/**
 * Scatter placement tests — pure functions over placement data. No WebGL.
 */

import { describe, expect, it } from 'vitest';
import { PROP_VARIANT_COUNTS } from '../../src/world/props';
import {
  BUILDING_ADJ_RADIUS,
  BUILDING_MAX,
  computePlacements,
  createScatter,
  filterExcluded,
  SCATTER_EXTENT,
  SCATTER_KINDS,
  SCATTER_STEP,
  type Placement,
} from '../../src/world/scatter';

describe('scatter placement', () => {
  it('is deterministic (positions and variants alike)', () => {
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

  it('every variant index is in range for its kind', () => {
    for (const p of computePlacements()) {
      expect(p.variant).toBeGreaterThanOrEqual(0);
      if (p.kind === 'tick') {
        expect(p.variant).toBe(0);
      } else {
        expect(p.variant, p.kind).toBeLessThan(PROP_VARIANT_COUNTS[p.kind]);
        expect(Number.isInteger(p.variant)).toBe(true);
      }
    }
  });

  it('uses every authored variant of the grove kinds', () => {
    const placements = computePlacements();
    for (const kind of ['tree', 'conifer', 'bush', 'rock', 'stump'] as const) {
      const of = placements.filter((p) => p.kind === kind);
      const used = new Set(of.map((p) => p.variant));
      expect(used.size, `${kind} variants used`).toBe(PROP_VARIANT_COUNTS[kind]);
      // No single variant swallows the kind entirely.
      for (const v of used) {
        const frac = of.filter((p) => p.variant === v).length / of.length;
        expect(frac, `${kind} variant ${v} share`).toBeLessThan(0.75);
      }
    }
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

  it('cluster neighbors bias toward one variant — present but not total', () => {
    const placements = computePlacements();
    for (const kind of ['tree', 'conifer'] as const) {
      const of = placements.filter((p) => p.kind === kind);
      const near = SCATTER_STEP * 2;
      let pairs = 0;
      let same = 0;
      for (let i = 0; i < of.length; i++) {
        for (let j = i + 1; j < of.length; j++) {
          const a = of[i]!;
          const b = of[j]!;
          if (Math.hypot(a.x - b.x, a.z - b.z) < near) {
            pairs++;
            if (a.variant === b.variant) same++;
          }
        }
      }
      expect(pairs, `${kind} near pairs`).toBeGreaterThan(20);
      const frac = same / pairs;
      // Uniform-independent picks would land near 1/count (≤ 0.34); the
      // ~60% cluster bias should push well past that — but a grove still
      // keeps its strays, so it never becomes uniform.
      expect(frac, `${kind} same-variant fraction`).toBeGreaterThan(0.45);
      expect(frac, `${kind} same-variant fraction`).toBeLessThan(0.95);
    }
  });

  it('buildings are rare, capped, and never repeat a variant nearby', () => {
    const buildings = computePlacements().filter((p) => p.kind === 'building');
    expect(buildings.length).toBeGreaterThan(0);
    expect(buildings.length).toBeLessThanOrEqual(BUILDING_MAX);
    // Buildings face the default iso camera (directional silhouettes).
    for (const b of buildings) {
      expect(Math.abs(b.rotY - Math.PI / 4)).toBeLessThanOrEqual(0.25 + 1e-9);
    }
    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        const a = buildings[i]!;
        const b = buildings[j]!;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < BUILDING_ADJ_RADIUS) {
          expect(a.variant, `buildings at d=${d.toFixed(1)}`).not.toBe(b.variant);
        }
      }
    }
  });

  it('ticks are numerous relative to props and buildings are rare', () => {
    const placements = computePlacements();
    const byKind = new Map<string, number>();
    for (const p of placements) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
    const ticks = byKind.get('tick') ?? 0;
    const props = placements.length - ticks;
    expect(ticks).toBeGreaterThan(props);
    expect(byKind.get('building') ?? 0).toBeLessThanOrEqual(BUILDING_MAX);
    expect(byKind.get('building') ?? 0).toBeGreaterThan(0);
  });

  it('exclusion filtering is exact: strictly inside hidden, outside kept', () => {
    const placements: Placement[] = [
      { kind: 'tree', variant: 0, x: 0, z: 0, scale: 1, rotY: 0 },
      { kind: 'tree', variant: 1, x: 3, z: 4, scale: 1, rotY: 0 }, // dist 5, on the r=5 boundary
      { kind: 'rock', variant: 0, x: 2, z: 0, scale: 1, rotY: 0 }, // dist 2, inside
      { kind: 'tick', variant: 0, x: 10, z: 0, scale: 1, rotY: 0 }, // outside
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

  it('exports the controllable kind list for the dev panel', () => {
    expect(SCATTER_KINDS).toContain('tree');
    expect(SCATTER_KINDS).toContain('tick');
    expect(SCATTER_KINDS).toContain('building');
    expect(new Set(SCATTER_KINDS).size).toBe(SCATTER_KINDS.length);
    expect(SCATTER_KINDS.length).toBe(7);
  });

  it('per-kind density is independent: one kind never moves another', () => {
    const key = (p: Placement): string => `${p.kind}:${p.x.toFixed(4)},${p.z.toFixed(4)}`;
    const base = computePlacements();

    // Zeroing trees removes every tree and moves nothing else: ticks are
    // byte-identical, and every base conifer/rock/... placement survives
    // (freed cells may ADD other kinds, never move them).
    const noTrees = computePlacements({ kindDensity: { tree: 0 } });
    expect(noTrees.filter((p) => p.kind === 'tree').length).toBe(0);
    expect(noTrees.filter((p) => p.kind === 'tick')).toEqual(
      base.filter((p) => p.kind === 'tick'),
    );
    const afterKeys = new Set(noTrees.map(key));
    for (const p of base) {
      if (p.kind === 'tree') continue;
      expect(afterKeys.has(key(p)), key(p)).toBe(true);
    }

    // Boosting ticks leaves every non-tick placement byte-identical.
    const moreTicks = computePlacements({ kindDensity: { tick: 2 } });
    expect(moreTicks.filter((p) => p.kind !== 'tick')).toEqual(
      base.filter((p) => p.kind !== 'tick'),
    );
    expect(moreTicks.filter((p) => p.kind === 'tick').length).toBeGreaterThan(
      base.filter((p) => p.kind === 'tick').length,
    );
  });

  it('per-kind density is monotone in its own multiplier', () => {
    const trees = (mult: number): number =>
      computePlacements({ kindDensity: { tree: mult } }).filter((p) => p.kind === 'tree').length;
    expect(trees(0.5)).toBeLessThan(trees(1));
    expect(trees(1)).toBeLessThan(trees(2));
  });

  it('scatter handle: setKindDensity and setKindScale act per kind', () => {
    const scatter = createScatter();
    try {
      const trees = (): number => scatter.positions().filter((p) => p.kind === 'tree').length;
      const rocks = (): number => scatter.positions().filter((p) => p.kind === 'rock').length;
      const treesBefore = trees();
      const rocksBefore = rocks();
      expect(treesBefore).toBeGreaterThan(0);

      scatter.setKindDensity('tree', 0);
      expect(trees()).toBe(0);
      expect(rocks()).toBe(rocksBefore); // rocks untouched
      scatter.setKindDensity('tree', 1);
      expect(trees()).toBe(treesBefore);

      const rockR = scatter.positions().find((p) => p.kind === 'rock')!.r;
      const treeR = scatter.positions().find((p) => p.kind === 'tree')!.r;
      scatter.setKindScale('rock', 2);
      expect(scatter.positions().find((p) => p.kind === 'rock')!.r).toBeCloseTo(rockR * 2, 6);
      expect(scatter.positions().find((p) => p.kind === 'tree')!.r).toBeCloseTo(treeR, 6);
    } finally {
      scatter.dispose();
    }
  });
});
