/**
 * Water — the LAKE / RIVER branch of envpaint's surface shader
 * (src/elements/Water.js `_buildSurfaceMaterial`, plus
 * src/core/shaders/water.glsl.js) as a drop-in for the water's flat fill
 * material on the `ghibli` style (docs/TASTE.md §9, docs/ghibli-port.md).
 *
 * WHAT IT DRAWS: three flat blues by depth, a foam rim at the shore, a thin
 * wet line just inside it, and sparse hand-drawn wave glyphs breathing on the
 * surface and drifting along the flow. Every edge in it is a `step`, wobbled
 * by a low-frequency noise so it is painted rather than ruled — the same
 * discipline `src/world/ground.ts` keeps for its terrace lips.
 *
 * TWO MATERIALS, ONE SHADER. `createWaterSurfaceMaterial` is the lake and
 * pond fill; `createSeaSurfaceMaterial` is the same shader with the sea
 * colours and a slow surface DRIFT, for the tropical island the user asked
 * for (2026-09-15). Nothing else differs — a sea is a lake that goes on.
 *
 * THE SHORE DISTANCE IS AN ATTRIBUTE HERE. envpaint recovers it per fragment
 * from `depth / |∇depth|`, because it has a live depth field to differentiate.
 * This world's fills are flat polygons cut from an authored outline
 * (`src/world/water.ts`), so the distance to that outline is something the
 * CALLER can bake once, per vertex, into `aShore` — cheaper, stabler under a
 * zoom, and it needs no derivatives. The depth proxy is that same distance
 * scaled by `uDepthScale`: a body shelves from its rim, so how far you are
 * from the shore is how deep you are, near enough for three flat bands.
 *
 * NO RIPPLE SIM. envpaint runs a height-field sim into a render target and
 * reads it here for rain rings and rock impacts. That is deferred
 * (docs/ghibli-port.md), and `uRippleTex` stays in the shader bound to a 1×1
 * flat texel so the sim can land later without touching this file: the two
 * `step`s that read it are simply always false.
 *
 * NO SHADOW MAP, NO GRAIN — as everywhere in this folder (TASTE §2.4, §2.7).
 */

import { Color, DoubleSide, ShaderMaterial, Vector2, type Texture } from 'three';
import { GHIBLI } from '../../taste/tokens';
import { PAINTED_SIZE } from '../painted';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import { WIND_FIELD_GLSL } from '../wind';
import { createWindUniforms, emptyLayerTexture, ggFloat } from './shared';

/**
 * [D] World units of depth per world unit of distance from the shore. A
 * painted pond shelves gently; 0.22 puts the `uDeep` band about five units
 * out, which is where the reference's own bands land on a lake that size.
 */
const DEPTH_SCALE = 0.22;

/** [D] How fast the glyph field is carried along the flow, and how fast it
 * breathes. Slow: a still surface, not a rapid. */
const ADVECT = 0.14;
const BREATHE = 0.14;

/** [D] Surface drift for the sea, as a fraction of the wind push. The sea
 * moves because the wind does; it never snaps and never arrests (TASTE §2.1). */
const SEA_DRIFT = 0.35;

const VERTEX = /* glsl */ `
${TOON_VARYINGS_GLSL}

attribute float aShore;

varying float vShore;

void main() {
  vShore = aShore;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vToonWorldPos = world.xyz;
  // A fill is one flat plane: its normal is up, and the cel ramp reads it as
  // one tone across the whole body — which is the look.
  vToonNormal = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */ `
const float GG_SIZE = ${ggFloat(PAINTED_SIZE)};
${TOON_LIGHTING_GLSL}
${WIND_FIELD_GLSL}

uniform sampler2D uRippleTex;
uniform float uRippleVis;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uWet;
uniform vec3 uHighlight;
uniform float uDepthScale;
uniform float uHighlightAmount;
uniform vec2 uFlowDir;
uniform float uDrift;

uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindGust;

varying float vShore;

