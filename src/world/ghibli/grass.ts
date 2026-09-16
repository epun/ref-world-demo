/**
 * The blade field — envpaint's `Grass` element (src/elements/Grass.js) ported
 * onto this world's seams. `ghibli` style only (docs/TASTE.md §9).
 *
 * ONE MESH, N BLADES, EVERY DECISION IN THE VERTEX SHADER. A single
 * `InstancedBufferGeometry` of a five-row strip, instanced over a seeded
 * jittered grid across `PAINTED_SIZE`. Whether a blade exists at all is a
 * shader decision — painted weight, the authored map, patchiness noise
 * against the blade's own random — so painting or re-painting the meadow
 * never touches an instance buffer and never re-uploads anything.
 *
 * WHAT CHANGED IN THE PORT, and why:
 *
 *   - **height comes from a BAKE of the seam, read in the shader.** envpaint
 *     displaces its ground from a `height` layer and its blades read the same
 *     sampler. Here the ground's displacement is geometry and the only legal
 *     height source is the `Surface` seam (`src/world/surface.ts`, CLAUDE.md),
 *     so the seam is baked into one texture per terrain rebuild
 *     (`src/world/ghibli/height.ts`) and the vertex shader taps it. It began
 *     as an `aGround` attribute baked per blade, which cost 651ms of seam
 *     sampling every time the window moved — measured, and a dropped frame
 *     every six units of camera travel.
 *   - **the map grows grass, not just the brush.** `uRegion`
 *     (src/world/ghibli/region.ts) carries meadow weight, beach weight and
 *     water proximity, so an unpainted island still has a meadow, the sand
 *     thins it out and nothing stands in the sea. envpaint had no authored
 *     map to consult.
 *   - **the wind is this world's wind.** `refWindAt` (the gust-front field,
 *     `src/world/wind.ts`) on the scatter's four uniform names, so a blade
 *     and a scatter tick are bent by the same weather. envpaint's
 *     derivative LEAD term — sample the field now and 0.12s ago, extrapolate,
 *     "spring back past neutral as the gust leaves" — is **dropped**: past
 *     neutral is overshoot, and overshoot is forbidden at confidence 1.00
 *     (TASTE §2.1). What is left is the field itself plus a smooth
 *     perpendicular flutter, which still reads as blown because the field is
 *     a travelling front (see `src/world/wind.ts`).
 *   - **no style branches, no grain, no shadow map.** Only the ghibli branch
 *     of each envpaint `uStyleId` switch survives; the lighting is
 *     `src/world/toon.ts`'s shared chunk with a constant 1.0 shadow term.
 *
 * THE MOVING WINDOW (2026-09-15, user direction: *"I want the grass density
 * and style to look like EnvPaint in the valiocon version, not the old
 * style"*). envpaint's world is 48 units across and carries 300 000 blades —
 * about 130 a square unit. This world is 400 units across, so that per-unit
 * density is twenty million blades. What the eye actually reads is blades per
 * SCREEN PIXEL, so the tier's budget is spent inside a `span`-wide window
 * around the camera's look-target instead of thinly over the whole map: at
 * envpaint-like density in the middle of the frame, fading out over the last
 * quarter of the window (never a hard edge — TASTE §2.1) into the ground
 * shader's own meadow green, which carries the field from there to the
 * horizon. `setCenter` slides the window; the caller quantises, because a
 * re-lay re-bakes every blade's ground height.
 *
 * INK NORMAL PASS. `src/world/ink.ts` renders a normal target with
 * `scene.overrideMaterial = MeshNormalMaterial`, which would draw this
 * geometry's rest-pose `position` attribute instead of the shader's blades.
 * The mesh therefore carries `userData.ghibliNormalPassSkip = true`: the
 * wiring hides it around that pass (docs/ghibli-port.md). A rest-pose
 * `position` attribute is supplied anyway so that nothing renders NaN if the
 * hide is ever missed.
 */

