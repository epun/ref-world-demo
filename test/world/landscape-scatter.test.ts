/**
 * Landscape-aware scatter — the map (src/world/landscape.ts) deciding WHAT
 * grows WHERE. Pure placement data; no WebGL except where a test has to
 * look at the built meshes.
 *
 * The invariant these all circle: the plain is still the world that shipped
 * before the map existed, and everything else is a departure from it that
 * the map asked for.
 */

import { describe, expect, it } from 'vitest';
import { InstancedMesh, type Material, type MeshStandardMaterial } from 'three';
import { WORLD } from '../../src/taste/tokens';
import { isWater, sampleLandscape } from '../../src/world/landscape';
import { MOUNTAIN_FOOTPRINT, PROP_VARIANT_COUNTS } from '../../src/world/props';
import {
  computePlacements,
  createScatter,
  filterExcluded,
  MOUNTAIN_CLEAR_FIT,
  MOUNTAIN_MAX,
  SHADOW_FIT,
  SHADOW_MAX_RADIUS,
  type Placement,
} from '../../src/world/scatter';

const shipped = (): Placement[] => computePlacements();

const kindsOf = (ps: Placement[], kind: Placement['kind']): Placement[] =>
  ps.filter((p) => p.kind === kind);

/** Distance from (x, z) to the nearest water, probed radially. Infinity when
 * there is none inside `max`. */
function distanceToWater(x: number, z: number, max = 4): number {
  for (let r = 0.1; r <= max; r += 0.1) {
    for (let a = 0; a < 32; a++) {
      const th = (a / 32) * Math.PI * 2;
      if (isWater(x + Math.cos(th) * r, z + Math.sin(th) * r)) return r;
    }
  }
  return Infinity;
}

/** Ground area, in square world units, where `pick` holds — a coarse grid
 * integral, the same grid for every region so the ratios are comparable. */
function areaWhere(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  pick: (x: number, z: number) => boolean,
  step = 0.5,
): number {
  let area = 0;
  for (let x = x0; x <= x1; x += step) {
    for (let z = z0; z <= z1; z += step) if (pick(x, z)) area += step * step;
  }
  return area;
}

describe('nothing stands in water', () => {
  it('no placement of any kind is wet', () => {
    for (const p of shipped()) {
      expect(isWater(p.x, p.z), `${p.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`).toBe(false);
    }
  });

  it('holds at cranked density too — the cut is on the placement, not the roll', () => {
    for (const density of [0.5, 2]) {
      for (const p of computePlacements({ density })) {
        expect(isWater(p.x, p.z), `${p.kind} at density ${density}`).toBe(false);
      }
    }
  });
});

describe('shoreline reeds', () => {
  it('are plentiful, dry, and hug the water they line', () => {
    const reeds = kindsOf(shipped(), 'reed');
    expect(reeds.length).toBeGreaterThan(40);
    for (const r of reeds) {
      expect(isWater(r.x, r.z), `reed at ${r.x.toFixed(1)},${r.z.toFixed(1)}`).toBe(false);
      expect(
        distanceToWater(r.x, r.z),
        `reed at ${r.x.toFixed(1)},${r.z.toFixed(1)}`,
      ).toBeLessThan(1.8);
    }
  });

  it('reach every water body, not just the lake', () => {
    const reeds = kindsOf(shipped(), 'reed');
    // The four ponds and the lake (whose island shore gets its own fringe).
    for (const [x, z] of [
      [26, 28],
      [6, -27],
      [-12, 31],
      [36, -8],
      [-40, -14],
    ] as const) {
      const near = reeds.filter((r) => Math.hypot(r.x - x, r.z - z) < 24);
      expect(near.length, `reeds near ${x},${z}`).toBeGreaterThan(2);
    }
  });

  it('scale with the density slider, and zero means none', () => {
    const count = (mult: number): number =>
      kindsOf(computePlacements({ kindDensity: { reed: mult } }), 'reed').length;
    expect(count(0)).toBe(0);
    expect(count(0.5)).toBeLessThan(count(1));
    expect(count(1)).toBeLessThanOrEqual(count(2));
    // Global density scales them too.
    expect(kindsOf(computePlacements({ density: 0 }), 'reed')).toHaveLength(0);
  });

  it('carry no collider and no shadow — they are ink marks, like the grass', () => {
    const scatter = createScatter();
    try {
      // positions() is the prop surface (colliders, minimap, affordances):
      // reeds are not in it.
      expect(scatter.positions().some((p) => (p.kind as string) === 'reed')).toBe(false);
      // …but they are drawn, in their own outliner row.
      const reeds = scatter.group.getObjectByName('reeds');
      expect(reeds).toBeDefined();
      expect(reeds!.children.length).toBeGreaterThan(0);
    } finally {
      scatter.dispose();
    }
  });
});

