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
 * 512² over the ground field's 400 units — 0.78 units a texel, against a foam
 * rim of about one and a half to three units, so the rim is four texels wide
 * at its thinnest. **[D]** Both ride `mapScale` (2026-09-16), so the texel is
 * 0.78 on any size of map.
 *
 * R16F, LINEAR (2026-09-17, the iOS Safari audit — it was R32F before).
 *
 * The filter is the reason. This field is smooth by construction (it is a
 * distance) and every band read off it wants a smooth ramp rather than a
 * staircase four texels wide, so it is the one bake here that asks for
 * hardware filtering. A 32-bit float texture is NOT texture-filterable in
 * core WebGL 2 — that is `OES_texture_float_linear`, and iOS Safari does not
 * expose it — and a sampler with `LINEAR` on a non-filterable texture makes
 * the texture INCOMPLETE, which samples as `(0,0,0,1)`. Zero here means "on
 * land", which the shader reads as foam: on an iPhone the whole sea would
 * have rendered as a sheet of surf. 16-bit float IS filterable in core
 * WebGL 2, so `HalfFloatType` costs half the bandwidth and needs no
 * extension at all. Its spacing at the numbers that decide the look — the
 * first few units off the shore — is under a thousandth of a unit; out in
 * open water it is half a unit, on a value nothing bands against.
 *
 * (The HEIGHT bake next door stays R32F because it is `NEAREST` and does its
 * own bilinear tap in the shader — nearest sampling of a float texture is
 * core, and a height has to be able to go negative and stay exact.)
 *
 * INSIDE IS POSITIVE. A texel in water holds its distance to the nearest dry
 * texel, in world units; a texel on land holds 0, which is the value the
 * shader reads as "foam" — so the slop where a fill's edge overhangs the
 * waterline by half a texel reads as surf rather than as deep water.
 */

import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RedFormat } from 'three';
import { isPhoneTier } from '../device';
import { FIELD_SIZE, fieldSize } from '../field';
import { distanceTransform } from '../painted-water';
import { ggFloat } from './shared';

/** Texels a side on a world with no island. */
export const SHORE_RES = 512;

/** World units the bake spans on a world with no island, centred on the
 * origin — the displaced ground field's own extent. */
export const SHORE_SIZE = FIELD_SIZE;

/**
 * …and the two the bake actually uses: both through `mapScale`
 * (2026-09-16, `MAP_SCALE` in src/world/landscape.ts), so the TEXEL stays
 * 0.78 world units and the foam rim is still four texels wide at its
 * thinnest. 1024² over 800 units at scale 2; **563² over 440 at 1.1**.
 *
 * ROUNDED TO A TEXEL COUNT, NOT STEPPED TO A POWER OF TWO (2026-09-17, when
 * `MAP_SCALE` stopped being an integer). 512 * 1.1 is 563.2, and the choice
 * was between an NPOT 563 that keeps the texel (0.7815 against 0.78125, three
 * hundredths of a percent) and a POT 1024 that would have halved it and
 * quadrupled a bake that already measures a second on one core. This is a WebGL2 renderer and
 * the texture is CLAMP + LINEAR with no mipmaps, which NPOT has always
 * supported there, so the rounding costs nothing at all and the texel — the
 * number the foam rim is measured against — is the thing that is held.
 */
export function shoreSize(): number {
  return fieldSize();
}

export function shoreRes(): number {
  // A HANDSET KEEPS 512 (2026-09-16). The bake is one `isWater` call and one
  // distance transform per texel: 1024² measured 1007ms on one node core
  // against 512²'s 203ms, and it re-runs on every landscape switch, terrain
  // dial and painted pond. At 512 over 800 units the texel is 1.56 rather
  // than 0.78, so the foam rim of 1.5–3 units is one or two texels instead of
  // two to four — a softer surf line on the screen that shows it least, which
  // is the trade the load time is worth. The projection keeps the texel.
  if (isPhoneTier()) return SHORE_RES;
  return Math.round(SHORE_RES * (fieldSize() / FIELD_SIZE));
}

/**
 * Bake the water into a fresh `DataTexture`.
 *
 * `isWater` is `src/world/landscape.ts`'s own query and nothing else — it
 * already answers for the authored bodies, for the sea when the island is on,
 * and for every painted body.
 */
export function bakeShoreTexture(
  isWater: (x: number, z: number) => boolean,
  res: number = shoreRes(),
): DataTexture {
  const texture = new DataTexture(
    new Uint16Array(res * res),
    res,
    res,
    RedFormat,
    HalfFloatType,
  );
  // LINEAR here, unlike the height bake: this field is smooth by construction
  // (it is a distance) and the bands read off it want a smooth ramp, not a
  // staircase four texels wide. See the header for why that forces 16-bit.
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
  const data = texture.image.data as Uint16Array;
  const size = shoreSize();
  const step = size / res;
  const origin = -size / 2 + step * 0.5;
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
    // Half-float, so the value is ENCODED rather than stored: this buffer is
    // the texture's own, and the gpu reads its sixteen bits as an f16.
    data[i] = DataUtils.toHalfFloat(wet[i] === 1 ? Math.sqrt(dist[i]!) * step : 0);
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
export function ggShoreGlsl(): string {
  const size = shoreSize();
  return /* glsl */ `
uniform sampler2D uShoreTex;
uniform float uShoreOn;

float ggShoreAt(vec2 world) {
  vec2 uv = world / ${ggFloat(size)} + 0.5;
  float baked = texture2D(uShoreTex, uv).r;
  return mix(${ggFloat(size)}, baked, uShoreOn);
}`;
}
