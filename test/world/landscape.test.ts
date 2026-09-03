/**
 * Landscape tests — pure geography. No WebGL, no DOM.
 *
 * The module is a contract several other systems read (scatter, physics, the
 * water renderer, the minimap), so these pin the guarantees they rely on:
 * determinism, the origin clearing staying open plain, water/island being a
 * hard partition, and the derived outputs (colliders, shores, ripples) all
 * agreeing with `isWater` rather than drifting from it.
 */

import { afterEach, describe, expect, it } from 'vitest';
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
  setTerrainParams,
  TERRAIN,
  TERRAIN_DEFAULTS,
  TERRAIN_LIMITS,
  terrainHeight,
  terrainNormal,
  terrainParams,
  waterColliders,
  WATER_COLLIDER_R,
  waterLevel,
  waterOutline,
  WATER_BODIES,
  WOBBLE_MAX,
  wobbledRadius,
  type Blob,
  type WaterBody,
} from '../../src/world/landscape';

/** The hatch clearing scatter also keeps open (ORIGIN_CLEAR_PROPS). */
const ORIGIN_CLEAR = 11;
/**
 * …and the clearing the SPREAD-OUT layout keeps: with the features pushed
 * out to the edges of the field (2026-09-03), no feature edge comes within
 * this of the origin, so the hatch ground has a real horizon around it.
 */
const FEATURE_CLEAR = 40;
/**
 * Scatter's half-extent (160) minus slack — nothing authored may leave the
 * region. 155, not 110: the field scaled up and the range runs along the
 * north edge, where the (-5, -118) mass reaches z ≈ -147 at full wobble.
 */
const REGION_LIMIT = 155;
/** Open plain the layout keeps between any two distinct environments,
 * measured edge to edge on 1.2 × the authored radius. */
const ENVIRONMENT_GAP = 20;

const LAKE: WaterBody = WATER_BODIES[0]!;
const PONDS: readonly WaterBody[] = WATER_BODIES.slice(1);
/** The island as the blob it is — its own centre, not the lake's. */
const ISLAND: Blob = LAKE.island!;

/** Units of open water crossed walking out from the island's shore on one
 * bearing, until the far shore. */
function crossing(theta: number): number {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const from = wobbledRadius(ISLAND, theta);
  let to = from;
  for (let d = from + 0.05; d < from + 80; d += 0.05) {
    if (!isWater(ISLAND.x + cos * d, ISLAND.z + sin * d)) break;
    to = d;
  }
  return to - from;
}
/** The water the layout keeps between the island's edge and the lake's, at
 * every angle: an island whose arm reached the far shore would be a headland
 * again. */
const ISLAND_CLEARANCE = 6;

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

  it('makes the island center island', () => {
    const on = sampleLandscape(ISLAND.x, ISLAND.z);
    expect(on.water).toBe(false);
    expect(on.island).toBe(true);
    expect(on.region).toBe('island');
  });

  it('sits the island off-centre, back toward the origin', () => {
    const off = Math.hypot(ISLAND.x - LAKE.x, ISLAND.z - LAKE.z);
    // Far enough off-centre to read as placed, not enough to touch a shore:
    // roughly a quarter of the lake's radius.
    expect(off).toBeGreaterThan(LAKE.r * 0.15);
    expect(off).toBeLessThan(LAKE.r * 0.45);
    // …and toward the origin, so the viewer coming from the hatch clearing
    // sees water IN FRONT of the island as well as behind it — a centred
    // island draws a donut, not a lake. Measured: 15.9 units of water on the
    // near crossing against 41.3 on the far one.
    expect(Math.hypot(ISLAND.x, ISLAND.z)).toBeLessThan(Math.hypot(LAKE.x, LAKE.z));
    const near = crossing(Math.atan2(-ISLAND.z, -ISLAND.x));
    const far = crossing(Math.atan2(-ISLAND.z, -ISLAND.x) + Math.PI);
    expect(near).toBeGreaterThan(ISLAND_CLEARANCE);
    expect(far).toBeGreaterThan(near * 1.5);
  });

  it('keeps water all the way round the island — no causeway, at any angle', () => {
    // Measured minimum: 7.9 units of water from the island's wobbled edge to
    // the lake's, over 720 angles. Nothing joins the island to the shore.
    let worst = Infinity;
    const outer = edgePoints(LAKE, 2048);
    for (const [px, pz] of edgePoints(ISLAND, 720)) {
      let near = Infinity;
      for (const [x, z] of outer) near = Math.min(near, Math.hypot(px - x, pz - z));
      worst = Math.min(worst, near);
    }
    expect(worst).toBeGreaterThanOrEqual(ISLAND_CLEARANCE);
  });

  it('holds water on every bearing out of the island', () => {
    // Walk out from the island's shore along 36 bearings: every one of them
    // crosses water before it leaves the lake. A causeway would be a bearing
    // that never got wet. Measured: 8.5 units at the narrowest, 44.7 at the
    // widest.
    for (let k = 0; k < 36; k++) {
      const th = (k / 36) * Math.PI * 2;
      expect(crossing(th), `bearing ${th.toFixed(2)}`).toBeGreaterThan(ISLAND_CLEARANCE);
    }
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
        // Every point of an outer outline is a shoreline now (nothing
        // interrupts the ring), but the probe is kept: it is what makes the
        // assertions below meaningful rather than vacuous.
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
    let area = 0;
    for (let i = 0; i < isl!.length; i++) {
      const [x, z] = isl![i]!;
      const [qx, qz] = isl![(i + 1) % isl!.length]!;
      area += x * qz - qx * z;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
      // Walked around the ISLAND's own centre, not the lake's.
      const onEdge =
        Math.hypot(x - ISLAND.x, z - ISLAND.z) -
        wobbledRadius(ISLAND, Math.atan2(z - ISLAND.z, x - ISLAND.x));
      expect(Math.abs(onEdge)).toBeLessThan(1e-9);
      // …and well inside the lake's outer shore.
      expect(Math.hypot(x - LAKE.x, z - LAKE.z)).toBeLessThan(LAKE.r);
    }
    // Counter-clockwise, like the outer one: the water renderer flips the
    // pen's water side per ring and relies on both winding the same way.
    expect(area).toBeGreaterThan(0);
    for (const p of PONDS) expect(islandOutline(p)).toBeNull();
  });
});

