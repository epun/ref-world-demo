/**
 * Whole-body deformation (PLAN §3.5) — the character has no skeleton, so
 * emotes and gait shape the ENTIRE mesh in the vertex shader from a few
 * uniforms. Every deformed frame must still read as a valid corpus still:
 * one solid silhouette, eyes as the only interior detail — which is exactly
 * what a whole-shape squash/lean/twist/reach guarantees by construction
 * (nothing can animate interior detail into existence).
 *
 * The math runs twice, identically:
 *  - GPU: injected into MeshPhysicalMaterial via onBeforeCompile, deforming
 *    `transformed` (and approximating `objectNormal` with the pure rotations
 *    so the clearcoat gloss tracks the lean/twist).
 *  - CPU: deformPoint() applies the same object-space math so character.ts
 *    can carry the separate eye caps along with the body every frame.
 *
 * All deformation is in OBJECT SPACE about the mesh's base (frame.baseY is
 * the geometry's bottom; the ground, once the mesh is offset to rest on it).
 * Uniform values are plain numbers driven by ζ≥1 springs upstream — this
 * module never animates anything itself.
 */

import type { MeshPhysicalMaterial } from 'three';

/** The deformation channels, in application order for schedule emissions. */
export const DEFORM_CHANNELS = ['squash', 'leanX', 'leanZ', 'twist', 'reach'] as const;

export type DeformChannel = (typeof DEFORM_CHANNELS)[number];

/**
 * One body pose as channel values:
 * - squash  1 = neutral; < 1 squashes y about the base and bulges x/z by
 *           1/sqrt(squash) so the volume feel is preserved.
 * - leanX   radians about the x axis (forward/back), increasing with height —
 *           a bend from the base, not a rigid tip.
 * - leanZ   radians about the z axis (side lean), increasing with height.
 * - twist   radians about the y axis, increasing with height.
 * - reach   vertical stretch of the upper half, as a fraction of body height
 *           (wave/surprised — the whole body reaches; there is no arm).
 */
export type DeformState = Record<DeformChannel, number>;

export const NEUTRAL_DEFORM: DeformState = {
  squash: 1,
  leanX: 0,
  leanZ: 0,
  twist: 0,
  reach: 0,
} as const;

/** Squash floor — keeps the volume bulge finite and the body a body. */
export const MIN_SQUASH = 0.05;

// ── gait layer (PLAN §3.5) ──────────────────────────────────────────────────
// A second, ADDITIVE set of uniforms driven by src/character/gait.ts. The
// emote springs and the gait never touch each other's channels: emotes shape
// the pose, the gait layers a phase-driven locomotion oscillation on top —
// both together still deform the WHOLE silhouette, so every frame remains a
// valid corpus still.

/** Hip height as a fraction of mesh height — below it, the leg shear reads. */
export const HIP_FRAC = 0.32;

/**
 * The gait layer's uniform values for one frame. All amplitudes are scaled by
 * `amp` (0..1, speed-following) so at rest the layer vanishes entirely and
 * the body sits back on the ambient drift floor alone.
 */
export interface GaitState {
  /** Step-cycle phase in radians; 2π is one full stride cycle. */
  phase: number;
  /** Master amplitude 0..1 — follows speed through a ζ≥1 spring upstream. */
  amp: number;
  /**
   * Alternating leg swing, as a fraction of body height: below the hip
   * (HIP_FRAC × height) the mesh shears along the travel axis by sin(phase),
   * with the sign flipping smoothly across the body midline — that antiphase
   * is the alternating-step read.
   */
  legShear: number;
  /** Body bob at 2× phase, fraction of height (~0.015). Rhythmic locomotion
   * oscillation like the egg wobble — continuous, never a springy bounce. */
  bob: number;
  /** Whole-body roll about the travel axis at 1× phase, radians — the roll
   * toward the planted foot. The roll is the waddle. */
  waddle: number;
  /** Blob archetype: traveling undulation along the travel axis — a lateral
   * sway sin(phase − h·k), fraction of height. The undulating glide. */
  undulate: number;
  /** Wave number of the blob undulation over the body height. */
  undulateK: number;
}

export const NEUTRAL_GAIT: GaitState = {
  phase: 0,
  amp: 0,
  legShear: 0,
  bob: 0,
  waddle: 0,
  undulate: 0,
  undulateK: 0,
} as const;

