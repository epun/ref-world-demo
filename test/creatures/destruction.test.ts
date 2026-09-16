/**
 * The destruction runtime — the rules, the routing and the chain reactions
 * (src/creatures/sticky.ts, src/world/wreck.ts, src/creatures/manager.ts).
 *
 * WHAT IS PINNED HERE, and why it is pinned at this level.
 *
 * The rules themselves (`stageFor`, the `break` outcome, the lifetimes) are
 * pure arithmetic and are asserted directly.
 *
 * The ROUTING is the interesting part, and it is asserted through the impact
 * seam rather than through a rapier simulation. `PropBodies.onImpact` hands
 * the manager two named sides and a relative speed (src/world/rocks.ts); the
 * stub here captures the callback and then calls it with the exact pair a
 * chain reaction produces — a carrier's stuck-item collider meeting a tree, a
 * falling chunk meeting a bush. That is the decision under test, and it is
 * deterministic. Whether rapier reports those contacts at all is pinned
 * separately, against a real physics world, in test/world/rocks.test.ts.
 *
 * The brief the whole file exists for (2026-09-15): *"objects can knock
 * loose, drag, stick, BREAK… attached objects stay dangerous (a stuck bench
 * swinging into a sign knocks it loose)… big readable reactions, chain
 * reactions."*
 */

import { Scene } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCreatureManager } from '../../src/creatures/manager';
import {
  debrisLifetimeMs,
  decideContact,
  impactOf,
  stageFor,
  STICKY,
} from '../../src/creatures/sticky';
import { MOTION } from '../../src/taste/tokens';
import type { ImpactSide, LooseItem } from '../../src/world/rocks';
import type { WorldHandles } from '../../src/world/scene';
import { FLAT_SURFACE } from '../../src/world/surface';
import { snowman } from '../fixtures/strokes';

beforeAll(() => {
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    };
  }
});

// ── the rules ───────────────────────────────────────────────────────────────

describe('the two new thresholds', () => {
  it('shatters a large prop instead of lifting it whole, and only above breakStrength', () => {
    const props = STICKY.monolith;
    expect(props.shatterStrength).toBeGreaterThan(props.breakStrength);
    // A monolith far bigger than the carrier: `decideContact` asks about
    // size first (2026-09-16 ruling) — a prop inside the carry limit is
    // simply stuck, and one inside `passLimit` is pushed past — so the
    // radius here is over BOTH lines. This is the ladder above them.
    const ask = (impact: number): string =>
      decideContact({ itemR: 4, rooted: true, props, impact, carrierR: 1.5 });
    expect(ask(props.breakStrength - 0.01)).toBe('block');
    expect(ask(props.breakStrength)).toBe('loose');
    expect(ask(props.shatterStrength! - 0.01)).toBe('loose');
    // Break takes precedence over coming out of the ground, which is the
    // whole reason it is asked first.
    expect(ask(props.shatterStrength!)).toBe('break');
    expect(ask(props.shatterStrength! * 4)).toBe('break');
  });

  it('never breaks a kind with no shatterStrength, however hard it is hit', () => {
    for (const kind of ['bush', 'tree', 'building', 'mountain'] as const) {
      expect(STICKY[kind].shatterStrength).toBeUndefined();
      expect(
        decideContact({
          itemR: 1,
          rooted: true,
          props: STICKY[kind],
          impact: 1e6,
          // Too big to carry, so the question reaches the break ladder at all.
          carrierR: 0.5,
        }),
      ).not.toBe('break');
    }
  });

  it('stages a building through three cumulative thresholds and never past them', () => {
    const props = STICKY.building;
    const stages = props.stages!;
    expect(stages[0]).toBeLessThan(stages[1]);
    expect(stages[1]).toBeLessThan(stages[2]);
    expect(stageFor(props, 0)).toBe(0);
    expect(stageFor(props, stages[0] - 0.01)).toBe(0);
    expect(stageFor(props, stages[0])).toBe(1);
    expect(stageFor(props, stages[1])).toBe(2);
    expect(stageFor(props, stages[2])).toBe(3);
    expect(stageFor(props, stages[2] * 10)).toBe(3);
  });

  it('gives a mountain higher stages than a building — it is the level', () => {
    for (let i = 0; i < 3; i++) {
      expect(STICKY.mountain.stages![i]!).toBeGreaterThan(STICKY.building.stages![i]!);
    }
  });

  it('never stages a kind that has no stages — a tree comes down, it does not crack', () => {
    expect(stageFor(STICKY.tree, 1e6)).toBe(0);
    expect(stageFor(STICKY.monolith, 1e6)).toBe(0);
  });

  it('takes its debris lifetimes from the motion tokens, and persists the big ones', () => {
    expect(debrisLifetimeMs(STICKY.rock)).toBe(MOTION.ambientMs * 2);
    expect(debrisLifetimeMs(STICKY.tree)).toBe(MOTION.ambientMs * 4);
    // The brief's bands: small 5-10s, medium 10-20s.
    expect(debrisLifetimeMs(STICKY.rock) / 1000).toBeGreaterThan(5);
    expect(debrisLifetimeMs(STICKY.rock) / 1000).toBeLessThan(10);
    expect(debrisLifetimeMs(STICKY.tree) / 1000).toBeGreaterThan(10);
    expect(debrisLifetimeMs(STICKY.tree) / 1000).toBeLessThan(20);
    // "Important debris is persistent": a fallen section of a building is a
    // record of what happened in the room.
    expect(debrisLifetimeMs(STICKY.monolith)).toBe(Infinity);
    expect(debrisLifetimeMs(STICKY.building)).toBe(Infinity);
  });
});

