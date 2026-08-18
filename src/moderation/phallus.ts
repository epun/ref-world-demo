/**
 * The phallus doodle detector.
 *
 * WHAT IT LOOKS FOR — one specific, very stereotyped mark: an elongated
 * shaft with TWO similar round lobes at one end, the whole thing roughly
 * mirror-symmetric about the shaft axis, and the other end NOT twin-lobed.
 * That combination is what makes the doodle recognisable to a person, and
 * it is measurable without any learned model:
 *
 *   1. elongation   — the shaft is at least ~2x longer than it is wide
 *   2. bulge        — the lobed end is measurably wider than the shaft
 *   3. twin lobes   — the end profile has two outward peaks with a notch
 *                     between them (two circles touching leave a cusp at
 *                     the axis exactly one lobe-radius deep)
 *   4. roundness    — each lobe carries a fat inscribed disc, so a forked
 *                     tail, a pair of thin fins, or a V never qualifies
 *   5. symmetry     — the mask mirrors onto itself about the shaft axis
 *   6. one end only — the far end has no comparable notch, which is what
 *                     separates this from a bone, a dumbbell or a barbell
 *
 * WHAT IT DOES NOT LOOK FOR: anatomy, skin, context, or intent. It is a
 * silhouette test. A drawing that means the same thing but is shaped
 * differently (drawn in perspective, drawn with the lobes apart, drawn as
 * a face, written as a word) is not caught here — see the module docs in
 * ./index.ts for what covers those cases.
 *
 * Pure: no DOM, no randomness, no clock.
 */

import type { Mask } from '../shape/types';
import { dtAt, inkAt, inkFrame, type InkFrame } from './mask';

export interface EndFeatures {
  /** +1 for the end at max u along the principal axis, -1 for the other. */
  side: 1 | -1;
  /** Cap width / shaft width. */
  bulge: number;
  /** Notch depth between the two lobes, in lobe radii. */
  notch: number;
  /** Smallest lobe inscribed radius / lobe radius from the peak spread. */
  roundness: number;
  /** |smaller lobe offset| / |larger lobe offset| — 1 is a balanced pair. */
  balance: number;
}

export interface PhallusFeatures {
  /** Axis length / shaft width. */
  elongation: number;
  /** Ink mirrored about the principal axis that lands on ink. */
  symmetry: number;
  /** Both ends, measured independently. Each is tested as the candidate
   * lobed end with the other as its "far end" — picking a single end up
   * front by one metric is what made the first cut misread rotations. */
  ends: [EndFeatures, EndFeatures];
}

export interface DetectorScore {
  /** Stable detector id, for logs and tests. */
  id: string;
  /** Did every criterion clear its threshold? */
  hit: boolean;
  /** 0..1 — mean margin across the criteria, for reporting only. */
  score: number;
  /** How many criteria cleared, out of how many were tested. A drawing
   * that clears 6 of 7 is a near miss; one that clears 3 is not. */
  passed: number;
  total: number;
  /** Lowercase, one line (TASTE §5: no uppercase anywhere). */
  reason: string;
}

// ── thresholds ───────────────────────────────────────────────────────────────
// Tuned on test/fixtures/moderation.ts: every threshold is the loosest value
// that still leaves the innocent fixture set with zero hits. Numbers are
// ratios, so they hold at any raster size and any rotation.

export const PHALLUS_MIN_ELONGATION = 2.8;
export const PHALLUS_MIN_BULGE = 2.0;
export const PHALLUS_MIN_NOTCH = 0.35;
export const PHALLUS_MIN_ROUNDNESS = 0.62;
export const PHALLUS_MIN_BALANCE = 0.6;
export const PHALLUS_MIN_SYMMETRY = 0.85;
/** The far end may not look twin-lobed too (bones, dumbbells, bows). */
export const PHALLUS_MAX_OTHER_NOTCH = 0.25;
/** Minimum notch depth as a share of the whole shape's axis length: below
 * this a "notch" is raster jitter on a rounded tip, not a drawn cusp. */
const NOTCH_NOISE_FLOOR = 0.03;

const U_BINS = 40;
const V_BINS = 25;

