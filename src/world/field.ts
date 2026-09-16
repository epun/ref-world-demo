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
 * covers a coast that now reaches ~352 units from the origin. The QUAD SIZE
 * is what is held fixed across that — 1.25 units, because the terrace risers
 * are the finest thing on the map and a quad wider than a riser washes the
 * drawn contour out (PLAN §7.1 measured it) — so the segment count doubles
 * with the side and the triangle count goes up fourfold.
 */

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
 * Segments per side on the map being read — the side through `mapScale`, so
 * the QUAD stays 1.25 units whatever the island's size (see the header).
 *
 * 640 on the doubled island: 819,200 triangles against 204,800, which is the
 * cost of keeping the risers drawn rather than washed. Measured both ways —
 * PLAN §7.1's riser-height-error method — before it was kept.
 */
export function fieldSegments(): number {
  return FIELD_SEGMENTS * mapScale();
}

/** World units a single ground quad spans. The constant the two numbers above
 * exist to hold: exported so a test can measure it rather than restate it. */
export function fieldQuad(): number {
  return fieldSize() / fieldSegments();
}

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
