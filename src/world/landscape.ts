/**
 * Landscape — the world's AUTHORED geography, PURE (no Three.js, no DOM, no
 * clocks, no Math.random).
 *
 * The world used to be one uniform field of scattered props. This module is
 * the map underneath it: a forest, a mountain backdrop, a handful of small
 * ponds, and one lake with an island in its middle reached by a land bridge.
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
 * feature reaches within ~11 units of it (the same clearing scatter keeps).
 *
 * All coordinates are world units on the x/z ground plane; the Surface seam
 * owns height, so nothing here knows about y.
 */

import type { Collider } from '../physics/colliders';

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
  /** Lake only: the island in its middle. */
  island?: { r: number; seed: number };
  /** Lake only: a land bridge from shore to island — the water ring is open here. */
  isthmus?: { angle: number; halfAngle: number };
}

export interface LandscapeSample {
  /** 0–1 soft weight. */
  forest: number;
  /** 0–1 soft weight. */
  mountain: number;
  water: boolean;
  /** Land inside the lake, including the land bridge. */
  island: boolean;
  /** Dominant label: water > island > forest > mountain > plain. */
  region: Region;
}

// ── deterministic hash ───────────────────────────────────────────────────────

const TAU = Math.PI * 2;

/** Deterministic hash → [0,1). Same recipe family as src/world/props.ts, and
 * deliberately independent of the scatter seed: geography is authored. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** Angle folded into (-π, π]. */
