/**
 * Spatial hash (src/physics/colliders.ts) — pure tests.
 *
 * The load-bearing property: queryCircle returns EXACTLY the colliders whose
 * circles strictly overlap the query circle — verified against a brute-force
 * filter over seeded fuzz. Plus: dedupe across cells, deterministic order,
 * and the allocation contract (one reused result array).
 */

import { describe, expect, it } from 'vitest';
import { makeRand } from '../../src/behavior/states';
import {
  buildColliderGrid,
  GRID_CELL_SIZE,
  type Collider,
} from '../../src/physics/colliders';

function brute(colliders: readonly Collider[], x: number, z: number, r: number): Collider[] {
  return colliders.filter((c) => {
    const dx = x - c.x;
    const dz = z - c.z;
    const rr = r + c.r;
    return dx * dx + dz * dz < rr * rr;
  });
}

function fuzzColliders(count: number, seed: number): Collider[] {
  const rand = makeRand(seed);
  const out: Collider[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: (rand() - 0.5) * 240,
      z: (rand() - 0.5) * 240,
      r: 0.3 + rand() * 2.7,
      hard: rand() < 0.8,
    });
  }
  return out;
}

describe('buildColliderGrid.queryCircle', () => {
  it('matches a brute-force overlap filter exactly (300 colliders × 200 queries)', () => {
    const colliders = fuzzColliders(300, 11);
    const grid = buildColliderGrid(colliders);
    const rand = makeRand(77);
    for (let q = 0; q < 200; q++) {
      const x = (rand() - 0.5) * 260;
      const z = (rand() - 0.5) * 260;
      const r = 0.5 + rand() * 11.5;
      // Results come back in input order — byte-identical to the filter.
      expect([...grid.queryCircle(x, z, r)]).toEqual(brute(colliders, x, z, r));
    }
  });

  it('tangency does not count as overlap; any strict overlap does', () => {
    const c: Collider = { x: 10, z: 0, r: 2, hard: true };
    const grid = buildColliderGrid([c]);
    // Touching exactly (d = 4 = 2 + 2): excluded.
    expect(grid.queryCircle(14, 0, 2)).toHaveLength(0);
    // A hair closer: included.
    expect([...grid.queryCircle(13.999, 0, 2)]).toEqual([c]);
    // Query circle entirely inside the collider: included.
    expect([...grid.queryCircle(10, 0, 0.1)]).toEqual([c]);
  });

  it('a collider spanning many cells is returned exactly once', () => {
    const big: Collider = { x: 0, z: 0, r: GRID_CELL_SIZE * 3, hard: true };
    const grid = buildColliderGrid([big]);
    expect(grid.queryCircle(0, 0, GRID_CELL_SIZE * 4)).toHaveLength(1);
    expect(grid.queryCircle(GRID_CELL_SIZE * 2.5, 0, 1)).toHaveLength(1);
  });

  it('reuses one result array across queries (no allocation churn)', () => {
    const grid = buildColliderGrid(fuzzColliders(50, 3));
    const first = grid.queryCircle(0, 0, 30);
    const second = grid.queryCircle(40, 40, 5);
    expect(second).toBe(first); // same array object, rewritten in place
  });

  it('is deterministic: same build + same queries → identical results', () => {
    const colliders = fuzzColliders(120, 9);
    const a = buildColliderGrid(colliders);
    const b = buildColliderGrid(colliders);
    const rand = makeRand(5);
    for (let q = 0; q < 50; q++) {
      const x = (rand() - 0.5) * 200;
      const z = (rand() - 0.5) * 200;
      const r = rand() * 10;
      expect([...a.queryCircle(x, z, r)]).toEqual([...b.queryCircle(x, z, r)]);
    }
  });

  it('handles an empty collider set and negative coordinates', () => {
    const empty = buildColliderGrid([]);
    expect(empty.queryCircle(-100, -100, 50)).toHaveLength(0);
    const c: Collider = { x: -37.5, z: -91.25, r: 1.5, hard: false };
    const grid = buildColliderGrid([c]);
    expect([...grid.queryCircle(-37, -91, 2)]).toEqual([c]);
  });
});
