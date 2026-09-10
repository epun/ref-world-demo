/**
 * Painted water in the GEOGRAPHY — src/world/landscape.ts `setPaintedWater`
 * and everything that has to answer for it. Pure, no WebGL except where the
 * scatter block at the bottom has to build one.
 *
 * The hook is the sibling of `setPaintedHeight` (test/world/painted.test.ts
 * pins that one), and the load-bearing test is the same: with no field
 * installed the world is the world, sample for sample. After that, that a
 * painted body cuts the AUTHORED basin's maths — a flat sheet at exactly its
 * level, a rim that holds the level over the first stride of bank, a
 * climb-out over `shoreRamp` — with the distance field standing in for
 * `d - wobbledRadius`. Every expectation below is re-derived from the
 * module's own dials at the point it is measured, never a recorded number.
 *
 * NO `deriveWater` HERE. The field is a `PaintedWaterField` built by hand: a
 * disc pond whose `shore` is `r - hypot(dx, dz)` and whose outline is a ring
 * of that radius, plus a variant with an island in it (`shore` the min of the
 * two signed distances, the island's ring as the body's one hole). That keeps
 * this file measuring the geography rather than the tracer — the tracer has
 * its own test — and it means every number below can be worked out on paper.
 *
 * WHERE THE POND SITS. (-50, 0), radius 9 — 67 units clear of the nearest
 * authored shoreline, so in the landscape mode the painted body and its
 * 16-unit ramp sit on open authored land and nothing measured here is the
 * lake answering for the pond. (The first draft put it at (60, 20), which is
 * 7.2 units from the lake's western shore: a 9-radius disc there is half in
 * the lake, and "isWater is false outside the painted shore" would have been
 * measuring the wrong water.)
 *
 * THE MODE. Painted water is a person's own hand, not the map, so it exists
 * in BOTH modes and both are pinned. This file runs in the landscape mode
 * (that is where there is authored land to cut a basin out of) and drops into
 * the plain one — where the land is flat zero and the arithmetic is
 * transparent — through `inPlain`.
 */

import { zeroPlanting } from '../../src/world/painted';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isWater,
  paintedRippleSpots,
  paintedShoreSamples,
  paintedWater,
  RIPPLE_MARGIN,
  sampleLandscape,
  setLandscapeMode,
  setPaintedWater,
  SHORE_SPACING,
  TERRAIN,
  terrainHeight,
  terrainNormal,
  terrainParams,
  WATER_COLLIDER_BITE,
  WATER_COLLIDER_R,
  waterColliders,
} from '../../src/world/landscape';
import type { PaintedBody, PaintedWaterField } from '../../src/world/painted-water';
import { computePlacements, createScatter, type Placement } from '../../src/world/scatter';

beforeAll(() => setLandscapeMode('landscape'));
afterAll(() => setLandscapeMode('plain'));
afterEach(() => setPaintedWater(null));

/** Run `f` with the map switched off, then put the file's mode back. */
function inPlain<T>(f: () => T): T {
  setLandscapeMode('plain');
  try {
    return f();
  } finally {
    setLandscapeMode('landscape');
  }
}

// ── the hand-made field ──────────────────────────────────────────────────────

/** The painted pond: a disc on open authored land, far from every authored
 * body (see the header). */
const POND = { x: -50, z: 0, r: 9 } as const;
/** An island standing in it, off-centre like the authored lake's. */
const ISLE = { x: -48, z: 0, r: 3 } as const;

/**
 * Ring segments about one painted texel long (src/world/painted.ts: 400 units
 * over 512 texels). A traced ring arrives at the brush's own scale, which is
 * why `paintedShoreSamples` does not subdivide it — so the rings here are
 * built at that scale rather than at an authored outline's 96 points.
 */
const RING_STEP = 400 / 512;

/** A closed ring, counter-clockwise in x/z (increasing theta, exactly like
 * `ringOutline`): the outward normal of a segment is `(dz, -dx)`. */