describe('the forest is a forest', () => {
  it('grows trees an order of magnitude denser than the open plain', () => {
    const placements = shipped();
    const wooded = placements.filter((p) => p.kind === 'tree' || p.kind === 'conifer');

    const inForest = wooded.filter((p) => sampleLandscape(p.x, p.z).forest >= 0.8);
    const forestArea = areaWhere(-60, 20, -20, 60, (x, z) => sampleLandscape(x, z).forest >= 0.8);

    // The plain sample: an annulus around the origin, outside the hatch
    // clearing and clear of every feature.
    const openPlain = (x: number, z: number): boolean => {
      const d = Math.hypot(x, z);
      if (d < 14 || d > 30) return false;
      const l = sampleLandscape(x, z);
      return l.forest === 0 && l.mountain === 0 && !l.island && !l.water;
    };
    const inPlain = wooded.filter((p) => openPlain(p.x, p.z));
    const plainArea = areaWhere(-30, 30, -30, 30, openPlain);

    expect(forestArea).toBeGreaterThan(200);
    expect(plainArea).toBeGreaterThan(200);
    expect(inForest.length).toBeGreaterThan(20);

    const forestDensity = inForest.length / forestArea;
    const plainDensity = inPlain.length / plainArea;
    expect(forestDensity / plainDensity).toBeGreaterThan(8);
  });
});

