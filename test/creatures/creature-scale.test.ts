/**
 * THE DRAWN CREATURE KEEPS ITS DRAWN SIZE. The pile is what grows.
 *
 * > User ask, 2026-09-17: *"we should not scale up the characters as they
 * > stick to things."*
 *
 * The root's uniform scale IS the growth (`growPass`), so until now the drawn
 * creature ballooned with its pile: a fifteen-metre ball was a fifteen-metre
 * creature wearing a few stones. The katamari read is the other way round —
 * a small character and a big ball of stuff — so the node the character hangs
 * in counters the root's scale exactly the way `localScaleOf` already counters
 * it for every stuck item (src/creatures/clump.ts).
 *
 * What this file pins, all through the manager so it is the same arithmetic
 * the world runs:
 *
 *   - across a twelve-pickup ladder the creature's WORLD scale never moves
 *     while `ballDiameter` climbs;
 *   - the eyes, the stalk and the topper shrink with it — they are children
 *     of the character root, and a child that did not follow would be a head
 *     floating over a small body;
 *   - the MASS still casts the shadow (`character.radius × growth`);
 *   - the creature rides the ball's north pole, un-rotated by the roll, and a
 *     PASSENGER still rides its carrier's pile rather than the pole;
 *   - and a world without the game is untouched: no counter-scale, no rider
 *     node, `root.scale` exactly 1.
 */

import { Group, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCreatureManager } from '../../src/creatures/manager';
import type { CreatureManager } from '../../src/creatures/manager';
import { growth } from '../../src/creatures/sticky';
import type { LooseMeshes } from '../../src/world/loose';
import type { WorldHandles } from '../../src/world/scene';
import type { WorldGame } from '../../src/world/game';
import { FLAT_SURFACE } from '../../src/world/surface';
import { fish, snowman } from '../fixtures/strokes';

// createEgg paints through a 2d canvas; off-DOM the context is null and every
// paint is a guarded no-op — only createElement itself must exist.
beforeAll(() => {
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    };
  }
});

const IDENTITY_Q = { qx: 0, qy: 0, qz: 0, qw: 1 };

/** The live shadow radius per key, which is what the ground stamp is. */
interface Shadows {
  radius: Map<string, number>;
}

function stubWorld(shadows: Shadows, scene: Scene): WorldHandles {
  return {
    scene,
    cameraRig: { frameAt: (_p: Vector3) => {} },
    shadows: {
      addShadow: (key: string, r: number) => {
        shadows.radius.set(key, r);
        return {
          setPosition: () => {},
          setRadius: (next: number) => shadows.radius.set(key, next),
        };
      },
      removeShadow: (key: string) => shadows.radius.delete(key),
    },
    scatter: {
      colliders: () => [],
      collidersVersion: () => 1,
      bump: () => {},
      positions: () => [],
      nudge: () => {},
      instanceRefs: () => [],
    },
  } as unknown as WorldHandles;
}

/** A `LooseMeshes` that draws nothing and hands back a real Object3D. */
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

function harness(game: WorldGame = 'katamari'): {
  scene: Scene;
  manager: CreatureManager;
  shadows: Shadows;
} {
  const scene = new Scene();
  const shadows: Shadows = { radius: new Map() };
  const manager = createCreatureManager(stubWorld(shadows, scene), {
    autoHatch: false,
    surface: FLAT_SURFACE,
    game,
    loose: stubLoose(scene),
  });
  return { scene, manager, shadows };
}

/** The one creature root in the scene. */
function rootOf(scene: Scene, manager: CreatureManager, id: string): Group {
  const at = manager.positionOf(id)!;
  for (const child of scene.children) {
    if (!(child instanceof Group)) continue;
    if (Math.hypot(child.position.x - at.x, child.position.z - at.z) < 1e-6) return child;
  }
  throw new Error(`no root for ${id}`);
}

/**
 * The node the drawn creature hangs in, and the character's own group inside
 * it. Looked up by name because that is all a test may know about the rig.
 */
function riderOf(root: Group): Object3D {
  const node = root.getObjectByName('rider');
  if (!node) throw new Error('no rider node');
  return node;
}

function charGroupOf(root: Group): Object3D {
  const child = riderOf(root).children[0];
  if (!child) throw new Error('no character group');
  return child;
}

function worldScale(object: Object3D): number {
  object.updateWorldMatrix(true, false);
  return object.getWorldScale(new Vector3()).x;
}

function worldPos(object: Object3D): Vector3 {
  object.updateWorldMatrix(true, false);
  return object.getWorldPosition(new Vector3());
}