function ring(cx: number, cz: number, r: number): [number, number][] {
  const n = Math.max(12, Math.round((2 * Math.PI * r) / RING_STEP));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(th) * r, cz + Math.sin(th) * r]);
  }
  return out;
}

function boundsOf(cx: number, cz: number, r: number): PaintedBody['bounds'] {
  return { x0: cx - r, z0: cz - r, x1: cx + r, z1: cz + r };
}

/** Signed distance to the disc's shore: positive inside the water. */
const discShore = (x: number, z: number): number => POND.r - Math.hypot(x - POND.x, z - POND.z);

/** …and with the island cut out of it: the nearer of the two shores. */
const isleShore = (x: number, z: number): number =>
  Math.min(discShore(x, z), Math.hypot(x - ISLE.x, z - ISLE.z) - ISLE.r);

function discField(level: number): PaintedWaterField {
  const body: PaintedBody = {
    id: 0,
    level,
    seed: 4211,
    outline: ring(POND.x, POND.z, POND.r),
    holes: [],
    bounds: boundsOf(POND.x, POND.z, POND.r),
    texels: 417,
  };
  return { shore: discShore, level: () => level, bodies: [body] };
}

function islandField(level: number): PaintedWaterField {
  const body: PaintedBody = {
    id: 0,
    level,
    seed: 4211,
    outline: ring(POND.x, POND.z, POND.r),
    holes: [ring(ISLE.x, ISLE.z, ISLE.r)],
    bounds: boundsOf(POND.x, POND.z, POND.r),
    texels: 371,
  };
  return { shore: isleShore, level: () => level, bodies: [body] };
}

// ── re-derived maths ─────────────────────────────────────────────────────────

/** The module's own spatial ramp. Private to landscape.ts, so it is written
 * out here rather than imported — the expectations below are its arithmetic,
 * not a recording of its output. */
function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const shoreRamp = (): number => TERRAIN.shoreRamp * terrainParams().relief;
const basinRim = (): number => TERRAIN.basinRim * terrainParams().relief;

/** What the painted pass must make of the land `h` at a point `out` units
 * OUTSIDE the painted shore (negative inside it), at `level`. */
function basin(h: number, level: number, out: number): number {
  const ramp = shoreRamp();
  if (out >= ramp) return h;
  const t = smoothstep(0, ramp, out);
  const blended = level + (h - level) * t;
  const rim = 1 - smoothstep(basinRim(), ramp, out);
  return blended + rim * Math.max(0, level - blended);
}

/** Deterministic probes over the field, the same sin-hash family the world
 * itself uses, spread over ±180 so the far fade, the authored bodies and the
 * painted pond are all in the sample. */
function probes(count: number, extent = 180): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
    const b = Math.sin(i * 269.5 + 183.3) * 43758.5453123;
    out.push([
      (a - Math.floor(a)) * 2 * extent - extent,
      (b - Math.floor(b)) * 2 * extent - extent,
    ]);
  }
  return out;
}

/** Points inside the pond, on a spiral so the whole disc is covered. */
function insidePond(count: number, r = POND.r): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const rr = Math.sqrt(t) * r * 0.995;
    const th = i * 2.399963;
    out.push([POND.x + Math.cos(th) * rr, POND.z + Math.sin(th) * rr]);
  }
  return out;
}

// ── the hook ─────────────────────────────────────────────────────────────────

describe('painted water — the hook', () => {
  it('holds nothing until a field is installed, and gives back the one it holds', () => {
    expect(paintedWater()).toBe(null);
    const field = discField(0);
    setPaintedWater(field);
    expect(paintedWater()).toBe(field);
    setPaintedWater(null);
    expect(paintedWater()).toBe(null);
  });
});

