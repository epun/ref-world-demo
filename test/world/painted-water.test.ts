/**
 * Painted water — the derivation, pure and headless.
 *
 * `deriveWater` (src/world/painted-water.ts) is the one genuinely new piece of
 * the painted world: an authored body of water is a blob with a wobbled
 * radius, so its shore, its ripples and its colliders all come from one
 * formula, but a painted body has no blob. Everything downstream of it — the
 * basin the ground cuts, the fill and the ribbon the water pass draws, the
 * reeds, the hex collider tiling — reads the shape back out of a signed
 * distance field and the rings traced off its zero contour, so what this file
 * pins is that those agree with the paint and with each other.
 *
 * Four things are load-bearing here and each has a block below.
 *
 * COMPONENTS. What counts as one body: 8-connected water (two texels touching
 * at a corner are one sheet), and the two size gates that keep a brush's
 * spatter from becoming geography — a droplet is culled back to `DRY`, a
 * pinhole is filled with the water it sits in. A body's surface is one plane,
 * so overlapping strokes at two levels equalise, and the LOWER wins.
 *
 * THE FIELD. `shore` is a real signed distance in world units, not a mask: it
 * reads the disc's radius at its centre, falls a unit a unit as you walk out,
 * and crosses zero half a texel off the paint — which is what lets the ground,
 * the ink and the colliders all find the same shoreline.
 *
 * THE RINGS. Counter-clockwise, both of them — the same convention as
 * `waterOutline` and `islandOutline`, so `(dz, −dx)` points onto land for a
 * shore and into the water for an island, which is what `walkShore` and the
 * fill builder rely on. An island is a hole in the component, and it stays a
 * hole. And the vertices really do sit on the contour: the tracer and the
 * sampler are the same field.
 *
 * THE MUTATION. `deriveWater` writes its tidying back into `map.water`,
 * because that array is the paint layer's own buffer and a cull the paint
 * could not see would come back on the next stroke.
 *
 * Maps here are small and square-unit: `res` texels over `res` world units, so
 * one texel is one unit and every tolerance below reads as texels.
 */

import { describe, expect, it } from 'vitest';
import { createPaintedMap, DRY, type PaintedMap } from '../../src/world/painted';
import {
  deriveWater,
  MIN_BODY_TEXELS,
  MIN_HOLE_TEXELS,
  PAINTED_SHORE_FAR,
  type PaintedBody,
} from '../../src/world/painted-water';

/** A map of `res` texels over `res` world units: one texel, one unit. */
function unitMap(res = 64): PaintedMap {
  return createPaintedMap(res, res);
}

/** World position of texel (tx, ty)'s centre. */
function centre(map: PaintedMap, tx: number, ty: number): [number, number] {
  const t = map.size / map.res;
  return [(tx + 0.5) * t - map.size / 2, (ty + 0.5) * t - map.size / 2];
}

/** Paint a disc of `level` — every texel whose centre is within `r` texels. */
function paintDisc(map: PaintedMap, cx: number, cy: number, r: number, level: number): void {
  stampDisc(map, cx, cy, r, level);
}

/** Drain a disc back to `DRY` — the dry hole a ring is painted as. */
function drainDisc(map: PaintedMap, cx: number, cy: number, r: number): void {
  stampDisc(map, cx, cy, r, DRY);
}

function stampDisc(map: PaintedMap, cx: number, cy: number, r: number, value: number): void {
  const { res } = map;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(res - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(res - 1, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) <= r) map.water[y * res + x] = value;
    }
  }
}

/** Paint an axis-aligned block of texels, inclusive of both corners. */
function paintBlock(
  map: PaintedMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  level: number,
): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map.water[y * map.res + x] = level;
}

