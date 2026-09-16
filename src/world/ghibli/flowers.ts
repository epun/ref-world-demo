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
export const FLOWER_COUNT_PROJECTION = 40000;
export const FLOWER_COUNT_PHONE = 10000;

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
 * Twice the blade window, on purpose: a bloom reads from much farther away
 * than a blade does (a coloured head is two or three pixels of yellow on
 * green, where a blade is one pixel of a slightly different green), and the
 * same budget over the blades' own window sowed about twenty a square unit —
 * a carpet of wildflowers rather than a meadow with flowers in it (measured on
 * screen, 2026-09-15). Five a square unit at the map's 0.18 base density is
 * roughly one bloom a square unit, which is the reference read.
 */
export const FLOWER_SPAN_PROJECTION = 88;
export const FLOWER_SPAN_PHONE = 52;

/** [D] Where the window's fade begins, as a fraction of its half-span. */
const FADE_IN = 0.72;

const DEFAULTS = {
  density: 1,
  /** [D] How many flowers the MAP sows unpainted: a meadow is mostly grass. */
  baseDensity: 0.18,
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

const VERTEX = /* glsl */ `
const float GG_SIZE = ${ggFloat(PAINTED_SIZE)};
const float GG_TAU = 6.2831853;
${TOON_VARYINGS_GLSL}
${WIND_FIELD_GLSL}
${GG_WIND_NOISE_GLSL}

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
uniform vec2 uCenter;
uniform float uSpan;
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
attribute float aGround;
attribute vec3 aVert;

varying vec4 vInfo;
varying vec3 vColor;
varying vec3 vCentreColor;

const vec2 GG_NOISE_SEED = vec2(31.7, 11.9);

void main() {
  vec2 luv = aOffset / GG_SIZE + 0.5;

  float paint = texture2D(uFlowers, luv).r;
  float grassV = texture2D(uGrass, luv).r;
  vec3 region = texture2D(uRegion, luv).rgb;
  float wet = step(0.95, region.b);

  float grow = max(paint, uBaseDensity * region.r);
  grow *= 1.0 - 0.75 * region.g;
  grow *= 1.0 - wet;
  float base = grow * uDensity;
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
  // The window's fade, the blade field's exactly (src/world/ghibli/grass.ts):
  // the last quarter shrinks into the ground rather than ending on a line.
  vec2 fromCenter = abs(aOffset - uCenter) / max(uSpan * 0.5, 1e-3);
  float windowFade = 1.0 - smoothstep(${ggFloat(FADE_IN)}, 1.0, max(fromCenter.x, fromCenter.y));
  bh *= windowFade;

  float phase = ggWindHash(dot(aOffset, vec2(127.1, 311.7))) * ${ggFloat(PHASE_JITTER)};
  vec2 push = refWindAt(aOffset, uWindTime * ${ggFloat(GUST_HZ)},
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

  vec3 world = vec3(aOffset.x, aGround, aOffset.y) + pos;

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
  head *= mix(0.96, 1.04, windHash21(aOffset * 3.7));

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
  heightAt: (x: number, z: number) => number;
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
  rebuild(heightAt: (x: number, z: number) => number): void;
  /** Slide the window and re-lay the field inside it. The caller quantises —
   * see `GrassField.setCenter`, which this mirrors exactly. */
  setCenter(x: number, z: number, heightAt: (x: number, z: number) => number): void;
  /** Where the window is centred, world x/z. */
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
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: DoubleSide,
  });

  let heightAt = opts.heightAt;
  let count = Math.max(1, Math.round(opts.count ?? FLOWER_COUNT_PROJECTION));
  let centerX = 0;
  let centerZ = 0;

  /** Sow `n` blooms on the seeded jittered grid inside the window, and bake
   * each one's ground height through the `Surface` seam. Re-run whole when the
   * window slides (`setCenter`) — see the blade field's own `lay`. */
  const lay = (
    n: number,
    offsets: Float32Array,
    rands: Float32Array,
    ground: Float32Array,
  ): void => {
    const k = Math.ceil(Math.sqrt(n));
    const cell = span / k;
    const half = span / 2;
    const rand = mulberry32(FLOWER_SEED);
    for (let i = 0; i < n; i++) {
      const gx = i % k;
      const gz = (i / k) | 0;
      const x = centerX - half + (gx + 0.5 + (rand() - 0.5) * 0.95) * cell;
      const z = centerZ - half + (gz + 0.5 + (rand() - 0.5) * 0.95) * cell;
      offsets[i * 2] = x;
      offsets[i * 2 + 1] = z;
      rands[i * 4] = rand();
      rands[i * 4 + 1] = rand();
      rands[i * 4 + 2] = rand();
      rands[i * 4 + 3] = rand();
      ground[i] = heightAt(x, z);
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
    const ground = new Float32Array(n);
    lay(n, offsets, rands, ground);
    geometry.setAttribute('aOffset', new InstancedBufferAttribute(offsets, 2));
    geometry.setAttribute('aRand', new InstancedBufferAttribute(rands, 4));
    geometry.setAttribute('aGround', new InstancedBufferAttribute(ground, 1));
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
    rebuild(next: (x: number, z: number) => number): void {
      heightAt = next;
      const offsets = geometry.getAttribute('aOffset');
      const ground = geometry.getAttribute('aGround');
      for (let i = 0; i < ground.count; i++) {
        ground.setX(i, heightAt(offsets.getX(i), offsets.getY(i)));
      }
      ground.needsUpdate = true;
    },
    setCenter(x: number, z: number, next: (x: number, z: number) => number): void {
      centerX = x;
      centerZ = z;
      heightAt = next;
      uniforms.uCenter.value.set(x, z);
      const offsets = geometry.getAttribute('aOffset') as InstancedBufferAttribute;
      const rands = geometry.getAttribute('aRand') as InstancedBufferAttribute;
      const ground = geometry.getAttribute('aGround') as InstancedBufferAttribute;
      lay(
        count,
        offsets.array as Float32Array,
        rands.array as Float32Array,
        ground.array as Float32Array,
      );
      offsets.needsUpdate = true;
      rands.needsUpdate = true;
      ground.needsUpdate = true;
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
