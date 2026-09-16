/**
 * Wild flowers — envpaint's `Flowers` element (src/elements/Flowers.js) ported
 * the same way the blade field is. `ghibli` style only (docs/TASTE.md §9).
 *
 * One instanced mesh: a two-segment stem strip plus a four-vertex head quad
 * that billboards to the camera, with the five-petal rose cut out of it by an
 * `atan`/`cos` polar threshold in the fragment shader — so a bloom is a
 * painted shape, not a texture and not a cutout mesh.
 *
 * Same three adaptations as `src/world/ghibli/grass.ts`, for the same
 * reasons — read its header first:
 *
 *   - ground height comes from a `heightAt(x, z)` callback baked into
 *     `aGround` (the `Surface` seam owns y), re-bakeable with
 *     `rebuild(heightAt)`;
 *   - the authored map grows a LOW base density of flowers in the meadow
 *     through `uRegion` (region.ts), thinned on the beach, none in water,
 *     on top of whatever the `flowers` brush painted;
 *   - the wind is `refWindAt` on the scatter's four uniform names, with
 *     envpaint's derivative lead term dropped (past neutral is overshoot —
 *     TASTE §2.1).
 *
 * `uNeedGrass` is kept: wild flowers grow in the meadow, not on bare ground,
 * so a bloom needs either painted grass or the map's own meadow weight under
 * it. That is the one term that makes a painted flower patch look sown rather
 * than sprinkled.
 */

import {
  BufferAttribute,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector4,
  type Texture,
} from 'three';
import { GHIBLI } from '../../taste/tokens';
import { PAINTED_SIZE } from '../painted';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import { WIND_FIELD_GLSL, type WindField } from '../wind';
import { FIELD_REACH, GG_FIELD_GLSL, ggHeightGlsl, heightRes } from './height';
import { regionSize } from './region';
import {
  GG_WIND_NOISE_GLSL,
  createWindUniforms,
  emptyLayerTexture,
  ggFloat,
  mulberry32,
  restPressTexture,
  setWindUniforms,
} from './shared';

/** Segments along a stem; `(SEG + 1) * 2` vertices, then 4 for the head. */
const SEG = 2;

/** Tier counts [D] — envpaint's own default, and a quarter of it on a phone. */
export const FLOWER_COUNT_PROJECTION = 16000;
export const FLOWER_COUNT_PHONE = 4000;

/** The layout seed — envpaint's constant, so the port lays out its flowers
 * exactly where the reference does relative to its grid. */
const FLOWER_SEED = 0x5f356495;

/** Gust frequency, flutter and detune — softer than a blade on a stem. */
const GUST_HZ = 0.55;
const FLUTTER = 0.05;
const FLUTTER_HZ = 1.1;
const PHASE_JITTER = 2.0;

/**
 * [D] World units the window spans, by tier — the blade field's window and
 * this one are the same window (src/world/ghibli/grass.ts, the header there
 * explains why there is one at all).
 */
/**
 * The BLADE field's own reach (2026-09-15, user direction: *"cut the flower
 * span to the blade span"*) — blooms belong in the grass, so they thin out
 * with distance on the same radial curve the blades do
 * (src/world/ghibli/height.ts).
 */
export const FLOWER_SPAN_PROJECTION = FIELD_REACH * 2;
export const FLOWER_SPAN_PHONE = FIELD_REACH;

const DEFAULTS = {
  density: 1,
  /**
   * [D] How many flowers the MAP sows unpainted: a meadow is mostly grass.
   *
   * 0.03, down from envpaint's 0.18 (2026-09-15, user direction). At 0.18 over
   * the blade window the render came back with about twenty blooms a square
   * unit — *"polka dots on a lawn"* — and envpaint's own meadow has flowers
   * only where a brush put them. A few per ten square units, and the DRIFT
   * below gathers even those into patches, so the ground between them is
   * plainly grass. A painted `flowers` layer still blooms at full density.
   */
  baseDensity: 0.03,
  noiseScale: 0.3,
  noiseStrength: 0.5,
  stemHeight: 1.4,
  stemWidth: 0.035,
  headSize: 1,
  windResponse: 0.8,
  needGrass: 1,
  /** Bloom mix: mostly white, then yellow, pink, the occasional blue. */
  mix: new Vector4(0.35, 0.3, 0.2, 0.15),
  zoom: 14,
};