import {
  BufferAttribute,
  Color,
  DoubleSide,
  Vector2,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  type Texture,
} from 'three';
import { GHIBLI } from '../../taste/tokens';
import { PAINTED_SIZE } from '../painted';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import { WIND_FIELD_GLSL, type WindField } from '../wind';
import { GG_HEIGHT_GLSL, GG_WINDOW_GLSL, HEIGHT_RES } from './height';
import {
  GG_WIND_NOISE_GLSL,
  createWindUniforms,
  emptyLayerTexture,
  ggFloat,
  mulberry32,
  neutralCombTexture,
  restPressTexture,
  setWindUniforms,
} from './shared';

/** Segments along a blade; `(SEG + 1) * 2` vertices per blade. */
const SEG = 4;

/**
 * Tier counts [D]. A projection is a desktop GPU drawing one frame for a
 * room; a handset is drawing the same world beside its own character panel
 * and its pixel ratio is already capped (src/world/scene.ts). Same field,
 * same seed, fewer blades — the layout is a prefix of the same grid, so the
 * two devices disagree about density and never about position.
 */
export const GRASS_COUNT_PROJECTION = 150000;
export const GRASS_COUNT_PHONE = 40000;

/** [D] Strength of the hard cel dab on a sunlit tip — see the fragment. */
const TIP_DAB = 0.08;

/** The layout seed. A constant, never a clock (see `mulberry32`). */
const GRASS_SEED = 0x9e3779b9;

/** Gust frequency for the front field, Hz — the scatter's tick profile. */
const GUST_HZ = 0.7;
/** Perpendicular flutter amplitude and rate, the tick profile's again. */
const FLUTTER = 0.07;
const FLUTTER_HZ = 1.5;
/** Per-blade detune, seconds, so neighbours move together but not as one. */
const PHASE_JITTER = 2.4;

/** envpaint's `Grass.params`, minus the panel. */
const DEFAULTS = {
  density: 1,
  baseDensity: 0.85,
  noiseScale: 0.25,
  noiseStrength: 0.6,
  bladeHeight: 0.8,
  /**
   * [D] envpaint's 0.11, widened.
   *
   * THE PIXELS, not the units: envpaint views its 48-unit world at about
   * 0.048 world units a pixel, so its 0.8 × 0.11 blade is ~17 px tall and
   * ~2.3 px wide. This world's default view is `FRUSTUM_HEIGHT` 40 over the
   * viewport height — 0.05 u/px at 800 px — which is within 5% of the same
   * scale, so the blade keeps envpaint's height exactly and reads the same
   * size on screen. The WIDTH goes up because the density cannot: a tier's
   * budget over the window below lands near 77 blades a square unit against
   * envpaint's 130, and a blade 27% wider covers the difference.
   */
  bladeWidth: 0.14,
  lean: 0.45,
  /** Radians. envpaint's 30° default. */
  direction: (30 * Math.PI) / 180,
  directionJitter: 0.9,
  combStrength: 0.9,
  windResponse: 0.9,
  /** Camera frustum half-height — how far away we are. */
  zoom: 14,
};

/**
 * [D] World units the window spans, by tier (see the header).
 *
 * A projection's default view covers roughly 64 × 69 units of GROUND, and
 * 150 000 blades only reach envpaint's density over about 34 units square —
 * so 44 puts real blades across the middle two thirds of the frame and lets
 * the ground green carry the rest. A handset holds the same budget ratio.
 */
export const GRASS_SPAN_PROJECTION = 44;
export const GRASS_SPAN_PHONE = 26;



