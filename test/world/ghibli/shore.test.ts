/**
 * The shore bake (src/world/ghibli/shore.ts).
 *
 * This is the field the whole ghibli water surface is banded off, and it
 * replaced a per-vertex attribute that could not be made robust: earcut gives
 * a fill whose every vertex lies ON the outline, so the lake's interior
 * triangles read zero at all three corners and painted the body as foam (a
 * user saw the white wedges on the live build). So what matters here is that
 * the field is a real distance INSIDE the water, zero on land, and re-baked in
 * place.
 */

import type { DataTexture } from 'three';
import { describe, expect, it } from 'vitest';
import { SHORE_SIZE, bakeShoreTexture, rebakeShore } from '../../../src/world/ghibli/shore';

const at = (texture: DataTexture, tx: number, tz: number): number =>
  (texture.image.data as Float32Array)[tz * texture.image.width + tx]!;

/** A disc of water of radius `r` about the origin. */
const disc =
  (r: number) =>
  (x: number, z: number): boolean =>
    Math.hypot(x, z) <= r;

describe('bakeShoreTexture', () => {
  it('is zero on land and positive in water', () => {
    const res = 64;
    const texture = bakeShoreTexture(disc(40), res);
    const step = SHORE_SIZE / res;
    const centre = res / 2;
    expect(at(texture, centre, centre)).toBeGreaterThan(0);
    // A corner of the map is a long way outside a 40-unit disc.
    expect(at(texture, 0, 0)).toBe(0);
    expect(step).toBeGreaterThan(0);
    texture.dispose();
  });

  it('measures the distance to the shore, in world units', () => {
    const res = 128;
    const radius = 60;
    const texture = bakeShoreTexture(disc(radius), res);
    const step = SHORE_SIZE / res;
    // At the centre of a disc the nearest dry ground is a radius away.
    expect(at(texture, res / 2, res / 2)).toBeGreaterThan(radius - 2 * step);
    expect(at(texture, res / 2, res / 2)).toBeLessThan(radius + 2 * step);
    // …and it falls off toward the shore: sample along the row through the
    // centre, a third of the way out.
    const third = Math.round((res / 2) * (1 + (radius / 3 / SHORE_SIZE) * 2));
    expect(at(texture, third, res / 2)).toBeLessThan(at(texture, res / 2, res / 2));
    texture.dispose();
  });

  it('is exact enough for a foam rim: the first wet texel is under a texel out', () => {
    const res = 256;
    const texture = bakeShoreTexture(disc(50), res);
    const step = SHORE_SIZE / res;
    // Walk out along the centre row and find where the water ends.
    let last = 0;
    for (let tx = res / 2; tx < res; tx++) {
      const v = at(texture, tx, res / 2);
      if (v === 0) break;
      last = v;
    }
    // The last wet texel is within a texel of the shore, so a rim a couple of
    // units wide has several texels to live in.
    expect(last).toBeLessThan(step * 1.5);
    texture.dispose();
  });

  it('re-bakes IN PLACE: same texture, same buffer, one upload', () => {
    const texture = bakeShoreTexture(disc(30), 64);
    const buffer = texture.image.data as Float32Array;
    const before = texture.version;
    const centre = 32;
    const wide = at(texture, centre, centre);
    rebakeShore(texture, disc(80));
    expect(texture.image.data).toBe(buffer);
    expect(texture.version).toBeGreaterThan(before);
    // A bigger lake is deeper water at its centre.
    expect(at(texture, centre, centre)).toBeGreaterThan(wide);
    texture.dispose();
  });

  it('holds a dry world at zero rather than at nonsense', () => {
    const texture = bakeShoreTexture(() => false, 32);
    for (let i = 0; i < 32 * 32; i++) {
      expect((texture.image.data as Float32Array)[i]).toBe(0);
    }
    texture.dispose();
  });
});
