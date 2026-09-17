/**
 * Clouds — envpaint's `Clouds` material (src/elements/Clouds.js) as a drop-in
 * for the scatter's `cloudMaterial` on the `ghibli` style (docs/TASTE.md §9,
 * docs/ghibli-port.md).
 *
 * Two tones and a soft underside: white where the sun reaches, a cool
 * blue-grey belly, and the band between them broken by a low-frequency
 * mottle so the edge is not a clean sphere line. Double-sided, because a
 * cloud is read from underneath.
 *
 * THE HEIGHT FRACTION. envpaint bakes an `aH` attribute — where a vertex
 * sits inside its own cloud blob, 0 at the belly and 1 at the crown — and
 * the whole look hangs off it. This world's clouds are inflated props with no
 * such attribute, so `vH` is derived from the OBJECT-space height,
 * `clamp(position.y / uCloudSpan + 0.5, 0, 1)`: the props are modelled
 * centred on their own origin, so half a span above centre is the crown and
 * half below is the belly. `uCloudSpan` is per material — the kind's typical
 * vertical extent in object units — not per instance, so a cloud much taller
 * than the span shades slightly flatter than one at it. Stated here rather
 * than hidden: it is the same class of approximation as the canopy's blob
 * normal (src/world/ghibli/trees.ts).
 *
 * DRIFT, NOT SWAY. The wind block is the scatter's CLOUD profile, copied:
 * a constant displacement factor, so the gust moves the whole form sideways
 * in world units instead of leaning it, and the SMOOTH two-octave noise
 * rather than the gust-front field. That split is deliberate and
 * `src/world/scatter.ts` argues it: a sharpened front on a position reads as
 * a shove and a stop, and both are forbidden at confidence 1.00 (TASTE §2.1).
 * A cloud crosses its own width over minutes and never arrests.
 */

import { Color, DoubleSide, ShaderMaterial } from 'three';
import { GHIBLI } from '../../taste/tokens';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import {
  GG_VARIATION_GLSL,
  GG_WIND_NOISE_GLSL,
  createWindUniforms,
  fbmMean,
  ggFloat,
} from './shared';

/** The scatter's `WIND_PROFILE_CLOUD`, mirrored. World units, not radians —
 * the displacement factor is a constant, so `bend` and `flutter` are a
 * distance. */
const CLOUD = {
  bend: 0.85,
  gustHz: 0.09,
  flutter: 0.34,
  flutterHz: 0.04,
  phaseJitter: 3.4,
};

/** [D] A cloud prop's typical vertical extent, object units (see the header). */
const CLOUD_SPAN = 4;

const VERTEX = /* glsl */ `
${TOON_VARYINGS_GLSL}
${GG_WIND_NOISE_GLSL}
${GG_VARIATION_GLSL}

attribute vec4 aVariation;

uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindGust;
uniform float uCloudSpan;

varying float vH;

void main() {
  vec3 transformed = ggVariation(position, aVariation);
  vH = clamp(transformed.y / max(uCloudSpan, 1e-4) + 0.5, 0.0, 1.0);
  vec3 nrm = normal;

  // ── drift (copied from scatter.ts's windBeginGlsl, cloud profile) ────────
  #ifdef USE_INSTANCING
  vec2 windCell = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  mat3 windRot = mat3(instanceMatrix);
  float windS2 = max(dot(windRot[0], windRot[0]), 1e-6);
  #else
  vec2 windCell = vec2(0.0);
  mat3 windRot = mat3(1.0);
  float windS2 = 1.0;
  #endif
  float windPhase = dot(windCell, uWindDir) * -0.05
    + ggWindHash(dot(windCell, vec2(127.1, 311.7))) * ${ggFloat(CLOUD.phaseJitter)};
  float windT = uWindTime * ${ggFloat(CLOUD.gustHz)} + windPhase;
  float windGust = 0.72 * ggWindNoise(windT, 17.3) + 0.28 * ggWindNoise(windT * 2.3 + 5.1, 29.7);
  float windBend = ${ggFloat(CLOUD.bend)} * uWindStrength * (0.45 + 0.55 * windGust);
  float windFlut = ${ggFloat(CLOUD.flutter)} * uWindStrength
    * ggWindNoise(uWindTime * ${ggFloat(CLOUD.flutterHz)} + windPhase * 1.7, 47.9);
  vec2 windLean = uWindDir * windBend + vec2(-uWindDir.y, uWindDir.x) * windFlut;
  // The factor is a CONSTANT: the whole form drifts, nothing leans.
  transformed += (vec3(windLean.x, 0.0, windLean.y) * windRot) * inversesqrt(windS2);

  vec4 local = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
  vec4 world = modelMatrix * local;
  vToonWorldPos = world.xyz;
  vToonNormal = normalize(mat3(modelMatrix) * nrm);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */ `
${TOON_LIGHTING_GLSL}

uniform float uWindTime;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;

varying float vH;

void main() {
  // How coarsely this fragment samples the world — first line, raw varying,
  // outside every branch (src/world/toon.ts toonUnitsPerPxAt).
  toonMeasurePixel(vToonWorldPos.xz);
  vec3 n = normalize(vToonNormal) * (gl_FrontFacing ? 1.0 : -1.0);

  // Lumpy break-up so the band edge on the underside is not a clean sphere
  // line. It drifts with the wind clock, so the belly never fully arrests.
  // Band-limited at its own 0.24 cycles a world unit, fading to its 3-octave
  // MEAN (2026-09-17): it moves the belly's band EDGE, which is the term that
  // shows worst past nyquist — neighbouring pixels land on opposite sides of
  // a hard two-tone step — and at the mean the underside keeps the average
  // band it was drawn with.
  float mottle = mix(${ggFloat(fbmMean(3))},
    toonFbm(vToonWorldPos.xz * 0.24 + vec2(uWindTime * 0.02), 3),
    toonBandLimit(0.24));
  float belly = 1.0 - smoothstep(0.12, 0.78, vH + (mottle - 0.5) * 0.28);

  vec3 albedo = mix(uCloudLit, uCloudShade, belly * 0.85);
  vec3 col = toonLight(albedo, n, 1.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface CloudMaterialOptions {
  /** A cloud prop's vertical extent in object units (see the header). */
  cloudSpan?: number;
}

/**
 * The cloud material. Shares `toonUniforms` by reference; its wind uniforms
 * are written once a frame with `setWindOnMaterial`
 * (src/world/ghibli/shared.ts).
 */
export function createCloudMaterial(opts: CloudMaterialOptions = {}): ShaderMaterial {
  return new ShaderMaterial({
    name: 'ghibli-cloud',
    uniforms: {
      ...toonUniforms,
      ...createWindUniforms(),
      uCloudSpan: { value: opts.cloudSpan ?? CLOUD_SPAN },
      uCloudLit: { value: new Color(GHIBLI.cloudLit) },
      uCloudShade: { value: new Color(GHIBLI.cloudShade) },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: DoubleSide,
  });
}
