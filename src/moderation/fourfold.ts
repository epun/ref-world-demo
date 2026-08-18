/**
 * Four-fold chiral figure detector — the swastika family.
 *
 * WHAT IT MEASURES, and only this:
 *
 *   1. four-fold rotation — the mask lands on itself when spun a quarter
 *      turn about its own centroid, from any drawn orientation
 *   2. chirality — it does NOT land on itself under any mirror line. This
 *      is the load-bearing test: a plus, an x, a square, a four-petal
 *      flower, a clover, a sun and a snowflake are all four-fold AND
 *      mirror-symmetric, so they fall out here
 *   3. line figure — the ink covers only a small share of the disc it
 *      spans, i.e. it is drawn with strokes rather than filled vanes
 *
 * WHAT IT CANNOT DO — stated plainly because it decides how this ships:
 * it CANNOT tell a swastika from any other thin four-fold chiral figure.
 * A pinwheel drawn with straight bars, a four-armed logo, a manji, some
 * traditional ornament: structurally the same object under these three
 * measurements. "Bent arms" is inferred from four-fold + chiral + thin,
 * not measured directly — skeleton-level arm tracing was tried and is too
 * noisy at drawing resolution to carry a refusal.
 *
 * Therefore this detector NEVER refuses on its own. It returns a HOLD: the
 * drawing waits in the operator queue and a person decides (./screen.ts,
 * docs/MODERATION.md).
 *
 * Pure: no DOM, no randomness, no clock.
 */

import type { Mask } from '../shape/types';
import type { DetectorScore } from './phallus';
import { bestMirrorSymmetry, inkFrame, rotationSelfSimilarity, type InkFrame } from './mask';

export interface FourFoldFeatures {
  /** Self-overlap under a quarter turn (mean of +90 and -90). */
  rot90: number;
  /** Best self-overlap under any mirror line through the centroid. */
  mirror: number;
  /** rot90 - mirror: positive means handed. */
  chirality: number;
  /** Ink area / area of the centroid-centred disc that bounds it. */
  fill: number;
}

export const FOURFOLD_ID = 'four-fold chiral';

// Tuned on test/fixtures/moderation.ts. The innocent set's largest
// chirality is a solid-vaned pinwheel at 0.21, which the fill test rejects
// (0.45 against a 0.35 ceiling); every other innocent fixture sits at 0.02
// or below, so the chirality floor is not a knife edge.
export const CROSS_MIN_ROT90 = 0.85;
export const CROSS_MIN_CHIRALITY = 0.18;
export const CROSS_MAX_FILL = 0.35;

/** Ink area over the area of the centroid-centred disc that bounds it. */
function fillRatio(frame: InkFrame): number {
  let r2 = 0;
  for (let i = 0; i < frame.count; i++) {
    const dx = frame.px[i]! - frame.cx;
    const dy = frame.py[i]! - frame.cy;
    const d = dx * dx + dy * dy;
    if (d > r2) r2 = d;
  }
  if (r2 <= 0) return 1;
  return frame.count / (Math.PI * r2);
}

export function fourFoldFeatures(mask: Mask): FourFoldFeatures | null {
  const frame = inkFrame(mask);
  if (!frame) return null;
  const rot90 =
    (rotationSelfSimilarity(frame, Math.PI / 2) +
      rotationSelfSimilarity(frame, -Math.PI / 2)) /
    2;
  const mirror = bestMirrorSymmetry(frame);
  return { rot90, mirror, chirality: rot90 - mirror, fill: fillRatio(frame) };
}

/** Run the detector over one screening mask. */
export function detectFourFold(mask: Mask): DetectorScore {
  const f = fourFoldFeatures(mask);
  if (!f) {
    return {
      id: FOURFOLD_ID,
      hit: false,
      score: 0,
      passed: 0,
      total: 1,
      reason: 'not enough ink to measure',
    };
  }
  const checks: [string, boolean][] = [
    ['four-fold rotation', f.rot90 >= CROSS_MIN_ROT90],
    ['chirality', f.chirality >= CROSS_MIN_CHIRALITY],
    ['line figure', f.fill <= CROSS_MAX_FILL],
  ];
  const hit = checks.every(([, ok]) => ok);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    id: FOURFOLD_ID,
    hit,
    passed: checks.filter(([, ok]) => ok).length,
    total: checks.length,
    // Deliberately middling: this detector holds for a person, it never
    // refuses on its own, and the number should never read as certainty.
    score: hit ? 0.5 : 0,
    reason: hit
      ? `four-fold chiral line figure (quarter-turn overlap ${f.rot90.toFixed(2)}, best mirror ${f.mirror.toFixed(2)}, fill ${f.fill.toFixed(2)}) — needs a person`
      : `no match — failed ${failed.join(', ')}`,
  };
}
