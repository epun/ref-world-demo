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
  chooseEviction,
  createCreatureManager,
  measureBodyRadius,
  spawnSpot,
} from '../../src/creatures/manager';
import { generatedName } from '../../src/creatures/naming';
import { MOTION } from '../../src/taste/tokens';
import { EGG_RADIUS } from '../../src/egg/egg';
import type { Collider } from '../../src/physics/colliders';
import type { WorldHandles } from '../../src/world/scene';
import { FLAT_SURFACE, ROLLING_SURFACE, type Surface } from '../../src/world/surface';
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
    const manager = createCreatureManager(world, { autoHatch: true, surface: FLAT_SURFACE });
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
    const manager = createCreatureManager(world, { autoHatch: true, surface: FLAT_SURFACE });
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
    const manager = createCreatureManager(world, { autoHatch: true, surface: FLAT_SURFACE });

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
    const manager = createCreatureManager(stubWorld([ROCK]), {
      autoHatch: true,
      surface: FLAT_SURFACE,
    });
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
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: true,
      surface: FLAT_SURFACE,
    });
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
    const manager = createCreatureManager(world, { autoHatch: false, surface: FLAT_SURFACE });
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
    const manager = createCreatureManager(world, { autoHatch: false, surface: FLAT_SURFACE });
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
    const manager = createCreatureManager(world, { autoHatch: false, surface: FLAT_SURFACE });
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
    // 68 was the seeded population when this surfaced. The seed is 30 now
    // (the recording was re-harvested), but the stress size is kept: the
    // bug scaled with population, so the test should not shrink with it.
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

describe('following a host — arriving at a world already in motion', () => {
  /**
   * The glitch: *"there's a glitch where the characters fly across the map"*
   * (user report, 2026-08-27).
   *
   * A viewer builds the cast locally and stands each creature on its
   * deterministic spawn spot — that is genuinely all it knows. The host has
   * been simulating for minutes and has them spread across the field. The
   * follow branch then EASED into the first pose it heard, so the entire
   * population set off from the spawn spiral and travelled to wherever they
   * really were, together, every time somebody opened the link.
   *
   * The first pose is not movement. It is finding out. So it is written,
   * and every pose after it eases.
   */

  function viewing(count: number) {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false, surface: FLAT_SURFACE });
    for (let i = 0; i < count; i++) {
      manager.spawn(`v-${i}`, circleBlob, { hatchMs: 60_000, grown: true });
    }
    // A viewer runs no agents of its own.
    manager.pauseAi(true);
    return manager;
  }

  /** Somewhere far from any spawn spot, so a flight would be unmistakable. */
  const farPose = (id: string, i: number) => ({
    id,
    x: 90 + i * 3,
    z: -90 - i * 3,
    heading: 0,
  });

  it('lands on the first pose within one frame instead of travelling to it', () => {
    const manager = viewing(8);
    const ids = manager.poses().map((p) => p.id);
    expect(ids.length).toBe(8);

    manager.followPoses(ids.map((id, i) => farPose(id, i)));
    manager.update(16, 1000);

    // ONE frame. Eased at FOLLOW_TAU_MS a 16ms step covers a small fraction
    // of the distance, so a creature still mid-flight fails this by a wide
    // margin — this is not a tolerance question.
    for (const [i, pose] of manager.poses().entries()) {
      const want = farPose(ids[i]!, i);
      expect(Math.hypot(pose.x - want.x, pose.z - want.z)).toBeLessThan(0.001);
    }
    manager.clearAll();
  });

  it('still eases every pose after the first — the fix is not a permanent snap', () => {
    const manager = viewing(1);
    const id = manager.poses()[0]!.id;

    manager.followPoses([{ id, x: 20, z: 0, heading: 0 }]);
    manager.update(16, 1000);
    const settled = manager.poses()[0]!;
    expect(settled.x).toBeCloseTo(20, 3);

    // A second, different pose must be approached, not jumped to.
    manager.followPoses([{ id, x: 40, z: 0, heading: 0 }]);
    manager.update(16, 1016);
    const moving = manager.poses()[0]!;
    expect(moving.x).toBeGreaterThan(20);
    expect(moving.x).toBeLessThan(39);
    manager.clearAll();
  });

  it('clearFollow drops the held pose, so the next one places again', () => {
    const manager = viewing(1);
    const id = manager.poses()[0]!.id;

    manager.followPoses([{ id, x: 20, z: 0, heading: 0 }]);
    manager.update(16, 1000);
    expect(manager.poses()[0]!.x).toBeCloseTo(20, 3);

    // A change of role. Whatever the last host said is now a stale opinion.
    manager.clearFollow();
    manager.followPoses([{ id, x: -35, z: 12, heading: 0 }]);
    manager.update(16, 1016);

    // Placed, not flown — the same guarantee as a first join, because for
    // this creature it IS one.
    const after = manager.poses()[0]!;
    expect(Math.hypot(after.x - -35, after.z - 12)).toBeLessThan(0.001);
    manager.clearAll();
  });
});