describe('landscape — the polygons the water is drawn from', () => {
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
  const simple = (poly: readonly [number, number][]): void => {
    const n = poly.length;
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
  };

  it('traces two simple closed rings for the lake, one for a pond', () => {
    simple(waterOutline(LAKE));
    simple(islandOutline(LAKE)!);
    for (const pond of PONDS) simple(waterOutline(pond));
  });

  it('never lets the two rings touch — the water is a ring of open water', () => {
    // The fill is the outer polygon with the island punched out as a HOLE,
    // and a hole that grazed the contour would triangulate into a fan of
    // slivers (and read as a causeway on screen).
    const outer = waterOutline(LAKE, 512);
    const isl = islandOutline(LAKE, 512)!;
    let worst = Infinity;
    for (const [x, z] of isl) {
      for (const [px, pz] of outer) worst = Math.min(worst, Math.hypot(x - px, z - pz));
    }
    expect(worst).toBeGreaterThan(ISLAND_CLEARANCE);
  });

  it('encloses exactly the water the geography reports', () => {
    // Outer area minus the island's: the water is everything between the two
    // rings, with nothing taken out of it anywhere.
    const ring = shoelace(waterOutline(LAKE)) - shoelace(islandOutline(LAKE)!);
    expect(ring).toBeGreaterThan(0);
    const reach = LAKE.r * WOBBLE_MAX + 1;
    const step = 0.1;
    let cells = 0;
    for (let x = LAKE.x - reach; x <= LAKE.x + reach; x += step) {
      for (let z = LAKE.z - reach; z <= LAKE.z + reach; z += step) if (isWater(x, z)) cells++;
    }
    const measured = cells * step * step;
    // Chords cut a hair inside every wobble, so the polygons run slightly
    // small on the outside and slightly large on the hole.
    expect(ring / measured).toBeGreaterThan(0.95);
    expect(ring / measured).toBeLessThan(1.02);
  });

  it('is deterministic and honours the requested point budget', () => {
    expect(waterOutline(LAKE)).toEqual(waterOutline(LAKE));
    expect(islandOutline(LAKE)).toEqual(islandOutline(LAKE));
    expect(waterOutline(LAKE, 32)).toHaveLength(32);
    expect(islandOutline(LAKE, 32)).toHaveLength(32);
  });
});