/** `½Σ(x_i z_{i+1} − x_{i+1} z_i)` — positive counter-clockwise. */
function signedArea(ring: readonly [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The one body a single-body map is expected to have. */
function only(bodies: readonly PaintedBody[]): PaintedBody {
  expect(bodies.length).toBe(1);
  return bodies[0]!;
}

// ── components ───────────────────────────────────────────────────────────────

describe('painted water — what counts as one body', () => {
  it('turns a painted disc into a single body at the level it was painted', () => {
    const map = unitMap();
    paintDisc(map, 32, 32, 8, 2.5);
    const field = deriveWater(map);
    expect(field).not.toBeNull();
    const body = only(field!.bodies);

    expect(body.id).toBe(0);
    expect(body.level).toBe(2.5);
    // Area of the disc, to the texel grid's own accuracy.
    expect(body.texels).toBeGreaterThan(Math.PI * 64 * 0.9);
    expect(body.texels).toBeLessThan(Math.PI * 64 * 1.1);
    // One shore, wound counter-clockwise, and nothing standing in it.
    expect(body.holes).toEqual([]);
    expect(body.outline.length).toBeGreaterThan(16);
    expect(signedArea(body.outline)).toBeGreaterThan(0);
    // The seed is the first texel in raster order — the top of the disc.
    let firstWet = -1;
    for (let i = 0; i < map.water.length && firstWet < 0; i++) {
      if (map.water[i] !== DRY) firstWet = i;
    }
    expect(body.seed).toBe(firstWet);
  });

  it('bounds the disc within a texel of the paint', () => {
    const map = unitMap();
    paintDisc(map, 32, 32, 8, 1);
    const body = only(deriveWater(map)!.bodies);
    const [cx, cz] = centre(map, 32, 32);
    // The contour runs half a texel outside the outermost wet texel centre,
    // so the box is the disc's own box give or take a texel.
    for (const [got, want] of [
      [body.bounds.x0, cx - 8.5],
      [body.bounds.x1, cx + 8.5],
      [body.bounds.z0, cz - 8.5],
      [body.bounds.z1, cz + 8.5],
    ]) {
      expect(Math.abs(got! - want!)).toBeLessThan(1);
    }
  });

  it('joins two sheets that touch only at a corner — water is 8-connected', () => {
    // A diagonal seam is a join, not a gap: paint that just meets is one body,
    // the way a person who painted it would read it.
    const map = unitMap();
    paintBlock(map, 10, 10, 13, 13, 3);
    paintBlock(map, 14, 14, 17, 17, 3);
    expect(4 * 4).toBeGreaterThanOrEqual(MIN_BODY_TEXELS);
    const body = only(deriveWater(map)!.bodies);
    expect(body.texels).toBe(32);
    // …and it comes out as ONE closed shore round the pair, not two.
    expect(body.holes).toEqual([]);
    expect(signedArea(body.outline)).toBeGreaterThan(0);
  });

  it('keeps two separated discs apart, each answering with its own level', () => {
    const map = unitMap();
    paintDisc(map, 16, 32, 6, 1.5);
    paintDisc(map, 36, 32, 6, 4.25);
    const field = deriveWater(map)!;
    expect(field.bodies.length).toBe(2);
    const [a, b] = field.bodies as [PaintedBody, PaintedBody];
    expect(a.id).toBe(0);
    expect(b.id).toBe(1);
    expect(a.seed).not.toBe(b.seed);
    expect(a.level).toBe(1.5);
    expect(b.level).toBe(4.25);
    expect(field.level(...centre(map, 16, 32))).toBe(1.5);
    expect(field.level(...centre(map, 36, 32))).toBe(4.25);
    // Each body's shore is its own: the gap between them is dry.
    expect(field.shore(...centre(map, 26, 32))).toBeLessThan(0);
  });

  it('equalises overlapping strokes to the lower level, in the paint itself', () => {
    // Two strokes at different bank heights that ran together are one sheet,
    // and a sheet has one surface. The lower one wins — water finds the lower
    // basin, and it is the level that cannot flood the higher stroke's bank.
    const map = unitMap();
    paintDisc(map, 26, 32, 8, 5);
    paintDisc(map, 34, 32, 8, 2);
    const field = deriveWater(map)!;
    const body = only(field.bodies);
    expect(body.level).toBe(2);
    // …written back through the shared buffer, so the next stroke sees it.
    expect(map.water[32 * 64 + 26]).toBe(2);
    expect(map.water[32 * 64 + 34]).toBe(2);
    expect(field.level(...centre(map, 26, 32))).toBe(2);
  });

  it('culls a speck of spatter back to dry', () => {
    const map = unitMap();
    paintDisc(map, 32, 32, 8, 1);
    // Four texels off in the corner: a droplet off the brush, not a pond.
    paintBlock(map, 5, 5, 6, 6, 9);
    expect(4).toBeLessThan(MIN_BODY_TEXELS);
    const field = deriveWater(map)!;
    expect(field.bodies.length).toBe(1);
    expect(field.bodies[0]!.level).toBe(1);
    for (const i of [5 * 64 + 5, 5 * 64 + 6, 6 * 64 + 5, 6 * 64 + 6]) {
      expect(map.water[i]).toBe(DRY);
    }
  });

  it('fills a pinhole the brush missed, with the water round it', () => {
    const map = unitMap();
    paintDisc(map, 32, 32, 8, 1.25);
    paintBlock(map, 31, 31, 32, 32, DRY);
    expect(4).toBeLessThan(MIN_HOLE_TEXELS);
    const field = deriveWater(map)!;
    const body = only(field.bodies);
    expect(body.holes).toEqual([]);
    expect(map.water[31 * 64 + 31]).toBe(1.25);
    expect(map.water[32 * 64 + 32]).toBe(1.25);
    expect(field.shore(...centre(map, 32, 32))).toBeGreaterThan(0);
  });

  it('has nothing to say about a dry map, or about one that is all spatter', () => {
    expect(deriveWater(unitMap())).toBeNull();
    const specks = unitMap();
    paintBlock(specks, 4, 4, 5, 5, 2);
    paintBlock(specks, 40, 40, 41, 41, 2);
    expect(deriveWater(specks)).toBeNull();
    // …and the cull is in the paint, so nothing is left to resurrect.
    expect(Array.from(specks.water).every((v) => v === DRY)).toBe(true);
  });

  it('derives the same map to the same bodies, twice over', () => {
    const build = (): PaintedMap => {
      const map = unitMap();
      paintDisc(map, 22, 26, 7, 2);
      paintDisc(map, 44, 40, 9, -1.5);
      drainDisc(map, 44, 40, 3);
      paintBlock(map, 2, 60, 3, 61, 8);
      return map;
    };
    const one = deriveWater(build())!;
    const two = deriveWater(build())!;
    expect(one.bodies).toEqual(two.bodies);
    // Deriving an already-derived map is a fixed point, not a drift.
    const map = build();
    const first = deriveWater(map)!;
    const again = deriveWater(map)!;
    expect(again.bodies).toEqual(first.bodies);
  });
});

// ── the field ────────────────────────────────────────────────────────────────

describe('painted water — the signed distance to the shore', () => {
  const map = unitMap();
  paintDisc(map, 32, 32, 8, 0);
  const field = deriveWater(map)!;
  const [cx, cz] = centre(map, 32, 32);

  it('reads the disc radius at its centre', () => {
    expect(field.shore(cx, cz)).toBeCloseTo(7.5, 0);
    expect(Math.abs(field.shore(cx, cz) - 7.5)).toBeLessThan(0.6);
  });

  it('falls a unit a unit as you walk out onto land', () => {
    // The rim sits at ~8.5 texels from the centre (half a texel past the last
    // wet texel), so three texels beyond it is −3.
    const at = field.shore(cx + 11.5, cz);
    expect(Math.abs(at + 3)).toBeLessThan(0.7);
  });

  it('crosses zero within half a texel of the painted rim', () => {
    // Walk out along one bearing and find the crossing by bisection.
    let lo = 0;
    let hi = 20;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (field.shore(cx + mid, cz) > 0) lo = mid;
      else hi = mid;
    }
    expect(Math.abs((lo + hi) / 2 - 8.5)).toBeLessThan(0.5);
  });

  it('is far from any shore outside the map, and levels nothing there', () => {
    for (const [x, z] of [
      [map.size, 0],
      [0, -map.size],
      [1e5, 1e5],
    ] as [number, number][]) {
      expect(field.shore(x, z)).toBe(-PAINTED_SHORE_FAR);
      expect(field.level(x, z)).toBe(0);
    }
  });

  it('puts every outline vertex on the contour it was traced from', () => {
    // The tracer and the sampler read the same field, so a vertex is a zero of
    // it — within the corner-cutting pass's own reach.
    for (const [x, z] of field.bodies[0]!.outline) {
      expect(Math.abs(field.shore(x, z)), `${x},${z}`).toBeLessThan(0.75);
    }
  });
});

// ── the rings ────────────────────────────────────────────────────────────────

describe('painted water — islands are holes, and both rings wind the same way', () => {
  const map = unitMap();
  paintDisc(map, 32, 32, 12, 3);
  drainDisc(map, 32, 32, 3);
  const field = deriveWater(map)!;
  const body = only(field.bodies);
  const [cx, cz] = centre(map, 32, 32);

  it('leaves the island standing, as exactly one hole in one body', () => {
    expect(body.holes.length).toBe(1);
    expect(body.level).toBe(3);
  });

  it('winds the hole counter-clockwise like the outer shore, and smaller', () => {
    const outer = signedArea(body.outline);
    const inner = signedArea(body.holes[0]!);
    expect(outer).toBeGreaterThan(0);
    expect(inner).toBeGreaterThan(0);
    expect(inner).toBeLessThan(outer);
  });

  it('reads the island as land, still belonging to the water round it', () => {
    expect(field.shore(cx, cz)).toBeLessThan(0);
    // …and the level is still the lake's: the basin the ground cuts round the
    // island has to know what surface it is cutting to.
    expect(field.level(cx, cz)).toBe(3);
  });
});
