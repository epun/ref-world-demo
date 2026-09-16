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

// ── Creature palette (creature brief, 2026-09-15) ────────────────────────────
// docs/taste/creature.md — TASTE §8. The brief's own tokens [M] are the
// sheets' palette (paper, neutrals, one dark ground); the six body hues are
// ours [D], pitched at its measured saturation (0.609, vivid, warm). One hue
// per creature, never mixed; topper and stalk are tints of the body toward
// `light` and `darkNeutral` (src/character/palette.ts).

export const CREATURE = {
  /** [M] Highlights and light-struck surfaces — the eye white, the topper tint. */
  light: '#f7f4f1',
  /** [M] The dark supporting tone — what the stalk is tinted toward. */
  darkNeutral: '#544c50',
  /** [M] The brief's ground token — the pupil, the one dark on the figure. */
  ground: '#1a1717',
  /** [D] The six types. */
  red: '#d9483b',
  blue: '#4f86c6',
  yellow: '#e9b93a',
  purple: '#8b63b8',
  pink: '#e58aae',
  grey: '#9b9591',
} as const;

// ── Applied surfaces [D] ─────────────────────────────────────────────────────
// Assignments are ours (TASTE §6); the values they point at are measured.

export const SURFACE = {
  /**
   * World ground and sky field. The measured target is groundLuma 0.74 [M]
   * (see COLOR_METRICS, left untouched — measured data is never rewritten);
   * this value is a deliberate USER OVERRIDE picked in the panel's color
   * picker and exported as the shipped default (luma ~0.87 — lighter paper
   * than the ref). The value-histogram gate reports the drift against the
   * measured reference rather than hiding it.
   */
  ground: '#dfdfdf',
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

// ── Ghibli style — user override (2026-09-15) [D] ────────────────────────────
// Ported verbatim from envpaint's `ghibli-toon` style (src/styles/ghibli-toon.js
// and src/core/Sun.js). NOT a measured taste value, and not attributable to
// either brief: a single world (valiocon) opts into a saturated cel palette
// instead of the near-achromatic one. Everything above stays the default and
// every other deployment keeps rendering from it. See docs/TASTE.md §9.
//
// Nothing here may leak into a world on the `ink` style — it is reached only
// through src/world/style.ts, and only when that resolves to `ghibli`.

export const GHIBLI = {
  /** Warm key. */
  sun: '#fff3d6',
  /** Cool hemisphere sky. */
  sky: '#dcecff',
  /** Hemisphere bounce off the meadow. */
  hemiGround: '#9cb07a',
  /** Scene background — envpaint's skyTop. */
  background: '#bfe0ff',
  fog: '#e9f0f6',
  /** Contour/ink colour: a violet-blue, never black. */
  ink: '#2a2340',
  // terrain albedos
  meadow: '#8fcf5a',
  lush: '#6ab545',
  dirt: '#c69a63',
  dirtEdge: '#a57b4d',
  /** Steep-slope rock on the ground shader. */
  rock: '#9a9aa6',
  snow: '#f6f9ff',
  ash: '#4a4643',
  char: '#2f2a27',
  // grass marks
  grassBase: '#5aa845',
  /**
   * The blade's tip. envpaint's own is `#cfe872` — a cool, bluish yellow-green
   * that, at this world's blade density, made the whole field read a value
   * lighter and a good deal bluer than the meadow it stands in, so the window
   * the field covers showed up as a pale lozenge on the lawn (2026-09-15, user
   * direction: it *"must be invisible"*). Pulled into the meadow's own family
   * — warmer, less blue, still lighter than the base. **[D]**
   */
  grassTip: '#a8d964',
  /** Sun-bleached blade, where the patchiness noise runs high. Warmed with the
   * tip above, and for the same reason. **[D]** */
  grassDry: '#d8cd6a',
  // wild flowers — envpaint's `flowers` palette, one bloom picked per stem
  flowerWhite: '#fff8f0',
  flowerYellow: '#ffe45c',
  flowerPink: '#ff9fc4',
  flowerBlue: '#8fb4ff',
  flowerStem: '#4f9a3c',
  /** The bloom's eye. A blue bloom takes `flowerWhite` instead. */
  flowerCentre: '#f7c948',
  // rocks and built things
  rockBody: '#8f8c88',
  /** The warm paper of built props. */
  rockWarm: '#bfb8ab',
  rockCool: '#5f7396',
  moss: '#6fa04a',
  // clouds
  cloudLit: '#ffffff',
  cloudShade: '#b9c8e6',
  // trees
  canopyShade: '#3f7d34',
  canopyLight: '#9ad35a',
  canopyHighlight: '#d8f08a',
  trunk: '#7a5a3a',
  // water
  waterDeep: '#2b6ec2',
  waterMid: '#3d8fe0',
  waterShallow: '#79c6f4',
  foam: '#f7ffff',
  /** The thin wet line where a fill meets its shore. */
  waterWet: '#2a62b0',
  /** The hand-drawn wave glyph on a still surface. */
  waterHighlight: '#f6fdff',
  // the tropical island (2026-09-15, user ask: a tropical island, ghibli
  // meets scavengers reign). Same palette family as the water above, pitched
  // for open sea and dry sand rather than a lake.
  seaDeep: '#2f7fc4',
  seaShallow: '#7fd0ef',
  sand: '#e9d9a8',
  /** The darker band of sand in the last units before the waterline. */
  sandWet: '#cbb27e',
  /** Dry sand's own shade band, and the beach's ink-free contour. */
  sandDark: '#a98d5c',
  /** envpaint's terrain `wetSand`: the shallow band the ground takes under water. */
  wetSand: '#7f7a55',
  /**
   * Cool violet-blue shadow multiplier, LINEAR — set straight onto a Color's
   * components, never through the srgb transfer curve.
   */
  shadowTint: [0.5, 0.66, 0.82] as [number, number, number],
  /** n·l where lit flips to shadow. */
  bandEdge: 0.22,
  /** Terminator softness. */
  bandSoft: 0.04,
  /** Strength of the thin mid band; 0 is a pure two-tone. */
  halfTone: 0.35,
  /** Silhouette edge light on the shade side. */
  rim: 0.18,
} as const;
