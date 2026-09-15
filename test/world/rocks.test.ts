/**
 * Loose rocks, fixed prop bodies and the tree recoil (src/world/rocks.ts).
 *
 * A REAL physics world (rapier's compat build runs headless under node) over
 * a STUB scatter: building the authored prop geometry takes seconds and none
 * of what is measured here depends on the actual silhouette, so the stub
 * hands out one tiny box geometry, a handful of placements, and fake
 * instanced meshes that just record the matrices written into them.
 *
 * The one assertion worth reading twice is the last: the recoil bend must
 * PEAK and then return toward zero WITHOUT changing sign. A sign change is
 * a rebound past the upright, and a rebound is bounce — forbidden at
 * confidence 1.00 (TASTE §2.1). Envpaint's version of this spring is ζ=0.35
 * and would fail it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, InstancedBufferAttribute, Group, Matrix4 } from 'three';
import { createPhysicsWorld, type PhysicsWorld } from '../../src/physics/world';
import {
  BEND_MAX,
  createPropBodies,
  hullPoints,
  type PropBodies,
} from '../../src/world/rocks';
import {
  placementKey,
  TRUNK_FOOTPRINT,
  type InstanceRef,
  type Placement,
  type Scatter,
} from '../../src/world/scatter';
import type { PropKind } from '../../src/world/props';
import type { Surface } from '../../src/world/surface';
import { gustAt, type WindField } from '../../src/world/wind';

const FIELD = 200;

const flat: Surface = {
  sampleHeight: () => 0,
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
};

/** A stand-in InstancedMesh: records what was written where. */
function fakeMesh(count: number, withBend: boolean): InstanceRef['mesh'] {
  const geometry = new BoxGeometry(1, 1, 1);
  if (withBend) {
    geometry.setAttribute(
      'aBend',
      new InstancedBufferAttribute(new Float32Array(count * 2), 2),
    );
  }
  const matrices = Array.from({ length: count }, () => new Matrix4());
  return {
    count,
    geometry,
    setMatrixAt: (i: number, m: Matrix4) => {
      matrices[i]!.copy(m);
    },
    getMatrixAt: (i: number, m: Matrix4) => {
      m.copy(matrices[i]!);
    },
    instanceMatrix: { needsUpdate: false },
  } as unknown as InstanceRef['mesh'];
}

const ROCKS: Placement[] = [
  { kind: 'rock', variant: 0, x: -20, z: 0, scale: 1, rotY: 0 },
  { kind: 'rock', variant: 0, x: 0, z: 0, scale: 1, rotY: 0 },
  { kind: 'rock', variant: 0, x: 20, z: 0, scale: 0.3, rotY: 0 },
];
const TREES: Placement[] = [
  { kind: 'tree', variant: 0, x: 4, z: 0, scale: 1, rotY: 0 },
  { kind: 'tree', variant: 0, x: -4, z: 6, scale: 1, rotY: 0 },
];

/** Minimal Scatter for the physics layer: refs, geometry, taken, wind. */
function stubScatter(): {
  scatter: Scatter;
  taken: () => ReadonlySet<string>;
  refs: Map<PropKind, InstanceRef[]>;
  version: () => number;
} {
  const geometry = new BoxGeometry(1, 1, 1);
  const rockMesh = fakeMesh(ROCKS.length, false);
  const treeMesh = fakeMesh(TREES.length, true);
  const refs = new Map<PropKind, InstanceRef[]>();
  let taken: ReadonlySet<string> = new Set<string>();
  let version = 1;

  const build = (): void => {
    refs.clear();
    const m = new Matrix4();
    const rockRefs: InstanceRef[] = [];
    ROCKS.forEach((p, i) => {
      if (taken.has(placementKey(p))) return;
      // Seated on the ground by the placement, exactly as the real rebuild
      // does: y is the sampled surface height.
      rockMesh.setMatrixAt(i, m.makeTranslation(p.x, flat.sampleHeight(p.x, p.z), p.z));
      rockRefs.push({
        key: placementKey(p),
        placement: p,
        mesh: rockMesh,
        index: i,
        scale: p.scale,
        radius: 0.5 * p.scale,
      });
    });
    refs.set('rock', rockRefs);
    const treeRefs: InstanceRef[] = [];
    TREES.forEach((p, i) => {
      if (taken.has(placementKey(p))) return;
      treeMesh.setMatrixAt(i, m.makeTranslation(p.x, flat.sampleHeight(p.x, p.z), p.z));
      treeRefs.push({
        key: placementKey(p),
        placement: p,
        mesh: treeMesh,
        index: i,
        scale: p.scale,
        radius: 1.2 * p.scale,
      });
    });
    refs.set('tree', treeRefs);
  };
  build();

  const field: WindField = { dirX: 1, dirZ: 0, strength: 1, speed: 1, gust: gustAt(0) };
  const scatter = {
    group: new Group(),
    instanceRefs: (kind: PropKind): InstanceRef[] => refs.get(kind) ?? [],
    geometryFor: () => geometry,
    rebuildVersion: () => version,
    setTaken: (keys: ReadonlySet<string>) => {
      taken = keys;
      version++;
      build();
    },
    windField: () => field,
  } as unknown as Scatter;

  return {
    scatter,
    taken: () => taken,
    refs,
    version: () => version,
    /** What the real `rebuild()` does to the physics layer: every instance
     * matrix back to the placement pose, fresh refs, version bumped. */
    rebuild: () => {
      version++;
      build();
    },
  };
}

