/**
 * The ground bake (src/world/ghibli/height.ts).
 *
 * It exists so that a window of a quarter of a million blades can slide with
 * the camera without the CPU touching one of them — so the two things that
 * matter are that it holds the SEAM'S OWN answers, and that a re-bake writes
 * the same buffer in place (a new texture per terrain drag would be a fresh
 * upload of a megabyte, and every field holding the old one would keep
 * standing on the old ground).
 */

import type { DataTexture } from 'three';
import { describe, expect, it } from 'vitest';
import {
  HEIGHT_RES,
  HEIGHT_SIZE,
  bakeHeightTexture,
  rebakeHeight,
} from '../../../src/world/ghibli/height';

const texelAt = (texture: DataTexture, tx: number, tz: number): number =>
  (texture.image.data as Float32Array)[tz * texture.image.width + tx]!;

describe('bakeHeightTexture', () => {
  it('bakes a square of the sampler, at the declared resolution', () => {
    const texture = bakeHeightTexture(() => 2.5, 16);
    expect(texture.image.width).toBe(16);
    expect(texture.image.height).toBe(16);
    expect((texture.image.data as Float32Array).length).toBe(16 * 16);
    for (let i = 0; i < 16 * 16; i++) {
      expect((texture.image.data as Float32Array)[i]).toBe(2.5);
    }
    texture.dispose();
  });

  it('samples the world positions its texels stand for', () => {
    // A ramp in x alone: the first column is the west edge, the last the east.
    const texture = bakeHeightTexture((x) => x, 8);
    const step = HEIGHT_SIZE / 8;
    const first = -HEIGHT_SIZE / 2 + step * 0.5;
    expect(texelAt(texture, 0, 0)).toBeCloseTo(first, 4);
    expect(texelAt(texture, 7, 0)).toBeCloseTo(first + 7 * step, 4);
    // …and nothing in z, because the sampler ignored it.
    expect(texelAt(texture, 3, 5)).toBeCloseTo(texelAt(texture, 3, 0), 6);
    texture.dispose();
  });

  it('holds negative heights — the basins are under zero', () => {
    const texture = bakeHeightTexture(() => -3.25, 4);
    expect(texelAt(texture, 2, 2)).toBe(-3.25);
    texture.dispose();
  });

  it('re-bakes IN PLACE: same texture, same buffer, one upload', () => {
    const texture = bakeHeightTexture(() => 1, 8);
    const buffer = texture.image.data as Float32Array;
    const before = texture.version;
    rebakeHeight(texture, () => 4);
    expect(texture.image.data).toBe(buffer);
    expect(texelAt(texture, 0, 0)).toBe(4);
    expect(texture.version).toBeGreaterThan(before);
    texture.dispose();
  });

  it('defaults to a resolution that spans the painted map', () => {
    expect(HEIGHT_RES).toBeGreaterThan(64);
    expect(HEIGHT_SIZE).toBeGreaterThan(0);
  });
});