describe('chooseEviction — a world does not eat its own cast', () => {
  /**
   * *"fix the population cap so the seeded ones don't get retired"* (user
   * ask, 2026-08-27).
   *
   * The guard retired the oldest live slot past MAX_POPULATION, and the
   * world's own residents load before anybody arrives — so they hold every
   * one of the lowest arrival numbers, and oldest-first took them in order.
   * A busy public world emptied out the field a person had come to look at,
   * one resident per arrival.
   */

  const slot = (order: number, resident = false, phase = 'alive') => ({
    order,
    resident,
    phase,
  });

  it('takes the oldest arrival, not the older resident beside it', () => {
    // The exact shape of the public world: residents first (lowest orders),
    // arrivals after them.
    const world = [
      ...Array.from({ length: 23 }, (_, i) => slot(i, true)),
      ...Array.from({ length: 73 }, (_, i) => slot(23 + i)),
    ];
    expect(chooseEviction(world)).toBe(world[23]);
  });

  it('walks through the arrivals and never reaches the residents', () => {
    const residents = Array.from({ length: 23 }, (_, i) => slot(i, true));
    const guests = Array.from({ length: 20 }, (_, i) => slot(23 + i));
    // Retire repeatedly, as a busy world does. Under the old rule the first
    // twenty-three of these were the seed.
    for (let n = 0; n < 20; n++) {
      const going = chooseEviction([...residents, ...guests])!;
      expect(going.resident).toBe(false);
      guests.splice(guests.indexOf(going), 1);
    }
    expect(residents.every((r) => r.resident)).toBe(true);
  });

  it('still evicts when a world is nothing but residents — the cap is not optional', () => {
    // A preference, not an exemption: a frame-rate guarantee with a
    // carve-out is a leak.
    const all = Array.from({ length: 96 }, (_, i) => slot(i, true));
    expect(chooseEviction(all)).toBe(all[0]);
  });

  it('skips a slot that is already leaving, so a slide is never restarted', () => {
    const world = [slot(0, false, 'retiring'), slot(1, true), slot(2)];
    expect(chooseEviction(world)).toBe(world[2]);
  });

  it('returns null when there is nobody available to retire', () => {
    expect(chooseEviction([])).toBeNull();
    expect(chooseEviction([slot(0, false, 'retiring')])).toBeNull();
  });
});

describe('resident spawns survive the cap end to end', () => {
  it('marks a resident spawn so the guard can see it', () => {
    // The thread that matters: SpawnOptions.resident has to reach the slot,
    // or chooseEviction is correct about data nothing ever sets. Kept to
    // two creatures — the choosing is proved above, this is the wiring.
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: false,
      surface: FLAT_SURFACE,
    });
    manager.spawn('res', circleBlob, { hatchMs: 60_000, grown: true, resident: true });
    manager.spawn('guest', circleBlob, { hatchMs: 60_000, grown: true });
    const live = manager.evictable();
    expect(live.find((s) => s.id === 'res')?.resident).toBe(true);
    expect(live.find((s) => s.id === 'guest')?.resident).toBe(false);
    // And the guard would take the guest, despite the resident being older.
    expect(chooseEviction(live)?.id).toBe('guest');
    manager.clearAll();
  });
});

