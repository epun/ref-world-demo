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
import { ggShoreGlsl } from './shore';
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

/** [D] How far the translucent shallows reach, and where the deep begins —
 * world units from the shore. The shallows GRADE (the bed shows through and
 * fades out with depth); the deep's edge is a painted step with the pen's
 * wobble in it. */
const SHALLOW_OUT = 6;
const DEEP_IN = 14;

/** [D] The foam at the waterline: how wide the rim is, how far out the trailing
 * streaks reach, and the noise thresholds that ERODE the inner edge — the rim
 * has to break up irregularly rather than end on a contour. */
const FOAM_BAND = 2.2;
const FOAM_ERODE = 0.42;
const FOAM_STREAK_OUT = 4.5;
const FOAM_STREAK_KEEP = 0.62;

/** [D] The sparkle: pinpoints, not dabs (2026-09-16, user reference — the
 * reference's glints are single bright pixels scattered over the whole
 * surface). A cell a bit over a world unit, one in twenty-five cells holding
 * one, and a dot a twentieth of a unit across — about one screen pixel at the
 * default view, two at a step in. Each fades in and out over `SPARKLE_BEAT`
 * seconds on its own phase, so the field twinkles and nothing pops. */
const SPARKLE_CELL = 1.3;
const SPARKLE_KEEP = 0.04;
const SPARKLE_SIZE = 0.055;
const SPARKLE_BEAT = 1.6;

/** [D] The painterly swell: big soft blotches of value across the deep, their
 * scale in world units and how far they move the value. */
const SWELL_SCALE = 15;
const SWELL_VALUE = 0.08;

/** [D] The pale wave lines: sparse and short, never a stripe field. */
const LINE_SPACING = 7;
const LINE_THICK = 0.14;
const LINE_LENGTH = 5;
const LINE_DRIFT = 0.35;
const LINE_KEEP = 0.78;

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

/**
 * Built at MATERIAL TIME, not at module time: the shore bake's span rides the
 * island's scale, which is decided in `start` after every module has been
 * evaluated (src/world/scene.ts).
 */
