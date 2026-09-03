/**
 * The ground (PLAN §7, TASTE §2.2): the terraced land the world stands on,
 * plus the flat field beyond it, colored exactly SURFACE.ground — mid-toned
 * neutral grey targeting groundLuma 0.74.
 *
 * UNLIT (MeshBasicMaterial): the field renders exactly its token at every
 * viewing angle. A lit ground's luma drifted with the orbit elevation and
 * straddled a toon-quantize band boundary, turning the dither into huge
 * camo blotches when the user rotated (user report). Flat paper is the
 * design; the environment engine's exposure still dims it at night in the
 * post pass, and hatching keys off the normal target, not the lit color.
 *
 * TWO MESHES, ONE MATERIAL:
 *
 *   field  a 400×400 plane at 1.25-unit resolution, every vertex lifted to
 *          `surface.sampleHeight` (the Surface seam, src/world/surface.ts —
 *          nothing here derives a height of its own) and re-normalled.
 *   far    a flat ring from the field's rim out to 1400.
 *
 * WHY THE FAR FIELD IS NOT PART OF THE PLANE [D]: it exists only so that no
 * orbit or pan reveals the void past the world, and a 1400-radius plane at
 * the field's density would be ~10 million triangles for ground nobody
 * looks at. The terrain is exactly 0 past TERRAIN.farEnd (185) by
 * construction, so everything outside the field is one flat sheet and a
 * couple of hundred triangles draw it.
 *
 * WHY THE NORMALS MATTER: the terraces read only because of them. The ink
 * pass hatches faces turned away from the key and draws a contour wherever
 * the normal target creases, so a correctly-normalled mesh draws its own
 * risers — there is no separate elevation pass anywhere.
 *
 * WHY A RING RATHER THAN THE DISC THAT USED TO BE HERE [D]: the terraced
 * land runs from about -3.1 to +8, so a full disc at y=0 under the field
 * would cover every basin on the map — the lake floor included — with a
 * sheet of paper. The ring's inner edge sits at the field's rim, where the
 * terrain is already exactly 0, so the two meet at the same value with no
 * seam to hide and no coplanar fight to lose.
 *
 * A ring rather than a rectangle: if a viewport ever reaches the edge of
 * the world, the silhouette it sees is round, not rectilinear (TASTE §3).
 * Its radius far exceeds the pannable region.
 */

import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { MOTION, SURFACE } from '../taste/tokens';
import { TERRAIN } from './landscape';
import type { Surface } from './surface';

/** Outer radius of the flat far field. */
const GROUND_RADIUS = 1400;
const GROUND_SEGMENTS = 96;

/**
 * Side of the displaced field, world units: ±200 in x and z. Comfortably
 * past TERRAIN.farEnd, so the rim is flat land and not a cut through a tier.
 */
export const FIELD_SIZE = 400;
/**
 * Segments per side — 1.25 units a quad, ~205k triangles. A ceiling, not a
 * starting point [D]: the terrace risers are the finest thing on the map
 * and a few units of run each, so this puts several vertices across one,
 * and doubling it quadruples both the build and the draw for a shape the
 * ink pass would render the same.
 */
export const FIELD_SEGMENTS = 320;

/**
 * [D] Pen-wobble drift rate, noise units per second: a twentieth of a noise
 * cell per ambient beat. Nothing on screen ever fully arrests (TASTE §2.1)
 * and this is the slowest thing that does not — under a pixel a second, so
 * the tier lines read as drawn, never as animated.
 */
const GROUND_DRIFT_PER_S = 0.05 / (MOTION.ambientMs / 1000);

