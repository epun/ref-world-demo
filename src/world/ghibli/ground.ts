/**
 * The ground — envpaint's `Terrain` shader (src/core/Terrain.js
 * `_buildMaterial`) as a drop-in for `src/world/ground.ts`'s one material on
 * the `ghibli` style (docs/TASTE.md §9, docs/ghibli-port.md).
 *
 * WHAT IT ADDS over the shipped unlit paper: a meadow that goes lush under
 * painted grass, a dirt path with a darker edge band, a charred rim around an
 * ash core where a fire burnt, wet sand in the shallows, rock on genuinely
 * steep faces with a noisy edge, snow above a noisy height line — and the
 * BEACH the tropical island asked for (2026-09-15): sand where the baked
 * region says beach, going to `sandWet` in the last units before the
 * waterline.
 *
 * WHAT IT MUST NOT LOSE. The shipped ground DRAWS ITS OWN TERRAIN: an ink
 * line along the lip of every terrace riser, sparse stroke hatching down the
 * riser's face, the painted trail's broken rim and stipple, and the fire's
 * scorch. Without them a terraced field and a flat one are the same picture —
 * that is a user report, not a theory (src/world/ground.ts's header). So the
 * whole mark block is REPLICATED here, function for function and constant for
 * constant, with a `gg` prefix on the noise chain so this shader can declare
 * it beside the shared `toon*` chain without a duplicate definition. Keep the
 * two in step: a dial changed there and not here shows up as marks in the
 * wrong place on one style only.
 *
 * THE VERTEX SHADER IS THE SIMPLE ONE. envpaint displaces its ground from a
 * height texture; here the geometry arrives already displaced from the
 * `Surface` seam (`src/world/surface.ts` — the only legal height source,
 * CLAUDE.md), so this only forwards world position and world normal.
 *
 * No shadow map, no material grain (TASTE §2.4, §2.7).
 */

import { Color, ShaderMaterial, Vector2, type Texture } from 'three';
import { GHIBLI, MOTION } from '../../taste/tokens';
import { TERRAIN, terrainParams } from '../landscape';
import { PAINTED_SIZE } from '../painted';
import { TOON_LIGHTING_GLSL, TOON_VARYINGS_GLSL, toonUniforms } from '../toon';
import { GG_FIELD_GLSL } from './height';
import { emptyLayerTexture, ggFloat } from './shared';

// ── the shipped ground's mark dials, mirrored (src/world/ground.ts) ─────────

const GROUND_DRIFT_PER_S = 0.05 / (MOTION.ambientMs / 1000);
const RISER_IN = 0.012;
const RISER_FULL = 0.045;
const NOISE_SCALE = 0.35;
const HATCH_WOBBLE = 0.12;
const LIP_WOBBLE = 0.06;
const STROKES_PER_TIER = 5;
const STROKE_IN: [number, number] = [0.5, 0.58];
const STROKE_OUT: [number, number] = [0.78, 0.86];
const HATCH_INK = 0.9;
const LIP_BAND: [number, number, number, number] = [0.06, 0.02, 0.0, 0.03];
const LIP_SLOPE: [number, number] = [0.003, 0.012];
const PATH_RIM = 0.22;
const PATH_RIM_BAND = 0.13;
const PATH_IN: [number, number] = [0.12, 0.34];
const PATH_SPECK_SCALE = 2.9;
const PATH_SPECK_IN: [number, number] = [0.6, 0.72];
const PATH_BREAK_IN: [number, number] = [0.38, 0.56];
const PATH_RIM_INK = 0.72;
const PATH_SPECK_INK = 0.5;
const SCORCH_IN: [number, number] = [0.08, 0.55];
const SCORCH_SPECK_SCALE = 4.3;
const SCORCH_SPECK_IN: [number, number] = [0.42, 0.62];
const SCORCH_INK = 0.82;

/** [D] Height above which snow takes the ground, world units. envpaint's 7.0
 * on a map whose terraces top out near 8 — so the tallest tier catches it. */
