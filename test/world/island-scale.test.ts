/**
 * The island is TWICE AS BIG — every field that has to cover it, and the plain
 * world that must not have moved (2026-09-16, user ask: *"make the island
 * twice as big"*).
 *
 * `test/world/island.test.ts` measures the coast's own geometry. This file
 * measures the RING OF CONSUMERS around it: the displaced ground field, the
 * three geography bakes, the blade field's base span, the scatter's extent,
 * the physics heightfield, the spawn disc, the minimap and the camera. Each of
 * them was sized for a 150-radius island, and each of them has to hold a
 * 300-radius one — and hold it at the same RESOLUTION, because a texel or a
 * quad that grew with the map would have quietly coarsened the picture instead
 * of enlarging it.
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
  RISER_RUN,
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

describe('the doubled island — the geography', () => {
  beforeAll(() => {
    setLandscapeMode('landscape');
    setIslandMode(true);
  });
  afterAll(() => {
    setLandscapeMode('plain');
    setIslandMode(false);
  });

  it('scales the coast about the origin, exactly', () => {
    expect(MAP_SCALE).toBe(2);
    expect(mapScale()).toBe(MAP_SCALE);
    expect(ISLAND.r).toBe(150 * MAP_SCALE);
    expect(ISLAND.x).toBe(0);
    expect(ISLAND.z).toBe(0);
    expect(ISLAND_LOBES[0]).toBe(ISLAND);
    // The authored lobes, doubled — centre AND radius, so the union keeps the
    // shape it was tuned to and only its size changes.
    expect(ISLAND_LOBES.map((l) => [l.x, l.z, l.r, l.seed])).toEqual([
      [0, 0, 300, 501],
      [14, -78, 230, 505],
      [70, 70, 228, 511],
      [-112, 42, 180, 521],
    ]);
    // Measured: exactly twice the authored 131.67 .. 176.26, because the
    // wobble phases key off a blob's SEED and the polar angle and both survive
    // a uniform scale about the origin.
    const { min, max } = coastReach();
    expect(min).toBeCloseTo(263.34, 1);
    expect(max).toBeCloseTo(352.52, 1);
  });

  it('moves the authored features out with it, and keeps a pond a pond', () => {
    // A region scales WHOLE — centre and radius — because it has to stay one
    // readable mass (the four mountain masses overlap by ~5 units, and
    // doubling the centres alone would have opened 40-unit gaps).
    expect(FOREST_BLOBS.map((b) => [b.x, b.z, b.r])).toEqual([
      [-190, 40, 80],
      [-120, 110, 36],
    ]);
    expect(MOUNTAIN_BLOBS.map((b) => [b.x, b.z, b.r])).toEqual([
      [-100, -210, 48],
      [-10, -236, 52],
      [80, -224, 48],
      [160, -180, 40],
    ]);
    // The lake scales whole too, its own island with it — the ring of water
    // between them is a measured pair.
    const lake = WATER_BODIES[0]!;
    expect([lake.x, lake.z, lake.r]).toEqual([160, 140, 84]);
    expect([lake.island!.x, lake.island!.z, lake.island!.r]).toEqual([144, 124, 28]);
    // …and a POND only moves: it is a physical thing you stand beside, not a
    // proportion of the map.
    expect(WATER_BODIES.slice(1).map((b) => [b.x, b.z, b.r])).toEqual([
      [30, -110, 6],
      [-50, 190, 6],
      [170, -70, 7],
      [-190, -116, 6],
    ]);
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
    expect(farFieldStart()).toBe(TERRAIN.farStart * MAP_SCALE);
    expect(farFieldEnd()).toBe(TERRAIN.farEnd * MAP_SCALE);
    expect(farFieldStart()).toBeGreaterThan(coastReach().min);
    expect(farFieldEnd()).toBeGreaterThan(coastReach().max);
  });

  it('walks every ring at the count its chords were picked for', () => {
    // A coastline twice as long drawn at the same vertex count would have
    // doubled the chord — so the counts ride the scale and the chords do not.
    expect(coastOutlinePoints()).toBe(192 * MAP_SCALE);
    expect(outlinePoints()).toBe(96 * MAP_SCALE);
    expect(islandOutlinePoints()).toBe(64 * MAP_SCALE);
  });
});

describe('the doubled island — every field covers it', () => {
  beforeAll(() => {
    setLandscapeMode('landscape');
    setIslandMode(true);
  });
  afterAll(() => {
    setLandscapeMode('plain');
    setIslandMode(false);
  });

  it('displaces a ground field that holds the coast and its floor slope', () => {
    expect(fieldSize()).toBe(FIELD_SIZE * MAP_SCALE);
    // A SQUARE field, so what it has to hold is the coast's box and not its
    // radius — plus the shore ramp the sea floor falls away over, so the rim
    // really is one flat number (test/world/ground.test.ts seats the ring on
    // exactly that).
    expect(coastBox() + TERRAIN.shoreRamp).toBeLessThan(fieldSize() / 2);
  });

  it('keeps the QUAD, not the count — the terrace risers still read', () => {
    // The PROJECTION's field: the side rides the scale and so does the count,
    // so the quad is the one the risers were measured against.
    expect(fieldSegments()).toBe(FIELD_SEGMENTS * MAP_SCALE);
    expect(fieldQuad()).toBe(FIELD_SIZE / FIELD_SEGMENTS);
    expect(fieldQuad()).toBe(1.25);
    // PLAN §7.1's riser-height-error method, in one line: the steepest slope
    // on the map is 0.4814, so a 1.6-unit riser over the middle 60% of its
    // step is 0.96 / 0.4814 ≈ 1.99 units of run — and the quad has to be
    // narrower than that or it draws a wash instead of a line. (2.5 would not
    // be; that is the measurement that kept 640 segments rather than 320.)
    expect(RISER_RUN[MAP_SCALE]).toBeCloseTo(1.99, 2);
    expect(fieldQuad()).toBeLessThan(RISER_RUN[MAP_SCALE]);
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
      // …and the resolution rides it, so the TEXEL is exactly what it was.
      expect(res, name).toBe(authoredRes * MAP_SCALE);
      expect(size / res, name).toBe(FIELD_SIZE / authoredRes);
    }
    // The shipped resolutions, spelled out: 256² / 512² / 1024² over 800 units.
    expect([regionRes(), heightRes(), shoreRes()]).toEqual([256, 512, 1024]);
  });

  it('spans the base blade field over the island, budget unchanged', () => {
    expect(grassBaseSpan()).toBe(GRASS_BASE_SPAN * MAP_SCALE);
    // The base field is laid over a BOX, so the coast's box is what it has to
    // hold — and the map's own meadow weight decides which of those cells grow
    // anything (src/world/ghibli/grass.ts).
    expect(coastBox()).toBeLessThan(grassBaseSpan() / 2);
  });

  it('scatters props over the island at the density it always had', () => {
    expect(scatterExtent()).toBe(SCATTER_EXTENT * MAP_SCALE);
    // The GRID step is untouched, so the prop count per unit area is exactly
    // what it was and the extra placements are extra map rather than a denser
    // field (test/world/scatter.test.ts measures the density itself).
    //
    // The extent holds the coast's NEAREST reach, not its box: the scattered
    // square has always stopped a few units inside the extreme headlands
    // (168.66 against 160 as authored, 337.32 against 320 doubled) and the
    // relationship is exactly the one that shipped. What matters is that the
    // props reach the coast everywhere the coast is close, which they do.
    expect(scatterExtent()).toBeGreaterThan(coastReach().min);
    expect(coastBox() / scatterExtent()).toBeCloseTo(168.66 / 160, 3);
  });

  it('cuts the physics heightfield at the cell it was picked for', () => {
    expect(heightfieldSegments()).toBe(HEIGHTFIELD_SEGMENTS * MAP_SCALE);
    expect(fieldSize() / heightfieldSegments()).toBe(FIELD_SIZE / HEIGHTFIELD_SEGMENTS);
  });

  it('spawns over the whole island, and never in the sea', () => {
    expect(spawnRadius()).toBe(SPAWN_RADIUS * MAP_SCALE);
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
    expect(worldMapExtent()).toBe(WORLD_MAP_EXTENT * MAP_SCALE);
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
describe('the doubled island — a handset trades resolution, not extent', () => {
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
    expect(fieldSize()).toBe(FIELD_SIZE * MAP_SCALE);
    expect([regionSize(), heightSize(), shoreSize()]).toEqual([
      fieldSize(),
      fieldSize(),
      fieldSize(),
    ]);
    expect(spawnRadius()).toBe(SPAWN_RADIUS * MAP_SCALE);
    expect(worldMapExtent()).toBe(WORLD_MAP_EXTENT * MAP_SCALE);
    expect(groundRadius()).toBe(GROUND_RADIUS * MAP_SCALE);
    expect(grassBaseSpan()).toBe(GRASS_BASE_SPAN * MAP_SCALE);
    expect(scatterExtent()).toBe(SCATTER_EXTENT * MAP_SCALE);
  });

  it('cuts the field at 480, still inside the riser it has to draw', () => {
    expect(fieldSegments()).toBe(FIELD_SEGMENTS_PHONE_ISLAND);
    expect(fieldQuad()).toBeCloseTo(1.667, 3);
    // The bound that matters, and the whole reason 480 is allowed where 320
    // is not: a quad wider than the riser's own run draws a wash instead of a
    // line (PLAN §7.1). Measured height error against the authored field over
    // 250,000 land samples in the camera's core: 0.112 u at 480 against
    // 0.066 u at 640 — a fourteenth of a tier step.
    expect(fieldQuad()).toBeLessThan(RISER_RUN[MAP_SCALE]);
    // …and it really is a saving: 231k vertices against 411k.
    expect((fieldSegments() + 1) ** 2).toBeLessThan((FIELD_SEGMENTS * MAP_SCALE + 1) ** 2 * 0.6);
  });

  it('keeps the shore, region and heightfield at their authored resolutions', () => {
    // Every one of these is a COLOUR ramp or a collider, not where a blade
    // stands, so a coarser texel costs a softer edge rather than a thing in
    // the wrong place.
    expect(shoreRes()).toBe(SHORE_RES);
    expect(regionRes()).toBe(REGION_RES);
    expect(heightfieldSegments()).toBe(HEIGHTFIELD_SEGMENTS);
    // The texels that follow, stated so a future change has to face them: the
    // foam rim of 1.5–3 units is one to two texels rather than two to four,
    // and the heightfield's cell is 3.12 units rather than 1.56.
    expect(shoreSize() / shoreRes()).toBeCloseTo(1.5625, 4);
    expect(regionSize() / regionRes()).toBeCloseTo(6.25, 4);
    expect(fieldSize() / heightfieldSegments()).toBeCloseTo(3.125, 4);
  });

  it('leaves the HEIGHT bake alone — that one is where a blade stands', () => {
    // The one bake the phone does not trade down, and the reason is a kind
    // and not a size: `ggGroundAt` is read per blade to seat it on the ground,
    // so its error shows up as geometry (a blade floating over a tread or
    // buried in a riser) rather than as a soft edge. It is the biggest single
    // item left in the handset's terrain walk — 671ms of 1944ms measured — so
    // it is the next lever if one is needed, and it is deliberately not
    // pulled here.
    expect(heightRes()).toBe(HEIGHT_RES * MAP_SCALE);
    expect(heightSize() / heightRes()).toBe(FIELD_SIZE / HEIGHT_RES);
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

describe('the doubled island — the camera still frames it', () => {
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
    // The frame at the floor is enormous up the screen on a portrait phone —
    // the WIDTH binds, so the ground reaches ~1.4× the coast's own radius
    // behind the island. The sea disc has to cover the far CORNER of it, which
    // is why `groundRadius` rides the map: at the authored 1400 the corner of
    // the doubled island's floor frame landed outside the ring.
    for (const aspect of [390 / 844, 16 / 9]) {
      const zoom = zoomMinFor(aspect);
      const corner = Math.hypot(across(aspect, zoom) / 2, up(zoom) / 2);
      expect(corner, `aspect ${aspect}`).toBeLessThan(groundRadius());
    }
    expect(groundRadius()).toBe(GROUND_RADIUS * MAP_SCALE);
  });

  it('keeps the depth range past the sea on both sides of the target', () => {
    expect(cameraDistance()).toBeGreaterThan(groundRadius());
    expect(cameraFar()).toBeGreaterThanOrEqual(cameraDistance() + groundRadius());
    // The doubled numbers, spelled out: the sea disc reaches 2800 and the
    // pannable region 400, so the reach is 3200 and the eye stands one
    // `DEPTH_MARGIN` behind it.
    expect(cameraDistance()).toBe(3400);
    expect(cameraFar()).toBe(6800);
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
      expect(ISLAND.r).toBe(300);
    } finally {
      setIslandMode(false);
    }
    expect(ISLAND).toBe(authored);
    expect(ISLAND.r).toBe(150);
  });
});