/**
 * Built at MATERIAL TIME, not at module time — see the same note on the blade
 * field's `vertexSource`: `GG_MAP_SIZE` and the height bake's span ride the
 * island's scale, which is decided after every module has been evaluated.
 */
const vertexSource = (): string => /* glsl */ `
const float GG_SIZE = ${ggFloat(PAINTED_SIZE)};
/** The ground field's square, which the geography bakes span — 800 units on
 * the doubled island where a painted layer is still 400 (see region.ts). */
const float GG_MAP_SIZE = ${ggFloat(regionSize())};
const float GG_TAU = 6.2831853;
${TOON_VARYINGS_GLSL}
${WIND_FIELD_GLSL}
${GG_WIND_NOISE_GLSL}
${ggHeightGlsl()}
${GG_FIELD_GLSL}

uniform sampler2D uFlowers;
uniform sampler2D uGrass;
uniform sampler2D uPress;
uniform sampler2D uRegion;

uniform float uDensity;
uniform float uBaseDensity;
uniform float uNoiseScale;
uniform float uNoiseStrength;
uniform float uStemHeight;
uniform float uStemWidth;
uniform float uHeadSize;
uniform float uWindResponse;
uniform float uNeedGrass;
uniform float uZoom;
uniform vec4 uMix;
uniform vec3 uWhite;
uniform vec3 uYellow;
uniform vec3 uPink;
uniform vec3 uBlue;
uniform vec3 uCentre;

uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindGust;

attribute vec2 aOffset;
attribute vec4 aRand;
attribute vec3 aVert;

varying vec4 vInfo;
varying vec3 vColor;
varying vec3 vCentreColor;

const vec2 GG_NOISE_SEED = vec2(31.7, 11.9);

void main() {
  // The window's centre lives in the shader (src/world/ghibli/grass.ts's
  // header explains why): everything below reads where the bloom IS.
  vec2 wpos = aOffset + uCenter;
  vec2 luv = wpos / GG_SIZE + 0.5;
  // The BAKE's own square (see GG_MAP_SIZE above).
  vec2 ruv = wpos / GG_MAP_SIZE + 0.5;

  float paint = texture2D(uFlowers, luv).r;
  float grassV = texture2D(uGrass, luv).r;
  vec3 region = texture2D(uRegion, ruv).rgb;
  float wet = step(0.95, region.b);

  // The map's blooms come in DRIFTS, not evenly (2026-09-15): a low-frequency
  // patch noise gates them, so a meadow has stretches of plain grass and
  // stretches with flowers in them. A painted layer is not gated — somebody
  // put those there.
  // windFbm sums to at most 0.75 over its octaves, so it is NORMALISED before
  // the threshold — at 0.52 on the raw value the gate was closed nearly
  // everywhere and the meadow came back with a dozen blooms in it (measured on
  // screen, 2026-09-15). Normalised, 0.55–0.72 keeps roughly a third of the
  // ground in bloom and leaves the rest plainly grass.
  float driftN = clamp(windFbm(luv * 8.0 + GG_NOISE_SEED, 3) * 1.3333, 0.0, 1.0);
  float drift = smoothstep(0.55, 0.72, driftN);
  float grow = max(paint, uBaseDensity * region.r * drift);
  grow *= 1.0 - 0.75 * region.g;
  grow *= 1.0 - wet;
  // The same radial LOD the blades ride: blooms thin with distance and stop
  // at the reach (src/world/ghibli/height.ts).
  float base = grow * uDensity * ggFieldDensity(wpos);
  // Wild flowers grow in the meadow, not on bare ground: painted grass under
  // the bloom, or the map's own meadow weight.
  base *= mix(1.0, step(0.15, max(grassV, region.r)), step(0.5, uNeedGrass));

  float p = 0.0;
  if (base > aRand.x) {
    float n = windFbm(luv * uNoiseScale * 40.0 + GG_NOISE_SEED, 4);
    p = base * mix(1.0, smoothstep(0.3, 0.8, n), uNoiseStrength);
  }

  vInfo = vec4(0.0);
  vColor = vec3(0.0);
  vCentreColor = vec3(0.0);
  vToonWorldPos = vec3(0.0);
  vToonNormal = vec3(0.0, 1.0, 0.0);

  if (p <= aRand.x) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float far = smoothstep(9.0, 22.0, uZoom);

  float bh = uStemHeight * mix(0.25, 0.6, aRand.z);
  // …and the same size fade at the rim, so a bloom out there is a smaller
  // bloom rather than the last one before a line.
  float windowFade = ggFieldHeight(wpos);
  bh *= windowFade;

  float phase = ggWindHash(dot(wpos, vec2(127.1, 311.7))) * ${ggFloat(PHASE_JITTER)};
  vec2 push = refWindAt(wpos, uWindTime * ${ggFloat(GUST_HZ)},
    uWindDir, uWindStrength, uWindGust);
  vec2 windV = push * uWindResponse;
  windV += vec2(-uWindDir.y, uWindDir.x) * (uWindStrength * ${ggFloat(FLUTTER)}
    * ggWindNoise(uWindTime * ${ggFloat(FLUTTER_HZ)} + phase * 1.7, 23.1) * uWindResponse);
  // A stem's own resting lean, hashed per flower so a patch is never a comb.
  vec2 bend2 = windV + vec2(cos(aRand.y * GG_TAU), sin(aRand.y * GG_TAU)) * 0.06;

  vec4 pr = texture2D(uPress, luv);
  vec2 pushDir = pr.rg * 2.0 - 1.0;
  float pressed = pr.b;
  bend2 += pushDir * pressed * 2.2;
  bh *= 1.0 - 0.6 * pressed;
  // Far away the stems all but vanish and only the coloured heads remain.
  bh *= 1.0 - 0.45 * far;

  float bendAmt = length(bend2);
  float part = aVert.z;
  // The head rides the tip, so its corner coordinate must not drive the curve.
  float t = part < 0.5 ? aVert.y : 1.0;

  vec3 tip = vec3(
    bend2.x * bh * t * t,
    bh * t * (1.0 - 0.3 * bendAmt * t * t),
    bend2.y * bh * t * t
  );

  // Billboard basis: the view matrix's right and up, so a head always faces
  // the camera.
  vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 upv = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));

  vec3 pos = tip;
  if (part < 0.5) {
    float width = uStemWidth * (1.0 - 0.5 * far);
    pos += right * aVert.x * width * 0.5;
  } else {
    // The rose fills ~0.72 of the quad, so widen it onto the asked-for bloom.
    // …and the bloom shrinks with the window fade too, so nothing is left
    // hovering over bare ground at the rim.
    float halfSize = uHeadSize * mix(0.14, 0.32, aRand.z) * 0.7 * windowFade;
    float a = aRand.y * GG_TAU;
    float ca = cos(a);
    float sa = sin(a);
    vec2 c = vec2(aVert.x * ca - aVert.y * sa, aVert.x * sa + aVert.y * ca);
    pos += (right * c.x + upv * c.y) * halfSize;
  }

  vec3 world = vec3(wpos.x, ggGroundAt(wpos), wpos.y) + pos;

  // Colour by weighted pick, so a meadow is mostly white with yellow, pink
  // and the occasional blue.
  vec4 w = max(uMix, vec4(0.0));
  float total = max(w.x + w.y + w.z + w.w, 1e-4);
  float pick = aRand.w * total;
  vec3 head = uWhite;
  vec3 centre = uCentre;
  if (pick >= w.x + w.y + w.z) {
    head = uBlue;
    centre = uWhite;
  } else if (pick >= w.x + w.y) {
    head = uPink;
  } else if (pick >= w.x) {
    head = uYellow;
  }
  head *= mix(0.96, 1.04, windHash21(wpos * 3.7));

  vInfo = vec4(aVert.xy, t, part);
  vColor = head;
  vCentreColor = centre;

  // Heads are lit as if facing the sky, so a whole bloom lands in one cel
  // band and the shade side of a hill cools all of its flowers together.
  vec3 nrm = normalize(vec3(0.0, 1.0, 0.0) + vec3(bend2.x, 0.0, bend2.y) * 0.25);

  vToonWorldPos = world;
  vToonNormal = nrm;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const FRAGMENT = /* glsl */ `
