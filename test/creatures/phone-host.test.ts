/**
 * A PHONE THAT HOSTS, WITH NO RIGID BODIES AT ALL.
 *
 * > User ask, 2026-09-16: *"we need to be able to run this on a slow network
 * > on people's devices."*
 *
 * Measured at 1.5 Mbit/s (`scratch/slow-network.mjs`): a phone opening the
 * world view downloaded 760 kb of compressed rapier — `@dimforge/rapier3d-compat`
 * with its wasm inlined — because a phone alone on the link wins its own
 * election and becomes the host (`HostRole` in src/main.ts). Four seconds of
 * the link, for a simulation nobody is watching on a screen that cannot
 * afford it. So a handset never loads it (`physicsExpectedFor` in
 * src/world/device.ts), and the game runs off the PURE resolve and the
 * scatter's own colliders instead.
 *
 * The gate the manager used to read was `bodies() !== null`, which meant
 * "this page is the host" only while those two facts arrived together. They
 * no longer do, so the questions came apart (`deciding` / `rapierOwns` in
 * src/creatures/manager.ts) and this file is what pins the phone-host path as
 * the TESTED one rather than an accident:
 *
 *   it picks a stone up — through the contact route, since there is no
 *     `bodies.items()` to find one in;
 *   it is stopped by something too big to carry — the resolve, which never
 *     needed rapier;
 *   it decides and SAYS SO, as the same scene events every other page reads
 *     (docs/PLAN.md §7.6 — the decision was always the event);
 *   and `enablePhysics` is never worth calling, so the dynamic import that
 *     fetches rapier is not reached.
 */

import { Group, Scene, type Object3D } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCreatureManager, type CreatureManager } from '../../src/creatures/manager';
import { carryLimit } from '../../src/creatures/sticky';
import type { Collider } from '../../src/physics/colliders';
import type { LooseMeshes } from '../../src/world/loose';
import type { WorldHandles } from '../../src/world/scene';
import { ROLLING_SURFACE } from '../../src/world/surface';
import { snowman } from '../fixtures/strokes';

/** Frame length, ms — a phone's. */
const FRAME_MS = 33;

// createEgg paints through a 2d canvas; off-DOM every paint is a guarded
// no-op and only createElement has to exist.
beforeAll(() => {
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    };
  }
});

/** A `LooseMeshes` that draws nothing and remembers everything. */
function stubLoose(scene: Scene): LooseMeshes {
  const objects = new Map<string, Object3D>();
  return {
    show(item: string): Object3D {
      const existing = objects.get(item);
      if (existing) return existing;
      const object = new Group();
      scene.add(object);
      objects.set(item, object);
      return object;
    },
    move: () => {},
    remove: () => {},
    get: (item: string) => objects.get(item),
    dispose: () => {},
  } as unknown as LooseMeshes;
}

interface Harness {
  manager: CreatureManager;
  scene: Scene;
  /** Everything the page decided, in order — what would go out as events. */
  said: { what: string; item: string }[];
  /** How many times anybody asked this page to load rapier. */
  asked(): number;
  root(): Group;
}

/**
 * THE PHONE HOST: `bodies()` is null forever and `physicsExpected()` is
 * false, which is exactly the pair of answers `src/world/scene.ts` gives on a
 * handset. `enablePhysics` records that it was called and does nothing —
 * because on a handset it resolves before reaching the import.
 */
function phoneHost(colliders: Collider[]): Harness {
  const scene = new Scene();
  let version = 1;
  const taken = new Set<string>();
  let asked = 0;
  const said: { what: string; item: string }[] = [];
  const world = {
    scene,
    cameraRig: { frameAt: () => {} },
    shadows: {
      addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
      removeShadow: () => {},
    },
    // The two answers that make this a phone.
    bodies: () => null,
    physics: () => null,
    physicsExpected: () => false,
    enablePhysics: async () => {
      asked++;
    },
    scatter: {
      colliders: () => colliders.filter((c) => c.key === undefined || !taken.has(c.key)),
      collidersVersion: () => version,
      positions: () => [],
      nudge: () => {},
      // The viewer-side owner of the taken set: with no `PropBodies` this is
      // how a placement stops being drawn (`hidePlacement`).
      hideTaken: (keys: ReadonlySet<string>) => {
        taken.clear();
        for (const k of keys) taken.add(k);
        version++;
      },
      setTaken: (keys: ReadonlySet<string>) => {
        taken.clear();
        for (const k of keys) taken.add(k);
        version++;
      },
      instanceRefs: (kind: string) =>
        colliders
          .filter((col) => col.kind === kind)
          .map((col) => ({
            key: col.key!,
            scale: 1,
            radius: col.r,
            placement: { rotY: 0 },
          })),
    },
  } as unknown as WorldHandles;

  const manager = createCreatureManager(world, {
    autoHatch: false,
    surface: ROLLING_SURFACE,
    game: 'katamari',
    loose: stubLoose(scene),
    observer: {
      stick: (record: { item: string }) => said.push({ what: 'stick', item: record.item }),
      loose: (item: string) => said.push({ what: 'loose', item }),
      drop: () => {},
      settle: () => {},
      crack: () => {},
      retire: () => {},
      spawn: () => {},
      hatch: () => {},
      emote: () => {},
      pose: () => {},
      shatter: (record: { item: string }) => said.push({ what: 'shatter', item: record.item }),
    } as never,
  });
  return {
    manager,
    scene,
    said,
    asked: () => asked,
    root(): Group {
      for (const child of scene.children) {
        if (child instanceof Group && child.name.startsWith('creature ')) return child;
      }
      throw new Error('no creature root');
    },
  };
}

