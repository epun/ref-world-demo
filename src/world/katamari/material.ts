/**
 * The katamari prop look: a PS2 baked texture read as flat hand-painted cel
 * fills (user ask, 2026-09-15: *"in a Ghibli-style toon shader that feels
 * hand-painted but also very Japanese anime"*).
 *
 * THE PROBLEM THIS SOLVES. The library's albedo is a 32–64 px baked texture
 * drawn for a console that filtered it to mush. Sampled at nearest, as
 * extracted, it reads as PIXELS — and pixels are the one thing this taste has
 * no room for: the frame is contoured ink and flat fills (TASTE §2.5, §9). So
 * the sample is POSTERISED: each channel quantised to `uLevels` steps (5 by
 * default **[D]** — enough to keep a roof apart from its wall, few enough that
 * a gradient collapses into bands), then nudged warm toward the sun colour.
 * What survives is the texture's SHAPE — the windows, the door, the fish
 * painted on the gable — as a handful of flat poster colours, which is exactly
 * how a cel background paints a building.
 *
 * ON TOP OF THAT, the world's own cel lighting: `toonLight` from
 * `src/world/toon.ts`, called with shadow 1.0 and three bands, the same call
 * every ghibli element makes. Two flat tones, a cool hue-shifted shade, a
 * painted terminator, and a hard warm dab where a facet points straight at the
 * sun — envpaint's tree-highlight rule, which is what makes a mass read as
 * painted rather than shaded.
 *
 * NO GRAIN, NO SHADOW MAP, NO OUTLINE. All three for the reasons
 * `src/world/toon.ts` sets out: grain is a full-frame post-process (TASTE
 * §2.7), the flat stamps are the cast shadows (TASTE §2.4), and the contour is
 * the world's ink pass — `src/world/ink.ts` draws it off the normal/depth
 * targets and this material has nothing to do about it.
 *
 * WHY `TOON_NOISE_GLSL` IS NOT PASTED HERE. `TOON_LIGHTING_GLSL` already
 * contains it; concatenating both would declare `toonHash21` twice, which is a
 * compile error and the exact class of bug `test/world/katamari/material.test.ts`
 * scans for.
 *
 * DROP-IN FOR AN INSTANCED SCATTER. A katamari variant is drawn by the
 * scatter's existing `InstancedMesh` path, so this material carries what the
 * `MeshStandardMaterial` it replaces was carrying: `aVariation` through
 * `ggVariation` (imported from `src/world/ghibli/shared.ts` rather than copied
 * again — one definition, in lockstep with `applyInstanceVariation` on the cpu
 * side) and a drift that never lets a prop fully arrest (TASTE §2.1). The
 * drift rides `ggWindNoise`, the smooth field, and reads its height fraction
 * off the geometry's own `uHeight` rather than the scatter's `aWindHeight`
 * attribute — which rigid kinds deliberately never get.
 *
 * ONE MATERIAL PER TEXTURE. `createKatamariMaterialSet` shares a material
 * across every model with the same texture, alpha mode and culling, so 82
 * models are 82 draw calls and not 82 compiles of the same program.
 */

import { Color, DoubleSide, FrontSide, ShaderMaterial, Vector2 } from 'three';
import type { Texture } from 'three';
import { GHIBLI } from '../../taste/tokens';
import {
  GG_VARIATION_GLSL,
  GG_WIND_NOISE_GLSL,
  createWindUniforms,
  ggFloat,
} from '../ghibli/shared';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import type { KatamariAlphaMode, KatamariLibrary, KatamariModel } from './models';

/** Posterisation steps per channel. [D] — see the header. */
export const KATAMARI_LEVELS = 5;

/** How far the posterised albedo is pulled toward the sun colour. [D] */
const WARMTH = 0.12;

/** n·l past which a facet takes the hard sun dab, and how strong it is. [D]
 * Mirrors the canopy's `step(0.82, ...)` in `src/world/ghibli/trees.ts`. */
const DAB_EDGE = 0.82;
const DAB = 0.35;

/** The drift floor: nothing in this world fully arrests (TASTE §2.1). [D] —
 * a hair under the canopy's flutter, because a vending machine is not a
 * branch. The wiring plan raises it for foliage. */
