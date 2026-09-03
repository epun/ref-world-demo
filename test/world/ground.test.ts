/**
 * Ground tests — the built mesh, headless. Geometries are plain buffers in
 * node (no WebGL), so the displaced field can be read vertex by vertex.
 *
 * What these pin is the seam: the paper the world stands on is the Surface
 * (src/world/surface.ts) and nothing else, its rim is flat where the terrain
 * is flat so the far field meets it without a seam, and it carries the
 * normals the ink pass needs to draw the terraces at all.
 */

import { describe, expect, it } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, type BufferAttribute } from 'three';
import { SURFACE } from '../../src/taste/tokens';
import { FIELD_SEGMENTS, FIELD_SIZE, createGround } from '../../src/world/ground';
import { FLAT_SURFACE, ROLLING_SURFACE } from '../../src/world/surface';

const field = (ground = createGround(ROLLING_SURFACE)): Mesh =>
  ground.group.getObjectByName('ground-field') as Mesh;

const positionOf = (mesh: Mesh): BufferAttribute =>
  mesh.geometry.getAttribute('position') as BufferAttribute;

/** Same sin-hash family as the world's own: a fixed, reproducible sample. */
function seededIndices(count: number, of: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
    out.push(Math.floor((x - Math.floor(x)) * of));
  }
  return out;
}

describe('ground — what gets built', () => {
  it('is one named group of two meshes sharing a single unlit material', () => {
    const ground = createGround(ROLLING_SURFACE);
    expect(ground.group.name).toBe('ground');
    expect(ground.group.children.map((child) => child.name)).toEqual([
      'ground-field',
      'ground-far',
    ]);
    for (const child of ground.group.children) {
      // ONE material: the paper is one value by construction, so a color
      // grade can never pull the field and the horizon apart.
      expect((child as Mesh).material, child.name).toBe(ground.material);
    }
    expect(ground.material).toBeInstanceOf(MeshBasicMaterial);
    expect(ground.material.color.equals(new Color(SURFACE.ground))).toBe(true);
  });

  it('keeps the field at the budgeted density', () => {
    // ~205k triangles is the ceiling this world pays for its ground.
    expect(FIELD_SEGMENTS).toBeLessThanOrEqual(320);
    const index = field().geometry.getIndex();
    expect(index).not.toBeNull();
    expect(index!.count / 3).toBe(FIELD_SEGMENTS * FIELD_SEGMENTS * 2);
  });
});

describe('ground — the field is the surface', () => {
  it('lifts every sampled vertex to exactly surface.sampleHeight', () => {
    const attr = positionOf(field());
    let moved = 0;
    for (const i of seededIndices(50, attr.count)) {
      const x = attr.getX(i);
      const z = attr.getZ(i);
      expect(attr.getY(i), `vertex ${i} at ${x},${z}`).toBeCloseTo(
        ROLLING_SURFACE.sampleHeight(x, z),
        4,
      );
      if (Math.abs(attr.getY(i)) > 1e-6) moved++;
    }
    // …and the sample really is over terrain, not 50 flat points.
    expect(moved).toBeGreaterThan(20);
  });

  it('rests its whole rim on zero, where the far field meets it', () => {
    // TERRAIN.farEnd is 185 and the rim is at 200, so the terrain is already
    // exactly flat out there: the ring beyond it needs no seam to hide.
    const attr = positionOf(field());
    const half = FIELD_SIZE / 2;
    let rim = 0;
    for (let i = 0; i < attr.count; i++) {
      const x = attr.getX(i);
      const z = attr.getZ(i);
      if (Math.abs(Math.abs(x) - half) > 1e-3 && Math.abs(Math.abs(z) - half) > 1e-3) continue;
      rim++;
      // Math.abs, because a faded tier lands on -0 and Object.is(-0, 0) is
      // false — the two are the same paper.
      expect(Math.abs(attr.getY(i)), `rim vertex at ${x},${z}`).toBe(0);
    }
    expect(rim).toBe(FIELD_SEGMENTS * 4);
  });

  it('carries unit normals, computed after the displacement', () => {
    // These normals ARE the terraces: the ink pass hatches faces turned from
    // the key and creases a contour at every riser. A mesh normalled before
    // the lift (or not at all) would render the whole map as flat paper.
    const attr = positionOf(field());
    const normal = field().geometry.getAttribute('normal') as BufferAttribute;
    expect(normal.count).toBe(attr.count);
    let tilted = 0;
    for (const i of seededIndices(200, normal.count)) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(length, `normal ${i}`).toBeCloseTo(1, 5);
      expect(normal.getY(i), `normal ${i}`).toBeGreaterThan(0);
      if (normal.getY(i) < 0.999) tilted++;
    }
    // A riser turns a face away from straight up; a flat sheet never would.
    expect(tilted).toBeGreaterThan(20);
  });

  it('follows whatever Surface it is handed — flat means flat', () => {
    // The seam, negatively: hand it the pre-terrain world and the ground is
    // the plane it used to be, with nothing in this file to change.
    const attr = positionOf(field(createGround(FLAT_SURFACE)));
    for (let i = 0; i < attr.count; i++) expect(attr.getY(i)).toBe(0);
  });
});
