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

/**
 * [D] The field's shape, in world units from the look-target.
 *
 * A WINDOW WITH DISTANCE LOD (2026-09-16, user direction: the old
 * constant-density square read as *"a textured oval on a flat green field"* —
 * the eye finds texture against no-texture long after the colours match). The
 * tier's budget is spent as a radial profile instead: full density in the
 * core, falling away with distance, out to a reach that covers the whole
 * default view. Beyond the reach the ghibli ground's own blade stipple carries
 * the meadow (src/world/ghibli/ground.ts).
 *
 * THE INTEGRAL IS THE CONSTRAINT, and it is what picked every number here.
 * At envpaint's 77 blades a square unit, a core of radius 18 alone is 78 000
 * blades — half a projection's whole budget — and a flat 8 a square unit out
 * to 70 is another 123 000. The curve is an INVERSE SQUARE clamped at
 * `RIM_DENSITY`, which is the one shape that spends a fixed budget over a
 * wide reach without either starving the core or thinning to nothing: a
 * 10-unit core at full density is 24 000 blades, the 1/r² skirt out to 38
 * units is 64 000, and the clamped rim from there to 70 is 59 000 — about
 * 147 000, against the 150 000 the tier carries. A gentler fall was tried
 * first and measured: it left the core at 16 blades a square unit, a fifth of
 * envpaint's, because the area weighting ate the budget on the way out.
 */
export const FIELD_CORE = 10;
export const FIELD_REACH = 70;

/** [D] Density at the reach, as a fraction of the core's — 7 blades a square
 * unit against 77, which still reads as grass at this world's scale and is
 * what the budget affords over an area sixty times the core's. */
export const RIM_DENSITY = 0.07;

/** [D] How much of its height a blade keeps at the rim: the field thins in
 * SIZE as well as in count, so the transition is never a line where blades
 * stop (TASTE §2.1). */
export const RIM_HEIGHT = 0.6;

/**
 * The field's radial profile, shared by the blade field, the bloom field and
 * the ground that has to agree with both.
 *
 *   `ggFieldDensity` — the density curve, 1 in the core and `RIM_DENSITY` at
 *     the reach, 0 beyond it. The blade cull multiplies by this.
 *   `ggFieldHeight`  — 1 in the core, `RIM_HEIGHT` at the reach.
 *   `ggFieldDense`   — how much the BLADES own this ground: 1 in the core,
 *     0 by the reach. The ground tints to the field's colour by it, and
 *     suppresses its own stipple by it (the blades are the texture there).
 *
 * `uCenter` is the look-target, quantised by the caller; `uSpan` is twice the
 * reach, kept under that name because every consumer already writes it.
 */
export const GG_FIELD_GLSL = /* glsl */ `
uniform vec2 uCenter;
uniform float uSpan;

float ggFieldR(vec2 world) {
  return length(world - uCenter) / max(uSpan * 0.5, 1e-3);
}

/**
 * The hard cut at the reach, and nothing else.
 *
 * What the BLADE field's cull uses, because its LAYOUT already carries the
 * density curve (an inverse-CDF draw — src/world/ghibli/grass.ts): applying
 * the curve in both places would square it and leave the rim bare. The BLOOM
 * field is the other way round — an area-even layout and the curve in the
 * cull — because a bloom field is sparse enough that the cull can afford to
 * throw most of them away.
 */
float ggFieldReach(vec2 world) {
  return step(ggFieldR(world), 1.0);
}

float ggFieldDensity(vec2 world) {
  float r = ggFieldR(world);
  // Flat through the core, then 1/r² — the header's integral — clamped so the
  // rim still has grass in it rather than a handful of survivors.
  float rel = clamp(${ggFloat(FIELD_CORE / FIELD_REACH)} / max(r, 1e-4), 0.0, 1.0);
  return step(r, 1.0) * max(${ggFloat(RIM_DENSITY)}, rel * rel);
}

float ggFieldHeight(vec2 world) {
  float r = ggFieldR(world);
  return mix(1.0, ${ggFloat(RIM_HEIGHT)}, smoothstep(0.0, 1.0, r)) * step(r, 1.0);
}

float ggFieldDense(vec2 world) {
  float r = ggFieldR(world);
  return 1.0 - smoothstep(${ggFloat(FIELD_CORE / FIELD_REACH)}, 0.6, r);
}`;