const fragmentSource = (): string => /* glsl */ `
const float GG_SIZE = ${ggFloat(PAINTED_SIZE)};
${TOON_LIGHTING_GLSL}
${WIND_FIELD_GLSL}
${ggShoreGlsl()}

uniform sampler2D uRippleTex;
uniform float uRippleVis;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uBed;
uniform vec3 uFoam;
uniform vec3 uLace;
uniform vec3 uLine;
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
  // keyed on WORLD xz — never a vertex attribute, which is what put white
  // wedges across the lake, and never anything in a camera frame, which is
  // what would make the surface spin against the view.
  float shore = max(ggShoreAt(p), 0.0);

  // The direction the surface is going: the authored flow, nudged by the
  // world's own wind on a still body and driven by it on the open sea. A WORLD
  // vector, so every mark below travels over the ground and not the screen.
  vec2 drift = refWindAt(p, uWindTime * 0.18, uWindDir, uWindStrength, uWindGust);
  vec2 flowVec = uFlowDir + drift * uDrift;
  float flowLen = length(flowVec);
  vec2 dir = flowLen > 1e-4 ? flowVec / flowLen : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  // The pen: two low-frequency wobbles, one still and one crawling with the
  // flow, so every hard edge below is hand-drawn rather than ruled.
  float wob = toonFbm(p * 0.55, 2) * 1.3333 - 0.5;
  float wobF = toonFbm(p * 0.8 - dir * (uWindTime * ${ggFloat(ADVECT)}), 2) * 1.3333 - 0.5;

  // ── the body: a translucent shallow over a dark teal deep ────────────────
  // THE SHALLOWS GRADE and the deep STEPS. Near a shore the bed shows through
  // — the beach's own sand pulled toward the water's turquoise, so it reads as
  // sand under water rather than turquoise paint — and it fades into the body
  // colour across the first several units. Out past DEEP_IN the painted step
  // into the deep is a hard edge with the pen's wobble in it.
  vec3 bed = mix(uShallow, uBed, 0.55);
  float shallowT = smoothstep(0.0, ${ggFloat(SHALLOW_OUT)} + wob * 1.2, shore);
  vec3 albedo = mix(bed, uMid, shallowT);
  // The deep's edge is a PAINTED transition, not a cut: a hard step here drew
  // the lake's deepest lobe as a dark stain with an edge you could trace
  // (measured on screen, 2026-09-16). Two and a half units of smoothstep keeps
  // the painted read and loses the stain.
  albedo = mix(albedo, uDeep, smoothstep(
    ${ggFloat(DEEP_IN - 2.5)} + wob * 2.0,
    ${ggFloat(DEEP_IN + 2.5)} + wob * 2.0,
    shore
  ));

  // ── the painterly swell ──────────────────────────────────────────────────
  // Big soft blotches of value drifting slowly across the whole surface: the
  // undulation a painted sea has instead of a normal map. Nothing here is a
  // step, and nothing arrests (TASTE §2.1).
  float blotch = toonFbm(p / ${ggFloat(SWELL_SCALE)} - dir * (uWindTime * 0.06), 2) * 1.3333;
  albedo *= 1.0 + (blotch - 0.5) * ${ggFloat(SWELL_VALUE * 2.0)};
  // …and, on the open sea only, the long shoreward swell on top of it.
  float swellPhase = (shore + uWindTime * ${ggFloat(SWELL_SPEED)}) / ${ggFloat(SWELL_SPACING)};
  albedo *= 1.0 - 0.04 * smoothstep(0.35, 0.5, fract(swellPhase + wob * 0.05)) * uSwell;

  // ── pale wave lines ──────────────────────────────────────────────────────
  // Short, sparse strokes lying across the flow and drifting with it: a
  // stripe field cut into lengths, with most of the lanes thrown away so the
  // result is a few marks rather than a pattern.
  float across = dot(p, perp) + toonFbm(p * 0.18, 2) * 7.0;
  float along = dot(p, dir) - uWindTime * ${ggFloat(LINE_DRIFT)};
  float laneId = floor(across / ${ggFloat(LINE_SPACING)});
  float lane = fract(across / ${ggFloat(LINE_SPACING)});
  float lineBody = 1.0 - smoothstep(0.0, ${ggFloat(LINE_THICK / LINE_SPACING)},
    abs(lane - 0.5 - wob * 0.06));
  float dash = toonFbm(vec2(along / ${ggFloat(LINE_LENGTH)}, laneId * 3.7), 2) * 1.3333;
  float lines = lineBody * smoothstep(${ggFloat(LINE_KEEP)}, ${ggFloat(LINE_KEEP + 0.12)}, dash);
  lines *= smoothstep(${ggFloat(SHALLOW_OUT)}, ${ggFloat(SHALLOW_OUT * 2.0)}, shore);
  albedo = mix(albedo, uLine, lines * 0.7);

  // ── the sparkle ──────────────────────────────────────────────────────────
  // Pinpoints: one bright pixel in a cell a world unit across, a twenty-fifth
  // of the cells holding one, each breathing in and out over a second and a
  // half on its own phase — so the field twinkles, nothing blinks, and nothing
  // appears at full brightness (TASTE §2.1). The whole lattice DRIFTS with the
  // flow, so the sparkle travels over the ground with the water.
  vec2 sp = p - dir * (uWindTime * 0.22);
  vec2 cell = floor(sp / ${ggFloat(SPARKLE_CELL)});
  float pick = toonHash21(cell);
  vec2 spot = (cell + vec2(toonHash21(cell + 4.7), toonHash21(cell + 9.1)))
    * ${ggFloat(SPARKLE_CELL)};
  float beat = 0.5 + 0.5 * sin(uWindTime * ${ggFloat(2.0 * 3.14159265 / SPARKLE_BEAT)}
    + pick * 6.2831853);
  float fleck = (1.0 - smoothstep(0.0, ${ggFloat(SPARKLE_SIZE)}, length(sp - spot)))
    * step(pick, ${ggFloat(SPARKLE_KEEP)})
    * smoothstep(0.45, 1.0, beat);
  // Denser out on the deep water than in the shallows, which is where the
  // reference puts them.
  fleck *= mix(0.25, 1.0, smoothstep(2.0, ${ggFloat(DEEP_IN)}, shore));
  albedo = mix(albedo, uHighlight, fleck);

  // ── the foam rim ─────────────────────────────────────────────────────────
  // A soft white rim hugging every land edge, its INNER edge eroded by noise
  // so it breaks up irregularly, plus a few thin streaks trailing off it into
  // the water. Both crawl with the flow; neither is a contour.
  float foamPen = toonFbm(p * 1.9 - dir * (uWindTime * 0.3), 3) * 1.3333;
  float rim = 1.0 - smoothstep(0.0, ${ggFloat(FOAM_BAND)}, shore);
  // The erosion: the further out, the more noise a texel needs to still be
  // foam, so the rim is solid at the waterline and ragged at its inner edge.
  float foam = smoothstep(0.0, 0.35, rim - ${ggFloat(FOAM_ERODE)} * (1.0 - foamPen));
  // The streaks: long thin tongues of the same pen, reaching out past the rim.
  float streakPen = toonFbm(vec2(dot(p, perp) * 1.6, dot(p, dir) * 0.22
    - uWindTime * 0.12), 2) * 1.3333;
  float streak = smoothstep(${ggFloat(FOAM_STREAK_KEEP)}, ${ggFloat(FOAM_STREAK_KEEP + 0.1)},
    streakPen) * (1.0 - smoothstep(${ggFloat(FOAM_BAND)}, ${ggFloat(FOAM_STREAK_OUT)}, shore));
  albedo = mix(albedo, uLace, clamp(foam + streak * 0.35, 0.0, 1.0));

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
      uBed: { value: new Color(GHIBLI.sand).lerp(new Color(GHIBLI.waterBed), 0.62) },
      uLine: { value: new Color(GHIBLI.waterLine) },
      uSwell: { value: opts.swell ?? 0 },
      uHighlight: { value: new Color(GHIBLI.waterHighlight) },
      uDepthScale: { value: opts.depthScale ?? DEPTH_SCALE },
      uHighlightAmount: { value: opts.highlightAmount ?? 0.6 },
      uFlowDir: { value: new Vector2(opts.flow?.x ?? 0, opts.flow?.z ?? 0) },
      uDrift: { value: opts.drift ?? 0.12 },
    },
    vertexShader: VERTEX,
    fragmentShader: fragmentSource(),
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
    { deep: GHIBLI.waterTealDeep, mid: GHIBLI.waterTeal, shallow: GHIBLI.waterShallow },
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
    { deep: GHIBLI.waterTealDeep, mid: GHIBLI.waterTeal, shallow: GHIBLI.seaShallow },
    // The swell belongs to the ocean and to nothing else: a lake has no fetch.
    { drift: SEA_DRIFT, swell: 1, ...opts },
  );
}