// ── the drawn terrain marks (fragment injection) ─────────────────────────────
/**
 * The tiers are geometry, but geometry is not enough: the ground is unlit
 * paper and the ink pass's hatch keys off normal·key over a threshold the
 * risers (slope ≤ 0.55) never trip, while its contour detector finds no
 * crease gentle enough to break on. Rendered honestly, a terraced field and
 * a flat one are the same picture (screenshot, user report: "the map is
 * flat").
 *
 * So the ground draws its own tiers, the way the isometric map references
 * do: an ink line along the lip of every riser and sparse stroke hatching
 * down its face. Both are functions of world HEIGHT, so a line is a line of
 * constant elevation — a contour, by construction — and both live in the
 * material's color only, which keeps them out of the normal target and off
 * the ink pass's own edges.
 *
 * ACHROMATIC: the one color mixed in is SURFACE.ink, the palette's floor
 * (TASTE §1 — nothing in the environment goes below it; near-black belongs
 * to characters). The toon quantize downstream therefore snaps every mark
 * onto a palette value.
 *
 * The widths are in HEIGHT units, so a stroke keeps its drawn weight at any
 * zoom instead of thinning out — the reference's pen does the same.
 */
const GROUND_MARKS_CACHE_KEY = 'ground-terrace-marks-v1';

// The dial set [D]. Every one of these is a threshold on world height or on
// the surface's tilt — no screen-space term anywhere, so the marks hold
// still under an orbit and keep their weight under a zoom.

/** Tilt at which a face starts / fully counts as a riser. A tread reads 0. */
const RISER_IN = 0.012;
const RISER_FULL = 0.045;
/** Wobble frequency on world xz — low, so a line bends like a pen stroke. */
const NOISE_SCALE = 0.35;
/** How far the wobble pushes a hatch stroke / a lip line, in height units. */
const HATCH_WOBBLE = 0.12;
const LIP_WOBBLE = 0.06;
/** Strokes down one tier's riser. Five: enough to read as hatching, sparse
 * enough to leave the generous paper between marks the taste asks for
 * (TASTE §2.3). */
const STROKES_PER_TIER = 5;
/** The stroke's two edges within its cell — a thin mark, most of the cell
 * left as paper. */
const STROKE_IN: [number, number] = [0.5, 0.58];
const STROKE_OUT: [number, number] = [0.78, 0.86];
/** Hatch ink strength; the lip line is the darker of the two marks. */
const HATCH_INK = 0.9;
/** The lip band, as offsets either side of the riser's top (uRiser.y). */
const LIP_BAND: [number, number, number, number] = [0.06, 0.02, 0.0, 0.03];
/** …and the tilt it needs to exist at all: a flat plain has no lip. */
const LIP_SLOPE: [number, number] = [0.003, 0.012];

/** A number that is always a glsl float literal (never `2` for `2.0`). */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/** Value noise on world xz — the same hash/lerp family as the ink pass, two
 * octaves rather than three: this only has to wobble a line off true, not
 * carry a texture. */
const groundNoiseGlsl = `
float groundHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float groundVNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(groundHash(i), groundHash(i + vec2(1.0, 0.0)), u.x),
    mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float groundNoise(vec2 p) {
  return 0.6 * groundVNoise(p) + 0.4 * groundVNoise(p * 2.07 + 11.3);
}`;

export interface Ground {
  /** Both meshes, ready to add to the scene. */
  group: Group;
  /** The ONE material they share — the dev color grade recolors just this. */
  material: MeshBasicMaterial;
  /**
   * Advance the pen wobble's ambient drift. Call once per frame, like
   * `water.update` — one uniform write, a wall-clock value, no integration.
   */
  update(nowMs: number): void;
}

