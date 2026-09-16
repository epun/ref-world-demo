/**
 * The ground height, baked into one texture for the element shaders that
 * stand ON the ground rather than being part of it (2026-09-15).
 *
 * WHY THIS EXISTS. The blade field and the bloom field are a quarter of a
 * million instances laid inside a window that SLIDES with the camera
 * (`src/world/ghibli/grass.ts`). Each one has to sit on the hillside under it,
 * and the only legal height source in this project is the `Surface` seam
 * (`src/world/surface.ts`, CLAUDE.md). Sampling the seam per blade costs
 * **651ms for 150 000 blades** — measured — so every slide of the window was a
 * dropped frame. So the seam is sampled ONCE per terrain rebuild into this
 * texture and the vertex shaders read it: a slide is then a single uniform
 * write and no CPU work at all.
 *
 * It is a CACHE OF THE SEAM'S ANSWERS, exactly as the region bake is
 * (`src/world/ghibli/region.ts`) — nothing here derives a height, and the
 * caller passes the sampler in.
 *
 * R32F, NEAREST. A float texture so a height can be negative (the basins are)
 * and needs no encoding; nearest because linear filtering of a 32-bit float
 * texture is an extension (`OES_texture_float_linear`) rather than a promise,
 * so the shaders do their own bilinear tap (`GG_HEIGHT_GLSL`). The resolution
 * is 256 over the painted map's 400 units — 1.56 units a texel, which is
 * coarser than a terrace riser is wide, so a blade within a unit of a lip
 * stands on a smoothed version of it. That is the trade the frame time bought:
 * 65 000 seam samples a rebuild instead of 150 000 a window slide. **[D]**
 */

import { DataTexture, FloatType, NearestFilter, RedFormat } from 'three';
import { PAINTED_SIZE } from '../painted';
import { ggFloat } from './shared';

/** Texels a side. */
export const HEIGHT_RES = 256;

/** World units the bake spans, centred on the origin — the painted map's own
 * extent, so one uv mapping reads this texture and every layer alike. */
export const HEIGHT_SIZE = PAINTED_SIZE;

/**
 * Bake the ground into a fresh `DataTexture`.
 *
 * `sampleHeight` is the `Surface` seam's own method and nothing else.
 */
export function bakeHeightTexture(
  sampleHeight: (x: number, z: number) => number,
  res: number = HEIGHT_RES,
): DataTexture {
  const texture = new DataTexture(new Float32Array(res * res), res, res, RedFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  rebakeHeight(texture, sampleHeight);
  return texture;
}

/**
 * Re-bake IN PLACE — same buffer, same texture object, one `needsUpdate`.
 *
 * The call that belongs beside `ground.rebuild()`: the terrain dials moved or
 * the map changed, so every blade standing on it has to come with it, and this
 * is the one write that makes that happen.
 */
export function rebakeHeight(
  texture: DataTexture,
  sampleHeight: (x: number, z: number) => number,
): void {
  const res = texture.image.width;
  const data = texture.image.data as Float32Array;
  const step = HEIGHT_SIZE / res;
  const origin = -HEIGHT_SIZE / 2 + step * 0.5;
  for (let tz = 0; tz < res; tz++) {
    const z = origin + tz * step;
    for (let tx = 0; tx < res; tx++) {
      data[tz * res + tx] = sampleHeight(origin + tx * step, z);
    }
  }
  texture.needsUpdate = true;
}

/**
 * The shader side: a bilinear tap of the bake, in world xz.
 *
 * Four nearest taps and a lerp rather than a hardware filter, for the reason
 * the header gives. `uHeight` is the texture and `uHeightRes` its resolution;
 * a field with no bake installed reads a 1×1 zero texel and stands on flat
 * paper, which is exactly the plain world.
 */
export const GG_HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeight;
uniform float uHeightRes;

float ggGroundAt(vec2 world) {
  vec2 uv = world / ${ggFloat(HEIGHT_SIZE)} + 0.5;
  vec2 t = uv * uHeightRes - 0.5;
  vec2 f = fract(t);
  vec2 base = (floor(t) + 0.5) / uHeightRes;
  float texel = 1.0 / uHeightRes;
  float h00 = texture2D(uHeight, base).r;
  float h10 = texture2D(uHeight, base + vec2(texel, 0.0)).r;
  float h01 = texture2D(uHeight, base + vec2(0.0, texel)).r;
  float h11 = texture2D(uHeight, base + vec2(texel, texel)).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}`;

/** [D] Fraction of the window's half-span the fade runs over. */
export const WINDOW_FADE = 0.45;

/**
 * The squircle window fade, shared by the blade field, the bloom field and the
 * ground that has to agree with both (2026-09-15, user direction: the window
 * *"must be invisible"* and *"NOT a diamond"*).
 *
 * A DIAMOND is what `max(|dx|, |dz|)` draws once the isometric camera turns it
 * 45°, and it was plainly visible on screen. The cubic sum is a squircle: a
 * rounded square with no corner pointing at the viewer, and the fade runs over
 * the last 45% of it, which is about ten units of ground at the shipped span.
 */
export const GG_WINDOW_GLSL = /* glsl */ `
uniform vec2 uCenter;
uniform float uSpan;

float ggWindow(vec2 world) {
  vec2 d = abs(world - uCenter) / max(uSpan * 0.5, 1e-3);
  float r = pow(pow(d.x, 3.0) + pow(d.y, 3.0), 1.0 / 3.0);
  return 1.0 - smoothstep(${ggFloat(1 - WINDOW_FADE)}, 1.0, r);
}`;