describe('with nothing painted, the world is the world', () => {
  it('leaves the authored map bit for bit at 500 probes', () => {
    const points = probes(500);
    const before = points.map(([x, z]) => ({
      h: terrainHeight(x, z),
      n: terrainNormal(x, z),
      w: isWater(x, z),
      s: sampleLandscape(x, z),
    }));
    const colliders = waterColliders().length;

    // Install, use, remove — the state is the only thing that could leak.
    setPaintedWater(islandField(1));
    terrainHeight(POND.x, POND.z);
    waterColliders();
    setPaintedWater(null);

    points.forEach(([x, z], i) => {
      const was = before[i]!;
      expect(terrainHeight(x, z), `${x},${z}`).toBe(was.h);
      expect(terrainNormal(x, z), `${x},${z}`).toEqual(was.n);
      expect(isWater(x, z), `${x},${z}`).toBe(was.w);
      expect(sampleLandscape(x, z), `${x},${z}`).toEqual(was.s);
    });
    expect(waterColliders().length).toBe(colliders);
  });

  it('leaves the plain flat, dry and empty', () => {
    inPlain(() => {
      for (const [x, z] of probes(500)) {
        expect(terrainHeight(x, z), `${x},${z}`).toBe(0);
        expect(terrainNormal(x, z)).toEqual({ x: 0, y: 1, z: 0 });
        expect(isWater(x, z)).toBe(false);
        expect(sampleLandscape(x, z)).toEqual({
          forest: 0,
          mountain: 0,
          water: false,
          island: false,
          region: 'plain',
          // Nothing is painted with a PLANTING brush in this file, so every
          // weight is 0 (src/world/painted.ts, the environment brush kit).
          planting: zeroPlanting(),
        });
      }
      expect(waterColliders().length).toBe(0);
    });
  });
});

// ── the basin ────────────────────────────────────────────────────────────────

describe('the painted basin — on the authored map', () => {
  const LEVEL = 1;

  it('is exactly the level everywhere inside the shore', () => {
    setPaintedWater(discField(LEVEL));
    expect(terrainHeight(POND.x, POND.z)).toBe(LEVEL);
    for (const [x, z] of insidePond(200)) {
      expect(discShore(x, z)).toBeGreaterThanOrEqual(0);
      expect(terrainHeight(x, z), `${x.toFixed(2)},${z.toFixed(2)}`).toBeCloseTo(LEVEL, 9);
    }
  });

  it('cuts the authored basin maths, point for point, out to the ramp', () => {
    const land = new Map<string, number>();
    const points: [number, number][] = [];
    for (let i = 0; i < 240; i++) {
      const th = (i / 24) * Math.PI * 2;
      const out = -POND.r + (Math.floor(i / 24) + 0.5) * ((POND.r + shoreRamp() + 4) / 10);
      const d = POND.r + out;
      const x = POND.x + Math.cos(th) * d;
      const z = POND.z + Math.sin(th) * d;
      points.push([x, z]);
      land.set(`${x},${z}`, terrainHeight(x, z));
    }
    setPaintedWater(discField(LEVEL));
    for (const [x, z] of points) {
      const out = -discShore(x, z);
      expect(terrainHeight(x, z), `${x.toFixed(2)},${z.toFixed(2)}`).toBeCloseTo(
        basin(land.get(`${x},${z}`)!, LEVEL, out),
        9,
      );
    }
  });

  it('holds the rim above the waterline and releases it by the ramp', () => {
    const ring1: [number, number][] = [];
    const past: [number, number][] = [];
    for (let i = 0; i < 180; i++) {
      const th = (i / 180) * Math.PI * 2;
      ring1.push([POND.x + Math.cos(th) * (POND.r + 1), POND.z + Math.sin(th) * (POND.r + 1)]);
      const d = POND.r + shoreRamp() + 1;
      past.push([POND.x + Math.cos(th) * d, POND.z + Math.sin(th) * d]);
    }
    const authored = past.map(([x, z]) => terrainHeight(x, z));
    const authoredRim = ring1.map(([x, z]) => terrainHeight(x, z));
    setPaintedWater(discField(LEVEL));

    // One unit out is inside `basinRim`, so the ground is never below the
    // water beside it…
    let heldExactly = 0;
    ring1.forEach(([x, z], i) => {
      const h = terrainHeight(x, z);
      expect(h, `${x.toFixed(2)},${z.toFixed(2)}`).toBeGreaterThanOrEqual(LEVEL - 1e-9);
      // …and where the authored land would fall BELOW the level, the rim
      // guard holds it at exactly the level.
      if (authoredRim[i]! < LEVEL) {
        expect(h).toBeCloseTo(LEVEL, 9);
        heldExactly++;
      }
    });
    expect(heldExactly).toBeGreaterThan(0);

    // Past the ramp the painted body has no say at all.
    past.forEach(([x, z], i) => {
      expect(terrainHeight(x, z), `${x.toFixed(2)},${z.toFixed(2)}`).toBe(authored[i]!);
    });
  });

  it('climbs out under the field slope bound', () => {
    setPaintedWater(discField(LEVEL));
    let worst = 0;
    for (let a = 0; a < 4; a++) {
      const th = (a / 4) * Math.PI * 2;
      for (let d = 0; d <= POND.r + shoreRamp() + 4; d += 0.5) {
        const x = POND.x + Math.cos(th) * d;
        const z = POND.z + Math.sin(th) * d;
        const gx = terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z);
        const gz = terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5);
        worst = Math.max(worst, Math.hypot(gx, gz));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.6);
  });
});