/** One prop's collider, by the same key shape the scatter publishes. */
function prop(kind: string, x: number, z: number, r: number, hard = true): Collider {
  return { x, z, r, hard, kind, key: `${kind}:0:${x}:${z}` } as Collider;
}

describe('a phone that hosts has no rigid bodies, and still runs the game', () => {
  it('is deciding: `simulating()` is true with `bodies()` null forever', () => {
    const h = phoneHost([]);
    h.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    h.manager.update(FRAME_MS, 1000);
    // The old gate was `bodies() !== null`, which on this page is false for
    // the life of the page — and this page is the host.
    expect(h.manager.simulating()).toBe(true);
    // A VIEWER is still not deciding, on a phone as anywhere else: that is
    // what `pauseAi` says on the way down from hosting.
    h.manager.pauseAi(true);
    expect(h.manager.simulating()).toBe(false);
    h.manager.pauseAi(false);
    expect(h.manager.simulating()).toBe(true);
    h.manager.clearAll();
  });

  it('picks up a stone, through the contact route', () => {
    const h = phoneHost([]);
    h.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    h.manager.update(FRAME_MS, 1000);
    const root = h.root();
    const bodyR = h.manager.ballDiameter('mine') / 2;
    expect(bodyR).toBeGreaterThan(0);

    // A stone well inside the carry limit, a short walk ahead. Placed
    // relative to the creature, so the spawn spot is not part of the test.
    const stone = prop('rock', root.position.x + 0.9, root.position.z, carryLimit(bodyR) * 0.4);
    const h2 = phoneHost([stone]);
    h2.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    h2.manager.update(FRAME_MS, 1000);
    const root2 = h2.root();
    root2.position.set(stone.x - 0.9, root2.position.y, stone.z);
    h2.manager.drive('mine', { x: 1, z: 0, mag: 1 });
    let now = 1000;
    for (let f = 0; f < 120; f++) {
      now += FRAME_MS;
      h2.manager.update(FRAME_MS, now);
    }
    // On the pile, and said out loud as the `stick` event every other page
    // in the room applies.
    expect(h2.said.map((s) => s.what)).toContain('stick');
    expect(h2.said.find((s) => s.what === 'stick')!.item).toBe(stone.key);
    h.manager.clearAll();
    h2.manager.clearAll();
  });

  it('is stopped by something too big to carry', () => {
    const h = phoneHost([]);
    h.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    h.manager.update(FRAME_MS, 1000);
    const bodyR = h.manager.ballDiameter('mine') / 2;
    h.manager.clearAll();

    // A trunk several times the carry limit: rooted, hard, and not going
    // anywhere. The resolve is what stops the creature, and the resolve
    // never needed rapier.
    const spawn = { x: 0, z: 0 };
    const tree = prop('tree', 0, 0, carryLimit(bodyR) * 6);
    const h2 = phoneHost([tree]);
    h2.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    h2.manager.update(FRAME_MS, 1000);
    const root = h2.root();
    // Start clear of the trunk and drive straight into it.
    root.position.set(tree.x - (tree.r + bodyR + 1.5), root.position.y, tree.z);
    spawn.x = root.position.x;
    spawn.z = root.position.z;
    h2.manager.drive('mine', { x: 1, z: 0, mag: 1 });
    let now = 1000;
    for (let f = 0; f < 240; f++) {
      now += FRAME_MS;
      h2.manager.update(FRAME_MS, now);
    }
    const end = h2.manager.positionOf('mine')!;
    // It moved (it is not frozen at the spawn) …
    expect(Math.hypot(end.x - spawn.x, end.z - spawn.z)).toBeGreaterThan(0.5);
    // … and it did not walk through the trunk. The wall-slide can carry it
    // around, so the invariant is the one that matters: never INSIDE.
    expect(Math.hypot(end.x - tree.x, end.z - tree.z)).toBeGreaterThan(tree.r);
    // And the tree is still standing: it is over the carry limit, so nothing
    // was picked up.
    expect(h2.said.some((s) => s.what === 'stick' && s.item === tree.key)).toBe(false);
    h2.manager.clearAll();
  });

  it('never asks for rapier — the dynamic import is not reached', () => {
    /*
     * The manager is not what calls `enablePhysics` (src/main.ts does, on
     * host election), so what is pinned here is the seam it would come
     * through: nothing in a frame of the phone-host path reaches for the
     * physics world or the bodies, so there is no second route to the
     * import. `physicsExpectedFor` is the gate itself and is pinned in
     * test/world/slow-network.test.ts.
     */
    const stone = prop('rock', 0.9, 0, 0.1);
    const h = phoneHost([stone]);
    h.manager.spawn('mine', snowman, { hatchMs: 10, grown: true });
    let now = 1000;
    h.manager.drive('mine', { x: 1, z: 0, mag: 1 });
    for (let f = 0; f < 120; f++) {
      now += FRAME_MS;
      h.manager.update(FRAME_MS, now);
    }
    expect(h.asked()).toBe(0);
    h.manager.clearAll();
  });
});