const SNOW_HEIGHT = 7;

/**
 * [D] The blade STIPPLE (2026-09-16, user direction: the ground *"must look
 * like grass everywhere the blades are not"* — the eye reads texture against
 * no-texture long after the colours match, and the field's window was still
 * plainly an oval).
 *
 * Cycles a world unit ACROSS the strokes, and how far they are stretched
 * ALONG them: 3.5 and 3:1, so at the default view (0.05 units a pixel) a
 * stroke is about six pixels long and a pixel and a half wide — a blade, seen
 * from where the blades are drawn. The direction is world (1,1) normalised,
 * which is very nearly screen-vertical under this world's isometric camera
 * (azimuth 45°), so the strokes stand up the way the blades do.
 *
 * `VALUE` is the modulation the strokes carry, `TIP` how far a bright stroke
 * goes toward the blade tip's own colour, and `SPECK` the sparse single-texel
 * scatter that stands in for the tips and roots the far field would have.
 * Every one of them is tuned so the ground's own texture CONTRAST matches the
 * blade field's — measured as the local standard deviation of luminance in a
 * 32×32 pixel patch at the dense middle of the frame against one at its far
 * corner. At ±7% of value the corner came back a third flatter than the
 * middle (sd 5.6 against 8.35); ±12% brought the corner to 6.0 against 7.9,
 * and ±15% is where the two stop being distinguishable. The last of the
 * spread is the ground ITSELF: a dirt path has no grass texture on it, which
 * is the point of weighting the stipple by how much grass grows here.
 */
const STIPPLE_CYCLES = 3.5;
const STIPPLE_STRETCH = 3;
const STIPPLE_VALUE = 0.3;
const STIPPLE_TIP = 0.18;
const STIPPLE_SPECK_CYCLES = 7;
const STIPPLE_SPECK = 0.22;

/**
 * [D] How far the meadow goes toward the blade field's own colour INSIDE the
 * field's window.
 *
 * Not a global tint any more (2026-09-15, user direction): the ground is
 * tinted where the blades are, through the SAME squircle fade the blades
 * themselves shorten on (`ggWindow`), so the two meet by construction and
 * there is no seam to measure. Outside the window the meadow is the meadow.
 *
 * Nearly all of the way, because that is what makes the match: what is left of
 * the meadow under it is the ground's own value break-up, which a real blade
 * field shows between its blades anyway.
 */
const BLADE_GROUND_MIX = 0.92;

/** [D] Where the wet-sand band sits inside the region texture's water-proximity
 * ramp. `region.ts` encodes land as `0.9 · (1 − d / WATER_NEAR)`, so 0.62
 * is roughly the last two world units before the waterline. */
const WET_SAND_IN = 0.62;

const VERTEX = /* glsl */ `
${TOON_VARYINGS_GLSL}

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vToonWorldPos = world.xyz;
  // The displacement is already in the attribute, so these normals ARE the
  // terraces (src/world/ground.ts recomputes them after every displace).
  vToonNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */ `
const float GG_SIZE = ${ggFloat(PAINTED_SIZE)};
${TOON_LIGHTING_GLSL}
${GG_FIELD_GLSL}

uniform sampler2D uGrass;
uniform sampler2D uPath;
uniform float uPathOn;
uniform sampler2D uScorch;
uniform float uScorchOn;
uniform sampler2D uRegion;

uniform vec3 uMeadow;
uniform vec3 uLush;
uniform vec3 uBladeField;
uniform vec3 uBladeTip;
uniform vec3 uDirt;
uniform vec3 uDirtEdge;
uniform vec3 uWetSand;
uniform vec3 uRock;
uniform vec3 uSnow;
uniform vec3 uAsh;
uniform vec3 uChar;
uniform vec3 uSand;
uniform vec3 uSandWet;
uniform vec3 uSandDark;
uniform float uSnowHeight;

uniform vec3 uInk;
uniform float uStep;
uniform vec2 uRiser;
uniform float uGroundTime;

