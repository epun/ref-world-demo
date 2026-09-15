/**
 * Ghibli cel lighting, as one chainable material injection (docs/TASTE.md §9).
 *
 * Ported from envpaint's `ghibliLightingGLSL` (src/core/shaders/toon.glsl.js):
 * two flat tones, a shadow that is hue-shifted cool rather than merely darker,
 * a hard sun-coloured rim on the shade side, and a terminator that follows a
 * brush instead of the maths. There the block lives inside a bespoke
 * ShaderMaterial; here it has to ride the STOCK three materials the world
 * already builds — MeshStandardMaterial props, MeshPhysicalMaterial creatures
 * and eggs, MeshBasicMaterial ground and marks — so it arrives through
 * `onBeforeCompile` and replaces `#include <opaque_fragment>`, which is the one
 * point every one of those shaders has `outgoingLight` and `diffuseColor` in
 * scope.
 *
 * TWO DELIBERATE OMISSIONS from the port:
 *
 *   - **no shadow term.** envpaint reads a shadow map; three.js shadow mapping
 *     stays off here because a shadow map is a penumbra and shadows are flat
 *     stamped shapes (TASTE §2.4, src/world/shadows.ts). `toonLight` is called
 *     with a constant 1.0 — the stamps already give the cast shadows.
 *   - **no painterly grain.** envpaint's `toonLight` multiplies a low-frequency
 *     wobble and a fine hash into the lit colour. Grain here is a full-frame
 *     post-process and never a material (TASTE §2.7) — a per-material grain
 *     would vary across a creature's fill and break the silhouette. Those lines
 *     are dropped; src/world/grain.ts is the grain.
 *
 * CHAINING IS THE CONTRACT. Half the materials in this world already own their
 * `onBeforeCompile`: the ground's terrace marks, the scatter's wind/nudge/
 * variation stack, the character's deform → marking → eye chain, the egg's
 * crack. `applyToon` captures whatever hook is there and calls it FIRST, and
 * wraps `customProgramCacheKey` with a `+toon-v1` suffix the same way. So it
 * must be applied LAST — after `deform.attach`, which assigns rather than
 * chains, and after the scatter's `chainVariation`.
 *
 * ONE SHARED UNIFORM SET. Every material gets the same `toonUniforms` objects
 * by reference, so `setToonEnabled` flips the whole frame with a single value
 * write and no recompile — which is what makes the ghost panel's style select
 * a comparison rather than a reload.
 */

import { Color, Vector3 } from 'three';
import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { GHIBLI } from '../taste/tokens';
import { KEY_DIRECTION } from './lighting';

/**
 * The look controls, shared BY REFERENCE with every toon-injected material.
 *
 * `uToonOn` is the switch: 0 leaves `#include <opaque_fragment>` to compute the
 * frame exactly as it does today, so a world on the `ink` style renders
 * byte-for-byte as it did before this file existed even though the injection is
 * compiled into its shaders.
 */
export const toonUniforms = {
  uToonOn: { value: 0 },
  /** Direction from the ground TOWARD the sun, world space. */
  uSunDir: { value: KEY_DIRECTION.clone() },
  uSunColor: { value: new Color(GHIBLI.sun) },
  uSkyColor: { value: new Color(GHIBLI.sky) },
  /** Linear multiplier — components set directly, never through srgb. */
  uShadowTint: { value: new Color(...GHIBLI.shadowTint) },
  uBandEdge: { value: GHIBLI.bandEdge as number },
  uBandSoft: { value: GHIBLI.bandSoft as number },
  uHalfTone: { value: GHIBLI.halfTone as number },
  uRim: { value: GHIBLI.rim as number },
  /** Albedo a steep slope takes under `TOON_SLOPE_ROCK` (the ground only). */
  uToonSlope: { value: new Color(GHIBLI.rock) },
};

/** Cache-key suffix. Bump with the glsl below, never with a uniform value. */
const TOON_CACHE_SUFFIX = '+toon-v1';

