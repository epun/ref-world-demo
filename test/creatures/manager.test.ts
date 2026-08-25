/**
 * Creature manager physics — integration-level guarantees against clipping.
 *
 * Runs the real manager against a stub world (headless Three.js): real
 * characters from the shared stroke fixtures, real eggs (canvas stubbed —
 * texture paint is a no-op off-DOM), real behavior agents, real substepped
 * resolve. Asserts the invariants the user actually sees:
 *
 *  - collision radii come from each character's REAL mesh footprint
 *    (wide fish > narrow bird), never a constant or the tucked-in shadow;
 *  - spawn spots are projected clear of hard props — an egg never
 *    incubates half-inside a rock;
 *  - over a long autonomous run (mixed small and clamped-250ms frames), no
 *    creature pair ever visibly overlaps and no creature penetrates a
 *    hard prop.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mesh, Scene, Vector3 } from 'three';
import type { Group, Object3D } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCharacter } from '../../src/character/character';
import {
  MAX_POPULATION,
  createCreatureManager,
  measureBodyRadius,
  spawnSpot,
} from '../../src/creatures/manager';
import { generatedName } from '../../src/creatures/naming';
import { EGG_RADIUS } from '../../src/egg/egg';
import type { Collider } from '../../src/physics/colliders';
import type { WorldHandles } from '../../src/world/scene';
import { bird, quadruped, snowman, circleBlob } from '../fixtures/strokes';

// createEgg paints its shell texture through a 2d canvas; off-DOM the
// context is null and every paint is a guarded no-op — only createElement
// itself must exist.
beforeAll(() => {
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    };
  }
});

/** Minimal world: real scene graph, no renderer, no DOM. */
function stubWorld(colliders: Collider[]): WorldHandles {
  let version = 1;
  const world = {
    scene: new Scene(),
    cameraRig: { frameAt: (_p: Vector3) => {} },
    shadows: {
      addShadow: () => ({ setPosition: () => {} }),
      removeShadow: () => {},
    },
    scatter: {
      colliders: () => colliders,
      collidersVersion: () => version,
      bump: () => {
        version++;
      },
      positions: () =>
        colliders.map((c) => ({ x: c.x, z: c.z, kind: c.hard ? 'rock' : 'bush', r: c.r })),
      nudge: () => {},
    },
  };
  return world as unknown as WorldHandles;
}

/** The same real-footprint measure the manager uses, applied to a live
 * root: widest x/z reach of every mesh under it. */
function rootRadius(root: Object3D): number {
  let r = 0;
  root.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    const geometry = obj.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb || bb.isEmpty()) return;
    const ex =
      Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)) * Math.abs(obj.scale.x) +
      Math.abs(obj.position.x);
    const ez =
      Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)) * Math.abs(obj.scale.z) +
      Math.abs(obj.position.z);
    r = Math.max(r, ex, ez);
  });
  return r;
}

describe('measureBodyRadius — radius truth from the generated mesh', () => {
  it('a wide-bodied drawing gets a larger collision radius than a tall one', () => {
    const wide = createCharacter(quadruped, 1, { identity: 'wide' })!;
    const tall = createCharacter(bird, 1, { identity: 'tall' })!;
    expect(wide).not.toBeNull();
    expect(tall).not.toBeNull();
    expect(measureBodyRadius(wide)).toBeGreaterThan(measureBodyRadius(tall));
    wide.dispose();
    tall.dispose();
  });

  it('always covers the real silhouette — strictly wider than the shadow radius', () => {
    for (const strokes of [circleBlob, snowman, quadruped, bird]) {
      const character = createCharacter(strokes, 1, { identity: 'probe' })!;
      // character.radius is the SHADOW stamp (tucked 15% inside the
      // footprint); colliding on it is exactly how wide bodies clipped.
      expect(measureBodyRadius(character)).toBeGreaterThan(character.radius);
      character.dispose();
    }
  });
});