describe('the painted basin — on the plain', () => {
  /** A pond sunk into the flat field: the floor is below the paper and the
   * land climbs from it back up to zero. */
  const SUNK = -1.5;
  /** …and one standing above it: the paper is BELOW the waterline, so the rim
   * guard holds the first stride of bank up at the level instead. */
  const RAISED = 1;

  it('sinks a flat basin at the level and ramps back to the paper', () => {
    inPlain(() => {
      setPaintedWater(discField(SUNK));
      expect(terrainHeight(POND.x, POND.z)).toBe(SUNK);
      for (const [x, z] of insidePond(200)) {
        expect(terrainHeight(x, z), `${x.toFixed(2)},${z.toFixed(2)}`).toBeCloseTo(SUNK, 9);
      }
      // The flat field is 0 everywhere, so the whole ramp is arithmetic.
      for (let out = 0; out <= shoreRamp() + 4; out += 0.25) {
        const d = POND.r + out;
        const h = terrainHeight(POND.x + d, POND.z);
        expect(h, `out ${out}`).toBeCloseTo(basin(0, SUNK, out), 9);
        expect(h).toBeGreaterThanOrEqual(SUNK - 1e-9);
      }
      expect(terrainHeight(POND.x + POND.r + shoreRamp() + 1, POND.z)).toBe(0);
    });
  });

  it('climbs monotonically out of a sunk pond along every ray', () => {
    inPlain(() => {
      setPaintedWater(discField(SUNK));
      for (let a = 0; a < 4; a++) {
        const th = (a / 4) * Math.PI * 2;
        let prev = -Infinity;
        let worst = 0;
        for (let d = 0; d <= POND.r + shoreRamp() + 4; d += 0.5) {
          const x = POND.x + Math.cos(th) * d;
          const z = POND.z + Math.sin(th) * d;
          const h = terrainHeight(x, z);
          expect(h, `ray ${a} at ${d}`).toBeGreaterThanOrEqual(prev - 1e-12);
          prev = h;
          const gx = terrainHeight(x + 0.5, z) - terrainHeight(x - 0.5, z);
          const gz = terrainHeight(x, z + 0.5) - terrainHeight(x, z - 0.5);
          worst = Math.max(worst, Math.hypot(gx, gz));
        }
        expect(worst).toBeLessThanOrEqual(0.6);
      }
    });
  });

  it('holds the bank up to a raised waterline over the rim band', () => {
    inPlain(() => {
      setPaintedWater(discField(RAISED));
      expect(terrainHeight(POND.x, POND.z)).toBe(RAISED);
      // The paper (0) is below the level, so `max(blended, level)` is the
      // level for the whole rim band — a bank, not an overflow.
      for (let out = 0; out <= basinRim(); out += 0.1) {
        expect(terrainHeight(POND.x + POND.r + out, POND.z), `out ${out}`).toBeCloseTo(RAISED, 9);
      }
      for (let out = 0; out <= shoreRamp() + 4; out += 0.25) {
        expect(terrainHeight(POND.x + POND.r + out, POND.z), `out ${out}`).toBeCloseTo(
          basin(0, RAISED, out),
          9,
        );
      }
      expect(terrainHeight(POND.x + POND.r + shoreRamp() + 1, POND.z)).toBe(0);
    });
  });
});

