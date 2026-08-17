/**
 * Taste tokens — the single source of truth for every color, duration, and
 * threshold that the two briefs govern.
 *
 * Provenance discipline (docs/TASTE.md §0): values marked [M] are measured,
 * exported straight from a brief and not ours to negotiate. Values marked [D]
 * are derived — our project decisions, consistent with the briefs but never
 * attributable to them. Change [D] on evidence; change [M] only when a new
 * export arrives.
 */

// ── World palette [M] ────────────────────────────────────────────────────────
// ref export, collection 20088c20-73c6-4158-9585-7ef7e6942559.
// Near-achromatic greys. There is no pastel in this taste.

export const WORLD = {
  /** Supporting tone, prevalence 0.82 */
  neutralDark: '#666764',
  /** Supporting tone, prevalence 0.82. Ground sits near this value. */
  neutralMid: '#b6b6af',
  /** Light role — highlights and light-struck surfaces, NOT the ground. */
  light: '#e9ebe9',
  /** The darkest the environment is allowed to go. */
  ink: '#353534',
  /** Supporting tone, prevalence 0.44 */
  neutral: '#92928e',
  /** Near-black exists in the corpus at 0.09 prevalence. It is the character. */
  nearBlack: '#0c0d0d',
} as const;

// ── Character palette [M] ────────────────────────────────────────────────────
// Character brief tokens.

export const CHARACTER = {
  /** Body fill. The only near-black on screen — the world never approaches it. */
  body: '#080808',
  /** Eye knockout — reads as negative space punched through the fill. */
  eye: '#f4f3ef',
  /**
   * The one warm accent. Character palette only, never environmental.
   * [D] At most one accent element on screen at a time: the hatch flash,
   * or your own marker on the minimap.
   */
  accent: '#fb5429',
} as const;

// ── Applied surfaces [D] ─────────────────────────────────────────────────────
// Assignments are ours (TASTE §6); the values they point at are measured.

export const SURFACE = {
  /** World ground — mid-toned neutral targeting groundLuma 0.74 [M]. */
  ground: '#c2c2bb',
  /** Flat shadow fill. One value, hard edge, no penumbra (TASTE §2.4). */
  shadow: '#92928e',
  /** Phone drawing canvas ground (light role). */
  canvas: WORLD.light,
  /** Environment linework and deepest marks. Floor for all environment values. */
  ink: WORLD.ink,
} as const;

// ── Color metrics [M] ────────────────────────────────────────────────────────
// Verification-gate targets, straight from the export.

export const COLOR_METRICS = {
  saturation: 0.188,
  contrast: 0.577,
  groundLuma: 0.74,
} as const;

// ── Density [M] ──────────────────────────────────────────────────────────────

export const DENSITY = {
  /** spacing.density and composition.density both measure 0.39. */
  global: 0.39,
  /**
   * [D] Negative-space exclusion radius around each character, in world units.
   * Scatter placement never enters it (TASTE §2.3).
   */
  exclusionRadius: 6,
} as const;

// ── Motion [M]+[D] ───────────────────────────────────────────────────────────
// The constraints (no overshoot / bounce / cut / stop) are confidence 1.00.
// The 1823ms median is confidence 0.06 — a starting point to tune, per TASTE §2.1.

export const MOTION = {
  /** [D] scale built around the measured median */
  tertiaryMs: 456,
  secondaryMs: 912,
  /** [M] animationCurves.medianDurationMs */
  primaryMs: 1823,
  ambientMs: 3646,
  /**
   * Drift settle: strong ease-out, zero overshoot, long tail.
   * The CSS-side equivalent of the ζ≥1 spring.
   */
  settleCurve: 'cubic-bezier(0.17, 0.72, 0.24, 1.0)',
  /**
   * [D] Ambient floor amplitude, as a fraction of an element's scale.
   * "Settles by drifting, not springing back" taken literally: nothing on
   * screen ever fully arrests.
   */
  ambientAmplitude: 0.003,
} as const;

// ── Lighting [M] ─────────────────────────────────────────────────────────────

export const LIGHTING = {
  /** lighting.softness 0.117 — hard, sharp shadow edges. */
  softness: 0.117,
  /** lighting.keyToFill 0.333 — even, non-directional. */
  keyToFill: 0.333,
} as const;

// ── Grain [M]+[D] ────────────────────────────────────────────────────────────
// "A steady grain sits over gloss finishes" — defining, 100% of corpus.
// [D] Full-frame post-process, never a material texture (TASTE §2.7): grain is
// the surface of the image, not of the mark, and must not vary across a
// character's fill.

export const GRAIN = {
  /** Low amplitude — the corpus reads polished, not tactile. */
  amplitude: 0.035,
} as const;

// ── Graphic layer [M] ────────────────────────────────────────────────────────
// The world brief's #1 defining signal. UI may use these marks and nothing else.

export const MARK_KINDS = ['icon', 'ruleLine', 'border'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];