describe('the mountain range', () => {
  const mountains = (ps = shipped()): Placement[] => kindsOf(ps, 'mountain');

  it('places a range, capped, only where the map says mountain', () => {
    const mts = mountains();
    expect(mts.length).toBeGreaterThanOrEqual(6);
    expect(mts.length).toBeLessThanOrEqual(MOUNTAIN_MAX);
    for (const m of mts) {
      expect(
        sampleLandscape(m.x, m.z).mountain,
        `mountain at ${m.x.toFixed(1)},${m.z.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(0.35);
      expect(m.variant).toBeLessThan(PROP_VARIANT_COUNTS.mountain);
    }
    // Every authored variant gets used somewhere in the range.
    expect(new Set(mts.map((m) => m.variant)).size).toBe(PROP_VARIANT_COUNTS.mountain);
  });

  it('sweeps its own ground clear — nothing else stands on a mountain', () => {
    const all = shipped();
    const mts = mountains(all);
    for (const p of all) {
      if (p.kind === 'mountain') continue;
      for (const m of mts) {
        const r = MOUNTAIN_FOOTPRINT[m.variant]! * m.scale * MOUNTAIN_CLEAR_FIT;
        expect(
          Math.hypot(p.x - m.x, p.z - m.z),
          `${p.kind} inside the mountain at ${m.x.toFixed(1)},${m.z.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(r);
      }
    }
  });

  it('survives creature exclusions — landscape does not blink out', () => {
    const all = shipped();
    const mts = mountains(all);
    expect(mts.length).toBeGreaterThan(0);
    // An exclusion circle centered on every mountain, generous enough to
    // swallow it whole.
    const exclusions = mts.map((m) => ({ x: m.x, z: m.z, r: 30 }));
    const kept = filterExcluded(all, exclusions);
    expect(kindsOf(kept, 'mountain')).toEqual(mts);
    // …while everything else inside those circles is gone, as before.
    for (const p of kept) {
      if (p.kind === 'mountain') continue;
      for (const e of exclusions) {
        expect(Math.hypot(p.x - e.x, p.z - e.z)).toBeGreaterThanOrEqual(e.r);
      }
    }
  });

  it('is rigid, paper-light, and stamps no shadow', () => {
    const scatter = createScatter();
    try {
      const meshes: InstancedMesh[] = [];
      scatter.group.traverse((o) => {
        if (o instanceof InstancedMesh && o.name.startsWith('mountain-')) meshes.push(o);
      });
      expect(meshes.length).toBeGreaterThan(0);
      const stump = scatter.group.getObjectByName('stumps')!.children[0] as InstancedMesh;
      for (const mesh of meshes) {
        // The LIGHT paper albedo the ink pass draws over — shared with the
        // other rigid built kinds, never the mid-tone stone material.
        expect((mesh.material as MeshStandardMaterial).color.getHexString()).toBe(
          WORLD.light.slice(1),
        );
        expect(mesh.material as Material).toBe(stump.material as Material);
        // Rigid: no wind height attribute, so nothing to bend.
        expect(mesh.geometry.getAttribute('aWindHeight'), mesh.name).toBeUndefined();
      }
      // No stamp: a mountain's footprint is past SHADOW_MAX_RADIUS at every
      // instance scale the placement can roll (0.7–1.3), so the existing
      // shadow filter drops it. A hard flat ellipse under a landmass would
      // read as a hole in the ground.
      for (const p of scatter.positions()) {
        if (p.kind !== 'mountain') continue;
        expect(p.r * SHADOW_FIT).toBeGreaterThan(SHADOW_MAX_RADIUS);
      }
      for (let v = 0; v < MOUNTAIN_FOOTPRINT.length; v++) {
        const smallest = MOUNTAIN_FOOTPRINT[v]! * 0.7 * SHADOW_FIT;
        expect(smallest, `mountain variant ${v} at the smallest scale`).toBeGreaterThan(
          SHADOW_MAX_RADIUS * 0.95,
        );
      }
    } finally {
      scatter.dispose();
    }
  });

  it('blocks like a mountain: one hard collider at its base extent', () => {
    const scatter = createScatter();
    try {
      const props = scatter.positions();
      const colliders = scatter.colliders();
      props.forEach((p, i) => {
        if (p.kind !== 'mountain') return;
        expect(colliders[i]!.hard).toBe(true);
        // Grounded kinds block at the built footprint, not a trunk circle.
        expect(colliders[i]!.r).toBeCloseTo(p.r, 9);
        expect(colliders[i]!.r).toBeGreaterThan(4);
      });
      expect(props.some((p) => p.kind === 'mountain')).toBe(true);
    } finally {
      scatter.dispose();
    }
  });
});

describe('the island', () => {
  const onIsland = (p: Placement): boolean => sampleLandscape(p.x, p.z).island;

  it('grows its own flora and nothing built', () => {
    const island = shipped().filter(onIsland);
    expect(island.filter((p) => p.kind === 'palm').length).toBeGreaterThanOrEqual(3);
    for (const kind of ['building', 'waterTower', 'cactus', 'picnicTable'] as const) {
      expect(island.filter((p) => p.kind === kind), `${kind} on the island`).toHaveLength(0);
    }
  });
});

describe('the plain is the world that shipped', () => {
  /** Deep plain: no feature weight at all, and far enough from every shore
   * that the cell which seeded it cannot have been inside the shore
   * keep-out either. Everything in here rolled exactly the pre-map
   * expression, so it must be byte-identical to the pre-map output. */
  function deepPlain(p: Placement): boolean {
    const l = sampleLandscape(p.x, p.z);
    if (l.forest !== 0 || l.mountain !== 0 || l.island || l.water) return false;
    for (let r = 1; r <= 13; r += 0.5) {
      for (let a = 0; a < 24; a++) {
        const th = (a / 24) * Math.PI * 2;
        if (isWater(p.x + Math.cos(th) * r, p.z + Math.sin(th) * r)) return false;
      }
    }
    return true;
  }

  const key = (p: Placement): string =>
    `${p.kind}:${p.variant}:${p.x.toFixed(4)}:${p.z.toFixed(4)}:${p.scale.toFixed(4)}:${p.rotY.toFixed(4)}`;

  /** fnv-1a, 32 bit — a stable digest, not a hash with any other job. */
  function digest(parts: string[]): string {
    let h = 0x811c9dc5;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // Fixture taken from `computePlacements()` on the PRE-map code (the commit
  // before landscape.ts existed), filtered by deepPlain above. If this moves,
  // the map has leaked into ground it was never supposed to touch.
  const PLAIN_COUNT = 831;
  const PLAIN_DIGEST = 'a9eac96d';

  it('places exactly what it placed before the map existed', () => {
    const plain = shipped().filter(deepPlain).map(key);
    expect(plain).toHaveLength(PLAIN_COUNT);
    expect(digest(plain)).toBe(PLAIN_DIGEST);
  });

  it('is untouched around the hatch clearing, placement for placement', () => {
    // The readable half of the same fixture: the disc the creatures spawn
    // into, spelled out rather than digested.
    const disc = shipped()
      .filter((p) => Math.hypot(p.x, p.z) <= 14)
      .map(key);
    expect(disc).toEqual([
      'tick:0:1.3146:7.1223:0.8188:3.3447',
      'tick:0:-4.8633:9.7157:1.2596:2.7263',
      'tick:0:-8.4336:9.1790:0.9504:5.2106',
      'tick:0:10.3971:2.5703:1.0100:1.5532',
    ]);
  });

  it('stays cheap enough to run on a slider drag', () => {
    // Warm the module (first call pays for the shoreline polygons).
    computePlacements();
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) computePlacements({ density: 1 + i * 0.05 });
    const each = (performance.now() - t0) / 3;
    expect(each).toBeLessThan(150);
  });
});
