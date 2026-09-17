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
import { Group, Mesh, Quaternion, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createCharacter } from '../../src/character/character';
import {
  DRIVE_IDLE_MS,
  DRIVE_SPEED,
  DRIVE_TURN_TAU_MS,
  KATAMARI_SPEED_MUL,
  KATAMARI_TURN_TAU_MS,
  KATAMARI_WALK_MUL,
  MAX_POPULATION,
  WANDER_SPEED_DEFAULT,
  chooseEviction,
  createCreatureManager,
  measureBodyRadius,
  spawnSpot,
  SPAWN_RADIUS,
} from '../../src/creatures/manager';
import { BehaviorAgent, MAX_SPEED } from '../../src/behavior/agent';
import { generatedName } from '../../src/creatures/naming';
import { MOTION } from '../../src/taste/tokens';
import { springRegistry } from '../../src/motion/spring';
import {
  FLOAT_BOB,
  FLOAT_LIFT_MIN,
  FLOAT_LIFT_RANGE,
  FLOAT_TUMBLE,
  floatHeight,
} from '../../src/creatures/gravity';
import {
  carryLimit,
  clearanceLift,
  CLEARANCE_DIRS,
  CLEARANCE_PAD,
  CLEARANCE_RING,
  CLUMP_FIT,
  GROWTH_K,
  passLimit,
  STICKY,
} from '../../src/creatures/sticky';
import { BALL_SIDE } from '../../src/creatures/ball';
import { EGG_RADIUS } from '../../src/egg/egg';
import type { Collider } from '../../src/physics/colliders';
import {
  MAX_STEP_TRAVEL,
  MAX_SUBSTEPS,
  SOFT_SPEED_FACTOR,
} from '../../src/physics/resolve';
import type { LooseMeshes } from '../../src/world/loose';
import type { WorldHandles } from '../../src/world/scene';
import type { WorldGame } from '../../src/world/game';
import { FLAT_SURFACE, ROLLING_SURFACE, type Surface } from '../../src/world/surface';
import { isWater } from '../../src/world/landscape';
import {
  DEADZONE,
  DRIVE_CURVE,
  KNOB_TRAVEL,
  stickToWorld,
  stickVector,
} from '../../src/world/joystick';
import { bird, fish, quadruped, snowman, circleBlob } from '../fixtures/strokes';

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

/**
 * The rigid-body layer, stubbed just enough for the sticky pass.
 *
 * `simulating()` is `bodies() !== null && !aiPaused`, which is how the
 * manager knows it is the page that decides (docs/PLAN.md §7.6). A stub
 * world with no `bodies` is therefore a VIEWER as far as the manager is
 * concerned, and that is exactly what one of the tests below wants.
 */
function stubBodies(): unknown {
  return {
    items: () => [],
    onSettle: () => {},
    // The destruction seams (src/world/rocks.ts). A stub that lacked them
    // would throw the moment the manager wired the impact seam — which is
    // every simulating frame.
    onImpact: () => {},
    onTake: () => {},
    registerForeign: () => {},
    unregisterForeign: () => {},
    adopt: () => {},
    release: () => false,
    take: () => true,
    restore: () => null,
    loosen: () => null,
    bump: () => {},
    itemByCollider: () => undefined,
    sideByCollider: () => null,
    sync: () => {},
    update: () => {},
    dispose: () => {},
  };
}

