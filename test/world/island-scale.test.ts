/**
 * The island is `MAP_SCALE` TIMES THE AUTHORED ONE — every field that has to
 * cover it, and the plain world that must not have moved.
 *
 * The scale has moved four times: 2 on 2026-09-16 (*"make the island twice
 * as big"*), then 1.3 and 1.1 on 2026-09-17 (*"the map is way too big, let's
 * reduce its size by 35%"*, then *"I still think this island is way too big,
 * let's reduce it by another 15%"*), and then **1.32** the same day the other
 * way (*"map is now too small, let's increase the size of the island by
 * 20%"*). NOTHING IN THIS FILE SPELLS THE SCALE OUT except the one assertion
 * that pins `MAP_SCALE` itself: every expectation below is written against
 * `MAP_SCALE` or measured off the geography, so the next change is one number
 * in src/world/landscape.ts and a re-measure of the handful of numbers that
 * are genuinely measured (the steepest slope, the coast's reach, and the one
 * pond that has to step off a riser) rather than an edit to every `it`.
 *
 * `test/world/island.test.ts` measures the coast's own geometry. This file
 * measures the RING OF CONSUMERS around it: the displaced ground field, the
 * three geography bakes, the blade field's base span, the scatter's extent,
 * the physics heightfield, the spawn disc, the minimap and the camera. Each of
 * them was sized for a 150-radius island, and each of them has to hold a
 * `150 · MAP_SCALE` one — and hold it at the same RESOLUTION, because a texel
 * or a quad that grew with the map would have quietly coarsened the picture
 * instead of enlarging it.
 *
 * …and the other half of the bargain, which is the reason every number here
 * goes through `mapScale`: with the island off, every single one of them is
 * the number the public world shipped with. That block is at the bottom and it
 * is the one that keeps the katamari ruling honest (CLAUDE.md: meridian and
 * the public world are byte-identical and behaviourally unchanged).
 *
 * Pure: no WebGL, no DOM. The one thing built here is nothing — every field
 * below is a number, which is exactly why they can all be checked at once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnRadius, spawnSpot, SPAWN_RADIUS } from '../../src/creatures/manager';
import { heightfieldSegments, HEIGHTFIELD_SEGMENTS } from '../../src/physics/world';
import { setRenderTier } from '../../src/world/device';
import { worldMapExtent, WORLD_MAP_EXTENT } from '../../src/ui/minimap';
import {
  cameraDistance,
  cameraFar,
  CAMERA_DISTANCE,
  CAMERA_FAR,
  FRUSTUM_HEIGHT,
  panLimitFor,
  zoomMinFor,
} from '../../src/world/camera';
import {
  fieldQuad,
  fieldSegments,
  fieldSize,
  groundRadius,
  FIELD_SEGMENTS,
  FIELD_SEGMENTS_PHONE_ISLAND,
  FIELD_SIZE,
  GROUND_RADIUS,
  riserRun,
} from '../../src/world/field';
import { grassBaseSpan, GRASS_BASE_SPAN } from '../../src/world/ghibli/grass';
import { heightRes, heightSize, HEIGHT_RES } from '../../src/world/ghibli/height';
import { regionRes, regionSize, REGION_RES } from '../../src/world/ghibli/region';
import { shoreRes, shoreSize, SHORE_RES } from '../../src/world/ghibli/shore';
import {
  coastInland,
  coastRadius,
  farFieldEnd,
  farFieldStart,
  isWater,
  islandOutlinePoints,
  mapScale,
  outlinePoints,
  setIslandMode,
  setLandscapeMode,
  FOREST_BLOBS,
  ISLAND,
  ISLAND_LOBES,
  MAP_SCALE,
  MOUNTAIN_BLOBS,
  TERRAIN,
  WATER_BODIES,
  coastOutlinePoints,
} from '../../src/world/landscape';
import { scatterExtent, SCATTER_EXTENT } from '../../src/world/scatter';

const TAU = Math.PI * 2;
const ISO_SIN = Math.sin(Math.atan(1 / Math.SQRT2));

/**
 * An authored number through the scale — and the reason it is a helper and not
 * a `*`: `MAP_SCALE` is 1.32 and 1.32 is not exact in binary, so `-55 * 1.32`
 * is -72.60000000000001 and `toEqual` on a spelled-out literal fails on the
 * last bit. Everything scaled below is compared with `toBeCloseTo` at 9 places,
 * which is far tighter than any of these numbers means and still immune to
 * the float.
 */
