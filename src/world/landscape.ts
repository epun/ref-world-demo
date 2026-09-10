/**
 * Landscape — the world's AUTHORED geography, PURE (no Three.js, no DOM, no
 * clocks, no Math.random).
 *
 * The world used to be one uniform field of scattered props. This module is
 * the map underneath it: a forest, a mountain backdrop, a handful of small
 * ponds, and one lake with an island standing in open water off its middle.
 * Every other system reads its geography from here — scatter (which kinds
 * grow where, and nothing at all in water), physics (water blocks
 * creatures), the water renderer (fills, shorelines, ripples, reeds), and
 * the minimap.
 *
 * AUTHORED, not generated: the layout below is hand-placed and FIXED. It does
 * NOT move with the scatter seed — that seed re-rolls props, never the map,
 * so a re-seeded world is the same country with different trees in it. The
 * hash here is self-contained for exactly that reason (same recipe family as
 * src/world/props.ts, never scatter's active seed).
 *
 * SHAPE [D]: no feature is a circle. Every blob's edge is a wobbled radius —
 * three low harmonics off a seeded phase (TASTE §2.5: the grid places, it
 * never forms; nothing on screen is built from primitives). `wobbledRadius`
 * is the single source of that edge, so the inside test, the outline
 * polygon, the shore samples and the ripple margins all agree exactly
 * instead of drifting apart by a fraction of a unit.
 *
 * The origin stays open plain: creatures hatch there and spiral out, so no
 * feature reaches within 40 units of it — comfortably past the ~11-unit
 * clearing scatter keeps — and the terrain is exactly flat inside 10.
 *
 * TWO MODES, ONE MAP (2026-09-09, user ask — *"I want to have the plain
 * version of the original world, where it was quite flat and there wasn't any
 * elevation or any interesting land features or landmarks… we're probably
 * going to sculpt the environment live with the audience"*). The world SHIPS
 * as `'plain'`: an open flat field of scattered props on flat paper, the way
 * it looked before this module existed — no forest, no range, no water, no
 * island, no reeds, no elevation at all. `'landscape'` restores the authored
 * map below bit for bit. See `setLandscapeMode`.
 *
 * The mode gates the QUERIES, never the data: `WATER_BODIES`, `FOREST_BLOBS`
 * and `MOUNTAIN_BLOBS` stay exported as authored whatever the mode, because
 * the water renderer builds its meshes from them once and then just hides
 * them. So switching modes is a rebuild, never a re-authoring, and the map
 * that comes back is the same one that went away.
 *
 * …and it gates the AUTHORED geography only. The painted offset below is a
 * person's own hand, not the map, so it survives the switch in both
 * directions and the plain field is fully paintable: opening flat and
 * sculpting from there is what the mode is FOR.
 *
 * Coordinates are world units on the x/z ground plane. HEIGHT lives here too
 * (`terrainHeight` / `terrainNormal` / `waterLevel`, at the bottom of this
 * file) because it is geography like everything else above it — the basins
 * are cut by the same wobbled shores the water is drawn from, and deriving
 * them anywhere else would be the second shoreline this module exists to
 * prevent. Consumers do not import them directly: they sample the Surface
 * seam (src/world/surface.ts), which is what PLAN §7.2 promised.
 *
 * PAINTED HEIGHT (PLAN §7, "painted terrain (dev)") lives here too, and only
 * as a hook: `setPaintedHeight` installs an offset sampler that
 * `terracedLand` adds to the smooth field. The map itself belongs to
 * src/world/painted.ts — a pure flat array the dev paint skill fills — but
 * the PLACE where a painted unit becomes a height is this module, for
 * exactly the reason the paragraph above gives: heights come from one place.
 * A hook anywhere else would be the second shoreline, in the height
 * dimension, and the Surface seam would have two sources under it.
 *
 * The offset is added BEFORE the terrace and BEFORE the far gate: a painted
 * hill gets risers like an authored one (the ink pass finds elevation only
 * where there is a contour to draw), and it settles onto the flat outer disc
 * at the rim like everything else. Nothing else in this file knows painting
 * exists — `terrainHeight`, `terrainNormal`, `waterLevel` and every consumer
 * are unchanged, and with no sampler set the world is identical to the
 * authored one (test/world/painted.test.ts pins that at 2,000 points).
 *
 * PAINTED WATER (envpaint docs/port-meridian.md §2.2, plan step 4) hangs on a
 * hook of exactly the same shape — `setPaintedWater` — and it hangs HERE for
 * the reason the paragraph above gives, one dimension over: heights and
 * SHORELINES come from one place. A person paints a level into the water
 * layer, src/world/painted-water.ts turns it into bodies and a signed
 * distance to the nearest painted shore, and the field installed here is what
 * `isWater`, `sampleLandscape`, `terrainHeight`, `terrainNormal` and
 * `waterColliders` all answer from. A hook anywhere else would be the second
 * shoreline this module exists to prevent — one for the ground, another for
 * the physics, a third for the reeds, drifting apart by a fraction of a unit.
 * Like the painted offset it is a person's own hand and NOT gated by the
 * mode: painted water exists in `'plain'` and `'landscape'` alike, and the
 * caller rebuilds the ground / scatter / water to see it.
 *
 * The painted basin is cut with the AUTHORED basin's maths, verbatim, with
 * the distance field standing in for `d - wobbledRadius`: inside the shore
 * the ground is EXACTLY the painted level (a flat sheet on a flat floor, like
 * an authored body), the first `basinRim` units of bank hold that level where
 * the land would otherwise fall below it, and the land climbs out over
 * `shoreRamp`. [D] The level is ABSOLUTE — a painted unit is a world unit, so
 * it is never scaled by the `elevation` dial, exactly as the painted height
 * offset is not; the dials are multipliers on the AUTHORED geography, and
 * somebody painted this waterline at the dials that were in force. [D] The
 * pass runs ONCE over the whole field rather than once per body, because the
 * field measures the NEAREST shore: where two painted bodies sit closer than
 * two shore ramps the nearer one wins the ground between them. That is the
 * same caveat the authored bodies carry (`terrainHeight`'s sequential basins)
 * and it has the same answer — paint them further apart.
 */

import type { Collider } from '../physics/colliders';
import { zeroPlanting, type PlantingWeights } from './painted';
import type { PaintedBody, PaintedWaterField } from './painted-water';

export type Region = 'plain' | 'forest' | 'mountain' | 'island' | 'water';

/** A hand-placed disc with a wobbled (never circular) edge. */
export interface Blob {
  x: number;
  z: number;
  r: number;
  seed: number;
}

export interface WaterBody {
  kind: 'pond' | 'lake';
  x: number;
  z: number;
  /** Mean outer radius. */
  r: number;
  seed: number;
  /**
   * Lake only: an island standing in it, with its OWN centre in world
   * coordinates — not a concentric core. Water runs all the way round it,
   * and nothing joins it to the shore: an island is a place you look at,
   * not a place the creatures walk to.
   */
  island?: Blob;
}

export interface LandscapeSample {
  /** 0–1 soft weight. */
  forest: number;
  /** 0–1 soft weight. */
  mountain: number;
  water: boolean;
  /** Land inside the lake's outer shore — the island, and only the island. */
  island: boolean;
  /** Dominant label: water > island > forest > mountain > plain. */
  region: Region;
  /**
   * What somebody has PAINTED here (src/world/painted.ts), per brush, [0,1] —
   * all zero when no planting sampler is installed, which is the shipped
   * world exactly.
   *
   * It rides on the landscape sample rather than being a query of its own
   * because every consumer that wants it (scatter's per-cell roll) already
   * takes one sample per cell, and a second query would be a second sample
   * of the same point. The authored fields above are gated by the landscape
   * MODE; this one is not — a person's own hand is not part of the map that
   * can be switched off, and painting the flat field is the whole point of
   * opening on one (2026-09-09, user ask).
   */
  planting: PlantingWeights;
}

