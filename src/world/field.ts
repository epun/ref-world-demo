/**
 * The FIELD: how far the displaced ground reaches, how finely it is cut, and
 * how far the flat horizon beyond it runs. Pure — no Three.js, no DOM.
 *
 * It lives in its own module rather than in `src/world/ground.ts` because the
 * three geography bakes (`src/world/ghibli/{region,height,shore}.ts`) span the
 * same field and `ground.ts` imports all three: a number they share cannot
 * live in the module above them without an import cycle. Everything here is
 * re-exported from `ground.ts`, which is still where the meshes are built and
 * still the name every existing consumer reads.
 *
 * TWICE AS BIG (2026-09-16, user ask — *"make the island twice as big"*).
 * Every number below is the one that shipped, times `mapScale()`
 * (src/world/landscape.ts): with the island off it is exactly 1 and this
 * module is the set of constants it always was, and with it on the field
 * covers a coast that now reaches ~352 units from the origin.
 *
 * The SIDE is the same on every device, because the bakes span it and the
 * physics heightfield is laid over it. The CUT is not: a projection keeps the
 * 1.25-unit quad the risers were measured against, and a handset takes 1.67
 * (see `fieldSegments`). That is the one place this module asks what kind of
 * screen it is on.
 */

import { isPhoneTier } from './device';
import { mapScale } from './landscape';

/**
 * Side of the displaced field, world units: ±200 in x and z on a world with
 * no island. Comfortably past `farFieldEnd`, so the rim is flat land and not
 * a cut through a tier.
 */
export const FIELD_SIZE = 400;

/**
 * Segments per side — 1.25 units a quad, ~205k triangles. A ceiling, not a
 * starting point [D]: the terrace risers are the finest thing on the map
 * and a few units of run each, so this puts several vertices across one,
 * and doubling it quadruples both the build and the draw for a shape the
 * ink pass would render the same.
 */
export const FIELD_SEGMENTS = 320;

/**
 * Outer radius of the flat far field on a world with no island. The water
 * pass builds the SEA's own sheet out to the same horizon — one disc of ocean
 * with the island punched out of it, seated on the same floor the ring stands
 * on (src/world/water.ts).
 */
export const GROUND_RADIUS = 1400;

/** Side of the displaced field on the map being read, world units. */
export function fieldSize(): number {
  return FIELD_SIZE * mapScale();
}

/**
 * [D] Segments per side on a handset's doubled island — 480 rather than 640.
 *
 * WHY THERE IS A TIER HERE AT ALL. Displacing the field is a CPU cost, not a
 * frame cost: every vertex goes through the Surface seam once per build and
 * once per rebuild, and a rebuild is what a terrain dial, a landscape switch
 * and a painted pond each ask for. 641² vertices measured 1194ms on one node
 * core against the authored 321²'s 251ms; on a handset that is seconds of
 * blocked main thread at load and again on every drag, which is the user's
 * standing *"very slow to load"* complaint (PLAN §7.1).
 *
 * WHY 480 IS ALLOWED. PLAN §7.1's riser-height-error method: the steepest
 * slope on the doubled map is 0.4814, so a 1.6-unit riser over the middle
 * 60% of its step is 0.96 / 0.4814 ≈ **1.99 units of run** — and a quad has
 * to be narrower than the riser it draws or the ground's own terrace mark
 * reads as a wash. 480 segments over 800 units is a **1.67-unit quad**, still
 * inside the riser, and the measured height error against the authored field
 * over 250,000 land samples in the camera's core is **0.112 u** against
 * 0.066 u at 640 — a fourteenth of a tier step, on the device with the
 * smallest screen. 320 segments would be a 2.5-unit quad, WIDER than the
 * riser, which is exactly the failure §7.1 rejected 160 for on the old map.
 */
export const FIELD_SEGMENTS_PHONE_ISLAND = 480;

/**
 * Segments per side on the map being read.
 *
 * A projection holds the QUAD at 1.25 units whatever the island's size — the
 * side rides `mapScale` and so does the count. A handset takes
 * `FIELD_SEGMENTS_PHONE_ISLAND` instead, for the reason written there; with
 * no island the two are the same 320, so the public world's field is the one
 * that shipped on every device.
 */
export function fieldSegments(): number {
  if (mapScale() === 1) return FIELD_SEGMENTS;
  return isPhoneTier() ? FIELD_SEGMENTS_PHONE_ISLAND : FIELD_SEGMENTS * mapScale();
}

/** World units a single ground quad spans — 1.25 everywhere but a handset's
 * doubled island, which takes 1.67. Exported so a test can measure it against
 * the riser it has to draw rather than restate either number. */
export function fieldQuad(): number {
  return fieldSize() / fieldSegments();
}

/**
 * [D] The narrowest terrace riser the ground has to draw, world units of run
 * — PLAN §7.1's own arithmetic, in one place so the field's cut can be
 * measured against it instead of against a copied number.
 *
 * A riser occupies the middle 60% of a step, so it climbs `0.6 · tierStep`
 * of SMOOTH field; the run that takes is that over the steepest gradient on
 * the map. Measured 0.843 at the authored size (1.14 units of run) and 0.4814
 * on the doubled island (1.99), because the island is twice as wide and
 * exactly as high.
 */
export const RISER_RUN: Record<1 | 2, number> = { 1: 1.14, 2: 1.99 };

/**
 * Outer radius of the flat far field on the map being read.
 *
 * It rides the scale for a reason that is not symmetry: at the zoom floor the
 * frame is the island's own width, and on a portrait phone that floor is set
 * by the WIDTH, so the frame is ~4.3 times as tall as it is wide and looks
 * ~1.4 times the coast's reach up-screen of the island. At 1400 the far
 * corners of that frame fell off the edge of the ring and showed the void;
 * at `1400 · mapScale` the sea still runs past every corner of it
 * (test/world/camera.test.ts measures the corner against this number).
 */
export function groundRadius(): number {
  return GROUND_RADIUS * mapScale();
}
