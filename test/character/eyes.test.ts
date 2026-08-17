/**
 * Eyes — pure-logic tests (PLAN §3.4).
 *
 * Covers the two pure modules that back the eye system: expressions
 * (uniform parameter sets + lerp) and placement (the mask→character-local
 * mapping that must replicate the inflater's world transform exactly).
 * No Three.js in any tested path — both modules import nothing renderable.
 */

import { describe, expect, it } from 'vitest';
import {
  EXPRESSIONS,
  EXPRESSION_BOUNDS,
  EXPRESSION_NAMES,
  lerpExpression,
  resolveExpression,
  type Expression,
} from '../../src/character/expressions';
import {
  computeEyePlacement,
  maskToLocal,
  sampleDistance,
  surfaceZ,
  EYE_DEPTH_SCALE,
  EYE_PROUD,
  EYE_RADIUS,
  EYE_SEPARATION,
} from '../../src/character/placement';
import type { DistanceField } from '../../src/shape/types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A synthetic distance field filled from fn(x, y). */
function field(size: number, fn: (x: number, y: number) => number): DistanceField {
  const data = new Float32Array(size * size);
  let max = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fn(x, y);
      data[y * size + x] = v;
      if (v > max) max = v;
    }
  }
  return { size, data, max };
}

const SIZE = 64;
const BOUNDS = { minX: 16, minY: 16, maxX: 47, maxY: 47 };
const CENTER = { x: (16 + 47) / 2, y: (16 + 47) / 2 }; // (31.5, 31.5)

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

describe('expressions', () => {
  it('defines the full emote set', () => {
    for (const name of ['neutral', 'happy', 'sad', 'sleepy', 'angry', 'surprised'] as const) {
      expect(EXPRESSIONS[name]).toBeDefined();
      expect(EXPRESSION_NAMES).toContain(name);
    }
  });

  it('keeps every expression inside the parameter bounds', () => {
    for (const name of EXPRESSION_NAMES) {
      const e = EXPRESSIONS[name];
      expect(e.openness).toBeGreaterThanOrEqual(EXPRESSION_BOUNDS.openness[0]);
      expect(e.openness).toBeLessThanOrEqual(EXPRESSION_BOUNDS.openness[1]);
      expect(e.curve).toBeGreaterThanOrEqual(EXPRESSION_BOUNDS.curve[0]);
      expect(e.curve).toBeLessThanOrEqual(EXPRESSION_BOUNDS.curve[1]);
      expect(e.wedge).toBeGreaterThanOrEqual(EXPRESSION_BOUNDS.wedge[0]);
      expect(e.wedge).toBeLessThanOrEqual(EXPRESSION_BOUNDS.wedge[1]);
      expect(e.size).toBeGreaterThanOrEqual(EXPRESSION_BOUNDS.size[0]);
      expect(e.size).toBeLessThanOrEqual(EXPRESSION_BOUNDS.size[1]);
    }
  });

  it('reads at small scale: each expression leans on its dominant axis', () => {
    // surprised = wide + larger than everything else
    expect(EXPRESSIONS.surprised.openness).toBe(1);
    for (const name of EXPRESSION_NAMES) {
      if (name === 'surprised') continue;
      expect(EXPRESSIONS.surprised.size).toBeGreaterThan(EXPRESSIONS[name].size);
    }
    // sleepy = lids nearly down
    expect(EXPRESSIONS.sleepy.openness).toBeLessThan(0.3);
    // happy bends up, sad bends down
    expect(EXPRESSIONS.happy.curve).toBeGreaterThan(0.5);
    expect(EXPRESSIONS.sad.curve).toBeLessThan(-0.5);
    // angry = wedge + slight negative curve, and only angry carries a wedge
    expect(EXPRESSIONS.angry.wedge).toBeGreaterThan(0.5);
    expect(EXPRESSIONS.angry.curve).toBeLessThan(0);
    for (const name of EXPRESSION_NAMES) {
      if (name === 'angry') continue;
      expect(EXPRESSIONS[name].wedge).toBe(0);
    }
  });

  it('lerpExpression hits its endpoints and midpoint', () => {
    const a = EXPRESSIONS.sad;
    const b = EXPRESSIONS.happy;
    expect(lerpExpression(a, b, 0)).toEqual(a);
    expect(lerpExpression(a, b, 1)).toEqual(b);
    const mid = lerpExpression(a, b, 0.5);
    for (const k of ['openness', 'curve', 'wedge', 'size'] as const) {
      expect(mid[k]).toBeCloseTo((a[k] + b[k]) / 2, 10);
    }
  });

  it('resolveExpression accepts names and literals', () => {
    expect(resolveExpression('happy')).toEqual(EXPRESSIONS.happy);
    const literal: Expression = { openness: 0.5, curve: 0.1, wedge: 0, size: 1 };
    expect(resolveExpression(literal)).toBe(literal);
  });
});

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

