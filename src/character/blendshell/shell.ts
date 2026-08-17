/**
 * The blend-shell mesh (BLENDSHELL step 2).
 *
 * One merged BufferGeometry of low-poly primitive meshes (capsule / sphere /
 * cone per SdfPart), one draw call, on the SAME MeshPhysicalMaterial recipe
 * as the inflate path (CHARACTER.body + clearcoat). A vertex stage injected
 * via onBeforeCompile evaluates the smooth-min SDF of the whole part table at
 * each vertex and SNAPS the vertex along the SDF gradient onto the zero
 * surface (3 gradient-descent iterations, central-difference gradient) —
 * overlapping primitives converge onto one blended skin and seams cease to
 * exist. Normals are the SDF gradient at the snapped position, so lighting
 * flows continuously across every joint.
 *
 * Buried-geometry tuck: a vertex whose unsnapped position is deep inside the
 * union (sdf < −tuck) snaps to the −tuck inner offset surface instead — it
 * collapses under the skin rather than surfacing as a coplanar double-cover.
 *
 * The part table is a uniform array (MAX_PARTS entries, 3 vec4 rows per
 * part); step.ts and secondary.ts mutate the SdfParts each frame and
 * updateParts() pushes the new table — the ropes and IK legs stay fused
 * because the shader re-blends the union every frame.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  SphereGeometry,
  Vector3,
  Vector4,
} from 'three';
import type { IUniform, MeshPhysicalMaterial, WebGLProgramParametersWithUniforms } from 'three';
import { createCharacterMaterial } from '../mesh';
import { MAX_PARTS, type CharacterSpec, type SdfPart } from './spec';

/** Gradient-descent iterations of the vertex snap. */
export const SNAP_ITERATIONS = 3;

/** Buried-vertex threshold/offset, spec units (~2% of a 1-unit character). */
export const TUCK_THRESHOLD = 0.02;

/** Central-difference epsilon, spec units. Mirrors spec.ts sdfGradient. */
const GRAD_EPS = 0.004;

/**
 * The shared part-table uniforms. ONE object serves both the body material
 * and the outline material — updateParts writes the arrays in place, so a
 * single call per frame feeds every shader that reads the table.
 */
export interface PartTableUniforms {
  /** xyz = a, w = r */
  uPartA: IUniform<Vector4[]>;
  /** xyz = b, w = r2 */
  uPartB: IUniform<Vector4[]>;
  /** x = blend */
  uPartK: IUniform<Vector4[]>;
  uPartCount: IUniform<number>;
  uTuck: IUniform<number>;
}

export function createPartTable(parts: readonly SdfPart[]): PartTableUniforms {
  const uniforms: PartTableUniforms = {
    uPartA: { value: Array.from({ length: MAX_PARTS }, () => new Vector4()) },
    uPartB: { value: Array.from({ length: MAX_PARTS }, () => new Vector4()) },
    uPartK: { value: Array.from({ length: MAX_PARTS }, () => new Vector4()) },
    uPartCount: { value: 0 },
    uTuck: { value: TUCK_THRESHOLD },
  };
  writePartTable(uniforms, parts);
  return uniforms;
}

/** Push the current SdfPart values into the uniform arrays (in place). */
export function writePartTable(
  table: PartTableUniforms,
  parts: readonly SdfPart[],
): void {
  const n = Math.min(parts.length, MAX_PARTS);
  for (let i = 0; i < n; i++) {
    const part = parts[i]!;
    const b = part.b ?? part.a;
    table.uPartA.value[i]!.set(part.a[0], part.a[1], part.a[2], part.r);
    table.uPartB.value[i]!.set(b[0], b[1], b[2], part.r2 ?? part.r);
    table.uPartK.value[i]!.set(part.blend, 0, 0, 0);
  }
  table.uPartCount.value = n;
}

/**
 * The GLSL twin of spec.ts's sdfSpec/sdfGradient + the snap loop. Injected
 * into both the body material and the outline material; the per-material
 * uniforms uSnapIso / uWobbleAmp / uWobbleSeed select the target surface
 * (0 = skin, outline width = ink hull) and the drawn-line wobble.
 */
