/**
 * Landscape tests — pure geography. No WebGL, no DOM.
 *
 * The module is a contract several other systems read (scatter, physics, the
 * water renderer, the minimap), so these pin the guarantees they rely on:
 * determinism, the origin clearing staying open plain, water/island being a
 * hard partition, and the derived outputs (colliders, shores, ripples) all
 * agreeing with `isWater` rather than drifting from it.
 */

import { describe, expect, it } from 'vitest';
import {
  FOREST_BLOBS,
  FOREST_FALLOFF,
  ISLAND_OUTLINE_POINTS,
  isWater,
  islandOutline,
  MOUNTAIN_BLOBS,
  MOUNTAIN_FALLOFF,
  OUTLINE_POINTS,
  RIPPLE_MARGIN,
  rippleSpots,
  sampleLandscape,
  shoreSamples,
  waterColliders,
  waterFillOutline,
  waterOutline,
  WATER_BODIES,
  WOBBLE_MAX,
  wobbledRadius,
  type Blob,
  type WaterBody,
} from '../../src/world/landscape';

/** The hatch clearing scatter also keeps open (ORIGIN_CLEAR_PROPS). */
const ORIGIN_CLEAR = 11;
/** Scatter's half-extent plus slack — nothing authored may leave the region. */
const REGION_LIMIT = 110;

const LAKE: WaterBody = WATER_BODIES[0]!;
const PONDS: readonly WaterBody[] = WATER_BODIES.slice(1);

/** Every authored feature as a plain blob (water bodies use their outer r). */
const ALL_BLOBS: Blob[] = [
  ...FOREST_BLOBS,
  ...MOUNTAIN_BLOBS,
  ...WATER_BODIES.map((b) => ({ x: b.x, z: b.z, r: b.r, seed: b.seed })),
];

/**
 * Probe points that sit outside EVERY blob in a set (its blobs overlap, and
 * the weight is a max over them, so "far from one" is not far enough).
 */
function farProbes(blobs: readonly Blob[], falloff: number): [number, number][] {
  const out: [number, number][] = [];
  for (const b of blobs) {
    const far = b.r * WOBBLE_MAX + falloff + 5;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = b.x + Math.cos(a) * far;
      const z = b.z + Math.sin(a) * far;
      const covered = blobs.some(
        (o) => Math.hypot(x - o.x, z - o.z) <= o.r * WOBBLE_MAX + falloff,
      );
      if (!covered) out.push([x, z]);
    }
  }
  return out;
}

/** Points evenly around a blob's wobbled edge. */
function edgePoints(b: Blob, n = 512): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = wobbledRadius(b, t);
    out.push([b.x + Math.cos(t) * r, b.z + Math.sin(t) * r]);
  }
  return out;
}

describe('landscape — determinism', () => {
  it('samples identically on repeat calls', () => {
    for (let i = 0; i < 200; i++) {
      const x = -100 + (i * 137) % 200;
      const z = -100 + (i * 61) % 200;
      expect(sampleLandscape(x, z)).toEqual(sampleLandscape(x, z));
    }
  });

  it('derives identical outlines, colliders, shores and ripples every call', () => {
    expect(waterOutline(LAKE)).toEqual(waterOutline(LAKE));
    expect(islandOutline(LAKE)).toEqual(islandOutline(LAKE));
    expect(waterColliders()).toEqual(waterColliders());
    for (const body of WATER_BODIES) {
      expect(shoreSamples(body)).toEqual(shoreSamples(body));
      expect(rippleSpots(body)).toEqual(rippleSpots(body));
    }
  });

  it('allocates a fresh collider array each call', () => {
    expect(waterColliders()).not.toBe(waterColliders());
  });

  it('wobbles every edge — no feature is a circle', () => {
    for (const b of ALL_BLOBS) {
      const radii = edgePoints(b, 128).map(([x, z]) => Math.hypot(x - b.x, z - b.z));
      const spread = Math.max(...radii) - Math.min(...radii);
      expect(spread).toBeGreaterThan(b.r * 0.05);
      expect(Math.max(...radii)).toBeLessThanOrEqual(b.r * WOBBLE_MAX + 1e-9);
    }
  });
});

