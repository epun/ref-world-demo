/**
 * How far a point is from the nearest shore, baked into one texture
 * (2026-09-16).
 *
 * WHY THIS REPLACED A VERTEX ATTRIBUTE. The ghibli water surface bands its
 * whole look off this one number — the foam rim, the wet line, the shallow
 * shelf and the depth ramp are all thresholds on it — and the first port baked
 * it per FILL VERTEX (docs/ghibli-port.md §6). That cannot be made robust:
 * earcut's fill has every vertex ON the outline, so a triangle spanning the
 * body's interior reads zero at all three corners and paints the whole span as
 * foam. Refining the triangles inside a band fixed the small bodies and left
 * the lake with huge white wedges — the interior triangles whose centroids sit
 * outside the band — which is exactly what a user saw on the live build.
 *
 * A TEXTURE HAS NO TRIANGLES. The field is exact (the same Euclidean distance
 * transform the painted water derivation uses — Felzenszwalb & Huttenlocher,
 * `distanceTransform` in src/world/painted-water.ts, not a chamfer, because
 * the foam rim is narrower than a chamfer's diagonal error), sampled by world
 * xz in the fragment shader, and it costs the fills nothing: they go back to
 * their plain earcut geometry, which is also the geometry the ink pass draws.
 *
 * 512² over the painted map's 400 units — 0.78 units a texel, against a foam
 * rim of about one and a half to three units, so the rim is four texels wide
 * at its thinnest. **[D]**
 *
 * INSIDE IS POSITIVE. A texel in water holds its distance to the nearest dry
 * texel, in world units; a texel on land holds 0, which is the value the
 * shader reads as "foam" — so the slop where a fill's edge overhangs the
 * waterline by half a texel reads as surf rather than as deep water.
 */

import { DataTexture, FloatType, LinearFilter, RedFormat } from 'three';
import { PAINTED_SIZE } from '../painted';
import { distanceTransform } from '../painted-water';
import { ggFloat } from './shared';

/** Texels a side. */
export const SHORE_RES = 512;

/** World units the bake spans, centred on the origin — the painted map's own
 * extent, so one uv mapping reads this texture and every other bake alike. */
export const SHORE_SIZE = PAINTED_SIZE;

/**
 * Bake the water into a fresh `DataTexture`.
 *
 * `isWater` is `src/world/landscape.ts`'s own query and nothing else — it
 * already answers for the authored bodies, for the sea when the island is on,
 * and for every painted body.
 */
export function bakeShoreTexture(
  isWater: (x: number, z: number) => boolean,
  res: number = SHORE_RES,
): DataTexture {
  const texture = new DataTexture(new Float32Array(res * res), res, res, RedFormat, FloatType);
  // LINEAR here, unlike the height bake: this field is smooth by construction
  // (it is a distance) and the bands read off it want a smooth ramp, not a
  // staircase four texels wide.
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  rebakeShore(texture, isWater);
  return texture;
}

/**
 * Re-bake IN PLACE — same buffer, same texture object, one `needsUpdate`.
 *
 * Belongs beside the region and the height bakes (src/world/ground.ts's
 * `rebuild`): one pass, three textures, and every surface that reads a
 * shoreline sees the new one without being handed anything.
 */
export function rebakeShore(
  texture: DataTexture,
  isWater: (x: number, z: number) => boolean,
): void {
  const res = texture.image.width;
  const data = texture.image.data as Float32Array;
  const step = SHORE_SIZE / res;
  const origin = -SHORE_SIZE / 2 + step * 0.5;
  // The SOURCE of the transform is dry land: the distance we want, inside
  // water, is the distance to the nearest dry texel.
  const land = new Uint8Array(res * res);
  const wet = new Uint8Array(res * res);
  for (let tz = 0; tz < res; tz++) {
    const z = origin + tz * step;
    for (let tx = 0; tx < res; tx++) {
      const i = tz * res + tx;
      const water = isWater(origin + tx * step, z);
      wet[i] = water ? 1 : 0;
      land[i] = water ? 0 : 1;
    }
  }
  const { dist } = distanceTransform(res, land);
  for (let i = 0; i < res * res; i++) {
    // Squared texel distance → world units, and land reads 0 (see the header).
    data[i] = wet[i] === 1 ? Math.sqrt(dist[i]!) * step : 0;
  }
  texture.needsUpdate = true;
}

/**
 * The shader side: the shore distance at a world xz, in world units.
 *
 * `uShoreTex` is the bake and `uShoreOn` says whether one is installed — with
 * none, every point reads a long way from shore, which is open water, and the
 * surface renders as its deep band rather than as a sheet of foam.
 */
export const GG_SHORE_GLSL = /* glsl */ `
uniform sampler2D uShoreTex;
uniform float uShoreOn;

float ggShoreAt(vec2 world) {
  vec2 uv = world / ${ggFloat(SHORE_SIZE)} + 0.5;
  float baked = texture2D(uShoreTex, uv).r;
  return mix(${ggFloat(SHORE_SIZE)}, baked, uShoreOn);
}`;
