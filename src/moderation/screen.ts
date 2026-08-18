/**
 * The screen: stroke list in, verdict out.
 *
 * Pure and deterministic — the same drawing always screens to the same
 * verdict, on the world, on a phone, in a test. No DOM, no Three.js, no
 * Math.random, no Date (src/shape's discipline, PLAN §6.3).
 *
 * Three verdicts, because two would be a lie:
 *
 *   refuse — a detector that is reliable on its fixture set fired. The
 *            drawing never spawns. Today only the phallus detector can
 *            produce this.
 *   hold   — a structural detector fired that CANNOT distinguish the mark
 *            from innocent shapes on its own (the four-fold chiral test).
 *            The drawing waits for a person in the operator queue.
 *   allow  — nothing fired. This is not a statement that the drawing is
 *            harmless; it is a statement that nothing measurable fired.
 */

import type { StrokeList } from '../shape/types';
import { detectFourFold } from './fourfold';
import { largestComponentShare, screenMask, SCREEN_SIZE } from './mask';
import { detectPhallus, type DetectorScore } from './phallus';

export type Verdict = 'allow' | 'hold' | 'refuse';

export interface ScreenResult {
  /** false only for `refuse` — a held drawing is not (yet) allowed to
   * spawn, but it is not rejected either; a person decides. */
  allow: boolean;
  verdict: Verdict;
  /** Lowercase one-liner naming what fired, or null when nothing did. */
  reason: string | null;
  /** Confidence in THIS verdict, 0..1. For `allow` it falls as a detector
   * comes closer to firing, so a near miss never reads as certainty. */
  confidence: number;
  /** Every detector's raw score, for the dev readout and the tests. */
  detectors: DetectorScore[];
}

export interface ScreenOptions {
  /** Screening raster size. Ratios only, so this changes nothing but cost. */
  size?: number;
}

/** Detectors that can refuse on their own. */
const REFUSING = [detectPhallus];
/** Detectors that can only hold for a person. */
const HOLDING = [detectFourFold];

/**
 * A drawing can arrive as one mass or as separate pieces. The world keeps
 * only the largest connected component, so that is what becomes a creature
 * — but the ink a person actually drew is all of it, and screening only
 * the surviving component would let the mark be split into two strokes
 * that the world then rejoins visually. Both are screened; the stronger
 * verdict wins.
 */
function candidateMasks(strokes: StrokeList, size: number): ReturnType<typeof screenMask>[] {
  const whole = screenMask(strokes, { size });
  const share = largestComponentShare(whole);
  if (share > 0.92) return [whole];
  return [whole, screenMask(strokes, { size, largestOnly: true })];
}

export function screenDrawing(
  strokes: StrokeList,
  opts: ScreenOptions = {},
): ScreenResult {
  const size = opts.size ?? SCREEN_SIZE;
  const detectors: DetectorScore[] = [];
  let refused: DetectorScore | null = null;
  let held: DetectorScore | null = null;
  let nearest = 0;

  for (const mask of candidateMasks(strokes, size)) {
    for (const detect of REFUSING) {
      const result = detect(mask);
      detectors.push(result);
      if (result.hit && !refused) refused = result;
      // "Nearest" is measured in criteria cleared, not in margin: a
      // drawing that clears six of seven tests is the interesting case.
      const closeness = Math.max(0, (result.passed / result.total - 0.5) * 2);
      if (!result.hit && closeness > nearest) nearest = closeness;
    }
    for (const detect of HOLDING) {
      const result = detect(mask);
      detectors.push(result);
      if (result.hit && !held) held = result;
    }
  }

  if (refused) {
    return {
      allow: false,
      verdict: 'refuse',
      reason: `${refused.id}: ${refused.reason}`,
      confidence: 0.6 + 0.35 * refused.score,
      detectors,
    };
  }
  if (held) {
    return {
      allow: false,
      verdict: 'hold',
      reason: `${held.id}: ${held.reason}`,
      confidence: 0.5,
      detectors,
    };
  }
  return {
    allow: true,
    verdict: 'allow',
    reason: null,
    confidence: Math.max(0, 1 - nearest),
    detectors,
  };
}