// ── the routing ─────────────────────────────────────────────────────────────

const TREE = 'tree:0:20.00:0.00';
const BUSH = 'bush:0:-20.00:0.00';
const BUILDING = 'building:0:40.00:0.00';
const MONOLITH = 'monolith:0:-40.00:0.00';

/** A `PropBodies` that records what was decided and hands back its own
 * impact callback, so a test can post the exact contact it wants. */
function recordingBodies(): {
  api: unknown;
  loosened: string[];
  taken: string[];
  bumped: { key: string; strength: number }[];
  fire: (a: ImpactSide, b: ImpactSide, speed: number) => void;
} {
  const loosened: string[] = [];
  const taken: string[] = [];
  const bumped: { key: string; strength: number }[] = [];
  let impact: ((a: ImpactSide, b: ImpactSide, speed: number) => void) | null = null;
  return {
    loosened,
    taken,
    bumped,
    fire: (a, b, speed) => impact?.(a, b, speed),
    api: {
      items: (): readonly LooseItem[] => [],
      onSettle: () => {},
      onImpact: (cb: (a: ImpactSide, b: ImpactSide, speed: number) => void) => {
        impact = cb;
      },
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
      loosen: (key: string) => {
        loosened.push(key);
        const parsed = key.split(':');
        return {
          key,
          kind: parsed[0],
          variant: 0,
          scale: 1,
          x: Number(parsed[2]),
          z: Number(parsed[3]),
          r: 1,
        };
      },
      bump: (key: string, _dx: number, _dz: number, strength: number) => {
        bumped.push({ key, strength });
      },
      itemByCollider: () => undefined,
      sideByCollider: () => null,
      sync: () => {},
      update: () => {},
      dispose: () => {},
    },
  };
}

/** One live creature on a stub world that is SIMULATING, plus the events it
 * decided and the seam to post contacts on. */