/** Median of a copied, sorted array. Empty → 0. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Mirror the ink about the principal axis and measure the overlap. */
function axisSymmetry(frame: InkFrame): number {
  let hit = 0;
  for (let i = 0; i < frame.count; i++) {
    const u = frame.u[i]!;
    const v = -frame.v[i]!;
    const x = frame.cx + u * frame.ax + v * frame.bx;
    const y = frame.cy + u * frame.ay + v * frame.by;
    if (inkAt(frame.mask, x, y)) hit++;
  }
  return hit / frame.count;
}

/** Measure one end of the shape (side = +1 → the max-u end). */
function endFeatures(frame: InkFrame, side: 1 | -1): EndFeatures {
  const length = frame.uMax - frame.uMin;
  const none: EndFeatures = { side, bulge: 0, notch: 0, roundness: 0, balance: 0 };
  if (length <= 0) return none;

  // w runs from 0 at the far end to `length` at this end.
  const w = new Float32Array(frame.count);
  for (let i = 0; i < frame.count; i++) {
    w[i] = side === 1 ? frame.u[i]! - frame.uMin : frame.uMax - frame.u[i]!;
  }

  // Width profile along the axis.
  const lo = new Float64Array(U_BINS).fill(Infinity);
  const hi = new Float64Array(U_BINS).fill(-Infinity);
  for (let i = 0; i < frame.count; i++) {
    const b = Math.min(U_BINS - 1, Math.floor((w[i]! / length) * U_BINS));
    const v = frame.v[i]!;
    if (v < lo[b]!) lo[b] = v;
    if (v > hi[b]!) hi[b] = v;
  }
  const widths: number[] = [];
  for (let b = 0; b < U_BINS; b++) {
    widths.push(hi[b]! >= lo[b]! ? hi[b]! - lo[b]! : 0);
  }

  // The cap is the outer 34% at this end; the shaft is sampled from the
  // 15–55% band, which is clear of both the cap and the far end's own tip.
  const capFrom = Math.floor(U_BINS * 0.66);
  const shaftBins = widths.slice(Math.floor(U_BINS * 0.15), Math.floor(U_BINS * 0.55));
  const shaftWidth = median(shaftBins.filter((x) => x > 0));
  if (shaftWidth <= 0) return none;
  let capWidth = 0;
  for (let b = capFrom; b < U_BINS; b++) if (widths[b]! > capWidth) capWidth = widths[b]!;

  // End profile: how far out the silhouette reaches at each offset from the
  // axis, sampled across the cap's own v extent.
  const capW = (length * capFrom) / U_BINS;
  let capVLo = Infinity;
  let capVHi = -Infinity;
  for (let i = 0; i < frame.count; i++) {
    if (w[i]! < capW) continue;
    const v = frame.v[i]!;
    if (v < capVLo) capVLo = v;
    if (v > capVHi) capVHi = v;
  }
  if (!Number.isFinite(capVLo) || capVHi <= capVLo) return none;
  const span = capVHi - capVLo;
  const reach = new Float64Array(V_BINS).fill(-Infinity);
  for (let i = 0; i < frame.count; i++) {
    if (w[i]! < capW) continue;
    const b = Math.min(V_BINS - 1, Math.floor(((frame.v[i]! - capVLo) / span) * V_BINS));
    if (w[i]! > reach[b]!) reach[b] = w[i]!;
  }
  const vOf = (b: number): number => capVLo + ((b + 0.5) / V_BINS) * span;

  // Peak on each side of the axis (v = 0 is the symmetry line). A flat-
  // topped lobe ties across several bins, so the peak position is the mean
  // of every bin within a pixel of that side's best — taking the first
  // winner instead would bias the two sides in opposite directions and
  // make a perfectly symmetric pair read as unbalanced.
  const sidePeak = (
    sign: 1 | -1,
  ): { peak: number; v: number; bLo: number; bHi: number } | null => {
    let peak = -Infinity;
    for (let b = 0; b < V_BINS; b++) {
      const r = reach[b]!;
      if (Number.isFinite(r) && Math.sign(vOf(b)) === sign && r > peak) peak = r;
    }
    if (!Number.isFinite(peak)) return null;
    let sum = 0;
    let n = 0;
    let bLo = V_BINS;
    let bHi = -1;
    for (let b = 0; b < V_BINS; b++) {
      const r = reach[b]!;
      if (!Number.isFinite(r) || Math.sign(vOf(b)) !== sign) continue;
      if (r < peak - 1) continue;
      sum += vOf(b);
      n++;
      if (b < bLo) bLo = b;
      if (b > bHi) bHi = b;
    }
    return { peak, v: sum / n, bLo, bHi };
  };
  const pos = sidePeak(1);
  const neg = sidePeak(-1);
  if (!pos || !neg) return none;
  const peakPos = pos.peak;
  const peakNeg = neg.peak;
  const vPos = pos.v;
  const vNeg = neg.v;
  const bPos = pos.bLo;
  const bNeg = neg.bHi;
  const bulge = capWidth / shaftWidth;
  const lobeRadius = (Math.abs(vPos) + Math.abs(vNeg)) / 2;
  const balance =
    Math.min(Math.abs(vPos), Math.abs(vNeg)) /
    Math.max(Math.abs(vPos), Math.abs(vNeg), 1e-6);
  const flat: EndFeatures = { side, bulge, notch: 0, roundness: 0, balance };

  // Twin lobes need two peaks that are really apart, with sampled profile
  // BETWEEN them: a round single end puts its two "peaks" in the two bins
  // either side of the axis with nothing in between, and reads as flat.
  if (bPos - bNeg < 2) return flat;
  if (lobeRadius < 0.15 * (span / 2)) return flat;

  // The notch: the shallowest reach strictly between the two peaks.
  let notchReach = Infinity;
  for (let b = bNeg + 1; b < bPos; b++) {
    const r = reach[b]!;
    if (Number.isFinite(r) && r < notchReach) notchReach = r;
  }
  if (!Number.isFinite(notchReach)) return flat;

  // Rasterization noise floor: a wobbly round tip dips a pixel or two and,
  // divided by a tiny lobe radius, would read as a deep notch. A real cusp
  // between two drawn balls is a few percent of the whole shape's length.
  const notchDepth = Math.min(peakPos, peakNeg) - notchReach;
  if (notchDepth < NOTCH_NOISE_FLOOR * length) return flat;

  // Lobe fatness: the biggest inscribed disc within one lobe-radius of each
  // peak. A drawn ball fills that window; a thin fin, a leg or a fork tine
  // leaves it nearly empty. Sampling the whole half-cap instead would read
  // the body mass beside the lobe, which is exactly the trap a standing
  // figure with two legs sets.
  const lobeDt = (vPeak: number, wPeak: number): number => {
    let best = 0;
    for (let i = 0; i < frame.count; i++) {
      if (w[i]! < capW) continue;
      if (Math.abs(frame.v[i]! - vPeak) > 0.7 * lobeRadius) continue;
      if (wPeak - w[i]! > 1.4 * lobeRadius) continue;
      const d = dtAt(frame.distance, frame.px[i]!, frame.py[i]!);
      if (d > best) best = d;
    }
    return best;
  };

  return {
    side,
    bulge,
    // Capped: a degenerate normalizer must not produce a huge "confidence".
    notch: Math.min(3, notchDepth / lobeRadius),
    roundness: Math.min(lobeDt(vPos, peakPos), lobeDt(vNeg, peakNeg)) / lobeRadius,
    balance,
  };
}