function wrapToPi(a: number): number {
  return a - TAU * Math.round(a / TAU);
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
export const FOREST_FALLOFF = 7;
/** Units over which the mountain weight fades at its edge. */
export const MOUNTAIN_FALLOFF = 8;

/** [D] One big stand to the west with a smaller spur running south-east off
 * it, so the forest reads as a mass with an arm rather than a disc. */
export const FOREST_BLOBS: readonly Blob[] = [
  { x: -34, z: 12, r: 20, seed: 101 },
  { x: -18, z: 30, r: 11, seed: 102 },
];

/** [D] A backdrop range along the north edge: three overlapping masses whose
 * near edge sits outside the roam radius on purpose — mountains are scenery
 * the creatures walk toward, never terrain they climb. */
export const MOUNTAIN_BLOBS: readonly Blob[] = [
  { x: -16, z: -54, r: 16, seed: 201 },
  { x: 8, z: -60, r: 17, seed: 202 },
  { x: 32, z: -50, r: 15, seed: 203 },
];

const LAKE_X = 26;
const LAKE_Z = 28;

/** The lake first, then the ponds. The lake's land bridge points back at the
 * origin so the island is reachable from the hatch clearing on foot. */
export const WATER_BODIES: readonly WaterBody[] = [
  {
    kind: 'lake',
    x: LAKE_X,
    z: LAKE_Z,
    r: 18,
    seed: 301,
    island: { r: 8, seed: 302 },
    isthmus: { angle: Math.atan2(-LAKE_Z, -LAKE_X), halfAngle: 0.2 },
  },
  { kind: 'pond', x: 6, z: -27, r: 5, seed: 401 },
  { kind: 'pond', x: -12, z: 31, r: 4.2, seed: 402 },
  { kind: 'pond', x: 36, z: -8, r: 5.5, seed: 403 },
  { kind: 'pond', x: -40, z: -14, r: 4.5, seed: 404 },
];

// ── water ────────────────────────────────────────────────────────────────────

/** Phase salt for the isthmus width wobble — the land bridge has drawn edges
 * too, so it never reads as a clean wedge cut out of the ring. */
const ISTHMUS_PHASE_SALT = 91.3;

function islandBlob(body: WaterBody): Blob | null {
  const isl = body.island;
  return isl ? { x: body.x, z: body.z, r: isl.r, seed: isl.seed } : null;
}

/**
 * Angular half-width of the land bridge at distance `d` from the lake center,
 * already adjusted for `pad`. `pad` is extra water in every direction, so it
 * eats into the bridge: at distance `d`, `pad` units of arc is `pad / d`
 * radians. A negative pad (water shrunk, e.g. a ripple margin) widens it by
 * the same rule, which keeps every consumer on one definition.
 */
function isthmusHalf(body: WaterBody, d: number, pad: number): number {
  const ist = body.isthmus;
  if (!ist) return -1;
  const phase = hash(body.seed + ISTHMUS_PHASE_SALT) * TAU;
  const w = ist.halfAngle * (1 + 0.15 * Math.sin(d * 0.9 + phase));
  return d > 1e-6 ? w - pad / d : w;
}

function inIsthmus(body: WaterBody, theta: number, d: number, pad: number): boolean {
  const ist = body.isthmus;
  if (!ist) return false;
  const half = isthmusHalf(body, d, pad);
  return half > 0 && Math.abs(wrapToPi(theta - ist.angle)) < half;
}

/** True where this one body holds water. `pad` grows it outward (a shore
 * keep-out); a negative pad shrinks it from every shore at once — the outer
 * edge, the island edge and the land bridge. */
function bodyHoldsWater(body: WaterBody, x: number, z: number, pad: number): boolean {
  const dx = x - body.x;
  const dz = z - body.z;
  const d = Math.hypot(dx, dz);
  const theta = Math.atan2(dz, dx);
  if (d >= wobbledRadius(body, theta) + pad) return false;
  const isl = islandBlob(body);
  if (!isl) return true;
  if (d <= wobbledRadius(isl, theta) - pad) return false;
  return !inIsthmus(body, theta, d, pad);
}

/** True inside any water body. `pad > 0` grows every water body outward by
 * `pad` units (a shore keep-out for planting). */
export function isWater(x: number, z: number, pad = 0): boolean {
  for (const body of WATER_BODIES) if (bodyHoldsWater(body, x, z, pad)) return true;
  return false;
}

/** True on land that sits inside a lake's outer shore — the island proper and
 * the land bridge that reaches it. */
function isIslandLand(x: number, z: number): boolean {
  for (const body of WATER_BODIES) {
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

/** Everything the rest of the world needs to know about one spot of ground. */
export function sampleLandscape(x: number, z: number): LandscapeSample {
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
  return { forest, mountain, water, island, region };
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
 * counter-clockwise in x/z. The land bridge is NOT cut out of it — this is
 * the water's outer edge, and the bridge crosses the ring, not the shore. */
export function waterOutline(body: WaterBody, points = OUTLINE_POINTS): [number, number][] {
  return ringOutline(body, points);
}

/** The island's shoreline, or null for a pond. */
export function islandOutline(
  body: WaterBody,
  points = ISLAND_OUTLINE_POINTS,
): [number, number][] | null {
  const isl = islandBlob(body);
  return isl ? ringOutline(isl, points) : null;
}

/** The polygon the water FILL is built from: for a pond the outer outline; for a lake the ring
 * with the land bridge cut out — outer outline points outside the isthmus wedge (starting just
 * past one edge of the bridge), then the island outline points inside the same angular range in
 * reverse, so one simple polygon (no hole) traces the C-shaped water. Counter-clockwise, closed,
 * last point not repeated. */
export function waterFillOutline(body: WaterBody, points = OUTLINE_POINTS): [number, number][] {
  const isl = islandBlob(body);
  const ist = body.isthmus;
  // A pond is a plain disc of water: its outer shore IS its fill.
  if (!isl || !ist) return ringOutline(body, points);
  // Sampling starts AT the bridge angle so the wedge is one contiguous run of
  // dropped samples — the kept outer points then form a single arc from just
  // past one bridge edge round to just before the other, and the polygon needs
  // no rotation afterwards to be simple.
  const outer: [number, number][] = [];
  const inner: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const theta = ist.angle + (i / points) * TAU;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // Each ring is tested at ITS OWN radius: the bridge is a wedge whose
    // angular width narrows with distance, so the outer shore and the island
    // shore leave it at different angles. Pad 0 — this is the water's true
    // edge, not a keep-out.
    const ro = wobbledRadius(body, theta);
    if (!inIsthmus(body, theta, ro, 0)) outer.push([body.x + cos * ro, body.z + sin * ro]);
    const ri = wobbledRadius(isl, theta);
    if (!inIsthmus(body, theta, ri, 0)) inner.push([body.x + cos * ri, body.z + sin * ri]);
  }
  // Out along the outer shore, back along the island's — the return leg runs
  // in reverse so the two arcs join into one C instead of crossing.
  inner.reverse();
  return [...outer, ...inner];
}

// ── physics ──────────────────────────────────────────────────────────────────

/** [D] Ring circles overlap by 8% so a creature cannot squeeze between two of
 * them into the lake. */
const RING_COLLIDER_OVERLAP = 1.08;

/**
 * Hard circles approximating every water body. A pond is one circle. A lake
 * is a RING of circles laid along the mid radius — one big disc would seal
 * the island off, and the island is walkable land. The land bridge is left
 * physically open: every circle whose center falls within the bridge's
 * half-angle (plus its own angular radius, so it cannot reach in from the
 * side) is skipped.
 *
 * Allocates fresh each call; callers own the result.
 */
export function waterColliders(): Collider[] {
  const out: Collider[] = [];
  for (const body of WATER_BODIES) {
    const isl = body.island;
    if (!isl) {
      out.push({ x: body.x, z: body.z, r: body.r, hard: true });
      continue;
    }
    const rm = (body.r + isl.r) / 2;
    const ringHalf = (body.r - isl.r) / 2;
    const cr = ringHalf * RING_COLLIDER_OVERLAP;
    const count = Math.ceil((TAU * rm) / (ringHalf * 0.9));
    const ist = body.isthmus;
    const gap = ist ? ist.halfAngle + cr / rm : -1;
    for (let k = 0; k < count; k++) {
      const a = (k * TAU) / count;
      if (ist && Math.abs(wrapToPi(a - ist.angle)) < gap) continue;
      out.push({ x: body.x + Math.cos(a) * rm, z: body.z + Math.sin(a) * rm, r: cr, hard: true });
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
  body: WaterBody,
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
      // The land bridge has no shoreline: both rings run straight through it.
      if (body.isthmus) {
        const ox = px - body.x;
        const oz = pz - body.z;
        if (inIsthmus(body, Math.atan2(oz, ox), Math.hypot(ox, oz), 0)) continue;
      }
      if (isWater(px, pz)) continue;
      out.push({ x: px, z: pz, nx, nz });
    }
    acc += len;
  }
}

/**
 * Points along a shoreline at ~`spacing` units, each with the unit normal
 * pointing away from the water — where reeds get planted. Covers the outer
 * shore, and the island shore too for a lake. Samples inside the land bridge
 * gap are skipped: there is no water there to line.
 */
export function shoreSamples(body: WaterBody, spacing = SHORE_SPACING): ShoreSample[] {
  const out: ShoreSample[] = [];
  walkShore(body, waterOutline(body, OUTLINE_POINTS * SHORE_WALK_SUBDIVISION), false, spacing, out);
  const isl = islandOutline(body, ISLAND_OUTLINE_POINTS * SHORE_WALK_SUBDIVISION);
  if (isl) walkShore(body, isl, true, spacing, out);
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
 * every shore (including the island's and the land bridge's). A jittered grid
 * rather than a hash cloud: even coverage, no clumps, and the jitter keeps it
 * off the grid it was placed on (TASTE §2.5).
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