// ── the water tests ──────────────────────────────────────────────────────────

describe('isWater answers for painted water', () => {
  it('is true inside the pond and false outside, in both modes', () => {
    const check = (): void => {
      setPaintedWater(discField(0));
      for (const [x, z] of insidePond(120)) expect(isWater(x, z)).toBe(true);
      for (let i = 0; i < 120; i++) {
        const th = (i / 120) * Math.PI * 2;
        const d = POND.r + 0.5;
        expect(isWater(POND.x + Math.cos(th) * d, POND.z + Math.sin(th) * d)).toBe(false);
      }
      setPaintedWater(null);
    };
    check();
    inPlain(check);
  });

  it('grows and shrinks the body exactly by the pad', () => {
    inPlain(() => {
      setPaintedWater(discField(0));
      for (let i = 0; i < 60; i++) {
        const th = (i / 60) * Math.PI * 2;
        const out = (d: number): [number, number] => [
          POND.x + Math.cos(th) * d,
          POND.z + Math.sin(th) * d,
        ];
        // 1.5 units outside the shore is inside the body grown by 2…
        expect(isWater(...out(POND.r + 1.5), 2)).toBe(true);
        expect(isWater(...out(POND.r + 1.5))).toBe(false);
        // …and 1.5 units inside it is outside the body shrunk by 2.
        expect(isWater(...out(POND.r - 1.5), -2)).toBe(false);
        expect(isWater(...out(POND.r - 1.5))).toBe(true);
      }
    });
  });

  it('reads the island out of the body as land', () => {
    inPlain(() => {
      setPaintedWater(islandField(0));
      expect(isWater(ISLE.x, ISLE.z)).toBe(false);
      for (let i = 0; i < 60; i++) {
        const th = (i / 60) * Math.PI * 2;
        expect(isWater(ISLE.x + Math.cos(th) * 1.5, ISLE.z + Math.sin(th) * 1.5)).toBe(false);
        // …and the ring of water round it still is water.
        const d = ISLE.r + 1.5;
        expect(isWater(ISLE.x + Math.cos(th) * d, ISLE.z + Math.sin(th) * d)).toBe(true);
      }
    });
  });
});

describe('sampleLandscape reports painted water on the plain', () => {
  it('calls the pond water and everything else plain', () => {
    inPlain(() => {
      setPaintedWater(discField(0));
      for (const [x, z] of insidePond(120)) {
        expect(sampleLandscape(x, z)).toEqual({
          forest: 0,
          mountain: 0,
          water: true,
          island: false,
          region: 'water',
          // Nothing is painted with a PLANTING brush in this file, so every
          // weight is 0 (src/world/painted.ts, the environment brush kit).
          planting: zeroPlanting(),
        });
      }
      for (const [x, z] of probes(200)) {
        if (isWater(x, z)) continue;
        expect(sampleLandscape(x, z)).toEqual({
          forest: 0,
          mountain: 0,
          water: false,
          island: false,
          region: 'plain',
          // Nothing is painted with a PLANTING brush in this file, so every
          // weight is 0 (src/world/painted.ts, the environment brush kit).
          planting: zeroPlanting(),
        });
      }
    });
  });
});

describe('terrainNormal on a painted plain', () => {
  it('leans on the bank and stands straight up away from it', () => {
    inPlain(() => {
      setPaintedWater(discField(-1.5));
      // Halfway up the climb-out: real ground, so a real slope.
      const n = terrainNormal(POND.x + POND.r + shoreRamp() * 0.5, POND.z);
      expect(n.y).toBeLessThan(1);
      expect(Math.hypot(n.x, n.z)).toBeGreaterThan(0.01);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
      // Far from the pond the paper is paper again — but it is a MEASURED
      // flat, not the straight-up early return, which the field switches off.
      const far = terrainNormal(120, 120);
      expect(far).toEqual({ x: -0, y: 1, z: -0 });
    });
  });
});