const VERTEX = /* glsl */ `
const float GG_SIZE = ${ggFloat(PAINTED_SIZE)};
const float GG_TAU = 6.2831853;
${TOON_VARYINGS_GLSL}
${WIND_FIELD_GLSL}
${GG_WIND_NOISE_GLSL}
${GG_HEIGHT_GLSL}
${GG_WINDOW_GLSL}

uniform sampler2D uGrass;
uniform sampler2D uComb;
uniform sampler2D uPress;
uniform sampler2D uRegion;

uniform float uDensity;
uniform float uBaseDensity;
uniform float uNoiseScale;
uniform float uNoiseStrength;
uniform float uBladeHeight;
uniform float uBladeWidth;
uniform float uLean;
uniform float uDirection;
uniform float uDirectionJitter;
uniform float uCombStrength;
uniform float uWindResponse;
uniform float uZoom;

uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindGust;
uniform vec3 uSunDir;

attribute vec2 aOffset;
attribute vec4 aRand;
attribute vec2 aBlade;

varying float vT;
varying vec4 vRand;
varying float vNoise;

const vec2 GG_NOISE_SEED = vec2(17.3, 41.7);

void main() {
  // The window's centre is the shader's, so a slide is one uniform write (see
  // the header). Everything below reads this world position and not the raw
  // offset: the layers, the map, the wind phase and the ground under the blade
  // all belong to where the blade IS.
  vec2 wpos = aOffset + uCenter;
  vec2 luv = wpos / GG_SIZE + 0.5;

  float paint = texture2D(uGrass, luv).r;
  vec3 region = texture2D(uRegion, luv).rgb;
  // b is exactly 1.0 in water and under 0.9 on land (region.ts) — one tap
  // answers both "am I wet" and "how close is the sea".
  float wet = step(0.95, region.b);
  // The brush wins where somebody painted; the map carries the rest.
  float grow = max(paint, uBaseDensity * region.r);
  grow *= 1.0 - 0.75 * region.g;
  grow *= 1.0 - wet;
  float base = grow * uDensity;

  float n = 0.0;
  float p = 0.0;
  if (base > aRand.x) {
    n = windFbm(luv * uNoiseScale * 40.0 + GG_NOISE_SEED, 4);
    p = base * mix(1.0, smoothstep(0.25, 0.75, n), uNoiseStrength);
  }

  vT = 0.0;
  vRand = vec4(0.0);
  vNoise = 0.0;
  vToonWorldPos = vec3(0.0);
  vToonNormal = vec3(0.0, 1.0, 0.0);

  if (p <= aRand.x) {
    // Off-screen in clip space: the cheapest cull there is, and the reason
    // painting never rebuilds a buffer.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float t = aBlade.y;
  float sideS = aBlade.x;

  float heightNoise = mix(0.65, 1.35, windFbm(luv * 25.0 + 7.3, 3));
  float bh = uBladeHeight * heightNoise * mix(0.7, 1.3, aRand.z);
  // The window's fade (ggWindow, src/world/ghibli/height.ts): the blades
  // shorten into a ground the ghibli terrain shader has already tinted to this
  // field's own colour, over the same squircle — so the field has an edge
  // nobody can see rather than a line somebody can (TASTE §2.1).
  bh *= ggWindow(wpos);
  float width = uBladeWidth * (1.0 - pow(t, 1.3));

  // Where the comb layer is painted it replaces the global lean entirely and
  // damps the per-blade jitter, so the patch reads as parted rather than wild.
  vec2 comb = texture2D(uComb, luv).rg * 2.0 - 1.0;
  float combMag = clamp(length(comb) * 1.4, 0.0, 1.0);
  float ang = uDirection + (aRand.y - 0.5) * uDirectionJitter * (1.0 - combMag * 0.7);
  vec2 lean = mix(
    vec2(cos(ang), sin(ang)) * uLean,
    normalize(comb + 1e-5) * uCombStrength,
    combMag
  );

  // The world's own gust-front field, plus a smooth perpendicular flutter.
  // No derivative lead, no spring back past neutral (see the header).
  float phase = ggWindHash(dot(wpos, vec2(127.1, 311.7))) * ${ggFloat(PHASE_JITTER)};
  vec2 push = refWindAt(wpos, uWindTime * ${ggFloat(GUST_HZ)},
    uWindDir, uWindStrength, uWindGust);
  vec2 windV = push * uWindResponse;
  windV += vec2(-uWindDir.y, uWindDir.x) * (uWindStrength * ${ggFloat(FLUTTER)}
    * ggWindNoise(uWindTime * ${ggFloat(FLUTTER_HZ)} + phase * 1.7, 47.9) * uWindResponse);

  vec2 bend2 = lean + windV;

  // Anything heavy rolling over the ground presses blades flat and shoves
  // them aside. RG is a direction in layer uv, whose axes are world xz.
  vec4 pr = texture2D(uPress, luv);
  vec2 pushDir = pr.rg * 2.0 - 1.0;
  float pressed = pr.b;
  bend2 += pushDir * pressed * 2.2;
  bh *= 1.0 - 0.55 * pressed;

  float bendAmt = length(bend2);

  // Quadratic curve in t; the tip sinks as it bends so the blade keeps length.
  vec3 pos = vec3(
    bend2.x * bh * t * t,
    bh * t * (1.0 - 0.3 * bendAmt * t * t),
    bend2.y * bh * t * t
  );

  float r = aRand.y * GG_TAU;
  vec3 sideDir = vec3(cos(r), 0.0, sin(r));
  pos += sideDir * width * sideS * 0.5;

  vec3 world = vec3(wpos.x, ggGroundAt(wpos), wpos.y) + pos;

  // One flat normal for the whole blade (tangent at mid-height) so each blade
  // lands wholly in one cel band.
  vec3 tangent = normalize(vec3(
    bend2.x * bh,
    bh * (1.0 - 0.225 * bendAmt),
    bend2.y * bh
  ));
  vec3 nrm = normalize(cross(sideDir, tangent));
  // The per-blade nudge toward the sun breaks up band alignment between
  // neighbours — but zoomed out a blade is a pixel wide and the nudge reads
  // as speckle, so it fades with distance.
  float far = smoothstep(9.0, 22.0, uZoom);
  nrm = normalize(nrm + uSunDir * (aRand.w - 0.5) * 0.35 * (1.0 - 0.85 * far));

  vT = t;
  vRand = aRand;
  vNoise = n;

  vToonWorldPos = world;
  vToonNormal = nrm;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const FRAGMENT = /* glsl */ `
