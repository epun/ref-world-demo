/**
 * Scatter placement tests — pure functions over placement data. No WebGL.
 */

import { describe, expect, it } from 'vitest';
import {
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
  type MeshStandardMaterial,
} from 'three';
import { WORLD } from '../../src/taste/tokens';
import { PROP_VARIANT_COUNTS } from '../../src/world/props';
import {
  applyInstanceVariation,
  BUILDING_ADJ_RADIUS,
  BUILDING_MAX,
  clampWindStrength,
  computePlacements,
  createScatter,
  filterExcluded,
  instanceVariation,
  ROCK_SQUASH_Y,
  ROCK_WIDEN_XZ,
  VARIATION_BULGE,
  VARIATION_LEAN_RAD,
  VARIATION_SCALE_XZ,
  VARIATION_SCALE_Y,
  SCATTER_EXTENT,
  SCATTER_KINDS,
  SCATTER_STEP,
  WIND_AZIMUTH_PERIOD_MS,
  WIND_STRENGTH_MAX,
  WIND_STRENGTH_MIN,
  WIND_SWAY_KINDS,
  windAzimuth,
  type Placement,
} from '../../src/world/scatter';
// Collider surface (kept as a separate import: the physics workstream).
import {
  BUSH_SOFT_FOOTPRINT,
  colliderFor,
  TRUNK_FOOTPRINT,
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

  it('wind direction drift is deterministic, finite, and wanders', () => {
    // Pure in nowMs: two devices (or two calls) agree exactly.
    for (const t of [0, 1234.5, 60000, WIND_AZIMUTH_PERIOD_MS * 2.7]) {
      expect(windAzimuth(t)).toBe(windAzimuth(t));
      expect(Number.isFinite(windAzimuth(t))).toBe(true);
    }
    // The heading actually wanders over multiple periods…
    const samples = [0, 0.5, 1.2, 2.1, 3.4, 4.8].map((k) =>
      windAzimuth(k * WIND_AZIMUTH_PERIOD_MS),
    );
    expect(new Set(samples.map((a) => a.toFixed(4))).size).toBeGreaterThan(3);
    // …but smoothly: adjacent frames barely move (no snap, TASTE §2.1).
    for (let t = 0; t < WIND_AZIMUTH_PERIOD_MS; t += 1000) {
      expect(Math.abs(windAzimuth(t + 16) - windAzimuth(t))).toBeLessThan(0.01);
    }
  });

  it('clamps wind strength sanely — floored above zero, capped, NaN-safe', () => {
    expect(clampWindStrength(0.35)).toBe(0.35);
    expect(clampWindStrength(0)).toBe(WIND_STRENGTH_MIN); // nothing fully still
    expect(clampWindStrength(-3)).toBe(WIND_STRENGTH_MIN);
    expect(clampWindStrength(99)).toBe(WIND_STRENGTH_MAX);
    expect(clampWindStrength(Number.NaN)).toBe(WIND_STRENGTH_MIN);
    expect(WIND_STRENGTH_MIN).toBeGreaterThan(0);
  });

  it('scatter handle: setWind clamps and reports through windState', () => {
    const scatter = createScatter();
    try {
      scatter.setWind(0.7, 5000);
      expect(scatter.windState().strength).toBeCloseTo(0.7, 6);
      expect(scatter.windState().timeMs).toBe(5000);
      expect(scatter.windState().azimuth).toBe(windAzimuth(5000));
      scatter.setWind(-1, 6000);
      expect(scatter.windState().strength).toBe(WIND_STRENGTH_MIN);
      scatter.setWind(99, 7000);
      expect(scatter.windState().strength).toBe(WIND_STRENGTH_MAX);
    } finally {
      scatter.dispose();
    }
  });

  it('wind touches only vegetation: sway kinds carry the height attribute, rigid kinds none', () => {
    expect([...WIND_SWAY_KINDS].sort()).toEqual(['bush', 'conifer', 'tree']);
    const scatter = createScatter();
    try {
      const meshes = scatter.group.children.filter(
        (o): o is InstancedMesh => o instanceof InstancedMesh && o.name.length > 0,
      );
      const kindOf = (name: string): string => name.split('-')[0]!;
      const swaySet = new Set<string>(WIND_SWAY_KINDS);
      const rigid = ['building', 'rock', 'stump'];
      expect(meshes.some((m) => swaySet.has(kindOf(m.name)))).toBe(true);
      expect(meshes.some((m) => rigid.includes(kindOf(m.name)))).toBe(true);

      const materialsOf = (pick: (kind: string) => boolean): Set<Material> =>
        new Set(meshes.filter((m) => pick(kindOf(m.name))).map((m) => m.material as Material));

      for (const mesh of meshes) {
        const kind = kindOf(mesh.name);
        const attr = mesh.geometry.getAttribute('aWindHeight');
        if (swaySet.has(kind)) {
          // Height fraction in [0,1], roots pinned at 0, crowns near 1.
          expect(attr, mesh.name).toBeDefined();
          let min = Infinity;
          let max = -Infinity;
          for (let i = 0; i < attr!.count; i++) {
            const h = attr!.getX(i);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThanOrEqual(1);
            min = Math.min(min, h);
            max = Math.max(max, h);
          }
          expect(min, mesh.name).toBeLessThan(0.05);
          expect(max, mesh.name).toBeGreaterThan(0.9);
        } else {
          // Rigid kinds (and ticks, which bend by position.y alone) carry no
          // wind attribute — buildings, rocks and stumps never lean.
          expect(attr, mesh.name).toBeUndefined();
        }
      }

      // Rigid kinds share the stock material — no wind injection at all: its
      // onBeforeCompile leaves a shader untouched, while the sway material
      // injects the wind uniforms and displacement.
      const fakeShader = () => ({
        uniforms: {} as Record<string, { value: unknown }>,
        vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
        fragmentShader: '',
      });
      // Rigid kinds split into two materials now (rocks carry the mid-tone
      // stone albedo; building/stump keep the light paper) — but NEITHER
      // gets a wind injection.
      const rigidMaterials = materialsOf((k) => rigid.includes(k));
      const swayMaterials = materialsOf((k) => swaySet.has(k));
      expect(rigidMaterials.size).toBe(2);
      expect(swayMaterials.size).toBe(1);
      const [swayMat] = swayMaterials;

      for (const rigidMat of rigidMaterials) {
        expect(rigidMat).not.toBe(swayMat);
        const rigidShader = fakeShader();
        rigidMat.onBeforeCompile(rigidShader as never, undefined as never);
        expect(rigidShader.vertexShader).not.toContain('uWindStrength');
        expect(rigidShader.uniforms['uWindStrength']).toBeUndefined();
      }

      const swayShader = fakeShader();
      swayMat!.onBeforeCompile(swayShader as never, undefined as never);
      expect(swayShader.vertexShader).toContain('uWindStrength');
      expect(swayShader.vertexShader).toContain('aWindHeight');
      expect(swayShader.uniforms['uWindStrength']).toBeDefined();

      // Ticks bend too — full-blade, no attribute needed.
      const tick = scatter.group.children.find(
        (o): o is InstancedMesh => o instanceof InstancedMesh && o.name === 'tick',
      );
      expect(tick).toBeDefined();
      const tickShader = fakeShader();
      (tick!.material as Material).onBeforeCompile(tickShader as never, undefined as never);
      expect(tickShader.vertexShader).toContain('uWindStrength');
      expect(tickShader.vertexShader).not.toContain('aWindHeight');
    } finally {
      scatter.dispose();
    }
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

// ── colliders (hard/soft body physics) ───────────────────────────────────────

describe('scatter colliders', () => {
  it('colliderFor: trunk kinds block small, grounded kinds at base extent, bush soft, tick none', () => {
    const at = (kind: Placement['kind'], scale = 1): Placement => ({
      kind,
      variant: 0,
      x: 3,
      z: -4,
      scale,
      rotY: 0,
    });
    expect(colliderFor(at('tick'), 0.4)).toBeNull();

    const tree = colliderFor(at('tree'), 2.4)!;
    expect(tree.hard).toBe(true);
    expect(tree.r).toBeCloseTo(TRUNK_FOOTPRINT.tree!, 9); // trunk, not the 2.4 crown
    expect(tree.r).toBeLessThan(2.4);

    const conifer = colliderFor(at('conifer', 1.2), 2.0)!;
    expect(conifer.r).toBeCloseTo(TRUNK_FOOTPRINT.conifer! * 1.2, 9);

    const rock = colliderFor(at('rock', 0.8), 1.7)!;
    expect(rock.hard).toBe(true);
    // Base extent × instance scale × the rock widen bias (rocks render flat
    // and wide so they never read as eggs — the collider follows).
    expect(rock.r).toBeCloseTo(1.7 * 0.8 * ROCK_WIDEN_XZ, 9);

    const bush = colliderFor(at('bush', 1.1), 1.9)!;
    expect(bush.hard).toBe(false);
    expect(bush.r).toBeCloseTo(BUSH_SOFT_FOOTPRINT * 1.1, 9);

    for (const kind of ['building', 'stump'] as const) {
      expect(colliderFor(at(kind), 1.5)!.hard).toBe(true);
    }
  });

  it('handle: one collider per visible non-tick prop, hard/soft split by kind', () => {
    const scatter = createScatter();
    try {
      const props = scatter.positions();
      const colliders = scatter.colliders();
      expect(colliders.length).toBe(props.length);
      // Same iteration order as positions(): pair them up.
      props.forEach((p, i) => {
        const c = colliders[i]!;
        expect(c.x).toBe(p.x);
        expect(c.z).toBe(p.z);
        expect(c.hard).toBe(p.kind !== 'bush');
        if (p.kind === 'tree' || p.kind === 'conifer') {
          expect(c.r, p.kind).toBeLessThan(p.r); // trunks block, crowns overhang
        }
        expect(c.r).toBeGreaterThan(0);
      });
    } finally {
      scatter.dispose();
    }
  });

  it('handle: cached between mutations, version bumps on every rebuild path', () => {
    const scatter = createScatter();
    try {
      const v0 = scatter.collidersVersion();
      const first = scatter.colliders();
      expect(scatter.colliders()).toBe(first); // cached array identity

      scatter.setKindDensity('tree', 0);
      expect(scatter.collidersVersion()).toBeGreaterThan(v0);
      const noTrees = scatter.colliders();
      expect(noTrees).not.toBe(first);
      expect(noTrees.length).toBeLessThan(first.length);

      scatter.setKindDensity('tree', 1);
      const v1 = scatter.collidersVersion();
      // Exclusions hide props — and their colliders with them.
      const victim = scatter.colliders()[0]!;
      scatter.setExclusions([{ x: victim.x, z: victim.z, r: 0.5 }]);
      expect(scatter.collidersVersion()).toBeGreaterThan(v1);
      expect(
        scatter.colliders().some((c) => c.x === victim.x && c.z === victim.z),
      ).toBe(false);

      // Kind scale scales the collider footprint too.
      scatter.setExclusions([]);
      const rockBefore = scatter
        .colliders()
        .find((c, i) => scatter.positions()[i]!.kind === 'rock')!;
      scatter.setKindScale('rock', 2);
      const rockAfter = scatter
        .colliders()
        .find((c) => c.x === rockBefore.x && c.z === rockBefore.z)!;
      expect(rockAfter.r).toBeCloseTo(rockBefore.r * 2, 6);
    } finally {
      scatter.dispose();
    }
  });

  it('nudge: slots are capped at 8, nearby re-nudges refresh instead of burning slots', () => {
    const scatter = createScatter();
    try {
      expect(scatter.nudgeState()).toHaveLength(0);
      scatter.nudge(5, 5, 0.8);
      expect(scatter.nudgeState()).toHaveLength(1);
      // Brushing the same bush again lands in the same slot.
      scatter.nudge(5.2, 5.1, 0.5);
      expect(scatter.nudgeState()).toHaveLength(1);
      expect(scatter.nudgeState()[0]!.strength).toBeCloseTo(0.8, 9); // max kept
      // Zero / negative strength is a no-op.
      scatter.nudge(20, 20, 0);
      expect(scatter.nudgeState()).toHaveLength(1);
      // Distinct points fill distinct slots, capped at 8.
      for (let i = 0; i < 12; i++) scatter.nudge(i * 7, -40, 1);
      expect(scatter.nudgeState().length).toBeLessThanOrEqual(8);
    } finally {
      scatter.dispose();
    }
  });
});

// ── per-instance shape variation (no two identical props) ────────────────────

describe('instance variation', () => {
  it('is deterministic and every channel sits in [0, 1)', () => {
    for (const p of computePlacements()) {
      const v = instanceVariation(p.x, p.z);
      expect(v).toEqual(instanceVariation(p.x, p.z));
      for (const c of v) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(1);
      }
    }
  });

  it('differs between instances — silhouettes, not just sizes', () => {
    const placements = computePlacements().filter((p) => p.kind !== 'tick');
    const signatures = new Set(
      placements.map((p) =>
        instanceVariation(p.x, p.z)
          .map((c) => c.toFixed(5))
          .join(','),
      ),
    );
    // Practically every instance carries its own deformation vector.
    expect(signatures.size).toBeGreaterThan(placements.length * 0.98);
  });

  it('max vertex displacement stays under the amplitude thresholds', () => {
    // Radial (x/z) worst case: scale × bulge compounding; vertical: scale
    // only; lean adds at most LEAN_RAD × the (scaled) height.
    const radialMax = (1 + VARIATION_SCALE_XZ) * (1 + VARIATION_BULGE) - 1; // ≈ 0.113
    const samples = [
      { x: 1, y: 0, z: 0 },
      { x: 0.8, y: 1.2, z: -0.6 },
      { x: -1.5, y: 3.1, z: 0.4 },
      { x: 0, y: 6.4, z: 0 }, // tallest authored prop height
      { x: 2.2, y: 0.5, z: 2.2 },
      { x: -0.3, y: 5.0, z: -1.9 },
    ];
    const placements = computePlacements().slice(0, 300);
    expect(placements.length).toBeGreaterThan(50);
    for (const p of placements) {
      const v = instanceVariation(p.x, p.z);
      for (const s of samples) {
        const out = applyInstanceVariation(s, v);
        expect(Math.abs(out.y - s.y)).toBeLessThanOrEqual(
          Math.abs(s.y) * VARIATION_SCALE_Y + 1e-9,
        );
        const leanBound = VARIATION_LEAN_RAD * Math.max(out.y, 0);
        expect(Math.abs(out.x - s.x)).toBeLessThanOrEqual(
          Math.abs(s.x) * radialMax + leanBound + 1e-9,
        );
        expect(Math.abs(out.z - s.z)).toBeLessThanOrEqual(
          Math.abs(s.z) * radialMax + leanBound + 1e-9,
        );
      }
    }
    // Subtlety in absolute terms: a crown point 2 units out on a 6.4-unit
    // prop never moves more than ~0.55 units — on-model, never a new shape.
    const worst = applyInstanceVariation({ x: 2, y: 6.4, z: 2 }, [0.999, 0.999, 0.999, 0.999]);
    expect(Math.hypot(worst.x - 2, worst.y - 6.4, worst.z - 2)).toBeLessThan(0.75);
  });

  it('the variation channel leaves placements untouched', () => {
    const before = computePlacements();
    for (const p of before) instanceVariation(p.x, p.z);
    expect(computePlacements()).toEqual(before);
  });

  it('every instanced prop and tick mesh carries a matching aVariation attribute', () => {
    const scatter = createScatter();
    try {
      const meshes = scatter.group.children.filter(
        (o): o is InstancedMesh => o instanceof InstancedMesh && o.name.length > 0,
      );
      expect(meshes.length).toBeGreaterThan(5);
      const matrix = new Matrix4();
      const pos = new Vector3();
      const quat = new Quaternion();
      const scl = new Vector3();
      for (const mesh of meshes) {
        const attr = mesh.geometry.getAttribute('aVariation');
        expect(attr, mesh.name).toBeDefined();
        expect(attr!.itemSize, mesh.name).toBe(4);
        expect(attr!.count, mesh.name).toBe(mesh.count);
        // Attribute rows pair with their instances: re-derive from the
        // instance matrix translation (ticks bake a small y-lift; the
        // variation hash reads x/z only, so the lift is irrelevant).
        for (let i = 0; i < Math.min(mesh.count, 8); i++) {
          mesh.getMatrixAt(i, matrix);
          matrix.decompose(pos, quat, scl);
          const expected = instanceVariation(pos.x, pos.z);
          for (let c = 0; c < 4; c++) {
            expect(attr!.getComponent(i, c), `${mesh.name}[${i}].${c}`).toBeCloseTo(
              expected[c]!,
              6,
            );
          }
        }
      }
    } finally {
      scatter.dispose();
    }
  });

  it('all three scatter materials inject the variation into the vertex stage', () => {
    const scatter = createScatter();
    try {
      const meshes = scatter.group.children.filter(
        (o): o is InstancedMesh => o instanceof InstancedMesh && o.name.length > 0,
      );
      const kindOf = (name: string): string => name.split('-')[0]!;
      const swaySet = new Set<string>(WIND_SWAY_KINDS);
      const fakeShader = () => ({
        uniforms: {} as Record<string, { value: unknown }>,
        vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
        fragmentShader: '',
      });
      const materialFor = (pick: (kind: string) => boolean): Material =>
        meshes.find((m) => pick(kindOf(m.name)))!.material as Material;

      // Rigid kinds (building/rock/stump): variation yes, wind still no.
      const rigid = fakeShader();
      materialFor((k) => ['building', 'rock', 'stump'].includes(k)).onBeforeCompile(
        rigid as never,
        undefined as never,
      );
      expect(rigid.vertexShader).toContain('aVariation');
      expect(rigid.vertexShader).not.toContain('uWindStrength');

      // Sway kinds: variation chained WITH the wind, neither clobbered.
      const sway = fakeShader();
      materialFor((k) => swaySet.has(k)).onBeforeCompile(sway as never, undefined as never);
      expect(sway.vertexShader).toContain('aVariation');
      expect(sway.vertexShader).toContain('uWindStrength');
      expect(sway.vertexShader).toContain('aWindHeight');
      // Variation deforms the form BEFORE the wind displaces it.
      expect(sway.vertexShader.indexOf('varBulge')).toBeLessThan(
        sway.vertexShader.indexOf('windGust'),
      );

      // Ticks reuse the same path (their length/bend jitter) plus their wind.
      const tick = fakeShader();
      materialFor((k) => k === 'tick').onBeforeCompile(tick as never, undefined as never);
      expect(tick.vertexShader).toContain('aVariation');
      expect(tick.vertexShader).toContain('uWindStrength');
    } finally {
      scatter.dispose();
    }
  });
});

// ── rock legibility (eggs are the only light-shelled lumps) ──────────────────

describe('rock legibility', () => {
  it('rocks render mid-toned, squashed and widened; other rigid kinds stay light', () => {
    const scatter = createScatter();
    try {
      const meshes = scatter.group.children.filter(
        (o): o is InstancedMesh => o instanceof InstancedMesh && o.name.length > 0,
      );
      const rock = meshes.find((m) => m.name.startsWith('rock-'));
      const otherRigid = meshes.find(
        (m) => m.name.startsWith('building-') || m.name.startsWith('stump-'),
      );
      expect(rock).toBeDefined();
      expect(otherRigid).toBeDefined();

      // Mid-band albedo for stone; the light role stays with the eggs (and
      // the other props' paper fill).
      expect(rock!.material).not.toBe(otherRigid!.material);
      const rockColor = (rock!.material as MeshStandardMaterial).color.getHexString();
      const rigidColor = (otherRigid!.material as MeshStandardMaterial).color.getHexString();
      expect(`#${rockColor}`).toBe(WORLD.neutral);
      expect(`#${rigidColor}`).toBe(WORLD.light);

      // Flat-and-wide instance bias: y/x scale ratio = SQUASH / WIDEN.
      const matrix = new Matrix4();
      const pos = new Vector3();
      const quat = new Quaternion();
      const scl = new Vector3();
      rock!.getMatrixAt(0, matrix);
      matrix.decompose(pos, quat, scl);
      expect(scl.y / scl.x).toBeCloseTo(ROCK_SQUASH_Y / ROCK_WIDEN_XZ, 6);
      expect(scl.z).toBeCloseTo(scl.x, 9);
      otherRigid!.getMatrixAt(0, matrix);
      matrix.decompose(pos, quat, scl);
      expect(scl.y / scl.x).toBeCloseTo(1, 6);
    } finally {
      scatter.dispose();
    }
  });
});

// ── zero density is EXACTLY zero (no invisible colliders) ────────────────────

describe('zero kind density', () => {
  it('multiplier 0 → no placements of the kind, seeds and cluster neighbors alike', () => {
    const base = computePlacements();
    for (const kind of ['tree', 'rock'] as const) {
      const none = computePlacements({ kindDensity: { [kind]: 0 } });
      expect(none.filter((p) => p.kind === kind)).toHaveLength(0);
      // Ticks roll on their own layer: byte-identical.
      expect(none.filter((p) => p.kind === 'tick')).toEqual(
        base.filter((p) => p.kind === 'tick'),
      );
      // Every other base placement survives untouched (freed cells may ADD
      // other kinds — the documented per-kind independence — never move them).
      const key = (p: Placement): string => `${p.kind}:${p.x.toFixed(4)},${p.z.toFixed(4)}`;
      const after = new Set(none.map(key));
      for (const p of base) {
        if (p.kind === kind) continue;
        expect(after.has(key(p)), key(p)).toBe(true);
      }
    }
  });

  it('handle: zeroing a kind removes its meshes, positions, colliders, and restores exactly', () => {
    const scatter = createScatter();
    try {
      const rockMeshCount = (): number =>
        scatter.group.children.filter(
          (o) => o instanceof InstancedMesh && o.name.startsWith('rock-'),
        ).length;
      const baseColliders = scatter.colliders().map((c) => ({ ...c }));
      const basePositions = scatter.positions();
      const rocks = basePositions.filter((p) => p.kind === 'rock');
      expect(rocks.length).toBeGreaterThan(0);
      expect(rockMeshCount()).toBeGreaterThan(0);

      scatter.setKindDensity('rock', 0);
      const positions = scatter.positions();
      const colliders = scatter.colliders();
      expect(positions.filter((p) => p.kind === 'rock')).toHaveLength(0);
      expect(rockMeshCount()).toBe(0);
      // One collider per visible prop — with rocks gone, none of the rock
      // colliders may linger (creatures must not steer around ghosts).
      expect(colliders).toHaveLength(positions.length);
      const rockSpots = new Set(rocks.map((r) => `${r.x},${r.z}`));
      for (const c of colliders) {
        expect(rockSpots.has(`${c.x},${c.z}`)).toBe(false);
      }

      // Restoring the multiplier restores the original set exactly.
      scatter.setKindDensity('rock', 1);
      expect(scatter.positions()).toEqual(basePositions);
      expect(scatter.colliders()).toEqual(baseColliders);
    } finally {
      scatter.dispose();
    }
  });
});