describe('hullPoints', () => {
  it('decimates to the budget and applies the instance scale', () => {
    const geometry = new BoxGeometry(1, 1, 1, 12, 12, 12);
    const count = geometry.getAttribute('position').count;
    expect(count).toBeGreaterThan(256);
    const points = hullPoints(geometry, 2, 3, 4);
    expect(points.length / 3).toBeLessThanOrEqual(256);
    expect(points.length / 3).toBeGreaterThan(64);
    // The box spans ±0.5 on each axis; scaled, ±1 / ±1.5 / ±2.
    let maxX = 0;
    let maxY = 0;
    let maxZ = 0;
    for (let i = 0; i < points.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(points[i]!));
      maxY = Math.max(maxY, Math.abs(points[i + 1]!));
      maxZ = Math.max(maxZ, Math.abs(points[i + 2]!));
    }
    expect(maxX).toBeCloseTo(1, 6);
    expect(maxY).toBeCloseTo(1.5, 6);
    expect(maxZ).toBeCloseTo(2, 6);
  });

  it('is empty for a geometry with no positions', () => {
    const empty = new BoxGeometry(1, 1, 1);
    empty.deleteAttribute('position');
    expect(hullPoints(empty, 1, 1, 1).length).toBe(0);
  });
});

describe('prop bodies', () => {
  let physics: PhysicsWorld;
  let bodies: PropBodies;
  let stub: ReturnType<typeof stubScatter>;

  beforeAll(async () => {
    physics = await createPhysicsWorld(flat, FIELD);
    stub = stubScatter();
    bodies = createPropBodies({
      physics,
      scatter: stub.scatter,
      surface: flat,
      wind: stub.scatter.windField(),
    });
  });

  it('creates one dynamic body per rock and one fixed body per hard prop', () => {
    expect(bodies.ready).toBe(true);
    const items = bodies.items();
    expect(items.length).toBe(ROCKS.length);
    for (const item of items) {
      expect(item.kind).toBe('rock');
      expect(item.body.isFixed()).toBe(false);
      // Asleep until disturbed: a field of stones costs nothing at rest.
      expect(item.body.isSleeping()).toBe(true);
      expect(bodies.itemByCollider(item.colliderHandle)).toBe(item);
    }
    // Rocks + trees. Trees are hard (TRUNK_FOOTPRINT has them), and no rock
    // is ever fixed.
    expect(TRUNK_FOOTPRINT.tree).toBeGreaterThan(0);
    expect(bodies.counts().bodies).toBe(ROCKS.length + TREES.length);

    let fixedCount = 0;
    let dynamicCount = 0;
    physics.world.forEachRigidBody((body) => {
      if (body.numColliders() === 0) return;
      if (body.isFixed()) fixedCount++;
      else dynamicCount++;
    });
    // The fixed set is the terrain plus one cylinder per tree.
    expect(fixedCount).toBe(1 + TREES.length);
    expect(dynamicCount).toBe(ROCKS.length);
  });

  it('lands a lifted rock back on the terrain within three seconds', () => {
    const item = bodies.items().find((i) => i.x === -20)!;
    item.body.setTranslation({ x: -20, y: 5, z: 0 }, true);
    item.body.wakeUp();
    item.awake = true;
    // 3s of frames at 60fps.
    for (let i = 0; i < 180; i++) bodies.update(1000 / 60, 1000 + i * (1000 / 60));
    const t = item.body.translation();
    expect(t.y).toBeLessThan(2);
    expect(t.y).toBeGreaterThan(flat.sampleHeight(t.x, t.z) - 0.5);
    // …and it stopped rather than rolling on forever.
    const v = item.body.linvel();
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.5);
    // Its transform reached the instance row it is drawn in.
    const ref = stub.refs.get('rock')!.find((r) => r.key === item.key)!;
    const m = new Matrix4();
    ref.mesh.getMatrixAt(ref.index, m);
    expect(m.elements[13]).toBeCloseTo(t.y, 3);
  });

  it('writes a SLEEPING survivor back after a rebuild instead of snapping it home', () => {
    // The regression this pins: `rebuild()` resets every instance matrix to
    // the placement pose, and `update()` deliberately skips a rock that is
    // asleep — so a stone that rolled away and then bedded down used to be
    // DRAWN back at its original spot with its collider still where it
    // rolled. An invisible stone for a creature to walk into.
    const item = bodies.items().find((i) => i.x === -20)!;
    const rolled = { x: -20 + 10, y: 0.5, z: 0 };
    item.body.setTranslation(rolled, true);
    item.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    item.body.sleep();
    item.awake = false;
    expect(item.body.isSleeping()).toBe(true);

    stub.rebuild();
    // The rebuild really did put the row back at the placement.
    const staleRef = stub.scatter.instanceRefs('rock').find((r) => r.key === item.key)!;
    const stale = new Matrix4();
    staleRef.mesh.getMatrixAt(staleRef.index, stale);
    expect(stale.elements[12]).toBeCloseTo(item.x, 5);
    staleRef.mesh.instanceMatrix.needsUpdate = false;

    bodies.sync();

    const ref = stub.scatter.instanceRefs('rock').find((r) => r.key === item.key)!;
    const m = new Matrix4();
    ref.mesh.getMatrixAt(ref.index, m);
    expect(m.elements[12]).toBeCloseTo(rolled.x, 5);
    expect(m.elements[13]).toBeCloseTo(rolled.y, 5);
    expect(m.elements[14]).toBeCloseTo(rolled.z, 5);
    // Still the same body, still asleep: a reconcile is not a disturbance.
    expect(bodies.items().find((i) => i.key === item.key)!.body).toBe(item.body);
    expect(item.body.isSleeping()).toBe(true);
    // …and the upload was marked, without waiting for the next frame.
    expect(ref.mesh.instanceMatrix.needsUpdate).toBe(true);
  });

  it('re-seats a body that ended up under the ground', () => {
    const item = bodies.items().find((i) => i.x === 0)!;
    item.body.setTranslation({ x: 0, y: -40, z: 0 }, true);
    item.body.wakeUp();
    item.awake = true;
    bodies.update(1000 / 60, 9000);
    expect(item.body.translation().y).toBeGreaterThan(-1);
  });

  it('take() drops the body and tells the scatter to stop drawing it', () => {
    const item = bodies.items().find((i) => i.x === 20)!;
    const key = item.key;
    const before = bodies.items().length;
    expect(bodies.take(key)).toBe(true);
    expect(bodies.items().length).toBe(before - 1);
    expect(stub.taken().has(key)).toBe(true);
    expect(stub.scatter.instanceRefs('rock').some((r) => r.key === key)).toBe(false);
    // Nothing to take twice, and an unknown key is simply false.
    expect(bodies.take(key)).toBe(false);
    expect(bodies.take('rock:0:999.00:999.00')).toBe(false);
  });

  it('bump() peaks then returns toward zero without ever changing sign', () => {
    const treeKey = placementKey(TREES[0]!);
    const ref = stub.scatter.instanceRefs('tree').find((r) => r.key === treeKey)!;
    const bend = ref.mesh.geometry.getAttribute('aBend') as InstancedBufferAttribute;

    bodies.bump(treeKey, 1, 0, 0.3);
    const trace: number[] = [];
    for (let i = 0; i < 400; i++) {
      bodies.update(1000 / 60, 20000 + i * (1000 / 60));
      trace.push(bend.getX(ref.index));
    }

    const peak = Math.max(...trace);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(BEND_MAX);
    // NO SIGN CHANGE, anywhere in the recoil: never a rebound past upright.
    for (const v of trace) expect(v).toBeGreaterThanOrEqual(0);
    // It peaks and comes back: the last frames are near zero, and the peak
    // is not at the very end.
    expect(trace[trace.length - 1]!).toBeLessThan(peak * 0.2);
    expect(trace.indexOf(peak)).toBeLessThan(trace.length - 1);
    // Monotone up to the peak, monotone down after it — one approach each
    // way, which is what ζ = 1 buys.
    const peakAt = trace.indexOf(peak);
    for (let i = 1; i <= peakAt; i++) expect(trace[i]!).toBeGreaterThanOrEqual(trace[i - 1]!);
    for (let i = peakAt + 2; i < trace.length; i++) {
      expect(trace[i]!).toBeLessThanOrEqual(trace[i - 1]! + 1e-9);
    }
    // Retired once settled: only struck props are iterated.
    expect(bodies.counts().springs).toBe(0);
  });

  it('caps the lean at BEND_MAX however hard it is hit', () => {
    const treeKey = placementKey(TREES[1]!);
    const ref = stub.scatter.instanceRefs('tree').find((r) => r.key === treeKey)!;
    const bend = ref.mesh.geometry.getAttribute('aBend') as InstancedBufferAttribute;
    bodies.bump(treeKey, 0, -1, 40);
    let extreme = 0;
    for (let i = 0; i < 400; i++) {
      bodies.update(1000 / 60, 40000 + i * (1000 / 60));
      extreme = Math.min(extreme, bend.getY(ref.index));
    }
    expect(extreme).toBeLessThan(0);
    expect(extreme).toBeGreaterThanOrEqual(-BEND_MAX);
  });

  it('ignores a bump for a prop that carries no bend row', () => {
    expect(() => bodies.bump('rock:0:0.00:0.00', 1, 0, 0.5)).not.toThrow();
    expect(bodies.counts().springs).toBe(0);
  });

  it('spawns a dropped rock deterministically and drops it onto the ground', () => {
    const key = bodies.spawnRock(6, 12, -6);
    expect(key).not.toBeNull();
    const item = bodies.items().find((i) => i.key === key)!;
    expect(item.body.isSleeping()).toBe(false);
    for (let i = 0; i < 240; i++) bodies.update(1000 / 60, 60000 + i * (1000 / 60));
    expect(item.body.translation().y).toBeLessThan(2);
  });

  it('stops a rolling rock at a tree, and the tree recoils from the hit', () => {
    const treeKey = placementKey(TREES[0]!);
    const ref = stub.scatter.instanceRefs('tree').find((r) => r.key === treeKey)!;
    const bend = ref.mesh.geometry.getAttribute('aBend') as InstancedBufferAttribute;
    const item = bodies.items().find((i) => i.x === 0)!;
    // Put the stone on the ground west of the trunk (which stands at x = 4)
    // and shove it east, hard.
    item.body.setTranslation({ x: 0, y: 0.5, z: 0 }, true);
    item.body.setLinvel({ x: 9, y: 0, z: 0 }, true);
    item.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    item.body.setLinearDamping(0.4);
    item.body.setAngularDamping(2.5);
    item.awake = true;

    let struck = 0;
    for (let i = 0; i < 300; i++) {
      bodies.update(1000 / 60, 80000 + i * (1000 / 60));
      struck = Math.max(struck, Math.abs(bend.getX(ref.index)));
    }
    // It did not pass through the trunk: the fixed cylinder stopped it short.
    expect(item.body.translation().x).toBeLessThan(4);
    // And the contact was reported, so the trunk took a lean from it.
    expect(struck).toBeGreaterThan(0);
    expect(struck).toBeLessThanOrEqual(BEND_MAX);
  });

  it('wakeAll wakes every rock, and dispose drops every body', () => {
    bodies.wakeAll();
    for (const item of bodies.items()) expect(item.body.isSleeping()).toBe(false);
    bodies.dispose();
    expect(bodies.items().length).toBe(0);
    expect(bodies.ready).toBe(false);
    let remaining = 0;
    physics.world.forEachRigidBody((body) => {
      if (body.numColliders() > 0) remaining++;
    });
    // Only the terrain is left.
    expect(remaining).toBe(1);
  });
});