/** The waddle's roll angle for a gait state — shared by shader mirror + eye
 * carry, so the eye caps roll with the body exactly. */
export function gaitRollAngle(g: GaitState): number {
  return g.waddle * g.amp * Math.sin(g.phase);
}

/** Width of the smooth sign flip across the midline, as a fraction of height.
 * A hard sign() would tear the mesh at x = 0; this blends the two legs'
 * antiphase shear through a narrow center band instead. */
export const LEG_SIDE_BLEND = 0.08;

/** Object-space vertical frame the deformation bends around. */
export interface DeformFrame {
  /** Geometry bottom (bounding-box min.y) — the pivot of every channel. */
  baseY: number;
  /** Geometry height (bounding-box extent) — normalizes the height ramp. */
  height: number;
}

export interface DeformHandles {
  /** Push new channel values into the shader uniforms (numbers, not tweens). */
  set(state: Partial<DeformState>): void;
  /** Current channel values, as last pushed. */
  get(): DeformState;
  /** Push the gait layer's values (additive with the emote channels). */
  setGait(state: GaitState): void;
  /** Current gait values, as last pushed. */
  getGait(): GaitState;
}

// ── shared math (GLSL + CPU keep these in lockstep) ─────────────────────────
// order: reach (upper-half stretch) → squash (about base, volume bulge) →
// twist (about y) → lean (bend about x, then z). The height fraction h is
// sampled from the UNDEFORMED y so both sides agree exactly.

const DEFORM_GLSL = /* glsl */ `
uniform float uSquash;
uniform float uLeanX;
uniform float uLeanZ;
uniform float uTwist;
uniform float uReach;
uniform float uDeformBaseY;
uniform float uDeformHeight;

float deformHeightFrac(float y) {
  return clamp((y - uDeformBaseY) / max(uDeformHeight, 1e-6), 0.0, 1.0);
}

vec3 deformBody(vec3 p) {
  float h = deformHeightFrac(p.y);

  // reach: stretch of the upper half only
  p.y += uReach * uDeformHeight * smoothstep(0.5, 1.0, h);

  // squash about the base, bulging x/z to preserve the volume feel
  float s = max(uSquash, ${MIN_SQUASH});
  p.y = uDeformBaseY + (p.y - uDeformBaseY) * s;
  float bulge = inversesqrt(s);
  p.x *= bulge;
  p.z *= bulge;

  // twist about y, angle increasing with height
  float ay = uTwist * h;
  float cy = cos(ay);
  float sy = sin(ay);
  p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);

  // lean: bend about the base, angle increasing with height — x axis first
  float ax = uLeanX * h;
  float cx = cos(ax);
  float sx = sin(ax);
  float ry = p.y - uDeformBaseY;
  p = vec3(p.x, uDeformBaseY + cx * ry - sx * p.z, sx * ry + cx * p.z);

  // ... then z axis
  float az = uLeanZ * h;
  float cz = cos(az);
  float sz = sin(az);
  ry = p.y - uDeformBaseY;
  p = vec3(cz * p.x - sz * ry, uDeformBaseY + sz * p.x + cz * ry, p.z);

  return p;
}

// ── gait layer — additive locomotion oscillation on the emote-deformed body.
// Runs AFTER deformBody so the walk rides whatever pose the emote springs
// hold; deformPoint mirrors the same order on the CPU.
uniform float uGaitPhase;
uniform float uGaitAmp;
uniform float uLegShear;
uniform float uGaitBob;
uniform float uWaddle;
uniform float uGaitUndulate;
uniform float uGaitUndulateK;
uniform float uHipY;

vec3 gaitBody(vec3 p) {
  float amp = uGaitAmp;
  if (amp < 1e-4) return p;
  float h = deformHeightFrac(p.y);

  // alternating leg swing: below the hip the mesh shears along the travel
  // axis by sin(phase); the sign flips smoothly across the midline so the
  // two sides step in antiphase without tearing the mesh at x = 0
  float legW = clamp((uHipY - p.y) / max(uHipY - uDeformBaseY, 1e-6), 0.0, 1.0);
  float side = clamp(p.x / (${LEG_SIDE_BLEND} * uDeformHeight), -1.0, 1.0);
  p.z += uLegShear * uDeformHeight * amp * side * sin(uGaitPhase) * legW;

  // blob: traveling undulation along the travel axis — the undulating glide
  p.x += uGaitUndulate * uDeformHeight * amp * sin(uGaitPhase - h * uGaitUndulateK);

  // body bob at 2x step frequency; upward-only so the base stays grounded
  p.y += uGaitBob * uDeformHeight * amp * 0.5 * (1.0 - cos(2.0 * uGaitPhase));

  // waddle: whole-body roll about the travel axis toward the planted foot
  float roll = uWaddle * amp * sin(uGaitPhase);
  float cr = cos(roll);
  float sr = sin(roll);
  float ry = p.y - uDeformBaseY;
  p = vec3(cr * p.x - sr * ry, uDeformBaseY + sr * p.x + cr * ry, p.z);

  return p;
}

// Gait normal approximation: the waddle roll is the only pure rotation in
// the layer — the shears are small and smooth, same call as squash/reach.
vec3 gaitBodyNormal(vec3 n) {
  float roll = uWaddle * uGaitAmp * sin(uGaitPhase);
  float cr = cos(roll);
  float sr = sin(roll);
  return normalize(vec3(cr * n.x - sr * n.y, sr * n.x + cr * n.y, n.z));
}

// Normal approximation: apply only the pure rotations (twist + lean). The
// squash/reach shear is small and smooth; close enough for the clearcoat.
vec3 deformBodyNormal(vec3 n, vec3 p) {
  float h = deformHeightFrac(p.y);

  float ay = uTwist * h;
  float cy = cos(ay);
  float sy = sin(ay);
  n = vec3(cy * n.x + sy * n.z, n.y, -sy * n.x + cy * n.z);

  float ax = uLeanX * h;
  float cx = cos(ax);
  float sx = sin(ax);
  n = vec3(n.x, cx * n.y - sx * n.z, sx * n.y + cx * n.z);

  float az = uLeanZ * h;
  float cz = cos(az);
  float sz = sin(az);
  n = vec3(cz * n.x - sz * n.y, sz * n.x + cz * n.y, n.z);

  return normalize(n);
}
`;