export function createGround(surface: Surface): Ground {
  const group = new Group();
  group.name = 'ground';
  // One material for both meshes: the paper is one value by construction, so
  // a color grade cannot pull the field and the horizon apart (scene.ts's
  // setBackgroundColor writes this single color).
  const material = new MeshBasicMaterial({ color: SURFACE.ground });

  // The terrace marks. The material stays unlit and its color stays the
  // token: this only mixes ink INTO the shaded result, per fragment, from
  // world height and the surface's own tilt.
  const markUniforms = {
    uInk: { value: new Color(SURFACE.ink) },
    uStep: { value: TERRAIN.terraceStep },
    uRiser: { value: new Vector2(TERRAIN.terraceRiser[0], TERRAIN.terraceRiser[1]) },
    uGroundTime: { value: 0 },
  };
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, markUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vGroundPos;\nvarying vec3 vGroundNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vGroundNormal = normalize(mat3(modelMatrix) * normal);
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uInk;
uniform float uStep;
uniform vec2 uRiser;
uniform float uGroundTime;
varying vec3 vGroundPos;
varying vec3 vGroundNormal;
${groundNoiseGlsl}`,
      )
      // After the color chunk, so the marks land on the shaded paper value.
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float h = vGroundPos.y;
  // 0 on a tread — the terrace's treads are dead flat by construction.
  float slope = 1.0 - clamp(vGroundNormal.y, 0.0, 1.0);
  float onRiser = smoothstep(${glslFloat(RISER_IN)}, ${glslFloat(RISER_FULL)}, slope);
  // The pen's wobble: nothing here is ruled, and it drifts imperceptibly so
  // the marks never fully arrest (TASTE §2.1).
  float n = groundNoise(vGroundPos.xz * ${glslFloat(NOISE_SCALE)}
    + uGroundTime * ${glslFloat(GROUND_DRIFT_PER_S)}) - 0.5;
  // Stroke hatching down the riser: lines of constant height, ${STROKES_PER_TIER} to a tier.
  float stripes = fract((h + n * ${glslFloat(HATCH_WOBBLE)}) / (uStep / ${glslFloat(STROKES_PER_TIER)}));
  float stroke = smoothstep(${glslFloat(STROKE_IN[0])}, ${glslFloat(STROKE_IN[1])}, stripes)
    * (1.0 - smoothstep(${glslFloat(STROKE_OUT[0])}, ${glslFloat(STROKE_OUT[1])}, stripes));
  float hatchInk = onRiser * stroke * ${glslFloat(HATCH_INK)};
  // The lip: one line along the top edge of every riser, where it meets the
  // tread above it.
  float f = fract((h + n * ${glslFloat(LIP_WOBBLE)}) / uStep);
  float lipBand = smoothstep(uRiser.y - ${glslFloat(LIP_BAND[0])}, uRiser.y - ${glslFloat(LIP_BAND[1])}, f)
    * (1.0 - smoothstep(uRiser.y + ${glslFloat(LIP_BAND[2])}, uRiser.y + ${glslFloat(LIP_BAND[3])}, f));
  float lip = lipBand * smoothstep(${glslFloat(LIP_SLOPE[0])}, ${glslFloat(LIP_SLOPE[1])}, slope);
  float ink = clamp(hatchInk + lip, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, uInk, ink);
}`,
      );
  };
  // The injected chunks change the program — never share a cache slot with a
  // stock basic material.
  material.customProgramCacheKey = (): string => GROUND_MARKS_CACHE_KEY;

  const field = new PlaneGeometry(FIELD_SIZE, FIELD_SIZE, FIELD_SEGMENTS, FIELD_SEGMENTS);
  // Laid flat first, so the attribute holds world x/z and the height sample
  // reads straight off it — no local-space bookkeeping in between.
  field.rotateX(-Math.PI / 2);
  const position = field.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    position.setY(i, surface.sampleHeight(position.getX(i), position.getZ(i)));
  }
  position.needsUpdate = true;
  // After the displacement, never before: these normals ARE the terraces.
  field.computeVertexNormals();
  const fieldMesh = new Mesh(field, material);
  fieldMesh.name = 'ground-field';
  group.add(fieldMesh);

  const far = new RingGeometry(FIELD_SIZE / 2, GROUND_RADIUS, GROUND_SEGMENTS);
  far.rotateX(-Math.PI / 2);
  const farMesh = new Mesh(far, material);
  farMesh.name = 'ground-far';
  // The ring's inner edge is inscribed in the circle the square field's rim
  // circumscribes, so the two OVERLAP (the field's corners reach past it)
  // rather than leaving a gap. Both are flat and the same value out here, so
  // the overlap is invisible — a gap would not have been.
  farMesh.position.y = 0;
  group.add(farMesh);

  return {
    group,
    material,
    update: (nowMs: number): void => {
      // Wall-clock seconds, like the ripples: no integration, so a dropped
      // frame cannot make the wobble jump.
      markUniforms.uGroundTime.value = nowMs / 1000;
    },
  };
}
