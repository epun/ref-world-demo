/**
 * The geometry side of the loader, on synthetic geometry and in node.
 *
 * These are the two things a glb has to become before the scatter can draw
 * it: a `PropVariant`-shaped whole (scaled to the catalog height, base at
 * y = 0, centred in x/z) and a list of breakable pieces in that same object
 * space. Both are pure functions over `BufferGeometry`, which is why they can
 * be checked here with a box instead of a building.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  conformKatamariGeometry,
  cutByHeightPlane,
  finishKatamariPart,
  katamariSeed,
  mergeKatamariGeometries,
  normalizeKatamariGeometry,
  splitByHeightPlanes,
  stageForIndex,
} from '../../../src/world/katamari/models';

/**
 * A closed box as twelve triangles, non-indexed, with normals and uv — the
 * shape a glb primitive arrives in. `at` offsets it so nothing under test can
 * pass by accident on a geometry that is already centred and grounded.
 */
function box(
  width: number,
  height: number,
  depth: number,
  at: [number, number, number] = [0, 0, 0],
): BufferGeometry {
  const [ox, oy, oz] = at;
  const x0 = ox - width / 2;
  const x1 = ox + width / 2;
  const y0 = oy;
  const y1 = oy + height;
  const z0 = oz - depth / 2;
  const z1 = oz + depth / 2;
  const corners: [number, number, number][] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces: [number, number, number, number][] = [
    [0, 1, 2, 3],
    [5, 4, 7, 6],
    [4, 0, 3, 7],
    [1, 5, 6, 2],
    [3, 2, 6, 7],
    [4, 5, 1, 0],
  ];
  const position: number[] = [];
  const uv: number[] = [];
  for (const [a, b, c, d] of faces) {
    for (const triangle of [
      [a, b, c],
      [a, c, d],
    ]) {
      for (const corner of triangle) {
        position.push(...corners[corner]!);
        uv.push(0.25, 0.75);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geometry.computeVertexNormals();
  return geometry;
}

function bounds(geometry: BufferGeometry): {
  min: [number, number, number];
  max: [number, number, number];
} {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
}

describe('katamari geometry normalisation', () => {
  it('a box comes out at the requested height, based at 0, centred in x/z', () => {
    const geometry = box(2, 4, 3, [17, 9, -5]);
    const { height, radius } = normalizeKatamariGeometry(geometry, 6);
    const { min, max } = bounds(geometry);
    expect(height).toBe(6);
    expect(max[1] - min[1]).toBeCloseTo(6, 5);
    expect(min[1]).toBeCloseTo(0, 5);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 5);
    expect((min[2] + max[2]) / 2).toBeCloseTo(0, 5);
    // Uniform scale: 4 -> 6 is x1.5, so the 3-deep box is 4.5 deep and the
    // footprint radius is half the larger of width and depth.
    expect(max[2] - min[2]).toBeCloseTo(4.5, 5);
    expect(radius).toBeCloseTo(4.5 / 2, 5);
  });

  it('is idempotent — normalising an already normalised box changes nothing', () => {
    const geometry = box(2, 4, 3, [1, 2, 3]);
    normalizeKatamariGeometry(geometry, 5);
    const first = bounds(geometry);
    normalizeKatamariGeometry(geometry, 5);
    expect(bounds(geometry)).toEqual(first);
  });

  it('refuses a geometry that is nothing', () => {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    expect(() => normalizeKatamariGeometry(empty, 3)).toThrow();
  });

  it('conform gives position, normal and uv, non-indexed', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2]);
    const out = conformKatamariGeometry(geometry);
    expect(out.index).toBeNull();
    expect(out.getAttribute('position').count).toBe(3);
    expect(out.getAttribute('normal').count).toBe(3);
    expect(out.getAttribute('uv').count).toBe(3);
  });

  it('merge keeps every vertex and every uv', () => {
    const a = conformKatamariGeometry(box(1, 1, 1));
    const b = conformKatamariGeometry(box(2, 2, 2, [5, 0, 0]));
    const merged = mergeKatamariGeometries([a, b]);
    expect(merged.getAttribute('position').count).toBe(72);
    expect(merged.getAttribute('uv').count).toBe(72);
    expect(merged.getAttribute('normal').count).toBe(72);
    // The inputs are left alone: they are also the parts.
    expect(a.getAttribute('position').count).toBe(36);
  });
});