// ── physics ──────────────────────────────────────────────────────────────────

describe('waterColliders tiles painted bodies', () => {
  it('fills the pond with hard circles and keeps them off the land', () => {
    inPlain(() => {
      const field = discField(0);
      setPaintedWater(field);
      const circles = waterColliders();
      expect(circles.length).toBeGreaterThan(10);
      for (const c of circles) {
        expect(c.hard).toBe(true);
        expect(c.r).toBe(WATER_COLLIDER_R);
        // Kept only where the body shrunk by R - bite still holds water, so
        // the worst protrusion onto land is exactly `bite`.
        expect(field.shore(c.x, c.z)).toBeGreaterThan(WATER_COLLIDER_R - WATER_COLLIDER_BITE);
        expect(WATER_COLLIDER_R - field.shore(c.x, c.z)).toBeLessThanOrEqual(
          WATER_COLLIDER_BITE + 1e-12,
        );
      }
      // The grid is anchored on the bounds centre, so the middle of a pond
      // always gets one.
      expect(circles.some((c) => c.x === POND.x && c.z === POND.z)).toBe(true);
    });
  });

  it('leaves the island in the middle of a body unblocked', () => {
    inPlain(() => {
      setPaintedWater(islandField(0));
      const circles = waterColliders();
      expect(circles.length).toBeGreaterThan(4);
      for (const c of circles) {
        expect(Math.hypot(c.x - ISLE.x, c.z - ISLE.z)).toBeGreaterThan(ISLE.r);
      }
    });
  });

  it('adds to the authored tiling in the landscape mode rather than replacing it', () => {
    const authored = waterColliders().length;
    setPaintedWater(discField(0));
    const both = waterColliders();
    expect(both.length).toBeGreaterThan(authored);
    expect(both.some((c) => discShore(c.x, c.z) > WATER_COLLIDER_R - WATER_COLLIDER_BITE)).toBe(
      true,
    );
  });
});

// ── shorelines ───────────────────────────────────────────────────────────────

describe('paintedShoreSamples', () => {
  it('is empty with no field installed', () => {
    expect(paintedShoreSamples()).toEqual([]);
  });

  it('lands every sample on dry ground beside the water it borders', () => {
    inPlain(() => {
      setPaintedWater(discField(0));
      const samples = paintedShoreSamples();
      // A ring of 56.5 units at 2.2 spacing.
      expect(samples.length).toBeGreaterThan(20);
      for (const s of samples) {
        expect(isWater(s.x, s.z), `${s.x.toFixed(2)},${s.z.toFixed(2)}`).toBe(false);
        expect(Math.hypot(s.nx, s.nz)).toBeCloseTo(1, 12);
        // Dry, but only just: a reed planted here borders the pond.
        expect(discShore(s.x, s.z)).toBeGreaterThan(-SHORE_SPACING);
        // The normal points AWAY from the water: a step along it is a step
        // further from the shore.
        expect(discShore(s.x + s.nx, s.z + s.nz)).toBeLessThan(discShore(s.x, s.z));
      }
    });
  });

  it('walks an island ring inward, off the water and onto the island', () => {
    inPlain(() => {
      setPaintedWater(islandField(0));
      const samples = paintedShoreSamples();
      const inner = samples.filter((s) => Math.hypot(s.x - ISLE.x, s.z - ISLE.z) < ISLE.r + 1);
      expect(inner.length).toBeGreaterThan(8);
      for (const s of inner) {
        expect(isWater(s.x, s.z)).toBe(false);
        // Toward the island's own centre — the flipped normal of a hole ring.
        const toCentre = Math.hypot(ISLE.x - s.x, ISLE.z - s.z);
        const stepped = Math.hypot(ISLE.x - (s.x + s.nx), ISLE.z - (s.z + s.nz));
        expect(stepped).toBeLessThan(toCentre);
      }
      // Both rings are walked, not just the outer one.
      expect(samples.length).toBeGreaterThan(inner.length + 10);
    });
  });
});