describe('landscape — colliders', () => {
  const cols = waterColliders();

  it('tiles every body with same-size hard circles, and not too many', () => {
    expect(cols.length).toBeGreaterThan(WATER_BODIES.length * 4);
    // A budget, not a fixture: the tiling is what the collider grid indexes
    // every frame. Measured 1118 for the shipped layout, ~1050 of them the
    // lake.
    expect(cols.length).toBeLessThanOrEqual(2500);
    for (const c of cols) {
      expect(c.hard).toBe(true);
      expect(c.r).toBe(WATER_COLLIDER_R);
    }
  });

  it('centers every collider on water', () => {
    for (const c of cols) expect(isWater(c.x, c.z)).toBe(true);
  });

  it('covers each pond, center included', () => {
    for (const p of PONDS) {
      const own = cols.filter((c) => Math.hypot(c.x - p.x, c.z - p.z) <= c.r);
      // The tiling is anchored on the body center, so a pond always gets a
      // circle dead on it — no pond is ever left as an open puddle.
      expect(own.length, `pond at ${p.x},${p.z}`).toBeGreaterThan(0);
    }
  });

  it('blocks the water on every bearing round the island', () => {
    // The other half of "no causeway": the ring is not merely wet, it is
    // impassable all the way round. Sampled at the midpoint of the crossing
    // from the island's shore to the far shore, on 36 bearings — a creature
    // aimed at the island is inside a hard circle whichever way it comes.
    for (let k = 0; k < 36; k++) {
      const th = (k / 36) * Math.PI * 2;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const from = wobbledRadius(ISLAND, th);
      let to = from;
      for (let d = from + 0.05; d < from + 60; d += 0.1) {
        if (!isWater(ISLAND.x + cos * d, ISLAND.z + sin * d)) break;
        to = d;
      }
      const mid = (from + to) / 2;
      const x = ISLAND.x + cos * mid;
      const z = ISLAND.z + sin * mid;
      expect(isWater(x, z), `bearing ${th.toFixed(2)}`).toBe(true);
      expect(
        cols.some((c) => Math.hypot(x - c.x, z - c.z) < c.r),
        `unblocked water on bearing ${th.toFixed(2)}`,
      ).toBe(true);
    }
  });

  it('leaves no wadeable pocket of open water', () => {
    // The design bound, with no exception left in it now the causeway is
    // gone: a creature gets at most ~1.6 units past any shore — the outer
    // one or the island's — before a circle stops it.
    for (const body of WATER_BODIES) {
      const reach = body.r * WOBBLE_MAX;
      for (let x = body.x - reach; x <= body.x + reach; x += 0.4) {
        for (let z = body.z - reach; z <= body.z + reach; z += 0.4) {
          if (!isWater(x, z)) continue;
          let clear = Infinity;
          for (const c of cols) clear = Math.min(clear, Math.hypot(x - c.x, z - c.z) - c.r);
          expect(clear, `open water at ${x.toFixed(1)},${z.toFixed(1)}`).toBeLessThan(1.8);
        }
      }
    }
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
    const inner = samples.filter(
      (s) => Math.hypot(s.x - ISLAND.x, s.z - ISLAND.z) < ISLAND.r * WOBBLE_MAX + 0.5,
    );
    expect(inner.length).toBeGreaterThan(8);
    for (const s of inner) {
      const dot = (s.x - ISLAND.x) * s.nx + (s.z - ISLAND.z) * s.nz;
      expect(dot).toBeLessThan(0);
    }
  });

  it('lines the island the whole way round — every bearing gets reeds', () => {
    // No gap anywhere on either ring now the causeway is gone. Sampled as
    // twelve 30° sectors of the island's shore: each holds samples.
    const inner = shoreSamples(LAKE).filter(
      (s) => Math.hypot(s.x - ISLAND.x, s.z - ISLAND.z) < ISLAND.r * WOBBLE_MAX + 0.5,
    );
    const sectors = new Set<number>();
    for (const s of inner) {
      const a = Math.atan2(s.z - ISLAND.z, s.x - ISLAND.x);
      sectors.add(Math.floor(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 6)));
    }
    expect(sectors.size).toBe(12);
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
    // A margin wider than the lake's own water empties it. 24, not 20: the
    // island moved off-centre, which opens a 41-unit crossing on the far
    // side of it — the widest open water the map holds.
    expect(rippleSpots(LAKE, 24)).toHaveLength(0);
  });
});