const K = (n: number): number => n * MAP_SCALE;

/** …and the same for a list of authored [x, z, r] triples.
 *
 * `offsets` are UNSCALED world units added after the scale — the `islandNudge`
 * a body may carry (src/world/landscape.ts), which is a distance on the ground
 * and not a proportion of the map. Omitted, nothing is added, which is every
 * list here but the ponds'. */
function closeTriples(
  got: readonly number[][],
  authored: readonly number[][],
  offsets: readonly number[][] = [],
): void {
  expect(got.length).toBe(authored.length);
  authored.forEach((want, i) => {
    want.forEach((n, j) => {
      expect(got[i]![j], `[${i}][${j}]`).toBeCloseTo(K(n) + (offsets[i]?.[j] ?? 0), 9);
    });
  });
}

/** The coast's own reach, measured off the geography rather than restated. */
function coastReach(): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < 1440; i++) {
    const r = coastRadius((i / 1440) * TAU);
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  return { min, max };
}

/** Largest |x| or |z| the coast reaches — what a SQUARE field has to hold,
 * which is a smaller number than the radius. */
function coastBox(): number {
  let box = 0;
  for (let i = 0; i < 1440; i++) {
    const th = (i / 1440) * TAU;
    const r = coastRadius(th);
    box = Math.max(box, Math.abs(Math.cos(th) * r), Math.abs(Math.sin(th) * r));
  }
  return box;
}