void main() {
  vec2 p = vToonWorldPos.xz;
  vec2 uv = p / GG_SIZE + 0.5;
  vec3 n = normalize(vToonNormal);

  // Distance to the shoreline (baked per vertex), and the depth it stands in.
  float shore = max(vShore, 0.0);
  float depth = shore * uDepthScale;

  // The direction the surface is going: the authored flow, nudged by the
  // world's own wind on a still body, and driven by it on the open sea.
  vec2 drift = refWindAt(p, uWindTime * 0.18, uWindDir, uWindStrength, uWindGust);
  vec2 flowVec = uFlowDir + drift * uDrift;
  float flowLen = length(flowVec);
  vec2 dir = flowLen > 1e-4 ? flowVec / flowLen : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  // Low-frequency wobble: every edge below is hard, but not a clean arc.
  float wob = toonFbm(p * 0.9, 2) - 0.5;
  // The shore foam wobbles ALONG the flow, so its edge crawls downstream.
  float wobF = toonFbm(p * 0.9 - dir * (uWindTime * ${ggFloat(ADVECT)} * 0.5), 2) - 0.5;

  // Three flat blues, a shallow band, a wet line and the foam rim.
  vec3 albedo = uMid;
  albedo = mix(albedo, uDeep, step(1.2 + wob * 0.35, depth));
  float shallowBand = step(0.30 + wob * 0.05, shore) * (1.0 - step(0.75 + wob * 0.12, shore));
  albedo = mix(albedo, uShallow, shallowBand);
  float wetBand = step(0.22 + wobF * 0.05, shore) * (1.0 - step(0.30 + wobF * 0.05, shore));
  albedo = mix(albedo, uWet, wetBand);
  float foam = 1.0 - step(0.22 + wobF * 0.07, shore);

  // Rain rings and rock impacts. Flat at rest (a 1×1 texel) until the sim
  // lands — see the header.
  float rip = texture2D(uRippleTex, uv).r * uRippleVis;
  albedo = mix(albedo, uShallow, step(0.30, rip));
  albedo = mix(albedo, uFoam, step(0.62, rip));

  // Hand-drawn wave glyphs: sparse, big, rounded, slowly breathing, carried
  // along the flow. toonFbm sums to at most 0.75 over two octaves, so the
  // glyph window is normalised the way the reference normalises it.
  float along = (dot(p, dir) - uWindTime * ${ggFloat(ADVECT)}) * 0.35;
  float across = dot(p, perp) * 2.4;
  float glyph = toonFbm(vec2(along, across), 2) * 1.3333;
  float breathe = toonFbm(vec2(along * 0.24 + uWindTime * ${ggFloat(BREATHE)}, across * 0.05), 2)
    * 1.3333 - 0.5;
  float lo = 0.75 - 0.12 * uHighlightAmount + breathe * 0.05;
  float hl = step(lo, glyph) * (1.0 - step(lo + 0.06, glyph));
  hl *= step(0.20, depth) * step(0.45, shore);
  albedo = mix(albedo, uHighlight, hl);

  albedo = mix(albedo, uFoam, clamp(foam, 0.0, 1.0));

  // Flat fills only: one two-band ramp on the surface normal, no per-pixel
  // normal shading and no glint.
  vec3 col = toonLight(albedo, n, 1.0, 2.0);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface WaterSurfaceOptions {
  /** World units of depth per unit of distance from the shore. */
  depthScale?: number;
  /** The authored flow direction, world xz. Zero on a still body. */
  flow?: { x: number; z: number };
  /** How much of the wind push drives the surface — the sea's own drift. */
  drift?: number;
  /** Glyph density, 0–1. */
  highlightAmount?: number;
  /** The ripple sim's target, when one exists. Deferred; see the header. */
  ripple?: Texture | null;
}

interface Palette {
  deep: string;
  mid: string;
  shallow: string;
}

function build(name: string, palette: Palette, opts: WaterSurfaceOptions): ShaderMaterial {
  const flat = emptyLayerTexture();
  const material = new ShaderMaterial({
    name,
    uniforms: {
      ...toonUniforms,
      ...createWindUniforms(),
      uRippleTex: { value: (opts.ripple ?? flat) as Texture },
      uRippleVis: { value: 5 },
      uDeep: { value: new Color(palette.deep) },
      uMid: { value: new Color(palette.mid) },
      uShallow: { value: new Color(palette.shallow) },
      uFoam: { value: new Color(GHIBLI.foam) },
      uWet: { value: new Color(GHIBLI.waterWet) },
      uHighlight: { value: new Color(GHIBLI.waterHighlight) },
      uDepthScale: { value: opts.depthScale ?? DEPTH_SCALE },
      uHighlightAmount: { value: opts.highlightAmount ?? 0.6 },
      uFlowDir: { value: new Vector2(opts.flow?.x ?? 0, opts.flow?.z ?? 0) },
      uDrift: { value: opts.drift ?? 0.12 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: DoubleSide,
  });
  // The rest texel belongs to the material: disposing one disposes the other.
  material.userData.restRipple = flat;
  return material;
}

/**
 * The lake / pond / river fill. Three flat blues from `GHIBLI.water*`.
 *
 * The caller bakes `aShore` on the fill geometry — distance from each vertex
 * to the body's outline, in world units (`src/world/water.ts` already holds
 * every outline it cut the fill from).
 */
export function createWaterSurfaceMaterial(opts: WaterSurfaceOptions = {}): ShaderMaterial {
  return build(
    'ghibli-water',
    { deep: GHIBLI.waterDeep, mid: GHIBLI.waterMid, shallow: GHIBLI.waterShallow },
    opts,
  );
}

/**
 * The open sea (2026-09-15, user ask: a tropical island). The same shader on
 * the sea colours, with the wind driving a slow surface drift — the glyphs
 * travel, the foam rim crawls, and nothing about it ever stops.
 */
export function createSeaSurfaceMaterial(opts: WaterSurfaceOptions = {}): ShaderMaterial {
  return build(
    'ghibli-sea',
    { deep: GHIBLI.seaDeep, mid: GHIBLI.waterMid, shallow: GHIBLI.seaShallow },
    { drift: SEA_DRIFT, ...opts },
  );
}