describe('landscape — the origin clearing stays open plain', () => {
  it('reports plain and dry at the origin', () => {
    expect(sampleLandscape(0, 0)).toEqual({
      forest: 0,
      mountain: 0,
      water: false,
      island: false,
      region: 'plain',
    });
  });

  it('keeps every authored feature edge outside the clearing', () => {
    for (const b of ALL_BLOBS) {
      for (const [x, z] of edgePoints(b)) {
        expect(Math.hypot(x, z)).toBeGreaterThan(ORIGIN_CLEAR);
      }
    }
  });

  it('leaves the whole clearing plain, dry and unweighted', () => {
    for (let i = 0; i <= 110; i++) {
      for (let j = 0; j <= 110; j++) {
        const x = -ORIGIN_CLEAR + i * 0.2;
        const z = -ORIGIN_CLEAR + j * 0.2;
        if (x * x + z * z > ORIGIN_CLEAR * ORIGIN_CLEAR) continue;
        const s = sampleLandscape(x, z);
        expect(s.water).toBe(false);
        expect(s.island).toBe(false);
        expect(s.region).toBe('plain');
        expect(s.forest).toBeLessThan(0.05);
        expect(s.mountain).toBeLessThan(0.05);
      }
    }
  });

  it('keeps every feature inside the scattered region', () => {
    for (const b of ALL_BLOBS) {
      for (const [x, z] of edgePoints(b)) {
        expect(Math.abs(x)).toBeLessThan(REGION_LIMIT);
        expect(Math.abs(z)).toBeLessThan(REGION_LIMIT);
      }
    }
  });
});

describe('landscape — soft weights', () => {
  it('reads full forest at each forest blob center and none far away', () => {
    for (const b of FOREST_BLOBS) {
      const s = sampleLandscape(b.x, b.z);
      expect(s.forest).toBeCloseTo(1, 6);
      expect(s.region).toBe('forest');
    }
    // Well beyond every blob's reach plus its falloff.
    const probes = farProbes(FOREST_BLOBS, FOREST_FALLOFF);
    expect(probes.length).toBeGreaterThan(8);
    for (const [x, z] of probes) expect(sampleLandscape(x, z).forest).toBe(0);
  });

  it('reads full mountain at each mountain blob center and none far away', () => {
    for (const b of MOUNTAIN_BLOBS) {
      const s = sampleLandscape(b.x, b.z);
      expect(s.mountain).toBeCloseTo(1, 6);
      expect(s.region).toBe('mountain');
    }
    const probes = farProbes(MOUNTAIN_BLOBS, MOUNTAIN_FALLOFF);
    expect(probes.length).toBeGreaterThan(8);
    for (const [x, z] of probes) expect(sampleLandscape(x, z).mountain).toBe(0);
  });

  it('stays inside 0–1 and never grows anything on water or island', () => {
    for (let x = -110; x <= 110; x += 3.5) {
      for (let z = -110; z <= 110; z += 3.5) {
        const s = sampleLandscape(x, z);
        expect(s.forest).toBeGreaterThanOrEqual(0);
        expect(s.forest).toBeLessThanOrEqual(1);
        expect(s.mountain).toBeGreaterThanOrEqual(0);
        expect(s.mountain).toBeLessThanOrEqual(1);
        if (s.water || s.island) {
          expect(s.forest).toBe(0);
          expect(s.mountain).toBe(0);
        }
        if (s.water) expect(s.region).toBe('water');
        else if (s.island) expect(s.region).toBe('island');
      }
    }
  });
});