// ── deterministic hash ───────────────────────────────────────────────────────

const TAU = Math.PI * 2;

/** Deterministic hash → [0,1). Same recipe family as src/world/props.ts, and
 * deliberately independent of the scatter seed: geography is authored. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** Smooth 0→1 ramp between two edges — used for the soft blob falloffs only
 * (this is a spatial blend, not an easing curve). */
function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ── the wobbled edge ─────────────────────────────────────────────────────────

/** [D] Three low harmonics: a big 3-lobe sway, a 5-lobe ripple, an 8-lobe
 * crinkle. Low enough to stay a readable landmass, uneven enough that no arc
 * of the edge repeats another. */
const WOBBLE_HARMONICS: readonly { n: number; amp: number }[] = [
  { n: 3, amp: 0.1 },
  { n: 5, amp: 0.06 },
  { n: 8, amp: 0.035 },
];

/** Phase salt per harmonic — each blob seed gets three unrelated phases. */
const WOBBLE_PHASE_STEP = 17.3;

/** Largest multiple of `r` the wobbled edge can reach (all harmonics at peak).
 * Bounding boxes use it; it is never a substitute for the real edge. */
export const WOBBLE_MAX = WOBBLE_HARMONICS.reduce((s, h) => s + h.amp, 1);

/** Wobbled edge radius of a blob at polar angle theta (radians,
 * `atan2(dz, dx)` from the blob center). */
export function wobbledRadius(b: Blob, theta: number): number {
  let f = 1;
  for (let k = 0; k < WOBBLE_HARMONICS.length; k++) {
    const h = WOBBLE_HARMONICS[k]!;
    const phase = hash(b.seed + (k + 1) * WOBBLE_PHASE_STEP) * TAU;
    f += h.amp * Math.sin(h.n * theta + phase);
  }
  return b.r * f;
}

// ── the authored layout ──────────────────────────────────────────────────────

/** Units over which the forest weight fades at its edge. */
export const FOREST_FALLOFF = 10;
/** Units over which the mountain weight fades at its edge — a long foothill
 * ramp, in proportion to a range whose masses are 20–26 across. */
export const MOUNTAIN_FALLOFF = 12;

/** [D] One big stand to the far west with a smaller spur running south-east
 * off it, so the forest reads as a mass with an arm rather than a disc.
 *
 * SPREAD AND SCALE (2026-09-03, user report — "i still want the distinct
 * environments to be really far apart in the map and they should also have a
 * larger footprint per environment"): the features used to crowd the middle
 * of the field, close enough that a creature could see all four from one
 * spot, and each was small enough to cross in a few strides. They sit out
 * near the edges of a bigger scattered region now, one per bearing, with at
 * least 20 units of open plain between any two of them — and each is roughly
 * half again as wide as it was. Every feature edge stays 40 units off the
 * origin, so the hatch clearing keeps a real horizon. */
export const FOREST_BLOBS: readonly Blob[] = [
  { x: -95, z: 20, r: 40, seed: 101 },
  { x: -60, z: 55, r: 18, seed: 102 },
];

/** [D] A backdrop range along the whole north edge: four overlapping masses
 * out past z = -90 — mountains are scenery the creatures walk toward, and a
 * range that reads as a horizon has to be both long and far. */
export const MOUNTAIN_BLOBS: readonly Blob[] = [
  { x: -50, z: -105, r: 24, seed: 201 },
  { x: -5, z: -118, r: 26, seed: 202 },
  { x: 40, z: -112, r: 24, seed: 203 },
  { x: 80, z: -90, r: 20, seed: 204 },
];

const LAKE_X = 80;
const LAKE_Z = 70;

/** The lake first, then the ponds.
 *
 * AN ISLAND, NOT A PENINSULA (2026-09-03, user report — "the island does not
 * look like an island at all"). Three things were wrong and all three are
 * authored here:
 *
 *   - a causeway tied it to the mainland, so it read as a headland. There is
 *     no land bridge any more, and no isthmus concept in this module at all:
 *     water runs the whole way round. Creatures cannot reach the island.
 *     That is the point of one.
 *   - it sat dead centre, which draws a donut rather than an island. Its
 *     centre is its own now, offset ~11 units back toward the origin — about
 *     a quarter of the lake's radius — so the viewer looking east from the
 *     hatch clearing sees open water in FRONT of the island as well as
 *     behind it.
 *   - it was a 9-unit speck in a 42-unit lake. 14 reads as a place, and the
 *     water still runs 7.9 units wide at the tightest point of the ring
 *     (8.5 measured along a bearing out of the island, 44.7 at the widest) —
 *     comfortably past the 6 the layout asks for, so no arm of it can ever
 *     pinch the ring shut.
 *
 * (Its HEIGHT is the fourth thing — see TERRAIN.islandRise.) */
export const WATER_BODIES: readonly WaterBody[] = [
  {
    kind: 'lake',
    x: LAKE_X,
    z: LAKE_Z,
    r: 42,
    seed: 301,
    island: { x: 72, z: 62, r: 14, seed: 302 },
  },
  { kind: 'pond', x: 15, z: -55, r: 6, seed: 401 },
  // (-25, 95), not (-35, 80): at 80 the pond's edge came within 7 units of
  // the forest's south-east arm, and the layout's rule is 20 units of open
  // plain between any two environments.
  { kind: 'pond', x: -25, z: 95, r: 6, seed: 402 },
  { kind: 'pond', x: 85, z: -35, r: 7, seed: 403 },
  // …and -58 rather than -55, for the same 20 units against the big western
  // stand.
  { kind: 'pond', x: -95, z: -58, r: 6, seed: 404 },
];

// ── the landscape mode ───────────────────────────────────────────────────────

/**
 * `'plain'` — the world before this module existed: one flat field of
 * scattered props, no features and no height. `'landscape'` — the authored
 * map above, exactly as written.
 */
export type LandscapeMode = 'plain' | 'landscape';

/**
 * The mode actually in force.
 *
 * Module state rather than an argument, for the same reason as `activeTerrain`
 * below and scatter's `activeSeed`: these queries are called from pure helpers
 * all over the world that take no instance, and threading a mode through every
 * one of them would put it in a hundred signatures.
 *
 * Determinism is unaffected — this is explicit state, not a clock or a random:
 * the same mode always gives the same map, and the shipped default is the one
 * the world opens in.
 *
 * `'plain'` IS the shipped default (2026-09-09, user ask): the room opens on
 * a flat field and the map is switched on live in front of the audience.
 */
let activeLandscapeMode: LandscapeMode = 'plain';

/** The mode the world is currently reading. */
export function landscapeMode(): LandscapeMode {
  return activeLandscapeMode;
}

/**
 * Switch the map on or off. Every pure query in this file answers for the
 * mode set here, and callers must rebuild the ground / scatter / water to SEE
 * it (WorldHandles.setLandscape does all three).
 */
export function setLandscapeMode(mode: LandscapeMode): void {
  activeLandscapeMode = mode;
}

/** True when the authored map is the one being read. */
function mapped(): boolean {
  return activeLandscapeMode === 'landscape';
}

/**
 * The water bodies that actually hold water right now — the authored list in
 * `'landscape'`, none at all in `'plain'`.
 *
 * The one seam every consumer that WALKS the water should use (scatter's reed
 * fringe, the collider tiling). `WATER_BODIES` itself stays the authored list
 * in both modes, for the renderer that builds its meshes once and hides them.
 */
