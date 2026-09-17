/**
 * ZERO GRAVITY — the local presentation of a shared flag. PURE (no Three.js,
 * no DOM, no clock of its own, no randomness).
 *
 * > User ask, 2026-09-17: *"i want a zero gravity mode where i can hit g on
 * > the keyboard and it turns off gravity for the map. characters should float
 * > in space."*
 *
 * WHAT TRAVELS IS ONE BIT. Gravity is a scene change, so it rides the session
 * log out over the sync topic and into `refworld:<world>:scene` like the
 * landscape switch and the terrain dials, and every page applies it through
 * the one replay driver (CLAUDE.md, docs/PLAN.md §7.6). What does NOT travel
 * is where anything ends up: poses carry x/z/heading and **Y is always
 * local**, which is the same rule the ball's ground clearance and the
 * walk/roll blend already follow. So each page derives the whole float from
 * the flag and its own clock, and this file is that derivation.
 *
 * THREE THINGS, all **[D]** — the taste briefs say nothing about weightless
 * characters, so none of it is attributable to them:
 *
 *   `floatHeight(seed)`  how high THIS creature hangs. Seeded by the slot id,
 *                        so a room of eighty does not hang at one altitude
 *                        like a shelf. Same discipline as `behaviorSeed`: a
 *                        creature's hidden numbers come from its id and
 *                        nothing else, so every page puts it at the same
 *                        altitude without a byte about it.
 *   `floatBob(t, seed)`  the ambient drift up there. Two incommensurate sines,
 *                        so it never repeats and nothing fully arrests
 *                        (TASTE §3, confidence 1.00) — the ground has the
 *                        character's own drift floor and the air has this.
 *   `floatTumble(t, s)`  a slow turn, as two angles. Written on the ROOT's x
 *                        and z (its y is the heading and belongs to the
 *                        locomotion), so the whole assembly — ball, pile,
 *                        passengers and the creature on the pole — tilts
 *                        together rather than the creature coming off its own
 *                        ball.
 *
 * All three are multiplied by the BLEND, a ζ ≥ 1 spring in the manager over
 * `MOTION.primaryMs`: lift-off is a slide up, `g` again is a slow settle back
 * onto the surface, and at rest on the ground the product is exactly 0 — the
 * placement the world shipped with, to the float. Nothing here can overshoot,
 * because the only thing with a target is that spring.
 *
 * THE PHASE IS EACH PAGE'S OWN CLOCK, and that is deliberate: two screens
 * agree that the world is weightless and about how high each creature hangs,
 * not about which centimetre of its bob it is on this instant. Agreeing on
 * that would need Y on the wire, which is the invariant this file exists
 * underneath.
 */

import { MOTION } from '../taste/tokens';

/**
 * [D] The lowest a creature floats, world units. Three units is over three
 * hatchling body-heights and reads unmistakably as off the ground at the
 * default framing (~0.05 world units a pixel).
 */
export const FLOAT_LIFT_MIN = 3;

/**
 * [D] …and the spread above it. 3 to 8 units: a room full of creatures at
 * visibly different altitudes, which is what makes it read as floating
 * rather than as a layer.
 */
export const FLOAT_LIFT_RANGE = 5;

/**
 * [D] Ambient drift amplitude up there, world units. Well under
 * `FLOAT_LIFT_MIN`, so a bob can never push a floating creature back into the
 * ground however the two sines line up.
 */
export const FLOAT_BOB = 0.55;

/**
 * [D] Tumble amplitude, radians — about 18°. A sway rather than a somersault:
 * the drawn creature's topper faces the heading and a creature rolled fully
 * over would be upside down, which reads as broken rather than weightless.
 */
export const FLOAT_TUMBLE = 0.32;

/**
 * [D] The bob's two periods, from the motion tokens rather than literals
 * (CLAUDE.md: durations come from motion tokens). `ambientMs` is the slowest
 * beat the scale has; doubled it is a seven-second rise and fall, and the
 * second sine is that over √2 so the pair never repeats.
 */
export const FLOAT_BOB_MS = MOTION.ambientMs * 2;
export const FLOAT_BOB_RATIO = Math.SQRT2;

/** [D] …and the tumble's, slower again: a full lean takes twenty seconds. */
export const FLOAT_TUMBLE_MS = MOTION.ambientMs * 3;
export const FLOAT_TUMBLE_RATIO = 1.618;

/**
 * [D] Where the blend counts as SETTLED, at either end.
 *
 * A ζ ≥ 1 spring approaches its target asymptotically and never arrives, so
 * without this a world whose gravity was turned back on would hold every
 * creature a picometre off the ground and pay two sines a frame for it
 * forever. A ten-thousandth of the blend is 0.0008 world units of height —
 * two orders finer than the spring's own settle (`settleMs` is "within ~1%")
 * and far under the float of the numbers it is compared against, so the
 * creature is exactly where it shipped and the snap is not a motion anything
 * could see. It is NOT a shortcut at the top end: 0.9999 of the blend is
 * already the whole lift.
 */
export const FLOAT_SETTLED = 1e-4;

/** A seed to 0..1, from the top bits (the low bits of an FNV hash of a short
 * id move barely at all between neighbours). */
function unit(seed: number, salt: number): number {
  const h = Math.imul(seed ^ Math.imul(salt, 0x9e3779b1), 2654435761) >>> 0;
  return (h >>> 8) / 0x1000000;
}

/**
 * How high this creature hangs when gravity is off, world units.
 *
 * A constant per creature, not a function of its size: a ball's root is its
 * underside, so lifting every root by the same 3–8 units lifts every ball
 * clear of the paper whatever it is carrying, and a big ball hanging the same
 * distance off the ground as a hatchling is the picture the ask describes.
 */
export function floatHeight(seed: number): number {
  return FLOAT_LIFT_MIN + FLOAT_LIFT_RANGE * unit(seed, 1);
}

/**
 * The ambient drift on top of it at `tMs`, world units, in
 * [−FLOAT_BOB, +FLOAT_BOB].
 */
export function floatBob(tMs: number, seed: number): number {
  const phase = unit(seed, 2) * Math.PI * 2;
  const a = Math.sin((tMs / FLOAT_BOB_MS) * Math.PI * 2 + phase);
  const b = Math.sin((tMs / (FLOAT_BOB_MS * FLOAT_BOB_RATIO)) * Math.PI * 2 + phase * 1.7);
  return FLOAT_BOB * (a * 0.7 + b * 0.3);
}

/**
 * The slow tumble at `tMs`, as the two angles to write on the root's x and z.
 * Bounded by `FLOAT_TUMBLE` on each axis.
 */
export function floatTumble(tMs: number, seed: number): { x: number; z: number } {
  const phase = unit(seed, 3) * Math.PI * 2;
  const x = Math.sin((tMs / FLOAT_TUMBLE_MS) * Math.PI * 2 + phase);
  const z = Math.cos(
    (tMs / (FLOAT_TUMBLE_MS * FLOAT_TUMBLE_RATIO)) * Math.PI * 2 + phase * 1.3,
  );
  return { x: FLOAT_TUMBLE * x, z: FLOAT_TUMBLE * z };
}