describe('landscape — water bodies', () => {
  it('puts the lake first, then the ponds', () => {
    expect(LAKE.kind).toBe('lake');
    expect(LAKE.island).toBeDefined();
    expect(LAKE.isthmus).toBeDefined();
    for (const p of PONDS) {
      expect(p.kind).toBe('pond');
      expect(p.island).toBeUndefined();
    }
  });

  it('holds water at every pond center', () => {
    for (const p of PONDS) {
      const s = sampleLandscape(p.x, p.z);
      expect(s.water).toBe(true);
      expect(s.island).toBe(false);
      expect(s.region).toBe('water');
    }
  });

  it('makes the lake center island, not water', () => {
    const s = sampleLandscape(LAKE.x, LAKE.z);
    expect(s.water).toBe(false);
    expect(s.island).toBe(true);
    expect(s.region).toBe('island');
  });

  it('leaves the land bridge walkable and the far side of the ring wet', () => {
    const isl = LAKE.island!;
    const ist = LAKE.isthmus!;
    const rm = (LAKE.r + isl.r) / 2;
    const ringHalf = (LAKE.r - isl.r) / 2;
    for (const d of [rm - ringHalf * 0.5, rm, rm + ringHalf * 0.5]) {
      const bx = LAKE.x + Math.cos(ist.angle) * d;
      const bz = LAKE.z + Math.sin(ist.angle) * d;
      expect(sampleLandscape(bx, bz).region).toBe('island');
      const ox = LAKE.x + Math.cos(ist.angle + Math.PI) * d;
      const oz = LAKE.z + Math.sin(ist.angle + Math.PI) * d;
      expect(sampleLandscape(ox, oz).region).toBe('water');
    }
  });

  it('points the land bridge back at the origin', () => {
    const ist = LAKE.isthmus!;
    expect(ist.angle).toBeCloseTo(Math.atan2(-LAKE.z, -LAKE.x), 12);
  });

  it('grows every body with a positive pad and shrinks it with a negative one', () => {
    for (const body of WATER_BODIES) {
      let checked = 0;
      for (const [x, z] of waterOutline(body, 64)) {
        const dx = x - body.x;
        const dz = z - body.z;
        const d = Math.hypot(dx, dz);
        const at = (rr: number): [number, number] => [
          body.x + (dx / d) * rr,
          body.z + (dz / d) * rr,
        ];
        const [ix, iz] = at(d - 0.3);
        // Only where this really is a shoreline — the land bridge gap has dry
        // ground on both sides of the outline and is not one.
        if (!isWater(ix, iz)) continue;
        checked++;
        const [ox, oz] = at(d + 0.5);
        expect(isWater(ox, oz)).toBe(false);
        expect(isWater(ox, oz, 1.5)).toBe(true);
        expect(isWater(ix, iz, -1.5)).toBe(false);
      }
      expect(checked).toBeGreaterThan(32);
    }
  });

  it('keeps the bodies disjoint', () => {
    for (let i = 0; i < WATER_BODIES.length; i++) {
      for (let j = i + 1; j < WATER_BODIES.length; j++) {
        const a = WATER_BODIES[i]!;
        const b = WATER_BODIES[j]!;
        const gap = Math.hypot(a.x - b.x, a.z - b.z) - (a.r + b.r) * WOBBLE_MAX;
        expect(gap).toBeGreaterThan(0);
      }
    }
  });
});

describe('landscape — outlines', () => {
  it('returns the requested point count, unrepeated, finite', () => {
    for (const body of WATER_BODIES) {
      const outer = waterOutline(body);
      expect(outer).toHaveLength(OUTLINE_POINTS);
      const custom = waterOutline(body, 24);
      expect(custom).toHaveLength(24);
      for (const [x, z] of outer) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(z)).toBe(true);
      }
      const first = outer[0]!;
      const last = outer[outer.length - 1]!;
      expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeGreaterThan(0);
    }
  });

  it('closes the loop with an even step and winds counter-clockwise', () => {
    for (const body of WATER_BODIES) {
      const poly = waterOutline(body);
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        area += a[0] * b[1] - b[0] * a[1];
        // Consecutive points stay close: the ring never jumps.
        expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(body.r);
      }
      expect(area).toBeGreaterThan(0);
    }
  });

  it('gives the lake an island shoreline and the ponds none', () => {
    const isl = islandOutline(LAKE);
    expect(isl).not.toBeNull();
    expect(isl).toHaveLength(ISLAND_OUTLINE_POINTS);
    expect(islandOutline(LAKE, 12)).toHaveLength(12);
    for (const [x, z] of isl!) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
      // The island shore sits inside the lake's outer shore.
      expect(Math.hypot(x - LAKE.x, z - LAKE.z)).toBeLessThan(LAKE.r);
    }
    for (const p of PONDS) expect(islandOutline(p)).toBeNull();
  });
});