export function activeWaterBodies(): readonly WaterBody[] {
  return mapped() ? WATER_BODIES : EMPTY_BODIES;
}

const EMPTY_BODIES: readonly WaterBody[] = [];

// ── water ────────────────────────────────────────────────────────────────────

/**
 * The painted water field in force, or null when no water is painted.
 *
 * Module state, exactly like `activeTerrain` and `paintedHeight` below and
 * for the same reason: `isWater` and `terrainHeight` are called from pure
 * helpers all over the world that take no instance, and threading a field
 * through every one of them would put it in a hundred signatures.
 * Determinism is unaffected — an installed field is explicit state, not a
 * clock or a random, and a build that never installs one is the authored
 * world unchanged.
 */
let paintedWaterField: PaintedWaterField | null = null;

/**
 * Install (or, with null, remove) the painted water field —
 * src/world/painted-water.ts `deriveWater` makes one out of the painted level
 * layer.
 *
 * The same contract as `setPaintedHeight`: this module holds the field by
 * reference and calls `shore` once per water query, so it is on the hot path
 * of every ground vertex, every placement and every walker, and callers must
 * rebuild the ground / scatter / water to SEE a change (the dev paint skill's
 * `rebuildLandscape` does all three).
 */
export function setPaintedWater(field: PaintedWaterField | null): void {
  paintedWaterField = field;
}

/** The painted water the world is currently reading, or null. */
export function paintedWater(): PaintedWaterField | null {
  return paintedWaterField;
}

function islandBlob(body: WaterBody): Blob | null {
  return body.island ?? null;
}

/** True where this one body holds water. `pad` grows it outward (a shore
 * keep-out); a negative pad shrinks it from both of its shores at once — the
 * outer edge and the island's.
 *
 * Each ring is measured from ITS OWN centre: the island is not concentric
 * with the lake, so one polar angle cannot serve both. */
function bodyHoldsWater(body: WaterBody, x: number, z: number, pad: number): boolean {
  const dx = x - body.x;
  const dz = z - body.z;
  if (Math.hypot(dx, dz) >= wobbledRadius(body, Math.atan2(dz, dx)) + pad) return false;
  const isl = islandBlob(body);
  if (!isl) return true;
  const ix = x - isl.x;
  const iz = z - isl.z;
  return Math.hypot(ix, iz) > wobbledRadius(isl, Math.atan2(iz, ix)) - pad;
}

/**
 * True inside any AUTHORED water body, whatever the mode — the map as
 * written. `pad > 0` grows every body outward by `pad` units.
 *
 * The one query that ignores the mode, and it exists for the water renderer:
 * it builds its fills, shorelines and ripples from the authored bodies in
 * both modes (it only hides them), so the guard that asks "is there water on
 * the wet side of this segment" has to ask the geography rather than the
 * world currently on screen. Everything else wants `isWater`.
 */
export function isAuthoredWater(x: number, z: number, pad = 0): boolean {
  for (const body of WATER_BODIES) if (bodyHoldsWater(body, x, z, pad)) return true;
  return false;
}

/**
 * True inside any water the world is actually holding: PAINTED water in both
 * modes, and the authored bodies in the landscape mode. `pad > 0` grows every
 * body outward by `pad` units (a shore keep-out for planting); a negative pad
 * shrinks it from every one of its shores at once.
 *
 * Painted first, and the painted test is EXACT rather than an approximation
 * [D]: `shore` is a SIGNED distance to the nearest painted shoreline, so
 * "inside the body grown by `pad`" is precisely "the signed distance is over
 * `-pad`" — outer shores and island shores together, with no ring to walk and
 * no polar angle to pick. With nothing painted this is the authored test it
 * always was, so the plain world with no paint on it has no water in it.
 */
export function isWater(x: number, z: number, pad = 0): boolean {
  const field = paintedWaterField;
  if (field && field.shore(x, z) > -pad) return true;
  return mapped() && isAuthoredWater(x, z, pad);
}

/** True on land that sits inside a lake's outer shore — which, with the
 * causeway gone, is the island and nothing else. */
function isIslandLand(x: number, z: number): boolean {
  for (const body of activeWaterBodies()) {
    if (!body.island) continue;
    const dx = x - body.x;
    const dz = z - body.z;
    const d = Math.hypot(dx, dz);
    if (d < wobbledRadius(body, Math.atan2(dz, dx)) && !bodyHoldsWater(body, x, z, 0)) return true;
  }
  return false;
}

// ── sampling ─────────────────────────────────────────────────────────────────

function blobWeight(blobs: readonly Blob[], falloff: number, x: number, z: number): number {
  let w = 0;
  for (const b of blobs) {
    const dx = x - b.x;
    const dz = z - b.z;
    const d = Math.hypot(dx, dz);
    const edge = wobbledRadius(b, Math.atan2(dz, dx));
    const v = 1 - smoothstep(edge - falloff, edge + falloff, d);
    if (v > w) w = v;
  }
  return w;
}

/** Everything the rest of the world needs to know about one spot of ground.
 *
 * In `'plain'` mode this answers as if the map did not exist — open,
 * unweighted plain everywhere — so every consumer that reads it (scatter's
 * regional tables above all) falls back to the pre-map world with no branch
 * of its own. Dry everywhere too, until somebody paints water: that is a
 * person's own hand rather than the map, so the plain sample reports it and
 * the regional tables cut their planting out of it with no branch of their
 * own either. A fresh object per call, like the mapped path: nobody mutates
 * a shared sample. */
export function sampleLandscape(x: number, z: number): LandscapeSample {
  // Painting answers in BOTH modes — see LandscapeSample.planting. In the
  // plain mode the AUTHORED map is gone but a PAINTED pond is not: `isWater`
  // already answers for the painted field there, so the plain branch carries
  // both a person's water and a person's planting.
  const planting = paintedPlanting ? paintedPlanting(x, z) : zeroPlanting();
  if (!mapped()) {
    const wet = isWater(x, z);
    return {
      forest: 0,
      mountain: 0,
      water: wet,
      island: false,
      region: wet ? 'water' : 'plain',
      planting,
    };
  }
  const water = isWater(x, z);
  const island = water ? false : isIslandLand(x, z);
  // Nothing grows on water, and the island is its own thing — the forest and
  // mountain fields are cut out of both rather than blended over them.
  const wet = water || island;
  const forest = wet ? 0 : blobWeight(FOREST_BLOBS, FOREST_FALLOFF, x, z);
  const mountain = wet ? 0 : blobWeight(MOUNTAIN_BLOBS, MOUNTAIN_FALLOFF, x, z);
  const region: Region = water
    ? 'water'
    : island
      ? 'island'
      : forest >= 0.5
        ? 'forest'
        : mountain >= 0.5
          ? 'mountain'
          : 'plain';
  return { forest, mountain, water, island, region, planting };
}

// ── terrain height ───────────────────────────────────────────────────────────

/**
 * The world used to be dead flat (PLAN §7.2 shipped `FlatSurface` first).
 * This is the rolling ground under the same authored map — gentle enough
 * that the isometric read never breaks, and pinned to the geography so a
 * lake can never sit above the land beside it.
 *
 * Four terms, in order:
 *
 *   rolling  2-octave value noise, faded in from the hatch clearing so the
 *            ground the creatures spawn on is exactly flat, and faded back
 *            out by `farEnd` so the terrain meets the flat outer ground disc
 *            without a seam.
 *   shelves  the forest raised onto a shelf and the range onto a high
 *            shoulder above it, over ramps much wider than the placement
 *            falloffs — the terrace below turns a long ramp into a flight of
 *            tiers, which is exactly the read we want.
 *   terrace  the whole smooth field snapped onto tiers, flat treads with
 *            rounded risers. This is what makes elevation legible at all in
 *            an orthographic ink render.
 *   basins   every water body flattens its whole disc — the island it holds
 *            included — to one number, `waterLevel(body)`, and the land
 *            climbs out of it over `shoreRamp`.
 *   island   …and then the island climbs back out of that basin, from the
 *            waterline up through two contour tiers to a crown.
 *
 * Pure and deterministic like the rest of this file: no clocks, no
 * Math.random, no Three.js. The Surface seam (src/world/surface.ts) is what
 * the rest of the world samples; nothing else derives a height.
 */
