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
 * SCALED WITH THE MAP (`MAP_SCALE`, src/world/landscape.ts — 2 from
 * 2026-09-16, then 1.1 and **1.32** on 2026-09-17). Every number below is the
 * one that shipped, times `mapScale()`: with the island off it is exactly 1
 * and this module is the set of constants it always was, and with it on the
 * field covers a coast that now reaches ~233 units from the origin.
 *
 * The SIDE is the same on every device, because the bakes span it and the
 * physics heightfield is laid over it. The CUT is not: a projection keeps the
 * 1.25-unit quad the risers were measured against, and a handset's own
 * ceiling no longer binds at this scale (see `fieldSegments`). That is the one
 * place this module asks what kind of screen it is on.
 */

import { isPhoneTier } from './device';
import { mapScale, TERRAIN } from './landscape';

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
 * [D] A CEILING on the segments per side on a handset's scaled island — 480
 * rather than the projection's `FIELD_SEGMENTS * mapScale` (640 at scale 2,
 * 352 at 1.1, where it does not bind).
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
 * 60% of its step is 0.96 / 0.4814 ≈ **1.99 units of run** (`riserRun`) —
 * and a quad has to be narrower than the riser it draws or the ground's own
 * terrace mark reads as a wash. 480 segments over 800 units is a **1.67-unit
 * quad**, still inside the riser, and the measured height error against the
 * authored field over 250,000 land samples in the camera's core is
 * **0.112 u** against 0.066 u at 640 — a fourteenth of a tier step, on the
 * device with the smallest screen. 320 segments would be a 2.5-unit quad,
 * WIDER than the riser, which is exactly the failure §7.1 rejected 160 for on
 * the old map.
 *
 * IT IS NOT RE-TRADED BELOW SCALE 1.5, AND IT DOES NOT BIND THERE
 * (2026-09-17, `MAP_SCALE` 2 then 1.3 then 1.1 then 1.32). The count is the
 * handset's own budget and not a fraction of the projection's, and every one
 * of the day's asks was about the map's size and not the phone's cut. But at
 * 1.32 the projection's own field is 422 segments, BELOW this ceiling — 480
 * over 528 units would be a 1.1-unit quad, finer than the projection's 1.25
 * and more work than the projection does — so `fieldSegments` takes the `min`
 * and a phone reads the projection's 422. The number is kept rather than
 * deleted because it is the measured budget for a bigger map and the scale has
 * moved four times in two days; it starts binding again above scale 1.5.
 */
export const FIELD_SEGMENTS_PHONE_ISLAND = 480;

/**
 * Segments per side on the map being read.
 *
 * A projection holds the QUAD at 1.25 units whatever the island's size — the
 * side rides `mapScale` and so does the count, to within the half segment the
 * rounding costs (1.25118 at 1.32). A handset takes
 * `FIELD_SEGMENTS_PHONE_ISLAND` instead, for the reason written there; with
 * no island the two are the same 320, so the public world's field is the one
 * that shipped on every device.
 */
export function fieldSegments(): number {
  if (mapScale() === 1) return FIELD_SEGMENTS;
  // ROUNDED: `MAP_SCALE` is not an integer (1.32 since 2026-09-17), and a
  // segment count has to be one. 422 at 1.32 — 422.4 rounded down, so the
  // quad is 1.25118 rather than 1.25, half a segment out over the whole side;
  // at 1.1 it happened to come out whole (352). `fieldQuad` is what a test
  // measures against the riser.
  const full = Math.round(FIELD_SEGMENTS * mapScale());
  // …and the handset's budget is a CEILING, not a substitute: at a scale
  // small enough that the projection's own cut is already finer than 480, a
  // phone takes the projection's rather than paying MORE for a map that got
  // smaller (see `FIELD_SEGMENTS_PHONE_ISLAND`).
  return isPhoneTier() ? Math.min(FIELD_SEGMENTS_PHONE_ISLAND, full) : full;
}