describe('the scaled island — the geography', () => {
  beforeAll(() => {
    setLandscapeMode('landscape');
    setIslandMode(true);
  });
  afterAll(() => {
    setLandscapeMode('plain');
    setIslandMode(false);
  });

  it('scales the coast about the origin, exactly', () => {
    // THE ONE PLACE THE SCALE IS SPELLED OUT. 1.32 since 2026-09-17 (it was
    // 2, then 1.3, then 1.1 — a room of 50-80 people did not need the doubled
    // map — and then 1.1 x 1.2 the same day, *"map is now too small, let's
    // increase the size of the island by 20%"*). Everything else in this file
    // reads it.
    expect(MAP_SCALE).toBe(1.32);
    expect(mapScale()).toBe(MAP_SCALE);
    expect(ISLAND.r).toBeCloseTo(K(150), 9);
    expect(ISLAND.x).toBe(0);
    expect(ISLAND.z).toBe(0);
    expect(ISLAND_LOBES[0]).toBe(ISLAND);
    // The authored lobes, scaled — centre AND radius, so the union keeps the
    // shape it was tuned to and only its size changes.
    closeTriples(
      ISLAND_LOBES.map((l) => [l.x, l.z, l.r]),
      [
        [0, 0, 150],
        [7, -39, 115],
        [35, 35, 114],
        [-56, 21, 90],
      ],
    );
    expect(ISLAND_LOBES.map((l) => l.seed)).toEqual([501, 505, 511, 521]);
    // Measured: exactly `MAP_SCALE` times the authored 131.67 .. 176.26,
    // because the wobble phases key off a blob's SEED and the polar angle and
    // both survive a uniform scale about the origin. 173.80 .. 232.66 at 1.32.
    const { min, max } = coastReach();
    expect(min).toBeCloseTo(K(131.67), 1);
    expect(max).toBeCloseTo(K(176.26), 1);
  });

  it('moves the authored features out with it, and keeps a pond a pond', () => {
    // A region scales WHOLE — centre and radius — because it has to stay one
    // readable mass (the four mountain masses overlap by ~5 units, and
    // scaling the centres alone would have opened gaps between them).
    closeTriples(
      FOREST_BLOBS.map((b) => [b.x, b.z, b.r]),
      [
        [-95, 20, 40],
        [-60, 55, 18],
      ],
    );
    closeTriples(
      MOUNTAIN_BLOBS.map((b) => [b.x, b.z, b.r]),
      [
        [-50, -105, 24],
        [-5, -118, 26],
        [40, -112, 24],
        [80, -90, 20],
      ],
    );
    // The lake scales whole too — centre and radius together.
    const lake = WATER_BODIES[0]!;
    closeTriples([[lake.x, lake.z, lake.r]], [[80, 70, 42]]);
    // …and it has NO ISLET to scale with it (2026-09-17, user ask —
    // src/world/landscape.ts `LAKE_ISLET_ON_ISLAND`): the islet used to scale
    // with its lake, because the ring of water between them is a measured
    // pair, and the island map simply has no islet in its lake now. The
    // AUTHORED one is untouched — the parity block at the bottom of this file
    // reads it back, centre, radius and seed.
    expect(lake.island).toBeUndefined();
    // …and a POND only moves: it is a physical thing you stand beside, not a
    // proportion of the map. Its RADIUS is the authored one at every scale,
    // which is why it is not run through `K` here.
    //
    // THE FIRST POND CARRIES AN `islandNudge` ON TOP OF THE SCALE
    // (2026-09-17, src/world/landscape.ts): (+5, +5) world units, added after
    // the scale and only on a scaled map, because everywhere in the band
    // 1.28-1.35 the scaled centre lands straddling a terrace riser and the
    // basin-shoulder bound in test/world/landscape.test.ts reads 0.478
    // against 0.6. It is UNSCALED here for the same reason a pond's radius is:
    // it is a distance on the ground, not a proportion of the map.
    closeTriples(
      WATER_BODIES.slice(1).map((b) => [b.x, b.z]),
      [
        [15, -55],
        [-25, 95],
        [85, -35],
        [-95, -58],
      ],
      [
        [5, 5],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    );
    expect(WATER_BODIES.slice(1).map((b) => b.r)).toEqual([6, 6, 7, 6]);
    // Every authored feature is still on the island, with dry land to spare
    // (test/world/island.test.ts measures the clearance itself).
    for (const b of [...FOREST_BLOBS, ...MOUNTAIN_BLOBS, ...WATER_BODIES]) {
      expect(coastInland(b.x, b.z), `feature ${b.seed}`).toBeGreaterThan(0);
    }
  });

  it('keeps every width that is a physical thing at its authored size', () => {
    // The rule: a number scales when it says WHERE something is, and does not
    // when it says HOW BIG a physical thing is (src/world/landscape.ts
    // `MAP_SCALE`). These are the second kind.
    expect(TERRAIN.coastRamp).toBe(26);
    expect(TERRAIN.shoreRamp).toBe(16);
    expect(TERRAIN.basinRim).toBe(2);
    expect(TERRAIN.basinDrop).toBe(1.5);
    expect(TERRAIN.clearRadius).toBe(10);
    expect(TERRAIN.clearEdge).toBe(30);
    expect(TERRAIN.forestShelfFalloff).toBe(24);
    expect(TERRAIN.mountainShelfFalloff).toBe(70);
    expect(TERRAIN.octaves.map((o) => o.wavelength)).toEqual([60, 26]);
    // …and the far-field gate is the FIRST kind: it is the map's own rim and
    // has to stay outside the coast.
    expect(farFieldStart()).toBeCloseTo(TERRAIN.farStart * MAP_SCALE, 9);
    expect(farFieldEnd()).toBeCloseTo(TERRAIN.farEnd * MAP_SCALE, 9);
    expect(farFieldStart()).toBeGreaterThan(coastReach().min);
    expect(farFieldEnd()).toBeGreaterThan(coastReach().max);
  });

  it('walks every ring at the count its chords were picked for', () => {
    // A longer coastline drawn at the same vertex count would have stretched
    // the chord — so the counts ride the scale and the chords do not. ROUNDED,
    // because `MAP_SCALE` is not an integer: 211 / 106 / 70 at 1.1, and the
    // chord is held to within half a vertex instead of exactly.
    expect(coastOutlinePoints()).toBe(Math.round(192 * MAP_SCALE));
    expect(outlinePoints()).toBe(Math.round(96 * MAP_SCALE));
    expect(islandOutlinePoints()).toBe(Math.round(64 * MAP_SCALE));
    // …and every one of them is a whole number, which is the thing a
    // non-integer scale can break: a fractional count silently truncates in
    // the loop that walks it.
    for (const n of [coastOutlinePoints(), outlinePoints(), islandOutlinePoints()]) {
      expect(Number.isInteger(n)).toBe(true);
    }
    // The chord each count was picked for, held across the scale to within
    // the half-vertex the rounding costs: the coast's is 5.77 units at the
    // widest bearing either way (211 points at 1.1 against 192 authored, a
    // tenth of a percent apart).
    expect((TAU * coastReach().max) / coastOutlinePoints()).toBeCloseTo(
      (TAU * (coastReach().max / MAP_SCALE)) / 192,
      1,
    );
  });
});

describe('the scaled island — every field covers it', () => {
  beforeAll(() => {
    setLandscapeMode('landscape');
    setIslandMode(true);
  });
  afterAll(() => {
    setLandscapeMode('plain');
    setIslandMode(false);
  });

  it('displaces a ground field that holds the coast and its floor slope', () => {
    expect(fieldSize()).toBeCloseTo(FIELD_SIZE * MAP_SCALE, 9);
    // A SQUARE field, so what it has to hold is the coast's box and not its
    // radius — plus the shore ramp the sea floor falls away over, so the rim
    // really is one flat number (test/world/ground.test.ts seats the ring on
    // exactly that).
    expect(coastBox() + TERRAIN.shoreRamp).toBeLessThan(fieldSize() / 2);
  });

  it('keeps the QUAD, not the count — the terrace risers still read', () => {
    // The PROJECTION's field: the side rides the scale and so does the count,
    // so the quad is the one the risers were measured against. The count is
    // ROUNDED — a segment count has to be whole and `MAP_SCALE` is not — and
    // at 1.32 the rounding bites: 422.4 comes down to 422 over 528 units, so
    // the quad is 1.25118 rather than 1.25 (at 1.1 it came out whole, 352).
    expect(fieldSegments()).toBe(Math.round(FIELD_SEGMENTS * MAP_SCALE));
    expect(Number.isInteger(fieldSegments())).toBe(true);
    // HALF A SEGMENT, which is exactly what the rounding can cost and all this
    // allows: the quad is `fieldSize() / round(FIELD_SEGMENTS · k)`, so it can
    // miss the authored quad by half a segment's share of the side and no
    // more.
    const quadSlack = (FIELD_SIZE / FIELD_SEGMENTS) * (0.5 / fieldSegments());
    expect(Math.abs(fieldQuad() - FIELD_SIZE / FIELD_SEGMENTS)).toBeLessThanOrEqual(quadSlack);
    expect(Math.abs(fieldQuad() - 1.25)).toBeLessThanOrEqual(quadSlack);
    // PLAN §7.1's riser-height-error method, in one line: a 1.6-unit riser
    // climbs over the middle 60% of its step, so it takes
    // `0.96 / steepestSlope` units of run — and the quad has to be narrower
    // than that or it draws a wash instead of a line. The slope is MEASURED
    // per scale (`riserRun`, src/world/field.ts): 0.5037 at 1.32, so 1.906
    // units of run, against 2.101 at 1.1, 1.99 on the doubled map and 1.14 as
    // authored. It does not widen with the scale — the noise does not scale,
    // so which hummock is the steepest changes.
    expect(riserRun()).toBeCloseTo(1.906, 2);
    expect(fieldQuad()).toBeLessThan(riserRun());
    // …and the bound really is a bound: the 2.5-unit quad §7.1 rejected would
    // still be outside it at this scale.
    expect(FIELD_SIZE / 160).toBeGreaterThan(riserRun());
  });

  it('bakes the geography over the whole field, at the texel it was picked for', () => {
    for (const [name, size, res, authoredRes] of [
      ['region', regionSize(), regionRes(), REGION_RES],
      ['height', heightSize(), heightRes(), HEIGHT_RES],
      ['shore', shoreSize(), shoreRes(), SHORE_RES],
    ] as const) {
      // The span is the ground field's, so no land texel is off the edge…
      expect(size, name).toBe(fieldSize());
      expect(coastBox(), name).toBeLessThan(size / 2);
      // …and the resolution rides it, ROUNDED TO A WHOLE TEXEL COUNT — which
      // is the choice a non-integer `MAP_SCALE` forced (2026-09-17): round and
      // keep the texel, rather than step to the next power of two and halve
      // it. WebGL2 samples an NPOT texture at CLAMP + LINEAR without a
      // complaint, so the rounding costs nothing and the TEXEL is the thing
      // that is held.
      expect(res, name).toBe(Math.round(authoredRes * MAP_SCALE));
      expect(Number.isInteger(res), name).toBe(true);
      // The texel to within half a texel of the authored one — at 1.32 the
      // three land within 0.03% (0.78107 / 1.56213 / 3.12426 against 0.78125 /
      // 1.5625 / 3.125).
      expect(size / res, name).toBeCloseTo(FIELD_SIZE / authoredRes, 2);
    }
    // The resolutions this scale asks for, spelled out: 169² / 338² / 676²
    // over 528 units.
    expect([regionRes(), heightRes(), shoreRes()]).toEqual([
      Math.round(REGION_RES * MAP_SCALE),
      Math.round(HEIGHT_RES * MAP_SCALE),
      Math.round(SHORE_RES * MAP_SCALE),
    ]);
  });

  it('spans the base blade field over the island, budget unchanged', () => {
    expect(grassBaseSpan()).toBeCloseTo(GRASS_BASE_SPAN * MAP_SCALE, 9);
    // The base field is laid over a BOX, so the coast's box is what it has to
    // hold — and the map's own meadow weight decides which of those cells grow
    // anything (src/world/ghibli/grass.ts).
    expect(coastBox()).toBeLessThan(grassBaseSpan() / 2);
  });

  it('scatters props over the island at the density it always had', () => {
    expect(scatterExtent()).toBeCloseTo(SCATTER_EXTENT * MAP_SCALE, 9);
    // The GRID step is untouched, so the prop count per unit area is exactly
    // what it was and the extra placements are extra map rather than a denser
    // field (test/world/scatter.test.ts measures the density itself).
    //
    // The extent holds the coast's NEAREST reach, not its box: the scattered
    // square has always stopped a few units inside the extreme headlands
    // (168.66 against 160 as authored, 185.53 against 176 at 1.1) and the
    // relationship is exactly the one that shipped — it is a RATIO, so it is
    // the same number at every scale. What matters is that the props reach the
    // coast everywhere the coast is close, which they do.
    expect(scatterExtent()).toBeGreaterThan(coastReach().min);
    expect(coastBox() / scatterExtent()).toBeCloseTo(168.66 / 160, 3);
  });

  it('cuts the physics heightfield at the cell it was picked for', () => {
    expect(heightfieldSegments()).toBe(Math.round(HEIGHTFIELD_SEGMENTS * MAP_SCALE));
    expect(Number.isInteger(heightfieldSegments())).toBe(true);
    // Rounded, so the cell is held to within half a cell — 1.56213 at 1.32
    // against the authored 1.5625.
    expect(fieldSize() / heightfieldSegments()).toBeCloseTo(
      FIELD_SIZE / HEIGHTFIELD_SEGMENTS,
      2,
    );
  });

  it('spawns over the whole island, and never in the sea', () => {
    expect(spawnRadius()).toBeCloseTo(SPAWN_RADIUS * MAP_SCALE, 9);
    // Inside the far-field gate, where the authored geography is still at full
    // height — the same margin the authored 120 keeps inside 150.
    expect(spawnRadius()).toBeLessThan(farFieldStart());
    // …and inside the coast on every bearing, so no id can be dealt a spot at
    // sea: the spawn disc is a disc, and the coast's NEAREST reach is what has
    // to contain it.
    expect(spawnRadius()).toBeLessThan(coastReach().min);
    // The real thing, over a spread of ids: every spot is on dry land.
    for (let i = 0; i < 400; i++) {
      const spot = spawnSpot(`spawn-${i}`);
      expect(isWater(spot.x, spot.z), `spawn ${i} at ${spot.x},${spot.z}`).toBe(false);
      expect(coastInland(spot.x, spot.z), `spawn ${i}`).toBeGreaterThan(0);
      expect(Math.hypot(spot.x, spot.z)).toBeLessThanOrEqual(spawnRadius() + 1e-9);
    }
  });

  it('draws a minimap that contains the island', () => {
    expect(worldMapExtent()).toBeCloseTo(WORLD_MAP_EXTENT * MAP_SCALE, 9);
    expect(coastReach().max).toBeLessThan(worldMapExtent());
  });
});

/*
 * THE HANDSET'S OWN BUDGETS (2026-09-16).
 *
 * Four times the land at the same resolution is four times the CPU, and it is
 * a rebuild cost: every terrain dial, landscape switch and painted pond pays
 * it again. Measured on one node core the doubled island's terrain walk went
 * 906ms → 3625ms, which on a handset is seconds of blocked main thread — the
 * user's standing *"very slow to load"*. So the phone tier trades resolution
 * back where the trade is cheapest to look at, and the projection keeps every
 * number it had. `src/world/device.ts` `setRenderTier` is the one switch.
 */
describe('the scaled island — a handset trades resolution, not extent', () => {
  beforeAll(() => {
    setLandscapeMode('landscape');
    setIslandMode(true);
    setRenderTier('phone');
  });
  afterAll(() => {
    setRenderTier('projection');
    setLandscapeMode('plain');
    setIslandMode(false);
  });

  it('keeps the EXTENT — the phone reads the same map, not a smaller one', () => {
    // Nothing here may change what the map IS: the field's side, the bakes'
    // spans, the spawn disc, the minimap and the sea disc are the map, and a
    // phone and a projection have to agree about them to the unit or two
    // pages of the same room would disagree about where the coast is.
    expect(fieldSize()).toBeCloseTo(FIELD_SIZE * MAP_SCALE, 9);
    expect([regionSize(), heightSize(), shoreSize()]).toEqual([
      fieldSize(),
      fieldSize(),
      fieldSize(),
    ]);
    expect(spawnRadius()).toBeCloseTo(SPAWN_RADIUS * MAP_SCALE, 9);
    expect(worldMapExtent()).toBeCloseTo(WORLD_MAP_EXTENT * MAP_SCALE, 9);
    expect(groundRadius()).toBeCloseTo(GROUND_RADIUS * MAP_SCALE, 9);
    expect(grassBaseSpan()).toBeCloseTo(GRASS_BASE_SPAN * MAP_SCALE, 9);
    expect(scatterExtent()).toBeCloseTo(SCATTER_EXTENT * MAP_SCALE, 9);
  });

  it('cuts the field at 480 OR AT THE PROJECTION\'S OWN CUT, whichever is finer', () => {
    // `FIELD_SEGMENTS_PHONE_ISLAND` is a CEILING, not a substitute. It was
    // written for the doubled island, where the projection cut 640 and the
    // phone's 480 was a real saving (231k vertices against 411k). At 1.1 the
    // projection cuts 352, BELOW the ceiling, so the phone takes 352 too — a
    // phone must never pay MORE than the projection for a map that got
    // smaller (2026-09-17).
    const full = Math.round(FIELD_SEGMENTS * MAP_SCALE);
    expect(fieldSegments()).toBe(Math.min(FIELD_SEGMENTS_PHONE_ISLAND, full));
    expect(fieldSegments()).toBeLessThanOrEqual(full);
    expect(fieldQuad()).toBeGreaterThanOrEqual(FIELD_SIZE / FIELD_SEGMENTS);
    // The bound that matters, and the whole reason 480 is allowed where 320
    // is not: a quad wider than the riser's own run draws a wash instead of a
    // line (PLAN §7.1). Measured height error against the authored field over
    // 250,000 land samples in the camera's core: 0.112 u at 480 on the doubled
    // map against 0.066 u at 640 — a fourteenth of a tier step.
    expect(fieldQuad()).toBeLessThan(riserRun());
  });

  it('keeps the shore, region and heightfield at their authored resolutions', () => {
    // Every one of these is a COLOUR ramp or a collider, not where a blade
    // stands, so a coarser texel costs a softer edge rather than a thing in
    // the wrong place.
    expect(shoreRes()).toBe(SHORE_RES);
    expect(regionRes()).toBe(REGION_RES);
    expect(heightfieldSegments()).toBe(HEIGHTFIELD_SEGMENTS);
    // The texels that follow, stated so a future change has to face them:
    // each is the authored texel times the scale, because the phone holds the
    // COUNT and the span grew. At 1.1 the foam rim of 1.5–3 units is two to
    // three texels rather than four, and the heightfield's cell is 1.72 units
    // rather than 1.56 — both a good deal milder than the doubled map's 3.12.
    expect(shoreSize() / shoreRes()).toBeCloseTo(K(FIELD_SIZE / SHORE_RES), 4);
    expect(regionSize() / regionRes()).toBeCloseTo(K(FIELD_SIZE / REGION_RES), 4);
    expect(fieldSize() / heightfieldSegments()).toBeCloseTo(
      K(FIELD_SIZE / HEIGHTFIELD_SEGMENTS),
      4,
    );
  });

  it('leaves the HEIGHT bake alone — that one is where a blade stands', () => {
    // The one bake the phone does not trade down, and the reason is a kind
    // and not a size: `ggGroundAt` is read per blade to seat it on the ground,
    // so its error shows up as geometry (a blade floating over a tread or
    // buried in a riser) rather than as a soft edge. It is the biggest single
    // item left in the handset's terrain walk — 671ms of 1944ms measured — so
    // it is the next lever if one is needed, and it is deliberately not
    // pulled here.
    expect(heightRes()).toBe(Math.round(HEIGHT_RES * MAP_SCALE));
    expect(heightSize() / heightRes()).toBeCloseTo(FIELD_SIZE / HEIGHT_RES, 2);
  });

  it('is the field that shipped again with no island', () => {
    setIslandMode(false);
    try {
      expect(fieldSegments()).toBe(FIELD_SEGMENTS);
      expect(fieldQuad()).toBe(1.25);
      expect([regionRes(), heightRes(), shoreRes()]).toEqual([128, 256, 512]);
      expect(heightfieldSegments()).toBe(256);
    } finally {
      setIslandMode(true);
    }
  });
});

describe('the scaled island — the camera still frames it', () => {
  beforeAll(() => setIslandMode(true));
  afterAll(() => setIslandMode(false));

  /** World units of ground across and up the frame at a zoom. */
  const across = (aspect: number, zoom: number): number => (FRUSTUM_HEIGHT * aspect) / zoom;
  const up = (zoom: number): number => FRUSTUM_HEIGHT / zoom / ISO_SIN;

  it('holds the whole island at the zoom floor on a portrait phone and in 16:9', () => {
    const want = 2 * coastReach().max;
    for (const aspect of [390 / 844, 16 / 9]) {
      const zoom = zoomMinFor(aspect);
      expect(across(aspect, zoom), `aspect ${aspect}`).toBeGreaterThanOrEqual(want);
      expect(up(zoom), `aspect ${aspect}`).toBeGreaterThanOrEqual(want);
      // …and the pan is closed to nothing there, so it cannot be dragged out.
      expect(panLimitFor(aspect, zoom)).toBeCloseTo(0, 6);
    }
  });

  it('reaches the sea past the corner of that frame, so no void is drawn', () => {
    // THE RULE, and the one the sea disc's size is derived from: at the zoom
    // floor on a 390×844 phone the WIDTH binds, so the frame is ~4× the
    // coast's own radius up-screen of the island, and the sea has to cover the
    // far CORNER of it or the void shows. At the authored 1400 the corner of
    // the doubled island's floor frame landed outside the ring, which is why
    // `groundRadius` rides the map at all. Measured at 1.1: the corner is 818
    // units against a 1540-unit ring.
    for (const aspect of [390 / 844, 16 / 9]) {
      const zoom = zoomMinFor(aspect);
      const corner = Math.hypot(across(aspect, zoom) / 2, up(zoom) / 2);
      expect(corner, `aspect ${aspect}`).toBeLessThan(groundRadius());
    }
    expect(groundRadius()).toBeCloseTo(GROUND_RADIUS * MAP_SCALE, 9);
  });

  it('keeps the depth range past the sea on both sides of the target', () => {
    // THE RULE, not a table: the eye stands one `DEPTH_MARGIN` behind
    // everything drawable (the sea disc plus the whole pannable region) and
    // the far plane clears the same reach again on the other side of the
    // target. Both are derived in src/world/camera.ts from `groundRadius` and
    // the pan ceiling, so they follow `MAP_SCALE` with no number to re-take.
    expect(cameraDistance()).toBeGreaterThan(groundRadius());
    expect(cameraFar()).toBeGreaterThanOrEqual(cameraDistance() + groundRadius());
    // …and the arithmetic spelled out, so a change of scale has to face it:
    // the reach is the sea disc plus the pan ceiling, both `· MAP_SCALE`, and
    // the two margins are 200 each. At 1.1 the disc reaches 1540 and the
    // pannable region 220, so the reach is 1760, the eye stands at 1960 and
    // the far plane at 3920 (it was 3400 / 6800 on the doubled map).
    const reach = K(GROUND_RADIUS) + K(200);
    expect(cameraDistance()).toBeCloseTo(reach + 200, 9);
    expect(cameraFar()).toBeCloseTo(reach + 200 + reach + 200, 9);
  });

  it('lets the pan reach the far shore', () => {
    // The ceiling rides the map too: at 200 units a creature on the far coast
    // of a 352-unit island could not be framed at all.
    const reached = panLimitFor(390 / 844, 2.6);
    expect(reached).toBeGreaterThan(coastReach().min);
  });
});

describe('with the island off, every one of those fields is the shipped number', () => {
  // No `setIslandMode(true)` anywhere in this block: the module default is off
  // and that is exactly the state under test.
  it('is off, and says so', () => {
    expect(mapScale()).toBe(1);
  });

  it('leaves the authored layout the authored objects', () => {
    expect(ISLAND.r).toBe(150);
    expect(ISLAND_LOBES.map((l) => [l.x, l.z, l.r])).toEqual([
      [0, 0, 150],
      [7, -39, 115],
      [35, 35, 114],
      [-56, 21, 90],
    ]);
    expect(FOREST_BLOBS.map((b) => [b.x, b.z, b.r])).toEqual([
      [-95, 20, 40],
      [-60, 55, 18],
    ]);
    expect(MOUNTAIN_BLOBS.map((b) => [b.x, b.z, b.r])).toEqual([
      [-50, -105, 24],
      [-5, -118, 26],
      [40, -112, 24],
      [80, -90, 20],
    ]);
    expect(WATER_BODIES.map((b) => [b.kind, b.x, b.z, b.r])).toEqual([
      ['lake', 80, 70, 42],
      ['pond', 15, -55, 6],
      ['pond', -25, 95, 6],
      ['pond', 85, -35, 7],
      ['pond', -95, -58, 6],
    ]);
    expect(WATER_BODIES[0]!.island).toEqual({ x: 72, z: 62, r: 14, seed: 302 });
  });

  it('leaves every field, bake and extent exactly as it shipped', () => {
    expect(fieldSize()).toBe(400);
    expect(fieldSegments()).toBe(320);
    expect(fieldQuad()).toBe(1.25);
    expect(groundRadius()).toBe(1400);
    expect(cameraDistance()).toBe(CAMERA_DISTANCE);
    expect(cameraFar()).toBe(CAMERA_FAR);
    expect([regionRes(), heightRes(), shoreRes()]).toEqual([128, 256, 512]);
    expect([regionSize(), heightSize(), shoreSize()]).toEqual([400, 400, 400]);
    expect(grassBaseSpan()).toBe(360);
    expect(scatterExtent()).toBe(160);
    expect(spawnRadius()).toBe(120);
    expect(heightfieldSegments()).toBe(256);
    expect(worldMapExtent()).toBe(185);
    expect(farFieldStart()).toBe(150);
    expect(farFieldEnd()).toBe(185);
    expect(coastOutlinePoints()).toBe(192);
    expect(outlinePoints()).toBe(96);
    expect(islandOutlinePoints()).toBe(64);
  });

  it('re-points the layout both ways, so the flag is the only state there is', () => {
    // The exported layout is a LIVE BINDING that `setIslandMode` moves (see
    // `MAP_SCALE`). This is the contract a reader has to be able to rely on:
    // set the flag, then read — and setting it back gives the authored objects
    // themselves, not copies of them.
    const authored = ISLAND;
    setIslandMode(true);
    try {
      expect(ISLAND).not.toBe(authored);
      expect(ISLAND.r).toBeCloseTo(150 * MAP_SCALE, 9);
    } finally {
      setIslandMode(false);
    }
    expect(ISLAND).toBe(authored);
    expect(ISLAND.r).toBe(150);
  });
});