/** userData flag — a second `applyToon` on one material is a no-op, so a
 * caller that cannot tell whether a material has been through here (the
 * topper's material list, a re-attached deform) cannot double-wrap it. */
const TOON_FLAG = 'toonApplied';

/**
 * Self-contained hash / value-noise / fbm.
 *
 * UNIQUE NAMES on purpose: the ground already defines `groundHash`/
 * `groundVNoise`, the scatter's wind block defines its own, and a duplicate
 * function definition in one shader is a compile error. `toonFbm` takes an
 * octave count like envpaint's `fbm` so the ported lines read unchanged.
 */
const TOON_NOISE_GLSL = /* glsl */ `
float toonHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float toonVnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = toonHash21(i);
  float b = toonHash21(i + vec2(1.0, 0.0));
  float c = toonHash21(i + vec2(0.0, 1.0));
  float d = toonHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float toonFbm(vec2 p, int octaves) {
  float v = 0.0;
  float amp = 0.5;
  vec2 q = p;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    v += amp * toonVnoise(q);
    q = q * 2.02 + 17.0;
    amp *= 0.5;
  }
  return v;
}`;

/** The ported lighting model. `fbm` → `toonFbm`, `vWorldPos` → `vToonWorldPos`,
 * grain removed (see the header). Signatures match envpaint's exactly. */
const TOON_LIGHTING_GLSL = /* glsl */ `
varying vec3 vToonWorldPos;
varying vec3 vToonNormal;

uniform float uToonOn;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uShadowTint;
uniform float uBandEdge;
uniform float uBandSoft;
uniform float uHalfTone;
uniform float uRim;
uniform vec3 uToonSlope;
${TOON_NOISE_GLSL}

// How lit the last toonLight() found the surface. Kept from the port so the
// block stays a drop-in; nothing downstream reads it here (the ink pass owns
// the hatch decision, and it keys off the normal target).
float gToonLit = 1.0;

// 0 = shadow, 1 = lit, with a thin half-tone plateau just past the terminator.
// bands <= 1.5 gives a pure two-tone; > 1.5 enables the half-tone.
float toonRamp(float ndl, float bands, float soft) {
  float e = uBandEdge;
  float lit = smoothstep(e - uBandSoft, e + uBandSoft, ndl);
  float mid = smoothstep(e + 0.10 - uBandSoft, e + 0.10 + uBandSoft, ndl);
  return mix(lit, mix(lit * 0.5 + 0.5 * mid, lit, 1.0 - uHalfTone), step(1.5, bands));
}

// The flat colour a surface takes in shadow: hue-shifted cool, not just darker.
vec3 toonShadowColor(vec3 albedo, vec3 n) {
  vec3 s = albedo * uShadowTint;
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  s = mix(vec3(l), s, 1.08);
  s += uSkyColor * 0.06 * clamp(n.y, 0.0, 1.0);
  s *= 1.0 + 0.07 * (toonFbm(vToonWorldPos.xz * 6.0, 2) - 0.5);
  return s;
}

// Two flat tones and a hard rim on the shadow side.
vec3 toonLight(vec3 albedo, vec3 n, float shadow, float bands) {
  float ndl = dot(n, uSunDir);
  // Painted terminator: the band edge follows the brush a little.
  ndl += (toonFbm(vToonWorldPos.xz * 2.0 + vToonWorldPos.y, 2) - 0.5) * 0.12;
  float lit = toonRamp(ndl, bands, uBandSoft) * shadow;
  gToonLit = lit;

  vec3 shade = toonShadowColor(albedo, n);
  vec3 sunlit = albedo * uSunColor * 1.05;
  vec3 col = mix(shade, sunlit, lit);

  vec3 viewDir = normalize(cameraPosition - vToonWorldPos);
  float fres = 1.0 - max(dot(n, viewDir), 0.0);
  float rim = smoothstep(0.62, 0.70, fres) * (1.0 - lit) * uRim;
  col += uSunColor * rim;

  return col;
}`;