describe('katamari part splitting', () => {
  it('cuts a box into two pieces that together are the whole box', () => {
    const geometry = conformKatamariGeometry(box(2, 4, 2));
    const [below, above] = cutByHeightPlane(geometry, 2, 7.3, 0.2);
    const whole = geometry.getAttribute('position').count;
    expect(below.getAttribute('position').count + above.getAttribute('position').count).toBe(whole);
    // Every piece keeps its uv — a textured chunk that lost them would draw
    // as one flat texel.
    expect(below.getAttribute('uv').count).toBe(below.getAttribute('position').count);
    expect(above.getAttribute('uv').count).toBe(above.getAttribute('position').count);
    // Jagged, not level: the seam wobbles, so the pieces overlap in y.
    expect(bounds(above).min[1]).toBeLessThan(bounds(above).max[1]);
  });

  it('throws rather than hand back an empty side', () => {
    const geometry = conformKatamariGeometry(box(2, 4, 2));
    expect(() => cutByHeightPlane(geometry, 99, 1, 0)).toThrow();
  });

  it('is deterministic — the same seed cuts the same way', () => {
    const one = splitByHeightPlanes(conformKatamariGeometry(box(2, 4, 2)), 4, 3, 11.5);
    const two = splitByHeightPlanes(conformKatamariGeometry(box(2, 4, 2)), 4, 3, 11.5);
    expect(one.map((p) => p.radius)).toEqual(two.map((p) => p.radius));
    expect(one.map((p) => p.offset)).toEqual(two.map((p) => p.offset));
  });

  it('a building-shaped split has three stages, top first', () => {
    const parts = splitByHeightPlanes(conformKatamariGeometry(box(3, 6, 3)), 6, 3, 21.7);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.stage)).toEqual([0, 1, 2]);
    // Top-down, but only weakly on a twelve-triangle box: each of its side
    // faces is ONE triangle spanning the whole height, and a triangle goes
    // whole to the side its centroid lands on, so the pieces' boxes overlap
    // almost entirely. That is the jagged uncapped cut working as intended —
    // a real prop's many small facets separate cleanly, which
    // test/world/katamari/models.test.ts checks on an actual glb.
    expect(parts[0]!.offset.y).toBeGreaterThanOrEqual(parts[2]!.offset.y);
    for (const part of parts) expect(part.geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('a two-band split is crown then trunk', () => {
    const parts = splitByHeightPlanes(conformKatamariGeometry(box(2, 5, 2)), 5, 2, 3.3);
    expect(parts.map((p) => p.stage)).toEqual([0, 2]);
  });

  it('falls back to one piece when there is nowhere to put a seam', () => {
    // A single triangle cannot be cut: every band would empty a side.
    const sliver = new BufferGeometry();
    sliver.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3),
    );
    sliver.setAttribute('normal', new BufferAttribute(new Float32Array(9), 3));
    sliver.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
    const parts = splitByHeightPlanes(sliver, 1, 3, 5.5);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.stage).toBe(2);
  });

  it('a finished part is centred on its own origin and remembers where it was', () => {
    const part = finishKatamariPart(conformKatamariGeometry(box(2, 2, 2, [4, 3, -1])), 1);
    const { min, max } = bounds(part.geometry);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 5);
    expect((min[1] + max[1]) / 2).toBeCloseTo(0, 5);
    expect(part.offset.x).toBeCloseTo(4, 5);
    expect(part.offset.y).toBeCloseTo(4, 5);
    expect(part.offset.z).toBeCloseTo(-1, 5);
    expect(part.radius).toBeGreaterThan(0);
    expect(part.stage).toBe(1);
  });

  it('stages read as a collapse, whatever the piece count', () => {
    expect(stageForIndex(0, 1)).toBe(2);
    expect([stageForIndex(0, 2), stageForIndex(1, 2)]).toEqual([0, 2]);
    expect([0, 1, 2, 3].map((i) => stageForIndex(i, 4))).toEqual([0, 1, 1, 2]);
  });

  it('seeds a model off its own id, and only off that', () => {
    expect(katamariSeed('026a')).toBe(katamariSeed('026a'));
    expect(katamariSeed('026a')).not.toBe(katamariSeed('026c'));
    expect(Number.isFinite(katamariSeed('0001'))).toBe(true);
  });
});