function simulatingWorld(): {
  bodies: ReturnType<typeof recordingBodies>;
  events: { kind: string; item: string; stage?: number }[];
  carrier: string;
  bodyR: number;
} {
  const bodies = recordingBodies();
  const events: { kind: string; item: string; stage?: number }[] = [];
  const world = {
    scene: new Scene(),
    cameraRig: { frameAt: () => {} },
    shadows: {
      addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
      removeShadow: () => {},
    },
    bodies: () => bodies.api,
    physics: () => null,
    enablePhysics: async () => {},
    scatter: {
      colliders: () => [],
      collidersVersion: () => 1,
      positions: () => [],
      nudge: () => {},
    },
  } as unknown as WorldHandles;

  const manager = createCreatureManager(world, {
    autoHatch: false,
    surface: FLAT_SURFACE,
    // Destruction is the katamari world's (src/world/game.ts): a manager that
    // says nothing plays no game and decides nothing about a prop.
    game: 'katamari',
    observer: {
      egg: () => {},
      hatch: () => {},
      retire: () => {},
      emote: () => {},
      stick: () => {},
      drop: () => {},
      loose: (item) => events.push({ kind: 'loose', item }),
      settle: () => {},
      crack: (record) => events.push({ kind: 'crack', item: record.item, stage: record.stage }),
      shatter: (record) => events.push({ kind: 'shatter', item: record.item }),
    },
  });
  manager.spawn('carrier', snowman, { hatchMs: 60_000, grown: true });
  // One frame, so the sticky pass runs and the impact seam is wired.
  manager.update(16, 1000);
  const bodyR = manager.positions().find((p) => p.kind === 'character')!.r;
  return { bodies, events, carrier: 'carrier', bodyR };
}

/** A creature-owned collider — its ball, or one of the balls standing in for
 * what it is carrying. Both are named as the carrier (src/world/rocks.ts). */
function creatureSide(id: string, r: number, x: number, z: number): ImpactSide {
  return { key: id, kind: 'creature', r, x, z, rooted: false };
}

function propSide(key: string, r: number): ImpactSide {
  const parts = key.split(':');
  return {
    key,
    kind: parts[0] as ImpactSide['kind'],
    r,
    x: Number(parts[2]),
    z: Number(parts[3]),
    rooted: true,
  };
}

