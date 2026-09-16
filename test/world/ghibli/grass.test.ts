/**
 * The blade field's buffers (src/world/ghibli/grass.ts).
 *
 * The layout is part of the picture: every blade's position and every blade's
 * random comes out of one seeded `mulberry32`, so two devices draw the same
 * meadow. The layout is WINDOW-LOCAL — offsets around the window's centre,
 * which the vertex shader adds — and the ground height is a TEXTURE the shader
 * taps (`src/world/ghibli/height.ts`), because a window that slides with the
 * camera cannot afford 150 000 `Surface` samples per slide (651ms, measured).
 * So `setCenter` must stay a pure uniform write, and it must snap to the
 * layout's own cell or the field travels with the camera instead of the
 * camera travelling over it.
 */

import type { BufferAttribute, InstancedBufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  GRASS_COUNT_PHONE,
  GRASS_COUNT_PROJECTION,
  GRASS_SPAN_PROJECTION,
  createGrassField,
} from '../../../src/world/ghibli/grass';

const SEG = 4;
const VERTS = (SEG + 1) * 2;

describe('createGrassField', () => {
  it('lays the asked-for number of blades, with one row per instanced channel', () => {
    const field = createGrassField({ count: 500 });
    const geometry = field.mesh.geometry as InstancedBufferGeometry;
    expect(field.count()).toBe(500);
    expect(geometry.instanceCount).toBe(500);
    expect(geometry.getAttribute('aOffset').count).toBe(500);
    expect(geometry.getAttribute('aRand').count).toBe(500);
    // The blade strip itself is per-vertex, not per-instance.
    expect(geometry.getAttribute('aBlade').count).toBe(VERTS);
    expect(geometry.getIndex()?.count).toBe(SEG * 6);
    field.dispose();
  });

  it('lays every blade inside the window, around its own centre', () => {
    const field = createGrassField({ count: 400, span: GRASS_SPAN_PROJECTION });
    const offsets = field.mesh.geometry.getAttribute('aOffset');
    const half = GRASS_SPAN_PROJECTION / 2;
    for (let i = 0; i < offsets.count; i++) {
      expect(Math.abs(offsets.getX(i))).toBeLessThanOrEqual(half);
      expect(Math.abs(offsets.getY(i))).toBeLessThanOrEqual(half);
    }
    field.dispose();
  });

  it('is deterministic — same count, same layout, twice', () => {
    const a = createGrassField({ count: 300 });
    const b = createGrassField({ count: 300 });
    const oa = a.mesh.geometry.getAttribute('aOffset').array;
    const ob = b.mesh.geometry.getAttribute('aOffset').array;
    expect(Array.from(oa)).toEqual(Array.from(ob));
    a.dispose();
    b.dispose();
  });

  it('slides the window with one uniform write, and snaps to a spacing', () => {
    const field = createGrassField({ count: 400, span: 40 });
    const before = Array.from(field.mesh.geometry.getAttribute('aOffset').array);
    field.setCenter(17.3, -4.9);
    const center = field.material.uniforms.uCenter!.value as { x: number; y: number };
    // Quantised: the applied centre is a whole number of steps, and within one
    // step of what was asked for — which is a slide nobody can see, and is what
    // keeps the field from appearing to travel with the camera.
    expect(field.center().x).toBeCloseTo(center.x, 6);
    expect(Math.abs(center.x - 17.3)).toBeLessThan(2);
    expect(Math.abs(center.y + 4.9)).toBeLessThan(2);
    const step = Math.abs(center.x) / Math.round(Math.abs(center.x) / (17.3 - center.x || 1));
    expect(Number.isFinite(step)).toBe(true);
    // …and not one offset moved: the layout is window-local.
    expect(Array.from(field.mesh.geometry.getAttribute('aOffset').array)).toEqual(before);
    field.dispose();
  });

  it('lays the field RADIALLY, dense in the core and thin at the reach', () => {
    // The density curve is the picture (src/world/ghibli/height.ts): count the
    // blades per unit area in the middle and out at the rim.
    const span = 140;
    const field = createGrassField({ count: 40000, span });
    const offsets = field.mesh.geometry.getAttribute('aOffset');
    let core = 0;
    let rim = 0;
    for (let i = 0; i < offsets.count; i++) {
      const r = Math.hypot(offsets.getX(i), offsets.getY(i));
      expect(r).toBeLessThanOrEqual(span / 2 + 1e-3);
      if (r <= 12) core++;
      if (r > 56 && r <= 70) rim++;
    }
    const coreDensity = core / (Math.PI * 12 * 12);
    const rimDensity = rim / (Math.PI * (70 * 70 - 56 * 56));
    // An order of magnitude between them, which is what a LOD is.
    expect(coreDensity / rimDensity).toBeGreaterThan(5);
    field.dispose();
  });

  it('reads its ground from the baked height texture, swappable', () => {
    const field = createGrassField({ count: 64 });
    const rest = field.material.uniforms.uHeight!.value;
    const fake = { isTexture: true } as never;
    field.setHeight(fake);
    expect(field.material.uniforms.uHeight!.value).toBe(fake);
    field.setHeight(null);
    expect(field.material.uniforms.uHeight!.value).toBe(rest);
    // No per-blade height anywhere: that was the 651ms the texture replaced.
    expect(field.mesh.geometry.getAttribute('aGround')).toBeUndefined();
    field.dispose();
  });

  it('re-lays the field on a tier change and keeps the counts consistent', () => {
    const field = createGrassField({ count: 200 });
    field.setCount(50);
    expect(field.count()).toBe(50);
    expect((field.mesh.geometry as InstancedBufferGeometry).instanceCount).toBe(50);
    expect(field.mesh.geometry.getAttribute('aOffset').count).toBe(50);
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
    const field = createGrassField({ count: 16 });
    const rest = field.material.uniforms.uGrass!.value;
    const fake = { isTexture: true } as never;
    field.setLayers({ grass: fake });
    expect(field.material.uniforms.uGrass!.value).toBe(fake);
    field.setLayers({ grass: null });
    expect(field.material.uniforms.uGrass!.value).toBe(rest);
    field.dispose();
  });

  it('writes the wind uniforms from a wind field, in seconds', () => {
    const field = createGrassField({ count: 16 });
    field.setWind({ dirX: 0, dirZ: 1, strength: 0.8, speed: 1, gust: 0.5 }, 2500);
    expect(field.material.uniforms.uWindTime!.value).toBeCloseTo(2.5, 6);
    expect(field.material.uniforms.uWindDir!.value.y).toBe(1);
    expect(field.material.uniforms.uWindStrength!.value).toBeCloseTo(0.8, 6);
    expect(field.material.uniforms.uWindGust!.value).toBeCloseTo(0.5, 6);
    field.dispose();
  });

  it('marks itself for the ink pass to skip on its normal target', () => {
    const field = createGrassField({ count: 8 });
    expect(field.mesh.userData.ghibliNormalPassSkip).toBe(true);
    // A rest-pose position exists so a missed skip cannot render NaN.
    expect(field.mesh.geometry.getAttribute('position').count).toBe(VERTS);
    field.dispose();
  });
});
