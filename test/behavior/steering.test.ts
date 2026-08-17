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
  headingTo,
  pickWanderTarget,
  quadrantOf,
  shortestDelta,
  STAND_OFF,
  WORLD_EXTENT,
  wrapAngle,
  type Vec2,
} from '../../src/behavior/steering';

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
