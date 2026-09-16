/**
 * THE STUCK DETECTOR — *"my character got stuck."*
 *
 * > User report, 2026-09-16, from a phone on the `valiocon` world: *"my
 * > character got stuck. we should assign speed velocity to the joy stick so
 * > the farther the push the faster the character goes."*
 *
 * Two halves, and they are different kinds of test.
 *
 * THE FIRST is the root cause, and it is arithmetic rather than a landscape:
 * with `PICKUP_RATIO` at 1.0 and the same ratio deciding a PASSENGER, two
 * creatures of equal size were each exactly at the other's limit, so the
 * first contact made one of them somebody's luggage — and a carried
 * creature's drive was thrown away. The stick did nothing, for as long as the
 * pile held it. `CREATURE_CARRY_RATIO` is the size gap that makes that
 * unrepresentable, and a passenger's push now reaches its carrier.
 *
 * THE SECOND is a sweep, because "stuck" is a claim about a whole map and no
 * single collider pair proves it. One hatchling is driven from six spawn
 * points in eight headings for ten seconds each, over the REAL island
 * geography and the REAL scatter (the katamari placement source, the sea
 * wall, the ponds, the forest, the range), through the same resolve path the
 * host runs. The invariant: while it is being driven it never fails to cover
 * 0.05u over any 1.5s window, UNLESS it is pressed against something rooted
 * and bigger than it can carry — and even then, turning 90° has to free it
 * inside 1.5s. A world where a wall can be leaned on is fine; a world where
 * a wall can hold you is the bug.
 *
 * THE THIRD is the same sweep with the REAL rapier world under it — the
 * heightfield, the fixed cylinders, the stone hulls, the contact-pair filter
 * and the kinematic ball — because the second report came off the deployed
 * build, where all of that is running. The compat build inlines its wasm, so
 * the solver really runs here; the block at the bottom of this file is where
 * the second root cause turned up.
 */

import { Group, Scene, type Object3D } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SPEED } from '../../src/behavior/agent';
import {
  createCreatureManager,
  KATAMARI_SPEED_MUL,
  type CreatureManager,
} from '../../src/creatures/manager';
import { carryLimit, CONTACT_PAD, creatureCarryLimit } from '../../src/creatures/sticky';
import type { Collider } from '../../src/physics/colliders';
import { createPhysicsWorld, type PhysicsWorld } from '../../src/physics/world';
import { FIELD_SIZE } from '../../src/world/ground';
import { katamariPendingSource } from '../../src/world/katamari/source';
import { createPropBodies, type PropBodies } from '../../src/world/rocks';
import {
  coastInland,
  isWater,
  setIslandMode,
  setLandscapeMode,
} from '../../src/world/landscape';
import type { LooseMeshes } from '../../src/world/loose';
import { setActivePropSource } from '../../src/world/props';
import {
  createScatter,
  VARIATION_BULGE,
  VARIATION_SCALE_XZ,
  type Scatter,
} from '../../src/world/scatter';
import type { WorldHandles } from '../../src/world/scene';
import { ROLLING_SURFACE } from '../../src/world/surface';
import { snowman } from '../fixtures/strokes';

type RapierCollider = import('@dimforge/rapier3d-compat').Collider;

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

/** The resolve's own visual pad on every hard collider (see the manager). */
const HARD_PAD = 1 + VARIATION_SCALE_XZ + VARIATION_BULGE;

/** Frame length for the sweep, ms — a phone's, not a projection's. */
const FRAME_MS = 33;
/** The window the invariant is stated over, ms. */
const WINDOW_MS = 1500;
const WINDOW_FRAMES = Math.round(WINDOW_MS / FRAME_MS);
/** Least displacement a driven creature must cover over one window. */
const MIN_TRAVEL = 0.05;
/** How long each heading is held, ms. */
const RUN_MS = 10_000;

/**
 * The island, the scatter and the katamari prop table — the actual map the
 * report came off.
 *
 * The island ships OFF (src/world/game.ts), so this switches it on and puts
 * it back like every other file that measures the authored world. The
 * PLACEMENT source is the katamari catalog with no geometry behind it: the
 * junk tiers then place exactly as they do on the deployment, and the props
 * that carry colliders are the authored ones, which is every hard thing on
 * the map bar the library's own models.
 */