describe('spawn placement', () => {
  it('projects an egg clear of a hard prop sitting on its spiral spot', () => {
    const spot = spawnSpot(0);
    const rock: Collider = { x: spot.x, z: spot.z, r: 1.5, hard: true };
    const world = stubWorld([rock]);
    const manager = createCreatureManager(world, { autoHatch: true });
    expect(manager.spawn('egg-on-rock', snowman, { hatchMs: 60_000 })).toBe(true);
    const [egg] = manager.positions();
    expect(egg).toBeDefined();
    const d = Math.hypot(egg!.x - rock.x, egg!.z - rock.z);
    // Clear of the rock's footprint plus the egg's own — no visual overlap.
    expect(d).toBeGreaterThanOrEqual(rock.r + EGG_RADIUS);
    manager.clearAll();
  });

  it('keeps a second egg clear of the first when spots collide', () => {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: true });
    manager.spawn('first', snowman, { hatchMs: 60_000 });
    manager.spawn('second', circleBlob, { hatchMs: 60_000 });
    const [a, b] = manager.positions();
    const d = Math.hypot(a!.x - b!.x, a!.z - b!.z);
    expect(d).toBeGreaterThanOrEqual(2 * EGG_RADIUS);
    manager.clearAll();
  });
});

describe('live population — nothing ever interpenetrates', () => {
  it('30s of autonomous roaming with clamped-dt spikes: no pair overlap, no prop penetration', () => {
    // Hard props sprinkled around the spawn spiral so roamers actually
    // meet them: a rock, a big building footprint, a trunk.
    const props: Collider[] = [
      { x: 7, z: 1, r: 1.3, hard: true },
      { x: -9, z: -3, r: 3.2, hard: true },
      { x: 2, z: -8, r: 0.45, hard: true },
      { x: -4, z: 7, r: 1.0, hard: false }, // a bush — soft, never blocks
    ];
    const world = stubWorld(props);
    const manager = createCreatureManager(world, { autoHatch: true });

    let now = performance.now();
    manager.spawn('a', snowman, { name: 'a', hatchMs: 0, personality: 'friends' });
    manager.spawn('b', quadruped, { name: 'b', hatchMs: 0, personality: 'adventure' });
    manager.spawn('c', bird, { name: 'c', hatchMs: 0, personality: 'chaos' });
    // High wander speed exercises the substepping the hardest.
    manager.setWanderSpeed(3);

    // Hatch: eggs at hatchMs 0 begin immediately; the crack spring needs
    // ~a second of updates to burst.
    for (let i = 0; i < 200 && manager.hoverTargets().length < 3; i++) {
      now += 50;
      manager.update(50, now);
    }
    const targets = manager.hoverTargets();
    expect(targets.length).toBe(3);

    const radii = new Map<Group, number>();
    for (const t of targets) radii.set(t.object, rootRadius(t.object));
    // Real per-drawing radii, not a shared constant.
    const values = [...radii.values()];
    expect(new Set(values.map((v) => v.toFixed(4))).size).toBeGreaterThan(1);

    // Visible-overlap epsilon: corrections are exact to the skin; allow a
    // few centimeters of numeric slack — far below anything the eye reads.
    const EPS = 0.03;
    const frames = 900;
    for (let frame = 0; frame < frames; frame++) {
      // Mostly 33ms frames with a clamped 250ms spike every 60 frames — a
      // background tab returning must not tunnel anyone into anything.
      const dt = frame % 60 === 59 ? 250 : 33;
      now += dt;
      manager.update(dt, now);

      const roots = [...radii.keys()];
      for (let i = 0; i < roots.length; i++) {
        const ri = radii.get(roots[i]!)!;
        for (let j = i + 1; j < roots.length; j++) {
          const rj = radii.get(roots[j]!)!;
          const d = Math.hypot(
            roots[i]!.position.x - roots[j]!.position.x,
            roots[i]!.position.z - roots[j]!.position.z,
          );
          expect(d, `pair overlap at frame ${frame}`).toBeGreaterThanOrEqual(ri + rj - EPS);
        }
        for (const c of props) {
          if (!c.hard) continue;
          const d = Math.hypot(roots[i]!.position.x - c.x, roots[i]!.position.z - c.z);
          expect(d, `prop penetration at frame ${frame}`).toBeGreaterThanOrEqual(
            ri + c.r - EPS,
          );
        }
      }
    }
    manager.clearAll();
  });
});

// ── manual move (dev panel gizmo) ────────────────────────────────────────────

