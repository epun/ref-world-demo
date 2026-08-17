import { describe, it, expect } from 'vitest';
import { rasterize, largestComponent } from '../../src/shape/raster';
import { capsule, disconnectedBlobs, SMALL_BLOB_CENTER } from '../fixtures/strokes';

const SIZE = 128;

function inkCount(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) n += data[i]!;
  return n;
}

describe('rasterize', () => {
  it('produces ink for a simple stroke', () => {
    const mask = rasterize([capsule(0.25, 0.5, 0.75, 0.5, 0.06)], SIZE);
    expect(mask.size).toBe(SIZE);
    expect(mask.data.length).toBe(SIZE * SIZE);
    expect(inkCount(mask.data)).toBeGreaterThan(0);
    // The stroke midpoint is solidly inside the ink.
    const mx = Math.round(0.5 * SIZE);
    const my = Math.round(0.5 * SIZE);
    expect(mask.data[my * SIZE + mx]).toBe(1);
    // Far corners stay background.
    expect(mask.data[0]).toBe(0);
    expect(mask.data[SIZE * SIZE - 1]).toBe(0);
  });

  it('produces an empty mask for an empty stroke list', () => {
    const mask = rasterize([], SIZE);
    expect(inkCount(mask.data)).toBe(0);
  });
});

describe('largestComponent', () => {
  it('keeps the bigger of two disconnected blobs and reports discarded ink', () => {
    const raw = rasterize(disconnectedBlobs, SIZE);
    const before = inkCount(raw.data);
    const { mask, discardedFraction } = largestComponent(raw);

    const after = inkCount(mask.data);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);

    // Discarded ink is the small blob: a positive, minority fraction that
    // matches the actual pixel counts.
    expect(discardedFraction).toBeGreaterThan(0);
    expect(discardedFraction).toBeLessThan(0.5);
    expect(discardedFraction).toBeCloseTo((before - after) / before, 10);

    // The small blob's center is scrubbed; the large blob's center survives.
    const [sx, sy] = SMALL_BLOB_CENTER;
    expect(mask.data[Math.round(sy * SIZE) * SIZE + Math.round(sx * SIZE)]).toBe(0);
    expect(mask.data[Math.round(0.5 * SIZE) * SIZE + Math.round(0.35 * SIZE)]).toBe(1);
  });

  it('is a no-op for a single-component mask', () => {
    const raw = rasterize([capsule(0.3, 0.5, 0.7, 0.5, 0.08)], SIZE);
    const { mask, discardedFraction } = largestComponent(raw);
    expect(discardedFraction).toBe(0);
    expect(inkCount(mask.data)).toBe(inkCount(raw.data));
  });
});