let scatter: Scatter;
let authored: readonly Collider[];

beforeAll(() => {
  setLandscapeMode('landscape');
  setIslandMode(true);
  setActivePropSource(katamariPendingSource());
  scatter = createScatter({ surface: ROLLING_SURFACE });
  authored = scatter.colliders().map((c) => ({ ...c }));
});

afterAll(() => {
  scatter.dispose();
  setActivePropSource(null);
  setIslandMode(false);
  setLandscapeMode('plain');
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
  /** The live collider set — a taken prop leaves it, as it does in the world. */
  colliders: Collider[];
  /** Say the set changed, like `Scatter.bump`: the manager's spatial index
   * is cached on the version and will not see an edit without it. */
  bump(): void;
  root(): Group;
}

/**
 * A simulating page on the island: the real collider set, a stub
 * `PropBodies` (so `simulating()` is true and the priority rules are live),
 * and a loose layer for anything the ball wears.
 */
function island(): Harness {
  const colliders: Collider[] = authored.map((c) => ({ ...c }));
  let version = 1;
  const scene = new Scene();
  const drop = (key: string): boolean => {
    const i = colliders.findIndex((c) => c.key === key);
    if (i < 0) return false;
    colliders.splice(i, 1);
    version++;
    return true;
  };
  const bodies = {
    items: () => [],
    onSettle: () => {},
    onImpact: () => {},
    onTake: () => {},
    registerForeign: () => {},
    unregisterForeign: () => {},
    adopt: () => {},
    release: () => false,
    // Faithful: a prop on a pile is out of the kinematic set, exactly as it
    // is once rapier owns it.
    take: (key: string) => drop(key),
    restore: () => null,
    bump: () => {},
    loosen: (key: string) => {
      const c = colliders.find((col) => col.key === key);
      if (!c) return null;
      drop(key);
      return { key, kind: c.kind, variant: 0, scale: 1, x: c.x, z: c.z, r: c.r };
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
  });
  return {
    manager,
    colliders,
    bump(): void {
      version++;
    },
    root(): Group {
      for (const child of scene.children) {
        if (child instanceof Group && child.name.startsWith('creature ')) return child;
      }
      throw new Error('no creature root');
    },
  };
}

/**
 * Six places on the island, found rather than guessed: a golden-angle walk
 * outward, keeping anything on land with real ground around it and spaced so
 * the six are six different neighbourhoods. Deterministic, so a failure is
 * the same failure on every box.
 */
function spawnPoints(): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 4000 && out.length < 6; i++) {
    const r = 6 + Math.sqrt(i / 4000) * 46;
    const a = i * golden;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // On land, with a couple of body widths of it under the creature, and
    // far enough inside the coast that the first second is not a shoreline.
    if (isWater(x, z, 2.5)) continue;
    if (coastInland(x, z) < 8) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 18)) continue;
    out.push({ x, z });
  }
  return out;
}

/**
 * Something rooted and too big to carry, close enough to be leaning on.
 *
 * The keyless circles the landscape publishes — the sea wall and the pond
 * tiling — count: water is as rooted as anything gets, and it is never
 * carried whatever the ball has eaten (`skipIf` refuses a collider with no
 * placement key, which is what keeps a grown creature out of the sea).
 */
function blocker(x: number, z: number, bodyR: number): Collider | null {
  const limit = carryLimit(bodyR);
  let best: Collider | null = null;
  let bestPen = -Infinity;
  for (const c of authored) {
    if (!c.hard) continue;
    if (c.key !== undefined && c.r <= limit) continue;
    const reach = bodyR + c.r * HARD_PAD + CONTACT_PAD * 4;
    const pen = reach - Math.hypot(x - c.x, z - c.z);
    if (pen > 0 && pen > bestPen) {
      bestPen = pen;
      best = c;
    }
  }
  return best;
}

