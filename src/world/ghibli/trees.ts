/**
 * The canopy — envpaint's `Trees` material (src/elements/Trees.js
 * `_buildMaterial`) as a drop-in for the scatter's `swayMaterial` /
 * `palmMaterial` on the `ghibli` style (docs/TASTE.md §9,
 * docs/ghibli-port.md).
 *
 * The read it exists for: foliage blocked in as THREE FLAT BANDS up the
 * crown, the way a cel painter blocks in a tree, broken along their edges by
 * a low-frequency noise so the bands are painted rather than ruled; a warm
 * dab where a facet points straight at the sun; a per-tree hue drift from
 * cool blue-green to warm yellow-green so a copse is not one colour; and the
 * trunk under it all.
 *
 * THE BLOB NORMAL — the one approximation in this file, stated plainly.
 * envpaint bakes an `aBlobN` attribute per vertex: the direction from the
 * crown blob's own centre out through that vertex, which it then mixes 0.72
 * with the facet normal so the cel bands land as big coherent shapes instead
 * of one speckle per facet. This world's crowns come out of the inflate
 * pipeline (`src/inflate/`) and carry no such attribute, and baking one is a
 * change to geometry another delegate owns. So the direction is
 * APPROXIMATED as `normalize(position - vec3(0.0, uCrownY, 0.0))` — outward
 * from a point on the trunk axis at `uCrownY` — and mixed 0.72 with the
 * vertex normal exactly as the reference does, on the canopy only. It is
 * right for a roughly radial crown and wrong for a long horizontal branch,
 * where it biases the normal outward from the axis; the visible cost is that
 * a branch tip bands slightly more like a sphere than like a branch. `uCrownY`
 * is per MATERIAL, not per instance — one number for the kind, set from the
 * crown's centroid height in the geometry's own object space.
 *
 * WIND. `windBeginGlsl`'s block, copied from `src/world/scatter.ts` (the
 * sway profile: bend 0.05, gust 0.38 Hz on the gust-front field, flutter
 * 0.016 at 0.7 Hz, phase jitter 1.6) rather than imported — the scatter is
 * another delegate's file, and this material must carry everything the
 * `MeshStandardMaterial` it replaces was carrying: the per-instance
 * variation, the height-weighted sway, AND the `aBend` tree-recoil channel
 * that `src/world/rocks.ts`'s ζ=1 angular spring writes when a creature
 * walks into a trunk.
 */

import { Color, DoubleSide, ShaderMaterial } from 'three';
import { GHIBLI } from '../../taste/tokens';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import { WIND_FIELD_GLSL } from '../wind';
import {
  GG_VARIATION_GLSL,
  GG_WIND_NOISE_GLSL,
  createWindUniforms,
  fbmMean,
  ggFloat,
} from './shared';

/** The scatter's `WIND_PROFILE_SWAY`, mirrored (see the header). */
const SWAY = {
  bend: 0.05,
  gustHz: 0.38,
  flutter: 0.016,
  flutterHz: 0.7,
  phaseJitter: 1.6,
};

/** The palm profile, for the kind that carries the strongest sway. */
const PALM = {
  bend: 0.11,
  gustHz: 0.45,
  flutter: 0.045,
  flutterHz: 0.9,
  phaseJitter: 1.9,
};

/** Cacti: barely — but the stillness floor never lets one freeze. */
const CACTUS = {
  bend: 0.008,
  gustHz: 0.3,
  flutter: 0.003,
  flutterHz: 0.5,
  phaseJitter: 1.2,
};

export type CanopyProfile = 'sway' | 'palm' | 'cactus';

const PROFILES: Record<CanopyProfile, typeof SWAY> = {
  sway: SWAY,
  palm: PALM,
  cactus: CACTUS,
};

/** [D] Height fraction below which a vertex is trunk, not canopy. */
const TRUNK_LINE = 0.42;
/** [D] Crown centre on the trunk axis, object units — see the header. */
const CROWN_Y = 1.6;