export const TERRAIN = {
  /** Flat disc at the origin — the hatch clearing is exactly 0. */
  clearRadius: 10,
  /** …the field reaches full amplitude here. */
  clearEdge: 30,
  /** [D] Two octaves, ±3.2 units in total before terracing. */
  octaves: [
    { wavelength: 60, amplitude: 2.4, salt: 0 },
    { wavelength: 26, amplitude: 0.8, salt: 57.13 },
  ],
  /** The forest sits on a raised shelf… */
  forestShelf: 2.5,
  /** …and the range on a high shoulder above it. */
  mountainShelf: 6,
  /**
   * [D] Width of the HEIGHT ramp outside each region's blob edge —
   * deliberately far wider than FOREST_FALLOFF / MOUNTAIN_FALLOFF, which
   * govern where things are PLANTED and must not move (widening those would
   * scatter mountains halfway down the apron).
   *
   * They have to be this wide because of the terrace below: it multiplies
   * every gradient by 1.5 / (riser width) = 2.5, so a shoulder that rises 6
   * units over the placement falloff of 12 would come out at a slope near 1.
   * Spread over a 70-unit ramp it stays inside the 0.6 bound — and the
   * terrace turns the long ramp into a flight of tiers, which is the whole
   * point: a smooth swell reads as nothing at all in an orthographic ink
   * render, and a staircase reads as elevation. Measured: the range's core
   * region stands 3.5 units over the open plain, the forest's 1.8.
   */
  forestShelfFalloff: 24,
  mountainShelfFalloff: 70,
  /**
   * [D] …and how far INSIDE each edge the shelf reaches full height. Kept
   * well short of a blob center on purpose: the wobbled radius is a function
   * of the polar angle, and near a center the angle (and so the edge) swings
   * arbitrarily fast — a transition band that reached the center would spin
   * that wobble into a spike in the slope.
   */
  shelfInner: 12,
  /** Tread-to-tread rise of the terrace, world units. */
  terraceStep: 1.6,
  /**
   * The riser occupies the middle 60% of each step, leaving a 40% tread — a
   * rounded ramp, never a hard edge (TASTE §3), and the ink pass contours
   * its crease on its own.
   *
   * [D] Wider than the 30% first drawn. A riser's slope is the smooth
   * field's slope times 1.5 / (its width), so a 30% riser multiplied every
   * gradient on the map by 5 and put the plain's own noise on a 1.2 slope —
   * twice the bound — before a shelf or a shore was involved at all. 60%
   * halves that to 2.5, and the treads still read: the walk from the hatch
   * clearing to the range crosses four distinct plateaus.
   */
  terraceRiser: [0.2, 0.8],
  /** [D] A basin floor sits this far under the terraced land at its center —
   * a full tier and a half, so a body of water reads as sunk, not as a
   * puddle painted on the plain. */
  basinDrop: 1.5,
  /**
   * [D] Units of shore over which the land climbs out of a basin. 16, not
   * the 6 first drawn: the lake floor sits five or six units under the land
   * around it now, and a 6-unit ramp put that drop on a slope of 1.4.
   */
  shoreRamp: 16,
  /**
   * [D] The first units of shore hold at the water level even where the
   * terraced land would fall below it, so water never laps over ground that
   * is lower than it is. Releases by `shoreRamp`.
   */
  basinRim: 2,
  /**
   * [D] How high an island stands over the water it sits in, before the
   * terrace. 3.4 clears two tiers, so the island's crown reads as a
   * two-contour hill and not a sandbar (2026-09-03, user report — "the
   * island sits FLAT at water level").
   *
   * The rise is measured from the island's own wobbled edge INWARD and
   * starts at exactly zero there, so the shore keeps the water's level, the
   * drawn shoreline ribbon at level + 0.011 stays on top of it, and the
   * first stride of beach is flat (the terrace's own tread holds the first
   * ~1.6 units of ramp at 0).
   */
  islandRise: 3.4,
  /**
   * [D] Units of island the rise runs over, measured as a FRACTION of the
   * island's own wobbled radius rather than in flat world units (see
   * `terrainHeight`). 12 of the island's 14: the bank climbs over six sevenths
   * of the way in and the crown is the last seventh, a plateau about 8 units
   * across.
   *
   * This is the steepest ground in the world and deliberately so — a bank is
   * the one landform whose job is to be steep, and 3.2 units of rise cannot
   * be spread over a 14-unit island at the plain's gradient however it is
   * shaped (the terrace multiplies every gradient by 2.5, so the plain's
   * 0.55 bound buys 0.22 units of climb per unit of ground: 3.2 would need
   * a 15-unit bank on a 14-unit island). Measured 1.15 at its worst, and the
   * terrain test carries that as an explicit ISLAND exception rather than a
   * raised bound for the whole field.
   */
  islandRamp: 12,
  /** Far field: the terrain starts fading here… */
  farStart: 150,
  /** …and is exactly 0 beyond here, matching the flat ground disc. */
  farEnd: 185,
  /** Central-difference step for the normal. */
  normalStep: 0.5,
} as const;

// ── the live terrain dials ───────────────────────────────────────────────────

/**
 * Three multipliers over the authored `TERRAIN` above — the ghost panel's
 * live terrain controls (2026-09-03, user ask: *"there is a lot of elevation
 * change. I want to be able to adjust the amount of elevation change there is
 * in the map and their spacing in proximity to each other"*).
 *
 * They are MULTIPLIERS, never a second geography: `TERRAIN` stays the single
 * authored source and every number below is read through these on the way
 * out, so there is still exactly one shoreline, one shelf and one basin in
 * this module.
 */
export interface TerrainParams {
  /** Multiplier on every vertical: noise amplitudes, region shelves, basin
   * drop, island rise. 0 = flat. */
  elevation: number;
  /** Tread-to-tread rise of the terrace, world units. */
  tierStep: number;
  /** Multiplier on every horizontal scale: noise wavelengths, shelf ramps,
   * shore ramp, island ramp. >1 = relief spread wider, contours farther
   * apart. */
  relief: number;
}

/**
 * The shipped defaults.
 *
 * [D] `elevation: 0.7`, not 1: the user judged the 1.0 world "a lot of
 * elevation change", so the world backs off to seven tenths of the authored
 * verticals and the dial keeps 2 available above it. Same discipline as
 * `SURFACE.ground` — a value tuned in the panel becomes the default by
 * changing this constant, and the authored `TERRAIN` numbers stay exactly as
 * recorded.
 */
export const TERRAIN_DEFAULTS: TerrainParams = {
  elevation: 0.7,
  tierStep: TERRAIN.terraceStep,
  relief: 1,
};

/** Inclusive range each dial is clamped to at the API boundary — a dev dial
 * can be steep, it can never be nonsense (a tierStep of 0 divides by zero in
 * `terrace`, a negative elevation turns the map inside out). */
export const TERRAIN_LIMITS: Readonly<Record<keyof TerrainParams, readonly [number, number]>> = {
  elevation: [0, 2],
  tierStep: [0.6, 4],
  relief: [0.5, 2.5],
};

