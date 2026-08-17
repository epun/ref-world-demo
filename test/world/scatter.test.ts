/**
 * Scatter placement tests — pure functions over placement data. No WebGL.
 */

import { describe, expect, it } from 'vitest';
import {
  computePlacements,
  filterExcluded,
  SCATTER_EXTENT,
  SCATTER_STEP,
  type Placement,
} from '../../src/world/scatter';

describe('scatter placement', () => {
  it('is deterministic', () => {
    expect(computePlacements()).toEqual(computePlacements());
    expect(computePlacements({ density: 0.7 })).toEqual(computePlacements({ density: 0.7 }));
  });

  it('stays inside a padded region and clear of the origin', () => {
    for (const p of computePlacements()) {
      // Neighbors may reach ~1.6 steps past their seed cell.
      expect(Math.abs(p.x)).toBeLessThan(SCATTER_EXTENT + SCATTER_STEP * 2.5);
      expect(Math.abs(p.z)).toBeLessThan(SCATTER_EXTENT + SCATTER_STEP * 2.5);
      // Origin clearing: the hatch ground stays open paper.
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(5.9);
    }
  });

  it('produces variation in scale and rotation within bounds', () => {
    const placements = computePlacements();
    const scales = new Set<number>();
    for (const p of placements) {
      expect(p.scale).toBeGreaterThanOrEqual(0.7);
      expect(p.scale).toBeLessThanOrEqual(1.3);
      expect(p.rotY).toBeGreaterThanOrEqual(0);
      expect(p.rotY).toBeLessThanOrEqual(Math.PI * 2);
      scales.add(Math.round(p.scale * 100));
    }
    expect(scales.size).toBeGreaterThan(10);
  });

  it('clusters: placements have same-kind neighbors far more often than chance', () => {
    const placements = computePlacements();
    const trees = placements.filter((p) => p.kind === 'tree');
    expect(trees.length).toBeGreaterThan(10);

    const nearRadius = SCATTER_STEP * 2;
    const withNeighbor = trees.filter((p) =>
      trees.some((q) => {
        if (q === p) return false;
        return Math.hypot(q.x - p.x, q.z - p.z) < nearRadius;
      }),
    ).length;
    const observed = withNeighbor / trees.length;

    // Chance baseline: under uniform placement of N trees over the region,
    // the expected fraction with a neighbor inside r is
    // 1 - (1 - πr²/A)^(N-1).
    const area = (2 * SCATTER_EXTENT) ** 2;
    const pDisc = (Math.PI * nearRadius * nearRadius) / area;
    const chance = 1 - Math.pow(1 - pDisc, trees.length - 1);

    // With enough trees the uniform baseline itself exceeds 0.5, so assert
    // an absolute lead over chance rather than a multiple of it.
    expect(observed).toBeGreaterThan(Math.min(chance + 0.2, 0.95));
    expect(observed).toBeGreaterThan(0.6); // every seed spawns 1-4 neighbors
  });

  it('ticks are numerous relative to props and landmarks are rare', () => {
    const placements = computePlacements();
    const byKind = new Map<string, number>();
    for (const p of placements) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
    const ticks = byKind.get('tick') ?? 0;
    const props = placements.length - ticks;
    expect(ticks).toBeGreaterThan(props);
    expect(byKind.get('landmark') ?? 0).toBeLessThanOrEqual(3);
    expect(byKind.get('landmark') ?? 0).toBeGreaterThan(0);
  });

  it('exclusion filtering is exact: strictly inside hidden, outside kept', () => {
    const placements: Placement[] = [
      { kind: 'tree', x: 0, z: 0, scale: 1, rotY: 0 },
      { kind: 'tree', x: 3, z: 4, scale: 1, rotY: 0 }, // dist 5, on the r=5 boundary
      { kind: 'rock', x: 2, z: 0, scale: 1, rotY: 0 }, // dist 2, inside
      { kind: 'tick', x: 10, z: 0, scale: 1, rotY: 0 }, // outside
    ];
    const kept = filterExcluded(placements, [{ x: 0, z: 0, r: 5 }]);
    expect(kept).toEqual([placements[1], placements[3]]);
    // No exclusions: identity.
    expect(filterExcluded(placements, [])).toEqual(placements);
    // Multiple circles combine.
    const kept2 = filterExcluded(placements, [
      { x: 0, z: 0, r: 5 },
      { x: 10, z: 0, r: 1 },
    ]);
    expect(kept2).toEqual([placements[1]]);
  });

  it('density multiplier changes instance count monotonically', () => {
    const low = computePlacements({ density: 0.5 }).length;
    const mid = computePlacements({ density: 1 }).length;
    const high = computePlacements({ density: 1.6 }).length;
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(computePlacements({ density: 0 }).length).toBe(0);
  });
});