/** World units a single ground quad spans — 1.25 everywhere but a handset's
 * scaled island, which takes `fieldSize() / 480` (1.67 at scale 2; at 1.32 the
 * ceiling does not bind and it is 1.25118, half a segment off 1.25). Exported so a test can measure
 * it against the riser it has to draw rather than restate either number. */
export function fieldQuad(): number {
  return fieldSize() / fieldSegments();
}

/**
 * [D] The steepest gradient the SMOOTH field reaches, per map scale —
 * measured, not derived, one entry per scale that has been measured.
 *
 * The method is PLAN §7.1's and test/world/landscape.test.ts runs it: walk
 * the whole field at 0.5 units, skip the lake island (the one landform with
 * its own bound) and the flat rim past `farEnd`, and take the worst central
 * difference. Verticals do not scale and the noise wavelengths do not either,
 * so the number does NOT fall as 1/scale — a wider island has the same
 * hummocks spread further apart, not gentler ones:
 *
 *   - 1    → **0.843** (the authored island)
 *   - 1.1  → **0.4570** (2026-09-17, at 64.5, -133, on the range's apron)
 *   - 1.3  → **0.5111** (2026-09-17, at 53, -191.5, on the way down to 1.1)
 *   - 1.32 → **0.5037** (2026-09-17, at 80.4, -164.6, the range's apron
 *     again — a fifth of a unit steeper than 1.1 for the reason above: a
 *     twentieth more island puts a different hummock under the steepest walk)
 *   - 2    → **0.4814** (2026-09-16)
 */
const STEEPEST_SLOPE: Readonly<Record<string, number>> = {
  '1': 0.843,
  '1.1': 0.457,
  '1.3': 0.5111,
  '1.32': 0.5037,
  '2': 0.4814,
};

/** Units of SMOOTH climb a terrace riser carries: the middle 60% of a step. */
const RISER_CLIMB = TERRAIN.terraceStep * (TERRAIN.terraceRiser[1] - TERRAIN.terraceRiser[0]);

/**
 * [D] The narrowest terrace riser the ground has to draw at a map scale,
 * world units of run — PLAN §7.1's own arithmetic, in one place so the
 * field's cut can be measured against it instead of against a copied number.
 *
 * A riser occupies the middle 60% of a step, so it climbs `0.6 · terraceStep`
 * of SMOOTH field; the run that takes is that over the steepest gradient on
 * the map. 1.14 units at the authored size, **1.906** at 1.32, 2.101 at 1.1,
 * 1.878 at 1.3 and 1.99 on the doubled island.
 *
 * A scale nobody has measured falls back on `0.843 / √scale`, which is a
 * CONSERVATIVE stand-in and deliberately so: the measured slopes fall more
 * slowly than 1/scale (0.4814 at scale 2 against 0.4215), so √scale
 * over-states the slope, under-states the run, and makes the riser bound
 * stricter than the truth rather than looser. Measure the scale and add it to
 * `STEEPEST_SLOPE` before relying on the number.
 */
export function riserRun(scale: number = mapScale()): number {
  const measured = STEEPEST_SLOPE[String(scale)];
  return RISER_CLIMB / (measured ?? STEEPEST_SLOPE['1']! / Math.sqrt(scale));
}

/**
 * Outer radius of the flat far field on the map being read.
 *
 * It rides the scale for a reason that is not symmetry: at the zoom floor the
 * frame is the island's own width, and on a portrait phone that floor is set
 * by the WIDTH, so the frame is ~4.3 times as tall as it is wide and looks
 * ~4 times the coast's reach up-screen of the island. At 1400 the far corners
 * of that frame fell off the edge of the ring and showed the void; at
 * `1400 * mapScale` the sea still runs past every corner of it — 1848 at
 * scale 1.32 against a far corner that measures 980
 * (test/world/island-scale.test.ts and test/world/camera.test.ts both measure
 * the corner against this number rather than restating it).
 */
export function groundRadius(): number {
  return GROUND_RADIUS * mapScale();
}