const TERRAIN_KEYS = ['elevation', 'tierStep', 'relief'] as const;

/**
 * The params actually in force.
 *
 * Module state rather than an argument, for the same reason as scatter's
 * `activeSeed`: `terrainHeight` is called from pure helpers all over the
 * world that take no instance, and threading a params object through every
 * one of them would put the dial in a hundred signatures.
 *
 * Determinism is unaffected — these are explicit state, not a clock or a
 * random: the same params always give the same map, and a session that never
 * touches the panel is byte-identical to the defaults.
 */
let activeTerrain: TerrainParams = { ...TERRAIN_DEFAULTS };

/** The dials the map is currently shaped by. A copy: nobody mutates ours. */
export function terrainParams(): TerrainParams {
  return { ...activeTerrain };
}

/** Move one or more dials. Values are clamped to TERRAIN_LIMITS; a
 * non-finite value leaves that dial where it was. Callers must rebuild the
 * ground / scatter / water to SEE it (WorldHandles.setTerrain does all
 * three). */
export function setTerrainParams(next: Partial<TerrainParams>): void {
  const merged = { ...activeTerrain };
  for (const key of TERRAIN_KEYS) {
    const v = next[key];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = TERRAIN_LIMITS[key];
    merged[key] = Math.min(hi, Math.max(lo, v));
  }
  activeTerrain = merged;
}

/** One lattice value in [-1, 1). Same sin-hash as everything else here. */
function lattice(ix: number, iz: number, salt: number): number {
  return hash(ix * 7.31 + iz * 13.7 + 91.7 + salt) * 2 - 1;
}

/** Bilinear value noise on the lattice, smoothstep-interpolated (so the
 * gradient is continuous across cell edges — a linear interpolation would
 * put a crease on every lattice line). */
function valueNoise(x: number, z: number, wavelength: number, salt: number): number {
  const fx = x / wavelength;
  const fz = z / wavelength;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smoothstep(0, 1, fx - ix);
  const tz = smoothstep(0, 1, fz - iz);
  const v00 = lattice(ix, iz, salt);
  const v10 = lattice(ix + 1, iz, salt);
  const v01 = lattice(ix, iz + 1, salt);
  const v11 = lattice(ix + 1, iz + 1, salt);
  const a = v00 + (v10 - v00) * tx;
  const b = v01 + (v11 - v01) * tx;
  return a + (b - a) * tz;
}

/** The 2-octave field, ±3.2 at elevation 1, before any fade. `elevation`
 * scales the amplitudes, `relief` stretches the wavelengths. */
function terrainNoise(x: number, z: number): number {
  const { elevation, relief } = activeTerrain;
  let v = 0;
  for (const o of TERRAIN.octaves) {
    v += o.amplitude * elevation * valueNoise(x, z, o.wavelength * relief, o.salt);
  }
  return v;
}

/** The flat-clearing gate: 0 on the hatch disc, 1 out in the field. */
function clearGate(r0: number): number {
  return smoothstep(TERRAIN.clearRadius, TERRAIN.clearEdge, r0);
}

/** The far-field gate: 1 over the world, 0 past `farEnd`, where the terrain
 * has to meet the flat outer ground disc. */
function farGate(r0: number): number {
  return 1 - smoothstep(TERRAIN.farStart, TERRAIN.farEnd, r0);
}

/**
 * 0–1 weight of one region's HEIGHT shelf, straight off its blobs and
 * unclamped by water or island (a basin overrides it afterwards anyway).
 * Measured from the signed distance to each wobbled edge rather than
 * `blobWeight`'s symmetric band, so a shelf is flat well before the center —
 * see TERRAIN.shelfInner.
 */
function shelfWeight(blobs: readonly Blob[], falloff: number, x: number, z: number): number {
  // `relief` stretches the WHOLE transition band, inner reach and outer ramp
  // together, so a spread-out shelf keeps the shape it had and just takes
  // longer to get there. (The caller has already scaled `falloff`.)
  const inner = TERRAIN.shelfInner * activeTerrain.relief;
  let w = 0;
  for (const b of blobs) {
    const dx = x - b.x;
    const dz = z - b.z;
    const d = Math.hypot(dx, dz);
    const out = d - wobbledRadius(b, Math.atan2(dz, dx));
    const v = 1 - smoothstep(-inner, falloff, out);
    if (v > w) w = v;
  }
  return w;
}

/**
 * The smooth height field, before terracing: rolling noise plus the region
 * shelves, gated flat on the hatch clearing.
 */
function smoothField(x: number, z: number): number {
  const { elevation, relief } = activeTerrain;
  const shelf =
    TERRAIN.forestShelf *
      elevation *
      shelfWeight(FOREST_BLOBS, TERRAIN.forestShelfFalloff * relief, x, z) +
    TERRAIN.mountainShelf *
      elevation *
      shelfWeight(MOUNTAIN_BLOBS, TERRAIN.mountainShelfFalloff * relief, x, z);
  // The clearing gate is NOT scaled by either dial: the hatch clearing is a
  // fixed place on the map (creatures spawn there and spiral out), not a
  // feature of the relief.
  return (terrainNoise(x, z) + shelf) * clearGate(Math.hypot(x, z));
}

/**
 * Snap a smooth height onto tiers: a flat tread, then a rounded riser over
 * the middle of each step. Terracing is what makes elevation READ — an
 * orthographic ink render swallows a smooth swell whole, and shows a
 * staircase clearly, because each tread holds one value and each riser
 * gives the hatching a contour to follow. The riser is a smoothstep, never
 * a cut: no hard-edged geometry anywhere (TASTE §3).
 */
function terrace(v: number): number {
  const step = activeTerrain.tierStep;
  const k = Math.floor(v / step);
  const f = v / step - k;
  return step * (k + smoothstep(TERRAIN.terraceRiser[0], TERRAIN.terraceRiser[1], f));
}

/**
 * The painted height offset in force, or null when nothing is painted.
 *
 * Module state, exactly like `activeTerrain` above and for the same reason:
 * `terrainHeight` is called from pure helpers all over the world that take no
 * instance. Determinism is unaffected — an injected function is explicit
 * state, not a clock or a random, and a build that never installs one is the
 * authored world unchanged. The demo build never installs one: only the dev
 * paint skill (src/dev/paint.ts) calls this, and a baked map will call it
 * from the loader later (envpaint docs/port-meridian.md §2.2).
 */
let paintedHeight: ((x: number, z: number) => number) | null = null;

/**
 * Install (or, with null, remove) the painted height offset — world units,
 * added to the smooth field before terracing.
 *
 * The sampler must be pure and finite; this module holds it by reference and
 * calls it once per height sample, so it is on the hot path of every ground
 * vertex, every walker and every shadow stamp. Callers must rebuild the
 * ground / scatter / water to SEE a change (`WorldHandles.setTerrain` does
 * all three) — the same contract as `setTerrainParams`.
 */
export function setPaintedHeight(sampler: ((x: number, z: number) => number) | null): void {
  paintedHeight = sampler;
}

/**
 * The installed planting sampler — the same hook shape as `paintedHeight`
 * above, one dimension over (src/world/painted.ts `plantingSampler`).
 */
let paintedPlanting: ((x: number, z: number) => PlantingWeights) | null = null;

/**
 * Install (or, with null, remove) the painted planting weights — what
 * somebody has brushed onto the field per motif family, read by
 * `sampleLandscape` and from there by scatter's per-cell roll
 * (2026-09-09, user ask: brushes for trees, rocks, grass, flowers, clouds…).
 *
 * Same contract as `setPaintedHeight`: pure, finite, held by reference, and
 * callers must rebuild the SCATTER to see a change. Not the ground — a
 * planting stroke moves no vertex, and re-cutting 103k of them for a stroke
 * that plants a tuft of grass is the difference between a live tool and a
 * slideshow (`WorldHandles.refreshScatter`).
 */