/** Measure a mask against the doodle's silhouette signature. */
export function phallusFeatures(mask: Mask): PhallusFeatures | null {
  const frame = inkFrame(mask);
  if (!frame) return null;
  const shaftLen = frame.uMax - frame.uMin;
  if (shaftLen <= 0) return null;

  const plus = endFeatures(frame, 1);
  const minus = endFeatures(frame, -1);

  // Elongation reads the body width from the middle 60% of the axis, so
  // neither end's cap inflates it.
  const lo = new Float64Array(U_BINS).fill(Infinity);
  const hi = new Float64Array(U_BINS).fill(-Infinity);
  for (let i = 0; i < frame.count; i++) {
    const t = (frame.u[i]! - frame.uMin) / shaftLen;
    const b = Math.min(U_BINS - 1, Math.floor(t * U_BINS));
    const v = frame.v[i]!;
    if (v < lo[b]!) lo[b] = v;
    if (v > hi[b]!) hi[b] = v;
  }
  const mid: number[] = [];
  for (let b = Math.floor(U_BINS * 0.2); b < Math.floor(U_BINS * 0.8); b++) {
    if (hi[b]! >= lo[b]!) mid.push(hi[b]! - lo[b]!);
  }
  const bodyWidth = median(mid.filter((x) => x > 0));

  return {
    elongation: bodyWidth > 0 ? shaftLen / bodyWidth : 0,
    symmetry: axisSymmetry(frame),
    ends: [plus, minus],
  };
}