describe('landscape — water fill outline', () => {
  const TAU = Math.PI * 2;
  const wrapToPi = (a: number): number => a - TAU * Math.round(a / TAU);
  const shoelace = (poly: readonly [number, number][]): number => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  /** Proper crossing of two open segments (shared endpoints do not count). */
  const crosses = (
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
  ): boolean => {
    const side = (o: readonly number[], p: readonly number[], q: readonly number[]): number =>
      (p[0]! - o[0]!) * (q[1]! - o[1]!) - (p[1]! - o[1]!) * (q[0]! - o[0]!);
    const d1 = side(c, d, a);
    const d2 = side(c, d, b);
    const d3 = side(a, b, c);
    const d4 = side(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };

  it('is exactly the outer outline for a pond — a pond is a disc of water', () => {
    for (const pond of PONDS) {
      expect(waterFillOutline(pond)).toEqual(waterOutline(pond));
      expect(waterFillOutline(pond, 24)).toEqual(waterOutline(pond, 24));
    }
  });

  it('puts every lake point on a wobbled edge — the outer shore or the island', () => {
    const isl = { x: LAKE.x, z: LAKE.z, r: LAKE.island!.r, seed: LAKE.island!.seed };
    for (const [x, z] of waterFillOutline(LAKE)) {
      const theta = Math.atan2(z - LAKE.z, x - LAKE.x);
      const d = Math.hypot(x - LAKE.x, z - LAKE.z);
      const onOuter = Math.abs(d - wobbledRadius(LAKE, theta)) < 1e-9;
      const onIsland = Math.abs(d - wobbledRadius(isl, theta)) < 1e-9;
      expect(onOuter || onIsland).toBe(true);
    }
  });

  it('cuts the land bridge out — no fill point sits in the isthmus wedge', () => {
    const ist = LAKE.isthmus!;
    // The bridge's half-width wobbles ±15% around its authored half-angle, so
    // "outside the wedge at its own radius" implies at least 0.85 of it.
    const floor = ist.halfAngle * 0.85;
    for (const [x, z] of waterFillOutline(LAKE)) {
      const theta = Math.atan2(z - LAKE.z, x - LAKE.x);
      expect(Math.abs(wrapToPi(theta - ist.angle))).toBeGreaterThanOrEqual(floor);
    }
    // And the bridge is genuinely dry land inside the ring: both rings are
    // sampled at the full budget, and both lose their bridge run.
    expect(waterFillOutline(LAKE).length).toBeLessThan(2 * OUTLINE_POINTS);
  });

  it('traces one simple closed polygon — a c, not a ring with a hole', () => {
    const poly = waterFillOutline(LAKE);
    const n = poly.length;
    // Closed by convention: the last point is NOT the first one repeated.
    expect(poly[0]).not.toEqual(poly[n - 1]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if ((j + 1) % n === i || (i + 1) % n === j) continue;
        expect(
          crosses(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!),
          `segments ${i} and ${j} cross`,
        ).toBe(false);
      }
    }
  });

  it('winds counter-clockwise and encloses the ring minus the land bridge', () => {
    const fill = shoelace(waterFillOutline(LAKE));
    const ring = shoelace(waterOutline(LAKE)) - shoelace(islandOutline(LAKE)!);
    expect(fill).toBeGreaterThan(0);
    // Strictly less than the whole ring: the bridge is missing from it.
    expect(fill).toBeLessThan(ring);
    // And it matches the water isWater actually reports, sampled on a grid —
    // the fill agrees with the geography instead of drifting from it.
    const reach = LAKE.r * WOBBLE_MAX + 1;
    const step = 0.1;
    let cells = 0;
    for (let x = LAKE.x - reach; x <= LAKE.x + reach; x += step) {
      for (let z = LAKE.z - reach; z <= LAKE.z + reach; z += step) if (isWater(x, z)) cells++;
    }
    const measured = cells * step * step;
    // Chords cut a hair inside every wobble, so the polygon runs slightly small.
    expect(fill / measured).toBeGreaterThan(0.95);
    expect(fill / measured).toBeLessThan(1.02);
  });

  it('is deterministic and honours the requested point budget', () => {
    expect(waterFillOutline(LAKE)).toEqual(waterFillOutline(LAKE));
    const coarse = waterFillOutline(LAKE, 32);
    expect(coarse.length).toBeGreaterThan(3);
    expect(coarse.length).toBeLessThan(64);
  });
});

describe('landscape — colliders', () => {
  it('gives each pond one hard circle and the lake a ring', () => {
    const cols = waterColliders();
    expect(cols.length).toBeGreaterThan(WATER_BODIES.length);
    for (const c of cols) {
      expect(c.hard).toBe(true);
      expect(c.r).toBeGreaterThan(0);
    }
    for (const p of PONDS) {
      const own = cols.filter((c) => c.x === p.x && c.z === p.z);
      expect(own).toHaveLength(1);
      expect(own[0]!.r).toBe(p.r);
    }
  });

  it('centers every collider on water', () => {
    for (const c of waterColliders()) expect(isWater(c.x, c.z)).toBe(true);
  });

  it('leaves the land bridge physically open', () => {
    const cols = waterColliders();
    const isl = LAKE.island!;
    const ist = LAKE.isthmus!;
    const rm = (LAKE.r + isl.r) / 2;
    const ringHalf = (LAKE.r - isl.r) / 2;
    for (const d of [rm - ringHalf * 0.5, rm, rm + ringHalf * 0.5]) {
      const x = LAKE.x + Math.cos(ist.angle) * d;
      const z = LAKE.z + Math.sin(ist.angle) * d;
      for (const c of cols) {
        expect(Math.hypot(x - c.x, z - c.z)).toBeGreaterThan(c.r);
      }
    }
  });

  it('overlaps neighboring ring circles so nothing squeezes through', () => {
    const isl = LAKE.island!;
    const rm = (LAKE.r + isl.r) / 2;
    const ring = waterColliders().filter(
      (c) => Math.abs(Math.hypot(c.x - LAKE.x, c.z - LAKE.z) - rm) < 1e-6,
    );
    expect(ring.length).toBeGreaterThan(8);
    // Every ring circle has a neighbor it overlaps (the bridge gap aside).
    let overlapping = 0;
    for (const a of ring) {
      for (const b of ring) {
        if (a === b) continue;
        if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r) {
          overlapping++;
          break;
        }
      }
    }
    expect(overlapping).toBe(ring.length);
  });
});