/**
 * Inject the body deformation into the character material. The uniforms
 * outlive any recompile (onBeforeCompile reassigns the same objects), so the
 * returned handles are valid immediately and forever.
 */
export function applyDeform(material: MeshPhysicalMaterial, frame: DeformFrame): DeformHandles {
  const uniforms = {
    uSquash: { value: NEUTRAL_DEFORM.squash },
    uLeanX: { value: NEUTRAL_DEFORM.leanX },
    uLeanZ: { value: NEUTRAL_DEFORM.leanZ },
    uTwist: { value: NEUTRAL_DEFORM.twist },
    uReach: { value: NEUTRAL_DEFORM.reach },
    uDeformBaseY: { value: frame.baseY },
    uDeformHeight: { value: Math.max(frame.height, 1e-6) },
    uGaitPhase: { value: NEUTRAL_GAIT.phase },
    uGaitAmp: { value: NEUTRAL_GAIT.amp },
    uLegShear: { value: NEUTRAL_GAIT.legShear },
    uGaitBob: { value: NEUTRAL_GAIT.bob },
    uWaddle: { value: NEUTRAL_GAIT.waddle },
    uGaitUndulate: { value: NEUTRAL_GAIT.undulate },
    uGaitUndulateK: { value: NEUTRAL_GAIT.undulateK },
    uHipY: { value: frame.baseY + HIP_FRAC * Math.max(frame.height, 1e-6) },
  };

  const byChannel: Record<DeformChannel, { value: number }> = {
    squash: uniforms.uSquash,
    leanX: uniforms.uLeanX,
    leanZ: uniforms.uLeanZ,
    twist: uniforms.uTwist,
    reach: uniforms.uReach,
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DEFORM_GLSL}`)
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n\tobjectNormal = gaitBodyNormal(deformBodyNormal(objectNormal, position));',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\ttransformed = gaitBody(deformBody(transformed));',
      );
  };
  // The injected chunks change the program — never share a cache slot with a
  // stock MeshPhysicalMaterial.
  material.customProgramCacheKey = () => 'character-body-deform-v2';

  return {
    set(state: Partial<DeformState>): void {
      for (const channel of DEFORM_CHANNELS) {
        const v = state[channel];
        if (v !== undefined) byChannel[channel].value = v;
      }
    },
    get(): DeformState {
      return {
        squash: byChannel.squash.value,
        leanX: byChannel.leanX.value,
        leanZ: byChannel.leanZ.value,
        twist: byChannel.twist.value,
        reach: byChannel.reach.value,
      };
    },
    setGait(state: GaitState): void {
      uniforms.uGaitPhase.value = state.phase;
      uniforms.uGaitAmp.value = state.amp;
      uniforms.uLegShear.value = state.legShear;
      uniforms.uGaitBob.value = state.bob;
      uniforms.uWaddle.value = state.waddle;
      uniforms.uGaitUndulate.value = state.undulate;
      uniforms.uGaitUndulateK.value = state.undulateK;
    },
    getGait(): GaitState {
      return {
        phase: uniforms.uGaitPhase.value,
        amp: uniforms.uGaitAmp.value,
        legShear: uniforms.uLegShear.value,
        bob: uniforms.uGaitBob.value,
        waddle: uniforms.uWaddle.value,
        undulate: uniforms.uGaitUndulate.value,
        undulateK: uniforms.uGaitUndulateK.value,
      };
    },
  };
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

function smoothstepEdge(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Height fraction of an object-space y within the frame, clamped to [0, 1]. */
export function heightFrac(y: number, frame: DeformFrame): number {
  return Math.min(1, Math.max(0, (y - frame.baseY) / Math.max(frame.height, 1e-6)));
}

/**
 * CPU twin of the vertex-shader deformation — the SAME math, in the same
 * order, so the separate eye caps can ride the deformed body exactly.
 * Pure: no Three.js types required at runtime.
 */
export function deformPoint(
  p: Vec3Like,
  state: DeformState,
  frame: DeformFrame,
  gait?: GaitState,
): Vec3Like {
  const height = Math.max(frame.height, 1e-6);
  const h = heightFrac(p.y, frame);
  let { x, y, z } = p;

  // reach
  y += state.reach * height * smoothstepEdge(0.5, 1, h);

  // squash + volume bulge
  const s = Math.max(state.squash, MIN_SQUASH);
  y = frame.baseY + (y - frame.baseY) * s;
  const bulge = 1 / Math.sqrt(s);
  x *= bulge;
  z *= bulge;

  // twist about y
  const ay = state.twist * h;
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  [x, z] = [cy * x + sy * z, -sy * x + cy * z];

  // lean about x
  const ax = state.leanX * h;
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  let ry = y - frame.baseY;
  [y, z] = [frame.baseY + cx * ry - sx * z, sx * ry + cx * z];

  // lean about z
  const az = state.leanZ * h;
  const cz = Math.cos(az);
  const sz = Math.sin(az);
  ry = y - frame.baseY;
  [x, y] = [cz * x - sz * ry, frame.baseY + sz * x + cz * ry];

  // gait layer — same terms and order as gaitBody in the shader
  if (gait && gait.amp >= 1e-4) {
    const amp = gait.amp;
    const hg = heightFrac(y, frame);
    const hipY = frame.baseY + HIP_FRAC * height;

    // alternating leg swing below the hip, antiphase across the midline
    const legW = Math.min(1, Math.max(0, (hipY - y) / Math.max(hipY - frame.baseY, 1e-6)));
    const side = Math.min(1, Math.max(-1, x / (LEG_SIDE_BLEND * height)));
    z += gait.legShear * height * amp * side * Math.sin(gait.phase) * legW;

    // blob undulation: traveling wave along the travel axis
    x += gait.undulate * height * amp * Math.sin(gait.phase - hg * gait.undulateK);

    // bob at 2x phase, upward-only
    y += gait.bob * height * amp * 0.5 * (1 - Math.cos(2 * gait.phase));

    // waddle roll about the travel axis
    const roll = gaitRollAngle(gait);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const rg = y - frame.baseY;
    [x, y] = [cr * x - sr * rg, frame.baseY + sr * x + cr * rg];
  }

  return { x, y, z };
}