export function setPaintedPlanting(
  sampler: ((x: number, z: number) => PlantingWeights) | null,
): void {
  paintedPlanting = sampler;
}

/**
 * The planting weights at a point, straight from the installed sampler —
 * every weight 0 when there is none.
 *
 * `sampleLandscape` already carries these for the point IT was asked about;
 * this is for the one caller that needs a SECOND point in the same cell:
 * scatter's painted pass, checking the cell's centre when the jittered seed
 * point it normally speaks for turns out to be outside a narrow stroke
 * (`hasPaintedPlanting` lets it skip the work entirely on an unpainted
 * world, which is every cell of the shipped one).
 */
export function paintedPlantingAt(x: number, z: number): PlantingWeights {
  return paintedPlanting ? paintedPlanting(x, z) : zeroPlanting();
}

/** Whether anybody has installed planting weights at all. */
export function hasPaintedPlanting(): boolean {
  return paintedPlanting !== null;
}

/** The painted offset at (x, z) — 0 when nothing is painted. */
function painted(x: number, z: number): number {
  return paintedHeight ? paintedHeight(x, z) : 0;
}

/**
 * The land: the smooth field, plus whatever has been painted onto it,
 * snapped onto tiers, then faded to the flat outer ground disc.
 *
 * The far fade runs OUTSIDE the terrace, not inside it. Fading the smooth
 * field first and terracing afterwards made the fade band cross a tier every
 * few units — the shoulder stands 8 units high where the fade begins — and
 * turned the world's rim into a flight of steps at three times the slope
 * bound. Fading the terraced height instead just settles the tiers down onto
 * the disc.
 *
 * The painted offset goes in INSIDE the terrace, so a painted hill comes out
 * with the same risers the authored relief has (envpaint docs/port-meridian.md
 * §6 weighed painting after terracing and rejected it: it would let a smooth
 * ramp exist, which TASTE §3 argues against). It is NOT scaled by the
 * `elevation` dial [D] — the dials are multipliers on the AUTHORED geography,
 * and a painted unit is a world unit somebody put there by hand at the dials
 * that were in force. It is also outside `clearGate`, so the hatch clearing
 * can be painted: the gate keeps the authored relief off the origin, it is
 * not a no-paint zone.
 */
function terracedLand(x: number, z: number): number {
  // The AUTHORED field is what the mode gates; the painted offset is not.
  // In the plain mode there is no smooth field to snap — but a painted hill
  // is still land, and it still terraces and still settles onto the flat
  // outer disc at the rim. `terrace(0)` is exactly 0, so an unpainted plain
  // world is exactly flat paper.
  const field = mapped() ? smoothField(x, z) : 0;
  return terrace(field + painted(x, z)) * farGate(Math.hypot(x, z));
}

/**
 * The flat level a body's water surface sits at — its basin floor: the tier
 * the land stands on at the body's own center, `basinDrop` below it. One
 * number per body, so a water surface is a plane and never a warped sheet.
 */
export function waterLevel(body: WaterBody): number {
  // No basin in a flat field — and the water renderer still asks, because it
  // keeps its (hidden) sheets seated whatever the mode.
  if (!mapped()) return 0;
  return terracedLand(body.x, body.z) - TERRAIN.basinDrop * activeTerrain.elevation;
}

/**
 * Ground height at (x, z), world units. Pure, deterministic.
 *
 * Basins are applied SEQUENTIALLY and LAST, each replacing the running
 * height the same way. Last, so a basin's interior is EXACTLY its
 * `waterLevel` — no gate multiplies it afterwards, which matters now that
 * the lake's far shore reaches past the start of the far-field fade.
 * Sequentially, because no point falls inside two shore ramps: the closest
 * pair of water bodies clears far more edge to edge than their two ramps add
 * up to, so the order cannot matter and this is the same thing as "the
 * nearest body".
 */
export function terrainHeight(x: number, z: number): number {
  const { elevation, relief } = activeTerrain;
  // The shore ramp and the rim guard are horizontal distances, so they ride
  // `relief` — a wider relief spreads a basin's climb-out over more ground.
  // They are read in BOTH modes now: the painted basin below is not gated by
  // the map, and it cuts itself with these same two numbers.
  const shoreRamp = TERRAIN.shoreRamp * relief;
  const basinRim = TERRAIN.basinRim * relief;
  let h = terracedLand(x, z);
  // The plain has no authored geography in it — no shelves, no basins, no
  // island — so it is `terracedLand` and the painted pass below, and nothing
  // else. NOT a bare 0: the painted offset lives inside `terracedLand`, and
  // painting the flat field is the whole point of opening on one (2026-09-09,
  // user ask — open flat, then sculpt in front of the audience). Unpainted,
  // this is exactly 0.
  if (mapped()) {
    for (const body of WATER_BODIES) {
      const dx = x - body.x;
      const dz = z - body.z;
      const d = Math.hypot(dx, dz);
      // Signed distance to the OUTER wobbled shore: negative inside it, which
      // is the island and the causeway too — the whole disc is one basin.
      const out = d - wobbledRadius(body, Math.atan2(dz, dx));
      if (out >= shoreRamp) continue;
      const level = waterLevel(body);
      const t = smoothstep(0, shoreRamp, out);
      // out <= 0 → t = 0 → exactly `level`: flat basin, flat island, flat
      // causeway, and no land inside the shore that water could sit above.
      const blended = level + (h - level) * t;
      // The rim guard is the continuous form of "never below the water line":
      // a plain max() would hold every low tier in the world up to the level
      // of the nearest lake, so the guard releases over the same ramp.
      const rim = 1 - smoothstep(basinRim, shoreRamp, out);
      h = blended + rim * Math.max(0, level - blended);
    }
    // …and then the island climbs back out of the basin that just flattened
    // it. AFTER the basin pass, never inside it: the basin's job is to put one
    // flat number under a sheet of water, and an island is land that stands on
    // top of that number rather than a hole in it. `max` for the same reason —
    // nothing here may ever pull the ground BELOW the water it is surrounded
    // by, at any distance from the shore.
    for (const body of WATER_BODIES) {
      const isl = body.island;
      if (!isl) continue;
      const dx = x - isl.x;
      const dz = z - isl.z;
      const d = Math.hypot(dx, dz);
      // Signed distance INTO the island from its own wobbled edge: 0 at the
      // waterline, positive inland.
      const edge = wobbledRadius(isl, Math.atan2(dz, dx));
      const inIsl = edge - d;
      if (inIsl <= 0) continue;
      // Measured as a FRACTION of the island's own radius here, scaled back
      // into units by its mean one. The wobbled radius swings by a sixth
      // around the ring, and a rise read in flat units off it carries that
      // swing straight into the gradient — the sideways term alone doubled the
      // steepest bank (measured 1.75 against 1.15). Proportion also puts the
      // crown over the middle whatever the edge is doing, and gives a pinched
      // arm of the island a proportionally narrower bank, which is what a
      // small headland looks like.
      const climb = isl.r * (inIsl / edge);
      const rise =
        TERRAIN.islandRise * elevation * smoothstep(0, TERRAIN.islandRamp * relief, climb);
      h = Math.max(h, waterLevel(body) + terrace(rise));
    }
  }
  // …and the PAINTED basin last of all, in both modes: the authored basin's
  // maths verbatim, with the distance field's `-shore` standing in for the
  // distance outside a wobbled radius. Last for the same reason the authored
  // basins are — a basin's interior has to come out EXACTLY its level, and
  // anything applied after it would multiply that flat sheet by something.
  // One pass, not one per body: the field measures the nearest shore, so
  // where two painted bodies sit closer than two ramps the nearer one wins.
  const field = paintedWaterField;
  if (field) {
    // Distance OUTSIDE the painted shore: negative inside the water.
    const out = -field.shore(x, z);
    if (out < shoreRamp) {
      // Absolute world units — the `elevation` dial multiplies the AUTHORED
      // verticals and never a painted one (same rule as the painted height
      // offset, and the same reason: somebody put this waterline here by
      // hand at the dials that were in force).
      const level = field.level(x, z);
      const t = smoothstep(0, shoreRamp, out);
      const blended = level + (h - level) * t;
      const rim = 1 - smoothstep(basinRim, shoreRamp, out);
      h = blended + rim * Math.max(0, level - blended);
    }
  }
  return h;
}

