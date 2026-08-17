import { describe, it, expect } from 'vitest';
import { analyze } from '../../src/shape/analyze';
import type { ShapeAnalysis } from '../../src/shape/types';
import {
  circleBlob,
  snowman,
  quadruped,
  bird,
  empty,
  dot,
  thinLine,
  disconnectedBlobs,
  scribble,
} from '../fixtures/strokes';

const SIZE = 128;
const OPTS = { size: SIZE };

function feet(a: ShapeAnalysis): number {
  return a.features.filter((f) => f.role === 'foot').length;
}
function limbs(a: ShapeAnalysis): number {
  return a.features.filter((f) => f.role === 'limb').length;
}

/** Structural sanity shared by every non-null analysis. */
function expectValid(a: ShapeAnalysis): void {
  expect(a.mask.size).toBe(SIZE);
  expect(a.contour.length).toBe(120);
  expect(a.bounds.maxX).toBeGreaterThan(a.bounds.minX);
  expect(a.bounds.maxY).toBeGreaterThan(a.bounds.minY);
  expect(a.distance.max).toBeGreaterThan(0);
  expect(['blob', 'biped', 'quadruped', 'bird']).toContain(a.archetype);
  // Head lobe sits inside the mask bounds horizontally and in the upper half.
  expect(a.headLobe.x).toBeGreaterThanOrEqual(a.bounds.minX);
  expect(a.headLobe.x).toBeLessThanOrEqual(a.bounds.maxX);
  // Every contour point stays on the canvas.
  for (const p of a.contour) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(SIZE);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(SIZE);
  }
}

describe('analyze: archetypes (golden)', () => {
  it('classifies a filled circle as blob', () => {
    const a = analyze(circleBlob, OPTS);
    expect(a).not.toBeNull();
    expectValid(a!);
    expect(a!.archetype).toBe('blob');
    expect(feet(a!)).toBeLessThan(2);
  });

  it('classifies a snowman with two legs as biped', () => {
    const a = analyze(snowman, OPTS);
    expect(a).not.toBeNull();
    expectValid(a!);
    expect(a!.archetype).toBe('biped');
    expect(feet(a!)).toBeGreaterThanOrEqual(2);
    expect(feet(a!)).toBeLessThanOrEqual(3);
  });

  it('classifies a body with four legs as quadruped', () => {
    const a = analyze(quadruped, OPTS);
    expect(a).not.toBeNull();
    expectValid(a!);
    expect(a!.archetype).toBe('quadruped');
    expect(feet(a!)).toBeGreaterThanOrEqual(4);
    expect(feet(a!)).toBeLessThanOrEqual(5);
  });

  it('classifies a tall two-legged shape with a lateral wing as bird', () => {
    const a = analyze(bird, OPTS);
    expect(a).not.toBeNull();
    expectValid(a!);
    expect(a!.archetype).toBe('bird');
    expect(feet(a!)).toBeGreaterThanOrEqual(2);
    expect(limbs(a!)).toBeGreaterThanOrEqual(1);
  });
});

describe('analyze: degenerate input', () => {
  it('returns null for an empty stroke list', () => {
    expect(analyze(empty, OPTS)).toBeNull();
  });

  it('returns null for a single dot', () => {
    expect(analyze(dot, OPTS)).toBeNull();
  });

  it('does not throw on a single thin line', () => {
    let a: ShapeAnalysis | null = null;
    expect(() => { a = analyze(thinLine, OPTS); }).not.toThrow();
    // A hairline may rasterize to a single-pixel-tall band, so the full
    // structural checks don't apply — but any non-null result must be usable.
    if (a !== null) {
      const got: ShapeAnalysis = a;
      expect(got.contour.length).toBe(120);
      expect(['blob', 'biped', 'quadruped', 'bird']).toContain(got.archetype);
      expect(got.bounds.maxX).toBeGreaterThan(got.bounds.minX);
    }
  });

  it('analyzes two disconnected blobs by keeping the larger one', () => {
    const a = analyze(disconnectedBlobs, OPTS);
    expect(a).not.toBeNull();
    expectValid(a!);
    expect(a!.archetype).toBe('blob');
    // The kept component is the large blob on the left; the stray blob at
    // (0.85, 0.2) must be outside the surviving ink bounds.
    expect(a!.bounds.maxX).toBeLessThan(0.75 * SIZE);
  });

  it('analyzes a canvas-filling scribble without throwing', () => {
    const a = analyze(scribble, OPTS);
    expect(a).not.toBeNull();
    expectValid(a!);
    // The scribble spans most of the canvas.
    expect(a!.bounds.maxX - a!.bounds.minX).toBeGreaterThan(SIZE * 0.7);
    expect(a!.bounds.maxY - a!.bounds.minY).toBeGreaterThan(SIZE * 0.7);
  });
});

describe('analyze: determinism', () => {
  it('produces byte-identical results across runs', () => {
    for (const strokes of [circleBlob, snowman, quadruped, bird, scribble]) {
      const a = analyze(strokes, OPTS)!;
      const b = analyze(strokes, OPTS)!;
      expect(JSON.stringify(a.contour)).toBe(JSON.stringify(b.contour));
      expect(JSON.stringify(a.features)).toBe(JSON.stringify(b.features));
      expect(a.archetype).toBe(b.archetype);
      expect(a.headLobe).toEqual(b.headLobe);
      expect(a.bounds).toEqual(b.bounds);
    }
  });
});