describe('placement', () => {
  it('maskToLocal centers on the ink bounds and flips y up', () => {
    // The bounds center maps to the local origin.
    const origin = maskToLocal(CENTER, BOUNDS, SIZE);
    expect(origin.x).toBeCloseTo(0, 10);
    expect(origin.y).toBeCloseTo(0, 10);
    // Mask y is down; a point ABOVE center (smaller y) maps to POSITIVE local y.
    const up = maskToLocal({ x: CENTER.x, y: CENTER.y - 10 }, BOUNDS, SIZE);
    expect(up.y).toBeCloseTo(10 / SIZE, 10);
    // And below center maps negative.
    const down = maskToLocal({ x: CENTER.x, y: CENTER.y + 8 }, BOUNDS, SIZE);
    expect(down.y).toBeCloseTo(-8 / SIZE, 10);
    // x scales by 1/maskSize.
    const right = maskToLocal({ x: CENTER.x + 6, y: CENTER.y }, BOUNDS, SIZE);
    expect(right.x).toBeCloseTo(6 / SIZE, 10);
  });

  it('sampleDistance bilinearly interpolates', () => {
    const f = field(4, (x) => x); // ramp: dt = x
    expect(sampleDistance(f, 1, 1)).toBeCloseTo(1, 10);
    expect(sampleDistance(f, 1.5, 2)).toBeCloseTo(1.5, 10);
    // Clamped at the border.
    expect(sampleDistance(f, -5, 0)).toBeCloseTo(0, 10);
    expect(sampleDistance(f, 99, 0)).toBeCloseTo(3, 10);
  });

  it('surfaceZ matches the inflate profile z = depthScale·sqrt(dt·dtMax)/size', () => {
    const DT = 8;
    const f = field(SIZE, () => DT); // constant field: dt = dtMax = 8
    const z = surfaceZ(f, CENTER.x, CENTER.y);
    expect(z).toBeCloseTo((EYE_DEPTH_SCALE * Math.sqrt(DT * DT)) / SIZE, 10);
  });

  it('places the pair straddling the head lobe at the lobe height', () => {
    const DT = 8;
    const analysis = {
      distance: field(SIZE, () => DT),
      headLobe: { x: CENTER.x, y: CENTER.y - 6 }, // above bounds center
      bounds: BOUNDS,
    };
    const p = computeEyePlacement(analysis);
    // Symmetric about the lobe x (= bounds center here → local 0).
    expect(p.left.x).toBeCloseTo(-p.right.x, 10);
    expect(p.left.x).toBeLessThan(0);
    // Both at the lobe's local height, y flipped up.
    expect(p.left.y).toBeCloseTo(6 / SIZE, 10);
    expect(p.right.y).toBeCloseTo(6 / SIZE, 10);
  });

  it('derives separation and radius from the local head thickness', () => {
    const analysisAt = (dt: number) => ({
      distance: field(SIZE, () => dt),
      headLobe: CENTER,
      bounds: BOUNDS,
    });
    const thin = computeEyePlacement(analysisAt(4));
    const thick = computeEyePlacement(analysisAt(8));
    // Positive, and proportional to thickness: double dt → double both.
    expect(thin.separation).toBeGreaterThan(0);
    expect(thin.radius).toBeGreaterThan(0);
    expect(thick.separation).toBeCloseTo(thin.separation * 2, 10);
    expect(thick.radius).toBeCloseTo(thin.radius * 2, 10);
    // Exact constants: sep = 0.55·t, r = 0.26·t (local units).
    expect(thick.separation).toBeCloseTo((EYE_SEPARATION * 8) / SIZE, 10);
    expect(thick.radius).toBeCloseTo((EYE_RADIUS * 8) / SIZE, 10);
    // Marks, not headlights: caps never touch each other.
    expect(thick.radius).toBeLessThan(thick.separation);
  });

  it('floats each cap just proud of the front surface at its own position', () => {
    const DT = 8;
    const analysis = {
      // A gentle ramp so the two eyes land at different surface heights.
      distance: field(SIZE, (x) => DT + x * 0.1),
      headLobe: CENTER,
      bounds: BOUNDS,
    };
    const p = computeEyePlacement(analysis);
    for (const eye of [p.left, p.right]) {
      // Convert the eye's local x back to mask x to sample the surface there.
      const mx = eye.x * SIZE + CENTER.x;
      const surface = surfaceZ(analysis.distance, mx, CENTER.y);
      expect(eye.z).toBeGreaterThan(surface);
      expect(eye.z).toBeCloseTo(surface + EYE_PROUD * p.radius, 10);
    }
    // The ramp means the right eye sits higher off the ground plane than the left.
    expect(p.right.z).toBeGreaterThan(p.left.z);
  });

  it('guards degenerate thickness so the eyes never collapse', () => {
    const p = computeEyePlacement({
      distance: field(SIZE, () => 0),
      headLobe: CENTER,
      bounds: BOUNDS,
    });
    expect(p.radius).toBeGreaterThan(0);
    expect(p.separation).toBeGreaterThan(0);
  });
});