export const SDF_SNAP_GLSL = /* glsl */ `
const int BS_MAX_PARTS = ${MAX_PARTS};
uniform vec4 uPartA[BS_MAX_PARTS];
uniform vec4 uPartB[BS_MAX_PARTS];
uniform vec4 uPartK[BS_MAX_PARTS];
uniform int uPartCount;
uniform float uTuck;
uniform float uSnapIso;
uniform float uWobbleAmp;
uniform float uWobbleSeed;
attribute float aPart;

float bsSeg(vec3 p, int i) {
  vec3 a = uPartA[i].xyz;
  vec3 ab = uPartB[i].xyz - a;
  float dd = dot(ab, ab);
  float t = dd > 1e-12 ? clamp(dot(p - a, ab) / dd, 0.0, 1.0) : 0.0;
  return length(p - a - ab * t) - mix(uPartA[i].w, uPartB[i].w, t);
}

// Smooth-min union; pairwise k = min(blend_i, blend_j) via the running blend
// of the dominating part (mirrors sdfSpec in spec.ts exactly).
float bsScene(vec3 p) {
  float d = 1e9;
  float cb = 1e9;
  for (int i = 0; i < BS_MAX_PARTS; i++) {
    if (i >= uPartCount) break;
    float di = bsSeg(p, i);
    float bi = uPartK[i].x;
    float k = max(min(cb, bi), 1e-5);
    float h = max(k - abs(d - di), 0.0) / k;
    float nd = min(d, di) - h * h * k * 0.25;
    cb = di < d ? bi : cb;
    d = nd;
  }
  return d;
}

vec3 bsGrad(vec3 p) {
  const float e = ${GRAD_EPS.toFixed(4)};
  return vec3(
    bsScene(p + vec3(e, 0.0, 0.0)) - bsScene(p - vec3(e, 0.0, 0.0)),
    bsScene(p + vec3(0.0, e, 0.0)) - bsScene(p - vec3(0.0, e, 0.0)),
    bsScene(p + vec3(0.0, 0.0, e)) - bsScene(p - vec3(0.0, 0.0, e)));
}

// Snap a vertex onto the iso surface along the SDF gradient. The wobble
// (outline only) perturbs the iso value with smooth spatial noise + a small
// per-part phase so the ink line reads drawn, without cracking the hull.
vec3 bsSnap(vec3 p) {
  float iso = uSnapIso;
  if (uWobbleAmp > 0.0) {
    float phase = uWobbleSeed + aPart * 0.7;
    iso += uWobbleAmp *
      (0.6 * sin(dot(p, vec3(31.7, 47.3, 27.1)) + phase) +
       0.4 * sin(dot(p, vec3(11.3, 17.9, 13.7)) * 2.7 + phase * 1.7));
  }
  // Buried tuck: deep-inside vertices collapse to an inner offset surface.
  float target = bsScene(p) < -uTuck ? -uTuck : iso;
  for (int i = 0; i < ${SNAP_ITERATIONS}; i++) {
    float d = bsScene(p) - target;
    vec3 g = bsGrad(p);
    p -= (g / max(length(g), 1e-5)) * d;
  }
  return p;
}
`;

// ── merged primitive geometry ────────────────────────────────────────────────

const UP = new Vector3(0, 1, 0);

/** Low-poly primitive for one part, transformed into place, in spec space. */
function partGeometry(part: SdfPart): BufferGeometry {
  const r = Math.max(part.r, part.r2 ?? part.r);
  if (!part.b || part.kind === 'sphere') {
    const geo = new SphereGeometry(r, 10, 8);
    geo.translate(part.a[0], part.a[1], part.a[2]);
    return geo;
  }
  const a = new Vector3(...part.a);
  const b = new Vector3(...part.b);
  const dir = b.clone().sub(a);
  const len = Math.max(dir.length(), 1e-5);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const quat = new Quaternion().setFromUnitVectors(UP, dir.divideScalar(len));
  const geo =
    part.kind === 'cone'
      ? new ConeGeometry(r, len, 8, 2, false)
      : new CapsuleGeometry(r, len, 2, 8);
  geo.applyMatrix4(new Matrix4().compose(mid, quat, new Vector3(1, 1, 1)));
  return geo;
}

/**
 * Merge all part primitives into one indexed BufferGeometry carrying a
 * per-vertex aPart index attribute. One geometry, one draw (per material).
 */
export function buildShellGeometry(spec: CharacterSpec): BufferGeometry {
  const sources = spec.parts.slice(0, MAX_PARTS).map(partGeometry);
  let vertCount = 0;
  let indexCount = 0;
  for (const g of sources) {
    vertCount += g.getAttribute('position').count;
    indexCount += g.getIndex()!.count;
  }

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const partIndex = new Float32Array(vertCount);
  const index = new Uint32Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  sources.forEach((g, partI) => {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const idx = g.getIndex()!;
    positions.set(pos.array as Float32Array, vOff * 3);
    normals.set(nrm.array as Float32Array, vOff * 3);
    partIndex.fill(partI, vOff, vOff + pos.count);
    for (let i = 0; i < idx.count; i++) index[iOff + i] = idx.getX(i) + vOff;
    vOff += pos.count;
    iOff += idx.count;
    g.dispose();
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aPart', new BufferAttribute(partIndex, 1));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingBox();
  // The snap can only pull vertices inward (blend shrinks the union), but
  // ropes/IK move parts at runtime — pad the culling sphere generously.
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius *= 1.5;
  return geometry;
}

// ── the body shell ───────────────────────────────────────────────────────────

export interface ShellHandles {
  mesh: Mesh;
  geometry: BufferGeometry;
  material: MeshPhysicalMaterial;
  /** The shared part table — hand it to the outline too. */
  table: PartTableUniforms;
  /** Push the (mutated) part list to the GPU. Call once per frame. */
  updateParts(parts: readonly SdfPart[]): void;
  dispose(): void;
}

/**
 * Build the blend-shell body mesh: merged geometry + the character material
 * with the SDF snap injected. The snapped position is computed once in the
 * beginnormal stage (bsP stays in scope for begin_vertex), and objectNormal
 * becomes the SDF gradient — the whole point of the technique.
 */
export function createShell(spec: CharacterSpec): ShellHandles {
  const geometry = buildShellGeometry(spec);
  const table = createPartTable(spec.parts);
  const material = createCharacterMaterial();

  const own = {
    uSnapIso: { value: 0 },
    uWobbleAmp: { value: 0 },
    uWobbleSeed: { value: 0 },
  };

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, table, own);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SDF_SNAP_GLSL}`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
	vec3 bsP = bsSnap(position);
	objectNormal = normalize(bsGrad(bsP));`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
	transformed = bsP;`,
      );
  };
  material.customProgramCacheKey = () => 'blendshell-body-v1';

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = true;

  return {
    mesh,
    geometry,
    material,
    table,
    updateParts(parts: readonly SdfPart[]): void {
      writePartTable(table, parts);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