/** Ramp a measurement into 0..1 across its threshold band, for reporting. */
function margin(value: number, threshold: number, ceiling: number): number {
  if (ceiling <= threshold) return value >= threshold ? 1 : 0;
  return Math.min(1, Math.max(0, (value - threshold) / (ceiling - threshold)));
}

export const PHALLUS_ID = 'phallus';

/** Run the detector over one screening mask. */
export function detectPhallus(mask: Mask): DetectorScore {
  const f = phallusFeatures(mask);
  if (!f) {
    return {
      id: PHALLUS_ID,
      hit: false,
      score: 0,
      passed: 0,
      total: 1,
      reason: 'not enough ink to measure',
    };
  }
  const a = evaluateEnd(f, f.ends[0], f.ends[1]);
  const b = evaluateEnd(f, f.ends[1], f.ends[0]);
  // Either end may carry the lobes; report whichever reads stronger.
  if (a.hit && !b.hit) return a;
  if (b.hit && !a.hit) return b;
  return a.score >= b.score ? a : b;
}

function evaluateEnd(
  f: PhallusFeatures,
  lobed: EndFeatures,
  other: EndFeatures,
): DetectorScore {
  const checks: [string, boolean, number][] = [
    [
      'elongation',
      f.elongation >= PHALLUS_MIN_ELONGATION,
      margin(f.elongation, PHALLUS_MIN_ELONGATION, PHALLUS_MIN_ELONGATION * 1.6),
    ],
    [
      'bulge',
      lobed.bulge >= PHALLUS_MIN_BULGE,
      margin(lobed.bulge, PHALLUS_MIN_BULGE, PHALLUS_MIN_BULGE * 1.4),
    ],
    [
      'notch',
      lobed.notch >= PHALLUS_MIN_NOTCH,
      margin(lobed.notch, PHALLUS_MIN_NOTCH, PHALLUS_MIN_NOTCH * 2),
    ],
    [
      'roundness',
      lobed.roundness >= PHALLUS_MIN_ROUNDNESS,
      margin(lobed.roundness, PHALLUS_MIN_ROUNDNESS, 1),
    ],
    [
      'balance',
      lobed.balance >= PHALLUS_MIN_BALANCE,
      margin(lobed.balance, PHALLUS_MIN_BALANCE, 1),
    ],
    [
      'symmetry',
      f.symmetry >= PHALLUS_MIN_SYMMETRY,
      margin(f.symmetry, PHALLUS_MIN_SYMMETRY, 1),
    ],
    [
      'single lobed end',
      other.notch <= PHALLUS_MAX_OTHER_NOTCH,
      margin(PHALLUS_MAX_OTHER_NOTCH - other.notch, 0, PHALLUS_MAX_OTHER_NOTCH),
    ],
  ];
  const hit = checks.every(([, ok]) => ok);
  const score = checks.reduce((sum, [, , m]) => sum + m, 0) / checks.length;
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    id: PHALLUS_ID,
    hit,
    score,
    passed: checks.filter(([, ok]) => ok).length,
    total: checks.length,
    reason: hit
      ? `shaft with twin round lobes at one end (elongation ${f.elongation.toFixed(2)}, bulge ${lobed.bulge.toFixed(2)}, notch ${lobed.notch.toFixed(2)}, roundness ${lobed.roundness.toFixed(2)}, symmetry ${f.symmetry.toFixed(2)})`
      : `no match — failed ${failed.join(', ')}`,
  };
}
