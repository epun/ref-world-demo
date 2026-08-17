/**
 * Steering (src/behavior/steering.ts) — pure tests.
 *
 * Sit-beside stand-off (approach targets never crowd the peer), arrival
 * slowing, angle unwrap math, wander-target dispersal bias, and world
 * bounds.
 */

import { describe, expect, it } from 'vitest';
import { makeRand } from '../../src/behavior/states';
import {
  approachTarget,
  arrive,
  ARRIVE_RADIUS,
  AVOID_DISTANCE,
  avoidanceBend,
  headingTo,
  pickWanderTarget,
  projectOutOfHard,
  quadrantOf,
  shortestDelta,
  STAND_OFF,
  TARGET_CLEARANCE,
  WORLD_EXTENT,
  wrapAngle,
  type Vec2,
} from '../../src/behavior/steering';
import { buildColliderGrid, type Collider } from '../../src/physics/colliders';

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('angles', () => {
  it('wrapAngle lands in [-π, π)', () => {
    for (let a = -20; a <= 20; a += 0.37) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThan(Math.PI);
      // Same direction, mod 2π.
      expect(Math.abs(wrapAngle(w - a))).toBeLessThan(1e-9);
    }
  });

  it('shortestDelta takes the short way across the seam', () => {
    // 3.0 → -3.0 is 0.28 rad forward through π, not 6.0 back through zero.
    const d = shortestDelta(3.0, -3.0);
    expect(Math.abs(d)).toBeLessThan(0.3);
    expect(d).toBeGreaterThan(0);
    expect(Math.abs(shortestDelta(0.1, -0.1) + 0.2)).toBeLessThan(1e-9);
  });

  it('headingTo matches the rotation.y forward convention (sin h, cos h)', () => {
    expect(headingTo({ x: 0, z: 0 }, { x: 0, z: 5 })).toBeCloseTo(0);
    expect(headingTo({ x: 0, z: 0 }, { x: 5, z: 0 })).toBeCloseTo(Math.PI / 2);
  });
});

describe('approachTarget — sit beside, never overlap', () => {
  it('the target never sits inside 1.2 units of the peer', () => {
    const rand = makeRand(2024);
    for (let i = 0; i < 200; i++) {
      const peer = { x: rand() * 40 - 20, z: rand() * 40 - 20 };
      const self = {
        x: peer.x + (rand() * 2 - 1) * 12,
        z: peer.z + (rand() * 2 - 1) * 12,
      };
      const target = approachTarget(self, peer);
      expect(dist(target, peer)).toBeGreaterThanOrEqual(1.2);
      expect(dist(target, peer)).toBeCloseTo(STAND_OFF);
    }
  });

  it('handles exact overlap deterministically', () => {
    const p = { x: 3, z: -2 };
    const target = approachTarget({ ...p }, p);
    expect(dist(target, p)).toBeCloseTo(STAND_OFF);
  });

  it('keeps the target on the creature side of the peer (no orbiting through)', () => {
    const self = { x: 10, z: 0 };
    const peer = { x: 0, z: 0 };
    const target = approachTarget(self, peer);
    expect(target.x).toBeCloseTo(STAND_OFF);
    expect(target.z).toBeCloseTo(0);
  });
});

describe('arrive', () => {
  it('slows linearly inside the arrival radius, full speed outside', () => {
    const target = { x: 0, z: 0 };
    const far = arrive({ x: 10, z: 0 }, target, 1.2, 0);
    expect(far.speed).toBeCloseTo(1.2);
    const near = arrive({ x: ARRIVE_RADIUS / 2, z: 0 }, target, 1.2, 0);
    expect(near.speed).toBeCloseTo(0.6);
    const there = arrive({ x: 0, z: 0 }, target, 1.2, 0.4);
    expect(there.speed).toBe(0);
    expect(there.heading).toBe(0.4); // keeps the caller's heading when parked
  });
});

describe('pickWanderTarget — dispersal (PLAN §7.1)', () => {
  it('stays inside the world extent', () => {
    const rand = makeRand(7);
    for (let i = 0; i < 100; i++) {
      const self = { x: rand() * 70 - 35, z: rand() * 70 - 35 };
      const t = pickWanderTarget(self, [], [0, 0, 0, 0], 1, rand);
      expect(Math.hypot(t.x, t.z)).toBeLessThanOrEqual(WORLD_EXTENT);
    }
  });

  it('is deterministic given the same stream', () => {
    const a = pickWanderTarget({ x: 1, z: 2 }, [{ x: 4, z: 4 }], [1, 0, 2, 0], 0.6, makeRand(5));
    const b = pickWanderTarget({ x: 1, z: 2 }, [{ x: 4, z: 4 }], [1, 0, 2, 0], 0.6, makeRand(5));
    expect(a).toEqual(b);
  });

  it('biases away from a crowd', () => {
    // A tight knot of peers to the east; targets should mostly land west.
    const crowd: Vec2[] = [
      { x: 8, z: 0 },
      { x: 9, z: 1 },
      { x: 8, z: -1 },
      { x: 10, z: 0 },
    ];
    const rand = makeRand(99);
    let west = 0;
    const runs = 50;
    for (let i = 0; i < runs; i++) {
      const t = pickWanderTarget({ x: 0, z: 0 }, crowd, [0, 0, 0, 0], 0.5, rand);
      if (t.x < 0) west++;
    }
    expect(west).toBeGreaterThan(runs * 0.7);
  });

  it('prefers the least-visited quadrant', () => {
    // Everything visited but quadrant 2 (-x, -z): targets should lean there.
    const rand = makeRand(41);
    let toward = 0;
    const runs = 50;
    for (let i = 0; i < runs; i++) {
      const t = pickWanderTarget({ x: 0, z: 0 }, [], [9, 9, 0, 9], 0.8, rand);
      if (quadrantOf(t) === 2) toward++;
    }
    expect(toward).toBeGreaterThan(runs * 0.5);
  });

  it('energy scales roam distance', () => {
    const reach = (energy: number): number => {
      const rand = makeRand(13);
      let sum = 0;
      for (let i = 0; i < 40; i++) {
        const t = pickWanderTarget({ x: 0, z: 0 }, [], [0, 0, 0, 0], energy, rand);
        sum += Math.hypot(t.x, t.z);
      }
      return sum / 40;
    };
    expect(reach(1)).toBeGreaterThan(reach(0) * 2);
  });
});

