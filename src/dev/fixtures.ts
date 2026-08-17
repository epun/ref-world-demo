/**
 * Deterministic fallback drawings for the dev panel's "spawn fallback
 * creatures" button — tiny hand-authored stroke lists in the same idiom as
 * test/fixtures/strokes.ts (fixed parameters, no randomness, no bitmap).
 *
 * They live in src/dev/ on purpose: only the lazily-loaded dev chunk imports
 * them, so they tree-shake out of the demo build along with the panel.
 */

import type { Stroke, StrokeList } from '../shape/types';

/** Dev pacing for fallback eggs — short enough to watch a hatch land. */
export const FALLBACK_HATCH_MS = 3000;

/** A filled disc: a single stamped point whose width is the diameter. */
function disc(cx: number, cy: number, r: number): Stroke {
  return { pts: [[cx, cy, 1]], w: r * 2 };
}

/** A straight capsule stroke from (x0,y0) to (x1,y1) with constant width. */
function capsule(x0: number, y0: number, x1: number, y1: number, w: number): Stroke {
  return {
    pts: [
      [x0, y0, 1],
      [x1, y1, 1],
    ],
    w,
  };
}

/** A round potato blob. Expected archetype: 'blob'. */
const blob: StrokeList = [disc(0.5, 0.52, 0.26), disc(0.62, 0.42, 0.14)];

/** Snowman with two legs. Expected archetype: 'biped'. */
const biped: StrokeList = [
  disc(0.5, 0.62, 0.2),
  disc(0.5, 0.32, 0.13),
  capsule(0.42, 0.75, 0.42, 0.94, 0.05),
  capsule(0.58, 0.75, 0.58, 0.94, 0.05),
];

/** Wide body on four legs. Expected archetype: 'quadruped'. */
const quadruped: StrokeList = [
  capsule(0.3, 0.45, 0.7, 0.45, 0.28),
  capsule(0.32, 0.5, 0.32, 0.8, 0.05),
  capsule(0.44, 0.5, 0.44, 0.8, 0.05),
  capsule(0.56, 0.5, 0.56, 0.8, 0.05),
  capsule(0.68, 0.5, 0.68, 0.8, 0.05),
];

/** The rotation the spawn button walks through. */
export const FALLBACK_DRAWINGS: readonly StrokeList[] = [blob, biped, quadruped];
