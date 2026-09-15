import { describe, expect, it } from 'vitest';
import { SpatialHash } from '../../src/physics/spatial';
import { separateCreatures, type CreatureBody } from '../../src/physics/resolve';

/** Brute-force reference: every index within r of (x, z), ascending. */
function naive(items: { x: number; z: number }[], x: number, z: number, r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const dx = items[i]!.x - x;
    const dz = items[i]!.z - z;
    if (dx * dx + dz * dz <= r * r) out.push(i);
  }
  return out;
}

/** Deterministic lcg so the test never depends on Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('SpatialHash', () => {
  it('refuses a cell size that is not a positive number', () => {
    expect(() => new SpatialHash(0)).toThrow(RangeError);
    expect(() => new SpatialHash(-1)).toThrow(RangeError);
    expect(() => new SpatialHash(Number.NaN)).toThrow(RangeError);
  });

  it('answers exactly what a brute-force scan answers, ascending, at every radius', () => {
    const rand = lcg(7);
    const items = Array.from({ length: 300 }, () => ({
      x: (rand() - 0.5) * 120,
      z: (rand() - 0.5) * 120,
    }));
    const grid = new SpatialHash(4);
    grid.rebuild(items);
    expect(grid.size).toBe(300);
    for (let q = 0; q < 80; q++) {
      const x = (rand() - 0.5) * 140;
      const z = (rand() - 0.5) * 140;
      // Radii both under and well over a cell — the block widens to match.
      const r = rand() * 15;
      expect([...grid.near(x, z, r)]).toEqual(naive(items, x, z, r));
    }
  });

  it('is exact on the cell boundary and at the query point itself', () => {
    const items = [
      { x: 0, z: 0 },
      { x: 4, z: 0 }, // exactly one cell over
      { x: -4, z: -4 },
      { x: 2, z: 2 },
    ];
    const grid = new SpatialHash(4);
    grid.rebuild(items);
    expect([...grid.near(0, 0, 0)]).toEqual([0]);
    // (2, 2) is 2.83 away — inside the disc, though it sits in another cell.
    expect([...grid.near(0, 0, 4)]).toEqual([0, 1, 3]);
    expect([...grid.near(0, 0, Math.hypot(4, 4))]).toEqual([0, 1, 2, 3]);
  });

  it('a negative or non-finite radius finds nothing', () => {
    const grid = new SpatialHash(2);
    grid.rebuild([{ x: 0, z: 0 }]);
    expect(grid.near(0, 0, -1).length).toBe(0);
    expect(grid.near(0, 0, Number.NaN).length).toBe(0);
  });

  it('rebuild replaces the index completely — nothing from the last set lingers', () => {
    const grid = new SpatialHash(1);
    grid.rebuild([{ x: 0, z: 0 }, { x: 10, z: 10 }]);
    expect([...grid.near(10, 10, 0.5)]).toEqual([1]);
    grid.rebuild([{ x: 5, z: 5 }]);
    expect(grid.size).toBe(1);
    expect(grid.near(10, 10, 0.5).length).toBe(0);
    expect([...grid.near(5, 5, 0.5)]).toEqual([0]);
  });

  it('reuses its result array between queries (callers copy what they keep)', () => {
    const grid = new SpatialHash(1);
    grid.rebuild([{ x: 0, z: 0 }, { x: 3, z: 3 }]);
    const a = grid.near(0, 0, 0.5);
    const b = grid.near(3, 3, 0.5);
    expect(a).toBe(b);
    expect([...b]).toEqual([1]);
  });

  it('handles positions far from the origin and on both sides of it', () => {
    const items = [
      { x: -1000.5, z: 999.25 },
      { x: -1000.25, z: 999.5 },
      { x: 1000, z: -1000 },
    ];
    const grid = new SpatialHash(3);
    grid.rebuild(items);
    expect([...grid.near(-1000.4, 999.4, 0.5)]).toEqual([0, 1]);
    expect([...grid.near(1000, -1000, 0.1)]).toEqual([2]);
  });
});

describe('separateCreatures (all-pairs on purpose — see src/physics/spatial.ts header)', () => {
  function crowd(n: number, seed: number, spread: number): CreatureBody[] {
    const rand = lcg(seed);
    return Array.from({ length: n }, () => ({
      x: (rand() - 0.5) * spread,
      z: (rand() - 0.5) * spread,
      vx: (rand() - 0.5) * 2,
      vz: (rand() - 0.5) * 2,
      r: 0.5 + rand() * 0.6,
    }));
  }

  function overlaps(bodies: readonly CreatureBody[]): number {
    let count = 0;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const sum = a.r + b.r;
        if (Math.hypot(a.x - b.x, a.z - b.z) < sum - 1e-6) count++;
      }
    }
    return count;
  }

  it('leaves a crowd of 200 penetration-free', () => {
    const bodies = crowd(200, 11, 45);
    expect(overlaps(bodies)).toBeGreaterThan(0);
    separateCreatures(bodies);
    expect(overlaps(bodies)).toBe(0);
  });

  it('is deterministic — the same crowd resolves to the same positions twice', () => {
    const a = crowd(120, 3, 20);
    const b = crowd(120, 3, 20);
    separateCreatures(a);
    separateCreatures(b);
    expect(a).toEqual(b);
  });

  it('does not touch a crowd that is already apart', () => {
    const bodies: CreatureBody[] = [
      { x: 0, z: 0, vx: 1, vz: 0, r: 1 },
      { x: 10, z: 0, vx: -1, vz: 0, r: 1 },
      { x: 0, z: 10, vx: 0, vz: 0, r: 1 },
    ];
    const before = JSON.stringify(bodies);
    expect(separateCreatures(bodies)).toBe(false);
    expect(JSON.stringify(bodies)).toBe(before);
  });
});
