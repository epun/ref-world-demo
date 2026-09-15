/**
 * The flower field's buffers (src/world/ghibli/flowers.ts).
 *
 * Same contract as the blade field: a seeded layout, a per-instance ground
 * height baked from the `Surface` seam, and a geometry whose vertex count is
 * the stem strip plus the head quad — get that wrong and every bloom is a
 * triangle in the wrong place.
 */

import type { BufferAttribute, InstancedBufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  FLOWER_COUNT_PHONE,
  FLOWER_COUNT_PROJECTION,
  createFlowerField,
} from '../../../src/world/ghibli/flowers';

const SEG = 2;
/** Stem rows, both sides, plus the four head corners. */
const VERTS = (SEG + 1) * 2 + 4;

describe('createFlowerField', () => {
  it('builds the stem strip and the head quad, instanced over the count', () => {
    const field = createFlowerField({ count: 250, heightAt: () => 0 });
    const geometry = field.mesh.geometry as InstancedBufferGeometry;
    expect(geometry.getAttribute('aVert').count).toBe(VERTS);
    expect(geometry.getIndex()?.count).toBe(SEG * 6 + 6);
    expect(geometry.instanceCount).toBe(250);
    expect(geometry.getAttribute('aOffset').count).toBe(250);
    expect(geometry.getAttribute('aRand').count).toBe(250);
    expect(geometry.getAttribute('aGround').count).toBe(250);
    field.dispose();
  });

  it('marks the head vertices as the head part, and the stem as stem', () => {
    const field = createFlowerField({ count: 8, heightAt: () => 0 });
    const vert = field.mesh.geometry.getAttribute('aVert');
    const stemRows = (SEG + 1) * 2;
    for (let i = 0; i < stemRows; i++) expect(vert.getZ(i)).toBe(0);
    for (let i = stemRows; i < VERTS; i++) expect(vert.getZ(i)).toBe(1);
    field.dispose();
  });

  it('bakes aGround and rebuilds it', () => {
    const field = createFlowerField({ count: 64, heightAt: () => 3 });
    const ground = field.mesh.geometry.getAttribute('aGround');
    for (let i = 0; i < ground.count; i++) expect(ground.getX(i)).toBe(3);
    field.rebuild(() => -1);
    for (let i = 0; i < ground.count; i++) expect(ground.getX(i)).toBe(-1);
    field.dispose();
  });

  it('is deterministic', () => {
    const a = createFlowerField({ count: 120, heightAt: () => 0 });
    const b = createFlowerField({ count: 120, heightAt: () => 0 });
    expect(Array.from(a.mesh.geometry.getAttribute('aRand').array)).toEqual(
      Array.from(b.mesh.geometry.getAttribute('aRand').array),
    );
    a.dispose();
    b.dispose();
  });

  it('sows fewer flowers than the meadow has blades, unpainted', () => {
    const field = createFlowerField({ count: 8, heightAt: () => 0 });
    // A meadow is mostly grass: the map's own flower term is a sprinkle.
    expect(field.material.uniforms.uBaseDensity!.value).toBeLessThan(0.5);
    field.setBaseDensity(2);
    expect(field.material.uniforms.uBaseDensity!.value).toBe(1);
    field.dispose();
  });

  it('has a projection tier and a phone tier', () => {
    expect(FLOWER_COUNT_PROJECTION).toBeGreaterThan(FLOWER_COUNT_PHONE);
  });
});