/** Unit surface normal by central differences. */
export function terrainNormal(x: number, z: number): { x: number; y: number; z: number } {
  // Straight up, exactly — a central difference over a flat field would land
  // on -0 for x and z rather than 0, and the plain is paper. Only while
  // nothing is painted, though: a painted hill on the plain has real slopes,
  // and so does the bank of a painted pond, and a stamp that lay flat across
  // either would read as a sticker.
  if (!mapped() && paintedHeight === null && paintedWaterField === null) {
    return { x: 0, y: 1, z: 0 };
  }
  const e = TERRAIN.normalStep;
  const dhdx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dhdz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  const len = Math.hypot(dhdx, 1, dhdz);
  return { x: -dhdx / len, y: 1 / len, z: -dhdz / len };
}

// ── outlines ─────────────────────────────────────────────────────────────────

/** Default vertex count of an outer shoreline. */
export const OUTLINE_POINTS = 96;
/** Default vertex count of an island shoreline. */
export const ISLAND_OUTLINE_POINTS = 64;

function ringOutline(b: Blob, points: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * TAU;
    const r = wobbledRadius(b, theta);
    out.push([b.x + Math.cos(theta) * r, b.z + Math.sin(theta) * r]);
  }
  return out;
}

/** Closed polygon (last point NOT repeated) of the outer shoreline, wobbled,
 * counter-clockwise in x/z. This is the whole of the water's outer edge:
 * nothing interrupts it, so it is also the polygon the fill is built from.
 * A lake's island is a HOLE in that fill, not a bite out of this loop —
 * `islandOutline` below. */
export function waterOutline(body: WaterBody, points = OUTLINE_POINTS): [number, number][] {
  return ringOutline(body, points);
}

/** The island's shoreline — walked around the island's OWN centre, and wound
 * counter-clockwise like the outer one, so `(dz, −dx)` points off the island
 * and into the water at every vertex. Null for a pond. */
export function islandOutline(
  body: WaterBody,
  points = ISLAND_OUTLINE_POINTS,
): [number, number][] | null {
  const isl = islandBlob(body);
  return isl ? ringOutline(isl, points) : null;
}

// ── physics ──────────────────────────────────────────────────────────────────

/** [D] Radius of one water collider. Small enough that the tiling follows a
 * wobbled shore closely; big enough that ~1200 of them cover every body
 * without turning the collider grid into a particle system. */
export const WATER_COLLIDER_R = 2.2;

/** [D] How far a collider is allowed to protrude past the shore onto land.
 * A circle is kept only where its center is water with the body shrunk by
 * `WATER_COLLIDER_R - WATER_COLLIDER_BITE`, so the worst case is this much
 * land blocked and at most ~1.6 units of shore water left unblocked.
 *
 * Exported so a test can measure the tiling against the number it was tiled
 * by rather than against a copy of it. */
export const WATER_COLLIDER_BITE = 0.6;

/** [D] Row pitch of the tiling: a hex offset (rows staggered by half a
 * spacing, √3/2 apart) packs circles of one radius with no gap a creature
 * can thread, at the fewest circles. */
const WATER_COLLIDER_ROW = 0.866;

/**
 * Hard circles approximating every water body — a uniform hex-offset TILING
 * of `WATER_COLLIDER_R` circles over the body's bounding square, keeping
 * every circle whose center is water once the body is shrunk by
 * `WATER_COLLIDER_R - WATER_COLLIDER_BITE`.
 *
 * This used to be one circle per pond and a ring of big circles along the
 * lake's mid radius, which only works while the ring is narrow and centred.
 * The lake is a wide body of water with an off-centre island standing in it
 * now, and no ring of circles describes that. A tiling has no such coupling:
 * the shape it blocks is the shape of the water, at any body size, whatever
 * is standing in the middle of it.
 *
 * The grid is anchored on the body center — so a pond always gets a circle
 * dead center — and the whole thing is integer-indexed, so it is
 * deterministic to the bit. Allocates fresh each call; callers own the
 * result.
 *
 * Authored circles only in the landscape mode; painted bodies in BOTH — a
 * person who paints a pond onto the flat field gets water that stops a
 * creature, the same as an authored one.
 */
export function waterColliders(): Collider[] {
  const out: Collider[] = [];
  const step = WATER_COLLIDER_R;
  const row = WATER_COLLIDER_R * WATER_COLLIDER_ROW;
  const pad = -(WATER_COLLIDER_R - WATER_COLLIDER_BITE);
  for (const body of activeWaterBodies()) {
    const reach = body.r * WOBBLE_MAX;
    const jn = Math.ceil(reach / row);
    const iMax = Math.ceil(reach / step) + 1;
    for (let j = -jn; j <= jn; j++) {
      const z = body.z + j * row;
      // Odd rows shift half a step: the hex offset.
      const shift = j % 2 === 0 ? 0 : 0.5;
      for (let i = -iMax; i <= iMax; i++) {
        const x = body.x + (i + shift) * step;
        if (!bodyHoldsWater(body, x, z, pad)) continue;
        out.push({ x, z, r: WATER_COLLIDER_R, hard: true });
      }
    }
  }
  // The same tiling over every painted body, anchored on its bounds centre so
  // a painted pond gets a circle in the middle of it just as an authored one
  // does. The keep test is the distance field read directly: `shore > R -
  // bite` IS "the body shrunk by R - bite still holds water here", with no
  // ring to walk — and an island falls out for free, because `shore` is
  // negative on the land inside a body.
  const field = paintedWaterField;
  if (field) {
    const keep = WATER_COLLIDER_R - WATER_COLLIDER_BITE;
    for (const body of field.bodies) {
      const { x0, z0, x1, z1 } = body.bounds;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const jn = Math.ceil((z1 - z0) / 2 / row) + 1;
      const iMax = Math.ceil((x1 - x0) / 2 / step) + 1;
      for (let j = -jn; j <= jn; j++) {
        const z = cz + j * row;
        const shift = j % 2 === 0 ? 0 : 0.5;
        for (let i = -iMax; i <= iMax; i++) {
          const x = cx + (i + shift) * step;
          if (field.shore(x, z) <= keep) continue;
          out.push({ x, z, r: WATER_COLLIDER_R, hard: true });
        }
      }
    }
  }
  return out;
}

// ── shorelines ───────────────────────────────────────────────────────────────

/** Default arc-length spacing between shore samples. */
export const SHORE_SPACING = 2.2;
/** [D] Every shore sample is nudged this far onto land along its normal, so a
 * reed planted on it is never standing in the water it borders. */
const SHORE_PUSH = 0.15;
/** Accuracy multiplier for the polygon the arc-length walk runs over. */
const SHORE_WALK_SUBDIVISION = 4;

export interface ShoreSample {
  x: number;
  z: number;
  /** Unit normal pointing AWAY from the water, onto land. */
  nx: number;
  nz: number;
}