/** Minimal world: real scene graph, no renderer, no DOM. */
function stubWorld(colliders: Collider[], opts: { physics?: boolean } = {}): WorldHandles {
  let version = 1;
  const world = {
    ...(opts.physics === true
      ? { bodies: stubBodies, physics: () => null, enablePhysics: async () => {} }
      : {}),
    scene: new Scene(),
    cameraRig: { frameAt: (_p: Vector3) => {} },
    shadows: {
      addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
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
  it('projects an egg clear of a hard prop sitting on its own spot', () => {
    const spot = spawnSpot('egg-on-rock');
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

describe('who is still an egg — the manual hatch, synced (user ask, 2026-09-10)', () => {
  /**
   * *"in the demo let's pause the hatching until I press h on the
   * keyboard"*. Every phone's world view is its own copy of the world page,
   * so the host has to be able to SAY which shells are still closed and a
   * viewer has to be able to open one by id. Both of those are this
   * manager's answers, and they are what src/net/worldsync.ts reconciles.
   */

  function eggWorld() {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false, surface: FLAT_SURFACE });
    manager.spawn('a', snowman, { hatchMs: 60_000 });
    manager.spawn('b', circleBlob, { hatchMs: 60_000 });
    return manager;
  }

  it('lists every standing egg, and nothing that is already alive', () => {
    const manager = eggWorld();
    expect(manager.eggIds().sort()).toEqual(['a', 'b']);
    expect(manager.liveIds()).toEqual([]);
    manager.clearAll();
  });

  it('a grown arrival was never an egg', () => {
    // the store's first pull in a TIMER world stands its drawings up whole.
    // nothing about them is waiting on anybody.
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false, surface: FLAT_SURFACE });
    manager.spawn('grown', snowman, { hatchMs: 60_000, grown: true });
    expect(manager.eggIds()).toEqual([]);
    expect(manager.liveIds()).toEqual(['grown']);
    manager.clearAll();
  });

  it('opens exactly the egg it is given, and leaves the other standing', () => {
    // what a viewer does with a `hatch` off the wire: one id, one shell.
    const manager = eggWorld();
    manager.hatch('a');
    expect(manager.eggIds()).toEqual(['b']);
    let now = performance.now();
    for (let i = 0; i < 200 && manager.liveIds().length < 1; i++) {
      now += 50;
      manager.update(50, now);
    }
    expect(manager.liveIds()).toEqual(['a']);
    // and 'b' is still a shell nobody has called: the roster keeps saying so.
    expect(manager.eggIds()).toEqual(['b']);
    manager.clearAll();
  });

  it('drops an egg off the list the moment its shell starts coming off', () => {
    // a slot that is BREAKING OPEN is on its way to alive: there is nothing
    // left for a viewer to decide about it, and a host that still called it
    // an egg would keep every other screen waiting on a hatch already run.
    const manager = eggWorld();
    manager.hatch('a');
    expect(manager.eggIds()).toEqual(['b']);
    manager.clearAll();
  });

  it('an id nobody holds is not a hatch', () => {
    // it arrives over a public broker, and the drawings on two pages are
    // not always the same set.
    const manager = eggWorld();
    manager.hatch('nobody');
    expect(manager.eggIds().sort()).toEqual(['a', 'b']);
    manager.clearAll();
  });

  it('tells the observer the same forced hatch a key press would', () => {
    // the session log — and the broadcast that hangs off this seam — must
    // not be able to tell a viewer's hatch apart from the operator's.
    const hatched: { id: string; cause: string }[] = [];
    const world = stubWorld([]);
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: FLAT_SURFACE,
      observer: {
        egg: () => {},
        hatch: (id, cause) => hatched.push({ id, cause }),
        retire: () => {},
        emote: () => {},
        stick: () => {},
        drop: () => {},
        loose: () => {},
        settle: () => {},
        crack: () => {},
        shatter: () => {},
      },
    });
    manager.spawn('a', snowman, { hatchMs: 60_000 });
    manager.hatch('a');
    expect(hatched).toEqual([{ id: 'a', cause: 'forced' }]);
    manager.clearAll();
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

  it('spawns from the id, not the arrival order — the same spot on every device', () => {
    // A phone's world view builds its own eggs from the same ids, so the
    // spot must be a function of the id alone (src/net/worldsync.ts).
    const src = readFileSync(join(process.cwd(), 'src/creatures/manager.ts'), 'utf8');
    expect(src).toMatch(/spawnSpot\(id\)/);
    expect(spawnSpot('drawer-a')).toEqual(spawnSpot('drawer-a'));
    expect(spawnSpot('drawer-a')).not.toEqual(spawnSpot('drawer-b'));
  });

  it('scatters a room over the whole map, on land, inside the spawn disc', () => {
    // User ask, 2026-09-15: random over the map, not a clutch at the origin.
    const spots = Array.from({ length: MAX_POPULATION }, (_, i) => spawnSpot(`device-${i}`));
    const radii = spots.map((p) => Math.hypot(p.x, p.z)).sort((a, b) => a - b);
    expect(radii[radii.length - 1]).toBeLessThanOrEqual(SPAWN_RADIUS);
    // Uniform over a disc puts the median radius at R/√2 ≈ 0.71R; anything
    // near the centre would be the spiral back again.
    expect(radii[(radii.length / 2) | 0]).toBeGreaterThan(SPAWN_RADIUS * 0.5);
    // No two ids share a spot.
    const seen = new Set(spots.map((p) => `${p.x.toFixed(3)},${p.z.toFixed(3)}`));
    expect(seen.size).toBe(spots.length);
    // And none of them is in the lake.
    for (const p of spots) expect(isWater(p.x, p.z)).toBe(false);
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

  it('a retiring creature sinks below the ground it was standing on', async () => {
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
      // A full room of grown creatures is a minute of synchronous mesh
      // building; yield now and then so the vitest worker can still answer
      // the runner (its RPC times out at 60 s of a blocked event loop).
      if (i % 16 === 0) await new Promise<void>((r) => setImmediate(r));
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

describe('ground clearance — a big ball rides on its whole footprint', () => {
  /**
   * > User report, 2026-09-16: *"the ball is glitching through the map floor
   * > if it's big enough."*
   *
   * A creature stands on the ground under its CENTRE, which is the Surface
   * seam doing exactly what §7.2 asks of it and is exactly right for a 0.9 u
   * hatchling. A ball several units across is a different shape of problem:
   * its underside IS the root, and it spans `bodyR` in every direction, so on
   * a slope or a terrace riser the ground under its uphill edge is above the
   * ground under its middle and the downhill half of it is inside the hill.
   *
   * KATAMARI ONLY, and the twin at the bottom of this block is the proof: the
   * same slope, the same fixture, the game off, and a creature standing on
   * precisely the height it always stood on.
   */
  const SLOPE30 = Math.tan(Math.PI / 6);
  const slope: Surface = {
    sampleHeight: (x) => x * SLOPE30,
    normalAt: () => {
      const len = Math.hypot(SLOPE30, 1);
      return { x: -SLOPE30 / len, y: 1 / len, z: 0 };
    },
  };

  /**
   * A 1.6 u terrace riser at x = 0 — the map's own `terraceStep`
   * (src/world/landscape.ts), as a cliff. Deliberately a cut here: it is the
   * hardest thing the footprint ring can be asked about, and a creature
   * STANDING next to it is where the report's bug lived.
   */
  const RISER = 1.6;
  const terrace: Surface = {
    sampleHeight: (x) => (x > 0 ? RISER : 0),
    normalAt: () => ({ x: 0, y: 1, z: 0 }),
  };

  /**
   * The same 1.6 u rise as the real map draws it: a smoothstep over a band,
   * never a cut (`terrace()` in src/world/landscape.ts — "the riser is a
   * smoothstep, never a cut: no hard-edged geometry anywhere"). This is the
   * one to WALK over; the cliff above is the one to stand beside.
   */
  const RISER_BAND = 2;
  const ramped: Surface = {
    sampleHeight: (x) => {
      const t = Math.min(1, Math.max(0, (x + RISER_BAND / 2) / RISER_BAND));
      return RISER * t * t * (3 - 2 * t);
    },
    normalAt: () => ({ x: 0, y: 1, z: 0 }),
  };

  /** Where a prop the manager has never drawn goes when it is stuck on: the
   * loose layer, which a headless caller has to stub. */
  function stubLoose(): LooseMeshes {
    const meshes = new Map<string, Object3D>();
    return {
      show: (item: string): Object3D => {
        let mesh = meshes.get(item);
        if (!mesh) {
          mesh = new Group();
          meshes.set(item, mesh);
        }
        return mesh;
      },
      move: () => {},
      remove: (item: string) => {
        meshes.delete(item);
      },
      get: (item: string) => meshes.get(item),
      dispose: () => {},
    };
  }

  function makeManager(
    surface: Surface,
    game: WorldGame,
    opts: { physics?: boolean } = {},
  ): ReturnType<typeof createCreatureManager> {
    const manager = createCreatureManager(stubWorld([], opts), {
      autoHatch: false,
      surface,
      game,
      loose: stubLoose(),
    });
    manager.spawn('ball', snowman, { name: 'ball', hatchMs: 60_000, grown: true });
    return manager;
  }

  function rootOf(manager: ReturnType<typeof createCreatureManager>): Group {
    const target = manager.hoverTargets().find((t) => t.name === 'ball');
    expect(target).toBeDefined();
    return target!.object;
  }

  /**
   * Give the creature a pile, through the EVENT path — which is the only
   * path: `applyStick` is what a viewer applies and what the host's own
   * decision goes through.
   *
   * Props rather than the passenger snacks the roll tests use, because this
   * block needs a BIG ball and a prop's radius is whatever the record says:
   * three items of `r` 3 put a snowman past `bodyR` 3, where feeding it
   * body-sized creatures would take a hundred spawns to get there.
   */
  function feedProps(
    manager: ReturnType<typeof createCreatureManager>,
    count: number,
    r: number,
  ): void {
    for (let i = 0; i < count; i++) {
      manager.applyStick({
        id: 'ball',
        item: `rock:0:${i}.00:0.00`,
        kind: 'rock',
        variant: 0,
        scale: r,
        ox: 0,
        oy: 0,
        oz: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    }
  }

  /**
   * Hold a creature at exactly (x, z) for `frames` frames.
   *
   * Through the POSE path, which is a viewer's own (`followPoses` applies
   * while the local ai is stood down, and its first frame is a placement
   * rather than a journey) — an agent is free to wander and these tests are
   * about a named spot on a named slope. The HOST path, agent and resolve and
   * all, is what the autonomous test below runs.
   */
  function holdAt(
    manager: ReturnType<typeof createCreatureManager>,
    x: number,
    z: number,
    frames: number,
    onFrame?: () => void,
  ): void {
    manager.pauseAi(true);
    let now = 100_000;
    for (let f = 0; f < frames; f++) {
      manager.followPoses([{ id: 'ball', x, z, heading: 0 }]);
      now += 33;
      manager.update(33, now);
      onFrame?.();
    }
  }

  /** The highest ground under the sampled footprint — the ring the clearance
   * rule measures, computed here from the surface rather than read out of the
   * code under test. */
  function highestUnderFootprint(surface: Surface, x: number, z: number, bodyR: number): number {
    let highest = surface.sampleHeight(x, z);
    const ringR = bodyR * CLEARANCE_RING;
    for (const dir of CLEARANCE_DIRS) {
      highest = Math.max(highest, surface.sampleHeight(x + dir.x * ringR, z + dir.z * ringR));
    }
    return highest;
  }

  /**
   * Is the drawn SPHERE clear of the ground everywhere under it?
   *
   * The report's own test, and stricter than the rule: the ball's centre is
   * `root.y + bodyR` and its surface at horizontal distance `d` is
   * `centre − sqrt(bodyR² − d²)`, so this walks the whole footprint disc —
   * not only the sampled ring — and asks whether the paper is under the
   * sphere at every one of them.
   */
  function sphereClears(
    surface: Surface,
    rootY: number,
    x: number,
    z: number,
    bodyR: number,
  ): boolean {
    const centre = rootY + bodyR;
    for (let ring = 0; ring <= 6; ring++) {
      const d = (ring / 6) * bodyR;
      const surfaceY = centre - Math.sqrt(Math.max(0, bodyR * bodyR - d * d));
      for (let a = 0; a < 16; a++) {
        const th = (a / 16) * Math.PI * 2;
        const ground = surface.sampleHeight(x + Math.cos(th) * d, z + Math.sin(th) * d);
        if (surfaceY < ground - 1e-9) return false;
      }
    }
    return true;
  }

  it('a bodyR 3 ball on a 30° slope keeps its underside above the ground', () => {
    const manager = makeManager(slope, 'katamari');
    const root = rootOf(manager);
    feedProps(manager, 3, 3);
    holdAt(manager, 6, -4, 400);

    const bodyR = manager.ballDiameter('ball') / 2;
    // A real ball, not a hatchling with a rounding error on it.
    expect(bodyR).toBeGreaterThan(2.5);

    const highest = highestUnderFootprint(slope, root.position.x, root.position.z, bodyR);
    const pad = bodyR * CLEARANCE_PAD;
    // The underside of the ball IS the root (`clump.group` at (0, baseR, 0),
    // the root's scale the growth), so this is the ball clearing the highest
    // ground under its footprint — with the pad still to spare.
    expect(root.position.y).toBeGreaterThanOrEqual(highest);
    expect(root.position.y + pad).toBeGreaterThanOrEqual(highest);
    // …and the drawn sphere is clear of the paper across the whole disc,
    // which is what the person reported.
    expect(sphereClears(slope, root.position.y, root.position.x, root.position.z, bodyR)).toBe(
      true,
    );
    // It is a CLEARANCE and not a float: the shipped placement would have
    // been the centre height, and that is where the downhill half went under.
    const centre = slope.sampleHeight(root.position.x, root.position.z);
    expect(root.position.y - centre).toBeGreaterThan(1);
    expect(manager.groundLift('ball')).toBeCloseTo(root.position.y - centre, 9);
    manager.clearAll();
  });

  it('and across a 1.6 u terrace riser, standing just below the step', () => {
    const manager = makeManager(terrace, 'katamari');
    const root = rootOf(manager);
    feedProps(manager, 3, 3);
    // Just downhill of the riser, so the ring reaches over the step and the
    // centre does not: the exact case a ball's middle knows nothing about.
    holdAt(manager, -0.1, 0, 400);

    const bodyR = manager.ballDiameter('ball') / 2;
    expect(terrace.sampleHeight(root.position.x, root.position.z)).toBe(0);
    const highest = highestUnderFootprint(terrace, root.position.x, root.position.z, bodyR);
    expect(highest).toBe(RISER);
    expect(root.position.y).toBeGreaterThanOrEqual(RISER);
    expect(
      sphereClears(terrace, root.position.y, root.position.x, root.position.z, bodyR),
    ).toBe(true);
    manager.clearAll();
  });

  it('the lift arrives by sliding — monotone, and never past the target', () => {
    const manager = makeManager(slope, 'katamari');
    const root = rootOf(manager);
    feedProps(manager, 3, 3);
    // One frame to write the pose and the growth, so the target the spring is
    // chasing is the one this asserts against.
    holdAt(manager, 6, -4, 1);
    const bodyR = manager.ballDiameter('ball') / 2;
    const target = clearanceLift(root.position.x, root.position.z, bodyR, (x, z) =>
      slope.sampleHeight(x, z),
    );
    expect(target).toBeGreaterThan(1);

    let previous = manager.groundLift('ball');
    let frames = 0;
    holdAt(manager, 6, -4, 300, () => {
      const lift = manager.groundLift('ball');
      // Monotone: it only ever rises toward the clearance…
      expect(lift).toBeGreaterThanOrEqual(previous - 1e-12);
      // …and never past it, which is ζ ≥ 1 doing its job (TASTE §2.1).
      expect(lift).toBeLessThanOrEqual(target + 1e-9);
      previous = lift;
      frames++;
    });
    expect(frames).toBe(300);
    // It got there, over about `MOTION.primaryMs` — 300 frames is deep into
    // the tail.
    expect(previous).toBeCloseTo(target, 4);
    manager.clearAll();
  });

  it('a hatchling gets the shipped placement — no lift, and no ring sampled', () => {
    // A counting surface: the ring is eight extra samples a frame, and the
    // ask is that a creature carrying nothing pays for none of them.
    let calls = 0;
    const counted: Surface = {
      sampleHeight: (x, z) => {
        calls++;
        return slope.sampleHeight(x, z);
      },
      normalAt: (x, z) => slope.normalAt(x, z),
    };
    const manager = makeManager(counted, 'katamari');
    const root = rootOf(manager);
    holdAt(manager, 6, -4, 60);
    const hatchlingCalls = calls;

    // Standing on the terrain under its centre, exactly as it shipped.
    expect(manager.ballDiameter('ball') / 2).toBeLessThan(1.5);
    expect(manager.groundLift('ball')).toBe(0);
    expect(root.position.y).toBe(slope.sampleHeight(root.position.x, root.position.z));

    // Then give it a pile: the same sixty frames now cost the ring.
    calls = 0;
    feedProps(manager, 3, 3);
    holdAt(manager, 6, -4, 60);
    expect(calls).toBeGreaterThan(hatchlingCalls);
    expect(manager.groundLift('ball')).toBeGreaterThan(0);
    manager.clearAll();
  });

  it('every other world stands exactly where it stood — the twin', () => {
    const plain = makeManager(slope, 'none');
    const game = makeManager(slope, 'katamari');
    // The same events reach both. A world without the game has no pile to
    // put them on, so `applyStick` drops them (`if (!katamari) return`).
    feedProps(plain, 3, 3);
    feedProps(game, 3, 3);
    holdAt(plain, 6, -4, 400);
    holdAt(game, 6, -4, 400);

    const plainRoot = rootOf(plain);
    // Not "close to": the same number it wrote before this change existed.
    expect(plainRoot.position.y).toBe(
      slope.sampleHeight(plainRoot.position.x, plainRoot.position.z),
    );
    expect(plain.groundLift('ball')).toBe(0);
    expect(plain.ballDiameter('ball')).toBe(0);
    // …while the katamari twin, same fixture and same slope, is riding up.
    expect(game.groundLift('ball')).toBeGreaterThan(1);
    plain.clearAll();
    game.clearAll();
  });

  it('an autonomous ball on the slope is clear of it on every frame', () => {
    // The HOST path — a real agent, the substepped resolve, no poses — and
    // the page that holds the bodies. The clearance is applied in the one
    // ground pass every branch ends up in, so a wandering ball has to clear
    // the hill wherever it wanders to.
    const manager = makeManager(slope, 'katamari', { physics: true });
    expect(manager.simulating()).toBe(true);
    const root = rootOf(manager);
    feedProps(manager, 3, 3);

    let now = 100_000;
    // Long enough for the lift spring to settle (`MOTION.primaryMs`) before
    // anything is asserted: arriving is a slide, and a slide starts low.
    for (let f = 0; f < 120; f++) {
      now += 33;
      manager.update(33, now);
    }
    // Read after the first frames: `bodyR` is written in `growPass`, so a
    // pile seated a moment ago is not on the readout until the loop has run.
    const bodyR0 = manager.ballDiameter('ball') / 2;
    let travelled = 0;
    let previousX = root.position.x;
    for (let f = 0; f < 400; f++) {
      // Under a thumb, straight UPHILL: an agent is free to stand still and
      // this test wants the ball actually crossing the slope. The drive goes
      // through the same resolve and the same ground pass a wander does.
      manager.drive('ball', { x: 1, z: 0, mag: 1 });
      now += 33;
      manager.update(33, now);
      const bodyR = manager.ballDiameter('ball') / 2;
      const highest = highestUnderFootprint(slope, root.position.x, root.position.z, bodyR);
      expect(root.position.y).toBeGreaterThanOrEqual(highest - 1e-9);
      expect(
        sphereClears(slope, root.position.y, root.position.x, root.position.z, bodyR),
      ).toBe(true);
      travelled += Math.abs(root.position.x - previousX);
      previousX = root.position.x;
    }
    // It really travelled, and it really is a ball.
    expect(travelled).toBeGreaterThan(10);
    expect(bodyR0).toBeGreaterThan(2.5);
    manager.clearAll();
  });

  it('a terrace edge is a slide, not a step', () => {
    const manager = makeManager(ramped, 'katamari');
    const root = rootOf(manager);
    feedProps(manager, 3, 3);
    // Settled well below the riser, where the ring reaches nothing.
    holdAt(manager, -20, 0, 200);
    const bodyR = manager.ballDiameter('ball') / 2;
    expect(manager.groundLift('ball')).toBeCloseTo(bodyR * CLEARANCE_PAD, 3);

    // Then walk it up and over, through the pose path at a walking pace.
    const heights: number[] = [];
    let now = 200_000;
    for (let f = 0; f < 600; f++) {
      manager.followPoses([{ id: 'ball', x: -20 + f * 0.05, z: 0, heading: 0 }]);
      now += 33;
      manager.update(33, now);
      heights.push(root.position.y);
      /*
       * THE DRAWN SPHERE IS CLEAR OF THE PAPER on every frame of the climb —
       * which is the report, and it is the right assertion while the ball is
       * MOVING. The ring rule itself (root at or above the highest ring
       * sample) is a resting rule: the lift eases over `MOTION.primaryMs`, so
       * a ball climbing a riser is always a little behind its own target, and
       * a spring that arrived instantly would be the step the motion law
       * forbids. The sphere has the slack for it — at the ring the surface is
       * `0.4 × bodyR` above the underside — and the rest of this block pins
       * the resting case exactly.
       */
      expect(
        sphereClears(ramped, root.position.y, root.position.x, root.position.z, bodyR),
      ).toBe(true);
    }

    /*
     * NO FRAME IS A STEP, in either direction.
     *
     * Not strict monotone, and deliberately: the ball rises as the ring
     * reaches the riser and then SETTLES back onto the tread as the rest of
     * its footprint comes level, which is a ball cresting a hill rather than
     * a rebound — the lift's own monotone-toward-a-target is pinned in the
     * test above, where the target is not moving under it.
     */
    let biggest = 0;
    for (let i = 1; i < heights.length; i++) {
      biggest = Math.max(biggest, Math.abs(heights[i]! - heights[i - 1]!));
    }
    // On the upper tread, clear of it, with the pad and nothing else.
    expect(root.position.y).toBeGreaterThanOrEqual(RISER);
    expect(manager.groundLift('ball')).toBeCloseTo(bodyR * CLEARANCE_PAD, 3);
    // And the whole climb was a slide: no single frame moved it a twentieth
    // of the riser it climbed (TASTE §2.1 — no hard cuts, confidence 1.00).
    expect(biggest).toBeLessThan(RISER / 20);
    manager.clearAll();
  });

  it('host and viewer put the same ball at the same height', () => {
    // The lift is DERIVED, never sent (docs/PLAN.md §7.6: poses carry
    // x/z/heading and Y is always local). So the page that simulates and a
    // page that holds no bodies at all must reach the same height from the
    // same pose and the same pile.
    const host = makeManager(slope, 'katamari', { physics: true });
    const viewer = makeManager(slope, 'katamari');
    expect(host.simulating()).toBe(true);
    expect(viewer.simulating()).toBe(false);
    feedProps(host, 3, 3);
    feedProps(viewer, 3, 3);

    // The host's own ball, placed by its agent and its resolve, then stood
    // still so there is one pose to compare against.
    let now = 100_000;
    for (let f = 0; f < 200; f++) {
      now += 33;
      host.update(33, now);
    }
    host.pauseAi(true);
    for (let f = 0; f < 200; f++) {
      now += 33;
      host.update(33, now);
    }

    // What actually goes on the wire. Three numbers, and no height among
    // them: that is the whole reason the viewer has to derive its own.
    const pose = host.poses().find((p) => p.id === 'ball')!;
    expect(Object.keys(pose).sort()).toEqual(['heading', 'id', 'x', 'z']);

    viewer.pauseAi(true);
    for (let f = 0; f < 200; f++) {
      viewer.followPoses([pose]);
      now += 33;
      viewer.update(33, now);
    }

    const hostRoot = rootOf(host);
    const viewerRoot = rootOf(viewer);
    expect(viewerRoot.position.x).toBeCloseTo(hostRoot.position.x, 9);
    expect(viewerRoot.position.z).toBeCloseTo(hostRoot.position.z, 9);
    // The two springs have different histories — the host's ran while it was
    // wandering — so they meet on the target rather than at the same instant.
    // Six decimals of a world unit is a micron.
    expect(viewer.groundLift('ball')).toBeCloseTo(host.groundLift('ball'), 6);
    expect(viewerRoot.position.y).toBeCloseTo(hostRoot.position.y, 6);
    expect(host.groundLift('ball')).toBeGreaterThan(1);
    host.clearAll();
    viewer.clearAll();
  });

  /*
   * ── THE BALL HAS A BODY ────────────────────────────────────────────────
   *
   * > User report, 2026-09-17: *"currently there is a bug where the
   * > characters are floating in space."*
   *
   * The creature came out of the pile that morning (the `rider` node: it
   * keeps its drawn size), and what it came out standing on was a sphere
   * nothing drew — the items are seated on the surface of a ball of radius
   * `bodyR` and the creature was a diameter above the ground, with a dozen
   * props and nothing else in between.
   *
   * > And then, the same day: *"the objects that collect around the creatures
   * > sit under the creature. I think the creature should be at the center,
   * > and then it should just be a giant rolling mass. We still have a glitch
   * > where the creature is sitting on the Z-index above whatever objects they
   * > collect. They should be at the center of the sphere of the objects."*
   *
   * So the pole seat is gone: the creature is at the ball's CENTRE, the shell
   * is drawn `BackSide` so the near hemisphere never occludes it (no depth or
   * render-order hack — that was the *"z-index"*), and an item on the near
   * side of the pile is genuinely in front of it. These pin the mesh that was
   * missing (src/creatures/ball.ts): where it is, how big it is, that the
   * creature is at its middle at every value of the roll blend, and that a
   * walking creature has none.
   */

  /** The manager's own `behaviorSeed`, which is what the float reads — the
   * hash is private, so this is the same four lines. */
  function seedOf(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** The ball mesh on this creature's root, or undefined. */
  function ballOf(manager: ReturnType<typeof createCreatureManager>): Object3D | undefined {
    return rootOf(manager).getObjectByName('ball');
  }

  /** A world-space radius: the mesh's own scale through every parent, which
   * for the ball is `baseR × growth` = `bodyR` and nothing else. */
  function worldRadius(object: Object3D): number {
    object.updateWorldMatrix(true, false);
    return object.getWorldScale(new Vector3()).x;
  }

  function worldPos(object: Object3D): Vector3 {
    object.updateWorldMatrix(true, false);
    return object.getWorldPosition(new Vector3());
  }

  /**
   * Seat `count` items of radius `r` ON THE BALL'S SURFACE, the way
   * `clumpLocalOffset` seats them: `(R + r × CLUMP_FIT) / growth` out from
   * the clump's origin, at the growth the pile ENDS at — so once all of them
   * are on, every one is exactly where the pure rule would have put it.
   * `feedProps` above seats everything at the origin, which is fine for a
   * size but says nothing about a surface.
   */
  function seatOnBall(
    manager: ReturnType<typeof createCreatureManager>,
    count: number,
    r: number,
  ): { R: number; r: number } {
    const baseR = manager.ballDiameter('ball') / 2;
    const growth = Math.cbrt(1 + (GROWTH_K * count * r * r * r) / (baseR * baseR * baseR));
    const R = baseR * growth;
    const reach = (R + r * CLUMP_FIT) / growth;
    for (let i = 0; i < count; i++) {
      // Spread around the equator, so no two share a seat and none of them
      // lands on the pole the creature is standing on.
      const th = (i / count) * Math.PI * 2;
      manager.applyStick({
        id: 'ball',
        item: `rock:0:${i}.00:0.00`,
        kind: 'rock',
        variant: 0,
        scale: r,
        r,
        ox: Math.cos(th) * reach,
        oy: 0,
        oz: Math.sin(th) * reach,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    }
    return { R, r };
  }

  it('draws a ball where the items are, with the creature at its centre', () => {
    const manager = makeManager(FLAT_SURFACE, 'katamari');
    const root = rootOf(manager);
    const seated = seatOnBall(manager, 3, 3);
    holdAt(manager, 4, 4, 400);

    const bodyR = manager.ballDiameter('ball') / 2;
    expect(bodyR).toBeGreaterThan(2.5);
    // The growth ended where the seats were computed for.
    expect(bodyR).toBeCloseTo(seated.R, 6);

    const ball = ballOf(manager);
    expect(ball).toBeDefined();
    expect(ball!.visible).toBe(true);
    // ONE WRITE: the mesh is radius 1 scaled to `baseR`, and the growth on
    // the root carries it to `bodyR` — the same number `ballDiameter`
    // reports and the resolve circle runs on.
    expect(worldRadius(ball!)).toBeCloseTo(bodyR, 6);

    // ITS CENTRE IS THE PILE'S ORIGIN, which is where every seat is measured
    // from (`clumpLocalOffset`) — so the items are ON its surface.
    const clump = root.getObjectByName('clump');
    expect(clump).toBeDefined();
    expect(worldPos(ball!).distanceTo(worldPos(clump!))).toBeLessThan(1e-6);

    // …and each seated item is a radius out, bedded in by CLUMP_FIT.
    expect(clump!.children.length).toBe(3);
    for (const item of clump!.children) {
      const out = worldPos(item).distanceTo(worldPos(ball!));
      expect(out).toBeCloseTo(bodyR + seated.r * CLUMP_FIT, 4);
    }

    // THE CREATURE IS AT THE CENTRE: its own group sits exactly where the
    // ball's centre is, which is also the point every seat above was measured
    // from. Not "about" — the two heights are the same statement (`growPass`
    // writes `baseR · roll` and `baseR · (2 · roll − 1)`, which meet at
    // `roll` 1) — and being a diameter above it instead is the thing the
    // report called a creature standing on top of its own pile.
    const rider = root.getObjectByName('rider');
    expect(rider).toBeDefined();
    const middle = worldPos(rider!);
    expect(middle.distanceTo(worldPos(ball!))).toBeLessThan(1e-6);
    // It is a BALL off the ground with something inside it: the sphere's
    // underside is the root, so the creature is a radius up and every seat is
    // a radius out from it.
    expect(root.position.y).toBeGreaterThanOrEqual(FLAT_SURFACE.sampleHeight(4, 4));
    expect(middle.y - root.position.y).toBeCloseTo(bodyR, 5);
    /*
     * AND NOTHING IS DRAWN OVER ANYTHING (the *"z-index"* half of the report).
     * The near hemisphere is not drawn at all — the shell is `BALL_SIDE`,
     * `BackSide` — so the creature at the centre needs no depth trick to be
     * seen, and an item in front of it is in front of it. Every material in
     * the rig keeps the depth test and the default render order.
     */
    expect(((ball as Mesh).material as { side: number }).side).toBe(BALL_SIDE);
    const drawn: { depthTest: boolean; depthWrite: boolean; renderOrder: number }[] = [];
    root.traverse((o) => {
      const mesh = o as Mesh & { material?: { depthTest?: boolean; depthWrite?: boolean } };
      if (!mesh.material) return;
      drawn.push({
        depthTest: mesh.material.depthTest !== false,
        depthWrite: mesh.material.depthWrite !== false,
        renderOrder: o.renderOrder,
      });
    });
    expect(drawn.length).toBeGreaterThan(1);
    for (const entry of drawn) {
      expect(entry.depthTest).toBe(true);
      expect(entry.depthWrite).toBe(true);
      expect(entry.renderOrder).toBe(0);
    }
    // The drawn creature is still its drawn size through all of it (the
    // 2026-09-17 rider ask — this fix must not undo it).
    expect(worldRadius(rider!)).toBeCloseTo(1, 6);
    manager.clearAll();
  });

  it('keeps the creature inside the mass through the whole roll ramp', () => {
    // The ramp is the roll spring, ζ ≥ 1 over `MOTION.primaryMs`: the mass
    // rises out of the ground around the creature as the creature rides up
    // into it, and on EVERY frame of that the creature is inside the shell —
    // never outside it for a frame, which would be a creature briefly
    // standing on its own pile again.
    const manager = makeManager(FLAT_SURFACE, 'katamari');
    const root = rootOf(manager);
    seatOnBall(manager, 3, 3);
    let rose = 0;
    let previous = -Infinity;
    holdAt(manager, 4, 4, 200, () => {
      const ball = ballOf(manager)!;
      const rider = root.getObjectByName('rider')!;
      const bodyR = manager.ballDiameter('ball') / 2;
      // Inside the sphere, by the arithmetic in `growPass`: the gap is
      // `R · (1 − roll)` and the radius is `R`.
      const gap = worldPos(rider).distanceTo(worldPos(ball));
      expect(gap).toBeLessThanOrEqual(bodyR + 1e-9);
      expect(gap).toBeCloseTo(bodyR * (1 - manager.rollBlend('ball')), 5);
      // …and the ball itself only ever rises out of the ground — a slide,
      // never a pop, and never past the pile's own origin.
      const centre = worldPos(ball).y - root.position.y;
      expect(centre).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(centre).toBeLessThanOrEqual(bodyR + 1e-9);
      previous = centre;
      rose++;
    });
    expect(rose).toBe(200);
    expect(manager.rollBlend('ball')).toBeGreaterThan(0.99);
    // Settled: the creature is AT the centre, not merely inside.
    expect(
      worldPos(root.getObjectByName('rider')!).distanceTo(worldPos(ballOf(manager)!)),
    ).toBeLessThan(0.01);
    manager.clearAll();
  });

  it('a creature carrying nothing stands on the ground and shows no ball', () => {
    const manager = makeManager(FLAT_SURFACE, 'katamari');
    const root = rootOf(manager);
    holdAt(manager, 4, 4, 200);
    // Nothing on it, so nothing rolls: the blend is 0 and the sphere is
    // parked a radius under the root, where the ground it is standing on
    // hides it. Hidden as well, so no slope can show a dome.
    expect(manager.rollBlend('ball')).toBe(0);
    const ball = ballOf(manager)!;
    expect(ball.visible).toBe(false);
    expect(ball.position.y).toBeCloseTo(-manager.ballDiameter('ball') / 2, 6);
    // Its FEET are on the surface — the placement that shipped, to the float.
    const rider = root.getObjectByName('rider')!;
    expect(worldPos(rider).y).toBeCloseTo(FLAT_SURFACE.sampleHeight(4, 4), 9);
    expect(root.position.y).toBe(FLAT_SURFACE.sampleHeight(4, 4));
    manager.clearAll();
  });

  it('and every other world has no ball at all', () => {
    const plain = makeManager(FLAT_SURFACE, 'none');
    seatOnBall(plain, 3, 3);
    holdAt(plain, 4, 4, 200);
    // No clump, no rider, no ball — the game's own gate, unchanged.
    expect(rootOf(plain).getObjectByName('ball')).toBeUndefined();
    expect(rootOf(plain).getObjectByName('clump')).toBeUndefined();
    plain.clearAll();
  });


  /*
   * ── ZERO GRAVITY, as the manager presents it ───────────────────────────
   *
   * > User ask, 2026-09-17: *"i want a zero gravity mode where i can hit g on
   * > the keyboard and it turns off gravity for the map. characters should
   * > float in space."*
   *
   * One bit arrives (a `gravity` scene event, through the replay driver); the
   * height is DERIVED here, on every page, from the bit, the slot id and this
   * page's own clock (src/creatures/gravity.ts). So these pin the same three
   * things the ground clearance above is pinned on: it is applied in the one
   * ground pass, it arrives and leaves by sliding, and it does not exist in a
   * world without the game.
   */
  it('lifts a creature off the ground, and settles it back', () => {
    const manager = makeManager(FLAT_SURFACE, 'katamari');
    const root = rootOf(manager);
    holdAt(manager, 4, 4, 60);
    // On the ground, exactly as it shipped.
    expect(manager.gravity()).toBe(true);
    expect(manager.floatOffset('ball')).toBe(0);
    expect(root.position.y).toBe(0);

    manager.setGravity(false);
    expect(manager.gravity()).toBe(false);
    // …and it is a SLIDE: the blend only ever rises toward 1, never past it.
    let previous = manager.floatBlend('ball');
    holdAt(manager, 4, 4, 200, () => {
      const blend = manager.floatBlend('ball');
      expect(blend).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(blend).toBeLessThanOrEqual(1 + 1e-9);
      previous = blend;
    });
    expect(previous).toBeGreaterThan(0.99);
    // Up in the air, at its own altitude, and the root is where the float put
    // it — the ground pass, not a second writer.
    const seed = seedOf('ball');
    const offset = manager.floatOffset('ball');
    expect(offset).toBeGreaterThan(FLOAT_LIFT_MIN - FLOAT_BOB);
    expect(offset).toBeLessThan(FLOAT_LIFT_MIN + FLOAT_LIFT_RANGE + FLOAT_BOB);
    expect(offset).toBeGreaterThan(floatHeight(seed) - FLOAT_BOB - 1e-9);
    expect(offset).toBeLessThan(floatHeight(seed) + FLOAT_BOB + 1e-9);
    expect(root.position.y).toBeCloseTo(offset, 9);

    // Then `g` again: back down, by sliding, to exactly zero.
    manager.setGravity(true);
    let falling = manager.floatBlend('ball');
    holdAt(manager, 4, 4, 300, () => {
      const blend = manager.floatBlend('ball');
      expect(blend).toBeLessThanOrEqual(falling + 1e-12);
      expect(blend).toBeGreaterThanOrEqual(0);
      falling = blend;
    });
    // Exactly the placement that shipped, to the float — not "about" zero.
    expect(manager.floatOffset('ball')).toBe(0);
    expect(root.position.y).toBe(0);
    expect(root.rotation.x).toBe(0);
    expect(root.rotation.z).toBe(0);
    manager.clearAll();
  });

  it('drifts and tumbles up there instead of hanging still', () => {
    const manager = makeManager(FLAT_SURFACE, 'katamari');
    const root = rootOf(manager);
    manager.setGravity(false);
    holdAt(manager, 4, 4, 200);
    // Settled at its altitude — and still moving (TASTE §3: nothing fully
    // arrests). Sampled over a few seconds of frames, well past the spring.
    const heights = new Set<number>();
    const tilts = new Set<number>();
    holdAt(manager, 4, 4, 150, () => {
      heights.add(Math.round(manager.floatOffset('ball') * 1e4));
      tilts.add(Math.round(root.rotation.x * 1e4));
    });
    expect(heights.size).toBeGreaterThan(50);
    expect(tilts.size).toBeGreaterThan(50);
    // The tumble is on the axes nothing else owns: the heading is still the
    // root's y, and the tilt is bounded.
    expect(Math.abs(root.rotation.x)).toBeLessThanOrEqual(FLOAT_TUMBLE);
    expect(Math.abs(root.rotation.z)).toBeLessThanOrEqual(FLOAT_TUMBLE);
    manager.clearAll();
  });

  it('floats the BALL, clearance and all, with the creature upright inside it', () => {
    const manager = makeManager(slope, 'katamari');
    const root = rootOf(manager);
    seatOnBall(manager, 3, 3);
    holdAt(manager, 6, -4, 300);
    const grounded = root.position.y;
    const lift = manager.groundLift('ball');
    expect(lift).toBeGreaterThan(1);

    manager.setGravity(false);
    holdAt(manager, 6, -4, 300);
    const bodyR = manager.ballDiameter('ball') / 2;
    // The float is ON TOP of the clearance — both offsets, one write.
    expect(manager.groundLift('ball')).toBeCloseTo(lift, 6);
    expect(root.position.y).toBeCloseTo(
      slope.sampleHeight(root.position.x, root.position.z) +
        manager.groundLift('ball') +
        manager.floatOffset('ball'),
      9,
    );
    expect(root.position.y).toBeGreaterThan(grounded + FLOAT_LIFT_MIN - FLOAT_BOB);
    /*
     * …and the rig is unchanged by any of it: the creature is still at the
     * ball's centre, which the tumble cannot move it off — the mass leans
     * about a point the creature is standing on.
     */
    const ball = ballOf(manager)!;
    const rider = root.getObjectByName('rider')!;
    expect(worldPos(rider).distanceTo(worldPos(ball))).toBeLessThan(1e-6);
    expect(bodyR).toBeGreaterThan(2.5);
    // Really tilted, or the lines below would be the grounded case again.
    expect(Math.hypot(root.rotation.x, root.rotation.z)).toBeGreaterThan(0.01);
    /*
     * AND THE CREATURE IS UPRIGHT INSIDE IT. The mass leans; the thing at its
     * middle does not, because a creature that rolled with the mass it is
     * inside would be upside down half the time (`growPass` counters the
     * root's orientation on the rider and puts the heading back).
     */
    rider.updateWorldMatrix(true, false);
    const up = new Vector3(0, 1, 0).applyQuaternion(
      rider.getWorldQuaternion(new Quaternion()),
    );
    expect(up.y).toBeCloseTo(1, 6);
    expect(Math.hypot(up.x, up.z)).toBeLessThan
      (1e-6);
    manager.clearAll();
  });

  it('is katamari only — no other world can be made weightless', () => {
    const plain = makeManager(FLAT_SURFACE, 'none');
    const root = rootOf(plain);
    holdAt(plain, 4, 4, 60);
    // The same call the driver would make, on a world with no game.
    plain.setGravity(false);
    expect(plain.gravity()).toBe(true);
    holdAt(plain, 4, 4, 200);
    expect(plain.floatOffset('ball')).toBe(0);
    expect(plain.floatBlend('ball')).toBe(0);
    expect(root.position.y).toBe(FLAT_SURFACE.sampleHeight(4, 4));
    expect(root.rotation.x).toBe(0);
    plain.clearAll();
  });

  it('every float spring is ζ ≥ 1, like everything else that moves', () => {
    // The damping-audit gate (TASTE §7) reads the same registry; this is the
    // local statement that the new spring is in it and is not underdamped.
    const manager = makeManager(FLAT_SURFACE, 'katamari');
    manager.setGravity(false);
    holdAt(manager, 4, 4, 30);
    for (const entry of springRegistry) expect(entry.zeta).toBeGreaterThanOrEqual(1);
    manager.clearAll();
  });
});

describe('drive — a creature under somebody’s thumb', () => {
  /**
   * The stick states an intent; the world decides what happens. So these
   * assert that the intent gets through AND that nothing else was bypassed
   * to make it get through — a driven creature is the creature, moving,
   * not a cursor wearing its shape (src/world/joystick.ts).
   */

  function driving() {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, { autoHatch: false });
    manager.spawn('mine', circleBlob, { hatchMs: 60_000, grown: true });
    return manager;
  }

  const run = (manager: ReturnType<typeof createCreatureManager>, frames: number) => {
    for (let f = 0; f < frames; f++) manager.update(16, 1000 + f * 16);
  };

  it('walks the way it is pushed', () => {
    const manager = driving();
    const from = manager.poses()[0]!;
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    run(manager, 60);
    const to = manager.poses()[0]!;

    // A full second at the creature's own speed: it has to have gone
    // somewhere, and it has to have gone the way it was asked.
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    expect(Math.hypot(dx, dz)).toBeGreaterThan(0.5);
    expect(dx).toBeGreaterThan(Math.abs(dz));
    manager.clearAll();
  });

  it('gives the creature back to its own agent when the thumb lifts', () => {
    const manager = driving();
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    run(manager, 30);
    expect(manager.driven()).toEqual(['mine']);

    // Thirty more frames of being pushed, to measure what obeying looks
    // like — the agent is free to idle, so an absolute distance would be
    // asserting the creature's mood rather than the release.
    const beforeRelease = manager.poses()[0]!;
    run(manager, 30);
    const obeying = manager.poses()[0]!;
    const drivenX = obeying.x - beforeRelease.x;

    manager.drive('mine', null);
    expect(manager.driven()).toEqual([]);

    const a = manager.poses()[0]!;
    run(manager, 30);
    const b = manager.poses()[0]!;
    // It must stop MARCHING. A leaked drive is a creature that keeps going
    // in the pushed direction at the pushed speed with nobody's thumb on
    // it, which is precisely what this compares against.
    expect(Number.isFinite(b.x)).toBe(true);
    expect(b.x - a.x).toBeLessThan(drivenX * 0.9);
    manager.clearAll();
  });

  it('treats a zero-strength drive as letting go', () => {
    // The release normally arrives as a rest frame rather than a null, so
    // the two have to mean the same thing.
    const manager = driving();
    manager.drive('mine', { x: 1, z: 0, mag: 0 });
    expect(manager.driven()).toEqual([]);
    manager.clearAll();
  });

  it('turns toward the push instead of snapping to it', () => {
    const manager = driving();
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    run(manager, 40);
    const facing = manager.poses()[0]!.heading;

    // Reverse the stick between one frame and the next, as a thumb can.
    manager.drive('mine', { x: -1, z: 0, mag: 1 });
    manager.update(16, 2000);
    const afterOneFrame = manager.poses()[0]!.heading;
    const turned = Math.abs(
      Math.atan2(Math.sin(afterOneFrame - facing), Math.cos(afterOneFrame - facing)),
    );
    // It moved, but nowhere near the half turn it was asked for: a 180°
    // spin in 16ms is a hard cut in orientation, which the motion law
    // forbids whether or not a person asked for it.
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThan(Math.PI / 3);
    manager.clearAll();
  });

  it('still collides — the person is not driving through a rock', () => {
    // The intent replaces the agent's velocity and nothing else. If drive
    // wrote positions instead, this is the test that would catch it.
    const rock: Collider = { x: 14, z: -6, r: 1.6, hard: true };
    const world = stubWorld([rock]);
    const manager = createCreatureManager(world, { autoHatch: false });
    manager.spawn('mine', circleBlob, { hatchMs: 60_000, grown: true });
    const start = manager.poses()[0]!;

    // Push straight at the rock, for long enough to be well past it.
    const toRock = { x: rock.x - start.x, z: rock.z - start.z };
    const len = Math.hypot(toRock.x, toRock.z);
    manager.drive('mine', { x: toRock.x / len, z: toRock.z / len, mag: 1 });
    run(manager, 240);

    const end = manager.poses()[0]!;
    const gap = Math.hypot(end.x - rock.x, end.z - rock.z);
    expect(gap).toBeGreaterThan(rock.r);
    manager.clearAll();
  });

  it('says so when there is nothing there to steer', () => {
    const manager = driving();
    expect(manager.drive('mine', { x: 1, z: 0, mag: 1 })).toBe(true);
    expect(manager.drive('nobody', { x: 1, z: 0, mag: 1 })).toBe(false);
    manager.clearAll();
  });
});

describe('drive hold — the stick owns the creature, the wander ai waits', () => {
  /**
   * The fight (user ask, 2026-09-09: *"the automated character walk fights
   * the user control"*): the agent used to keep choosing and turning under
   * a person's thumb, so every pause between two pushes was the creature
   * setting off somewhere nobody had asked for. The hold stands the agent
   * down while a hand is on it and for DRIVE_IDLE_MS after the last push.
   */

  function held() {
    const manager = createCreatureManager(stubWorld([]), { autoHatch: false });
    manager.spawn('mine', circleBlob, { hatchMs: 60_000, grown: true });
    return manager;
  }

  /** A clock the test owns: the manager compares the window against the
   * `nowMs` it is stepped with, so the test can walk it deliberately. */
  function clock(manager: ReturnType<typeof createCreatureManager>, start = 10_000) {
    let now = start;
    return {
      get now() {
        return now;
      },
      run(ms: number, dt = 16) {
        for (let t = 0; t < ms; t += dt) {
          now += dt;
          manager.update(dt, now);
        }
      },
    };
  }

  it('stands the agent down while the stick is down', () => {
    const manager = held();
    const spy = vi.spyOn(BehaviorAgent.prototype, 'update');
    const c = clock(manager);
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    c.run(320);
    expect(spy.mock.calls.length).toBeGreaterThan(10);
    // Every single step of the agent was a held one.
    for (const call of spy.mock.calls) expect(call[6]).not.toBeNull();
    expect(manager.isDriven('mine', c.now)).toBe(true);
    spy.mockRestore();
    manager.clearAll();
  });

  it('keeps holding for DRIVE_IDLE_MS after the thumb lifts, then hands back', () => {
    const manager = held();
    const c = clock(manager);
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    c.run(320);
    manager.drive('mine', null);
    // The stick is at rest but the window is open: still nobody else's.
    expect(manager.driven()).toEqual([]);

    const spy = vi.spyOn(BehaviorAgent.prototype, 'update');
    c.run(DRIVE_IDLE_MS - 400);
    expect(manager.isDriven('mine', c.now)).toBe(true);
    for (const call of spy.mock.calls) expect(call[6]).not.toBeNull();

    spy.mockClear();
    c.run(800);
    expect(manager.isDriven('mine', c.now)).toBe(false);
    // The last steps are the agent's own again — it has the creature back.
    const last = spy.mock.calls[spy.mock.calls.length - 1]!;
    expect(last[6]).toBeNull();
    spy.mockRestore();
    manager.clearAll();
  });

  it('a zero-strength drive neither starts nor extends the hold', () => {
    const manager = held();
    const c = clock(manager);
    const spy = vi.spyOn(BehaviorAgent.prototype, 'update');

    // Nothing but rest frames: the creature was never steered, so the agent
    // never stops living.
    manager.drive('mine', { x: 1, z: 0, mag: 0 });
    c.run(320);
    expect(manager.isDriven('mine', c.now)).toBe(false);
    for (const call of spy.mock.calls) expect(call[6]).toBeNull();

    // And a rest frame arriving late in an open window does not push its
    // end back — a window measured from letting go would never close.
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    c.run(160);
    const lastPush = c.now;
    manager.drive('mine', { x: 1, z: 0, mag: 0 });
    c.run(DRIVE_IDLE_MS - 400);
    expect(manager.isDriven('mine', c.now)).toBe(true);
    c.run(800);
    expect(c.now - lastPush).toBeGreaterThan(DRIVE_IDLE_MS);
    expect(manager.isDriven('mine', c.now)).toBe(false);
    spy.mockRestore();
    manager.clearAll();
  });

  it('lets go as a drift-stop on the heading it was left on — no turn, no brake', () => {
    const manager = held();
    const c = clock(manager);
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    c.run(800);
    manager.drive('mine', null);

    const facing = manager.poses()[0]!.heading;
    let previous = manager.poses()[0]!;
    let step = Infinity;
    let travelled = 0;
    for (let t = 0; t < DRIVE_IDLE_MS - 200; t += 16) {
      c.run(16);
      const at = manager.poses()[0]!;
      const d = Math.hypot(at.x - previous.x, at.z - previous.z);
      // Slowing every frame, never a cut to zero and never a new push.
      expect(d).toBeLessThanOrEqual(step + 1e-6);
      // And never a turn: the creature it hands back is the one that was
      // left facing this way.
      expect(at.heading).toBeCloseTo(facing, 6);
      step = d;
      travelled += d;
      previous = at;
    }
    // It coasted to a stop rather than stopping dead, and it is standing
    // still by the time the window closes.
    expect(travelled).toBeGreaterThan(0.05);
    // A frame of the push moved it ~0.027; the last frame of the coast is
    // under a twentieth of that. Not zero — nothing here fully arrests.
    expect(step).toBeLessThan(0.0015);
    expect(step).toBeGreaterThan(0);
    manager.clearAll();
  });

  it('still resolves colliders while the hold runs', () => {
    // The hold is about intent, not about walking through rocks.
    const rock: Collider = { x: 9, z: 4, r: 1.8, hard: true };
    const manager = createCreatureManager(stubWorld([rock]), { autoHatch: false });
    manager.spawn('mine', circleBlob, { hatchMs: 60_000, grown: true });
    const c = clock(manager);
    const start = manager.poses()[0]!;
    const toRock = { x: rock.x - start.x, z: rock.z - start.z };
    const len = Math.hypot(toRock.x, toRock.z);

    // Pushed straight into the rock, then released against it: the coast
    // out of the release is still travelling at it.
    manager.drive('mine', { x: toRock.x / len, z: toRock.z / len, mag: 1 });
    for (let t = 0; t < 4000; t += 16) {
      c.run(16);
      const at = manager.poses()[0]!;
      expect(Math.hypot(at.x - rock.x, at.z - rock.z)).toBeGreaterThan(rock.r);
    }
    manager.drive('mine', null);
    for (let t = 0; t < DRIVE_IDLE_MS; t += 16) {
      c.run(16);
      const at = manager.poses()[0]!;
      expect(Math.hypot(at.x - rock.x, at.z - rock.z)).toBeGreaterThan(rock.r);
    }
    expect(manager.isDriven('mine', c.now)).toBe(false);
    manager.clearAll();
  });

  it('says nothing is held for a creature that was never there', () => {
    const manager = held();
    expect(manager.isDriven('nobody', 10_000)).toBe(false);
    manager.clearAll();
  });
});

// ── the sticky world (src/creatures/sticky.ts, docs/PLAN.md §7.6) ───────────
/*
 * WHAT THESE PIN, in the user's terms: a small creature that walks into a big
 * one ends up riding on it; the person whose creature is being carried keeps
 * it (their minimap follows the pile, and they get it back when the carrier
 * leaves); and a phone watching the room arrives at exactly the same pile
 * from the event alone, without running a solver and without pretending to
 * have decided anything.
 *
 * `fish` measures ~2.72u and `snowman` ~0.91u, so the snowman is comfortably
 * inside `carryLimit(fish)` = 1.0 × 2.72 = 2.72 and the fish is not inside
 * the snowman's. Deliberately not a hand-set radius: the carry rule turns on
 * the REAL mesh footprint, and a test that set the numbers itself would pass
 * over a generator that had stopped measuring.
 */

describe('sticky — one creature carrying another', () => {
  function pair(opts: { physics?: boolean; game?: WorldGame } = {}): {
    world: WorldHandles;
    manager: ReturnType<typeof createCreatureManager>;
    seen: { kind: string; id: string; item: string }[];
  } {
    const seen: { kind: string; id: string; item: string }[] = [];
    const world = stubWorld([], opts);
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: FLAT_SURFACE,
      // The katamari is a per-world GAME (src/world/game.ts): the piles, the
      // kinematic bodies and the sticky pass only exist in a manager that was
      // told this world plays it. A manager that says nothing is meridian's,
      // and the gate block at the bottom of this file passes 'none' here.
      game: opts.game ?? 'katamari',
      observer: {
        egg: () => {},
        hatch: () => {},
        retire: () => {},
        emote: () => {},
        stick: (r) => seen.push({ kind: 'stick', id: r.id, item: r.item }),
        drop: (r) => seen.push({ kind: 'drop', id: r.id, item: r.item }),
        loose: (item) => seen.push({ kind: 'loose', id: '', item }),
        settle: (r) => seen.push({ kind: 'settle', id: '', item: r.item }),
        crack: (r) => seen.push({ kind: 'crack', id: '', item: r.item }),
        shatter: (r) => seen.push({ kind: 'shatter', id: '', item: r.item }),
      },
    });
    // Grown, so there is no shell to break and no hatch timing in the way.
    manager.spawn('big', fish, { hatchMs: 60_000, grown: true });
    manager.spawn('small', snowman, { hatchMs: 60_000, grown: true });
    return { world, manager, seen };
  }

  /**
   * The live roots, by id.
   *
   * Matched on POSITION rather than on the root's name: the manager names a
   * root after the creature's generated name when the drawer did not sign
   * one, so the name is not the id and a test keyed on it would be pinning
   * the naming table. `positionOf` is the id's own answer.
   */
  function rootsOf(
    world: WorldHandles,
    manager: ReturnType<typeof createCreatureManager>,
  ): Map<string, Group> {
    const out = new Map<string, Group>();
    for (const id of ['big', 'small']) {
      const at = manager.positionOf(id);
      if (!at) continue;
      for (const child of world.scene.children) {
        if (!(child instanceof Group)) continue;
        if (Math.hypot(child.position.x - at.x, child.position.z - at.z) < 1e-6) {
          out.set(id, child);
          break;
        }
      }
    }
    return out;
  }

  it('carries the smaller one: slot state, root parent, and one stick event', () => {
    const { world, manager, seen } = pair({ physics: true });
    const roots = rootsOf(world, manager);
    expect(roots.size).toBe(2);
    const big = roots.get('big')!;
    const small = roots.get('small')!;
    // Standing on each other. Nothing here writes Y — the ground pass owns it.
    small.position.set(big.position.x, small.position.y, big.position.z);
    manager.update(16, 1000);

    const sticks = seen.filter((e) => e.kind === 'stick');
    expect(sticks).toEqual([{ kind: 'stick', id: 'big', item: 'creature:small' }]);
    // The small one now hangs under the big one's clump, not under the scene.
    expect(small.parent?.name).toBe('clump');
    expect(small.parent?.parent).toBe(big);
    expect(world.scene.children).not.toContain(small);

    // And it is still its drawer's creature: the roster reports it, and its
    // pose is where it has been carried TO rather than a clump-local offset.
    expect(manager.liveIds()).toContain('small');
    const pose = manager.poses().find((p) => p.id === 'small')!;
    expect(Math.hypot(pose.x - big.position.x, pose.z - big.position.z)).toBeLessThan(12);

    // Exactly once, however many frames go by.
    manager.update(16, 1016);
    manager.update(16, 1032);
    expect(seen.filter((e) => e.kind === 'stick')).toHaveLength(1);
    manager.clearAll();
  });

  it('grows the carrier, and the growth shows up in the exclusion radius', () => {
    const { world, manager } = pair({ physics: true });
    const roots = rootsOf(world, manager);
    const big = roots.get('big')!;
    const small = roots.get('small')!;
    const before = Math.max(...manager.positions().map((p) => p.r));
    small.position.set(big.position.x, small.position.y, big.position.z);
    manager.update(16, 1000);
    expect(big.scale.x).toBeGreaterThan(1);
    // `positions()` is what the scatter reads for its exclusion radius, so a
    // creature that has eaten something clears more world out of its way.
    expect(Math.max(...manager.positions().map((p) => p.r))).toBeGreaterThan(before);
    manager.clearAll();
  });

  it('sets the passenger down FREE when its carrier leaves, with a drop', () => {
    const { world, manager, seen } = pair({ physics: true });
    const roots = rootsOf(world, manager);
    const big = roots.get('big')!;
    const small = roots.get('small')!;
    small.position.set(big.position.x, small.position.y, big.position.z);
    manager.update(16, 1000);
    expect(small.parent?.name).toBe('clump');
    seen.length = 0;

    manager.clear('big');
    // Back in the world, standing on its own, and its own creature again.
    expect(small.parent).toBe(world.scene);
    expect(manager.liveIds()).toEqual(['small']);
    expect(seen.filter((e) => e.kind === 'drop')).toEqual([
      { kind: 'drop', id: 'big', item: 'creature:small' },
    ]);
    // It answers to its phone again.
    expect(manager.drive('small', { x: 1, z: 0, mag: 1 })).toBe(true);
    expect(manager.driven()).toEqual(['small']);
    manager.clearAll();
  });

  it('a carried creature keeps its stick — and steers its carrier', () => {
    /*
     * THE STUCK REPORT, 2026-09-16: *"my character got stuck."*
     *
     * A carried creature's drive used to be dropped on the floor, so a phone
     * whose creature had been picked up could do nothing with it at all. The
     * ruling is that the player's character always answers its own phone —
     * and since a passenger has no locomotion of its own (its position is a
     * seat on a pile), what the push moves is the PILE. The event on the wire
     * is unchanged: it still names the passenger, and the manager resolves it
     * to the carrier on the frame it applies it.
     */
    const { world, manager } = pair({ physics: true });
    const roots = rootsOf(world, manager);
    const big = roots.get('big')!;
    roots.get('small')!.position.set(big.position.x, 0, big.position.z);
    manager.update(16, 1000);
    expect(manager.drive('small', { x: 1, z: 0, mag: 1 })).toBe(true);
    expect(manager.driven()).toEqual(['small']);

    // Nobody is touching the carrier's own stick, and the carrier moves.
    const from = manager.positionOf('big')!.clone();
    for (let f = 0; f < 60; f++) manager.update(16, 1016 + f * 16);
    const to = manager.positionOf('big')!;
    expect(to.x - from.x).toBeGreaterThan(0.3);
    manager.clearAll();
  });

  it('a viewer reaches the same slot state from the event, deciding nothing', () => {
    // No physics at all: `simulating()` is false, the sticky pass never runs,
    // and the only thing that puts the small one on the pile is the event.
    const { world, manager, seen } = pair();
    expect(manager.simulating()).toBe(false);
    const roots = rootsOf(world, manager);
    const big = roots.get('big')!;
    const small = roots.get('small')!;
    // Overlapping, and a frame goes by. On a viewer that decides nothing.
    small.position.set(big.position.x, small.position.y, big.position.z);
    manager.update(16, 1000);
    expect(small.parent).toBe(world.scene);
    expect(seen).toEqual([]);

    manager.applyStick({
      id: 'big',
      item: 'creature:small',
      ox: 0,
      oy: 2,
      oz: 1,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    // The same state the host's decision produced — and NOT a decision: the
    // observer never fired.
    expect(small.parent?.name).toBe('clump');
    expect(small.parent?.parent).toBe(big);
    expect(seen).toEqual([]);
    expect(manager.liveIds()).toContain('small');
    manager.clearAll();
  });

  it('refuses to seat a creature on itself, or to seat one twice', () => {
    const { world, manager } = pair();
    const small = rootsOf(world, manager).get('small')!;
    const record = {
      item: 'creature:small',
      ox: 0,
      oy: 1,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    };
    manager.applyStick({ ...record, id: 'small' });
    expect(small.parent).toBe(world.scene);
    manager.applyStick({ ...record, id: 'big' });
    expect(small.parent?.name).toBe('clump');
    // A resent batch must not put it on a second pile.
    manager.applyStick({ ...record, id: 'small' });
    expect(small.parent?.parent).toBe(rootsOf(world, manager).get('big'));
    manager.clearAll();
  });

  it('ignores an apply naming a carrier or an item that does not exist', () => {
    const { manager, seen } = pair();
    expect(() =>
      manager.applyStick({
        id: 'ghost',
        item: 'creature:small',
        ox: 0,
        oy: 0,
        oz: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      }),
    ).not.toThrow();
    expect(() =>
      manager.applyDrop({
        id: 'big',
        item: 'creature:nobody',
        x: 0,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      }),
    ).not.toThrow();
    expect(() =>
      manager.applySettle({ item: 'rock:0:0.00:0.00', x: 1, z: 1, qx: 0, qy: 0, qz: 0, qw: 1 }),
    ).not.toThrow();
    expect(seen).toEqual([]);
    manager.clearAll();
  });
});

describe('sticky — impact is in world units per SECOND', () => {
  /*
   * THE UNITS BUG THIS PINS, because it was silent and total.
   *
   * `stepCreatures` integrates `x += vx * subDt / 1000` with `subDt` in
   * MILLISECONDS, so a body's `vx` is world units per SECOND — the same scale
   * as `MAX_SPEED` (1.2), which is how the soft-body nudge has always read it.
   * The sticky pass divided by 1000 on the way into `impactOf`, making every
   * impact a thousand times too small: a creature walking at 1.2 u/s with a
   * ~0.9u body scored 0.001 instead of 1.1, so `breakStrength` 0.6 for a bush
   * and 4 for a tree were unreachable, NO rooted prop could ever come out of
   * the ground, and `shouldDrop` never fired once. Every unit test passed —
   * they all handed `impactOf` its numbers directly.
   *
   * So this one goes end to end: a real creature, driven at a real speed,
   * into a real collider, and the assertion is on what `PropBodies` is asked
   * to do about it.
   */

  /** `PropBodies`, recording what the sticky pass asks of it. */
  function recordingBodies(): {
    api: unknown;
    loosened: string[];
    bumped: { key: string; strength: number }[];
  } {
    const loosened: string[] = [];
    const bumped: { key: string; strength: number }[] = [];
    return {
      loosened,
      bumped,
      api: {
        items: () => [],
        onSettle: () => {},
        onImpact: () => {},
        onTake: () => {},
        registerForeign: () => {},
        unregisterForeign: () => {},
        adopt: () => {},
        release: () => false,
        take: () => true,
        restore: () => null,
        bump: (key: string, _dx: number, _dz: number, strength: number) => {
          bumped.push({ key, strength });
        },
        loosen: (key: string) => {
          loosened.push(key);
          // A plausible item, so the observer's `loose` fires too.
          return { key, kind: 'bush', variant: 0, scale: 1, x: 0, z: 0, r: 1 };
        },
        itemByCollider: () => undefined,
        sideByCollider: () => null,
        sync: () => {},
        update: () => {},
        dispose: () => {},
      },
    };
  }

  /**
   * One creature, driven straight at one collider.
   *
   * The collider is added AFTER the spawn on purpose: `clearSpawnSpot`
   * projects an egg clear of every hard prop, so a prop present at spawn
   * would simply push the creature away from the thing under test.
   */
  function walkInto(c: Omit<Collider, 'x' | 'z'> & { gap: number }): {
    loosened: string[];
    bumped: { key: string; strength: number }[];
    impact: number;
  } {
    const recorded = recordingBodies();
    const colliders: Collider[] = [];
    let version = 1;
    const world = {
      scene: new Scene(),
      cameraRig: { frameAt: () => {} },
      shadows: {
        addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
        removeShadow: () => {},
      },
      bodies: () => recorded.api,
      physics: () => null,
      enablePhysics: async () => {},
      scatter: {
        colliders: () => colliders,
        collidersVersion: () => version,
        positions: () => [],
        nudge: () => {},
      },
    } as unknown as WorldHandles;

    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: FLAT_SURFACE,
      // The sticky pass is the katamari world's (src/world/game.ts).
      game: 'katamari',
      observer: {
        egg: () => {},
        hatch: () => {},
        retire: () => {},
        emote: () => {},
        stick: () => {},
        drop: () => {},
        loose: () => {},
        settle: () => {},
        crack: () => {},
        shatter: () => {},
      },
    });
    /*
     * Exactly MAX_SPEED under the thumb, so the arithmetic in the assertions
     * is the arithmetic in the code rather than times a multiplier.
     *
     * The slider is the ROLLING ceiling and a creature carrying nothing
     * drives at `KATAMARI_WALK_MUL` of it (the walk/roll blend, docs/PLAN.md
     * §7.6) — so `6 / 2.5` puts this walker's ceiling at 1.0, which
     * `driveCeiling` then confirms rather than this comment claiming it.
     */
    manager.setWanderSpeed(KATAMARI_SPEED_MUL / KATAMARI_WALK_MUL);
    manager.spawn('walker', snowman, { hatchMs: 60_000, grown: true });
    expect(manager.driveCeiling('walker')).toBeCloseTo(MAX_SPEED, 6);

    const at = manager.positionOf('walker')!;
    const bodyR = manager.positions().find((p) => p.kind === 'character')!.r;
    // Already overlapping, straight ahead on +x: the first resolve corrects
    // and the contact is reported on the same frame.
    colliders.push({ ...c, x: at.x + bodyR + c.r - c.gap, z: at.z });
    version++;

    manager.drive('walker', { x: 1, z: 0, mag: 1 });
    manager.update(16, 1000);
    return {
      loosened: recorded.loosened,
      bumped: recorded.bumped,
      impact: MAX_SPEED * bodyR,
    };
  }

  it('a walk into a bush is enough to take it out of the ground', () => {
    // A bush's collider is SOFT — it is the only soft prop kind — so it never
    // reaches `resolveHard` and could not be reported through `onContact` at
    // all. Its 0.6 break strength existed and was unreachable.
    const { loosened, bumped, impact } = walkInto({
      r: 1,
      hard: false,
      kind: 'bush',
      key: 'bush:0:9.00:9.00',
      gap: 0.2,
    });
    // ~1.1, comfortably over the bush's 0.6 — and a thousand times the
    // 0.0011 the bug produced.
    expect(impact).toBeGreaterThan(STICKY.bush.breakStrength);
    expect(impact).toBeLessThan(STICKY.tree.breakStrength);
    expect(loosened).toEqual(['bush:0:9.00:9.00']);
    // And it was shoved in the direction it was walked into, always —
    // whatever the verdict.
    expect(bumped.map((b) => b.key)).toContain('bush:0:9.00:9.00');
    expect(bumped[0]!.strength).toBeGreaterThan(0);
    expect(bumped[0]!.strength).toBeLessThanOrEqual(1);
  });

  it('the same walk into a tree bends it and leaves it standing', () => {
    const { loosened, bumped, impact } = walkInto({
      r: 1,
      hard: true,
      kind: 'tree',
      key: 'tree:0:9.00:9.00',
      gap: 0.2,
    });
    expect(impact).toBeLessThan(STICKY.tree.breakStrength);
    // Rooted and unyielding at this speed: the recoil spring is kicked, the
    // tree stays in the ground. A creature has to grow before a forest is
    // food, which is the arc the brief asks for.
    expect(loosened).toEqual([]);
    expect(bumped.map((b) => b.key)).toEqual(['tree:0:9.00:9.00']);
    expect(bumped[0]!.strength).toBeGreaterThan(0);
  });

  it('reports the speed carried INTO the contact, not what survived it', () => {
    // `resolveHard` drops the inward velocity as part of the correction and
    // reports afterwards, so reading the body's velocity in the listener
    // scored a head-on hit — the only kind that matters — as ~0, and nothing
    // was ever bumped hard at all. A tree hit head-on must still register.
    const { bumped } = walkInto({
      r: 1,
      hard: true,
      kind: 'tree',
      key: 'tree:0:1.00:1.00',
      gap: 0.2,
    });
    // impact ≈ 1.1, and the bump strength is min(1, impact / 6) ≈ 0.18. Zero
    // is what the bug gave, so anything clearly above it is the fix.
    expect(bumped[0]!.strength).toBeGreaterThan(0.1);
  });

  it('a building is bumped and never loosened, whatever walks into it', () => {
    const { loosened, bumped } = walkInto({
      r: 2,
      hard: true,
      kind: 'building',
      key: 'building:0:9.00:9.00',
      gap: 0.2,
    });
    expect(loosened).toEqual([]);
    expect(bumped.map((b) => b.key)).toEqual(['building:0:9.00:9.00']);
  });

  it('ignores a collider with no placement key — the landscape water rings', () => {
    // Water blocks a creature and is not a prop. Nothing to bump, nothing to
    // loosen, and no crash for asking.
    const { loosened, bumped } = walkInto({ r: 1, hard: true, gap: 0.2 });
    expect(loosened).toEqual([]);
    expect(bumped).toEqual([]);
  });
});

/**
 * THE KATAMARI IS A PER-WORLD GAME (2026-09-15 user ruling, src/world/game.ts).
 *
 * The default branch builds every world's production deployment at once, and a
 * merge that put the rigid-body rocks and the pickups on meridian had to be
 * reverted. Nothing on this branch may reach meridian or the public world
 * again, so the manager's whole second half is off unless it was created with
 * `{ game: 'katamari' }`.
 *
 * Every assertion below is paired with its katamari twin above — the same
 * stubs, the same overlap, the same frame — so this block measures the gate
 * rather than an inert fixture.
 */
describe('the katamari is a per-world game — a world without it plays none', () => {
  function pair(game: WorldGame): {
    world: WorldHandles;
    manager: ReturnType<typeof createCreatureManager>;
    seen: { kind: string; id: string; item: string }[];
  } {
    const seen: { kind: string; id: string; item: string }[] = [];
    // `physics: true` on purpose: the stub HAS bodies, so the only thing
    // standing between this manager and a simulation is the game.
    const world = stubWorld([], { physics: true });
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: FLAT_SURFACE,
      game,
      observer: {
        egg: () => {},
        hatch: () => {},
        retire: () => {},
        emote: () => {},
        stick: (r) => seen.push({ kind: 'stick', id: r.id, item: r.item }),
        drop: (r) => seen.push({ kind: 'drop', id: r.id, item: r.item }),
        loose: (item) => seen.push({ kind: 'loose', id: '', item }),
        settle: (r) => seen.push({ kind: 'settle', id: '', item: r.item }),
        crack: (r) => seen.push({ kind: 'crack', id: '', item: r.item }),
        shatter: (r) => seen.push({ kind: 'shatter', id: '', item: r.item }),
      },
    });
    manager.spawn('big', fish, { hatchMs: 60_000, grown: true });
    manager.spawn('small', snowman, { hatchMs: 60_000, grown: true });
    return { world, manager, seen };
  }

  /** The live roots by id — the same lookup the sticky block uses. */
  function rootsOf(
    world: WorldHandles,
    manager: ReturnType<typeof createCreatureManager>,
  ): Map<string, Group> {
    const out = new Map<string, Group>();
    for (const id of ['big', 'small']) {
      const at = manager.positionOf(id);
      if (!at) continue;
      for (const child of world.scene.children) {
        if (!(child instanceof Group)) continue;
        if (Math.hypot(child.position.x - at.x, child.position.z - at.z) < 1e-6) {
          out.set(id, child);
          break;
        }
      }
    }
    return out;
  }

  it('never simulates, however many bodies the page has', () => {
    // The gate is the game, not the election: this stub world is a HOST.
    expect(pair('none').manager.simulating()).toBe(false);
    // …and the twin, so the stub really would simulate if it were allowed to.
    expect(pair('katamari').manager.simulating()).toBe(true);
  });

  it('never builds a pile, so nothing sticks and nothing grows', () => {
    const { world, manager, seen } = pair('none');
    const roots = rootsOf(world, manager);
    const big = roots.get('big')!;
    const small = roots.get('small')!;
    // Dead overlapping, and a frame goes by. On the katamari world this is
    // exactly the setup that seats the small one on the big one's clump.
    small.position.set(big.position.x, small.position.y, big.position.z);
    manager.update(16, 1000);
    expect(small.parent).toBe(world.scene);
    expect(seen).toEqual([]);
    // No clump means no growth curve: the root's scale is untouched and the
    // exclusion radius the scatter reads is the measured footprint.
    expect(big.scale.x).toBe(1);
    expect(small.scale.x).toBe(1);
    manager.clearAll();
  });

  it('ignores the six katamari presentations rather than half-applying them', () => {
    // A page in a world with no game can still be handed these — a stale wire
    // batch, a log restored from another world — and it has to answer nothing
    // at all rather than seat an item on a pile it never built.
    const { world, manager, seen } = pair('none');
    const small = rootsOf(world, manager).get('small')!;
    manager.applyStick({
      id: 'big',
      item: 'creature:small',
      ox: 0,
      oy: 2,
      oz: 1,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    expect(small.parent).toBe(world.scene);
    manager.applyDrop({
      id: 'big',
      item: 'creature:small',
      x: 4,
      z: 4,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    manager.applyLoose('tree:3:1.00:1.00', 5, 5);
    manager.applySettle({
      item: 'tree:3:1.00:1.00',
      x: 5,
      z: 5,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    manager.applyCrack('building:1:1.00:1.00', 2);
    manager.applyShatter({
      item: 'building:1:1.00:1.00',
      x: 6,
      z: 6,
      rotY: 0,
      scale: 1,
      kind: 'building',
      variant: 1,
    });
    // Nothing decided, nothing recorded, and no wreck state invented.
    expect(seen).toEqual([]);
    expect(manager.wrecks()).toEqual([]);
    manager.clearAll();
  });
});

/**
 * ROLLING, NOT WALKING — the katamari world only (user ask, 2026-09-16:
 * *"like Katamari Damacy, we should have the character ROLL versus walk.
 * Right now, the walking cycle is way too slow"*).
 *
 * Three things had to become true at once, and each one is worth its own
 * assertion because each one alone would look like the feature and not be it:
 * the CREATURE is inside the pile's rolling group (so eyes and topper turn
 * with the ball instead of a ball rolling beside a walking creature), the
 * walk cycle is OFF (a waddle on top of a roll is two locomotions), and the
 * speeds go up (a ball has no stride to outrun).
 *
 * And the fourth: none of it reaches any other world. The ink/meridian world
 * keeps the walk it shipped with, at the speeds it shipped with — the nested
 * block at the bottom is that assertion.
 */
describe('the creature rolls — katamari locomotion', () => {
  function rolling(game: WorldGame): {
    world: WorldHandles;
    manager: ReturnType<typeof createCreatureManager>;
  } {
    const world = stubWorld([]);
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: FLAT_SURFACE,
      game,
    });
    // Grown: no shell to break, so the rig under test exists on frame one.
    manager.spawn('roller', snowman, { hatchMs: 60_000, grown: true });
    return { world, manager };
  }

  /** The one creature root in the scene. */
  function rootOf(world: WorldHandles): Group {
    for (const child of world.scene.children) {
      if (child instanceof Group && child.name.startsWith('creature ')) return child;
    }
    throw new Error('no creature root');
  }

  function named(root: Object3D, name: string): Object3D | null {
    let found: Object3D | null = null;
    root.traverse((o) => {
      if (found === null && o.name === name) found = o;
    });
    return found;
  }

  function firstMesh(root: Object3D): Mesh | null {
    let found: Mesh | null = null;
    root.traverse((o) => {
      if (found === null && o instanceof Mesh) found = o;
    });
    return found;
  }

  /** How far a quaternion turns, radians in [0, pi]. */
  function angleOf(q: Quaternion): number {
    return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  }

  /**
   * Give a creature a pile, through the EVENT path.
   *
   * `applyStick` is what a viewer applies and what the host's own decision
   * goes through, so a pile built this way is the pile the room agrees on —
   * and passengers are the one item kind that needs no loose-mesh layer to
   * seat, which is why the snacks are creatures.
   *
   * Then run the clock: the blend is a spring over `MOTION.primaryMs`, so
   * this is the slide the ask requires and not a state anybody sets.
   */
  function feed(
    manager: ReturnType<typeof createCreatureManager>,
    id: string,
    count: number,
    settleMs = 0,
  ): void {
    for (let i = 0; i < count; i++) {
      manager.spawn(`snack-${id}-${i}`, snowman, { hatchMs: 60_000, grown: true });
      manager.applyStick({
        id,
        item: `creature:snack-${id}-${i}`,
        ox: 0,
        oy: 1,
        oz: i * 0.1,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    }
    let now = 100_000;
    for (let t = 0; t < settleMs; t += 33) {
      now += 33;
      manager.update(33, now);
    }
  }

  it('puts the drawn creature on the ROOT, beside the pile and never inside it', () => {
    /*
     * REVISED 2026-09-17 (*"we should not scale up the characters as they
     * stick to things"*). The body used to hang INSIDE `clump.group` in a
     * wrapper named `ball`, so the drawn creature was the ball and grew with
     * it. It is a `rider` on the root now: the pile is the ball, the creature
     * is its passenger, and the node divides the root's growth back out of it
     * (docs/PLAN.md §7.6).
     *
     * REVISED AGAIN THE SAME DAY (*"currently there is a bug where the
     * characters are floating in space"*): the name `ball` now belongs to the
     * DRAWN SPHERE (src/creatures/ball.ts), a sibling of the rider on the
     * root — so the assertion is no longer that nothing is called that, it is
     * that the creature does not hang inside it.
     */
    const { world, manager } = rolling('katamari');
    const root = rootOf(world);
    const baseR = measureBodyRadius(manager.latestCharacter()!);

    const clump = named(root, 'clump');
    const rider = named(root, 'rider');
    expect(clump).not.toBeNull();
    expect(rider).not.toBeNull();
    // Beside the pile's rolling group, not in it.
    expect(rider!.parent).toBe(root);
    // The drawn sphere is a SIBLING: on the root, beside the rider and the
    // pile, and holding no part of the creature.
    const ball = named(root, 'ball');
    expect(ball).not.toBeNull();
    expect(ball!.parent).toBe(root);
    expect(ball!.children.length).toBe(0);
    // The clump still sits at the middle of the creature — the roll centre is
    // unchanged, and so is the radius the roll divides by.
    expect(clump!.position.y).toBeCloseTo(baseR, 10);
    // Carrying nothing, the creature is exactly where it always stood and
    // exactly the size it was drawn: `roll` is 0 and `growth` is 1.
    expect(rider!.position.y).toBeCloseTo(0, 12);
    expect(rider!.scale.x).toBeCloseTo(1, 12);

    // And the body really moved: the mesh reaches the root through the rider
    // and through no part of the pile.
    const mesh = firstMesh(root);
    expect(mesh).not.toBeNull();
    let hop: Object3D | null = mesh;
    let viaRider = false;
    let viaClump = false;
    let viaBall = false;
    while (hop) {
      if (hop === rider) viaRider = true;
      if (hop === clump) viaClump = true;
      if (hop === ball) viaBall = true;
      hop = hop.parent;
    }
    expect(viaRider).toBe(true);
    expect(viaClump).toBe(false);
    expect(viaBall).toBe(false);
    manager.clearAll();
  });

  it('returns the pile to identity over one full roll, with the creature upright throughout', () => {
    /*
     * ONE FRAME PER HALF, because a FIRST pose is written rather than eased
     * (see the follow branch): those are the only frames whose displacement
     * is exactly the number this test hands them. The roll is pure
     * integration of travel, so one exact 2piR step and a thousand small ones
     * come to the same place — which the pure version of this pins in
     * test/creatures/sticky.test.ts.
     */
    const { world, manager } = rolling('katamari');
    const root = rootOf(world);
    const clump = named(root, 'clump')!;
    const rider = named(root, 'rider')!;
    /*
     * A BALL FIRST. The roll is scaled by the walk/roll blend now (a creature
     * carrying nothing walks, and a walking creature's ball stays upright),
     * so this settles the blend to 1 before measuring a no-slip roll — eight
     * seconds is deep into a `MOTION.primaryMs` spring's tail, which is what
     * makes the third-decimal assertions below honest.
     */
    feed(manager, 'roller', 3, 8000);
    expect(manager.rollBlend('roller')).toBeCloseTo(1, 6);
    // The pile's radius, which is what the roll is measured against.
    const R = manager.positions().find((p) => p.kind === 'character')!.r;
    manager.pauseAi(true);
    manager.clearFollow();

    const half = { x: root.position.x + Math.PI * R, z: root.position.z };
    manager.followPoses([{ id: 'roller', x: half.x, z: half.z, heading: 0 }]);
    manager.update(16, 1000);
    // Halfway round: a real turn, not a decal sliding across the field.
    expect(angleOf(clump.quaternion)).toBeCloseTo(Math.PI, 3);
    /*
     * …and the CREATURE did not turn with it (2026-09-17). It rides the pile
     * rather than being it, so a pile that is upside down leaves it standing
     * up. The heading is the root's and is 0 here, so its world frame is
     * identity apart from the ambient drift's yaw — which is a yaw, so the
     * node's own Y axis is still straight up.
     */
    root.updateMatrixWorld(true);
    const upAt = (o: Object3D): number => {
      const e = o.matrixWorld.elements;
      return new Vector3(e[4]!, e[5]!, e[6]!).normalize().y;
    };
    expect(upAt(rider)).toBeCloseTo(1, 6);
    expect(upAt(clump)).toBeLessThan(0);

    manager.clearFollow();
    manager.followPoses([{ id: 'roller', x: half.x + Math.PI * R, z: half.z, heading: 0 }]);
    manager.update(16, 1016);
    // A full turn: back where it started, with no residue.
    expect(angleOf(clump.quaternion)).toBeCloseTo(0, 3);
    // And the creature is where it has been the whole way round: upright.
    root.updateMatrixWorld(true);
    expect(upAt(rider)).toBeCloseTo(1, 6);
    expect(upAt(clump)).toBeCloseTo(1, 3);
    manager.clearAll();
  });

  /*
   * WALK FIRST, ROLL WITH MASS (user ask, 2026-09-16: *"let's have them start
   * walking at first and once they hit a few objects they begin to roll
   * because they have mass"*).
   *
   * The gait used to be fed a flat zero on a katamari world, so a hatchling
   * that had picked nothing up slid across the field like a decal. It is a
   * BLEND now — one ζ ≥ 1 spring per creature over `MOTION.primaryMs`,
   * retargeted at `rollTarget(items, growth)` — and it moves three things at
   * once: the gait's amplitude, how much of the travel turns into roll, and
   * the drive ceiling.
   */
  it('walks at spawn: gait running, pile upright, walk ceiling', () => {
    const { world, manager } = rolling('katamari');
    const root = rootOf(world);
    const clump = named(root, 'clump')!;
    expect(manager.rollBlend('roller')).toBe(0);
    expect(manager.driveCeiling('roller')).toBeCloseTo(MAX_SPEED * KATAMARI_WALK_MUL, 6);

    manager.drive('roller', { x: 0, z: 1, mag: 1 });
    let now = 2000;
    for (let i = 0; i < 60; i++) {
      now += 33;
      manager.update(33, now);
    }
    // Really travelling, and WALKING while it does.
    expect(manager.latestCharacter()!.gaitState!().amp).toBeGreaterThan(0.5);
    // And the pile is upright: nothing of the travel became roll.
    expect(angleOf(clump.quaternion)).toBeCloseTo(0, 6);
    manager.clearAll();
  });

  it('rises to a roll over three sticks — monotone, no overshoot, gait to nothing', () => {
    const { manager } = rolling('katamari');
    /*
     * ONE BODY-SIZED ITEM IS ALREADY A PILE — BY MASS (2026-09-17).
     *
     * The rule is `ROLL_MASS_ITEMS` items OR `ROLL_GROWTH` bigger, whichever
     * comes first (src/creatures/sticky.ts), and the snacks `feed` uses are
     * this creature's own drawing at its own size. Since `GROWTH_K` became 4
     * one of them makes the roller about 1.6× — well past 1.08 — so mass gets
     * there on the first pickup rather than on the third. It used to make it
     * 1.07×, a hair under the line, which is the only reason this read 0.
     *
     * The COUNT threshold is what a handful of pebbles reaches instead, and
     * both halves are pinned on the pure function
     * (test/creatures/growth-ladder.test.ts `rollTarget`).
     */
    feed(manager, 'roller', 1, 1000);
    // A second is most of the way up a `MOTION.primaryMs` spring, not all of
    // it: the point is that the target is 1, which it was not before.
    expect(manager.rollBlend('roller')).toBeGreaterThan(0.5);

    // …and it stays a ball as the pile grows: monotone, never past 1.
    feed(manager, 'roller', 2);
    manager.drive('roller', { x: 0, z: 1, mag: 1 });
    let now = 200_000;
    let previous = manager.rollBlend('roller');
    let peak = previous;
    for (let i = 0; i < 300; i++) {
      now += 33;
      manager.update(33, now);
      const blend = manager.rollBlend('roller');
      // Monotone up, and never past 1: the spring is ζ ≥ 1, so there is no
      // frame where a creature is more than fully a ball.
      expect(blend).toBeGreaterThanOrEqual(previous - 1e-12);
      expect(blend).toBeLessThanOrEqual(1);
      peak = Math.max(peak, blend);
      previous = blend;
    }
    expect(peak).toBeGreaterThan(0.99);
    // The walk has gone with it, and the ceiling is the rolling one.
    expect(manager.latestCharacter()!.gaitState!().amp).toBeLessThan(0.02);
    expect(manager.driveCeiling('roller')).toBeCloseTo(MAX_SPEED * KATAMARI_SPEED_MUL, 4);
    manager.clearAll();
  });

  it('walks again when the pile comes off', () => {
    const { manager } = rolling('katamari');
    feed(manager, 'roller', 3, 6000);
    expect(manager.rollBlend('roller')).toBeGreaterThan(0.99);

    // Everything off, one at a time, the way a drop travels.
    for (let i = 0; i < 3; i++) {
      manager.applyDrop({
        id: 'roller',
        item: `creature:snack-roller-${i}`,
        x: 20 + i,
        z: 20,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    }
    let now = 300_000;
    for (let i = 0; i < 300; i++) {
      now += 33;
      manager.update(33, now);
    }
    expect(manager.rollBlend('roller')).toBeLessThan(0.01);
    expect(manager.driveCeiling('roller')).toBeCloseTo(MAX_SPEED * KATAMARI_WALK_MUL, 4);
    manager.clearAll();
  });

  it('gives a passenger its carrier’s blend, not its own', () => {
    const { manager } = rolling('katamari');
    feed(manager, 'roller', 3, 6000);
    expect(manager.rollBlend('roller')).toBeGreaterThan(0.99);
    // A passenger carries nothing of its own — its own spring is at rest —
    // and it is inside a rolling ball, so it rolls with it.
    expect(manager.rollBlend('snack-roller-0')).toBe(manager.rollBlend('roller'));
    manager.clearAll();
  });

  it('is derived on a viewer from the same events, with nothing on the wire', () => {
    /*
     * The blend is never sent (docs/PLAN.md §7.6: poses carry x/z/heading).
     * A viewer holds the same clump off the same `stick` events, so it
     * derives the same number — which is what lets a phone show the same
     * locomotion as the projection without another field in the format.
     */
    const host = rolling('katamari');
    const viewer = rolling('katamari');
    // The viewer decides nothing: no bodies, and its ai is a follower.
    viewer.manager.pauseAi(true);
    feed(host.manager, 'roller', 3, 4000);
    feed(viewer.manager, 'roller', 3, 4000);
    expect(viewer.manager.rollBlend('roller')).toBeCloseTo(
      host.manager.rollBlend('roller'),
      6,
    );
    host.manager.clearAll();
    viewer.manager.clearAll();
  });

  it('rolls PROPORTIONALLY while the blend is climbing', () => {
    /*
     * No snap: at blend 0 the ball node is upright, at 1 it rolls fully, and
     * in between the same travel turns it partly. Measured as a ratio against
     * the no-slip angle for the distance actually covered, so this is the
     * blend and not the speed.
     */
    const { world, manager } = rolling('katamari');
    const root = rootOf(world);
    const clump = named(root, 'clump')!;
    feed(manager, 'roller', 3);
    manager.pauseAi(true);
    manager.clearFollow();

    /*
     * THE RADIUS THE ROLL ACTUALLY USES is the pile's — `clump.R()`, which is
     * `baseR × growth` and is exactly what the phone's own readout measures
     * (`ballDiameter`). The character radius is a different number (the
     * drawn silhouette's) and using it here made the expectation out by a
     * factor of two.
     */
    const R = manager.ballDiameter('roller') / 2;
    expect(R).toBeGreaterThan(0);
    let now = 400_000;
    // One eased frame at a time, walking it a fixed distance.
    const step = 0.2;
    let turned = 0;
    let travelled = 0;
    let blendSum = 0;
    let frames = 0;
    /*
     * The INCREMENTAL turn, `inverse(before) × after`, not the difference of
     * two absolute angles (2026-09-17). `angleOf` answers in [0, π], so the
     * absolute form silently folds a ball that has rolled more than half a
     * turn back toward zero — and since a viewer now leads the host's last
     * pose by its own derived speed (`followPoses`), a frame here covers
     * several times what it used to and the fold was reached. The relative
     * form measures what actually turned, whatever the accumulated attitude.
     */
    const prevQ = new Quaternion();
    const delta = new Quaternion();
    let expected = 0;
    for (let i = 0; i < 20; i++) {
      prevQ.copy(clump.quaternion);
      const from = root.position.x;
      // The blend the roll will be applied AT: the spring is advanced in
      // `growPass`, after the frame's roll, so this frame's turn uses the
      // value standing now.
      const blendNow = manager.rollBlend('roller');
      manager.followPoses([
        { id: 'roller', x: root.position.x + step, z: root.position.z, heading: 0 },
      ]);
      now += 33;
      manager.update(33, now);
      const moved = root.position.x - from;
      travelled += moved;
      turned += angleOf(delta.copy(prevQ).invert().multiply(clump.quaternion));
      expected += (Math.abs(moved) / R) * blendNow;
      blendSum += manager.rollBlend('roller');
      frames++;
    }
    const noSlip = travelled / R;
    const mean = blendSum / frames;
    // Part of the way round, and strictly less than a full no-slip roll,
    // which is what "no snap" means here.
    expect(mean).toBeGreaterThan(0.05);
    expect(mean).toBeLessThan(0.95);
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThan(noSlip);
    /*
     * PROPORTIONAL, exactly: each frame turns the ball by that frame's own
     * travel over the radius, times the blend the pile had when the roll was
     * applied. Summed frame by frame rather than compared against the MEAN
     * blend over the window — the mean is only the same thing when travel
     * and blend are uncorrelated, and they are not: a viewer eases toward a
     * lead now (`followPoses`, 2026-09-17), so the early frames cover more
     * ground while the blend is still climbing.
     *
     * A BAND rather than an equality: the blend is a spring, and which side
     * of the frame's own update the roll read it on is an off-by-one this
     * loop cannot see from outside. Half to one and a half of the prediction
     * is far tighter than the thing it rules out — a snap would be the whole
     * no-slip roll, which at this mean blend is several times bigger.
     */
    expect(turned).toBeGreaterThan(expected * 0.4);
    expect(turned).toBeLessThan(expected * 1.6);
    manager.clearAll();
  });

  /** How fast a creature is actually travelling under a given push, u/s. */
  function drivenSpeed(
    manager: ReturnType<typeof createCreatureManager>,
    id: string,
    push: { x: number; z: number; mag: number },
    startMs = 5000,
  ): number {
    manager.drive(id, push);
    let now = startMs;
    // A few frames to settle the heading onto the stick, then a measured
    // second: the turn is eased, so the first frames are a curve.
    for (let i = 0; i < 10; i++) {
      now += 33;
      manager.update(33, now);
    }
    const from = manager.positionOf(id)!.clone();
    let travelled = 0;
    for (let i = 0; i < 30; i++) {
      now += 33;
      manager.update(33, now);
      travelled += 33;
    }
    const to = manager.positionOf(id)!;
    return (Math.hypot(to.x - from.x, to.z - from.z) / travelled) * 1000;
  }

  it('drives at the katamari top speed — six times the spec pace', () => {
    /*
     * User report, 2026-09-16, off the deployed build: *"we need to up the
     * speed and velocity by a lot."* 3 → 6, so the rolling ceiling is
     * 7.2 u/s and the island is fourteen seconds across instead of thirty.
     */
    const { manager } = rolling('katamari');
    expect(KATAMARI_SPEED_MUL).toBe(9);
    expect(manager.wanderSpeed()).toBe(KATAMARI_SPEED_MUL);
    // A BALL: the rolling ceiling belongs to a creature with mass on it, and
    // a hatchling drives at the walk one (the blend, docs/PLAN.md §7.6).
    feed(manager, 'roller', 3, 8000);
    expect(manager.driveCeiling('roller')).toBeCloseTo(MAX_SPEED * KATAMARI_SPEED_MUL, 4);
    const speed = drivenSpeed(manager, 'roller', { x: 0, z: 1, mag: 1 });
    expect(speed).toBeCloseTo(MAX_SPEED * KATAMARI_SPEED_MUL, 2);
    /*
     * AND THE SUBSTEP GUARD STILL COVERS IT. `stepCreatures` clamps dt at
     * 250ms and advances at most MAX_STEP_TRAVEL (0.25u) per substep over at
     * most MAX_SUBSTEPS (16) — 4u of travel per frame. At this speed a
     * clamped frame is 2.7u (10.8 u/s after the 2026-09-16 "increase it by
     * 50%" ask), ELEVEN of the sixteen substeps, and 0.25u is
     * still well under the smallest footprint on the map (a 0.5u stone), so
     * no substep can leap a collider. Nothing needed raising.
     */
    const clampedFrameTravel = (MAX_SPEED * KATAMARI_SPEED_MUL * 250) / 1000;
    expect(clampedFrameTravel).toBeCloseTo(2.7, 10);
    expect(Math.ceil(clampedFrameTravel / MAX_STEP_TRAVEL)).toBe(11);
    expect(Math.ceil(clampedFrameTravel / MAX_STEP_TRAVEL)).toBeLessThanOrEqual(MAX_SUBSTEPS);
    manager.clearAll();
  });

  it('is proportional to the push — half a stick is a third of the ceiling', () => {
    /*
     * The other half of the same report: *"we should assign speed velocity to
     * the joy stick so the farther the push the faster the character goes."*
     * The stick's own curve is `driveResponse` (src/world/joystick.ts); what
     * this pins is that the manager scales by whatever strength arrives and
     * normalises nothing on the way in.
     */
    const { manager } = rolling('katamari');
    // Whatever this creature's ceiling actually is — a hatchling's walk here,
    // since it is carrying nothing. The claim is the PROPORTION.
    const ceiling = manager.driveCeiling('roller');
    expect(ceiling).toBeCloseTo(MAX_SPEED * KATAMARI_WALK_MUL, 6);
    // Straight through the real handset path: a thumb halfway through the
    // knob's travel, mapped by the camera, curved, driven.
    const half = stickToWorld(
      stickVector(0, 0, 0, -(DEADZONE + (KNOB_TRAVEL - DEADZONE) / 2), 1),
      0,
    );
    expect(half.mag).toBeCloseTo(0.5 ** DRIVE_CURVE, 6);
    expect(drivenSpeed(manager, 'roller', half)).toBeCloseTo(ceiling * half.mag, 2);

    const full = stickToWorld(stickVector(0, 0, 0, -KNOB_TRAVEL, 1), 0);
    expect(full.mag).toBeCloseTo(1, 6);
    expect(drivenSpeed(manager, 'roller', full, 30_000)).toBeCloseTo(ceiling, 2);
    manager.clearAll();
  });

  it('wanders at the WALK ceiling, so an unattended creature does not race', () => {
    /*
     * The ruling with the speed raise (2026-09-16): the STICK gets 7.2 u/s,
     * the ai does not. An unattended creature crossing the island at the
     * rolling ceiling is a world running away from the person watching it.
     *
     * Measured rather than asserted off a constant: twenty seconds of
     * wandering, and the fastest frame in it. The walk ceiling is the agent's
     * own upper bound (`MAX_SPEED × (0.35 + 0.65 × energy) × mult`), so
     * nothing here can reach the rolling one unless the wiring hands it over.
     */
    const world = stubWorld([]);
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: FLAT_SURFACE,
      game: 'katamari',
    });
    // `adventure` is the restless answer: this one actually goes somewhere.
    manager.spawn('rover', snowman, {
      hatchMs: 60_000,
      grown: true,
      personality: 'adventure',
    });
    expect(KATAMARI_WALK_MUL).toBeLessThan(KATAMARI_SPEED_MUL);
    expect(manager.wanderSpeed()).toBe(KATAMARI_SPEED_MUL);

    let now = 5000;
    let last = manager.positionOf('rover')!.clone();
    let fastest = 0;
    for (let i = 0; i < 2400; i++) {
      now += 33;
      manager.update(33, now);
      const at = manager.positionOf('rover')!;
      fastest = Math.max(fastest, (Math.hypot(at.x - last.x, at.z - last.z) / 33) * 1000);
      last = at.clone();
    }
    // It really does wander…
    expect(fastest).toBeGreaterThan(0.2);
    // …and never faster than a walk.
    expect(fastest).toBeLessThanOrEqual(MAX_SPEED * KATAMARI_WALK_MUL * 1.02);
    manager.clearAll();
  });

  it('picks up momentum at once — no ramp between the thumb and the ceiling', () => {
    /*
     * User ask, 2026-09-16: *"relax the actual physics a little bit so that
     * it's a bit easier to pick up momentum."* The manager substitutes the
     * stick's velocity directly (`driveVx = driven.x × ceiling`) rather than
     * easing a speed toward it, so the acceleration is one frame — well
     * inside the ~400 ms the ask allows. Pinned because the obvious "fix" for
     * a stick that feels jerky is to put a spring here, and that spring would
     * be the lag the report was about.
     */
    const { manager } = rolling('katamari');
    const ceiling = manager.driveCeiling('roller');
    manager.drive('roller', { x: 0, z: 1, mag: 1 });
    let now = 5000;
    let last = manager.positionOf('roller')!.clone();
    let covered = 0;
    // 400ms of frames, measured from the very first one.
    for (let i = 0; i < 12; i++) {
      now += 33;
      manager.update(33, now);
      const at = manager.positionOf('roller')!;
      covered += Math.hypot(at.x - last.x, at.z - last.z);
      last = at.clone();
    }
    expect((covered / (12 * 33)) * 1000).toBeGreaterThan(ceiling * 0.9);

    /*
     * AND A TURN DOES NOT COST IT. The velocity is the STICK's direction, not
     * the creature's facing — the facing eases behind it (`turnTauMs`) — so
     * swinging the thumb changes where the creature is going without ever
     * taking its speed away.
     */
    manager.drive('roller', { x: 1, z: 0, mag: 1 });
    last = manager.positionOf('roller')!.clone();
    covered = 0;
    for (let i = 0; i < 9; i++) {
      now += 33;
      manager.update(33, now);
      const at = manager.positionOf('roller')!;
      covered += Math.hypot(at.x - last.x, at.z - last.z);
      last = at.clone();
    }
    expect((covered / (9 * 33)) * 1000).toBeGreaterThan(ceiling * 0.9);
    manager.clearAll();
  });

  it('turns tighter at the katamari speed, and still cannot overshoot', () => {
    /*
     * At 7.2 u/s a 200ms heading lag is a metre and a half of sliding, so the
     * turn constant is shorter here (KATAMARI_TURN_TAU_MS). Exponential
     * either way: monotone, and it never crosses the heading it is going to.
     */
    expect(KATAMARI_TURN_TAU_MS).toBeLessThan(DRIVE_TURN_TAU_MS);
    const { manager } = rolling('katamari');
    manager.drive('roller', { x: 0, z: 1, mag: 1 });
    let now = 5000;
    for (let i = 0; i < 40; i++) {
      now += 33;
      manager.update(33, now);
    }
    const facing = manager.poses()[0]!.heading;
    // A quarter turn asked for, and a quarter turn arrived at inside 250ms —
    // approached from one side, never past it.
    manager.drive('roller', { x: 1, z: 0, mag: 1 });
    let overshoot = 0;
    for (let i = 0; i < 8; i++) {
      now += 33;
      manager.update(33, now);
      const turned = Math.abs(
        Math.atan2(
          Math.sin(manager.poses()[0]!.heading - facing),
          Math.cos(manager.poses()[0]!.heading - facing),
        ),
      );
      overshoot = Math.max(overshoot, turned);
    }
    expect(overshoot).toBeGreaterThan(Math.PI / 2 * 0.8);
    expect(overshoot).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    manager.clearAll();
  });

  /*
   * HOW BIG THE BALL IS — the number its phone shows (user ask, 2026-09-16:
   * *"for the mobile ui on the world view i want to show ball diameter in
   * the top left hand side"*).
   *
   * `ballDiameter` is a READOUT of the radius the rest of the manager
   * already runs on (`bodyR = baseR × clump.growth()`, written by
   * `growPass`), not a second measurement of the same ball — so these pin
   * the wiring, the passenger rule and the gate rather than a curve.
   * src/ui/size.ts is what turns it into a length, and test/ui/size.test.ts
   * pins that half.
   */
  describe('how big the ball is — the readout its phone shows', () => {
    it('is twice the measured footprint before anything is picked up', () => {
      const { manager } = rolling('katamari');
      const baseR = measureBodyRadius(manager.latestCharacter()!);
      manager.update(33, 1000);
      // Growth is 1 on an empty pile, so the ball is the creature.
      expect(manager.ballDiameter('roller')).toBeCloseTo(2 * baseR, 10);
      manager.clearAll();
    });

    it('grows with the pile, and stays twice the radius everything else uses', () => {
      const { manager } = rolling('katamari');
      const baseR = measureBodyRadius(manager.latestCharacter()!);
      const before = manager.ballDiameter('roller');
      feed(manager, 'roller', 3, 8000);
      const after = manager.ballDiameter('roller');
      expect(after).toBeGreaterThan(before);
      expect(after).toBeGreaterThan(2 * baseR);
      // The SAME radius the resolve pass, the pickup reach and the scatter's
      // exclusion radius read — `positions()` reports `bodyR` directly.
      const r = manager.positions().find((at) => at.kind === 'character')!.r;
      expect(after).toBeCloseTo(2 * r, 10);
      manager.clearAll();
    });

    it('answers with the CARRIER\u2019s ball for a passenger riding one', () => {
      const { manager } = rolling('katamari');
      feed(manager, 'roller', 1, 500);
      // `feed` seats `snack-roller-0` on the roller's pile through the event
      // path — so that creature's own phone is looking at a ball it is
      // inside, not at the snowman it drew.
      const carrier = manager.ballDiameter('roller');
      expect(carrier).toBeGreaterThan(0);
      expect(manager.ballDiameter('snack-roller-0')).toBe(carrier);
      manager.clearAll();
    });

    it('is zero for a shell, and for an id nobody holds', () => {
      const { manager } = rolling('katamari');
      // No footprint until hatch, so no ball to put a size on — which is
      // what keeps the corner empty until the creature is out.
      manager.spawn('shell', snowman, { hatchMs: 60_000 });
      expect(manager.ballDiameter('shell')).toBe(0);
      expect(manager.ballDiameter('nobody')).toBe(0);
      manager.clearAll();
    });
  });

  /*
   * THE OTHER WORLDS WALK, at the speeds they always did. Same stubs, same
   * frames, same stick — only the game differs, so this measures the gate.
   */
  describe('every other world keeps its walk cycle', () => {
    it('leaves the body mesh on the root, with no rolling group at all', () => {
      const { world, manager } = rolling('none');
      const root = rootOf(world);
      expect(named(root, 'clump')).toBeNull();
      expect(named(root, 'ball')).toBeNull();
      // The two-level rig, exactly as it shipped: the root holds the
      // character group, and the mesh is one level down inside it.
      const mesh = firstMesh(root)!;
      expect(mesh.parent!.parent).toBe(root);
      manager.clearAll();
    });

    it('has no ball at all, so the size readout is never reached', () => {
      /*
       * THE GATE (2026-09-15 user ruling, src/world/game.ts). `bodyR` is a
       * real measured footprint in every world — it is what the resolve pass
       * runs on — so the readout has to answer 0 on the GAME rather than on
       * the radius, or the corner would show a creature's own width as a
       * ball diameter on meridian and on the public world.
       */
      const { manager } = rolling('none');
      manager.update(33, 1000);
      expect(manager.positions().find((at) => at.kind === 'character')!.r).toBeGreaterThan(0);
      expect(manager.ballDiameter('roller')).toBe(0);
      // …and the katamari twin, so this measures the gate rather than a
      // creature that happens to have no size.
      expect(rolling('katamari').manager.ballDiameter('roller')).toBeGreaterThan(0);
      manager.clearAll();
    });

    it('still walks, and still at the shipped speeds', () => {
      // The speed constants themselves are untouched by the katamari work.
      expect(DRIVE_SPEED).toBe(MAX_SPEED);
      expect(WANDER_SPEED_DEFAULT).toBe(1.4);

      const { manager } = rolling('none');
      expect(manager.wanderSpeed()).toBe(WANDER_SPEED_DEFAULT);
      manager.drive('roller', { x: 0, z: 1, mag: 1 });
      let now = 5000;
      now += 33;
      manager.update(33, now);
      const from = manager.positionOf('roller')!.clone();
      let travelled = 0;
      for (let i = 0; i < 30; i++) {
        now += 33;
        manager.update(33, now);
        travelled += 33;
      }
      const to = manager.positionOf('roller')!;
      const speed = (Math.hypot(to.x - from.x, to.z - from.z) / travelled) * 1000;
      expect(speed).toBeCloseTo(DRIVE_SPEED * WANDER_SPEED_DEFAULT, 2);
      // And the walk cycle is running — amplitude, not a rolling ball.
      expect(manager.latestCharacter()!.gaitState!().amp).toBeGreaterThan(0.5);
      manager.clearAll();
    });
  });
});

/**
 * THE CHARACTER HAS PRIORITY (user ruling, 2026-09-16: *"the user's
 * character has priority; objects should stick to it as it moves or rolls
 * over the object. It shouldn't impede the character from moving unless the
 * mass isn't big enough to overtake the object"*).
 *
 * The pair above this block — a walk into a `r: 1` bush and into a `r: 1`
 * tree — is the OTHER half of the same rule: a ~0.91u snowman's carry limit
 * is 0.91, so a 1u prop is still too big, still blocks, and still goes
 * through the impact ladder. These tests use a 0.5u prop, which is inside
 * the limit, and pin the part that changed: it comes up whole, it emits one
 * `stick` and no `loose`, and it never slows the creature down.
 */
describe('the character has priority — what it can carry cannot stop it', () => {
  /** A `LooseMeshes` that draws nothing and remembers everything. */
  function stubLoose(scene: Scene): { api: LooseMeshes; shown: string[] } {
    const shown: string[] = [];
    const objects = new Map<string, Object3D>();
    return {
      shown,
      api: {
        show(item: string): Object3D {
          const existing = objects.get(item);
          if (existing) return existing;
          const object = new Group();
          scene.add(object);
          objects.set(item, object);
          shown.push(item);
          return object;
        },
        move: () => {},
        remove: () => {},
        get: (item: string) => objects.get(item),
        dispose: () => {},
      },
    };
  }

  /**
   * One creature driven straight at one prop, with everything the uproot
   * path actually touches: a `PropBodies` that records, a loose layer to draw
   * the thing into, and `instanceRefs` so the placement has a measurable
   * scale and radius.
   */
  function rollOver(
    c: Omit<Collider, 'x' | 'z'> & { gap: number; mag?: number; turn?: boolean },
  ): {
    stuck: string[];
    loosed: string[];
    bumped: string[];
    taken: string[];
    /** How far the creature actually travelled on the contact frame. */
    travelled: number;
    bodyR: number;
  } {
    const stuck: string[] = [];
    const loosed: string[] = [];
    const bumped: string[] = [];
    const taken: string[] = [];
    const colliders: Collider[] = [];
    let version = 1;
    const scene = new Scene();
    const loose = stubLoose(scene);
    const bodies = {
      items: () => [],
      onSettle: () => {},
      onImpact: () => {},
      onTake: () => {},
      registerForeign: () => {},
      unregisterForeign: () => {},
      adopt: () => {},
      release: () => false,
      take: (key: string) => {
        taken.push(key);
        return true;
      },
      restore: () => null,
      bump: (key: string) => {
        bumped.push(key);
      },
      loosen: (key: string) => {
        loosed.push(key);
        return { key, kind: c.kind, variant: 0, scale: 1, x: 0, z: 0, r: c.r };
      },
      itemByCollider: () => undefined,
      sideByCollider: () => null,
      sync: () => {},
      update: () => {},
      dispose: () => {},
    };
    const world = {
      scene,
      cameraRig: { frameAt: () => {} },
      shadows: {
        addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
        removeShadow: () => {},
      },
      bodies: () => bodies,
      physics: () => null,
      enablePhysics: async () => {},
      scatter: {
        colliders: () => colliders,
        collidersVersion: () => version,
        positions: () => [],
        nudge: () => {},
        setTaken: () => {},
        // What `placementDrawn` reads: the row the prop is drawn from.
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
      surface: FLAT_SURFACE,
      game: 'katamari',
      loose: loose.api,
      observer: {
        egg: () => {},
        hatch: () => {},
        retire: () => {},
        emote: () => {},
        stick: (r) => stuck.push(r.item),
        drop: () => {},
        loose: (item) => loosed.push(item),
        settle: () => {},
        crack: () => {},
        shatter: () => {},
      },
    });
    // MAX_SPEED exactly under the thumb (see `walkInto` above for the
    // 6 / 2.5: the slider is the rolling ceiling, a creature carrying
    // nothing drives at the walk fraction of it).
    manager.setWanderSpeed(KATAMARI_SPEED_MUL / KATAMARI_WALK_MUL);
    manager.spawn('walker', snowman, { hatchMs: 60_000, grown: true });
    expect(manager.driveCeiling('walker')).toBeCloseTo(MAX_SPEED, 6);

    const at = manager.positionOf('walker')!.clone();
    const bodyR = manager.positions().find((p) => p.kind === 'character')!.r;
    // Already overlapping, straight ahead on +x.
    colliders.push({ ...c, x: at.x + bodyR + c.r - c.gap, z: at.z });
    version++;

    const mag = c.mag ?? 1;
    manager.drive('walker', { x: mag, z: 0, mag });
    manager.update(16, 1000);
    if (c.turn === true) {
      // Mid-contact, the thumb swings a quarter turn: the pickup must not
      // depend on which way the creature happens to be facing.
      manager.drive('walker', { x: 0, z: mag, mag });
      manager.update(16, 1016);
    }
    const after = manager.positionOf('walker')!;
    const travelled = after.x - at.x;
    manager.clearAll();
    return { stuck, loosed, bumped, taken, travelled, bodyR };
  }

  it('rolls over a small bush and wears it — one stick, no loose, no slowdown', () => {
    const { stuck, loosed, bumped, taken, travelled, bodyR } = rollOver({
      r: 0.5,
      hard: false,
      kind: 'bush',
      key: 'bush:0:9.00:9.00',
      gap: 0.2,
    });
    // Inside its own limit, which is the whole test.
    expect(0.5).toBeLessThanOrEqual(carryLimit(bodyR));
    // Straight onto the pile: ONE stick event, and no round trip through
    // the ground on the way.
    expect(stuck).toEqual(['bush:0:9.00:9.00']);
    expect(loosed).toEqual([]);
    // Nothing flinched: uprooting something smaller than you costs nothing.
    expect(bumped).toEqual([]);
    // And the placement is gone, through the one owner.
    expect(taken).toContain('bush:0:9.00:9.00');
    // NO SOFT SLOWDOWN. A damped frame would travel MAX_SPEED x 0.45 x 16ms;
    // this travelled the undamped distance.
    const full = (MAX_SPEED * 16) / 1000;
    expect(travelled).toBeCloseTo(full, 4);
    expect(travelled).toBeGreaterThan(full * SOFT_SPEED_FACTOR * 1.5);
  });

  it('rolls over a small tree without being stopped by its trunk', () => {
    const { stuck, loosed, travelled } = rollOver({
      r: 0.5,
      hard: true,
      kind: 'tree',
      key: 'tree:0:9.00:9.00',
      gap: 0.2,
    });
    // A HARD collider it can carry: the resolve skipped it (`skipIf`), so the
    // creature kept its whole frame of travel instead of being pushed back to
    // contact — which is the ruling in one number.
    expect(travelled).toBeCloseTo((MAX_SPEED * 16) / 1000, 4);
    expect(stuck).toEqual(['tree:0:9.00:9.00']);
    expect(loosed).toEqual([]);
  });

  it('is still stopped by a tree far bigger than it can carry', () => {
    const { stuck, loosed, bumped, travelled } = rollOver({
      // Over `passLimit` — a ~0.91u snowman pushes past anything up to 1.46u
      // since the 2026-09-16 relaxation, so a wall has to be bigger than it
      // used to be to still be a wall.
      r: 2.4,
      hard: true,
      kind: 'tree',
      key: 'tree:0:4.00:4.00',
      gap: 0.2,
    });
    // Over the block line: blocked at contact — it started 0.2u inside the
    // circle, so the correction pushes it BACK, and it ends the frame behind
    // where it began rather than a frame's travel ahead.
    expect(travelled).toBeLessThan(0);
    expect(stuck).toEqual([]);
    // Nothing came up, and the trunk flinched — the old ladder, untouched.
    expect(loosed).toEqual([]);
    expect(bumped).toEqual(['tree:0:4.00:4.00']);
  });

  /*
   * RELAXED, per the third stuck report (2026-09-16: *"I think we can relax
   * the actual physics a little bit so that it's a bit easier to pick up
   * momentum and pick things up to your character"*).
   */
  it('pushes PAST a tree between its carry limit and the block ratio', () => {
    const { stuck, loosed, bumped, travelled, bodyR } = rollOver({
      r: 1.2,
      hard: true,
      kind: 'tree',
      key: 'tree:0:6.00:6.00',
      gap: 0.2,
    });
    // In the band: too big to wear, not big enough to stop it.
    expect(1.2).toBeGreaterThan(carryLimit(bodyR));
    expect(1.2).toBeLessThan(passLimit(bodyR));
    expect(stuck).toEqual([]);
    // It kept going — slowed to the soft-body factor, never held.
    expect(travelled).toBeGreaterThan(0);
    expect(travelled).toBeCloseTo((MAX_SPEED * SOFT_SPEED_FACTOR * 16) / 1000, 4);
    // And the tree still took the hit it always took.
    expect(bumped).toEqual(['tree:0:6.00:6.00']);
    expect(loosed).toEqual([]);
  });

  it('sticks at a crawl — there is no speed threshold on a pickup', () => {
    const { stuck, travelled } = rollOver({
      r: 0.5,
      hard: true,
      kind: 'tree',
      key: 'tree:0:7.00:7.00',
      gap: 0.2,
      // A twentieth of the stick: as slow as a hand can ask for.
      mag: 0.05,
    });
    expect(stuck).toEqual(['tree:0:7.00:7.00']);
    expect(travelled).toBeGreaterThan(0);
  });

  it('sticks while the thumb is turning, not only while it is pointing at it', () => {
    const { stuck } = rollOver({
      r: 0.5,
      hard: false,
      kind: 'bush',
      key: 'bush:0:8.00:8.00',
      gap: 0.2,
      turn: true,
    });
    expect(stuck).toEqual(['bush:0:8.00:8.00']);
  });
});
