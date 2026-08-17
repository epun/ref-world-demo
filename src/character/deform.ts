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
        '#include <beginnormal_vertex>\n\tobjectNormal = deformBodyNormal(objectNormal, position);',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\ttransformed = deformBody(transformed);',
      );
  };
  // The injected chunks change the program — never share a cache slot with a
  // stock MeshPhysicalMaterial.
  material.customProgramCacheKey = () => 'character-body-deform-v1';

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
export function deformPoint(p: Vec3Like, state: DeformState, frame: DeformFrame): Vec3Like {
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

  return { x, y, z };
}