function vertexGlsl(profile: typeof SWAY): string {
  return /* glsl */ `
${TOON_VARYINGS_GLSL}
${WIND_FIELD_GLSL}
${GG_WIND_NOISE_GLSL}
${GG_VARIATION_GLSL}

attribute vec4 aVariation;
attribute float aWindHeight;
attribute vec2 aBend;

uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindGust;
uniform float uTrunkLine;
uniform float uCrownY;

varying float vCanopy;
varying float vH;
varying float vVar;

void main() {
  // Per-instance shape variation FIRST, in object space, exactly as the
  // scatter's chain does it (shared.ts ggVariation).
  vec3 transformed = ggVariation(position, aVariation);

  vH = clamp(aWindHeight, 0.0, 1.0);
  // Cel-hard trunk/canopy split, with just enough softness not to alias.
  vCanopy = smoothstep(uTrunkLine - 0.02, uTrunkLine + 0.02, vH);
  vVar = aVariation.w;

  // The crown's outward direction, approximated from the trunk axis (header),
  // mixed into the facet normal on the canopy only.
  vec3 blobN = normalize(transformed - vec3(0.0, uCrownY, 0.0) + vec3(1e-5));
  vec3 nrm = mix(normal, normalize(mix(normal, blobN, 0.72)), vCanopy);

  // ── wind (copied from scatter.ts's windBeginGlsl; see the header) ────────
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
    + ggWindHash(dot(windCell, vec2(127.1, 311.7))) * ${ggFloat(profile.phaseJitter)};
  float windGust = length(refWindAt(windCell, uWindTime * ${ggFloat(profile.gustHz)},
    uWindDir, 1.0, uWindGust)) * 2.0 - 1.0;
  float windBend = ${ggFloat(profile.bend)} * uWindStrength * (0.45 + 0.55 * windGust);
  float windFlut = ${ggFloat(profile.flutter)} * uWindStrength
    * ggWindNoise(uWindTime * ${ggFloat(profile.flutterHz)} + windPhase * 1.7, 47.9);
  vec2 windLean = uWindDir * windBend + vec2(-uWindDir.y, uWindDir.x) * windFlut;
  float windFactor = aWindHeight * transformed.y;
  vec3 windWorld = vec3(windLean.x, 0.0, windLean.y) * windFactor;
  // Tree recoil (src/world/rocks.ts): a per-instance world-axis lean from a
  // ζ=1 angular spring, riding the same height factor as the wind.
  windWorld += vec3(aBend.x, 0.0, aBend.y) * windFactor;
  transformed += (windWorld * windRot) * inversesqrt(windS2);

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
}

const FRAGMENT = /* glsl */ `
${TOON_LIGHTING_GLSL}

uniform vec3 uTrunk;
uniform vec3 uCanopyDark;
uniform vec3 uCanopyLight;
uniform vec3 uHighlight;

varying float vCanopy;
varying float vH;
varying float vVar;

void main() {
  // How coarsely this fragment samples the world — first line, raw varying,
  // outside every branch (src/world/toon.ts toonUnitsPerPxAt). A canopy at
  // the zoom floor is a handful of pixels, and a walking creature's
  // zoomed-out frame is full of them.
  toonMeasurePixel(vToonWorldPos.xz);
  vec3 n = normalize(vToonNormal);

  // Vertical canopy gradient, broken up by noise then quantised into three
  // flat bands the way cel painters block in foliage.
  // The break-up is band-limited at its own 1.6 cycles a world unit and fades
  // to its 2-octave MEAN, not to zero (2026-09-17): the quantise below is a
  // floor(), so a wobble sampled past nyquist throws neighbouring pixels into
  // different bands, and at zero the whole canopy would STEP to a different
  // band rather than settle on the one it averages to.
  float t = smoothstep(0.35, 1.0, vH)
    + (mix(${ggFloat(fbmMean(2))}, toonFbm(vToonWorldPos.xz * 1.6, 2), toonBandLimit(1.6))
      - 0.5) * 0.35;
  float q = clamp(floor(clamp(t, 0.0, 1.0) * 3.0) / 2.0, 0.0, 1.0);
  vec3 canopy = mix(uCanopyDark, uCanopyLight, q);

  // Per-tree hue drift: cool blue-green through warm yellow-green.
  canopy *= mix(vec3(0.86, 1.02, 0.94), vec3(1.12, 0.99, 0.78), vVar);

  vec3 albedo = mix(uTrunk * (0.85 + 0.3 * vVar), canopy, vCanopy);

  // Hard warm dab where a facet points straight at the sun.
  float hi = step(0.82, dot(n, uSunDir)) * vCanopy;
  albedo = mix(albedo, uHighlight, hi * 0.5);

  vec3 col = toonLight(albedo, n, 1.0, 3.0);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface CanopyMaterialOptions {
  /** Which wind profile — the scatter's three rooted recipes. */
  profile?: CanopyProfile;
  /** Height fraction below which a vertex takes the trunk colour. */
  trunkLine?: number;
  /** Crown centre height on the trunk axis, object units (see the header). */
  crownY?: number;
  /** Thin frond blades want both faces drawn (the palms do). */
  doubleSide?: boolean;
}

/**
 * The canopy material. Shares `toonUniforms` by reference; owns its own wind
 * uniforms, which the caller writes once a frame with the SAME field the
 * scatter is drawing (`setWindOnMaterial`, src/world/ghibli/shared.ts).
 */
export function createCanopyMaterial(opts: CanopyMaterialOptions = {}): ShaderMaterial {
  const profile = PROFILES[opts.profile ?? 'sway'];
  const material = new ShaderMaterial({
    name: 'ghibli-canopy',
    uniforms: {
      ...toonUniforms,
      ...createWindUniforms(),
      uTrunkLine: { value: opts.trunkLine ?? TRUNK_LINE },
      uCrownY: { value: opts.crownY ?? CROWN_Y },
      uTrunk: { value: new Color(GHIBLI.trunk) },
      uCanopyDark: { value: new Color(GHIBLI.canopyShade) },
      uCanopyLight: { value: new Color(GHIBLI.canopyLight) },
      uHighlight: { value: new Color(GHIBLI.canopyHighlight) },
    },
    vertexShader: vertexGlsl(profile),
    fragmentShader: FRAGMENT,
  });
  if (opts.doubleSide === true) material.side = DoubleSide;
  return material;
}