const DRIFT = 0.006;
const DRIFT_HZ = 0.24;

/**
 * The drift and the per-instance variation. `uHeight` is the model's own
 * normalised height, so the drift is height-weighted without the scatter's
 * `aWindHeight` attribute.
 */
function vertexGlsl(drift: number): string {
  return /* glsl */ `
${TOON_VARYINGS_GLSL}
${GG_WIND_NOISE_GLSL}
${GG_VARIATION_GLSL}

attribute vec4 aVariation;

uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uHeight;

varying vec2 vKatUv;
varying float vKatVar;

void main() {
  vKatUv = uv;
  vKatVar = aVariation.w;

  vec3 transformed = ggVariation(position, aVariation);

  #ifdef USE_INSTANCING
  vec2 katCell = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  mat3 katRot = mat3(instanceMatrix);
  float katS2 = max(dot(katRot[0], katRot[0]), 1e-6);
  #else
  vec2 katCell = vec2(0.0);
  mat3 katRot = mat3(1.0);
  float katS2 = 1.0;
  #endif

  // The ambient drift floor: a slow lateral lean, never snapping, never
  // arresting. Height-weighted off the model's own height.
  float katPhase = ggWindHash(dot(katCell, vec2(127.1, 311.7))) * 6.2831853;
  float katDrift = ${ggFloat(drift)} * uWindStrength
    * ggWindNoise(uWindTime * ${ggFloat(DRIFT_HZ)} + katPhase, 31.7);
  float katFrac = clamp(transformed.y / max(uHeight, 1e-4), 0.0, 1.0);
  vec2 katLean = (uWindDir + vec2(-uWindDir.y, uWindDir.x) * 0.4) * katDrift;
  transformed += vec3(katLean.x, 0.0, katLean.y) * katFrac * transformed.y * katRot
    * inversesqrt(katS2);

  vec4 local = vec4(transformed, 1.0);
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
  vec4 world = modelMatrix * local;
  vToonWorldPos = world.xyz;
  vToonNormal = normalize(mat3(modelMatrix) * nrm);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
}

const FRAGMENT = /* glsl */ `
${TOON_LIGHTING_GLSL}

uniform sampler2D uAlbedo;
uniform float uLevels;
uniform float uWarmth;
uniform vec3 uWarm;
uniform float uDab;

varying vec2 vKatUv;
varying float vKatVar;

/** srgb -> linear, by hand: this is a raw ShaderMaterial, so three does no
 * decode for us and the posterise wants to happen in the space the texture
 * was painted in. */
vec3 katSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

/** Quantise each channel to uLevels flat steps — the whole point of the
 * file: a baked ps2 texel becomes a poster colour. */
vec3 katPosterize(vec3 c, float levels) {
  float steps = max(levels, 2.0);
  return clamp(floor(clamp(c, 0.0, 1.0) * steps) / (steps - 1.0), 0.0, 1.0);
}

void main() {
  vec4 texel = texture2D(uAlbedo, vKatUv);
  #ifdef KATAMARI_MASK
    if (texel.a < 0.5) discard;
  #endif

  // Posterise in the painted (srgb) space, then decode.
  vec3 albedo = katSrgbToLinear(katPosterize(texel.rgb, uLevels));
  // A slight warm shift toward the sun colour, and a touch of per-instance
  // drift so a row of the same model is not one flat colour.
  albedo = mix(albedo, albedo * uWarm, uWarmth * (0.7 + 0.6 * vKatVar));

  vec3 n = normalize(vToonNormal);
  // The hard warm dab on facets that point straight at the sun — envpaint's
  // tree-highlight rule, on built things too.
  float dab = step(${ggFloat(DAB_EDGE)}, dot(n, uSunDir));
  albedo = mix(albedo, uSunColor, dab * uDab);

  vec3 col = toonLight(albedo, n, 1.0, 3.0);
  gl_FragColor = vec4(col, texel.a);
  #include <colorspace_fragment>
}`;

export interface KatamariMaterialOptions {
  /** How the glb's material handled alpha. `mask` becomes a hard cutout,
   * `blend` a transparent draw; `opaque` is the default. */
  alphaMode?: KatamariAlphaMode;
  /** Draw both faces (the game's own culling flag, off by default). */
  doubleSide?: boolean;
  /** Posterisation steps per channel. */
  levels?: number;
  /** The model's normalised height, for the height-weighted drift. */
  height?: number;
  /** Drift amplitude — the wiring plan raises it for foliage. */
  drift?: number;
  /** Sun-dab strength. */
  dab?: number;
  /** A name for the debugger. */
  name?: string;
}

/**
 * One katamari material.
 *
 * Shares `toonUniforms` BY REFERENCE, so the ghost panel's style switch and
 * the once-a-frame sun write reach it with no recompile — the same contract
 * every module under `src/world/ghibli/` keeps. Owns its own wind uniforms,
 * which the caller writes with `setWindOnMaterial` from
 * `src/world/ghibli/shared.ts`.
 */
export function createKatamariMaterial(
  texture: Texture | null,
  opts: KatamariMaterialOptions = {},
): ShaderMaterial {
  const alphaMode = opts.alphaMode ?? 'opaque';
  const material = new ShaderMaterial({
    name: opts.name ?? 'katamari-prop',
    uniforms: {
      ...toonUniforms,
      ...createWindUniforms(),
      uAlbedo: { value: texture },
      uLevels: { value: opts.levels ?? KATAMARI_LEVELS },
      uWarmth: { value: WARMTH },
      uWarm: { value: new Color(GHIBLI.sun) },
      uDab: { value: opts.dab ?? DAB },
      uHeight: { value: opts.height ?? 1 },
    },
    vertexShader: vertexGlsl(opts.drift ?? DRIFT),
    fragmentShader: FRAGMENT,
    defines: alphaMode === 'mask' ? { KATAMARI_MASK: '' } : {},
  });
  material.side = opts.doubleSide === true ? DoubleSide : FrontSide;
  if (alphaMode === 'mask') {
    // A hard cutout at 0.5 — a leaf edge is a drawn edge, never a fade.
    material.alphaTest = 0.5;
    material.transparent = false;
  } else if (alphaMode === 'blend') {
    material.transparent = true;
    material.depthWrite = false;
  }
  // The wind uniforms start pointed somewhere legal even if nothing ever
  // writes them (a still frame still drifts).
  (material.uniforms.uWindDir!.value as Vector2).set(1, 0);
  return material;
}

export interface KatamariMaterialSet {
  /** The material a model draws with. */
  materialFor(model: KatamariModel): ShaderMaterial;
  /** Every distinct material, for the frame's wind write and disposal. */
  materials(): ShaderMaterial[];
  dispose(): void;
}

/**
 * One material per (texture, alpha mode, culling) — models that share a
 * texture share a program and a uniform set.
 *
 * `uHeight` differs per model and lives in a SHARED material, so it is set
 * from the tallest model on the material: the drift is a height-weighted
 * hair of lean, and a shorter model on the same texture leans a hair less
 * than it might. That is invisible, and it is the price of not compiling one
 * program per prop. Where it ever matters, ask for a material of your own.
 */
export function createKatamariMaterialSet(library: KatamariLibrary): KatamariMaterialSet {
  const byKey = new Map<string, ShaderMaterial>();
  const keyOf = (model: KatamariModel): string =>
    `${model.texture ? model.id : 'flat'}|${model.alphaMode}|${model.doubleSide ? 'two' : 'one'}`;
  for (const model of library.models) {
    const key = keyOf(model);
    const existing = byKey.get(key);
    if (existing) {
      const slot = existing.uniforms.uHeight!;
      slot.value = Math.max(slot.value as number, model.height);
      continue;
    }
    byKey.set(
      key,
      createKatamariMaterial(model.texture, {
        alphaMode: model.alphaMode,
        doubleSide: model.doubleSide,
        height: model.height,
        name: `katamari-${model.id}`,
      }),
    );
  }
  return {
    materialFor(model: KatamariModel): ShaderMaterial {
      const material = byKey.get(keyOf(model));
      if (!material) throw new Error(`no katamari material for ${model.id}`);
      return material;
    },
    materials(): ShaderMaterial[] {
      return [...byKey.values()];
    },
    dispose(): void {
      for (const material of byKey.values()) material.dispose();
      byKey.clear();
    },
  };
}