// The shipped ground's own two-octave value noise, gg-prefixed so it can
// stand beside the shared toon chain (src/world/ground.ts groundNoiseGlsl).
float ggGroundHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float ggGroundVNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(ggGroundHash(i), ggGroundHash(i + vec2(1.0, 0.0)), u.x),
    mix(ggGroundHash(i + vec2(0.0, 1.0)), ggGroundHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float ggGroundNoise(vec2 p) {
  return 0.6 * ggGroundVNoise(p) + 0.4 * ggGroundVNoise(p * 2.07 + 11.3);
}

void main() {
  vec2 uv = vToonWorldPos.xz / GG_SIZE + 0.5;
  vec3 n = normalize(vToonNormal);

  vec3 region = texture2D(uRegion, uv).rgb;
  // TWO grass terms, and the difference matters.
  //
  // painted is somebody's brushstroke, and it is what turns the meadow LUSH
  // — a darker, richer green than the meadow token. Driving that from the
  // map's own meadow weight instead (which is 1 over the whole meadow) turned
  // the entire ground lush and left the blade field's window reading as a pale
  // patch on a dark lawn: measured on screen, 2026-09-15.
  //
  // grass is where it stands at all, brush or map, and it is what the
  // blade-field tint below rides — so the ground takes the FIELD's colour
  // exactly where the field is drawn and the meadow's everywhere else.
  float painted = clamp(texture2D(uGrass, uv).r, 0.0, 1.0);
  float grass = clamp(max(painted, region.r), 0.0, 1.0);
  float path = texture2D(uPath, uv).r * step(0.5, uPathOn);
  float burn = texture2D(uScorch, uv).r * step(0.5, uScorchOn);

  // Meadow -> lush green under dense grass.
  vec3 albedo = mix(uMeadow, uLush, pow(painted, 0.7));
  // …and then toward the BLADE FIELD's own colour, INSIDE THAT FIELD and on
  // the same radial curve the blades thin on: where the blades are,
  // the ground under them is their colour; where they have faded out, it is the
  // meadow again; in between, both cross over together. That is what makes the
  // window invisible rather than a pale lozenge on the lawn, which is what the
  // first render showed (2026-09-15). uBladeField is the colour a blade
  // collapses to when it is too far away to draw — the same field, at two
  // distances, rather than two different greens.
  float dense = ggFieldDense(vToonWorldPos.xz);
  albedo = mix(albedo, uBladeField, pow(grass, 0.7) * ${ggFloat(BLADE_GROUND_MIX)} * dense);

  // ── the blade stipple (see STIPPLE_*) ───────────────────────────────────
  // What the ground looks like where the blades are not: short vertical
  // strokes of a slightly different green, a few lighter tips and darker
  // roots, and nothing at all under the dense middle of the field, which owns
  // its own texture. Weighted by how much grass grows here, so sand, rock and
  // a dirt path stay smooth.
  {
    vec2 dir = normalize(vec2(1.0, 1.0));
    vec2 perp = vec2(-dir.y, dir.x);
    vec2 sp = vec2(
      dot(vToonWorldPos.xz, perp) * ${ggFloat(STIPPLE_CYCLES)},
      dot(vToonWorldPos.xz, dir) * ${ggFloat(STIPPLE_CYCLES / STIPPLE_STRETCH)}
    );
    float blades = ggGroundNoise(sp) - 0.5;
    float speck = ggGroundHash(floor(vToonWorldPos.xz * ${ggFloat(STIPPLE_SPECK_CYCLES)}));
    float tips = step(0.93, speck) - step(speck, 0.07);
    float amount = (1.0 - dense) * pow(grass, 0.7);
    albedo *= 1.0 + blades * ${ggFloat(STIPPLE_VALUE)} * amount;
    albedo *= 1.0 + tips * ${ggFloat(STIPPLE_SPECK)} * amount;
    albedo = mix(
      albedo,
      uBladeTip,
      smoothstep(0.12, 0.48, blades) * ${ggFloat(STIPPLE_TIP)} * amount
    );
  }

  // Large-scale colour break-up so flat ground isn't a solid slab.
  float cn = ggGroundNoise(uv * 6.0);
  albedo *= 0.94 + 0.12 * cn;

  // The beach (2026-09-15, user ask). Sand takes the ground where the baked
  // region says beach, with its own shade band so a wide beach is not one
  // flat slab, and the damp strip in the last units before the waterline.
  float beach = clamp(region.g, 0.0, 1.0);
  vec3 sand = mix(uSand, uSandDark, step(0.55, cn) * 0.35);
  albedo = mix(albedo, sand, beach);
  float near = clamp(region.b, 0.0, 1.0);
  float damp = smoothstep(${ggFloat(WET_SAND_IN)}, 0.88, near) * step(0.05, beach);
  albedo = mix(albedo, uSandWet, damp);
  // Wet sand under standing water, the reference's own band.
  albedo = mix(albedo, uWetSand, step(0.95, near) * 0.8);

  // Dirt road, quantised into a darker edge band and a lighter core.
  float pathEdge = step(0.15, path) * (1.0 - step(0.45, path));
  float pathCore = step(0.45, path);
  albedo = mix(albedo, uDirtEdge, pathEdge);
  albedo = mix(albedo, uDirt, pathCore);

  // Burnt ground: a charred rim around an ash core, quantised like the path.
  float burnEdge = step(0.05, burn) * (1.0 - step(0.25, burn));
  float burnCore = step(0.25, burn);
  albedo = mix(albedo, uChar, burnEdge);
  albedo = mix(albedo, uAsh, burnCore);

  // Rock only on genuinely steep slopes, with a hard but noisy edge so gentle
  // hills stay green.
  float rockEdge = 0.55 + (ggGroundNoise(uv * 30.0) - 0.5) * 0.15;
  float rock = 1.0 - step(rockEdge, n.y);
  albedo = mix(albedo, uRock, rock * 0.85);

  // Snow above a noisy height threshold.
  float snowNoise = ggGroundNoise(vToonWorldPos.xz * 0.12);
  float snowLine = uSnowHeight + (snowNoise - 0.5) * 2.5;
  albedo = mix(albedo, uSnow, step(snowLine, vToonWorldPos.y));

  // Water darkens the ground beneath it.
  albedo *= 1.0 - 0.35 * step(0.95, near);

  vec3 col = toonLight(albedo, n, 1.0, 3.0);

  // ── the shipped ground's own drawn marks (src/world/ground.ts) ───────────
  // Both are functions of world HEIGHT, so a line is a line of constant
  // elevation — a contour, by construction.
  {
    float h = vToonWorldPos.y;
    float slope = 1.0 - clamp(n.y, 0.0, 1.0);
    float onRiser = smoothstep(${ggFloat(RISER_IN)}, ${ggFloat(RISER_FULL)}, slope);
    // The pen's wobble, drifting imperceptibly so the marks never fully
    // arrest (TASTE §2.1).
    float nz = ggGroundNoise(vToonWorldPos.xz * ${ggFloat(NOISE_SCALE)}
      + uGroundTime * ${ggFloat(GROUND_DRIFT_PER_S)}) - 0.5;
    float stripes = fract((h + nz * ${ggFloat(HATCH_WOBBLE)})
      / (uStep / ${ggFloat(STROKES_PER_TIER)}));
    float stroke = smoothstep(${ggFloat(STROKE_IN[0])}, ${ggFloat(STROKE_IN[1])}, stripes)
      * (1.0 - smoothstep(${ggFloat(STROKE_OUT[0])}, ${ggFloat(STROKE_OUT[1])}, stripes));
    float hatchInk = onRiser * stroke * ${ggFloat(HATCH_INK)};
    float f = fract((h + nz * ${ggFloat(LIP_WOBBLE)}) / uStep);
    float lipBand = smoothstep(uRiser.y - ${ggFloat(LIP_BAND[0])},
        uRiser.y - ${ggFloat(LIP_BAND[1])}, f)
      * (1.0 - smoothstep(uRiser.y + ${ggFloat(LIP_BAND[2])},
        uRiser.y + ${ggFloat(LIP_BAND[3])}, f));
    float lip = lipBand * smoothstep(${ggFloat(LIP_SLOPE[0])}, ${ggFloat(LIP_SLOPE[1])}, slope);

    float pathInk = 0.0;
    if (uPathOn > 0.5) {
      float w = texture2D(uPath, uv).r;
      float onPath = smoothstep(${ggFloat(PATH_IN[0])}, ${ggFloat(PATH_IN[1])}, w);
      float speck = ggGroundNoise(vToonWorldPos.xz * ${ggFloat(PATH_SPECK_SCALE)}
        + uGroundTime * ${ggFloat(GROUND_DRIFT_PER_S)});
      float tread = onPath
        * smoothstep(${ggFloat(PATH_SPECK_IN[0])}, ${ggFloat(PATH_SPECK_IN[1])}, speck);
      float rim = 1.0 - smoothstep(0.0, ${ggFloat(PATH_RIM_BAND)},
        abs(w - ${ggFloat(PATH_RIM)}));
      float broken = smoothstep(${ggFloat(PATH_BREAK_IN[0])}, ${ggFloat(PATH_BREAK_IN[1])},
        ggGroundNoise(vToonWorldPos.xz * 1.35 + 7.1
          + uGroundTime * ${ggFloat(GROUND_DRIFT_PER_S)}));
      pathInk = max(rim * broken * ${ggFloat(PATH_RIM_INK)},
        tread * ${ggFloat(PATH_SPECK_INK)});
    }

    float scorchInk = 0.0;
    if (uScorchOn > 0.5) {
      float b = texture2D(uScorch, uv).r;
      float burnt = smoothstep(${ggFloat(SCORCH_IN[0])}, ${ggFloat(SCORCH_IN[1])}, b);
      float ash = ggGroundNoise(vToonWorldPos.xz * ${ggFloat(SCORCH_SPECK_SCALE)}
        + uGroundTime * ${ggFloat(GROUND_DRIFT_PER_S)});
      scorchInk = burnt
        * smoothstep(${ggFloat(SCORCH_SPECK_IN[0])}, ${ggFloat(SCORCH_SPECK_IN[1])}, ash)
        * ${ggFloat(SCORCH_INK)};
    }

    float ink = clamp(hatchInk + lip + pathInk + scorchInk, 0.0, 1.0);
    // The marks land on the LIT value here, not on the albedo: the ghibli
    // ground is shaded, so mixing ink before the ramp would let the cel
    // shadow eat a contour line.
    col = mix(col, uInk, ink);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface GhibliGroundOptions {
  /** The baked geography (src/world/ghibli/region.ts). */
  region?: Texture | null;
  /** Height above which snow takes the ground, world units. */
  snowHeight?: number;
}

/**
 * The ghibli ground material, plus the handles `src/world/ground.ts`'s own
 * interface exposes — the caller swaps materials, so it has to be able to
 * drive this one exactly as it drives the shipped one.
 */
export interface GhibliGround {
  material: ShaderMaterial;
  /** The painted `grass` layer: meadow goes lush under it. */
  setPaintedGrass(texture: Texture | null): void;
  /** The painted `path` layer: dirt albedo AND the drawn trail. */
  setPaintedPath(texture: Texture | null): void;
  /** The fire driver's live scorch layer. */
  setPaintedScorch(texture: Texture | null): void;
  /** The baked geography, after a landscape change. */
  setRegion(texture: Texture | null): void;
  /**
   * Where the blade field's window is and how wide it is, so the meadow can be
   * that field's colour exactly where the field is (see `BLADE_GROUND_MIX`).
   * A span of zero is no window at all, which is the ground on its own.
   */
  setFieldWindow(x: number, z: number, span: number): void;
  /** Recolour the drawn marks (`Ground.setInk`). */
  setInk(color: Color | string): void;
  /** Advance the pen wobble (`Ground.update`). */
  update(nowMs: number): void;
  /** Re-read the terrace step after a terrain dial moved (`Ground.rebuild`). */
  refresh(): void;
  dispose(): void;
}

export function createGroundMaterial(opts: GhibliGroundOptions = {}): GhibliGround {
  const empty = emptyLayerTexture();
  const uniforms = {
    ...toonUniforms,
    uGrass: { value: empty as Texture },
    uPath: { value: empty as Texture },
    uPathOn: { value: 0 },
    uScorch: { value: empty as Texture },
    uScorchOn: { value: 0 },
    uRegion: { value: (opts.region ?? empty) as Texture },
    uMeadow: { value: new Color(GHIBLI.meadow) },
    uLush: { value: new Color(GHIBLI.lush) },
    // The blade field's far-zoom collapse colour, verbatim from its fragment
    // shader (src/world/ghibli/grass.ts `mix(uColorBase, uColorTip, 0.55)`).
    uBladeTip: { value: new Color(GHIBLI.grassTip) },
    uBladeField: {
      value: new Color(GHIBLI.grassBase).lerp(new Color(GHIBLI.grassTip), 0.55),
    },
    uDirt: { value: new Color(GHIBLI.dirt) },
    uDirtEdge: { value: new Color(GHIBLI.dirtEdge) },
    uWetSand: { value: new Color(GHIBLI.wetSand) },
    uRock: { value: new Color(GHIBLI.rock) },
    uSnow: { value: new Color(GHIBLI.snow) },
    uAsh: { value: new Color(GHIBLI.ash) },
    uChar: { value: new Color(GHIBLI.char) },
    uSand: { value: new Color(GHIBLI.sand) },
    uSandWet: { value: new Color(GHIBLI.sandWet) },
    uSandDark: { value: new Color(GHIBLI.sandDark) },
    uSnowHeight: { value: opts.snowHeight ?? SNOW_HEIGHT },
    // The drawn marks. `dirtEdge` is what the shipped ground's `setInk` is
    // handed on this style (src/world/scene.ts) — a violet-black contour on
    // green meadow reads as a crack, not as a drawn line.
    uInk: { value: new Color(GHIBLI.dirtEdge) },
    uCenter: { value: new Vector2(0, 0) },
    uSpan: { value: 1e-3 },
    uStep: { value: terrainParams().tierStep },
    uRiser: { value: new Vector2(TERRAIN.terraceRiser[0], TERRAIN.terraceRiser[1]) },
    uGroundTime: { value: 0 },
  };

  const material = new ShaderMaterial({
    name: 'ghibli-ground',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });

  return {
    material,
    setPaintedGrass(texture: Texture | null): void {
      uniforms.uGrass.value = texture ?? empty;
    },
    setPaintedPath(texture: Texture | null): void {
      uniforms.uPath.value = texture ?? empty;
      uniforms.uPathOn.value = texture ? 1 : 0;
    },
    setPaintedScorch(texture: Texture | null): void {
      uniforms.uScorch.value = texture ?? empty;
      uniforms.uScorchOn.value = texture ? 1 : 0;
    },
    setRegion(texture: Texture | null): void {
      uniforms.uRegion.value = texture ?? empty;
    },
    setFieldWindow(x: number, z: number, span: number): void {
      uniforms.uCenter.value.set(x, z);
      uniforms.uSpan.value = Math.max(1e-3, span);
    },
    setInk(color: Color | string): void {
      uniforms.uInk.value.set(color);
    },
    update(nowMs: number): void {
      // Wall-clock seconds, like the shipped ground: no integration, so a
      // dropped frame cannot make the wobble jump.
      uniforms.uGroundTime.value = nowMs / 1000;
    },
    refresh(): void {
      uniforms.uStep.value = terrainParams().tierStep;
    },
    dispose(): void {
      material.dispose();
      empty.dispose();
    },
  };
}
