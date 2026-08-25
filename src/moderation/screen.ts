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

import type { StrokeList } from '../shape/types.js';
import { detectFourFold } from './fourfold.js';
import { largestComponentShare, screenMask, SCREEN_SIZE } from './mask.js';
import { detectPhallus, type DetectorScore } from './phallus.js';

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

/**
 * Screening resolutions.
 *
 * The criteria are ratios, so in principle resolution changes nothing —
 * in practice it decides the verdict. The same doodle was measured hitting
 * at 96, 128, 192 and 256 and MISSING at 160, which was the one size the
 * screen actually ran (user report: it still let one through). Binning a
 * hand-drawn shape into forty width bins puts several criteria on a knife
 * edge, and which side they land is an artefact of the raster.
 *
 * So the shape is read at several scales and the STRONGEST verdict wins: a
 * drawing that reads as a phallus at any scale is one, and is not admitted
 * because one particular grid happened to smear a notch shut.
 */
const SCREEN_SIZES = [96, 128, 160, 224] as const;

/**
 * How many criteria a drawing may fail and still be HELD for a person
 * rather than admitted. One. A shape that clears six of seven tests of
 * "shaft with twin round lobes" is not something to wave through on the
 * strength of the seventh — but neither is it certain enough to refuse
 * outright, which is exactly what holding is for.
 */
const HOLD_WITHIN = 1;

/** A near miss only counts when the detector actually measured the shape:
 * an unmeasurable scrap reports no criteria and would otherwise clear the
 * band trivially (a single dot held, before this). */
const MIN_CRITERIA_FOR_HOLD = 3;

export function screenDrawing(
  strokes: StrokeList,
  opts: ScreenOptions = {},
): ScreenResult {
  // One explicit size means one size; otherwise read the shape at several
  // (see SCREEN_SIZES) so a raster artefact cannot decide the verdict.
  const sizes = opts.size === undefined ? SCREEN_SIZES : [opts.size];
  const detectors: DetectorScore[] = [];
  let refused: DetectorScore | null = null;
  let held: DetectorScore | null = null;
  let nearMiss: DetectorScore | null = null;
  let nearest = 0;

  for (const size of sizes) {
    for (const mask of candidateMasks(strokes, size)) {
      for (const detect of REFUSING) {
        const result = detect(mask);
        detectors.push(result);
        if (result.hit && !refused) refused = result;
        // Short of a refusal by a single criterion: too close to admit.
        // A detector that could not measure the shape at all reports no
        // criteria — that is ignorance, not a near miss, and ink too small
        // or too sparse to read must never be held on the strength of it.
        if (
          !result.hit &&
          result.total >= MIN_CRITERIA_FOR_HOLD &&
          result.passed >= result.total - HOLD_WITHIN &&
          !nearMiss
        ) {
          nearMiss = result;
        }
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
  }
  // A near miss holds — after the outright refusals and the holding
  // detectors have had their say.
  if (!refused && !held && nearMiss) {
    held = {
      ...nearMiss,
      reason: `close to ${nearMiss.id} (${nearMiss.passed}/${nearMiss.total} criteria) — held for a person`,
    };
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