describe('manual move — the gizmo owns a held creature', () => {
  /** A rock the resolve pass must eject anyone standing inside. */
  const ROCK: Collider = { x: 14, z: -6, r: 1.6, hard: true };

  function hatchOne(): {
    manager: ReturnType<typeof createCreatureManager>;
    root: Group;
  } {
    const manager = createCreatureManager(stubWorld([ROCK]), { autoHatch: true });
    let now = performance.now();
    manager.spawn('held', snowman, { name: 'held', hatchMs: 0 });
    for (let i = 0; i < 200 && manager.hoverTargets().length < 1; i++) {
      now += 50;
      manager.update(50, now);
    }
    const root = manager.hoverTargets()[0]!.object;
    return { manager, root };
  }

  it('holds the dragged spot, then hands the root back to physics on release', () => {
    const { manager, root } = hatchOne();
    const radius = rootRadius(root);
    let now = performance.now();
    expect(manager.beginManualMove(root)).toBe(true);

    // The "drag": park the creature INSIDE the rock. While held, nothing —
    // not behavior, not the hard resolve — may move it: the gizmo is the
    // only authority, so a user can place a creature anywhere they like.
    root.position.set(ROCK.x, 0, ROCK.z);
    for (let i = 0; i < 60; i++) {
      now += 33;
      manager.update(33, now);
      expect(root.position.x).toBeCloseTo(ROCK.x, 6);
      expect(root.position.z).toBeCloseTo(ROCK.z, 6);
    }

    // Released: the root is grounded and physics owns it again, so the rock
    // it was parked in ejects it within a few frames.
    root.position.y = 1.4; // a gizmo drag can lift off the ground plane
    manager.endManualMove(root);
    expect(root.position.y).toBe(0);
    for (let i = 0; i < 30; i++) {
      now += 33;
      manager.update(33, now);
    }
    const d = Math.hypot(root.position.x - ROCK.x, root.position.z - ROCK.z);
    expect(d, 'physics owns the root again after release').toBeGreaterThanOrEqual(
      radius + ROCK.r - 0.03,
    );
    manager.clearAll();
  });

  it('a held creature is still an obstacle: neighbors part around it', () => {
    const manager = createCreatureManager(stubWorld([]), { autoHatch: true });
    let now = performance.now();
    manager.spawn('held', snowman, { name: 'held', hatchMs: 0 });
    manager.spawn('free', circleBlob, { name: 'free', hatchMs: 0 });
    for (let i = 0; i < 300 && manager.hoverTargets().length < 2; i++) {
      now += 50;
      manager.update(50, now);
    }
    const [a, b] = manager.hoverTargets();
    const held = a!.object;
    const free = b!.object;
    const rHeld = rootRadius(held);
    const rFree = rootRadius(free);

    manager.beginManualMove(held);
    // Park the held creature right on top of its neighbor: the resolve pass
    // must push the FREE one out, never the held one.
    held.position.set(free.position.x, 0, free.position.z);
    const parkedX = held.position.x;
    const parkedZ = held.position.z;
    for (let i = 0; i < 90; i++) {
      now += 33;
      manager.update(33, now);
    }
    expect(held.position.x).toBeCloseTo(parkedX, 6);
    expect(held.position.z).toBeCloseTo(parkedZ, 6);
    const gap = Math.hypot(free.position.x - parkedX, free.position.z - parkedZ);
    expect(gap, 'neighbor pushed clear of the held body').toBeGreaterThanOrEqual(
      rHeld + rFree - 0.03,
    );
    manager.clearAll();
  });

  it('is a no-op for anything that is not a live creature root', () => {
    const { manager } = hatchOne();
    expect(manager.beginManualMove(new Mesh())).toBe(false);
    // Releasing an unheld object must not throw or ground it.
    const stranger = new Mesh();
    stranger.position.y = 3;
    manager.endManualMove(stranger);
    expect(stranger.position.y).toBe(3);
    manager.clearAll();
  });
});

describe('the outliner can see both phases', () => {
  // The ghost-panel outliner registers NAMED meshes and groups off the scene
  // graph. Only the hatched character used to carry a name, so a world full
  // of eggs read as an empty list — exactly backwards for the thing the list
  // is used for, which is checking that geometry actually built.
  it('names the egg group, and the creature keeps the same name', () => {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false });
    expect(manager.spawn('drawer-1', snowman, { name: 'ada', hatchMs: 60_000 })).toBe(true);

    const names: string[] = [];
    world.scene.traverse((node) => {
      if (node.name) names.push(node.name);
    });
    expect(names).toContain('egg ada');
    // One drawer reads as one thing across both phases.
    expect(names.every((n) => n === n.toLowerCase())).toBe(true);
  });

  it('names an unsigned egg with the generated name', () => {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false });
    manager.spawn('drawer-2', snowman, { hatchMs: 60_000 });
    const names: string[] = [];
    world.scene.traverse((node) => {
      if (node.name.startsWith('egg ')) names.push(node.name);
    });
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`egg ${generatedName('drawer-2')}`);
  });
});

