/**
 * Prop motif tests — pure: the stroke lists run through analyze() and the
 * built geometries are inspected as data. No WebGL, no DOM.
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/shape/analyze';
import {
  buildPropGeometries,
  INFLATED_PROP_KINDS,
  PROP_HEIGHTS,
  PROP_MASK_SIZE,
  PROP_STROKES,
} from '../../src/world/props';

describe('prop motifs', () => {
  it('every motif analyzes to usable ink', () => {
    for (const kind of INFLATED_PROP_KINDS) {
      const a = analyze(PROP_STROKES[kind], { size: PROP_MASK_SIZE, contourPoints: 96 });
      expect(a, kind).not.toBeNull();
      expect(a!.contour.length).toBeGreaterThan(30);
    }
  });

  it('proportions are sane: tall kinds tall, low kinds low', () => {
    const aspect = (kind: (typeof INFLATED_PROP_KINDS)[number]): number => {
      const a = analyze(PROP_STROKES[kind], { size: PROP_MASK_SIZE })!;
      return (a.bounds.maxY - a.bounds.minY) / (a.bounds.maxX - a.bounds.minX);
    };
    expect(aspect('tree')).toBeGreaterThan(1.1);
    expect(aspect('conifer')).toBeGreaterThan(1.5);
    expect(aspect('landmark')).toBeGreaterThan(1.1);
    expect(aspect('rock')).toBeLessThan(1);
    expect(aspect('bush')).toBeLessThan(1);
    expect(aspect('stump')).toBeLessThan(1);
  });

  it('analysis is deterministic', () => {
    const a = analyze(PROP_STROKES.tree, { size: PROP_MASK_SIZE });
    const b = analyze(PROP_STROKES.tree, { size: PROP_MASK_SIZE });
    expect(a!.contour).toEqual(b!.contour);
    expect(a!.bounds).toEqual(b!.bounds);
  });

  it('built geometries are grounded, centered, and scaled to kind height', () => {
    const geometries = buildPropGeometries();
    for (const kind of INFLATED_PROP_KINDS) {
      const { geometry, height, radius } = geometries[kind];
      const box = geometry.boundingBox!;
      expect(box.min.y, `${kind} grounded`).toBeCloseTo(0, 4);
      expect(box.max.y - box.min.y, `${kind} height`).toBeCloseTo(PROP_HEIGHTS[kind], 3);
      expect(height).toBe(PROP_HEIGHTS[kind]);
      // Centered in x/z within a small tolerance.
      expect(Math.abs(box.min.x + box.max.x), `${kind} centered x`).toBeLessThan(1e-3);
      expect(Math.abs(box.min.z + box.max.z), `${kind} centered z`).toBeLessThan(1e-3);
      expect(radius).toBeGreaterThan(0);
      geometry.dispose();
    }
  });
});
