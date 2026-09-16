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
import { GG_SHORE_GLSL } from './shore';
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

// ── the painted read (2026-09-16, user direction: Ponyo / Kiki / Totoro) ─────
// FLAT saturated water with hand-painted marks on it, not a simulation. Every
// number here is a world distance or a world-space frequency, because the
// whole surface is anchored to the ground and not to the screen: a pattern in
// any camera frame appears to spin against the view when the camera turns,
// which is exactly what a user reported.

/** [D] Where the turquoise shallows give way to the mid blue, and the mid blue
 * to the cobalt deep — world units from the shore. */
const SHALLOW_OUT = 4;
const DEEP_IN = 14;

/** [D] The foam lace at the waterline: the band's width, the second line's
 * offset beyond it, and how broken each is (the noise threshold that cuts the
 * lace — higher is more gaps). */
const LACE_BAND = 1.6;
const LACE_SECOND = 1.1;
const LACE_BREAK = 0.46;
const LACE_SECOND_BREAK = 0.6;

/** [D] The pale wave lines across the deep: their spacing, their thickness,
 * their length, and how far they travel a second. */
const LINE_SPACING = 5;
const LINE_THICK = 0.15;
const LINE_LENGTH = 9;
const LINE_DRIFT = 0.35;

/** [D] The glint dabs: the grid they are hashed on (world units), how few of
 * those cells hold one, and how big the dab is in world units — two to four
 * pixels at the default view. */
const GLINT_CELL = 7;
const GLINT_KEEP = 0.055;
const GLINT_SIZE = 0.13;

/** [D] The sea's long swell: how far apart the crests are and how fast they
 * travel shoreward. */
const SWELL_SPACING = 34;
const SWELL_SPEED = 1.5;