describe('grown arrivals — a creature that is already here', () => {
  /**
   * The regression this file exists to prevent recurring.
   *
   * The hatch builds a TWO-LEVEL rig: an empty wrapper owns the world
   * position, and `character.group` hangs inside it owning only the lean
   * and bob that `character.update()` rewrites every frame. `placeGrown`
   * once used `character.group` itself as the root, which handed the
   * animation the world transform — every creature's spawn position was
   * erased on the next tick, the whole population landed on the origin in
   * one heap, and the physics pass then fought the animation for the same
   * three floats. On screen: a clump of sixty-eight creatures vibrating.
   *
   * Three separate assertions because the collapse had three separate
   * tells, and any one of them alone could be argued away.
   */

  function grownWorld(count: number) {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false });
    const kinds = [snowman, circleBlob, quadruped, bird];
    for (let i = 0; i < count; i++) {
      manager.spawn(`grown-${i}`, kinds[i % kinds.length]!, { hatchMs: 60_000, grown: true });
    }
    return { world, manager };
  }

  it('never uses the character group as the root — the two frames stay separate', () => {
    const { world, manager } = grownWorld(6);
    // Every creature root in the scene must be a wrapper holding the
    // character, not the character's own group.
    let checked = 0;
    for (const child of world.scene.children) {
      if (!child.name.startsWith('creature ')) continue;
      checked++;
      // A wrapper is empty: it holds the character group and nothing else.
      // Collapsed, this IS the character group, whose own direct children
      // are the creature's meshes — so a mesh one level down is the tell.
      expect(child.children.length).toBeGreaterThan(0);
      const holdsGeometryDirectly = child.children.some((c) => c instanceof Mesh);
      expect(holdsGeometryDirectly).toBe(false);
    }
    expect(checked).toBe(6);
    manager.clearAll();
  });

  it('holds its spawn position across frames instead of collapsing to the origin', () => {
    const { manager } = grownWorld(12);
    const before = manager.positions().map((p) => ({ x: p.x, z: p.z }));
    // Radii must already be spread — nobody starts on top of anybody.
    expect(Math.max(...before.map((p) => Math.hypot(p.x, p.z)))).toBeGreaterThan(5);

    // Run frames. The character's own animation writes its local offset on
    // every one of these; the world position must survive all of them.
    for (let f = 0; f < 60; f++) manager.update(16, 1000 + f * 16);

    const after = manager.positions();
    for (let i = 0; i < after.length; i++) {
      const drift = Math.hypot(after[i]!.x - before[i]!.x, after[i]!.z - before[i]!.z);
      // A creature walks; it does not teleport. 60 frames at 16ms is under
      // a second, and MAX_SPEED is 1.2 — so a whole world unit is already
      // generous, while the collapse moved every one of them ~15.
      expect(drift).toBeLessThan(1);
    }
    manager.clearAll();
  }, 60_000);

  it('spreads a full room instead of piling it at the centre', () => {
    // 68 is the demo's seeded population — the size that surfaced this.
    const { manager } = grownWorld(68);
    const live = manager.positions();
    expect(live).toHaveLength(68);

    const radii = live.map((p) => Math.hypot(p.x, p.z)).sort((a, b) => a - b);
    // The spiral reaches 3.2 + 2.1*sqrt(67) ≈ 20.4 at this population.
    expect(radii[radii.length - 1]).toBeGreaterThan(15);
    expect(radii[(radii.length / 2) | 0]).toBeGreaterThan(8);

    // And nobody is standing inside anybody.
    let overlaps = 0;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const d = Math.hypot(live[i]!.x - live[j]!.x, live[i]!.z - live[j]!.z);
        if (d < live[i]!.r + live[j]!.r) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
    manager.clearAll();
  }, 120_000);

  it('wraps the spawn spiral at the population cap, never below it', () => {
    // At `% 64` a room of 68 put four creatures on EXACTLY the first four
    // spots, and zero distance has no separation direction, so no later
    // pass could undo it. A literal here is the bug: the wrap has to track
    // the cap, so pin the relationship rather than either number.
    const src = readFileSync(join(process.cwd(), 'src/creatures/manager.ts'), 'utf8');
    expect(src).toMatch(/spawnSpot\(orderCounter % MAX_POPULATION\)/);

    // ...and the spiral really is injective across that whole range, so
    // the cap is a safe modulus to wrap at.
    const seen = new Set<string>();
    for (let i = 0; i < MAX_POPULATION; i++) {
      const spot = spawnSpot(i);
      const key = `${spot.x.toFixed(4)},${spot.z.toFixed(4)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