// ── ripples ──────────────────────────────────────────────────────────────────

describe('paintedRippleSpots', () => {
  const body = (): PaintedBody => discField(0).bodies[0]!;

  it('keeps every mark clear of the shore, and repeats exactly', () => {
    const spots = paintedRippleSpots(body(), discShore);
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) {
      expect(discShore(s.x, s.z)).toBeGreaterThanOrEqual(RIPPLE_MARGIN);
      expect(s.len).toBeGreaterThanOrEqual(0.6);
      expect(s.rot).toBeGreaterThanOrEqual(0);
      expect(s.rot).toBeLessThan(Math.PI * 2);
    }
    expect(paintedRippleSpots(body(), discShore)).toEqual(spots);
  });

  it('honours a wider margin, and gives up past the pond radius entirely', () => {
    const wide = paintedRippleSpots(body(), discShore, 4);
    for (const s of wide) expect(discShore(s.x, s.z)).toBeGreaterThanOrEqual(4);
    expect(wide.length).toBeLessThanOrEqual(paintedRippleSpots(body(), discShore).length);
    expect(paintedRippleSpots(body(), discShore, POND.r + 1)).toEqual([]);
  });

  it('keeps its marks out of an island as well as off the shore', () => {
    const isle = islandField(0).bodies[0]!;
    for (const s of paintedRippleSpots(isle, isleShore, 1)) {
      expect(Math.hypot(s.x - ISLE.x, s.z - ISLE.z)).toBeGreaterThan(ISLE.r + 1 - 1e-12);
    }
  });
});

// ── scatter ──────────────────────────────────────────────────────────────────

describe('scatter lines a painted shore and stays out of the water', () => {
  it('plants reeds along the painted shore and nothing at all in the pond', () => {
    inPlain(() => {
      expect(computePlacements().filter((p: Placement) => p.kind === 'reed')).toEqual([]);
      setPaintedWater(discField(-1.5));
      const placed = computePlacements();
      const reeds = placed.filter((p) => p.kind === 'reed');
      expect(reeds.length).toBeGreaterThan(3);
      for (const r of reeds) {
        expect(isWater(r.x, r.z)).toBe(false);
        // Within a couple of units of the waterline: a fringe, not a field.
        const off = -discShore(r.x, r.z);
        expect(off, `reed at ${r.x.toFixed(1)},${r.z.toFixed(1)}`).toBeLessThan(2);
      }
      for (const p of placed) expect(isWater(p.x, p.z), p.kind).toBe(false);
    });
  });

  it('leaves the authored placement byte-identical once the field is gone', () => {
    inPlain(() => {
      const before = createScatter();
      const trees = before.positions().filter((p) => p.kind === 'tree');
      before.dispose();
      expect(trees.length).toBeGreaterThan(0);

      setPaintedWater(discField(-1.5));
      const wet = createScatter();
      try {
        // Nothing stands in the painted pond…
        for (const p of wet.positions()) expect(isWater(p.x, p.z), p.kind).toBe(false);
        // …and the pond has cost the plain a few of its props.
        expect(wet.positions().filter((p) => p.kind === 'tree').length).toBeLessThanOrEqual(
          trees.length,
        );
        expect(wet.group.getObjectByName('reeds')?.children.length ?? 0).toBeGreaterThan(0);
      } finally {
        wet.dispose();
      }

      setPaintedWater(null);
      const after = createScatter();
      try {
        expect(after.positions().filter((p) => p.kind === 'tree')).toEqual(trees);
        // The reeds went with the water they lined.
        expect(computePlacements().filter((p) => p.kind === 'reed')).toEqual([]);
        expect(after.group.getObjectByName('reeds')?.children.length ?? 0).toBe(0);
      } finally {
        after.dispose();
      }
    });
  });
});
