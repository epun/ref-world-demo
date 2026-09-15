/**
 * The baked geography (src/world/ghibli/region.ts).
 *
 * The whole point of this texture is that the elements read the AUTHORED map
 * rather than a second opinion about it, so what these tests pin is the
 * encoding every shader keys off: water is exactly the top of the b channel,
 * land is never mistaken for it, the beach only exists near water, and grass
 * grows where the map says land.
 */

import { describe, expect, it } from 'vitest';
import { setLandscapeMode } from '../../../src/world/landscape';
import { REGION_RES, bakeRegionTexture, rebakeRegion } from '../../../src/world/ghibli/region';

function channels(data: Uint8Array, i: number): { r: number; g: number; b: number } {
  return { r: data[i * 4]!, g: data[i * 4 + 1]!, b: data[i * 4 + 2]! };
}

describe('bakeRegionTexture', () => {
  it('bakes a square rgba texture at the declared resolution', () => {
    const texture = bakeRegionTexture();
    expect(texture.image.width).toBe(REGION_RES);
    expect(texture.image.height).toBe(REGION_RES);
    expect((texture.image.data as Uint8Array).length).toBe(REGION_RES * REGION_RES * 4);
    // `needsUpdate` is write-only in three (it bumps `version`).
    expect(texture.version).toBeGreaterThan(0);
  });

  it('keeps water at the top of the b channel and land under it', () => {
    setLandscapeMode('landscape');
    const texture = bakeRegionTexture(64);
    const data = texture.image.data as Uint8Array;
    let wet = 0;
    let dry = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const c = channels(data, i);
      if (c.b === 255) {
        wet++;
        // Nothing grows in water, and water is not a beach.
        expect(c.r).toBe(0);
        expect(c.g).toBe(0);
      } else {
        dry++;
        // The land half of the ramp stops short of the water mark, so a
        // `step(0.95, b)` in a shader means exactly "wet".
        expect(c.b).toBeLessThanOrEqual(230);
      }
    }
    expect(wet).toBeGreaterThan(0);
    expect(dry).toBeGreaterThan(0);
  });

  it('only calls a beach a beach on land, and only some of it', () => {
    setLandscapeMode('landscape');
    const res = 64;
    const texture = bakeRegionTexture(res);
    const data = texture.image.data as Uint8Array;
    let beach = 0;
    let land = 0;
    for (let i = 0; i < res * res; i++) {
      const c = channels(data, i);
      if (c.b === 255) continue; // water is not a beach — pinned above
      land++;
      if (c.g > 0) {
        beach++;
        // Sand takes the meadow channel down where it is strong, so a beach
        // texel never also reads as full meadow.
        if (c.g > 200) expect(c.r).toBeLessThan(120);
      }
    }
    expect(beach).toBeGreaterThan(0);
    // A shoreline ribbon, not a county: the beach is a minority of the land.
    expect(beach).toBeLessThan(land * 0.5);
  });

  it('grows grass on the plain field with no map at all', () => {
    setLandscapeMode('plain');
    const texture = bakeRegionTexture(32);
    const data = texture.image.data as Uint8Array;
    let meadow = 0;
    for (let i = 0; i < 32 * 32; i++) if (channels(data, i).r > 200) meadow++;
    expect(meadow).toBeGreaterThan(0);
  });

  it('re-bakes in place — same buffer, same texture', () => {
    setLandscapeMode('landscape');
    const texture = bakeRegionTexture(32);
    const buffer = texture.image.data;
    const version = texture.version;
    setLandscapeMode('plain');
    rebakeRegion(texture);
    expect(texture.image.data).toBe(buffer);
    expect(texture.version).toBeGreaterThan(version);
    // Back to the shipped default, so nothing after this reads a switched map.
    setLandscapeMode('plain');
  });
});