describe('the stuck report — a carried creature is not a parked one', () => {
  /**
   * Two hatchlings of the same size, one driven into the other.
   *
   * This is the report, reproduced: before `CREATURE_CARRY_RATIO` the
   * contact made one of them a passenger and the passenger's stick went
   * nowhere. Both halves of the fix are asserted — nobody is carried, and
   * both creatures still answer their own phones.
   */
  function two(): { manager: CreatureManager; scene: Scene; roots(): Map<string, Group> } {
    const scene = new Scene();
    const world = {
      scene,
      cameraRig: { frameAt: () => {} },
      shadows: {
        addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
        removeShadow: () => {},
      },
      bodies: () => ({
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
        loosen: () => null,
        bump: () => {},
        itemByCollider: () => undefined,
        sideByCollider: () => null,
        sync: () => {},
        update: () => {},
        dispose: () => {},
      }),
      physics: () => null,
      enablePhysics: async () => {},
      scatter: {
        colliders: () => [],
        collidersVersion: () => 1,
        positions: () => [],
        nudge: () => {},
        setTaken: () => {},
        instanceRefs: () => [],
      },
    } as unknown as WorldHandles;
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: ROLLING_SURFACE,
      game: 'katamari',
    });
    // The SAME drawing twice: identical measured radii, which is the case
    // the old ratio could not represent without making one of them luggage.
    manager.spawn('mine', snowman, { hatchMs: 60_000, grown: true });
    manager.spawn('theirs', snowman, { hatchMs: 60_000, grown: true });
    return {
      manager,
      scene,
      roots(): Map<string, Group> {
        const out = new Map<string, Group>();
        for (const id of ['mine', 'theirs']) {
          const at = manager.positionOf(id);
          if (!at) continue;
          for (const child of scene.children) {
            if (!(child instanceof Group)) continue;
            if (Math.hypot(child.position.x - at.x, child.position.z - at.z) < 1e-6) {
              out.set(id, child);
              break;
            }
          }
        }
        return out;
      },
    };
  }

  it('two equal creatures separate instead of one wearing the other', () => {
    const { manager, scene, roots } = two();
    const r = roots();
    const mine = r.get('mine')!;
    const theirs = r.get('theirs')!;
    // Nose to nose, overlapping — the contact the report came out of.
    theirs.position.set(mine.position.x + 0.2, theirs.position.y, mine.position.z);

    const start = manager.positionOf('mine')!.clone();
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    let now = 1000;
    for (let f = 0; f < 90; f++) {
      now += FRAME_MS;
      manager.update(FRAME_MS, now);
    }

    // Nobody is on a pile: the two are the same size and the gap is 1.35.
    expect(mine.parent).toBe(scene);
    expect(theirs.parent).toBe(scene);
    // And the stick still moved the creature it belongs to — three seconds
    // of pushing past a neighbour is not a parked creature.
    const end = manager.positionOf('mine')!;
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(1);
    manager.clearAll();
  });

  it('keeps both sticks live where the old ratio silenced one', () => {
    const { manager, roots } = two();
    const r = roots();
    r.get('theirs')!.position.set(r.get('mine')!.position.x + 0.2, 0, r.get('mine')!.position.z);
    manager.update(FRAME_MS, 1000);
    expect(manager.drive('mine', { x: 1, z: 0, mag: 1 })).toBe(true);
    expect(manager.drive('theirs', { x: -1, z: 0, mag: 1 })).toBe(true);
    expect(manager.driven().sort()).toEqual(['mine', 'theirs']);
    manager.clearAll();
  });

  it('is a size GAP and not a tie — the ratio makes mutual carrying unreachable', () => {
    // The arithmetic, stated once: there is no pair of radii where each is
    // inside the other's creature limit, so no id tiebreak can exist.
    for (const a of [0.4, 0.9, 1.4, 2.7, 6]) {
      for (const b of [0.4, 0.9, 1.4, 2.7, 6]) {
        const aTakesB = b <= creatureCarryLimit(a);
        const bTakesA = a <= creatureCarryLimit(b);
        expect(aTakesB && bTakesA).toBe(false);
      }
    }
  });

  it('a passenger still steers: its push moves the carrier', () => {
    // The other half of the ruling — the player's character always answers
    // its own phone. It cannot walk while it is on a pile, so what it does
    // instead is drive the pile.
    const { manager, roots } = two();
    const r = roots();
    const rider = r.get('theirs')!;
    // Seated by the EVENT path, so this is the same state the host's own
    // decision produces (and the only way to get a same-size passenger now).
    manager.applyStick({
      id: 'mine',
      item: 'creature:theirs',
      ox: 0,
      oy: 1,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    expect(rider.parent?.name).toBe('clump');

    const from = manager.positionOf('mine')!.clone();
    // Only the PASSENGER's stick is down. Nobody is touching the carrier.
    expect(manager.drive('theirs', { x: 1, z: 0, mag: 1 })).toBe(true);
    let now = 2000;
    for (let f = 0; f < 60; f++) {
      now += FRAME_MS;
      manager.update(FRAME_MS, now);
    }
    const to = manager.positionOf('mine')!;
    expect(to.x - from.x).toBeGreaterThan(0.5);
    expect(Math.abs(to.z - from.z)).toBeLessThan(Math.abs(to.x - from.x));
    manager.clearAll();
  });

  it('adds the pile up and clamps it to one stick, so agreement is not speed', () => {
    const { manager, roots } = two();
    roots();
    manager.applyStick({
      id: 'mine',
      item: 'creature:theirs',
      ox: 0,
      oy: 1,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    const ceiling = MAX_SPEED * KATAMARI_SPEED_MUL;

    // Both pushing the same way: a full push, not a double one.
    manager.drive('mine', { x: 1, z: 0, mag: 1 });
    manager.drive('theirs', { x: 1, z: 0, mag: 1 });
    let now = 3000;
    now += FRAME_MS;
    manager.update(FRAME_MS, now);
    const from = manager.positionOf('mine')!.clone();
    for (let f = 0; f < 30; f++) {
      now += FRAME_MS;
      manager.update(FRAME_MS, now);
    }
    const to = manager.positionOf('mine')!;
    const speed = (Math.hypot(to.x - from.x, to.z - from.z) / (30 * FRAME_MS)) * 1000;
    expect(speed).toBeLessThanOrEqual(ceiling * 1.02);

    // And pushing against each other cancels. Not into a STOP — a net zero
    // hands the ball back to the drift-stop the motion law requires (no
    // abrupt stops, confidence 1.00), so what it does is coast down.
    manager.drive('theirs', { x: -1, z: 0, mag: 1 });
    const held = manager.positionOf('mine')!.clone();
    let last = held.clone();
    let tail = 0;
    for (let f = 0; f < 60; f++) {
      now += FRAME_MS;
      manager.update(FRAME_MS, now);
      const at = manager.positionOf('mine')!;
      if (f >= 45) tail += Math.hypot(at.x - last.x, at.z - last.z);
      last = at.clone();
    }
    const after = manager.positionOf('mine')!;
    // Two seconds of a full push would be 7.2u; cancelling costs it most of
    // that, and by the last half second it is barely moving.
    expect(Math.hypot(after.x - held.x, after.z - held.z)).toBeLessThan(ceiling * 2 * 0.45);
    expect((tail / (15 * FRAME_MS)) * 1000).toBeLessThan(ceiling * 0.35);
    manager.clearAll();
  });
});

describe('the stuck detector — the island, eight ways, from six places', () => {
  it('never holds a driven creature still, except against something too big', () => {
    const points = spawnPoints();
    expect(points).toHaveLength(6);

    /** Everything the sweep noticed, so a failure reads as a report. */
    const held: string[] = [];
    const leaned: string[] = [];
    /** Frames the creature spent inside something too big to carry — the
     * proof that the sweep actually ran the creature into the world. */
    let pressed = 0;
    let travelled = 0;

    for (let p = 0; p < points.length; p++) {
      const spot = points[p]!;
      const harness = island();
      const { manager } = harness;
      manager.spawn(`walker${p}`, snowman, { hatchMs: 60_000, grown: true });
      const root = harness.root();
      let now = 1000;

      for (let h = 0; h < 8; h++) {
        const heading = (h * Math.PI) / 4;
        const dir = { x: Math.sin(heading), z: Math.cos(heading) };
        // Back to the spot for every heading, so eight runs are eight runs.
        root.position.set(spot.x, root.position.y, spot.z);
        manager.drive(`walker${p}`, { x: dir.x, z: dir.z, mag: 1 });

        const xs: number[] = [];
        const zs: number[] = [];
        const frames = Math.round(RUN_MS / FRAME_MS);
        for (let f = 0; f < frames; f++) {
          now += FRAME_MS;
          manager.update(FRAME_MS, now);
          const at = manager.positionOf(`walker${p}`)!;
          xs.push(at.x);
          zs.push(at.z);
          if (f > 0) travelled += Math.hypot(at.x - xs[f - 1]!, at.z - zs[f - 1]!);
          // Sampled rather than per frame: this walks the whole collider set
          // and the answer does not change inside a tenth of a second.
          if (f % 5 === 0) {
            const bodyR = manager.positions().find((q) => q.kind === 'character')!.r;
            if (blocker(at.x, at.z, bodyR)) pressed++;
          }
          if (f < WINDOW_FRAMES) continue;
          const i0 = f - WINDOW_FRAMES;
          const moved = Math.hypot(xs[f]! - xs[i0]!, zs[f]! - zs[i0]!);
          if (moved >= MIN_TRAVEL) continue;

          // Held still. Is there anything here entitled to hold it?
          const bodyR = manager.positions().find((q) => q.kind === 'character')!.r;
          const against = blocker(xs[f]!, zs[f]!, bodyR);
          const where = `spot ${p} heading ${h} at ${xs[f]!.toFixed(1)},${zs[f]!.toFixed(1)}`;
          if (!against) {
            held.push(`${where}: nothing near it, moved ${moved.toFixed(3)}u`);
            break;
          }
          leaned.push(`${where}: on ${against.kind ?? 'water'} r ${against.r.toFixed(2)}`);

          // THE ESCAPE. Ninety degrees off, and it has to be free inside a
          // window — a wall may stop you, it may not hold you.
          const turn = heading + Math.PI / 2;
          manager.drive(`walker${p}`, { x: Math.sin(turn), z: Math.cos(turn), mag: 1 });
          const fromX = xs[f]!;
          const fromZ = zs[f]!;
          let freed = 0;
          for (let e = 0; e < WINDOW_FRAMES; e++) {
            now += FRAME_MS;
            manager.update(FRAME_MS, now);
            const at = manager.positionOf(`walker${p}`)!;
            freed = Math.hypot(at.x - fromX, at.z - fromZ);
            if (freed >= MIN_TRAVEL * 4) break;
          }
          if (freed < MIN_TRAVEL * 4) {
            held.push(
              `${where}: a 90° turn off ${against.kind ?? 'water'} freed only ` +
                `${freed.toFixed(3)}u in ${WINDOW_MS}ms`,
            );
          }
          break;
        }
        manager.drive(`walker${p}`, null);
      }
      manager.clearAll();
    }

    /*
     * NOT VACUOUS. The sweep has to have driven the creature into the map:
     * forty-eight ten-second runs, real travel, and real time spent inside
     * the reach of things it cannot carry (the sea wall, the range, the
     * ponds, the buildings). Without these three a world that failed to
     * drive at all would pass the invariant by never moving anything.
     */
    expect(travelled).toBeGreaterThan(6 * 8 * 5);
    expect(pressed).toBeGreaterThan(20);
    expect(held).toEqual([]);
    // Recorded for the log rather than asserted: a lean is allowed, and
    // whether one happened at all depends on where the coast wobbles.
    if (leaned.length > 0) console.log(`leaned on something ${leaned.length}×`);
  }, 120_000);

  /**
   * THE CORNER — the case the invariant's escape clause exists for.
   *
   * Two walls of big rooted props meeting at a right angle, and a creature
   * driven straight into the inside of the corner. There is no tangent left
   * to slide along: the tangent of each wall is into the other. It is
   * allowed to STOP there — that is a wall doing its job, and the ruling only
   * promises priority over what the creature could carry. What it is not
   * allowed to do is HOLD, so the second half of the test is the 90° turn,
   * asserted rather than hoped for.
   */
  it('a corner stops a creature and a turn frees it', () => {
    const harness = island();
    const { manager, colliders } = harness;
    // Off the map's own props: the geometry under test is this corner, not
    // the island's. (The landscape's own circles are all far from here.)
    colliders.length = 0;
    harness.bump();
    manager.spawn('wedged', snowman, { hatchMs: 60_000, grown: true });
    const root = harness.root();
    root.position.set(0, root.position.y, 0);
    // Two overlapping runs of mountain-sized circles: x = 6 and z = 6.
    for (let i = -6; i <= 6; i++) {
      colliders.push({
        x: 6,
        z: i * 2,
        r: 2.4,
        hard: true,
        kind: 'mountain',
        key: `mountain:0:x${i}`,
      });
      colliders.push({
        x: i * 2,
        z: 6,
        r: 2.4,
        hard: true,
        kind: 'mountain',
        key: `mountain:0:z${i}`,
      });
    }
    harness.bump();

    let now = 1000;
    const into = { x: Math.SQRT1_2, z: Math.SQRT1_2, mag: 1 };
    manager.drive('wedged', into);
    for (let f = 0; f < 150; f++) {
      now += FRAME_MS;
      manager.update(FRAME_MS, now);
    }
    const pinned = manager.positionOf('wedged')!.clone();
    for (let f = 0; f < WINDOW_FRAMES; f++) {
      now += FRAME_MS;
      manager.update(FRAME_MS, now);
    }
    const still = manager.positionOf('wedged')!;
    // Pinned: a whole window of pushing into the corner buys nothing much.
    expect(Math.hypot(still.x - pinned.x, still.z - pinned.z)).toBeLessThan(0.5);
    // And it is OUTSIDE both walls, not wedged inside one of them.
    const bodyR = manager.positions().find((q) => q.kind === 'character')!.r;
    for (const c of colliders) {
      expect(Math.hypot(still.x - c.x, still.z - c.z)).toBeGreaterThan(bodyR + c.r - 0.2);
    }

    // And free, 90° off, inside one window.
    manager.drive('wedged', { x: Math.SQRT1_2, z: -Math.SQRT1_2, mag: 1 });
    const from = manager.positionOf('wedged')!.clone();
    for (let f = 0; f < WINDOW_FRAMES; f++) {
      now += FRAME_MS;
      manager.update(FRAME_MS, now);
    }
    const freed = manager.positionOf('wedged')!;
    expect(Math.hypot(freed.x - from.x, freed.z - from.z)).toBeGreaterThan(MIN_TRAVEL * 4);
    manager.clearAll();
  });
});

/**
 * THE SAME INVARIANT, WITH THE REAL SOLVER UNDER IT.
 *
 * > Second report, 2026-09-16, off the deployed build: *"my character got
 * > stuck again."*
 *
 * The block above runs the pure resolve, which is what decides where a
 * creature ends up. This one adds the half only a host has: a real rapier
 * world, a real heightfield off the Surface seam, the fixed cylinders under
 * every rooted prop, the hulls under the stones, the contact-pair filter and
 * the kinematic ball that grows with the pile (docs/PLAN.md §7.6). The compat
 * build inlines its wasm, so the solver really runs here.
 *
 * WHAT THE SOLVER CAN AND CANNOT DO — the answer to *"can rapier's own
 * contact keep it pinned?"*: a creature stands in that world as a KINEMATIC
 * POSITION-BASED body, written from the resolved position every frame. A
 * kinematic body is not moved by contacts; it moves what it touches. So
 * rapier can shove a stone out of the way and it cannot hold a creature
 * anywhere — and the first test below is that stated as an assertion rather
 * than as a claim about rapier's manual.
 */
describe('the stuck detector — with rapier under it', () => {
  let physicsScatter: Scatter;
  let physics: PhysicsWorld | null = null;
  let bodies: PropBodies | null = null;

  beforeAll(async () => {
    physicsScatter = createScatter({ surface: ROLLING_SURFACE });
    physics = await createPhysicsWorld(ROLLING_SURFACE, FIELD_SIZE);
    bodies = createPropBodies({
      physics,
      scatter: physicsScatter,
      surface: ROLLING_SURFACE,
      wind: physicsScatter.windField(),
    });
    bodies.sync();
  }, 120_000);

  afterAll(() => {
    bodies?.dispose();
    physics?.dispose();
    physicsScatter?.dispose();
  });

  interface Hosted {
    manager: CreatureManager;
    /** One frame, the way the page runs one: the manager, then the solver.
     * `bodies.update` is what applies a kinematic body's next translation
     * and steps every stone — src/world/scene.ts does exactly this. */
    frame(now: number): void;
    root(): Group;
    /** Where the creature's own kinematic body is, in rapier's world. */
    ball(): { x: number; y: number; z: number };
    ballRadius(): number;
  }

  function hosted(id: string, onStick?: (item: string) => void): Hosted {
    const scene = new Scene();
    const world = {
      scene,
      cameraRig: { frameAt: () => {} },
      shadows: {
        addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
        removeShadow: () => {},
      },
      physics: () => physics,
      bodies: () => bodies,
      enablePhysics: async () => {},
      scatter: physicsScatter,
    } as unknown as WorldHandles;
    const manager = createCreatureManager(world, {
      autoHatch: false,
      surface: ROLLING_SURFACE,
      game: 'katamari',
      loose: stubLoose(scene),
      ...(onStick
        ? {
            observer: {
              egg: () => {},
              hatch: () => {},
              retire: () => {},
              emote: () => {},
              stick: (r) => onStick(r.item),
              drop: () => {},
              loose: () => {},
              settle: () => {},
              crack: () => {},
              shatter: () => {},
            },
          }
        : {}),
    });
    manager.spawn(id, snowman, { hatchMs: 60_000, grown: true });
    const root = (): Group => {
      for (const child of scene.children) {
        if (child instanceof Group && child.name.startsWith('creature ')) return child;
      }
      throw new Error('no creature root');
    };
    /**
     * The creature's OWN ball in the solver.
     *
     * Found by the body rather than by scanning colliders: every prop is
     * fixed or dynamic, so the kinematic body standing where this creature
     * stands is its stand-in — and its `collider(0)` is the ball, since the
     * balls standing in for what it CARRIES are created after it and hang off
     * the same body.
     */
    const own = (): RapierCollider => {
      const at = root().position;
      let found: RapierCollider | null = null;
      physics!.world.forEachRigidBody((body) => {
        if (found || !body.isKinematic()) return;
        const t = body.translation();
        if (Math.hypot(t.x - at.x, t.z - at.z) > 1e-3) return;
        found = body.collider(0);
      });
      if (!found) throw new Error('no kinematic collider');
      return found;
    };
    return {
      manager,
      frame(now: number): void {
        manager.update(FRAME_MS, now);
        bodies!.update(FRAME_MS, now);
      },
      root,
      ball(): { x: number; y: number; z: number } {
        return own().parent()!.translation();
      },
      ballRadius(): number {
        return own().radius();
      },
    };
  }

  it('re-syncs the kinematic body from the resolved position, so nothing pins it', () => {
    const { manager, root, ball, frame } = hosted('hostwalker');
    const start = root().position.clone();
    manager.drive('hostwalker', { x: 1, z: 0, mag: 1 });
    let now = 1000;
    for (let f = 0; f < 90; f++) {
      now += FRAME_MS;
      frame(now);
      const at = manager.positionOf('hostwalker')!;
      const body = ball();
      // Every frame: rapier's copy IS the resolved position, never a
      // position the solver decided for it.
      // float32 in the solver, so this is "the same place", not "the same
      // bits": a millimetre at world scale is four orders under a body.
      expect(Math.hypot(body.x - at.x, body.z - at.z)).toBeLessThan(1e-4);
    }
    const end = manager.positionOf('hostwalker')!;
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(1);
    manager.clearAll();
  });

  it('grows every radius together — the ball, the resolve circle and the reach', () => {
    const { manager, root, ballRadius, frame } = hosted('grower');
    const baseR = manager.positions().find((q) => q.kind === 'character')!.r;
    frame(1000);
    expect(ballRadius()).toBeCloseTo(baseR, 4);

    // Eat something its own size, through the event path — so this is the
    // state a viewer and the host both reach.
    manager.spawn('snack', snowman, { hatchMs: 60_000, grown: true });
    manager.applyStick({
      id: 'grower',
      item: 'creature:snack',
      ox: 0,
      oy: 1,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    frame(1033);
    const grown = manager.positions().find((q) => q.kind === 'character')!.r;
    expect(grown).toBeGreaterThan(baseR);
    // ONE number everywhere: the scatter's exclusion radius, the root's
    // scale, the rapier ball and the pickup reach are all this `bodyR`, so
    // there is no radius a creature can wedge in the gap between.
    expect(ballRadius()).toBeCloseTo(grown, 4);
    expect(root().scale.x).toBeCloseTo(grown / baseR, 6);
    manager.clearAll();
  });

  it('rolls a loose stone onto the pile without killing the frame', () => {
    /*
     * THE SECOND ROOT CAUSE, pinned (2026-09-16).
     *
     * `take` removes the stone's rigid body from the solver, and the pickup
     * then read that body's translation to work out where the thing was. A
     * removed rapier body is a dead handle: the read traps the wasm
     * (`RuntimeError: unreachable`), the throw came out of `update()`, and
     * the host's frame loop died with it — no more poses, so every phone in
     * the room watched its creature stop where it stood. This test picks a
     * real stone off the real map and rolls a real ball over it.
     */
    const stuck: string[] = [];
    const { manager, root, frame } = hosted('scooper', (item) => stuck.push(item));
    const bodyR = manager.positions().find((q) => q.kind === 'character')!.r;
    // A stone inside the hatchling's own carry limit, with a live body.
    const stone = bodies!
      .items()
      .map((item) => ({ item, t: item.body.translation() }))
      .find(({ item }) => item.kind === 'rock' && item.r <= carryLimit(bodyR) * 0.9);
    expect(stone).toBeDefined();

    // Stood just short of it, pushing straight at it.
    const to = { x: stone!.t.x, z: stone!.t.z };
    root().position.set(to.x - (bodyR + stone!.item.r) * 0.9, root().position.y, to.z);
    manager.drive('scooper', { x: 1, z: 0, mag: 1 });
    let now = 1000;
    // The whole point: this loop used to throw on the pickup frame.
    for (let f = 0; f < 30; f++) {
      now += FRAME_MS;
      frame(now);
    }
    expect(stuck).toContain(stone!.item.key);
    // And the ball kept rolling — a creature that ate a stone is not parked.
    manager.clearAll();
  });

  it('is never held while driven — the coast, the ponds and the forest', () => {
    /*
     * Fewer runs than the resolve sweep, same rule: four headings from three
     * places, six seconds each, with the whole rigid-body world stepping
     * underneath. Held is a failure unless something too big to carry is
     * doing the holding, and then a 90° turn has to free it.
     */
    const points = spawnPoints().slice(0, 3);
    const held: string[] = [];
    for (let p = 0; p < points.length; p++) {
      const spot = points[p]!;
      const { manager, root, frame } = hosted(`host${p}`);
      let now = 1000;
      for (let h = 0; h < 4; h++) {
        const heading = (h * Math.PI) / 2;
        root().position.set(spot.x, root().position.y, spot.z);
        manager.drive(`host${p}`, { x: Math.sin(heading), z: Math.cos(heading), mag: 1 });
        const xs: number[] = [];
        const zs: number[] = [];
        const frames = Math.round(6000 / FRAME_MS);
        for (let f = 0; f < frames; f++) {
          now += FRAME_MS;
          frame(now);
          const at = manager.positionOf(`host${p}`)!;
          xs.push(at.x);
          zs.push(at.z);
          if (f < WINDOW_FRAMES) continue;
          const i0 = f - WINDOW_FRAMES;
          if (Math.hypot(xs[f]! - xs[i0]!, zs[f]! - zs[i0]!) >= MIN_TRAVEL) continue;
          const bodyR = manager.positions().find((q) => q.kind === 'character')!.r;
          const against = blocker(xs[f]!, zs[f]!, bodyR);
          const where = `spot ${p} heading ${h} at ${xs[f]!.toFixed(1)},${zs[f]!.toFixed(1)}`;
          if (!against) {
            held.push(`${where}: nothing near it`);
            break;
          }
          const turn = heading + Math.PI / 2;
          manager.drive(`host${p}`, { x: Math.sin(turn), z: Math.cos(turn), mag: 1 });
          const fromX = xs[f]!;
          const fromZ = zs[f]!;
          let freed = 0;
          for (let e = 0; e < WINDOW_FRAMES; e++) {
            now += FRAME_MS;
            frame(now);
            const at2 = manager.positionOf(`host${p}`)!;
            freed = Math.hypot(at2.x - fromX, at2.z - fromZ);
            if (freed >= MIN_TRAVEL * 4) break;
          }
          if (freed < MIN_TRAVEL * 4) {
            held.push(
              `${where}: a 90° turn off ${against.kind ?? 'water'} freed ${freed.toFixed(3)}u`,
            );
          }
          break;
        }
        manager.drive(`host${p}`, null);
      }
      manager.clearAll();
    }
    expect(held).toEqual([]);
  }, 120_000);
});