${TOON_LIGHTING_GLSL}

uniform vec3 uStem;
uniform float uZoom;

varying vec4 vInfo;
varying vec3 vColor;
varying vec3 vCentreColor;

void main() {
  vec3 n = normalize(vToonNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float far = smoothstep(9.0, 22.0, uZoom);

  vec3 col;
  if (vInfo.w < 0.5) {
    // Stem: flat green, darker where it meets the ground.
    col = uStem * mix(0.7, 1.0, smoothstep(0.0, 0.35, vInfo.z));
  } else {
    // Head: five rounded petals around a small eye, cut out of the quad.
    vec2 q = vInfo.xy;
    float r = length(q);
    float ang = atan(q.y, q.x);
    // Zoomed out the rose collapses to a disc, so a distant meadow speckles
    // instead of shimmering.
    float petal = mix(0.5 + 0.22 * cos(5.0 * ang), 0.64, far);
    if (r > petal) discard;

    col = vColor;
    col = mix(col, col * 0.8, step(petal - 0.14, r) * (1.0 - far));
    col = mix(vCentreColor, col, step(0.2, r));
  }

  vec3 lit = toonLight(col, n, 1.0, 1.0);
  gl_FragColor = vec4(lit, 1.0);
  #include <colorspace_fragment>
}`;

export interface FlowerLayers {
  /** The painted `flowers` weight layer. */
  flowers?: Texture | null;
  /** The painted `grass` layer — a bloom wants meadow under it. */
  grass?: Texture | null;
  /** The press layer. Deferred; see docs/ghibli-port.md. */
  press?: Texture | null;
}

export interface FlowerFieldOptions {
  count?: number;
  /** The baked ground (src/world/ghibli/height.ts). Absent means flat paper. */
  height?: Texture | null;
  region?: Texture | null;
  baseDensity?: number;
  /** World units the window spans. Defaults to the whole painted map. */
  span?: number;
  layers?: FlowerLayers;
}

export interface FlowerField {
  mesh: Mesh;
  material: ShaderMaterial;
  setLayers(layers: FlowerLayers): void;
  setRegion(region: Texture | null): void;
  setBaseDensity(value: number): void;
  /** Point the field at the baked ground — see `GrassField.setHeight`. */
  setHeight(height: Texture | null): void;
  /** Slide the window's centre: one uniform write, quantised to the layout's
   * own cell — see `GrassField.setCenter`, which this mirrors exactly. */
  setCenter(x: number, z: number): void;
  /** Where the window is centred, world x/z — quantised, as applied. */
  center(): { x: number; z: number };
  setCount(count: number): void;
  count(): number;
  setWind(field: WindField, timeMs: number): void;
  setZoom(halfHeight: number): void;
  dispose(): void;
}

export function createFlowerField(opts: FlowerFieldOptions): FlowerField {
  const span = Math.max(1, opts.span ?? PAINTED_SIZE);
  const restLayer = emptyLayerTexture();
  const restPress = restPressTexture();
  const windUniforms = createWindUniforms();

  const uniforms = {
    ...toonUniforms,
    ...windUniforms,
    uFlowers: { value: (opts.layers?.flowers ?? restLayer) as Texture },
    uGrass: { value: (opts.layers?.grass ?? restLayer) as Texture },
    uPress: { value: (opts.layers?.press ?? restPress) as Texture },
    uRegion: { value: (opts.region ?? restLayer) as Texture },
    uDensity: { value: DEFAULTS.density },
    uBaseDensity: { value: opts.baseDensity ?? DEFAULTS.baseDensity },
    uNoiseScale: { value: DEFAULTS.noiseScale },
    uNoiseStrength: { value: DEFAULTS.noiseStrength },
    uStemHeight: { value: DEFAULTS.stemHeight },
    uStemWidth: { value: DEFAULTS.stemWidth },
    uHeadSize: { value: DEFAULTS.headSize },
    uWindResponse: { value: DEFAULTS.windResponse },
    uNeedGrass: { value: DEFAULTS.needGrass },
    uZoom: { value: DEFAULTS.zoom },
    uCenter: { value: new Vector2(0, 0) },
    uSpan: { value: span },
    uHeight: { value: (opts.height ?? restLayer) as Texture },
    uHeightRes: { value: heightRes() },
    uMix: { value: DEFAULTS.mix.clone() },
    uWhite: { value: new Color(GHIBLI.flowerWhite) },
    uYellow: { value: new Color(GHIBLI.flowerYellow) },
    uPink: { value: new Color(GHIBLI.flowerPink) },
    uBlue: { value: new Color(GHIBLI.flowerBlue) },
    uCentre: { value: new Color(GHIBLI.flowerCentre) },
    uStem: { value: new Color(GHIBLI.flowerStem) },
  };

  const material = new ShaderMaterial({
    name: 'ghibli-flowers',
    uniforms,
    vertexShader: vertexSource(),
    fragmentShader: FRAGMENT,
    side: DoubleSide,
  });

  let count = Math.max(1, Math.round(opts.count ?? FLOWER_COUNT_PROJECTION));
  let centerX = 0;
  let centerZ = 0;
  /** The quantum `setCenter` snaps to — see the blade field's own. */
  const cell = Math.max(0.05, span / Math.max(1, Math.sqrt(count)) / 8);

  /**
   * Sow `n` blooms RADIALLY and WINDOW-LOCAL, thinning with distance the way
   * the blades do — the same construction as `GrassField`'s `lay`, on the
   * bloom seed. The density curve is the shader's; this only has to put the
   * instances where it will not cull them all.
   */
  const lay = (n: number, offsets: Float32Array, rands: Float32Array): void => {
    const reach = span / 2;
    const rand = mulberry32(FLOWER_SEED);
    for (let i = 0; i < n; i++) {
      const angle = i * 2.39996323 + (rand() - 0.5) * 0.9;
      // sqrt keeps the sowing even per unit AREA before the shader's own curve
      // thins it — a bloom field is sparse enough that the curve alone carries
      // the falloff.
      const r = Math.sqrt((i + rand()) / n) * reach;
      offsets[i * 2] = Math.cos(angle) * r;
      offsets[i * 2 + 1] = Math.sin(angle) * r;
      rands[i * 4] = rand();
      rands[i * 4 + 1] = rand();
      rands[i * 4 + 2] = rand();
      rands[i * 4 + 3] = rand();
    }
  };

  const build = (n: number): InstancedBufferGeometry => {
    const geometry = new InstancedBufferGeometry();
    geometry.name = 'ghibli-flower';
    const rows = SEG + 1;
    const verts = new Float32Array((rows * 2 + 4) * 3);
    const rest = new Float32Array((rows * 2 + 4) * 3);
    for (let row = 0; row < rows; row++) {
      const t = row / SEG;
      verts.set([-1, t, 0], row * 2 * 3);
      verts.set([1, t, 0], (row * 2 + 1) * 3);
      rest.set([-DEFAULTS.stemWidth * 0.5, t * DEFAULTS.stemHeight * 0.4, 0], row * 2 * 3);
      rest.set([DEFAULTS.stemWidth * 0.5, t * DEFAULTS.stemHeight * 0.4, 0], (row * 2 + 1) * 3);
    }
    const headBase = rows * 2;
    verts.set([-1, -1, 1], headBase * 3);
    verts.set([1, -1, 1], (headBase + 1) * 3);
    verts.set([-1, 1, 1], (headBase + 2) * 3);
    verts.set([1, 1, 1], (headBase + 3) * 3);
    const tipY = DEFAULTS.stemHeight * 0.4;
    const petal = DEFAULTS.headSize * 0.2;
    rest.set([-petal, tipY - petal, 0], headBase * 3);
    rest.set([petal, tipY - petal, 0], (headBase + 1) * 3);
    rest.set([-petal, tipY + petal, 0], (headBase + 2) * 3);
    rest.set([petal, tipY + petal, 0], (headBase + 3) * 3);
    geometry.setAttribute('aVert', new BufferAttribute(verts, 3));
    // Rest pose, for the ink pass's override material only (see grass.ts).
    geometry.setAttribute('position', new BufferAttribute(rest, 3));

    const index = new Uint16Array(SEG * 6 + 6);
    for (let s = 0; s < SEG; s++) {
      const a = s * 2;
      index.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], s * 6);
    }
    const b = headBase;
    index.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], SEG * 6);
    geometry.setIndex(new BufferAttribute(index, 1));

    const offsets = new Float32Array(n * 2);
    const rands = new Float32Array(n * 4);
    lay(n, offsets, rands);
    geometry.setAttribute('aOffset', new InstancedBufferAttribute(offsets, 2));
    geometry.setAttribute('aRand', new InstancedBufferAttribute(rands, 4));
    geometry.instanceCount = n;
    return geometry;
  };

  let geometry = build(count);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ghibli-flowers';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.userData.ghibliNormalPassSkip = true;

  return {
    mesh,
    material,
    setLayers(layers: FlowerLayers): void {
      if ('flowers' in layers) uniforms.uFlowers.value = layers.flowers ?? restLayer;
      if ('grass' in layers) uniforms.uGrass.value = layers.grass ?? restLayer;
      if ('press' in layers) uniforms.uPress.value = layers.press ?? restPress;
    },
    setRegion(region: Texture | null): void {
      uniforms.uRegion.value = region ?? restLayer;
    },
    setBaseDensity(value: number): void {
      uniforms.uBaseDensity.value = Math.min(1, Math.max(0, value));
    },
    setHeight(height: Texture | null): void {
      uniforms.uHeight.value = height ?? restLayer;
    },
    setCenter(x: number, z: number): void {
      centerX = Math.round(x / cell) * cell;
      centerZ = Math.round(z / cell) * cell;
      uniforms.uCenter.value.set(centerX, centerZ);
    },
    center(): { x: number; z: number } {
      return { x: centerX, z: centerZ };
    },
    setCount(next: number): void {
      const n = Math.max(1, Math.round(next));
      if (n === count) return;
      count = n;
      const old = geometry;
      geometry = build(n);
      mesh.geometry = geometry;
      old.dispose();
    },
    count(): number {
      return count;
    },
    setWind(field: WindField, timeMs: number): void {
      setWindUniforms(windUniforms, field, timeMs);
    },
    setZoom(halfHeight: number): void {
      uniforms.uZoom.value = halfHeight;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      restLayer.dispose();
      restPress.dispose();
    },
  };
}