/** A node's own Y axis in world space — which way is up for it. */
function worldUp(object: Object3D): Vector3 {
  object.updateWorldMatrix(true, false);
  const e = object.matrixWorld.elements;
  return new Vector3(e[4]!, e[5]!, e[6]!).normalize();
}

/** Seat one prop on `id`'s pile through the presentation path. */
function stick(manager: CreatureManager, id: string, n: number, r: number): void {
  manager.applyStick({
    id,
    item: `rock:${n % 3}:${n}:0`,
    kind: 'rock',
    variant: n % 3,
    scale: r,
    r,
    ox: 0,
    oy: r,
    oz: 0,
    ...IDENTITY_Q,
  });
}

describe('a creature does not grow with its pile', () => {
  it('keeps its world scale across a twelve-pickup ladder while the ball grows', () => {
    const { scene, manager } = harness();
    manager.spawn('grower', fish, { hatchMs: 60_000, grown: true });
    manager.update(16, 1000);
    const root = rootOf(scene, manager, 'grower');
    const drawn = worldScale(charGroupOf(root));
    // The creature is drawn at the size the generator made it — the counter
    // scale is exact, not a correction.
    expect(drawn).toBeCloseTo(1, 10);
    let ball = manager.ballDiameter('grower');
    expect(ball).toBeGreaterThan(0);
    // Twelve things its OWN size, so the ball is several times the creature
    // by the end — the state the ask is about.
    const each = ball / 2;

    let now = 1000;
    for (let n = 0; n < 12; n++) {
      stick(manager, 'grower', n, each);
      // Enough frames for the growth spring to have moved; the assertion is
      // that the creature's own size is INDIFFERENT to it, not that it has
      // settled.
      for (let f = 0; f < 4; f++) {
        now += 16;
        manager.update(16, now);
      }
      const next = manager.ballDiameter('grower');
      expect(next).toBeGreaterThan(ball);
      ball = next;
      expect(worldScale(charGroupOf(root))).toBeCloseTo(drawn, 8);
    }
    // The ball is several times the creature by the end, and the ROOT is what
    // carries that — the growth is still one write.
    expect(root.scale.x).toBeGreaterThan(2.5);
    expect(ball / manager.ballDiameter('grower')).toBeCloseTo(1, 10);
    manager.clearAll();
  });

  it('shrinks the stalk, the topper and the eyes with it', () => {
    const { scene, manager } = harness();
    manager.spawn('grower', fish, { hatchMs: 60_000, grown: true });
    manager.update(16, 1000);
    const root = rootOf(scene, manager, 'grower');
    const topper = root.getObjectByName('topper');
    expect(topper).toBeTruthy();
    const before = worldScale(topper!);
    const wherever = worldPos(topper!).clone();
    const each = manager.ballDiameter('grower') / 2;
    for (let n = 0; n < 6; n++) stick(manager, 'grower', n, each);
    let now = 1000;
    for (let f = 0; f < 60; f++) {
      now += 16;
      manager.update(16, now);
    }
    expect(root.scale.x).toBeGreaterThan(2);
    // Children of the character root, so they ride the counter-scale with it.
    expect(worldScale(topper!)).toBeCloseTo(before, 8);
    // …and they are still ATTACHED: the topper sits on the body, which has
    // moved up onto the pile, so its world position moved with the creature
    // rather than staying behind.
    expect(worldPos(topper!).y).toBeGreaterThan(wherever.y);
    manager.clearAll();
  });

  it('still lets the MASS cast the shadow', () => {
    const { scene, manager, shadows } = harness();
    manager.spawn('grower', fish, { hatchMs: 60_000, grown: true });
    manager.update(16, 1000);
    const root = rootOf(scene, manager, 'grower');
    const base = shadows.radius.get('char-grower')!;
    expect(base).toBeGreaterThan(0);
    const each = manager.ballDiameter('grower') / 2;
    for (let n = 0; n < 8; n++) stick(manager, 'grower', n, each);
    let now = 1000;
    for (let f = 0; f < 60; f++) {
      now += 16;
      manager.update(16, now);
    }
    const stamp = shadows.radius.get('char-grower')!;
    // The stamp is the BALL's, not the creature's: `character.radius × g`.
    expect(stamp / base).toBeCloseTo(root.scale.x, 6);
    expect(stamp).toBeGreaterThan(base * 2);
    manager.clearAll();
  });

  it('rides the ball, un-rotated by the roll', () => {
    const { scene, manager } = harness();
    manager.spawn('grower', fish, { hatchMs: 60_000, grown: true });
    manager.update(16, 1000);
    const root = rootOf(scene, manager, 'grower');
    const each = manager.ballDiameter('grower') / 2;
    for (let n = 0; n < 8; n++) stick(manager, 'grower', n, each);
    let now = 1000;
    for (let f = 0; f < 90; f++) {
      now += 16;
      manager.update(16, now);
    }
    const R = manager.ballDiameter('grower') / 2;
    const rider = riderOf(root);
    // The node hangs on the ROOT, above the pile — not inside the clump.
    expect(rider.parent).toBe(root);
    // The creature's base is at the ball's top: `2R` above the root, which is
    // the ball's underside (docs/PLAN.md §7.6).
    const lifted = worldPos(charGroupOf(root)).y - root.position.y;
    expect(lifted).toBeCloseTo(2 * R * manager.rollBlend('grower'), 4);
    expect(manager.rollBlend('grower')).toBeGreaterThan(0.9);

    /*
     * And the roll does not turn it. The pile's rotation is on the clump —
     * the rider is not under it — so a rolled pile tips the pile over and
     * leaves the creature standing up. (The roll itself accumulates from
     * resolved travel on the host; here it is put on the clump directly,
     * which is the same node `Clump.roll` writes.)
     */
    const clump = root.getObjectByName('clump')!;
    expect(worldUp(clump).y).toBeCloseTo(1, 6);
    clump.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 1.2);
    root.updateMatrixWorld(true);
    expect(worldUp(clump).y).toBeLessThan(0.4);
    expect(worldUp(charGroupOf(root)).y).toBeCloseTo(1, 6);
    manager.clearAll();
  });

  it('seats a PASSENGER on its carrier’s pile, not on the pole', () => {
    const { scene, manager } = harness();
    manager.spawn('big', fish, { hatchMs: 60_000, grown: true });
    manager.spawn('small', snowman, { hatchMs: 60_000, grown: true });
    manager.update(16, 1000);
    const big = rootOf(scene, manager, 'big');
    const small = rootOf(scene, manager, 'small');
    const drawn = worldScale(charGroupOf(small));
    manager.applyStick({
      id: 'big',
      item: 'creature:small',
      ox: 0,
      oy: 1.4,
      oz: 0,
      ...IDENTITY_Q,
    });
    let now = 1000;
    for (let f = 0; f < 60; f++) {
      now += 16;
      manager.update(16, now);
    }
    // On the carrier's pile, exactly as before.
    expect(small.parent?.name).toBe('clump');
    expect(small.parent?.parent).toBe(big);
    // Its own pile is empty, so its own rider offset is zero: it sits in its
    // seat rather than a body-length above it.
    expect(riderOf(small).position.y).toBeCloseTo(0, 6);
    // And it is still drawn at its own size — the carrier's growth is
    // countered for it by the clump (`localScaleOf`), and its own root is
    // unscaled because it carries nothing.
    expect(worldScale(charGroupOf(small))).toBeCloseTo(drawn, 6);
    manager.clearAll();
  });
});

