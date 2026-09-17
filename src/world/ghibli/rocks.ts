/**
 * Stone — envpaint's `Rocks` material (src/elements/Rocks.js `_buildMaterial`)
 * as a drop-in for the scatter's `rockMaterial` on the `ghibli` style
 * (docs/TASTE.md §9, docs/ghibli-port.md).
 *
 * THREE THINGS MAKE A ROCK READ AS PAINTED STONE and they are all here: a
 * warm sun-bleached top, a cool blue-grey on the faces turned away from the
 * sun (hue, not just value — the same move the cel shadow makes), and a
 * hard-stepped voronoi fleck that reads as mineral rather than as noise.
 * Moss caps the up-facing part of a rock standing in grass, with a broken
 * hand-painted edge.
 *
 * WHAT THE PORT HAS TO CARRY THAT ENVPAINT'S DID NOT. This material replaces
 * a `MeshStandardMaterial` that the scatter had already injected its
 * per-instance shape variation into, so it has to do that itself or a field
 * of rocks becomes a field of identical rocks. `GG_VARIATION_GLSL`
 * (src/world/ghibli/shared.ts) is that block, copied from `scatter.ts`'s
 * `variationBeginGlsl` verbatim rather than imported — the scatter is another
 * delegate's file.
 *
 * TWO ATTRIBUTES ARE OPTIONAL. `aMoss` (0–1, how mossy this instance is) and
 * `aSeed` (fleck seed) are per-instance attributes the world does not
 * currently bake. A vertex attribute a geometry does not supply reads as the
 * generic default `(0, 0, 0, 1)` in WebGL, so a rock with neither is simply
 * unmossed stone with its fleck seeded from `aVariation.w` — which the
 * scatter DOES bake. Nothing to wire on day one; the moss channel is there
 * for whoever wants a rock to green up in a meadow.
 *
 * No `uGrain` (TASTE §2.7), no shadow map (TASTE §2.4) — `toonLight` takes a
 * constant 1.0 and the flat stamps are the cast shadows.
 */

import { Color, ShaderMaterial } from 'three';
import { GHIBLI } from '../../taste/tokens';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import { GG_VARIATION_GLSL, fbmMean, ggFloat } from './shared';

/** [D] Fleck strength — envpaint's own `speckle` default. */
const SPECKLE = 0.55;

function vertexGlsl(variation: boolean): string {
  return /* glsl */ `
${TOON_VARYINGS_GLSL}
${variation ? GG_VARIATION_GLSL : ''}
${variation ? 'attribute vec4 aVariation;' : ''}
attribute float aMoss;
attribute float aSeed;

varying float vMoss;
varying float vSeed;
varying vec3 vObjPos;

void main() {
  vec3 pos = position;
  ${variation ? 'pos = ggVariation(pos, aVariation);' : ''}
  vObjPos = pos;
  vMoss = aMoss;
  // aSeed is optional (reads 0 when unbaked); the scatter's per-instance
  // variation always carries a usable one in its w channel.
  vSeed = aSeed${variation ? ' + aVariation.w * 37.0' : ''};

  vec4 local = vec4(pos, 1.0);
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

uniform vec3 uRock;
uniform vec3 uWarm;
uniform vec3 uCool;
uniform vec3 uMoss;
uniform float uSpeckle;

varying float vMoss;
varying float vSeed;
varying vec3 vObjPos;

// Distance to the nearest feature point of a jittered grid: the speckle of
// the reference rock's voronoi layer. toonHash21 comes from the shared toon
// chunk — no second hash in this shader.
float ggVoronoiF1(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float best = 1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = vec2(toonHash21(cell + g), toonHash21(cell + g + 91.7));
      best = min(best, length(g + o - f));
    }
  }
  return clamp(best, 0.0, 1.0);
}

void main() {
  // How coarsely this fragment samples the world — first line, raw varying,
  // outside every branch, because a derivative is undefined in non-uniform
  // control flow (src/world/toon.ts toonUnitsPerPxAt). A scattered rock is a
  // few pixels across at the zoom floor, so its own marks go past nyquist
  // long before the ground's do.
  toonMeasurePixel(vToonWorldPos.xz);
  vec3 n = normalize(vToonNormal);

  // Warm, sun-bleached top; cool blue-grey on the faces turned away.
  float up = smoothstep(0.0, 0.85, n.y);
  vec3 albedo = mix(uRock, uWarm, up * 0.7);
  float away = 1.0 - smoothstep(-0.25, 0.30, dot(n, uSunDir));
  albedo = mix(albedo, uCool, away * 0.7);

  // Cellular speckle, hard-stepped so it reads as painted flecks.
  float cell = ggVoronoiF1(vObjPos.xz * 4.5 + vObjPos.y * 3.0 + vSeed);
  float fleck = step(0.42, cell);
  albedo *= mix(1.0, 0.90 + 0.20 * fleck + 0.06 * cell, uSpeckle);

  // Moss caps the up-facing part of a rock standing in grass, with a broken,
  // hand-painted edge.
  // Band-limited at its own 2.5 cycles a world unit, fading to its 3-octave
  // MEAN (2026-09-17): a rock a few pixels across cannot show a broken edge,
  // and past nyquist the step below flips per pixel instead. At the mean the
  // cap keeps the average reach it was drawn with and simply stops being
  // ragged (src/world/ghibli/shared.ts fbmMean).
  float mossEdge = mix(${ggFloat(fbmMean(3))}, toonFbm(vToonWorldPos.xz * 2.5, 3),
    toonBandLimit(2.5));
  float moss = step(0.5, vMoss * smoothstep(0.2, 0.7, n.y) * (0.55 + 0.95 * mossEdge));
  albedo = mix(albedo, uMoss, moss * 0.9);

  vec3 col = toonLight(albedo, n, 1.0, 3.0);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface RockMaterialOptions {
  /**
   * Apply the scatter's per-instance shape variation from `aVariation`.
   * Default true — every scatter instance carries the attribute, and a
   * material that ignored it would flatten the field into clones.
   */
  variation?: boolean;
  /** Fleck strength, 0–1. */
  speckle?: number;
}

/**
 * The rock material. One per swap: it holds its own uniforms, but shares
 * `toonUniforms` by reference, so the cel sun still swings it with everything
 * else in the frame.
 */
export function createRockMaterial(opts: RockMaterialOptions = {}): ShaderMaterial {
  const variation = opts.variation !== false;
  return new ShaderMaterial({
    name: 'ghibli-rock',
    uniforms: {
      ...toonUniforms,
      uRock: { value: new Color(GHIBLI.rockBody) },
      uWarm: { value: new Color(GHIBLI.rockWarm) },
      uCool: { value: new Color(GHIBLI.rockCool) },
      uMoss: { value: new Color(GHIBLI.moss) },
      uSpeckle: { value: opts.speckle ?? SPECKLE },
    },
    vertexShader: vertexGlsl(variation),
    fragmentShader: FRAGMENT,
  });
}
