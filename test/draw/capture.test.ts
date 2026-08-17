/**
 * Pure-logic tests for the velocity → width mapping (src/draw/velocity.ts).
 * Node environment — no DOM, no pointer events; DrawCapture itself is a thin
 * event shell over this module.
 */

import { describe, expect, it } from 'vitest';
import {
  createWidthTracker,
  DEFAULT_MID_SPEED,
  mapSpeedToWidthScale,
  WIDTH_SCALE_MAX,
  WIDTH_SCALE_MIN,
  widthScalesFromSpeeds,
} from '../../src/draw/velocity';

describe('mapSpeedToWidthScale', () => {
  it('is strictly monotonic decreasing — faster strokes are thinner', () => {
    const speeds = [0, 0.05, 0.1, 0.25, 0.5, 0.7, 1, 1.5, 2, 3, 5, 8, 20];
    for (let i = 1; i < speeds.length; i++) {
      const slower = mapSpeedToWidthScale(speeds[i - 1]!);
      const faster = mapSpeedToWidthScale(speeds[i]!);
      expect(faster).toBeLessThan(slower);
    }
  });

  it('clamps to [0.55, 1.45]', () => {
    expect(mapSpeedToWidthScale(0)).toBe(WIDTH_SCALE_MAX);
    expect(mapSpeedToWidthScale(1e9)).toBeGreaterThanOrEqual(WIDTH_SCALE_MIN);
    expect(mapSpeedToWidthScale(1e9)).toBeCloseTo(WIDTH_SCALE_MIN, 4);
    for (const s of [-1, 0, 0.3, 0.7, 2, 100, Number.POSITIVE_INFINITY]) {
      const scale = mapSpeedToWidthScale(s);
      expect(scale).toBeGreaterThanOrEqual(WIDTH_SCALE_MIN);
      expect(scale).toBeLessThanOrEqual(WIDTH_SCALE_MAX);
    }
  });

  it('maps the neutral speed to exactly the midpoint scale (1.0)', () => {
    expect(mapSpeedToWidthScale(DEFAULT_MID_SPEED)).toBeCloseTo(
      (WIDTH_SCALE_MIN + WIDTH_SCALE_MAX) / 2,
      10,
    );
  });

  it('treats negative speeds as zero', () => {
    expect(mapSpeedToWidthScale(-5)).toBe(mapSpeedToWidthScale(0));
  });
});

describe('EMA smoothing', () => {
  it('softens a single-sample speed spike', () => {
    const base = 0.5;
    const spike = 8;
    const spikeIndex = 5;
    const speeds = Array.from({ length: 11 }, (_, i) =>
      i === spikeIndex ? spike : base,
    );

    const smoothed = widthScalesFromSpeeds(speeds);
    const rawAtSpike = mapSpeedToWidthScale(spike);
    const rawAtBase = mapSpeedToWidthScale(base);

    // The smoothed width at the spike thins less than the unsmoothed map
    // would, but still thins relative to the base pace.
    expect(smoothed[spikeIndex]!).toBeGreaterThan(rawAtSpike);
    expect(smoothed[spikeIndex]!).toBeLessThan(rawAtBase);

    // The spike decays over the following samples instead of vanishing:
    // width recovers toward the base value monotonically.
    expect(smoothed[spikeIndex + 1]!).toBeGreaterThan(smoothed[spikeIndex]!);
    expect(smoothed[spikeIndex + 2]!).toBeGreaterThan(smoothed[spikeIndex + 1]!);
    expect(smoothed[speeds.length - 1]!).toBeLessThanOrEqual(rawAtBase);
  });

  it('keeps every smoothed output inside the clamp range', () => {
    const speeds = [0, 50, 0, 50, 0.001, 12, 0.7, 0, 0, 100];
    for (const scale of widthScalesFromSpeeds(speeds)) {
      expect(scale).toBeGreaterThanOrEqual(WIDTH_SCALE_MIN);
      expect(scale).toBeLessThanOrEqual(WIDTH_SCALE_MAX);
    }
  });

  it('seeds the EMA with the first sample (no warm-up bias toward zero)', () => {
    const tracker = createWidthTracker();
    expect(tracker.push(DEFAULT_MID_SPEED)).toBeCloseTo(1.0, 10);
  });

  it('is deterministic — same speeds, same widths', () => {
    const speeds = [0.3, 0.4, 2.2, 0.1, 0.9, 5, 0.05, 0.7];
    const a = widthScalesFromSpeeds(speeds);
    const b = widthScalesFromSpeeds(speeds);
    expect(a).toEqual(b);

    const tracker = createWidthTracker();
    const c = speeds.map((s) => tracker.push(s));
    tracker.reset();
    const d = speeds.map((s) => tracker.push(s));
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });
});
