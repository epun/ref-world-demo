/**
 * Kinematic circle resolution — PURE (no Three.js, no DOM, no clocks).
 *
 * Hard bodies: circle-vs-circle positional correction + tangential slide.
 * The creature circle is pushed out along the penetration normal and the
 * inward component of its velocity is removed — the tangential component is
 * kept untouched, so contact reads as flowing along the surface. There is
 * deliberately NO restitution term anywhere in this file: bounce is
 * forbidden at confidence 1.00 (TASTE §2.1), so a collision can only
 * correct position and redirect velocity, never reflect it.
 *
 * Soft bodies (bushes): no positional correction at all — walking in simply
 * damps ground speed (~55% off), and the visible reaction is the scatter's
 * nudge sway, not a force.
 *
 * Creature-vs-creature: soft mutual separation. Overlap beyond a hard cap
 * (~40% of the summed radii) corrects immediately; the remainder relaxes
 * out exponentially at half strength, so two creatures brush past each
 * other with a soft shoulder, never a shove and never a stack.
 *
 * Everything works in x/z only — the Surface seam owns height.
 */

import type { Collider } from './colliders';

/** Sweeps over the nearby set: two handles the common corner (a push-out
 * landing inside a neighbor); deep pockets get a few extra sweeps up to the
 * cap, so a resolved body is penetration-free whenever a clear spot exists
 * within local corrections. */
export const RESOLVE_PASSES = 2;
export const RESOLVE_PASSES_MAX = 8;

/** Push-out skin, world units: corrections clear the surface by this hair
 * so corner sweeps terminate instead of chasing a geometric tail. 1mm at
 * world scale — positional slop, invisible, and NOT a rebound. */
export const RESOLVE_SKIN = 1e-3;

/** Creature collision circle = character.radius × this. A touch inside the
 * silhouette, so brushing past props reads close, not force-fielded. */
export const CREATURE_BODY_FIT = 0.8;

/** Ground-speed multiplier while overlapping a soft body (~55% damped). */
export const SOFT_SPEED_FACTOR = 0.45;

/** Two creatures never overlap deeper than this fraction of their summed
 * radii — the immediate-correction cap. */
export const MAX_CREATURE_OVERLAP = 0.4;

/** Exponential relaxation time of the soft separation, ms. */
export const SEPARATION_RELAX_MS = 250;

/** A moving circle: position (world x/z) + ground velocity (units/s). */
export interface KinematicBody {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/**
 * Resolve `body` (radius `r`) against the HARD colliders in `nearby`,
 * in place: push out along the penetration normal to exact contact, and
 * remove the velocity component INTO the surface (slide — the tangential
 * component is preserved bit-for-bit, and an outward normal component is
 * left alone). Soft colliders are ignored here. Sweeps stop as soon as a
 * full pass makes no correction — usually after `passes`, with extra sweeps
 * up to RESOLVE_PASSES_MAX for deep corner pockets. Returns true when any
 * contact corrected the body.
 */
export function resolveHard(
  body: KinematicBody,
  r: number,
  nearby: readonly Collider[],
  passes: number = RESOLVE_PASSES,
): boolean {
  let touched = false;
  const maxPasses = Math.max(passes, RESOLVE_PASSES_MAX);
  for (let pass = 0; pass < maxPasses; pass++) {
    let corrected = false;
    for (const c of nearby) {
      if (!c.hard) continue;
      const dx = body.x - c.x;
      const dz = body.z - c.z;
      const rr = r + c.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      // Dead-center overlap: deterministic +x normal.
      const nx = d > 1e-9 ? dx / d : 1;
      const nz = d > 1e-9 ? dz / d : 0;
      // Positional correction to contact (+ the termination skin) — a
      // static clearance, never a rebound.
      const pen = rr - d + RESOLVE_SKIN;
      body.x += nx * pen;
      body.z += nz * pen;
      // Slide: drop the inward normal component, keep the tangent.
      const vn = body.vx * nx + body.vz * nz;
      if (vn < 0) {
        body.vx -= nx * vn;
        body.vz -= nz * vn;
      }
      corrected = true;
      touched = true;
    }
    if (!corrected) break;
  }
  return touched;
}

/**
 * Deepest soft collider overlapping the circle, or null. "Deepest" by
 * penetration depth; ties break to input order (deterministic).
 */
export function deepestSoftOverlap(
  x: number,
  z: number,
  r: number,
  nearby: readonly Collider[],
): Collider | null {
  let best: Collider | null = null;
  let bestPen = 0;
  for (const c of nearby) {
    if (c.hard) continue;
    const dx = x - c.x;
    const dz = z - c.z;
    const rr = r + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) continue;
    const pen = rr - Math.sqrt(d2);
    if (pen > bestPen) {
      bestPen = pen;
      best = c;
    }
  }
  return best;
}

/** Per-circle displacement of one separation step (apply to a, negate-free:
 * b gets its own signed pair). */
export interface SeparationOffsets {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/**
 * Soft mutual separation between two creature circles. Overlap beyond the
 * MAX_CREATURE_OVERLAP cap is corrected immediately (split half/half); the
 * remaining overlap relaxes out exponentially over SEPARATION_RELAX_MS at
 * half strength. Returns null when the circles don't overlap. Writes into
 * `out` when provided (allocation-free in the per-frame path).
 */
export function separationOffsets(
  ax: number,
  az: number,
  ar: number,
  bx: number,
  bz: number,
  br: number,
  dt: number,
  out?: SeparationOffsets,
): SeparationOffsets | null {
  const dx = ax - bx;
  const dz = az - bz;
  const sum = ar + br;
  const d2 = dx * dx + dz * dz;
  if (d2 >= sum * sum) return null;
  const d = Math.sqrt(d2);
  // Dead-center: deterministic +x split.
  const nx = d > 1e-9 ? dx / d : 1;
  const nz = d > 1e-9 ? dz / d : 0;
  const pen = sum - d;
  const cap = MAX_CREATURE_OVERLAP * sum;
  const excess = Math.max(0, pen - cap);
  // Half-strength soft push on the capped remainder, relaxed by dt.
  const relax = 1 - Math.exp(-Math.max(0, dt) / SEPARATION_RELAX_MS);
  const soft = (pen - excess) * 0.5 * relax;
  const each = (excess + soft) * 0.5;
  const o = out ?? { ax: 0, az: 0, bx: 0, bz: 0 };
  o.ax = nx * each;
  o.az = nz * each;
  o.bx = -nx * each;
  o.bz = -nz * each;
  return o;
}