/**
 * World position and world normal, from the stock vertex pipeline.
 *
 * `transformed` is POST-displacement, so the terrace field, the wind sway and
 * the creature's deform all land in the position the shadow terminator is
 * computed from. `normal` is the RAW attribute (undeformed) — the same
 * approximation the ink pass already accepts for its normal target, and on a
 * cel ramp a few degrees of stale normal is invisible.
 */
const TOON_VERTEX_GLSL = /* glsl */ `
{
  vec4 tp = vec4(transformed, 1.0);
  vec3 tn = normal;
  #ifdef USE_INSTANCING
    tp = instanceMatrix * tp;
    tn = mat3(instanceMatrix) * tn;
  #endif
  vToonWorldPos = (modelMatrix * tp).xyz;
  vToonNormal = normalize(mat3(modelMatrix) * tn);
}`;

/** The one replacement — `outgoingLight` is overwritten just before three
 * writes it out, so nothing about the stock chain has to be understood. */
const TOON_OPAQUE_GLSL = /* glsl */ `
if (uToonOn > 0.5) {
  vec3 toonAlbedo = diffuseColor.rgb;
  #ifdef TOON_SLOPE_ROCK
    float toonN = normalize(vToonNormal).y;
    float rockEdge = 0.55 + (toonFbm(vToonWorldPos.xz * 0.3, 2) - 0.5) * 0.15;
    toonAlbedo = mix(toonAlbedo, uToonSlope, (1.0 - step(rockEdge, toonN)) * 0.85);
  #endif
  outgoingLight = toonLight(toonAlbedo, normalize(vToonNormal), 1.0, 3.0);
}
#include <opaque_fragment>`;

export interface ToonOptions {
  /**
   * Repaint steep faces with `uToonSlope` before lighting them — envpaint's
   * Terrain does this so a hillside reads as rock rather than tilted meadow.
   * The GROUND only: a prop has no slope to speak of.
   */
  slopeRock?: boolean;
}

/**
 * Chain the cel lighting onto a material. Idempotent.
 *
 * Works on MeshBasicMaterial, MeshStandardMaterial and MeshPhysicalMaterial
 * alike: all three declare `diffuseColor` and `outgoingLight` before
 * `#include <opaque_fragment>`, and `cameraPosition` comes from three's own
 * fragment prefix.
 */
export function applyToon(material: Material, opts: ToonOptions = {}): void {
  if (material.userData[TOON_FLAG] === true) return;
  material.userData[TOON_FLAG] = true;

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (
    shader: WebGLProgramParametersWithUniforms,
    renderer: WebGLRenderer,
  ): void => {
    // Whatever was already here runs FIRST: its own replacements still see
    // the untouched stock source, and this block wraps the result.
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, toonUniforms);
    if (opts.slopeRock === true) {
      shader.defines = { ...(shader.defines ?? {}), TOON_SLOPE_ROCK: '' };
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vToonWorldPos;\nvarying vec3 vToonNormal;',
      )
      .replace('#include <project_vertex>', `#include <project_vertex>${TOON_VERTEX_GLSL}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${TOON_LIGHTING_GLSL}`)
      .replace('#include <opaque_fragment>', TOON_OPAQUE_GLSL);
  };

  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = (): string =>
    `${previousKey()}${TOON_CACHE_SUFFIX}${opts.slopeRock === true ? '-slope' : ''}`;
}

/**
 * Turn the look on or off for EVERY toon-injected material at once — one
 * value write, no recompile, which is what lets the ghost panel's style select
 * be a side-by-side comparison.
 */
export function setToonEnabled(on: boolean): void {
  toonUniforms.uToonOn.value = on ? 1 : 0;
}

/**
 * Point the cel sun and set its colours. scene.ts calls this every frame with
 * the key light's live world direction, so the terminator swings with the sun
 * arc that src/world/environment.ts is already driving.
 */
export function setToonSun(dir: Vector3, color: Color, sky: Color): void {
  toonUniforms.uSunDir.value.copy(dir).normalize();
  toonUniforms.uSunColor.value.copy(color);
  toonUniforms.uSkyColor.value.copy(sky);
}
