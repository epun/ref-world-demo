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
 * TWO LAYERS (2026-09-16, user direction: *"grass over the entire map, not
 * one section"*). One `createGrassField` builds either:
 *
 *   - a BASE field (`layout: 'box'`): every land texel of the island that the
 *     map calls meadow, at a uniform density over the island's own bounding
 *     box, with the whole of a tier's base budget in it — 600 000 blades on a
 *     projection over ~124 000 square units, about 10 a square unit. At that
 *     spacing a blade is far apart from its neighbours, so a base blade is
 *     WIDER (`bladeWidth`) and its width additionally has a floor in PIXELS
 *     (`uPxScale`, written from the camera's units-per-pixel every frame), so
 *     a blade never thins to a flicker as the camera pulls back.
 *   - a NEAR field (`layout: 'radial'`): the dense one around the look-target,
 *     envpaint's own density in the middle of the frame, thinning with
 *     distance. It draws ON TOP of the base field.
 *
 * …and the ghibli ground's own blade stipple is the third layer under both
 * (src/world/ghibli/ground.ts), so there is grass texture from the camera to
 * the coast with nothing anywhere that reads as an edge.
 *
 * THE MOVING WINDOW (2026-09-15, user direction: *"I want the grass density
 * and style to look like EnvPaint in the valiocon version, not the old
 * style"*). envpaint's world is 48 units across and carries 300 000 blades —
 * about 130 a square unit. This world is 400 units across, so that per-unit
 * density is twenty million blades. What the eye actually reads is blades per
 * SCREEN PIXEL, so the tier's budget is spent around the camera's look-target
 * instead of thinly over the whole map.
 *
 * AND IT IS A LOD, not a patch (2026-09-16, user direction: the constant-
 * density window read as *"a textured oval on a flat green field"*). The
 * layout is RADIAL and its density follows `ggFieldDensity`
 * (src/world/ghibli/height.ts): envpaint's own density through a 12-unit core,
 * falling with distance to a ninth of it at 70 units, nothing beyond — which
 * covers the whole default view rather than a lozenge in the middle of it.
 * Blades also keep only `RIM_HEIGHT` of their height out there, so the field
 * thins in size as well as in count, and past the reach the ground's own blade
 * stipple carries the meadow.
 *
 * WHY THE LAYOUT IS RADIAL AND NOT A GRID THE SHADER CULLS. The instruction
 * was to lay the grid at the DENSEST spacing over the whole reach and let the
 * cull thin it with distance — but that is 1.5 MILLION instances submitted to
 * draw 150 000, ten times the vertex work of the budget it was meant to keep.
 * So the radial layout puts each instance where the curve wants it (an
 * inverse-CDF draw on the same seeded stream), every instance survives, and
 * the shader's own distance term still gates the rim and the density curve —
 * so a blade the curve thins out is still culled, it is simply never laid
 * somewhere the curve did not ask for.
 *
 * THE WINDOW IS THE SHADER'S, not the buffer's. `setCenter` writes ONE uniform
 * and the vertex shader adds it to every blade's offset; the height comes from
 * the bake, so a slide costs nothing and can happen every frame. The centre is
 * quantised to the core's own spacing, so the blades land back on the same
 * lattice as they slide and the field never appears to move with the camera.
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
import { mapScale } from '../landscape';
import { regionSize } from './region';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import { WIND_FIELD_GLSL, type WindField } from '../wind';
import {
  FIELD_CORE,
  FIELD_REACH,
  GG_FIELD_GLSL,
  ggHeightGlsl,
  heightRes,
  RIM_DENSITY,
} from './height';
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
export const GRASS_COUNT_PROJECTION = 60000;
export const GRASS_COUNT_PHONE = 12000;

/**
 * The BASE field's budget, by tier (2026-09-16, user direction). 600 000 was
 * envpaint's own maximum and where this started; cut to 240 000 the same day
 * ("reduce the grass physics and density to help optimize" — the game was
 * glitchy at 200 creatures) with the near field cut to 60 000 alongside, so
 * the two fields are 2.4M triangles a pass instead of 6M. A handset draws
 * 40 000, keeping the six-to-one the pixel cap and the debris ceiling are
 * built on. The blade-width floor in pixels (`minBladePx`) is what keeps the
 * thinner field reading as a continuous meadow from the island view.
 */
export const GRASS_BASE_PROJECTION = 240000;
export const GRASS_BASE_PHONE = 40000;

/**
 * [D] World units the base field spans: the island's own bounding box. The
 * coast reaches about 176 units from the origin at its farthest bulge, so 360
 * covers every land texel with a margin, and the map's own meadow weight
 * (`uRegion`) is what decides which of those texels grow anything.
 */
export const GRASS_BASE_SPAN = 360;

/**
 * …and the span the base field is actually laid over: `GRASS_BASE_SPAN`
 * through `mapScale` (2026-09-16, the island doubled), so it still covers
 * every land texel of a coast that reaches ~352 units out. 720.
 *
 * THE BUDGET IS UNCHANGED, so the density per unit area is a QUARTER of what
 * it was and neighbouring blades stand twice as far apart (0.74 units → 1.47).
 * Two numbers absorb that, and both of them are about what a blade covers
 * rather than how many there are:
 */
export function grassBaseSpan(): number {
  return GRASS_BASE_SPAN * mapScale();
}

/**
 * [D] The base blade's width in world units, and the floor it keeps in
 * SCREEN PIXELS — `0.22 / 1.5` as authored, and `0.31 / 2.25` on the doubled
 * island (√2 and 1.5 on the two).
 *
 * The base field's job is the MID and FAR distance: inside `FIELD_REACH` of
 * the look-target the dense near field draws over it, and past the reach the
 * ghibli ground carries its own blade stipple, so what this field has to do
 * is bridge the two without reading as a thinning.
 *
 * WHY ONE BUMP EACH rather than one big one. At the zoom floor on a phone the
 * frame is ~1.9 world units a pixel, so a 0.31-unit blade is 0.16 of a pixel
 * before `minBladePx` clamps it — out there the FLOOR is the whole of what is
 * on screen, and the world width does nothing. At the default framing it is
 * the other way round: the near field owns everything inside 70 units of the
 * look-target and the world width is what reads on the band beyond it. So the
 * two numbers cover different distances and each takes a share of the factor
 * of four rather than either taking all of it. [D] Neither is measured off a
 * render — the numbers a render DID settle are the authored 0.22 / 1.5 — so
 * they are a starting point to tune, like `MOTION`'s own 1823ms.
 */
export function grassBaseBladeWidth(): number {
  return GRASS_BASE_BLADE_WIDTH * (mapScale() === 1 ? 1 : Math.SQRT2);
}

export function grassBaseMinBladePx(): number {
  return GRASS_BASE_MIN_BLADE_PX * (mapScale() === 1 ? 1 : 1.5);
}

/** The authored pair, at the island's authored size. */
export const GRASS_BASE_BLADE_WIDTH = 0.22;
export const GRASS_BASE_MIN_BLADE_PX = 1.5;

/** [D] How far a blade's normal leans to the ground's own up — see the
 * vertex shader, where it is the difference between a meadow and a grey
 * patch. 0.6 closed half the gap the cel shadow band opened (44 units of blue
 * down to 21, measured); 0.85 closes most of the rest, and the terminator is
 * still broken up by the painted noise inside `toonLight` rather than by the
 * blades' own facets.
 *
 * 0.94 and not 0.85 because of where the last of the blue was coming from: a
 * blade in the cel SHADOW band takes `shadowTint` (cool) plus a sixteenth of
 * the sky colour, so every blade still shaded put blue into the field's mean.
 * The flatter the field, the more of it shares the ground's own band. */
const NORMAL_UPRIGHT = 0.94;

/** [D] How far a dry patch goes toward the bleached colour — see the fragment. */
const DRY_MIX = 0.35;

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
 * [D] World units the field reaches across, by tier — twice
 * `FIELD_REACH` on a projection, and half of that on a handset, which holds a
 * quarter of the blades and a smaller screen to spend them on.
 */
export const GRASS_SPAN_PROJECTION = FIELD_REACH * 2;
export const GRASS_SPAN_PHONE = FIELD_REACH;



/**
 * The vertex source, built at MATERIAL TIME rather than at module time, and
 * that is load-bearing: `GG_MAP_SIZE` and the height bake's own span both ride
 * the island's scale, and the island is decided in `start` after every module
 * has been evaluated (src/world/scene.ts). A module-level template literal
 * would have frozen the 400-unit map into the shader.
 */
const vertexSource = (): string => /* glsl */ `
const float GG_SIZE = ${ggFloat(PAINTED_SIZE)};
const float GG_MAP_SIZE = ${ggFloat(regionSize())};
const float GG_TAU = 6.2831853;
${TOON_VARYINGS_GLSL}
${WIND_FIELD_GLSL}
${GG_WIND_NOISE_GLSL}
${ggHeightGlsl()}
${GG_FIELD_GLSL}

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
uniform float uUnitsPerPx;
uniform float uMinBladePx;
uniform float uLean;
uniform float uDirection;
uniform float uDirectionJitter;
uniform float uCombStrength;
uniform float uWindResponse;
uniform float uZoom;
/** 1 for the near field, 0 for the base field — see the header. */
uniform float uReach;

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
  // The BAKE's own square (see the header on GG_MAP_SIZE): on the doubled
  // island the geography spans 800 units where a painted layer spans 400.
  vec2 ruv = wpos / GG_MAP_SIZE + 0.5;

  float paint = texture2D(uGrass, luv).r;
  vec3 region = texture2D(uRegion, ruv).rgb;
  // b is exactly 1.0 in water and under 0.9 on land (region.ts) — one tap
  // answers both "am I wet" and "how close is the sea".
  float wet = step(0.95, region.b);
  // The brush wins where somebody painted; the map carries the rest.
  float grow = max(paint, uBaseDensity * region.r);
  grow *= 1.0 - 0.75 * region.g;
  grow *= 1.0 - wet;
  // The LOD's hard edge (see the header): the LAYOUT carries the density
  // curve, so the cull only has to know where the field stops — culling by the
  // curve as well would square it and leave the rim bare. The BASE field has
  // no window at all (uReach 0), and the map's own meadow weight above is what
  // decides where it grows.
  float base = grow * uDensity * mix(1.0, ggFieldReach(wpos), uReach);

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
  // …and in the height: a blade at the rim keeps RIM_HEIGHT of itself, so the
  // field thins in size as well as in count and there is no line where blades
  // stop (TASTE §2.1). The ground under it carries its own stipple from there
  // on (src/world/ghibli/ground.ts).
  bh *= mix(1.0, ggFieldHeight(wpos), uReach);
  // The width floor in pixels (see the header): a base blade ten units from
  // its neighbour has to stay legible when the camera pulls back, and a blade
  // under a pixel and a half wide is a flicker, not a blade.
  float widthUnits = max(uBladeWidth, uMinBladePx * uUnitsPerPx);
  float width = widthUnits * (1.0 - pow(t, 1.3));

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
  nrm = normalize(nrm + uSunDir * (aRand.w - 0.5) * 0.18 * (1.0 - 0.85 * far));
  // …and then mostly UPRIGHT [D]. A blade's own facet normal points every
  // which way, so about half the field landed in the cel SHADOW band, which
  // is hue-shifted cool (GHIBLI.shadowTint) — measured on screen, that put the
  // field 44 units of blue above the meadow it stands in and made the window
  // read as a grey patch even with every colour matched. A cel meadow is lit
  // as a field, not blade by blade: the normal leans toward the ground's own
  // up so the field takes the ground's band, keeping enough of its own tilt to
  // break the terminator up.
  nrm = normalize(mix(nrm, vec3(0.0, 1.0, 0.0), ${ggFloat(NORMAL_UPRIGHT)}));

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
  // The dry patches, at ${ggFloat(DRY_MIX)} rather than envpaint's 0.55 [D]:
  // sun-bleached yellow is the other thing that was lifting the field's blue
  // above the meadow's (measured, 2026-09-15), and a meadow with a third of it
  // bleached still reads as one that has had a dry week.
  col = mix(col, uColorDry, smoothstep(0.55, 0.9, vNoise) * ${ggFloat(DRY_MIX)});
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
  /** World units the field spans — the window's diameter for a radial field,
   * the box's side for a base one. */
  span?: number;
  /**
   * Which field this is (see the header): `radial` is the dense near field
   * around the look-target, `box` the base field over the whole island.
   * Defaults to `radial`.
   */
  layout?: 'radial' | 'box';
  /** Blade width in world units. The base field's blades are wider, because
   * they stand much farther apart. */
  bladeWidth?: number;
  /** [D] The floor a blade's width keeps in PIXELS — a blade thinner than
   * this flickers rather than reads (`setPixelScale`). */
  minBladePx?: number;
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
  /**
   * World units per screen pixel, from the camera rig — so a blade's width can
   * keep a floor in pixels however far back the camera is pulled. One uniform
   * write; call it with the zoom.
   */
  setPixelScale(unitsPerPx: number): void;
  dispose(): void;
}

/**
 * Build the blade field. Nothing is added to a scene here — the caller owns
 * that, and owns hiding the mesh on the `ink` style (docs/ghibli-port.md).
 */
export function createGrassField(opts: GrassFieldOptions): GrassField {
  const span = Math.max(1, opts.span ?? PAINTED_SIZE);
  const layout = opts.layout ?? 'radial';
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
    uBladeWidth: { value: opts.bladeWidth ?? DEFAULTS.bladeWidth },
    // World units a pixel, and the width floor in pixels: the shader takes
    // whichever is wider, so a blade is never thinner than it can be drawn.
    uUnitsPerPx: { value: 0.05 },
    uMinBladePx: { value: opts.minBladePx ?? 0 },
    uLean: { value: DEFAULTS.lean },
    uDirection: { value: DEFAULTS.direction },
    uDirectionJitter: { value: DEFAULTS.directionJitter },
    uCombStrength: { value: DEFAULTS.combStrength },
    uWindResponse: { value: DEFAULTS.windResponse },
    uZoom: { value: DEFAULTS.zoom },
    uCenter: { value: new Vector2(0, 0) },
    uSpan: { value: span },
    uReach: { value: (opts.layout ?? 'radial') === 'box' ? 0 : 1 },
    uHeight: { value: (opts.height ?? restGrass) as Texture },
    uHeightRes: { value: heightRes() },
    uColorBase: { value: new Color(GHIBLI.grassBase) },
    uColorTip: { value: new Color(GHIBLI.grassTip) },
    uColorDry: { value: new Color(GHIBLI.grassDry) },
  };

  const material = new ShaderMaterial({
    name: 'ghibli-grass',
    uniforms,
    vertexShader: vertexSource(),
    fragmentShader: FRAGMENT,
    side: DoubleSide,
  });

  let count = Math.max(1, Math.round(opts.count ?? GRASS_COUNT_PROJECTION));
  let centerX = 0;
  let centerZ = 0;
  /** The core's own blade spacing, and the quantum `setCenter` snaps to — a
   * slide of less than this is a slide nobody can see, which is what keeps the
   * field from appearing to travel with the camera. */
  const cell = Math.max(0.02, Math.sqrt((Math.PI * FIELD_CORE * FIELD_CORE) / Math.max(1, count)));

  /**
   * The radial CDF of `ggFieldDensity` over the reach, inverted — so an
   * instance drawn uniformly lands where the density curve wants it.
   *
   * Built once per count, on the SAME curve the shader culls with (kept in
   * step by `RIM_DENSITY` and the core fraction, both imported), and
   * deterministic: 512 bins of the same arithmetic on every device.
   */
  const CDF_BINS = 512;
  const radiusTable = ((): Float32Array => {
    const reach = span / 2;
    const core = FIELD_CORE / reach;
    // Blades per unit area at radius r (relative), times the annulus' own
    // area — the weight each ring of the field carries.
    const weight = new Float32Array(CDF_BINS + 1);
    let total = 0;
    for (let i = 0; i <= CDF_BINS; i++) {
      const r = i / CDF_BINS;
      // The shader's own curve, term for term (ggFieldDensity): flat through
      // the core, then 1/r², clamped at the rim. The two must not drift — a
      // layout on one curve and a cull on another is a bare ring.
      const density = Math.max(RIM_DENSITY, Math.min(1, (core / Math.max(r, 1e-4)) ** 2));
      total += density * r;
      weight[i] = total;
    }
    // Invert: for each uniform u, the radius whose cumulative weight is u.
    const table = new Float32Array(CDF_BINS + 1);
    let bin = 0;
    for (let i = 0; i <= CDF_BINS; i++) {
      const target = (i / CDF_BINS) * total;
      while (bin < CDF_BINS && weight[bin]! < target) bin++;
      table[i] = (bin / CDF_BINS) * reach;
    }
    return table;
  })();
  const radiusAt = (u: number): number => {
    const t = Math.min(0.999999, Math.max(0, u)) * CDF_BINS;
    const i = Math.floor(t);
    const f = t - i;
    return radiusTable[i]! * (1 - f) + radiusTable[i + 1]! * f;
  };

  /**
   * Lay `n` blades RADIALLY and WINDOW-LOCAL: a seeded angle, a radius drawn
   * through the curve above, and the vertex shader adds `uCenter`. Runs once
   * per count and never again as the window slides.
   */
  const lay = (n: number, offsets: Float32Array, rands: Float32Array): void => {
    const rand = mulberry32(GRASS_SEED);
    if (layout === 'box') {
      // The BASE field: a seeded jittered grid over the island's bounding box,
      // uniform per unit area, and the map's own meadow weight (read in the
      // shader) is what decides which cells grow anything at all.
      const k = Math.ceil(Math.sqrt(n));
      const cellSize = span / k;
      const half = span / 2;
      for (let i = 0; i < n; i++) {
        const gx = i % k;
        const gz = (i / k) | 0;
        offsets[i * 2] = -half + (gx + 0.5 + (rand() - 0.5) * 0.95) * cellSize;
        offsets[i * 2 + 1] = -half + (gz + 0.5 + (rand() - 0.5) * 0.95) * cellSize;
        rands[i * 4] = rand();
        rands[i * 4 + 1] = rand();
        rands[i * 4 + 2] = rand();
        rands[i * 4 + 3] = rand();
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      // The golden angle keeps successive blades from lining up into spokes,
      // with the per-blade jitter breaking the spiral itself up.
      const angle = i * 2.39996323 + (rand() - 0.5) * 0.9;
      const r = radiusAt((i + rand()) / n);
      offsets[i * 2] = Math.cos(angle) * r;
      offsets[i * 2 + 1] = Math.sin(angle) * r;
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
      // The BASE field covers the island and has nowhere to slide to: moving
      // it would drag the whole meadow along with the camera.
      if (layout === 'box') return;
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
    setPixelScale(unitsPerPx: number): void {
      uniforms.uUnitsPerPx.value = Math.max(1e-4, unitsPerPx);
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
