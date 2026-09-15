/**
 * The creature's colourway, from its drawing — PURE (no Three.js, no DOM).
 *
 * The creature brief (docs/taste/creature.md, user-supplied 2026-09-15)
 * restages one rig — soft ovoid body, two dot eyes, a stalk from the head
 * ending in a topper — across colourways, and *"color itself signals
 * identity at a glance"*: each figure is a near-monochrome fill in one of
 * **red, blue, yellow, purple, pink, or grey** [M]. The user's ask on top of
 * that: *"the drawing can inform the color of the character as well as the
 * silhouette"* — so the colourway is not drawn from a hat, it is read off
 * the drawing's measured motifs (src/character/interpret.ts), the same
 * numbers that shape the body. Same drawing → same colour on every device,
 * with no seed and no salt: two people who draw the same thing get the same
 * kind of creature, which is what a type colour means.
 *
 * The rule, in order **[D]** (each is one legible fact about the drawing):
 *
 *   bird archetype ............................ pink    (winged)
 *   two or more crown protrusions ............. purple  (horned, antennaed)
 *   quadruped .................................. yellow
 *   tall (bulk aspect ≥ TALL_ASPECT) ........... blue
 *   lumpy contour (≥ LUMPY) .................... grey    (the rock type)
 *   otherwise — a smooth round doodle .......... red     (the iconic one)
 *
 * The six body hexes are ours [D]: the brief's tokens are the SHEETS'
 * palette (paper, neutrals, one dark ground), not the creatures', and its
 * measured saturation is 0.609 — vivid, warm — so these sit there rather
 * than in the world's achromatic register. Topper and stalk are tints of
 * the body toward the brief's `light` and dark neutral tokens [M], never a
 * second hue on one figure (*"color rarely mixes on one figure"*).
 */

import { CREATURE } from '../taste/tokens';
import type { Motifs } from './interpret';

export type PaletteName = 'red' | 'blue' | 'yellow' | 'purple' | 'pink' | 'grey';

export interface CreaturePalette {
  name: PaletteName;
  /** The body fill — the one hue on the figure. */
  body: string;
  /** The stalk's topper (the drawing): a light tint of the body. */
  topper: string;
  /** The stalk itself: the body pulled toward the brief's dark neutral. */
  stalk: string;
  /** Eye white — the brief's `light` token. */
  eye: string;
  /** Pupil — the brief's `ground` token, the one dark on the figure. */
  pupil: string;
}

/** Brief tokens [M] — the values live in src/taste/tokens.ts, the one home. */
export const BRIEF_LIGHT: string = CREATURE.light;
export const BRIEF_DARK_NEUTRAL: string = CREATURE.darkNeutral;
export const BRIEF_GROUND: string = CREATURE.ground;

/** Body hues [D]: one per type, vivid (brief saturation 0.609). */
export const BODY_HUES: Readonly<Record<PaletteName, string>> = {
  red: CREATURE.red,
  blue: CREATURE.blue,
  yellow: CREATURE.yellow,
  purple: CREATURE.purple,
  pink: CREATURE.pink,
  grey: CREATURE.grey,
};

/** Bulk aspect (height / width) at which a drawing reads as tall. [D] */
export const TALL_ASPECT = 1.3;
/** Contour lumpiness at which a drawing reads as a rock. [D] */
export const LUMPY = 0.3;
/** How far the topper tint goes toward light, and the stalk toward dark. [D] */
export const TOPPER_TINT = 0.55;
export const STALK_SHADE = 0.45;

/** Which type a drawing is, by the rule in the header. Pure. */
export function paletteNameFor(motifs: Motifs): PaletteName {
  if (motifs.archetype === 'bird') return 'pink';
  if (motifs.crown.length >= 2) return 'purple';
  if (motifs.archetype === 'quadruped') return 'yellow';
  if (motifs.aspect >= TALL_ASPECT) return 'blue';
  if (motifs.lumpiness >= LUMPY) return 'grey';
  return 'red';
}

/** The full colourway for a drawing. Pure. */
export function paletteFor(motifs: Motifs): CreaturePalette {
  return paletteNamed(paletteNameFor(motifs));
}

/** The colourway of a named type — the dev panel's override path. Pure. */
export function paletteNamed(name: PaletteName): CreaturePalette {
  const body = BODY_HUES[name];
  return {
    name,
    body,
    topper: mixHex(body, BRIEF_LIGHT, TOPPER_TINT),
    stalk: mixHex(body, BRIEF_DARK_NEUTRAL, STALK_SHADE),
    eye: BRIEF_LIGHT,
    pupil: BRIEF_GROUND,
  };
}

export const PALETTE_NAMES: readonly PaletteName[] = [
  'red',
  'blue',
  'yellow',
  'purple',
  'pink',
  'grey',
];

/** Linear mix of two `#rrggbb` values in sRGB, t toward `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const pa = parseHex(a);
  const pb = parseHex(b);
  const out = pa.map((v, i) => Math.round(v + (pb[i]! - v) * k));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