// ── obstacle avoidance ───────────────────────────────────────────────────────

/** A deterministic little forest of hard circles (plus some soft strays). */
function fuzzForest(count: number, seed: number): Collider[] {
  const rand = makeRand(seed);
  const out: Collider[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: (rand() - 0.5) * 70,
      z: (rand() - 0.5) * 70,
      r: 0.5 + rand() * 1.5,
      hard: rand() < 0.85,
    });
  }
  return out;
}

describe('projectOutOfHard', () => {
  it('projects a point inside a hard collider out to the clearance ring', () => {
    const grid = buildColliderGrid([{ x: 0, z: 0, r: 2, hard: true }]);
    const p = projectOutOfHard({ x: 0.5, z: 0 }, grid);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(2 + TARGET_CLEARANCE, 6);
  });

  it('returns the same object when the point is already clear (and for soft)', () => {
    const grid = buildColliderGrid([
      { x: 0, z: 0, r: 2, hard: true },
      { x: 10, z: 0, r: 2, hard: false },
    ]);
    const clear = { x: 6, z: 6 };
    expect(projectOutOfHard(clear, grid)).toBe(clear);
    const inBush = { x: 10, z: 0.2 };
    expect(projectOutOfHard(inBush, grid)).toBe(inBush); // soft never blocks
    expect(projectOutOfHard(clear, null)).toBe(clear);
  });
});

describe('avoidanceBend', () => {
  it('bends the heading away, monotonically with proximity', () => {
    // Obstacle bearing 0.4 rad off the +z forward; close the gap step by
    // step — the deflection must never shrink as the surface gets nearer.
    const heading = 0;
    const r = 0.6;
    let prev = -1;
    for (let gap = AVOID_DISTANCE - 0.05; gap >= 0.05; gap -= 0.1) {
      const d = gap + r;
      const c: Collider = { x: Math.sin(0.4) * d, z: Math.cos(0.4) * d, r, hard: true };
      const bent = avoidanceBend({ x: 0, z: 0 }, heading, [c]);
      const deflection = Math.abs(wrapAngle(bent - heading));
      expect(deflection).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(wrapAngle(bent - heading)).toBeLessThan(0); // away from the obstacle
      prev = deflection;
    }
    expect(prev).toBeGreaterThan(0.15); // near contact the bend is real
  });

  it('leaves the heading untouched beyond AVOID_DISTANCE or for soft bodies', () => {
    const far: Collider = { x: 0, z: 5, r: 1, hard: true }; // gap 4 > 2
    const bush: Collider = { x: 0, z: 1, r: 1, hard: false };
    expect(avoidanceBend({ x: 0, z: 0 }, 0.3, [far, bush])).toBe(0.3);
    expect(avoidanceBend({ x: 0, z: 0 }, 0.3, [])).toBe(0.3);
  });

  it('picks a side deterministically on a dead head-on contact', () => {
    const c: Collider = { x: 0, z: 1.4, r: 0.8, hard: true };
    const a = avoidanceBend({ x: 0, z: 0 }, 0, [c]);
    const b = avoidanceBend({ x: 0, z: 0 }, 0, [c]);
    expect(a).toBe(b);
    expect(Math.abs(wrapAngle(a))).toBeGreaterThan(0.1); // it does turn
  });
});

describe('wander targets never land inside hard colliders', () => {
  it('fuzz: 500 seeded rolls across a scattered forest', () => {
    const forest = fuzzForest(80, 21);
    const grid = buildColliderGrid(forest);
    const rand = makeRand(1234);
    for (let i = 0; i < 500; i++) {
      const self = { x: (rand() - 0.5) * 60, z: (rand() - 0.5) * 60 };
      const t = pickWanderTarget(self, [], [0, 0, 0, 0], rand(), rand, grid);
      for (const c of forest) {
        if (!c.hard) continue;
        expect(
          Math.hypot(t.x - c.x, t.z - c.z),
          `target (${t.x.toFixed(2)}, ${t.z.toFixed(2)}) vs collider (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) r=${c.r.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(c.r - 1e-9);
      }
    }
  });

  it('the grid changes candidate positions, never the rand draw count', () => {
    // Same stream with and without a grid → the same number of draws, so
    // downstream behavior stays deterministic when colliders appear.
    const grid = buildColliderGrid(fuzzForest(40, 8));
    const a = makeRand(42);
    const b = makeRand(42);
    pickWanderTarget({ x: 1, z: 2 }, [], [0, 0, 0, 0], 0.7, a);
    pickWanderTarget({ x: 1, z: 2 }, [], [0, 0, 0, 0], 0.7, b, grid);
    expect(a()).toBe(b()); // streams still in lockstep
  });
});
