/**
 * Pure tests for the dev panel's perf readout helpers (src/dev/perf.ts).
 * No DOM, no ghost-panel, no renderer — the ring and the formatter are
 * arithmetic, which is why they live outside index.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  FRAME_RING_SIZE,
  createFrameRing,
  formatCount,
  formatPerfLine,
  frameStats,
} from '../../src/dev/perf';

describe('frame ring', () => {
  it('is empty until it is fed', () => {
    expect(createFrameRing().stats()).toEqual({ avgMs: 0, p95Ms: 0, frames: 0 });
  });

  it('averages the samples it holds', () => {
    const ring = createFrameRing(4);
    for (const ms of [10, 20, 30, 40]) ring.push(ms);
    const stats = ring.stats();
    expect(stats.frames).toBe(4);
    expect(stats.avgMs).toBeCloseTo(25, 6);
  });

  it('keeps only the last n frames', () => {
    const ring = createFrameRing(3);
    for (const ms of [100, 100, 100, 1, 2, 3]) ring.push(ms);
    const stats = ring.stats();
    expect(stats.frames).toBe(3);
    expect(stats.avgMs).toBeCloseTo(2, 6);
    expect(stats.p95Ms).toBe(3);
  });

  it('drops garbage deltas rather than storing them', () => {
    const ring = createFrameRing(4);
    ring.push(Number.NaN);
    ring.push(-5);
    ring.push(Number.POSITIVE_INFINITY);
    ring.push(16);
    expect(ring.stats()).toEqual({ avgMs: 16, p95Ms: 16, frames: 1 });
  });

  it('resets', () => {
    const ring = createFrameRing(4);
    ring.push(16);
    ring.reset();
    expect(ring.stats().frames).toBe(0);
  });

  it('defaults to a two-second window at 60fps', () => {
    expect(FRAME_RING_SIZE).toBe(120);
    const ring = createFrameRing();
    for (let i = 0; i < 500; i++) ring.push(16);
    expect(ring.stats().frames).toBe(FRAME_RING_SIZE);
  });
});

describe('p95', () => {
  it('is the 95th percentile of the sorted samples', () => {
    // 1..100 — the 95th of a hundred samples.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(frameStats(samples).p95Ms).toBe(95);
  });

  it('does not depend on sample order (the ring wraps)', () => {
    const rising = Array.from({ length: 40 }, (_, i) => i + 1);
    const shuffled = [...rising.slice(17), ...rising.slice(0, 17)];
    expect(frameStats(shuffled)).toEqual(frameStats(rising));
  });

  it('never runs off the end of a short ring', () => {
    expect(frameStats([9]).p95Ms).toBe(9);
    expect(frameStats([9, 11]).p95Ms).toBe(11);
  });
});

describe('count shorthand', () => {
  it('reads plainly below a thousand', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(213)).toBe('213');
  });

  it('abbreviates thousands and millions, lowercase (taste §5)', () => {
    expect(formatCount(1234)).toBe('1.2k');
    expect(formatCount(1_200_000)).toBe('1.2m');
    expect(formatCount(1_000_000)).toBe('1.0m');
  });
});

describe('perf line', () => {
  const frames = frameStats([16.4, 16.4, 22.1]);

  it('carries frame, draw calls, triangles and creatures', () => {
    const line = formatPerfLine({ frames, calls: 213, triangles: 1_200_000, creatures: 200 });
    expect(line).toBe('frame 18.3ms (p95 22.1) · draw calls 213 · tris 1.2m · creatures 200');
  });

  it('omits the renderer fields when there is no renderer handle', () => {
    const line = formatPerfLine({ frames, creatures: 3 });
    expect(line).toBe('frame 18.3ms (p95 22.1) · creatures 3');
  });

  it('says nothing about a frame it has not measured yet', () => {
    const line = formatPerfLine({ frames: frameStats([]), creatures: 0 });
    expect(line).toBe('frame — · creatures 0');
  });

  it('is lowercase throughout (taste §5)', () => {
    const line = formatPerfLine({ frames, calls: 9, triangles: 9, creatures: 9 });
    expect(line).toBe(line.toLowerCase());
  });
});