describe('chain reactions through the impact seam', () => {
  it('a stuck rock swinging off a carrier knocks a tree loose', () => {
    // The gap the katamari work left behind: a drop or a loose fired off the
    // PURE resolve's hard contacts, which is a creature walking into a
    // trunk — and a rock hanging off a pile never produces one of those. The
    // stuck item's ball is registered as the carrier, so this contact is the
    // carrier hitting the tree and the impact is measured against the pile.
    const { bodies, events, carrier, bodyR } = simulatingWorld();
    // Fast enough that `speed x bodyR` clears a tree's 4.
    const speed = (STICKY.tree.breakStrength / bodyR) * 1.2;
    expect(impactOf(speed, bodyR)).toBeGreaterThan(STICKY.tree.breakStrength);
    bodies.fire(creatureSide(carrier, 0.4, 19, 0), propSide(TREE, 1.2), speed);
    expect(bodies.loosened).toEqual([TREE]);
    expect(events).toEqual([{ kind: 'loose', item: TREE }]);
    // And it flinched, whatever the verdict.
    expect(bodies.bumped[0]!.key).toBe(TREE);
    expect(bodies.bumped[0]!.strength).toBeGreaterThan(0);
    expect(bodies.bumped[0]!.strength).toBeLessThanOrEqual(1);
  });

  it('a falling chunk loosens the bush it lands on — nothing to do with a creature', () => {
    // Measured against the CHUNK's radius, not against anybody's pile: the
    // currency is `speed x radius` and the chunk is the thing that arrived.
    const { bodies, events } = simulatingWorld();
    const chunk: ImpactSide = {
      key: `${BUILDING}#2`,
      kind: 'chunk',
      r: 0.8,
      x: -19.5,
      z: 0,
      rooted: false,
    };
    const speed = 3;
    expect(impactOf(speed, chunk.r)).toBeGreaterThan(STICKY.bush.breakStrength);
    bodies.fire(chunk, propSide(BUSH, 0.9), speed);
    expect(bodies.loosened).toEqual([BUSH]);
    expect(events).toEqual([{ kind: 'loose', item: BUSH }]);
  });

  it('ignores two standing props and two loose things alike', () => {
    const { bodies, events } = simulatingWorld();
    bodies.fire(propSide(TREE, 1.2), propSide(BUSH, 0.9), 40);
    const stone: ImpactSide = {
      key: 'rock:0:1.00:1.00',
      kind: 'rock',
      r: 0.4,
      x: 1,
      z: 1,
      rooted: false,
    };
    bodies.fire(stone, { ...stone, key: 'rock:0:2.00:2.00' }, 40);
    expect(bodies.loosened).toEqual([]);
    expect(events).toEqual([]);
  });

  it('wears a building down over repeated impacts and never lifts it whole', () => {
    // The brief: a building "initially resists, and can become loose after
    // repeated impact". Damage ACCUMULATES on the host; the stages are what
    // travels.
    const { bodies, events, carrier, bodyR } = simulatingWorld();
    const stages = STICKY.building.stages!;
    // Each hit is a third of the first threshold, so the stages arrive one
    // at a time rather than all at once.
    const per = stages[0] / 3;
    const speed = per / bodyR;
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      bodies.fire(creatureSide(carrier, bodyR, 39, 0), propSide(BUILDING, 3), speed);
      for (const event of events.splice(0)) {
        if (event.kind === 'crack') seen.push(event.stage!);
      }
    }
    // Strictly 1, 2, 3 — in order, once each, and nothing after.
    expect(seen).toEqual([1, 2, 3]);
    // And never loose: `breakStrength` stays Infinity, which is what makes a
    // building the thing you cannot eat.
    expect(bodies.loosened).toEqual([]);
  });

  it('bursts a monolith once, and only above its shatter strength', () => {
    const { bodies, events, carrier, bodyR } = simulatingWorld();
    const props = STICKY.monolith;
    /*
     * The impact is measured against the CARRIER's own radius, which the
     * manager reads off the live slot rather than off the collider that was
     * hit — the same number the pile's growth writes. So reaching the large
     * tier is a matter of speed here, where in the world it is a matter of
     * having eaten ninety trees (src/creatures/sticky.ts).
     */
    const under = (props.breakStrength / bodyR) * 1.05;
    bodies.fire(creatureSide(carrier, bodyR, -39, 0), propSide(MONOLITH, 2.5), under);
    expect(events.map((e) => e.kind)).toEqual(['loose']);
    expect(bodies.loosened).toEqual([MONOLITH]);

    const second = simulatingWorld();
    const over = (props.shatterStrength! / second.bodyR) * 1.05;
    second.bodies.fire(
      creatureSide(second.carrier, second.bodyR, -39, 0),
      propSide(MONOLITH, 2.5),
      over,
    );
    expect(second.events).toEqual([{ kind: 'shatter', item: MONOLITH }]);
    // It stopped being scenery: the placement is hidden and its fixed
    // collider is gone, so the chunks are the only copy of the thing.
    expect(second.bodies.taken).toEqual([MONOLITH]);
    expect(second.bodies.loosened).toEqual([]);
    // Once. A second contact on a prop that is already a wreck decides
    // nothing.
    second.bodies.fire(
      creatureSide(second.carrier, second.bodyR, -39, 0),
      propSide(MONOLITH, 2.5),
      over,
    );
    expect(second.events.length).toBe(1);
  });

  it('records the wreck on the page that decided it', () => {
    const { bodies, carrier, bodyR } = simulatingWorld();
    const stages = STICKY.building.stages!;
    bodies.fire(
      creatureSide(carrier, bodyR, 39, 0),
      propSide(BUILDING, 3),
      (stages[0] * 1.05) / bodyR,
    );
    const probe = (globalThis as { __refworldCreatures?: { wrecks(): unknown } })
      .__refworldCreatures;
    expect(probe).toBeTruthy();
    expect(probe!.wrecks()).toEqual([{ item: BUILDING, stage: 1, removed: 0 }]);
  });
});
