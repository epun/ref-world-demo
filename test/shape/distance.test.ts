import { describe, it, expect } from 'vitest';
import { rasterize } from '../../src/shape/raster';
import { distanceTransform } from '../../src/shape/distance';
import { circleBlob, CIRCLE_RADIUS } from '../fixtures/strokes';

const SIZE = 128;

describe('distanceTransform', () => {
  const mask = rasterize(circleBlob, SIZE);
  const dist = distanceTransform(mask);
  const rPx = CIRCLE_RADIUS * SIZE;

  it('peaks at approximately the circle radius', () => {
    expect(dist.max).toBeGreaterThan(rPx * 0.9);
    expect(dist.max).toBeLessThan(rPx * 1.1);
  });

  it('locates the peak near the circle center', () => {
    let best = -1, bx = 0, by = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const v = dist.data[y * SIZE + x]!;
        if (v > best) { best = v; bx = x; by = y; }
      }
    }
    expect(best).toBe(dist.max);
    const cx = 0.5 * SIZE, cy = 0.5 * SIZE;
    expect(Math.hypot(bx - cx, by - cy)).toBeLessThan(SIZE * 0.05);
  });

  it('is zero on every background pixel', () => {
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] === 0) expect(dist.data[i]).toBe(0);
    }
  });

  it('is strictly positive on every ink pixel', () => {
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] === 1) expect(dist.data[i]).toBeGreaterThan(0);
    }
  });
});