describe('landscape — the environments are spread out', () => {
  /** Closest approach of one wobbled edge to another, edge to edge. Negative
   * means the two blobs overlap. */
  function edgeGap(a: Blob, b: Blob): number {
    let gap = Infinity;
    for (const [x, z] of edgePoints(a, 720)) {
      const theta = Math.atan2(z - b.z, x - b.x);
      gap = Math.min(gap, Math.hypot(x - b.x, z - b.z) - wobbledRadius(b, theta));
    }
    return gap;
  }

  const waterBlobs: Blob[] = WATER_BODIES.map((b) => ({ x: b.x, z: b.z, r: b.r, seed: b.seed }));

  it('holds every feature edge at least a horizon off the origin', () => {
    for (const b of ALL_BLOBS) {
      for (const [x, z] of edgePoints(b)) {
        expect(
          Math.hypot(x, z),
          `feature at ${b.x},${b.z} r=${b.r}`,
        ).toBeGreaterThanOrEqual(FEATURE_CLEAR);
      }
    }
  });

  it('keeps 20 units of open plain between any two environments', () => {
    // Environments, not blobs: the forest's two masses overlap each other on
    // purpose and so do the range's four, but no two DIFFERENT environments
    // may come near one another. 1.2 × r is the authored radius plus the
    // wobble's headroom.
    const environments: [string, readonly Blob[]][] = [
      ['forest', FOREST_BLOBS],
      ['range', MOUNTAIN_BLOBS],
      ...WATER_BODIES.map(
        (b, i) => [`${b.kind} ${i}`, [{ x: b.x, z: b.z, r: b.r, seed: b.seed }]] as [string, Blob[]],
      ),
    ];
    for (let i = 0; i < environments.length; i++) {
      for (let j = i + 1; j < environments.length; j++) {
        const [an, as_] = environments[i]!;
        const [bn, bs] = environments[j]!;
        let gap = Infinity;
        for (const a of as_) {
          for (const b of bs) {
            gap = Math.min(gap, Math.hypot(a.x - b.x, a.z - b.z) - 1.2 * (a.r + b.r));
          }
        }
        expect(gap, `${an} <-> ${bn}`).toBeGreaterThanOrEqual(ENVIRONMENT_GAP);
      }
    }
  });

  it('never grows a forest or a range into a body of water', () => {
    for (const land of [...FOREST_BLOBS, ...MOUNTAIN_BLOBS]) {
      for (const wet of waterBlobs) {
        expect(edgeGap(land, wet), `${land.x},${land.z} <-> ${wet.x},${wet.z}`).toBeGreaterThan(0);
      }
    }
  });

  it('spreads them across the field, not into one corner', () => {
    // Each of the four environments sits on its own bearing from the origin:
    // forest west, range north, lake east, ponds scattered between them.
    const bearing = (b: { x: number; z: number }): number => Math.atan2(b.z, b.x);
    const forest = bearing(FOREST_BLOBS[0]!);
    const range = bearing(MOUNTAIN_BLOBS[1]!);
    const lake = bearing(LAKE);
    const apart = (a: number, b: number): number =>
      Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    expect(apart(forest, range)).toBeGreaterThan(1);
    expect(apart(range, lake)).toBeGreaterThan(1);
    expect(apart(lake, forest)).toBeGreaterThan(1);
  });

  it('keeps the lake reading as a body of water, not a moat', () => {
    // Most of the lake disc is wet: an island standing in open water, not a
    // ring of water around a landmass. Measured 0.889 of the disc.
    const isl = LAKE.island!;
    expect(LAKE.r / isl.r).toBeGreaterThan(2.5);
    const reach = LAKE.r * WOBBLE_MAX;
    let wet = 0;
    let dry = 0;
    for (let x = LAKE.x - reach; x <= LAKE.x + reach; x += 0.25) {
      for (let z = LAKE.z - reach; z <= LAKE.z + reach; z += 0.25) {
        const d = Math.hypot(x - LAKE.x, z - LAKE.z);
        if (d >= wobbledRadius(LAKE, Math.atan2(z - LAKE.z, x - LAKE.x))) continue;
        if (isWater(x, z)) wet++;
        else dry++;
      }
    }
    expect(wet / (wet + dry)).toBeGreaterThan(0.8);
  });
});

