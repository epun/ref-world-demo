/**
 * The blade field's buffers (src/world/ghibli/grass.ts).
 *
 * The layout is part of the picture: every blade's position and every blade's
 * random comes out of one seeded `mulberry32`, so two devices draw the same
 * meadow. And the GROUND HEIGHT is baked per blade rather than sampled in the
 * shader, because the only legal height source is the `Surface` seam — so
 * `rebuild(heightAt)` is the call `refreshTerrain` has to make, and a blade
 * left at its old height is a blade floating over a hillside that moved.
 */

import type { BufferAttribute, InstancedBufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  GRASS_COUNT_PHONE,
  GRASS_COUNT_PROJECTION,
  createGrassField,
} from '../../../src/world/ghibli/grass';
import { PAINTED_SIZE } from '../../../src/world/painted';

const SEG = 4;
const VERTS = (SEG + 1) * 2;

describe('createGrassField', () => {
  it('lays the asked-for number of blades, with one row per instanced channel', () => {
    const field = createGrassField({ count: 500, heightAt: () => 0 });
    const geometry = field.mesh.geometry as InstancedBufferGeometry;
    expect(field.count()).toBe(500);
    expect(geometry.instanceCount).toBe(500);
    expect(geometry.getAttribute('aOffset').count).toBe(500);
    expect(geometry.getAttribute('aRand').count).toBe(500);
    expect(geometry.getAttribute('aGround').count).toBe(500);
    // The blade strip itself is per-vertex, not per-instance.
    expect(geometry.getAttribute('aBlade').count).toBe(VERTS);
    expect(geometry.getIndex()?.count).toBe(SEG * 6);
    field.dispose();
  });

  it('places every blade inside the painted map', () => {
    const field = createGrassField({ count: 400, heightAt: () => 0 });
    const offsets = field.mesh.geometry.getAttribute('aOffset');
    const half = PAINTED_SIZE / 2;
    for (let i = 0; i < offsets.count; i++) {
      expect(Math.abs(offsets.getX(i))).toBeLessThanOrEqual(half);
      expect(Math.abs(offsets.getY(i))).toBeLessThanOrEqual(half);
    }
    field.dispose();
  });

  it('is deterministic — same count, same layout, twice', () => {
    const a = createGrassField({ count: 300, heightAt: () => 0 });
    const b = createGrassField({ count: 300, heightAt: () => 0 });
    const oa = a.mesh.geometry.getAttribute('aOffset').array;
    const ob = b.mesh.geometry.getAttribute('aOffset').array;
    expect(Array.from(oa)).toEqual(Array.from(ob));
    a.dispose();
    b.dispose();
  });

  it('bakes aGround from the callback, and rebuild rewrites it', () => {
    const field = createGrassField({ count: 128, heightAt: (x) => x * 0.25 });
    const offsets = field.mesh.geometry.getAttribute('aOffset');
    const ground = field.mesh.geometry.getAttribute('aGround');
    for (let i = 0; i < ground.count; i++) {
      expect(ground.getX(i)).toBeCloseTo(offsets.getX(i) * 0.25, 4);
    }
    field.rebuild((_x, z) => z * -0.5);
    for (let i = 0; i < ground.count; i++) {
      expect(ground.getX(i)).toBeCloseTo(offsets.getY(i) * -0.5, 4);
    }
    // `needsUpdate` is write-only in three (it bumps `version`), so the
    // re-upload is checked through the version it bumped.
    expect((field.mesh.geometry.getAttribute('aGround') as BufferAttribute).version).toBeGreaterThan(0);
    field.dispose();
  });

  it('re-lays the field on a tier change and keeps the counts consistent', () => {
    const field = createGrassField({ count: 200, heightAt: () => 1 });
    field.setCount(50);
    expect(field.count()).toBe(50);
    expect((field.mesh.geometry as InstancedBufferGeometry).instanceCount).toBe(50);
    expect(field.mesh.geometry.getAttribute('aGround').count).toBe(50);
    // Same count is a no-op, not a rebuild.
    const geometry = field.mesh.geometry as InstancedBufferGeometry;
    field.setCount(50);
    expect(field.mesh.geometry).toBe(geometry);
    field.dispose();
  });

  it('the two tiers are a projection count and a phone count', () => {
    expect(GRASS_COUNT_PROJECTION).toBeGreaterThan(GRASS_COUNT_PHONE);
    expect(GRASS_COUNT_PHONE).toBeGreaterThan(0);
  });

  it('swaps layer samplers and falls back to rest textures', () => {
    const field = createGrassField({ count: 16, heightAt: () => 0 });
    const rest = field.material.uniforms.uGrass!.value;
    const fake = { isTexture: true } as never;
    field.setLayers({ grass: fake });
    expect(field.material.uniforms.uGrass!.value).toBe(fake);
    field.setLayers({ grass: null });
    expect(field.material.uniforms.uGrass!.value).toBe(rest);
    field.dispose();
  });

  it('writes the wind uniforms from a wind field, in seconds', () => {
    const field = createGrassField({ count: 16, heightAt: () => 0 });
    field.setWind({ dirX: 0, dirZ: 1, strength: 0.8, speed: 1, gust: 0.5 }, 2500);
    expect(field.material.uniforms.uWindTime!.value).toBeCloseTo(2.5, 6);
    expect(field.material.uniforms.uWindDir!.value.y).toBe(1);
    expect(field.material.uniforms.uWindStrength!.value).toBeCloseTo(0.8, 6);
    expect(field.material.uniforms.uWindGust!.value).toBeCloseTo(0.5, 6);
    field.dispose();
  });

  it('marks itself for the ink pass to skip on its normal target', () => {
    const field = createGrassField({ count: 8, heightAt: () => 0 });
    expect(field.mesh.userData.ghibliNormalPassSkip).toBe(true);
    // A rest-pose position exists so a missed skip cannot render NaN.
    expect(field.mesh.geometry.getAttribute('position').count).toBe(VERTS);
    field.dispose();
  });
});