function walkShore(
  poly: readonly [number, number][],
  inward: boolean,
  spacing: number,
  out: ShoreSample[],
): void {
  let acc = 0;
  // Start half a step in so the first sample is not pinned to the seam of the
  // polygon (which is an artifact of where theta happens to start).
  let next = spacing * 0.5;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len <= 1e-9) continue;
    // Outward normal of a counter-clockwise ring is (dz, -dx). For the island
    // that points into the water, so it flips: away from water, onto land, is
    // toward the island's own center.
    const s = inward ? -1 : 1;
    const nx = (s * dz) / len;
    const nz = (-s * dx) / len;
    while (next <= acc + len) {
      const t = (next - acc) / len;
      const px = a[0] + dx * t + nx * SHORE_PUSH;
      const pz = a[1] + dz * t + nz * SHORE_PUSH;
      next += spacing;
      if (isWater(px, pz)) continue;
      out.push({ x: px, z: pz, nx, nz });
    }
    acc += len;
  }
}

/**
 * Points along a shoreline at ~`spacing` units, each with the unit normal
 * pointing away from the water — where reeds get planted. Covers the outer
 * shore, and for a lake the island's shore too: BOTH are lined, with no gap
 * anywhere on either, because there is no longer any stretch of either ring
 * that is not a boundary between water and land.
 */
export function shoreSamples(body: WaterBody, spacing = SHORE_SPACING): ShoreSample[] {
  const out: ShoreSample[] = [];
  walkShore(waterOutline(body, OUTLINE_POINTS * SHORE_WALK_SUBDIVISION), false, spacing, out);
  const isl = islandOutline(body, ISLAND_OUTLINE_POINTS * SHORE_WALK_SUBDIVISION);
  if (isl) walkShore(isl, true, spacing, out);
  return out;
}

/**
 * The same shore samples along every PAINTED shoreline — the outer ring of
 * each body and the ring of every island in it — or `[]` when no field is
 * installed.
 *
 * The walker above is reused unchanged, and every one of its habits is
 * already right here [D]: its `isWater` skip covers painted water now, so a
 * sample that lands back in the pond is dropped by the same test that drops
 * an authored one; its `SHORE_PUSH` nudge onto land is the same nudge for a
 * traced ring as for a wobbled one; and a hole ring is EXACTLY the island
 * case, so the flipped normal it already has points off the island and into
 * the water's back.
 *
 * No `SHORE_WALK_SUBDIVISION` here [D]: an authored ring is a 96-point
 * sampling of a smooth curve and has to be subdivided before an arc-length
 * walk over it is accurate, but a painted ring is already densified to the
 * brush's own texel scale — it IS the polygon, not an approximation of one,
 * and there is nothing between its vertices to subdivide toward.
 */
export function paintedShoreSamples(spacing = SHORE_SPACING): ShoreSample[] {
  const out: ShoreSample[] = [];
  const field = paintedWaterField;
  if (!field) return out;
  for (const body of field.bodies) {
    walkShore(body.outline, false, spacing, out);
    for (const hole of body.holes) walkShore(hole, true, spacing, out);
  }
  return out;
}

// ── ripples ──────────────────────────────────────────────────────────────────

/** [D] Roughly one ripple mark per this much water, so a pond gets a couple
 * and the lake gets a scattering — a surface that reads as moving without
 * becoming a texture. */
export const RIPPLE_AREA_PER_SPOT = 14;
/** Fraction of grid cells that actually carry a mark (the rest is open
 * water — TASTE §2.3, generous negative space). */
const RIPPLE_KEEP = 0.55;
/** Default clearance from every shore. */
export const RIPPLE_MARGIN = 1.8;

export interface RippleSpot {
  x: number;
  z: number;
  /** Radians. */
  rot: number;
  len: number;
}

/**
 * Deterministic ripple marks inside the water, each at least `margin` from
 * every shore, the island's included. A jittered grid rather than a hash
 * cloud: even coverage, no clumps, and the jitter keeps it off the grid it
 * was placed on (TASTE §2.5).
 */
export function rippleSpots(body: WaterBody, margin = RIPPLE_MARGIN): RippleSpot[] {
  const out: RippleSpot[] = [];
  const step = Math.sqrt(RIPPLE_AREA_PER_SPOT);
  const reach = body.r * WOBBLE_MAX;
  const ix0 = Math.floor((body.x - reach) / step);
  const ix1 = Math.floor((body.x + reach) / step);
  const iz0 = Math.floor((body.z - reach) / step);
  const iz1 = Math.floor((body.z + reach) / step);
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iz = iz0; iz <= iz1; iz++) {
      if (hash(body.seed + ix * 7.1 + iz * 13.7) >= RIPPLE_KEEP) continue;
      const jx = (hash(body.seed + ix * 3.3 + iz * 9.1 + 5.5) - 0.5) * 0.8 * step;
      const jz = (hash(body.seed + ix * 11.9 + iz * 4.7 + 8.2) - 0.5) * 0.8 * step;
      const x = (ix + 0.5) * step + jx;
      const z = (iz + 0.5) * step + jz;
      // Negative pad = the body shrunk by `margin` from every one of its
      // shores at once, which is exactly the clearance a mark needs.
      if (!bodyHoldsWater(body, x, z, -margin)) continue;
      out.push({
        x,
        z,
        rot: hash(body.seed + ix * 2.7 + iz * 6.3 + 13.1) * TAU,
        len: 0.6 + 0.8 * hash(body.seed + ix * 5.9 + iz * 8.7 + 21.7),
      });
    }
  }
  return out;
}

/**
 * Ripple marks inside one PAINTED body — the same jittered grid as
 * `rippleSpots` above, over the body's bounds, keeping a mark only where the
 * distance field says it is at least `margin` from every shore.
 *
 * The `shore` sampler is passed in rather than read off the installed field
 * [D]: the water renderer builds a body's marks from the field it was handed,
 * and a mark placed against some OTHER field that happened to be installed at
 * the time would be a mark in the wrong pond.
 *
 * Same step and same hash salts as the authored version, off `body.seed` —
 * which is the body's first texel index, so the same painted shape always
 * ripples the same way. Deterministic; allocates fresh each call.
 */
export function paintedRippleSpots(
  body: PaintedBody,
  shore: (x: number, z: number) => number,
  margin = RIPPLE_MARGIN,
): RippleSpot[] {
  const out: RippleSpot[] = [];
  const step = Math.sqrt(RIPPLE_AREA_PER_SPOT);
  const ix0 = Math.floor(body.bounds.x0 / step);
  const ix1 = Math.floor(body.bounds.x1 / step);
  const iz0 = Math.floor(body.bounds.z0 / step);
  const iz1 = Math.floor(body.bounds.z1 / step);
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iz = iz0; iz <= iz1; iz++) {
      if (hash(body.seed + ix * 7.1 + iz * 13.7) >= RIPPLE_KEEP) continue;
      const jx = (hash(body.seed + ix * 3.3 + iz * 9.1 + 5.5) - 0.5) * 0.8 * step;
      const jz = (hash(body.seed + ix * 11.9 + iz * 4.7 + 8.2) - 0.5) * 0.8 * step;
      const x = (ix + 0.5) * step + jx;
      const z = (iz + 0.5) * step + jz;
      // The signed distance IS the clearance from every shore at once — the
      // outer one and any island's — which is exactly what a mark needs.
      if (shore(x, z) < margin) continue;
      out.push({
        x,
        z,
        rot: hash(body.seed + ix * 2.7 + iz * 6.3 + 13.1) * TAU,
        len: 0.6 + 0.8 * hash(body.seed + ix * 5.9 + iz * 8.7 + 21.7),
      });
    }
  }
  return out;
}