const VERTEX = /* glsl */ `
${TOON_VARYINGS_GLSL}

void main() {
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
${GG_SHORE_GLSL}

uniform sampler2D uRippleTex;
uniform float uRippleVis;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uLace;
uniform vec3 uLine;
uniform vec3 uWet;
uniform vec3 uHighlight;
uniform float uDepthScale;
uniform float uHighlightAmount;
uniform vec2 uFlowDir;
uniform float uDrift;
uniform float uSwell;

uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindGust;

void main() {
  vec2 p = vToonWorldPos.xz;
  vec2 uv = p / GG_SIZE + 0.5;
  vec3 n = normalize(vToonNormal);

  // Distance to the shoreline, from the BAKE (src/world/ghibli/shore.ts) and
  // keyed on WORLD xz — never a vertex attribute, which is what put huge white
  // wedges across the lake, and never anything in a camera frame, which is
  // what would make the surface spin against the view.
  float shore = max(ggShoreAt(p), 0.0);

  // The direction the surface is going: the authored flow, nudged by the
  // world's own wind on a still body and driven by it on the open sea. A WORLD
  // vector, so the marks below travel over the ground rather than over the
  // screen.
  vec2 drift = refWindAt(p, uWindTime * 0.18, uWindDir, uWindStrength, uWindGust);
  vec2 flowVec = uFlowDir + drift * uDrift;
  float flowLen = length(flowVec);
  vec2 dir = flowLen > 1e-4 ? flowVec / flowLen : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  // The pen: two low-frequency wobbles, one still and one crawling with the
  // flow, so every hard edge below is hand-drawn rather than ruled.
  float wob = toonFbm(p * 0.55, 2) * 1.3333 - 0.5;
  float wobF = toonFbm(p * 0.8 - dir * (uWindTime * ${ggFloat(ADVECT)}), 2) * 1.3333 - 0.5;

  // ── three flat tones, hard edges ────────────────────────────────────────
  // Turquoise in the shallows, mid blue, cobalt in the deep, and the
  // boundaries between them are STEPS with the pen's wobble in them — a
  // painted band, never a gradient.
  float shallowEdge = ${ggFloat(SHALLOW_OUT)} + wob * 1.4;
  float deepEdge = ${ggFloat(DEEP_IN)} + wob * 3.0;
  vec3 albedo = uShallow;
  albedo = mix(albedo, uMid, step(shallowEdge, shore));
  albedo = mix(albedo, uDeep, step(deepEdge, shore));

  // ── the long swell (the sea only) ───────────────────────────────────────
  // A very faint darker band travelling shoreward. uSwell is 0 on a lake.
  float swellPhase = (shore + uWindTime * ${ggFloat(SWELL_SPEED)}) / ${ggFloat(SWELL_SPACING)};
  float swell = smoothstep(0.35, 0.5, fract(swellPhase + wob * 0.05));
  albedo *= 1.0 - 0.05 * swell * uSwell;

  // ── pale wave lines across the deep ─────────────────────────────────────
  // Long, nearly parallel strokes drifting in the flow: a stripe field ACROSS
  // the flow, cut into 5-to-12-unit lengths along it, each stroke's centre
  // wobbled by the pen so no two are the same line and none of it is a grid.
  float across = dot(p, perp) + toonFbm(p * 0.18, 2) * 6.0;
  float along = dot(p, dir) - uWindTime * ${ggFloat(LINE_DRIFT)};
  float lane = fract(across / ${ggFloat(LINE_SPACING)});
  float laneId = floor(across / ${ggFloat(LINE_SPACING)});
  float lineBody = 1.0 - smoothstep(0.0, ${ggFloat(LINE_THICK / LINE_SPACING)},
    abs(lane - 0.5 - wob * 0.06));
  // …in dashes along the lane, with the dash pattern hashed per lane so the
  // strokes never line up end to end.
  float dash = toonFbm(vec2(along / ${ggFloat(LINE_LENGTH)}, laneId * 3.7), 2) * 1.3333;
  float lines = lineBody * smoothstep(0.52, 0.66, dash);
  // Only out in the water, and fading in rather than appearing (TASTE §2.1).
  lines *= smoothstep(${ggFloat(SHALLOW_OUT)}, ${ggFloat(SHALLOW_OUT * 2.0)}, shore);
  albedo = mix(albedo, uLine, lines * 0.85);

  // ── glint dabs ──────────────────────────────────────────────────────────
  // Small bright dabs on a hashed world grid, each breathing on the ambient
  // beat with its own phase, so one is always arriving and none of them pops.
  vec2 cell = floor(p / ${ggFloat(GLINT_CELL)});
  float pick = toonHash21(cell);
  vec2 spot = (cell + vec2(toonHash21(cell + 11.3), toonHash21(cell + 27.1)))
    * ${ggFloat(GLINT_CELL)};
  float beat = 0.5 + 0.5 * sin(uWindTime * ${ggFloat(2.0 * 3.14159265 / 6.0)}
    + pick * 6.2831853);
  float dab = (1.0 - smoothstep(0.0, ${ggFloat(GLINT_SIZE)}, length(p - spot)))
    * step(pick, ${ggFloat(GLINT_KEEP)}) * smoothstep(0.55, 1.0, beat);
  dab *= step(${ggFloat(SHALLOW_OUT)}, shore);
  albedo = mix(albedo, uHighlight, dab);

  // ── the foam lace ───────────────────────────────────────────────────────
  // A broken white band at the waterline, and a second thinner line a unit
  // further out that comes and goes. Both are noise-CUT, so they read as lace
  // rather than as a stripe, and both crawl with the flow.
  float lacePen = toonFbm(p * 2.6 - dir * (uWindTime * 0.35), 2) * 1.3333;
  float band = 1.0 - smoothstep(0.0, ${ggFloat(LACE_BAND)}, shore);
  float lace = band * step(${ggFloat(LACE_BREAK)}, lacePen + band * 0.35);
  float secondPen = toonFbm(p * 2.1 + dir * (uWindTime * 0.22) + 19.7, 2) * 1.3333;
  float second = (1.0 - smoothstep(0.0, 0.55,
    abs(shore - ${ggFloat(LACE_BAND + LACE_SECOND)})))
    * step(${ggFloat(LACE_SECOND_BREAK)}, secondPen);
  albedo = mix(albedo, uLace, clamp(lace + second * 0.8, 0.0, 1.0));
  // The wet line where the water meets the sand: a darker hair under the lace.
  float wet = (1.0 - smoothstep(0.0, 0.35, shore)) * (1.0 - lace);
  albedo = mix(albedo, uWet, wet * 0.5);

  // Rain rings and rock impacts. Flat at rest (a 1×1 texel) until the sim
  // lands — see the header.
  float rip = texture2D(uRippleTex, uv).r * uRippleVis;
  albedo = mix(albedo, uShallow, step(0.30, rip));
  albedo = mix(albedo, uFoam, step(0.62, rip));

  // Flat fills only: one two-band ramp on the surface normal, no per-pixel
  // normal shading and no specular.
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
  /** How much long swell the surface carries — 1 on the open sea, 0 on a
   * lake, which has no fetch to build one. */
  swell?: number;
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
      uShoreTex: { value: flat as Texture },
      uShoreOn: { value: 0 },
      uRippleVis: { value: 5 },
      uDeep: { value: new Color(palette.deep) },
      uMid: { value: new Color(palette.mid) },
      uShallow: { value: new Color(palette.shallow) },
      uFoam: { value: new Color(GHIBLI.foam) },
      uLace: { value: new Color(GHIBLI.waterLace) },
      uLine: { value: new Color(GHIBLI.waterLine) },
      uSwell: { value: opts.swell ?? 0 },
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
    // A fill is coplanar with the basin floor it sits on, and the camera's far
    // plane is 3600 units out — the same bias the shipped fill and the shadow
    // stamps carry (src/world/water.ts, the lifts).
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // The rest texel belongs to the material: disposing one disposes the other.
  material.userData.restRipple = flat;
  return material;
}

/**
 * Point a surface material at the baked shore field, or at nothing.
 *
 * With no bake the surface renders as open water rather than as a sheet of
 * foam, which is the honest fallback: a body whose shoreline nobody has baked
 * is a body whose edge we do not know.
 */
export function setShoreTexture(material: ShaderMaterial, shore: Texture | null): void {
  const u = material.uniforms;
  if (!u.uShoreTex) return;
  u.uShoreTex!.value = shore ?? (material.userData.restRipple as Texture);
  u.uShoreOn!.value = shore ? 1 : 0;
}

/**
 * The lake / pond / river fill. Three flat blues from `GHIBLI.water*`.
 *
 * The caller hands over the baked shore field (`setShoreTexture`); the fill's
 * own geometry carries nothing but its position.
 */
export function createWaterSurfaceMaterial(opts: WaterSurfaceOptions = {}): ShaderMaterial {
  return build(
    'ghibli-water',
    { deep: GHIBLI.waterCobalt, mid: GHIBLI.waterMid, shallow: GHIBLI.waterShallow },
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
    { deep: GHIBLI.waterCobalt, mid: GHIBLI.seaDeep, shallow: GHIBLI.seaShallow },
    // The swell belongs to the ocean and to nothing else: a lake has no fetch.
    { drift: SEA_DRIFT, swell: 1, ...opts },
  );
}