describe('a world without the game', () => {
  it('has no rider node, nothing counter-scaled and a root scale of one', () => {
    const { scene, manager } = harness('none');
    manager.spawn('plain', fish, { hatchMs: 60_000, grown: true });
    let now = 1000;
    for (let f = 0; f < 30; f++) {
      now += 16;
      manager.update(16, now);
    }
    const root = rootOf(scene, manager, 'plain');
    expect(root.getObjectByName('rider')).toBeUndefined();
    expect(root.getObjectByName('clump')).toBeUndefined();
    expect(root.scale.x).toBe(1);
    // The character's group is a direct child of the root, at world scale 1 —
    // the rig that shipped before the game.
    const group = root.children[0]!;
    expect(worldScale(group)).toBe(1);
    // No pile means no ball to measure.
    expect(manager.ballDiameter('plain')).toBe(0);
    manager.clearAll();
  });
});

describe('the growth curve itself is untouched', () => {
  it('still puts the whole growth on the root', () => {
    const { scene, manager } = harness();
    manager.spawn('grower', fish, { hatchMs: 60_000, grown: true });
    manager.update(16, 1000);
    const root = rootOf(scene, manager, 'grower');
    const baseR = manager.ballDiameter('grower') / 2;
    for (let n = 0; n < 5; n++) stick(manager, 'grower', n, baseR);
    let now = 1000;
    for (let f = 0; f < 120; f++) {
      now += 16;
      manager.update(16, now);
    }
    const one = baseR ** 3;
    const want = growth(baseR, [one, one, one, one, one]);
    expect(root.scale.x).toBeCloseTo(want, 6);
    expect(manager.ballDiameter('grower')).toBeCloseTo(2 * baseR * want, 6);
    // …and the creature is still its own size on top of it.
    expect(worldScale(charGroupOf(root))).toBeCloseTo(1, 8);
    manager.clearAll();
  });
});