describe('landscape — shore samples', () => {
  it('lands every sample on dry ground beside water, with a unit normal', () => {
    for (const body of WATER_BODIES) {
      const samples = shoreSamples(body);
      expect(samples.length).toBeGreaterThan(8);
      for (const s of samples) {
        expect(isWater(s.x, s.z)).toBe(false);
        expect(Math.hypot(s.nx, s.nz)).toBeCloseTo(1, 9);
        // Water is close by, back along the normal — this is a shoreline, not
        // a point stranded in the land-bridge gap.
        let near = Infinity;
        for (let t = 0.05; t <= 1.5; t += 0.025) {
          if (isWater(s.x - s.nx * t, s.z - s.nz * t)) {
            near = t;
            break;
          }
        }
        expect(near).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('spaces samples at roughly the requested arc length', () => {
    const tight = shoreSamples(LAKE, 1.1);
    const loose = shoreSamples(LAKE, 4.4);
    expect(tight.length).toBeGreaterThan(loose.length * 2);
  });

  it('covers the island shore too, with normals pointing at the island', () => {
    const samples = shoreSamples(LAKE);
    const isl = LAKE.island!;
    const inner = samples.filter(
      (s) => Math.hypot(s.x - LAKE.x, s.z - LAKE.z) < isl.r * WOBBLE_MAX + 0.5,
    );
    expect(inner.length).toBeGreaterThan(8);
    for (const s of inner) {
      const dot = (s.x - LAKE.x) * s.nx + (s.z - LAKE.z) * s.nz;
      expect(dot).toBeLessThan(0);
    }
  });

  it('skips the land bridge gap on both rings', () => {
    const ist = LAKE.isthmus!;
    for (const s of shoreSamples(LAKE)) {
      const a = Math.atan2(s.z - LAKE.z, s.x - LAKE.x);
      const delta = Math.abs(Math.atan2(Math.sin(a - ist.angle), Math.cos(a - ist.angle)));
      // Nothing on the bridge centerline; the pushed samples sit at its edges.
      expect(delta).toBeGreaterThan(ist.halfAngle * 0.5);
    }
  });
});

describe('landscape — ripple spots', () => {
  it('keeps every mark in the water and clear of every shore', () => {
    for (const body of WATER_BODIES) {
      const spots = rippleSpots(body);
      const shores = [waterOutline(body, 512), islandOutline(body, 512)].filter(
        (p): p is [number, number][] => p !== null,
      );
      for (const s of spots) {
        expect(isWater(s.x, s.z)).toBe(true);
        expect(isWater(s.x, s.z, -RIPPLE_MARGIN)).toBe(true);
        // The margin is applied radially, so the true clearance to a wobbled
        // shore is a little under it — but never close to zero.
        let minD = Infinity;
        for (const poly of shores) {
          for (const [x, z] of poly) minD = Math.min(minD, Math.hypot(s.x - x, s.z - z));
        }
        expect(minD).toBeGreaterThan(RIPPLE_MARGIN * 0.75);
      }
    }
  });

  it('scatters the lake with marks and gives each one a rotation and a length', () => {
    const spots = rippleSpots(LAKE);
    expect(spots.length).toBeGreaterThan(6);
    for (const s of spots) {
      expect(s.rot).toBeGreaterThanOrEqual(0);
      expect(s.rot).toBeLessThan(Math.PI * 2);
      expect(s.len).toBeGreaterThanOrEqual(0.6);
      expect(s.len).toBeLessThanOrEqual(1.4);
    }
  });

  it('honors a wider margin by emptying the small ponds first', () => {
    for (const body of WATER_BODIES) {
      expect(rippleSpots(body, 6).length).toBeLessThanOrEqual(rippleSpots(body).length);
    }
    expect(rippleSpots(LAKE, 12)).toHaveLength(0);
  });
});
