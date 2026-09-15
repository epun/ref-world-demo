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
import { Group, Mesh, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createCharacter } from '../../src/character/character';
import {
  DRIVE_IDLE_MS,
  MAX_POPULATION,
  chooseEviction,
  createCreatureManager,
  measureBodyRadius,
  spawnSpot,
  SPAWN_RADIUS,
} from '../../src/creatures/manager';
import { BehaviorAgent, MAX_SPEED } from '../../src/behavior/agent';
import { generatedName } from '../../src/creatures/naming';
import { MOTION } from '../../src/taste/tokens';
import { STICKY } from '../../src/creatures/sticky';
import { EGG_RADIUS } from '../../src/egg/egg';
import type { Collider } from '../../src/physics/colliders';
import type { WorldHandles } from '../../src/world/scene';
import type { WorldGame } from '../../src/world/game';
import { FLAT_SURFACE, ROLLING_SURFACE, type Surface } from '../../src/world/surface';
import { isWater } from '../../src/world/landscape';
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
 * inside `carryLimit(fish)` = 0.6 × 2.72 = 1.63 and the fish is not inside
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

  it('ignores a drive on a carried creature rather than refusing it', () => {
    // A `false` would have the handset report the creature gone, which it is
    // not: it is on a pile, and it will answer again the moment it is down.
    const { world, manager } = pair({ physics: true });
    const roots = rootsOf(world, manager);
    const big = roots.get('big')!;
    roots.get('small')!.position.set(big.position.x, 0, big.position.z);
    manager.update(16, 1000);
    expect(manager.drive('small', { x: 1, z: 0, mag: 1 })).toBe(true);
    expect(manager.driven()).toEqual([]);
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
    // Exactly MAX_SPEED under the thumb, so the arithmetic in the assertions
    // is the arithmetic in the code rather than times the wander multiplier.
    manager.setWanderSpeed(1);
    manager.spawn('walker', snowman, { hatchMs: 60_000, grown: true });

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
