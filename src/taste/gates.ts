/**
 * Runtime taste gates (TASTE §7) — the buttons the Ghost Panel `refworld.taste`
 * skill presses. Every gate is a pure function over data the caller supplies
 * (pixel buffers, coverage samples, position traces); nothing here touches the
 * DOM or Three.js, so the whole module is importable from node tests.
 *
 * All gates return { pass, detail } with lowercase detail strings, ready to
 * print in a dev panel or a test failure.
 */

import { auditDamping } from '../motion/spring';
import { CHARACTER, COLOR_METRICS, DENSITY } from './tokens';

export interface GateResult {
  pass: boolean;
  detail: string;
}

// ── color helpers (pure) ─────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

interface Hsl {
  /** hue in degrees [0, 360) — meaningless when s === 0 */
  h: number;
  /** hsl saturation [0, 1] */
  s: number;
  /** lightness [0, 1] */
  l: number;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d + 6) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  return { h, s, l };
}

/** rec.709 luma of an srgb pixel, [0, 1]. */
function lumaOf(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** shortest angular distance between two hues, in degrees. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const ACCENT_HUE = rgbToHsl(...hexToRgb(CHARACTER.accent)).h;

/** minimum saturation for a pixel's hue to count as a deliberate accent. */
const ACCENT_MIN_SATURATION = 0.25;

// ── damping audit ────────────────────────────────────────────────────────────

export interface DampingGateResult extends GateResult {
  violations: ReturnType<typeof auditDamping>;
}

/**
 * Every registered spring must run at ζ ≥ 1 (TASTE §2.1, confidence 1.00 —
 * underdamped rebounds past target, and a rebound is bounce). Wraps
 * auditDamping() from src/motion/spring.ts.
 */
export function auditDampingGate(): DampingGateResult {
  const violations = auditDamping();
  return {
    pass: violations.length === 0,
    violations,
    detail:
      violations.length === 0
        ? 'all registered springs run at zeta >= 1'
        : `${violations.length} spring(s) underdamped: ${violations
            .map((v) => `zeta ${v.zeta} (settle ${v.settleMs}ms)`)
            .join(', ')}`,
  };
}

// ── achromatic gate ──────────────────────────────────────────────────────────

/**
 * Desaturate the frame and it must still read (TASTE §7). Analyses an RGBA
 * buffer:
 *
 * - mean hsl saturation, weighted by luma (a near-black pixel's hue is
 *   invisible, so it barely counts). the frame passes when it does not exceed
 *   COLOR_METRICS.saturation by more than 0.1 — the taste is near-achromatic,
 *   so being *quieter* than the measured 0.188 is never a violation; being
 *   louder is.
 * - the warm-accent ration: the fraction of pixels whose hue sits within ±20°
 *   of CHARACTER.accent must stay below 0.02. only `#fb5429` may depend on
 *   hue, and at most one accent element is on screen at a time.
 */
export function achromaticGate(pixels: Uint8ClampedArray): GateResult {
  if (pixels.length === 0 || pixels.length % 4 !== 0) {
    return { pass: false, detail: 'empty or malformed rgba buffer' };
  }
  let saturationWeighted = 0;
  let lumaWeight = 0;
  let accentCount = 0;
  let counted = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    if (a === 0) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const { h, s } = rgbToHsl(r, g, b);
    const luma = lumaOf(r, g, b);
    saturationWeighted += s * luma;
    lumaWeight += luma;
    counted++;
    if (s >= ACCENT_MIN_SATURATION && hueDistance(h, ACCENT_HUE) <= 20) accentCount++;
  }
  if (counted === 0) return { pass: false, detail: 'buffer is fully transparent' };
  const meanSaturation = lumaWeight > 0 ? saturationWeighted / lumaWeight : 0;
  const accentFraction = accentCount / counted;
  const saturationOk = meanSaturation <= COLOR_METRICS.saturation + 0.1;
  const accentOk = accentFraction < 0.02;
  const detail =
    `mean saturation ${meanSaturation.toFixed(3)} (target <= ${(
      COLOR_METRICS.saturation + 0.1
    ).toFixed(3)}), ` +
    `warm-accent coverage ${(accentFraction * 100).toFixed(2)}% (limit 2%)` +
    (saturationOk ? '' : ' — frame is louder than the near-achromatic taste allows') +
    (accentOk ? '' : ' — the accent is rationed to one element');
  return { pass: saturationOk && accentOk, detail };
}

// ── value histogram gate ─────────────────────────────────────────────────────

const HISTOGRAM_BUCKETS = 64;
/** luma below this counts as the character's near-black band. */
const NEAR_BLACK_LUMA = 0.12;
/** the near-black band must stay below this coverage — the character is small in the frame. */
const NEAR_BLACK_MAX_COVERAGE = 0.15;
/** how far the histogram mode may sit from COLOR_METRICS.groundLuma. */
const GROUND_LUMA_TOLERANCE = 0.08;