describe('landscape — terrain height', () => {
  const FIELD = 155;
  /** Inside (or within a sample of) the island — the one landform measured
   * against its own slope bound rather than the field's. */
  const nearIsland = (x: number, z: number): boolean => {
    const dx = x - ISLAND.x;
    const dz = z - ISLAND.z;
    const d = Math.hypot(dx, dz);
    return d < wobbledRadius(ISLAND, Math.atan2(dz, dx)) + 1.5;
  };
  /** Every sample is a `terrainHeight` call, so the field walks are coarse on
   * purpose. */
  const walk = (step: number, fn: (x: number, z: number) => void): void => {
    for (let x = -FIELD; x <= FIELD; x += step) for (let z = -FIELD; z <= FIELD; z += step) fn(x, z);
  };

  it('is deterministic', () => {
    for (let i = 0; i < 400; i++) {
      const x = -140 + ((i * 137) % 280);
      const z = -140 + ((i * 61) % 280);
      expect(terrainHeight(x, z)).toBe(terrainHeight(x, z));
      expect(terrainNormal(x, z)).toEqual(terrainNormal(x, z));
    }
  });

  it('leaves the whole hatch clearing exactly flat at zero', () => {
    expect(terrainHeight(0, 0)).toBe(0);
    for (let i = 0; i <= 100; i++) {
      for (let j = 0; j <= 100; j++) {
        const x = -TERRAIN.clearRadius + i * 0.2;
        const z = -TERRAIN.clearRadius + j * 0.2;
        if (x * x + z * z > TERRAIN.clearRadius * TERRAIN.clearRadius) continue;
        expect(terrainHeight(x, z), `${x.toFixed(1)},${z.toFixed(1)}`).toBe(0);
      }
    }
  });

  it('holds every slope inside the bound, risers included', () => {
    // The terrace multiplies the smooth field's gradient by 1.5 / the riser
    // width, so this is the number the [D] falloffs were tuned against:
    // terraceRiser 0.2–0.8, mountainShelfFalloff 70, shoreRamp 16. Measured
    // 0.4546 at TERRAIN_DEFAULTS.elevation 0.7 (it was 0.5476 at 1.0, at the
    // range's southern apron; the default backed off and the bound did not).
    //
    // THE ISLAND IS EXEMPT, and is measured on its own below. It is a bank:
    // 3.2 units of rise on a 14-unit island cannot be spread at 0.55 by any
    // shaping (0.55 through the terrace buys 0.22 units of climb per unit of
    // ground, so it would want a 15-unit run), and a bank is the one landform
    // whose job is to be steeper than the field around it.
    let worst = 0;
    walk(0.5, (x, z) => {
      if (nearIsland(x, z)) return;
      const gx = terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z);
      const gz = terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5);
      worst = Math.max(worst, Math.hypot(gx, gz));
    });
    expect(worst).toBeLessThanOrEqual(0.6);
  });

  it('climbs the island out of the water onto a contour crown', () => {
    const level = waterLevel(LAKE);
    // A crown, not a sandbar (2026-09-03, user report — "the island sits FLAT
    // at water level").
    //
    // RE-MEASURED at TERRAIN_DEFAULTS.elevation 0.7 (the dial the same user
    // asked for, 2026-09-03: "there is a lot of elevation change"). Every
    // vertical is seven tenths of the authored one, so the crown that stood
    // level + 3.20 over two full tiers now stands level + 2.35 — one full
    // tier and most of a second. Push the elevation dial back to 1.0 and the
    // old 3.20 comes straight back; this is the shipped default, not a
    // change to the geography.
    expect(terrainHeight(ISLAND.x, ISLAND.z) - level).toBeGreaterThanOrEqual(2.3);
    // …and the tiers are the world's own tiers, not heights of their own.
    const tiers = new Set<number>();
    for (let i = 0; i < 720; i++) {
      const th = (i / 720) * Math.PI * 2;
      const edge = wobbledRadius(ISLAND, th);
      for (let d = 0; d < edge; d += 0.25) {
        const h = terrainHeight(ISLAND.x + Math.cos(th) * d, ISLAND.z + Math.sin(th) * d) - level;
        const k = h / TERRAIN.terraceStep;
        if (Math.abs(k - Math.round(k)) < 1e-9) tiers.add(Math.round(k));
      }
    }
    // [0, 1] at the 0.7 default (it was [0, 1, 2] at 1.0): the crown sits
    // between the second and third contour rather than exactly on the third.
    expect([...tiers].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('starts the island bank AT the waterline, so the drawn shore stays on top', () => {
    // The shore ribbon rides `waterLevel + 0.011`. Every island shore sample
    // — already pushed 0.15 onto land — has to still be under it, or the pen
    // line is buried in the bank it draws. Measured: exactly the water level
    // at all of them (the terrace's first tread is flat).
    const level = waterLevel(LAKE);
    const inner = shoreSamples(LAKE).filter(
      (s) => Math.hypot(s.x - ISLAND.x, s.z - ISLAND.z) < ISLAND.r * WOBBLE_MAX + 0.5,
    );
    expect(inner.length).toBeGreaterThan(20);
    for (const s of inner) {
      expect(terrainHeight(s.x, s.z), `island shore at ${s.x},${s.z}`).toBeLessThanOrEqual(
        level + 0.011,
      );
    }
    // …and it really is a bank and not a plateau: four units in, the ground
    // has left the water behind on every bearing.
    //
    // FOUR, re-measured at TERRAIN_DEFAULTS.elevation 0.7 — it was three at
    // 1.0, with 0.03 of a unit to spare. The terrace's first tread is flat
    // until the smooth rise clears 0.32 (terraceRiser 0.2 × tierStep 1.6),
    // and a rise scaled by 0.7 needs a little more bank to get there: at
    // three units in, the widest-edge bearing is still exactly at the water
    // line. Measured at four: 0.09 clear at the worst bearing.
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * Math.PI * 2;
      const d = wobbledRadius(ISLAND, th) - 4;
      expect(
        terrainHeight(ISLAND.x + Math.cos(th) * d, ISLAND.z + Math.sin(th) * d),
        `island at 4 units in, bearing ${th.toFixed(2)}`,
      ).toBeGreaterThan(level);
    }
  });

  it('keeps the island bank inside ITS bound — steep, never a wall', () => {
    // The island's own number, measured the same way as the field's: 0.87 at
    // TERRAIN_DEFAULTS.elevation 0.7 (1.15 at elevation 1.0). The bound stays
    // at the elevation-1.0 headroom so it keeps pinning the bank's SHAPE
    // rather than tracking whichever default the dial ships at.
    // A bank, not a cliff — and pinned, so it cannot creep toward vertical.
    let worst = 0;
    for (let x = ISLAND.x - 20; x <= ISLAND.x + 20; x += 0.5) {
      for (let z = ISLAND.z - 20; z <= ISLAND.z + 20; z += 0.5) {
        const gx = terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z);
        const gz = terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5);
        worst = Math.max(worst, Math.hypot(gx, gz));
      }
    }
    expect(worst).toBeLessThanOrEqual(1.25);
  });

  it('keeps the whole field inside ±10 units of height', () => {
    let lo = Infinity;
    let hi = -Infinity;
    walk(1, (x, z) => {
      const h = terrainHeight(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    });
    // Measured [-2.61, 5.54] at TERRAIN_DEFAULTS.elevation 0.7 ([-3.10, 8.00]
    // at 1.0, [-6.20, 16.00] at the dial's ceiling of 2.0) — the bound is the
    // design budget for the shipped world, not the value.
    expect(lo).toBeGreaterThan(-10);
    expect(hi).toBeLessThan(10);
  });

  it('reads as tiers, not a swell — four levels between the origin and the range', () => {
    const target = MOUNTAIN_BLOBS[1]!;
    const len = Math.hypot(target.x, target.z);
    const line: number[] = [];
    for (let d = 0; d <= len; d += 1) {
      line.push(terrainHeight((target.x * d) / len, (target.z * d) / len));
    }
    // Plateaus: runs of the same height (to a tenth of a unit) at least six
    // units long. A smooth swell has none; a terrace has one per tread.
    const levels: number[] = [];
    let current = Math.round(line[0]! * 10) / 10;
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      const h = i < line.length ? Math.round(line[i]! * 10) / 10 : NaN;
      if (h === current) {
        run++;
        continue;
      }
      if (run >= 6) levels.push(current);
      current = h;
      run = 1;
    }
    expect(new Set(levels).size).toBeGreaterThanOrEqual(4);
    // …and they are genuine tiers of the terrace, not arbitrary heights.
    for (const level of levels) {
      expect(Math.abs(level / TERRAIN.terraceStep - Math.round(level / TERRAIN.terraceStep))).toBeLessThan(
        0.05,
      );
    }
  });

  it('flattens every water body to exactly its own level', () => {
    for (const body of WATER_BODIES) {
      const level = waterLevel(body);
      for (let i = 0; i < 240; i++) {
        const theta = (i / 240) * Math.PI * 2;
        for (const f of [0, 0.35, 0.7, 0.95]) {
          const r = wobbledRadius(body, theta) * f;
          const x = body.x + Math.cos(theta) * r;
          const z = body.z + Math.sin(theta) * r;
          // The basin is the whole disc, island included — the island then
          // climbs back out of it, and only there is the ground above the
          // water. Everywhere else inside the shore is exactly the level, so
          // water can never sit above land.
          if (sampleLandscape(x, z).island) {
            expect(terrainHeight(x, z)).toBeGreaterThanOrEqual(level);
            continue;
          }
          expect(terrainHeight(x, z), `${body.kind} at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(level);
        }
      }
    }
  });

  it('never lets a shore sit below the water it borders', () => {
    for (const body of WATER_BODIES) {
      const level = waterLevel(body);
      for (let i = 0; i < 720; i++) {
        const theta = (i / 720) * Math.PI * 2;
        const r = wobbledRadius(body, theta) + 1;
        const x = body.x + Math.cos(theta) * r;
        const z = body.z + Math.sin(theta) * r;
        expect(
          terrainHeight(x, z),
          `${body.kind} shore at ${theta.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(level);
      }
    }
  });

  it('sinks every basin — the land around a body of water stands over it', () => {
    for (const body of WATER_BODIES) {
      const level = waterLevel(body);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 360; i++) {
        const theta = (i / 360) * Math.PI * 2;
        for (let out = 8; out <= 14; out += 1) {
          const r = wobbledRadius(body, theta) + out;
          sum += terrainHeight(body.x + Math.cos(theta) * r, body.z + Math.sin(theta) * r);
          n++;
        }
      }
      // Re-measured at TERRAIN_DEFAULTS.elevation 0.7: the lake stands 1.77
      // under its own shoulder and the ponds 0.75–1.07 (it was 2.17 and
      // 1.09–1.85 at elevation 1.0 — the basin drop and the land around it
      // both scale with the dial). A body of water still reads as sunk, not
      // painted on.
      expect(sum / n - level, `${body.kind} at ${body.x},${body.z}`).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('puts each environment on its own level', () => {
    const meanWhere = (pick: (x: number, z: number) => boolean): number => {
      let sum = 0;
      let n = 0;
      walk(2, (x, z) => {
        if (!pick(x, z)) return;
        sum += terrainHeight(x, z);
        n++;
      });
      expect(n).toBeGreaterThan(200);
      return sum / n;
    };
    // Open plain: an annulus clear of every region weight and every body of
    // water, the reference the shelves are measured against.
    const plain = meanWhere((x, z) => {
      const r = Math.hypot(x, z);
      if (r < 35 || r > 90) return false;
      const l = sampleLandscape(x, z);
      return l.forest === 0 && l.mountain === 0 && !l.water && !l.island;
    });
    const forest = meanWhere((x, z) => sampleLandscape(x, z).forest >= 0.8);
    const range = meanWhere((x, z) => sampleLandscape(x, z).mountain >= 0.8);
    // Re-measured at TERRAIN_DEFAULTS.elevation 0.7: plain 1.21, forest 2.54,
    // range 3.65 (it was 1.70 / 3.53 / 5.23 at elevation 1.0). Each
    // environment still stands a full tier over the one below it.
    expect(forest - plain).toBeGreaterThanOrEqual(1.3);
    expect(range - forest).toBeGreaterThan(1);
  });

  it('meets the flat ground disc past the far fade', () => {
    for (let a = 0; a < 360; a += 3) {
      for (const r of [TERRAIN.farEnd, TERRAIN.farEnd + 20, 400]) {
        const th = (a / 180) * Math.PI;
        // Math.abs: the fade multiplies a negative height by zero, which is
        // -0 — numerically zero, and not what this test is about.
        expect(Math.abs(terrainHeight(Math.cos(th) * r, Math.sin(th) * r))).toBe(0);
      }
    }
  });

  it('returns a unit up-normal everywhere', () => {
    let flattest = 1;
    walk(2, (x, z) => {
      const n = terrainNormal(x, z);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
      // The island bank tilts harder than the field (see its own bound
      // above); this is the field's number.
      if (!nearIsland(x, z)) flattest = Math.min(flattest, n.y);
    });
    // Terrace risers tilt harder than the old smooth swell did: measured
    // 0.9107 at TERRAIN_DEFAULTS.elevation 0.7 (0.8775 at elevation 1.0),
    // which is the slope bound above read as a normal.
    expect(flattest).toBeGreaterThan(0.8);
    const flat = terrainNormal(0, 0);
    expect(flat.y).toBe(1);
    expect(Math.abs(flat.x)).toBe(0);
    expect(Math.abs(flat.z)).toBe(0);
  });
});

describe('landscape — the terrain dials', () => {
  // Module state, like scatter's active seed: every test here puts it back,
  // so nothing downstream of this file ever sees a moved dial. (Vitest runs
  // files in separate workers, so this is tidiness rather than a guard.)
  afterEach(() => setTerrainParams(TERRAIN_DEFAULTS));

  /** The line from the origin out to the range — the walk the tier tests
   * read, and the same one the "reads as tiers" test above uses. */
  const RANGE_TARGET = MOUNTAIN_BLOBS[1]!;
  const alongRange = (step: number, fn: (x: number, z: number) => void): void => {
    const len = Math.hypot(RANGE_TARGET.x, RANGE_TARGET.z);
    for (let d = 0; d <= len; d += step) {
      fn((RANGE_TARGET.x * d) / len, (RANGE_TARGET.z * d) / len);
    }
  };

  /** Mean |∇h| over the field, the island excluded (it is a bank and has its
   * own gradient — see its bound above). */
  const meanGradient = (): number => {
    let sum = 0;
    let n = 0;
    for (let x = -155; x <= 155; x += 2) {
      for (let z = -155; z <= 155; z += 2) {
        const dx = x - ISLAND.x;
        const dz = z - ISLAND.z;
        if (Math.hypot(dx, dz) < wobbledRadius(ISLAND, Math.atan2(dz, dx)) + 1.5) continue;
        const gx = terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z);
        const gz = terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5);
        sum += Math.hypot(gx, gz);
        n++;
      }
    }
    return sum / n;
  };

  it('ships TERRAIN_DEFAULTS, with the terrace step the authored one', () => {
    expect(terrainParams()).toEqual(TERRAIN_DEFAULTS);
    // The shipped elevation is a decision, not the authored 1.0: the user
    // judged the 1.0 world "a lot of elevation change" (2026-09-03).
    expect(TERRAIN_DEFAULTS.elevation).toBe(0.7);
    expect(TERRAIN_DEFAULTS.tierStep).toBe(TERRAIN.terraceStep);
    expect(TERRAIN_DEFAULTS.relief).toBe(1);
  });

  it('flattens the whole world at elevation 0 — water levels and island too', () => {
    setTerrainParams({ elevation: 0 });
    for (let i = 0; i < 500; i++) {
      const x = -150 + ((i * 137) % 300);
      const z = -150 + ((i * 61) % 300);
      expect(terrainHeight(x, z), `${x},${z}`).toBe(0);
    }
    for (const body of WATER_BODIES) expect(waterLevel(body), body.kind).toBe(0);
    // The island is the last term in `terrainHeight` and the one most likely
    // to survive a zeroed dial, so it gets walked explicitly.
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * Math.PI * 2;
      for (let f = 0; f <= 1; f += 0.1) {
        const d = wobbledRadius(ISLAND, th) * f;
        expect(terrainHeight(ISLAND.x + Math.cos(th) * d, ISLAND.z + Math.sin(th) * d)).toBe(0);
      }
    }
  });

  it('spaces the treads farther apart at a bigger tierStep', () => {
    // Count the distinct treads the walk to the range crosses. Measured:
    // 4 at 1.6, 2 at 3.2 — the same climb cut into half as many steps.
    const treadsAt = (tierStep: number): number => {
      setTerrainParams({ tierStep });
      const seen = new Set<number>();
      alongRange(0.5, (x, z) => seen.add(Math.round(terrainHeight(x, z) / tierStep)));
      return seen.size;
    };
    const fine = treadsAt(1.6);
    const coarse = treadsAt(3.2);
    expect(fine).toBe(4);
    expect(coarse).toBe(2);
    expect(coarse).toBeLessThan(fine);
  });

  it('spreads the relief wider — the contours move apart', () => {
    // `relief` is a horizontal scale, so doubling it halves every gradient:
    // the same height differences laid out over twice the ground. Measured
    // mean |∇h| 0.0571 at relief 1 and 0.0453 at relief 2 — the field's own
    // flat regions (the clearing, the far fade, the basins) are not scaled
    // and dilute the ratio, so this asserts the direction and a floor, not
    // an exact half.
    const tight = meanGradient();
    setTerrainParams({ relief: 2 });
    const spread = meanGradient();
    expect(spread).toBeLessThan(tight);
    expect(spread).toBeLessThan(tight * 0.85);
  });

  it('clamps every dial to its limits', () => {
    setTerrainParams({ elevation: -5, tierStep: 0, relief: 99 });
    expect(terrainParams()).toEqual({
      elevation: TERRAIN_LIMITS.elevation[0],
      tierStep: TERRAIN_LIMITS.tierStep[0],
      relief: TERRAIN_LIMITS.relief[1],
    });
    setTerrainParams({ elevation: 99, tierStep: 99, relief: -1 });
    expect(terrainParams()).toEqual({
      elevation: TERRAIN_LIMITS.elevation[1],
      tierStep: TERRAIN_LIMITS.tierStep[1],
      relief: TERRAIN_LIMITS.relief[0],
    });
    // A non-finite value leaves the dial where it was rather than poisoning
    // every height on the map with NaN.
    setTerrainParams({ elevation: Number.NaN, relief: Number.POSITIVE_INFINITY });
    expect(terrainParams().elevation).toBe(TERRAIN_LIMITS.elevation[1]);
    expect(terrainParams().relief).toBe(TERRAIN_LIMITS.relief[0]);
  });

  it('is reversible — set a dial, put it back, get the identical map', () => {
    const sample = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 300; i++) {
        const x = -140 + ((i * 137) % 280);
        const z = -140 + ((i * 61) % 280);
        out.push(terrainHeight(x, z));
      }
      for (const body of WATER_BODIES) out.push(waterLevel(body));
      return out;
    };
    const before = sample();
    setTerrainParams({ elevation: 1.45, tierStep: 2.7, relief: 1.8 });
    expect(sample()).not.toEqual(before);
    setTerrainParams(TERRAIN_DEFAULTS);
    expect(sample()).toEqual(before);
  });

  it('leaves the hatch clearing alone, and the far rim flat, at every setting', () => {
    // Neither gate is scaled by a dial: the clearing is a fixed place the
    // creatures hatch in, and the rim has to keep meeting the flat outer
    // disc. The clearing is EXACT at every setting.
    //
    // The rim is exact at the shipped defaults (the "meets the flat ground
    // disc past the far fade" test above pins that at 0) but not quite at
    // the top of the relief dial, and that is the geography being honest:
    // basins are applied AFTER the far fade so a basin's interior is exactly
    // its water level, and at relief 2.5 the lake's 40-unit shore ramp (16 ×
    // 2.5) reaches a few units past farEnd. Measured worst case: 0.11 of a
    // unit, a fourteenth of a tier, on one bearing of the rim.
    for (const params of [
      { elevation: 2, tierStep: 4, relief: 2.5 },
      { elevation: 0.2, tierStep: 0.6, relief: 0.5 },
    ]) {
      setTerrainParams(params);
      expect(terrainHeight(0, 0)).toBe(0);
      for (let i = 0; i < 120; i++) {
        const th = (i / 120) * Math.PI * 2;
        for (const r of [3, 7, TERRAIN.clearRadius]) {
          expect(terrainHeight(Math.cos(th) * r, Math.sin(th) * r), `clearing ${r}`).toBe(0);
        }
        for (const r of [TERRAIN.farEnd, TERRAIN.farEnd + 20, 400]) {
          expect(
            Math.abs(terrainHeight(Math.cos(th) * r, Math.sin(th) * r)),
            `rim ${r}`,
          ).toBeLessThanOrEqual(0.15);
        }
      }
    }
    // …and back at the defaults it is exactly the flat sheet again.
    setTerrainParams(TERRAIN_DEFAULTS);
    for (let i = 0; i < 120; i++) {
      const th = (i / 120) * Math.PI * 2;
      expect(
        Math.abs(terrainHeight(Math.cos(th) * TERRAIN.farEnd, Math.sin(th) * TERRAIN.farEnd)),
      ).toBe(0);
    }
  });

  it('stays a bank and not a wall at the top of the elevation dial', () => {
    // A dev dial may be steep — the 0.6 field bound is the SHIPPED world's,
    // not the dial's. Measured at elevation 2.0: 1.15 over the field (at the
    // range's southern apron) and 2.05 on the island's bank. Stated, so a
    // future change that makes the ceiling vertical is caught.
    setTerrainParams({ elevation: TERRAIN_LIMITS.elevation[1] });
    let field = 0;
    let island = 0;
    for (let x = -155; x <= 155; x += 1) {
      for (let z = -155; z <= 155; z += 1) {
        const gx = terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z);
        const gz = terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5);
        const g = Math.hypot(gx, gz);
        const dx = x - ISLAND.x;
        const dz = z - ISLAND.z;
        if (Math.hypot(dx, dz) < wobbledRadius(ISLAND, Math.atan2(dz, dx)) + 1.5) {
          island = Math.max(island, g);
        } else field = Math.max(field, g);
      }
    }
    expect(field).toBeLessThanOrEqual(1.25);
    expect(island).toBeLessThanOrEqual(2.2);
  });
});
