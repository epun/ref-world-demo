/**
 * Velocity → stroke-width mapping. Pure: numbers in, numbers out. No DOM, no
 * pointer events — this is the testable core of the capture module.
 *
 * PLAN §3.1: slow strokes thicken, fast strokes thin. A constant round brush
 * reads as clip-art; modulating width by speed produces the hand-carved
 * woodcut edge the character brief calls for. Speeds are smoothed with an
 * exponential moving average so a single jittery pointer sample never spikes
 * the width, then mapped through a strictly decreasing saturating curve into
 * [WIDTH_SCALE_MIN, WIDTH_SCALE_MAX].
 *
 * The map is `min + (max - min) / (1 + speed / midSpeed)`:
 * - speed 0        → max (1.45): a held, careful stroke at full thickness
 * - speed midSpeed → exactly the midpoint (1.0): the neutral width
 * - speed → ∞      → min (0.55): a fast flick at its thinnest
 * Strictly decreasing everywhere and never leaves the clamp range, so there
 * is no plateau where two different speeds read identically.
 */

/** Thinnest a stroke gets (fast flicks). */
export const WIDTH_SCALE_MIN = 0.55;
/** Thickest a stroke gets (slow, deliberate marks). */
export const WIDTH_SCALE_MAX = 1.45;
/**
 * Speed, in CSS px/ms, at which the width scale sits exactly at the midpoint
 * of the range (1.0). Roughly a comfortable drawing pace on a phone.
 */
export const DEFAULT_MID_SPEED = 0.7;
/**
 * EMA smoothing factor in (0, 1]. 1 disables smoothing; lower values smooth
 * harder. 0.35 lets the width follow deliberate speed changes within a few
 * samples while flattening single-sample jitter.
 */
export const DEFAULT_EMA_ALPHA = 0.35;

export interface VelocityWidthOptions {
  /** Lower clamp for the width scale. Default WIDTH_SCALE_MIN. */
  minScale?: number;
  /** Upper clamp for the width scale. Default WIDTH_SCALE_MAX. */
  maxScale?: number;
  /** Speed (px/ms) mapping to the midpoint scale. Default DEFAULT_MID_SPEED. */
  midSpeed?: number;
  /** EMA factor in (0, 1]. Default DEFAULT_EMA_ALPHA. */
  alpha?: number;
}

interface Resolved {
  minScale: number;
  maxScale: number;
  midSpeed: number;
  alpha: number;
}

function resolve(opts?: VelocityWidthOptions): Resolved {
  return {
    minScale: opts?.minScale ?? WIDTH_SCALE_MIN,
    maxScale: opts?.maxScale ?? WIDTH_SCALE_MAX,
    midSpeed: opts?.midSpeed ?? DEFAULT_MID_SPEED,
    alpha: opts?.alpha ?? DEFAULT_EMA_ALPHA,
  };
}

/**
 * Map a single (already-smoothed) speed to a width scale. Strictly
 * decreasing in speed; result always within [minScale, maxScale].
 */
export function mapSpeedToWidthScale(
  speed: number,
  opts?: VelocityWidthOptions,
): number {
  const { minScale, maxScale, midSpeed } = resolve(opts);
  const s = Math.max(0, speed);
  const raw = minScale + (maxScale - minScale) / (1 + s / midSpeed);
  // The curve stays inside the range analytically; the clamp guards NaN/∞
  // inputs and any future re-shaping of the curve.
  return Math.min(maxScale, Math.max(minScale, raw));
}

export interface WidthTracker {
  /**
   * Feed one raw per-point speed (px/ms); returns the width scale for that
   * point, computed from the EMA-smoothed speed.
   */
  push(speed: number): number;
  /** Forget all smoothing state (call between strokes). */
  reset(): void;
}

/**
 * Stateful EMA smoother + width map for one stroke at a time. The first
 * pushed speed seeds the EMA directly (no warm-up bias toward zero).
 *
 * Capture seeds each stroke by pushing DEFAULT_MID_SPEED for the pen-down
 * point — a stroke begins at the neutral width (exactly 1.0) and thickens or
 * thins from there as real speeds arrive.
 */
export function createWidthTracker(opts?: VelocityWidthOptions): WidthTracker {
  const { alpha } = resolve(opts);
  let ema: number | null = null;
  return {
    push(speed: number): number {
      const s = Math.max(0, Number.isFinite(speed) ? speed : 0);
      ema = ema === null ? s : ema + alpha * (s - ema);
      return mapSpeedToWidthScale(ema, opts);
    },
    reset(): void {
      ema = null;
    },
  };
}

/**
 * Batch form: smooth a speed sequence with the EMA and map each sample to a
 * width scale. Deterministic — same input, same output.
 */
export function widthScalesFromSpeeds(
  speeds: readonly number[],
  opts?: VelocityWidthOptions,
): number[] {
  const tracker = createWidthTracker(opts);
  return speeds.map((s) => tracker.push(s));
}
