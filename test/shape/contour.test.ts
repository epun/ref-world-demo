import { describe, it, expect } from 'vitest';
import { rasterize } from '../../src/shape/raster';
import { traceContour, resample, chaikin } from '../../src/shape/contour';
import type { Contour, Point } from '../../src/shape/types';
import { circleBlob, CIRCLE_RADIUS } from '../fixtures/strokes';

const SIZE = 128;

function perimeter(c: Contour): number {
  let p = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i]!, b = c[(i + 1) % c.length]!;
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

describe('traceContour', () => {
  const mask = rasterize(circleBlob, SIZE);
  const contour = traceContour(mask);

  it('returns a closed loop of adjacent boundary pixels', () => {
    expect(contour.length).toBeGreaterThan(8);
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]!, b = contour[(i + 1) % contour.length]!;
      // Moore tracing steps between 8-neighbors, including the closing step.
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(Math.SQRT2 + 1e-9);
    }
  });

  it('has perimeter ≈ 2πr for a circle', () => {
    const expected = 2 * Math.PI * CIRCLE_RADIUS * SIZE;
    const p = perimeter(contour);
    expect(p).toBeGreaterThan(expected * 0.85);
    expect(p).toBeLessThan(expected * 1.15);
  });

  it('stays on ink pixels', () => {
    for (const pt of contour) {
      expect(mask.data[pt.y * SIZE + pt.x]).toBe(1);
    }
  });

  it('returns an empty contour for an empty mask', () => {
    expect(traceContour(rasterize([], SIZE))).toEqual([]);
  });
});

describe('resample', () => {
  const contour = traceContour(rasterize(circleBlob, SIZE));

  it('returns exactly n points', () => {
    expect(resample(contour, 64).length).toBe(64);
    expect(resample(contour, 120).length).toBe(120);
  });

  it('spaces points within 25% of uniform', () => {
    const n = 64;
    const out = resample(contour, n);
    const step = perimeter(out) / n;
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!, b = out[(i + 1) % out.length]!;
      const gap = Math.hypot(b.x - a.x, b.y - a.y);
      expect(gap).toBeGreaterThan(step * 0.75);
      expect(gap).toBeLessThan(step * 1.25);
    }
  });
});

describe('chaikin', () => {
  const square: Contour = [
    { x: 20, y: 20 },
    { x: 100, y: 20 },
    { x: 100, y: 100 },
    { x: 20, y: 100 },
  ];

  /** Direction change at each vertex, in degrees (0 = straight, 90 = square corner). */
  function maxTurnAngle(c: Contour): number {
    let worst = 0;
    for (let i = 0; i < c.length; i++) {
      const p = c[(i - 1 + c.length) % c.length]!;
      const q = c[i]!;
      const r = c[(i + 1) % c.length]!;
      const a: Point = { x: q.x - p.x, y: q.y - p.y };
      const b: Point = { x: r.x - q.x, y: r.y - q.y };
      const la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y);
      if (la < 1e-9 || lb < 1e-9) continue;
      const cos = Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y) / (la * lb)));
      const turn = (Math.acos(cos) * 180) / Math.PI;
      if (turn > worst) worst = turn;
    }
    return worst;
  }

  it('doubles the point count per pass', () => {
    expect(chaikin(square, 1).length).toBe(8);
    expect(chaikin(square, 2).length).toBe(16);
  });

  it('cuts square corners: no turn sharper than ~60°', () => {
    // The raw square turns 90° at every corner — sharper than the gate.
    expect(maxTurnAngle(square)).toBeCloseTo(90, 5);
    // After the default two passes, the sharpest turn is 22.5°.
    expect(maxTurnAngle(chaikin(square, 2))).toBeLessThan(60);
  });

  it('keeps points inside the convex hull of the input', () => {
    const out = chaikin(square, 2);
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(100);
    }
  });
});
