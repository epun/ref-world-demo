/**
 * Prop motif tests — pure: the variant stroke lists run through analyze()
 * and the built geometries are inspected as data. No WebGL, no DOM.
 */

import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/shape/analyze';
import {
  buildPropGeometries,
  INFLATED_PROP_KINDS,
  PROP_MASK_SIZE,
  PROP_MASK_SIZE_SMALL,
  PROP_VARIANT_COUNTS,
  PROP_VARIANT_DEFS,
  type InflatedPropKind,
} from '../../src/world/props';

/** Mask size per kind, mirroring buildPropGeometries' small-kind rule. */
function maskSize(kind: InflatedPropKind): number {
  return kind === 'rock' || kind === 'bush' || kind === 'stump'
    ? PROP_MASK_SIZE_SMALL
    : PROP_MASK_SIZE;
}

describe('prop motif variants', () => {
  it('ships the authored variant counts per kind', () => {
    expect(PROP_VARIANT_COUNTS.tree).toBe(4);
    expect(PROP_VARIANT_COUNTS.conifer).toBe(3);
    expect(PROP_VARIANT_COUNTS.rock).toBe(3);
    expect(PROP_VARIANT_COUNTS.bush).toBe(3);
    expect(PROP_VARIANT_COUNTS.building).toBe(5);
    expect(PROP_VARIANT_COUNTS.stump).toBe(2);
    for (const kind of INFLATED_PROP_KINDS) {
      expect(PROP_VARIANT_DEFS[kind].length).toBe(PROP_VARIANT_COUNTS[kind]);
    }
  });

  it('every variant analyzes to usable ink', () => {
    for (const kind of INFLATED_PROP_KINDS) {
      for (const def of PROP_VARIANT_DEFS[kind]) {
        const a = analyze(def.strokes, { size: maskSize(kind), contourPoints: 96 });
        expect(a, `${kind}/${def.name}`).not.toBeNull();
        expect(a!.contour.length, `${kind}/${def.name}`).toBeGreaterThan(30);
      }
    }
  });

  it('proportions are sane per kind: tall kinds tall, low kinds low', () => {
    const aspects: Record<InflatedPropKind, [number, number]> = {
      tree: [1.1, 3.2], // fat lobe … tall narrow crown
      conifer: [1.3, 3.5], // squat pine … spire
      rock: [0.3, 1.0],
      bush: [0.3, 1.0],
      building: [0.7, 3.0], // cottage … tower
      stump: [0.5, 2.0], // cut stump … roofed well
    };
    for (const kind of INFLATED_PROP_KINDS) {
      const [lo, hi] = aspects[kind];
      for (const def of PROP_VARIANT_DEFS[kind]) {
        const a = analyze(def.strokes, { size: maskSize(kind) })!;
        const aspect = (a.bounds.maxY - a.bounds.minY) / (a.bounds.maxX - a.bounds.minX);
        expect(aspect, `${kind}/${def.name} aspect`).toBeGreaterThan(lo);
        expect(aspect, `${kind}/${def.name} aspect`).toBeLessThan(hi);
      }
    }
  });

  it('variants within a kind are actually distinct silhouettes', () => {
    for (const kind of INFLATED_PROP_KINDS) {
      const seen = new Set<string>();
      for (const def of PROP_VARIANT_DEFS[kind]) {
        const a = analyze(def.strokes, { size: maskSize(kind) })!;
        const key = a.contour
          .slice(0, 12)
          .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
          .join(';');
        expect(seen.has(key), `${kind}/${def.name} duplicates another variant`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('analysis is deterministic', () => {
    for (const def of [PROP_VARIANT_DEFS.tree[0]!, PROP_VARIANT_DEFS.building[2]!]) {
      const a = analyze(def.strokes, { size: PROP_MASK_SIZE });
      const b = analyze(def.strokes, { size: PROP_MASK_SIZE });
      expect(a!.contour).toEqual(b!.contour);
      expect(a!.bounds).toEqual(b!.bounds);
    }
  });

  it('built geometries are grounded, centered, and scaled to variant height', () => {
    const geometries = buildPropGeometries();
    for (const kind of INFLATED_PROP_KINDS) {
      const variants = geometries.get(kind)!;
      expect(variants.length, kind).toBe(PROP_VARIANT_COUNTS[kind]);
      variants.forEach((v, i) => {
        const tag = `${kind}/${PROP_VARIANT_DEFS[kind][i]!.name}`;
        const box = v.geometry.boundingBox!;
        expect(box.min.y, `${tag} grounded`).toBeCloseTo(0, 4);
        expect(box.max.y - box.min.y, `${tag} height`).toBeCloseTo(
          PROP_VARIANT_DEFS[kind][i]!.height,
          3,
        );
        expect(v.height).toBe(PROP_VARIANT_DEFS[kind][i]!.height);
        // Centered in x/z within a small tolerance.
        expect(Math.abs(box.min.x + box.max.x), `${tag} centered x`).toBeLessThan(1e-3);
        expect(Math.abs(box.min.z + box.max.z), `${tag} centered z`).toBeLessThan(1e-3);
        expect(v.radius, `${tag} radius`).toBeGreaterThan(0);
        v.geometry.dispose();
      });
    }
  });

  it('variant heights vary within tree and conifer (the grove skyline reads)', () => {
    const spread = (kind: InflatedPropKind): number => {
      const hs = PROP_VARIANT_DEFS[kind].map((d) => d.height);
      return Math.max(...hs) - Math.min(...hs);
    };
    expect(spread('tree')).toBeGreaterThan(0.5);
    expect(spread('conifer')).toBeGreaterThan(1.5);
    expect(spread('building')).toBeGreaterThan(1.5);
  });
});