/**
 * The frame's value structure (TASTE §7): a mid-toned ground must dominate
 * (histogram mode within ±0.08 of groundLuma 0.74), and the near-black band
 * (luma < 0.12) — which only characters may occupy — must cover less than 15%
 * of the frame. one small dark figure against a huge undifferentiated field.
 */
export function valueHistogramGate(pixels: Uint8ClampedArray): GateResult {
  if (pixels.length === 0 || pixels.length % 4 !== 0) {
    return { pass: false, detail: 'empty or malformed rgba buffer' };
  }
  const histogram = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  let nearBlack = 0;
  let counted = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    if (a === 0) continue;
    const luma = lumaOf(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    const bucket = Math.min(HISTOGRAM_BUCKETS - 1, Math.floor(luma * HISTOGRAM_BUCKETS));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    if (luma < NEAR_BLACK_LUMA) nearBlack++;
    counted++;
  }
  if (counted === 0) return { pass: false, detail: 'buffer is fully transparent' };
  let modeBucket = 0;
  for (let b = 1; b < HISTOGRAM_BUCKETS; b++) {
    if ((histogram[b] ?? 0) > (histogram[modeBucket] ?? 0)) modeBucket = b;
  }
  const modeLuma = (modeBucket + 0.5) / HISTOGRAM_BUCKETS;
  const groundOk = Math.abs(modeLuma - COLOR_METRICS.groundLuma) <= GROUND_LUMA_TOLERANCE;
  const nearBlackFraction = nearBlack / counted;
  const nearBlackOk = nearBlackFraction < NEAR_BLACK_MAX_COVERAGE;
  const detail =
    `histogram mode at luma ${modeLuma.toFixed(2)} (ground target ${COLOR_METRICS.groundLuma} ± ${GROUND_LUMA_TOLERANCE}), ` +
    `near-black coverage ${(nearBlackFraction * 100).toFixed(1)}% (limit ${NEAR_BLACK_MAX_COVERAGE * 100}%)` +
    (groundOk ? '' : ' — the mid-toned ground is not the dominant value') +
    (nearBlackOk ? '' : ' — too much near-black; the character is small in the frame');
  return { pass: groundOk && nearBlackOk, detail };
}

// ── density gate ─────────────────────────────────────────────────────────────

/** how far mean coverage may drift from DENSITY.global. */
const DENSITY_TOLERANCE = 0.12;

/**
 * Global coverage ≈ 0.39 (TASTE §2.3). the caller samples the scene (grid
 * cells, screen tiles — its choice) and hands over coverage fractions; the
 * gate checks their mean against the measured density.
 */
export function densityGate(coverageSamples: number[]): GateResult {
  if (coverageSamples.length === 0) {
    return { pass: false, detail: 'no coverage samples supplied' };
  }
  const mean = coverageSamples.reduce((sum, c) => sum + c, 0) / coverageSamples.length;
  const deviation = mean - DENSITY.global;
  const pass = Math.abs(deviation) <= DENSITY_TOLERANCE;
  const direction = deviation > 0 ? 'packed' : 'sparse';
  return {
    pass,
    detail:
      `mean coverage ${mean.toFixed(3)} over ${coverageSamples.length} sample(s) ` +
      `(target ${DENSITY.global} ± ${DENSITY_TOLERANCE})` +
      (pass ? '' : ` — too ${direction}; open ground is the design`),
  };
}

// ── stillness gate ───────────────────────────────────────────────────────────

/**
 * Nothing fully arrests (TASTE §2.1: settle is drift, never a stop). the
 * caller samples each element's position over ≥2s of idle and hands over the
 * traces; any element whose total positional variance is exactly zero has
 * frozen, and the gate fails. an element with fewer than two samples cannot
 * prove it moved, so it counts as frozen too.
 */
export function stillnessGate(samples: { x: number; y: number }[][]): GateResult {
  if (samples.length === 0) {
    return { pass: false, detail: 'no elements sampled' };
  }
  const frozen: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const trace = samples[i] ?? [];
    if (trace.length < 2) {
      frozen.push(i);
      continue;
    }
    let meanX = 0;
    let meanY = 0;
    for (const p of trace) {
      meanX += p.x;
      meanY += p.y;
    }
    meanX /= trace.length;
    meanY /= trace.length;
    let variance = 0;
    for (const p of trace) {
      variance += (p.x - meanX) ** 2 + (p.y - meanY) ** 2;
    }
    if (variance === 0) frozen.push(i);
  }
  return {
    pass: frozen.length === 0,
    detail:
      frozen.length === 0
        ? `all ${samples.length} element(s) drift — nothing fully arrests`
        : `element(s) ${frozen.join(', ')} fully arrested — the ambient floor must run under everything`,
  };
}