${TOON_LIGHTING_GLSL}

uniform vec3 uColorBase;
uniform vec3 uColorTip;
uniform vec3 uColorDry;
uniform float uZoom;

varying float vT;
varying vec4 vRand;
varying float vNoise;

void main() {
  vec3 n = normalize(vToonNormal) * (gl_FrontFacing ? 1.0 : -1.0);

  vec3 col = mix(uColorBase, uColorTip, pow(vT, 0.7));
  col = mix(col, uColorDry, smoothstep(0.55, 0.9, vNoise) * 0.55);
  col *= mix(0.95, 1.05, vRand.w);
  col *= mix(0.72, 1.0, smoothstep(0.0, 0.5, vT));

  // Zoomed out, root darkening and tip contrast turn into per-pixel noise:
  // collapse them toward one painted mid green so the meadow reads as a fill.
  float far = smoothstep(9.0, 22.0, uZoom);
  col = mix(col, mix(uColorBase, uColorTip, 0.55), far * 0.6);

  vec3 lit = toonLight(col, n, 1.0, 2.0);
  // Tip highlight: a hard cel dab, the ghibli branch of envpaint's switch.
  // 0.08 and not envpaint's 0.2 [D]: at this world's density the dab landed on
  // enough tips to lift the whole field a value above the meadow around it, and
  // a window you can see is worse than a highlight you cannot (2026-09-15).
  lit += uSunColor * ${ggFloat(TIP_DAB)}
    * smoothstep(0.6, 1.0, vT)
    * smoothstep(0.4, 0.9, dot(n, uSunDir));

  gl_FragColor = vec4(lit, 1.0);
  #include <colorspace_fragment>
}`;

/** The layers a blade field reads, all optional, all live buffers. */
export interface GrassLayers {
  /** The painted `grass` weight layer's `DataTexture`. */
  grass?: Texture | null;
  /** The painted `comb` direction layer. */
  comb?: Texture | null;
  /** The press layer — rgb = push direction and force. Deferred; see the doc. */
  press?: Texture | null;
}

export interface GrassFieldOptions {
  /** Blades. The caller passes its tier's count (see the two constants). */
  count?: number;
  /** The baked ground (src/world/ghibli/height.ts) — the `Surface` seam's own
   * answers and nothing else. Absent means flat paper. */
  height?: Texture | null;
  /** The baked geography (src/world/ghibli/region.ts). */
  region?: Texture | null;
  /** How much grass the MAP grows where nobody has painted, 0–1. */
  baseDensity?: number;
  /** World units the window spans (see the header). Defaults to the whole
   * painted map, which is the layout the field had before the window. */
  span?: number;
  layers?: GrassLayers;
}

export interface GrassField {
  mesh: Mesh;
  material: ShaderMaterial;
  /** Point the samplers at live layer buffers, or `null` to go back to rest. */
  setLayers(layers: GrassLayers): void;
  /** Swap the baked geography (after a landscape change). */
  setRegion(region: Texture | null): void;
  /** How much grass the map grows unpainted. */
  setBaseDensity(value: number): void;
  /**
   * Point the field at the baked ground — `refreshTerrain`'s call, and the
   * whole of it: the bake is re-run in place by whoever owns it
   * (src/world/ground.ts), so a terrain change costs this field nothing.
   */
  setHeight(height: Texture | null): void;
  /**
   * Slide the window's centre. ONE uniform write, so this is a per-frame call
   * (see the header) — and the centre is quantised to the layout's own cell
   * inside here, so the blades slide along their own world lattice instead of
   * travelling with the camera.
   */
  setCenter(x: number, z: number): void;
  /** Where the window is centred, world x/z — quantised, as applied. */
  center(): { x: number; z: number };
  /** Re-lay the field at a new blade count (the tier changed). */
  setCount(count: number): void;
  /** Blades currently laid. */
  count(): number;
  /** One frame's wind, from the same field the scatter draws. */
  setWind(field: WindField, timeMs: number): void;
  /** The camera's frustum half-height, for the distance collapse. */
  setZoom(halfHeight: number): void;
  dispose(): void;
}

/**
 * Build the blade field. Nothing is added to a scene here — the caller owns
 * that, and owns hiding the mesh on the `ink` style (docs/ghibli-port.md).
 */
export function createGrassField(opts: GrassFieldOptions): GrassField {
  const span = Math.max(1, opts.span ?? PAINTED_SIZE);
  const restGrass = emptyLayerTexture();
  const restComb = neutralCombTexture();
  const restPress = restPressTexture();
  const windUniforms = createWindUniforms();

  const uniforms = {
    ...toonUniforms,
    ...windUniforms,
    uGrass: { value: (opts.layers?.grass ?? restGrass) as Texture },
    uComb: { value: (opts.layers?.comb ?? restComb) as Texture },
    uPress: { value: (opts.layers?.press ?? restPress) as Texture },
    uRegion: { value: (opts.region ?? restGrass) as Texture },
    uDensity: { value: DEFAULTS.density },
    uBaseDensity: { value: opts.baseDensity ?? DEFAULTS.baseDensity },
    uNoiseScale: { value: DEFAULTS.noiseScale },
    uNoiseStrength: { value: DEFAULTS.noiseStrength },
    uBladeHeight: { value: DEFAULTS.bladeHeight },
    uBladeWidth: { value: DEFAULTS.bladeWidth },
    uLean: { value: DEFAULTS.lean },
    uDirection: { value: DEFAULTS.direction },
    uDirectionJitter: { value: DEFAULTS.directionJitter },
    uCombStrength: { value: DEFAULTS.combStrength },
    uWindResponse: { value: DEFAULTS.windResponse },
    uZoom: { value: DEFAULTS.zoom },
    uCenter: { value: new Vector2(0, 0) },
    uSpan: { value: span },
    uHeight: { value: (opts.height ?? restGrass) as Texture },
    uHeightRes: { value: HEIGHT_RES },
    uColorBase: { value: new Color(GHIBLI.grassBase) },
    uColorTip: { value: new Color(GHIBLI.grassTip) },
    uColorDry: { value: new Color(GHIBLI.grassDry) },
  };

  const material = new ShaderMaterial({
    name: 'ghibli-grass',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: DoubleSide,
  });

  let count = Math.max(1, Math.round(opts.count ?? GRASS_COUNT_PROJECTION));
  let centerX = 0;
  let centerZ = 0;
  /** The lattice step the layout lays blades on, and the quantum `setCenter`
   * snaps to — so a slide moves the field by whole cells and every blade lands
   * where a blade already was. */
  let cell = span / Math.ceil(Math.sqrt(count));

  /**
   * Lay `n` blades on the seeded jittered grid, WINDOW-LOCAL: the offsets are
   * relative to the window's centre and the vertex shader adds `uCenter`, so
   * this runs once per count and never again as the window slides.
   */
  const lay = (n: number, offsets: Float32Array, rands: Float32Array): void => {
    const k = Math.ceil(Math.sqrt(n));
    cell = span / k;
    const half = span / 2;
    const rand = mulberry32(GRASS_SEED);
    for (let i = 0; i < n; i++) {
      const gx = i % k;
      const gz = (i / k) | 0;
      offsets[i * 2] = -half + (gx + 0.5 + (rand() - 0.5) * 0.95) * cell;
      offsets[i * 2 + 1] = -half + (gz + 0.5 + (rand() - 0.5) * 0.95) * cell;
      rands[i * 4] = rand();
      rands[i * 4 + 1] = rand();
      rands[i * 4 + 2] = rand();
      rands[i * 4 + 3] = rand();
    }
  };

  /** The blade strip: shared by every instance, built once per count change
   * only because the instance attributes live on the same geometry. */
  const build = (n: number): InstancedBufferGeometry => {
    const geometry = new InstancedBufferGeometry();
    geometry.name = 'ghibli-blade';
    const rows = SEG + 1;
    const blade = new Float32Array(rows * 2 * 2);
    // The rest-pose position, for the ink pass's override material only.
    const rest = new Float32Array(rows * 2 * 3);
    for (let row = 0; row < rows; row++) {
      const t = row / SEG;
      blade[row * 2 * 2] = -1;
      blade[row * 2 * 2 + 1] = t;
      blade[(row * 2 + 1) * 2] = 1;
      blade[(row * 2 + 1) * 2 + 1] = t;
      rest[row * 2 * 3] = -DEFAULTS.bladeWidth * 0.5;
      rest[row * 2 * 3 + 1] = t * DEFAULTS.bladeHeight;
      rest[(row * 2 + 1) * 3] = DEFAULTS.bladeWidth * 0.5;
      rest[(row * 2 + 1) * 3 + 1] = t * DEFAULTS.bladeHeight;
    }
    geometry.setAttribute('aBlade', new BufferAttribute(blade, 2));
    geometry.setAttribute('position', new BufferAttribute(rest, 3));

    const index = new Uint16Array(SEG * 6);
    for (let s = 0; s < SEG; s++) {
      const a = s * 2;
      index.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], s * 6);
    }
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
  mesh.name = 'ghibli-grass';
  // The blades live in world space (the vertex shader projects them itself),
  // so no bounding volume is meaningful and the matrix never moves.
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  // The marker the ink pass's normal target reads (see the header).
  mesh.userData.ghibliNormalPassSkip = true;

  return {
    mesh,
    material,
    setLayers(layers: GrassLayers): void {
      if ('grass' in layers) uniforms.uGrass.value = layers.grass ?? restGrass;
      if ('comb' in layers) uniforms.uComb.value = layers.comb ?? restComb;
      if ('press' in layers) uniforms.uPress.value = layers.press ?? restPress;
    },
    setRegion(region: Texture | null): void {
      uniforms.uRegion.value = region ?? restGrass;
    },
    setBaseDensity(value: number): void {
      uniforms.uBaseDensity.value = Math.min(1, Math.max(0, value));
    },
    setHeight(height: Texture | null): void {
      uniforms.uHeight.value = height ?? restGrass;
    },
    setCenter(x: number, z: number): void {
      // Snapped to the lattice: a blade that slides by whole cells stands
      // where a blade already stood, so the field reads as world-fixed even
      // though the buffer is window-local.
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
      restGrass.dispose();
      restComb.dispose();
      restPress.dispose();
    },
  };
}