describe('standing on the ground — heights come from the Surface seam', () => {
  /**
   * Creatures walk on terrain (PLAN §7.2): locomotion still writes x/z only
   * and the height is SAMPLED after it, every frame. A fixed ramp rather
   * than the authored landscape — this is about the seam being used, not
   * about what the map happens to be at some coordinate.
   */
  const SLOPE = 0.12;
  const ramp: Surface = {
    sampleHeight: (x, z) => x * SLOPE + z * 0.05,
    normalAt: () => {
      const len = Math.hypot(SLOPE, 1, 0.05);
      return { x: -SLOPE / len, y: 1 / len, z: -0.05 / len };
    },
  };

  /** The one live creature root, by the name it was spawned with. */
  function rootOf(manager: ReturnType<typeof createCreatureManager>): Group {
    const target = manager.hoverTargets()[0];
    expect(target).toBeDefined();
    return target!.object;
  }

  it('a grown creature spawns standing on the terrain, not on y = 0', () => {
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: false,
      surface: ramp,
    });
    manager.spawn('walker', snowman, { name: 'walker', hatchMs: 60_000, grown: true });
    const root = rootOf(manager);
    expect(root.position.y).toBeCloseTo(
      ramp.sampleHeight(root.position.x, root.position.z),
      12,
    );
    // ...and the ramp is well off zero at the first spiral spot, so this
    // is a real height rather than a zero that would pass either way.
    expect(Math.abs(root.position.y)).toBeGreaterThan(0.1);
    manager.clearAll();
  });

  it('the height follows a creature to a new x/z, every frame', () => {
    // Driven through the viewer path (a host's poses) so the movement is
    // real and deterministic — an autonomous agent is free to sit still,
    // and this is about the height following, not about wandering.
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: false,
      surface: ramp,
    });
    manager.spawn('walker', quadruped, { name: 'walker', hatchMs: 60_000, grown: true });
    manager.pauseAi(true);
    const root = rootOf(manager);
    const startX = root.position.x;

    let now = performance.now();
    for (let f = 0; f < 40; f++) {
      manager.followPoses([{ id: 'walker', x: 28 - f * 0.6, z: -14 + f * 0.4, heading: 0 }]);
      now += 33;
      manager.update(33, now);
      // Sampled AFTER the follow ease wrote x/z — every single frame.
      expect(root.position.y).toBeCloseTo(
        ramp.sampleHeight(root.position.x, root.position.z),
        12,
      );
    }
    // It really travelled, and its height came with it.
    expect(Math.abs(root.position.x - startX)).toBeGreaterThan(1);
    manager.clearAll();
  });

  it('an autonomous creature never leaves the ground over a long run', () => {
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: false,
      surface: ramp,
    });
    manager.spawn('roamer', quadruped, { name: 'roamer', hatchMs: 60_000, grown: true });
    manager.setWanderSpeed(3);
    const root = rootOf(manager);
    let now = performance.now();
    for (let f = 0; f < 300; f++) {
      // A clamped 250ms spike every 60 frames, as the real loop delivers.
      const dt = f % 60 === 59 ? 250 : 33;
      now += dt;
      manager.update(dt, now);
      expect(root.position.y).toBeCloseTo(
        ramp.sampleHeight(root.position.x, root.position.z),
        12,
      );
    }
    manager.clearAll();
  });

  it('the world terrain is the default — nobody has to ask for it', () => {
    const manager = createCreatureManager(stubWorld([]), { autoHatch: false });
    manager.spawn('walker', snowman, { name: 'walker', hatchMs: 60_000, grown: true });
    const root = rootOf(manager);
    // Compared against the seam, never a number: the map may change.
    expect(root.position.y).toBe(
      ROLLING_SURFACE.sampleHeight(root.position.x, root.position.z),
    );
    manager.clearAll();
  });

  it("an egg rests on the ground under it, and the entrance slides down to it", () => {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false, surface: ramp });
    manager.spawn('layer', snowman, { name: 'ada', hatchMs: 60_000 });

    let group: Object3D | null = null;
    world.scene.traverse((node) => {
      if (node.name === 'egg ada') group = node;
    });
    const egg = group as Object3D | null;
    expect(egg).not.toBeNull();
    const ground = ramp.sampleHeight(egg!.position.x, egg!.position.z);
    expect(Math.abs(ground)).toBeGreaterThan(0.1);
    // Entrances slide (TASTE §2.1): it starts above its ground...
    expect(egg!.position.y).toBeGreaterThan(ground + 1);

    // ...and settles onto it, never onto zero.
    let now = performance.now();
    for (let f = 0; f < 200; f++) {
      now += 33;
      manager.update(33, now);
    }
    expect(egg!.position.y - ramp.sampleHeight(egg!.position.x, egg!.position.z)).toBeLessThan(
      0.02,
    );
    manager.clearAll();
  });

  it('a hatched creature rises out of the ground and settles on it', () => {
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: true,
      surface: ramp,
    });
    let now = performance.now();
    manager.spawn('hatcher', snowman, { name: 'hatcher', hatchMs: 0 });
    for (let i = 0; i < 200 && manager.hoverTargets().length < 1; i++) {
      now += 50;
      manager.update(50, now);
    }
    const root = rootOf(manager);
    // Mid-rise: under the ground it is coming out of, never under y = 0.
    // (The burst frame also ejects the newborn from its own egg's collider,
    // so it is already a step away from where the shell stood — which is
    // exactly why the rise re-samples rather than holding one height.)
    const ground = ramp.sampleHeight(root.position.x, root.position.z);
    expect(root.position.y).toBeLessThan(ground);
    expect(root.position.y).toBeGreaterThan(ground - 2);

    // The whole exit, then: standing exactly on the terrain.
    for (let f = 0; f < 200; f++) {
      now += 33;
      manager.update(33, now);
    }
    expect(root.position.y).toBeCloseTo(
      ramp.sampleHeight(root.position.x, root.position.z),
      12,
    );
    manager.clearAll();
  });

  it('a retiring creature sinks below the ground it was standing on', () => {
    // The population guard is the only thing that retires a creature, so
    // the world has to be full for the sink to run at all. One fixture and
    // grown arrivals keep that as cheap as a full room can be.
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: false,
      surface: ramp,
    });
    manager.spawn('eldest', circleBlob, { name: 'eldest', hatchMs: 60_000, grown: true });
    const root = rootOf(manager);
    const ground = ramp.sampleHeight(root.position.x, root.position.z);
    expect(root.position.y).toBeCloseTo(ground, 12);

    for (let i = 1; i < MAX_POPULATION + 1; i++) {
      manager.spawn(`filler-${i}`, circleBlob, { hatchMs: 60_000, grown: true });
    }

    // Mid-slide: under the terrain it was standing on — the sink used to be
    // measured from y = 0, which on a raised tier is somewhere in the air.
    let now = performance.now();
    now += MOTION.primaryMs * 0.4;
    manager.update(16, now);
    expect(root.position.y).toBeLessThan(ground - 0.5);
    expect(root.position.y).toBeGreaterThan(ground - 2.6);
    manager.clearAll();
  }, 120_000);

  it('endManualMove sets the creature back down on the terrain', () => {
    const manager = createCreatureManager(stubWorld([]), {
      autoHatch: false,
      surface: ramp,
    });
    manager.spawn('held', snowman, { name: 'held', hatchMs: 60_000, grown: true });
    const root = rootOf(manager);
    expect(manager.beginManualMove(root)).toBe(true);

    // A gizmo drag: anywhere, on all three axes — while held, nothing
    // re-grounds it.
    root.position.set(24, 5.5, -11);
    let now = performance.now();
    for (let f = 0; f < 10; f++) {
      now += 33;
      manager.update(33, now);
      expect(root.position.y).toBe(5.5);
    }

    manager.endManualMove(root);
    expect(root.position.y).toBe(ramp.sampleHeight(24, -11));
    manager.clearAll();
  });
});
