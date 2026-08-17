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
 * Creature-vs-creature: HARD mutual separation. Every overlapping pair is
 * pushed apart to exact contact each step, the correction split half/half
 * (symmetric), iterated so chains of creatures resolve. A pair closing
 * head-on gets a small deterministic tangential bias on the correction so
 * the two shoulder PAST each other instead of stalling nose to nose. All
 * of it is positional — no impulses, no restitution, no relaxation timer.
 *
 * stepCreatures ties it together: position integration is substepped so a
 * clamped-dt frame (up to 250ms) can never carry a body across a collider
 * in one leap (tunneling), and each substep runs hard resolve + pair
 * separation + a hard backstop so no push lands anyone inside anything.
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

/** Pair-separation sweeps per step: chains of creatures (a) push (b) push
 * (c) resolve within a few passes. */
export const SEPARATION_PASSES = 3;

/** Deep stacks (three-in-a-row spawn bursts) converge geometrically; the
 * sweep keeps going up to this cap whenever a pass still found overlap. */
export const SEPARATION_PASSES_MAX = 16;

/** Head-on tangential bias: fraction of each half-correction redirected
 * along the contact tangent when a pair is closing, so two creatures
 * meeting nose to nose glide around each other instead of stalling. Moving
 * the pair in OPPOSITE tangent directions only ever increases their
 * distance, so the bias can never re-create penetration. */
export const HEAD_ON_SLIDE = 0.4;

/** Max distance a body may travel in one resolve substep, world units —
 * comfortably under the smallest hard footprint (conifer trunk ~0.39u at
 * min instance scale), so a step can never leap a collider. */
export const MAX_STEP_TRAVEL = 0.25;

/** Substep cap: 16 × MAX_STEP_TRAVEL = 4u of covered travel per frame,
 * far beyond peak creature speed × the 250ms dt clamp. */
export const MAX_SUBSTEPS = 16;

/** A moving circle: position (world x/z) + ground velocity (units/s). */
export interface KinematicBody {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/** A creature circle in the pair-separation set: a kinematic body that
 * also carries its collision radius. */
export interface CreatureBody extends KinematicBody {
  r: number;
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
 *
 * `hardPadFrac` fractionally inflates every hard collider radius during the
 * test (r × (1 + pad)): the scatter's per-instance shape variation widens a
 * prop's VISUAL silhouette beyond its published footprint circle by up to
 * ~11% (scale jitter + bulge), and the pad keeps the resolve at the visual
 * surface instead of the nominal one.
 */
export function resolveHard(
  body: KinematicBody,
  r: number,
  nearby: readonly Collider[],
  passes: number = RESOLVE_PASSES,
  hardPadFrac = 0,
): boolean {
  let touched = false;
  const maxPasses = Math.max(passes, RESOLVE_PASSES_MAX);
  const pad = 1 + Math.max(0, hardPadFrac);
  for (let pass = 0; pass < maxPasses; pass++) {
    let corrected = false;
    for (const c of nearby) {
      if (!c.hard) continue;
      const dx = body.x - c.x;
      const dz = body.z - c.z;
      const rr = r + c.r * pad;
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

/**
 * Hard mutual separation over a set of creature circles, in place. Every
 * overlapping pair is pushed to exact contact (+ skin) along the pair
 * normal, the correction split half/half — a symmetric, NON-penetration
 * constraint, not an advisory nudge. Pairs are visited in input-array
 * order (callers sort by slot id for frame-to-frame determinism) and the
 * sweep iterates up to `passes` times so chains resolve; it stops early the
 * moment a pass finds nothing to correct.
 *
 * Slide, two ways, neither an impulse:
 *  - the closing component of the pair's RELATIVE velocity is removed
 *    (split evenly), exactly like resolveHard's wall slide — tangential
 *    velocity is preserved bit-for-bit, so nobody walks in place against a
 *    shoulder and nobody rebounds;
 *  - a closing pair additionally angles its positional correction along the
 *    contact tangent (HEAD_ON_SLIDE, weighted by how head-on the approach
 *    is) with ONE fixed chirality — every pair passes on the same side, a
 *    world-wide "keep left". The chirality must not be derived from the
 *    contact normal's tiny lateral component: at a near-perfect head-on
 *    that sign is noise and flips frame to frame, cancelling the glide
 *    into a nose-to-nose stall. A constant side circulates the pair
 *    smoothly around each other. Opposite tangent moves only ever increase
 *    pair distance — the bias cannot create penetration.
 *
 * Returns true when any pair needed correcting. Sweeps continue past
 * `passes` (up to SEPARATION_PASSES_MAX) while overlap remains, mirroring
 * resolveHard — deep chains converge geometrically.
 */
export function separateCreatures(
  bodies: readonly CreatureBody[],
  passes: number = SEPARATION_PASSES,
): boolean {
  let touched = false;
  const maxPasses = Math.max(passes, SEPARATION_PASSES_MAX);
  for (let pass = 0; pass < maxPasses; pass++) {
    let corrected = false;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const sum = a.r + b.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= sum * sum) continue;
        const d = Math.sqrt(d2);
        // Dead-center: deterministic +x split.
        const nx = d > 1e-9 ? dx / d : 1;
        const nz = d > 1e-9 ? dz / d : 0;
        const half = (sum - d + RESOLVE_SKIN) * 0.5;

        // Closing analysis on the relative velocity (a relative to b).
        const rvx = a.vx - b.vx;
        const rvz = a.vz - b.vz;
        const closing = -(rvx * nx + rvz * nz); // > 0 → approaching
        let tx = 0;
        let tz = 0;
        if (closing > 1e-9) {
          const rel = Math.hypot(rvx, rvz);
          // 1 at a pure head-on approach, 0 when merely grazing.
          const headness = closing / rel;
          // Fixed world chirality (see header) — never sign-of-noise.
          const slide = half * HEAD_ON_SLIDE * headness;
          tx = -nz * slide;
          tz = nx * slide;
          // Remove the closing relative-velocity component, split evenly —
          // a projection onto the contact tangent, never added energy.
          const each = closing * 0.5;
          a.vx += nx * each;
          a.vz += nz * each;
          b.vx -= nx * each;
          b.vz -= nz * each;
        }

        a.x += nx * half + tx;
        a.z += nz * half + tz;
        b.x -= nx * half + tx;
        b.z -= nz * half + tz;
        corrected = true;
        touched = true;
      }
    }
    if (!corrected) break;
  }
  return touched;
}

/** Collider lookup around a circle — the manager's spatial-hash + egg
 * gather, injected so this module stays pure. The returned array may be
 * reused between calls. */
export type NearbyQuery = (x: number, z: number, r: number) => readonly Collider[];

export interface StepOptions {
  /** Per-substep travel cap, world units. */
  maxTravel?: number;
  maxSubsteps?: number;
  /** Pair-separation sweeps per substep. */
  passes?: number;
  /** Fractional inflation of hard collider radii (see resolveHard). */
  hardPadFrac?: number;
}

const backstopScratch: KinematicBody = { x: 0, z: 0, vx: 0, vz: 0 };

/**
 * Advance a set of creature bodies by `dt` (ms): substepped position
 * integration + hard prop resolve + hard pair separation, in place.
 *
 * Substepping is the anti-tunneling guarantee: the frame's dt is split so
 * no body travels more than `maxTravel` (default MAX_STEP_TRAVEL, under the
 * smallest hard footprint) between resolves — a clamped 250ms frame at any
 * sane speed can no longer step across a trunk or through a peer. Each
 * substep runs, in order:
 *   1. integrate + resolveHard per body (input-array order — callers sort
 *      by slot id for determinism),
 *   2. pair separation interleaved with a positional-only hard backstop
 *      (velocity untouched), so a pair push never parks anyone inside a
 *      rock and the rock push never re-stacks the pair.
 *
 * All corrections positional; velocities only ever LOSE their component
 * into a surface (slide) — no impulses, no restitution, nothing to bounce.
 */
export function stepCreatures(
  bodies: readonly CreatureBody[],
  dt: number,
  near: NearbyQuery,
  opts: StepOptions = {},
): void {
  if (bodies.length === 0 || dt <= 0) return;
  const maxTravel = opts.maxTravel ?? MAX_STEP_TRAVEL;
  const maxSub = opts.maxSubsteps ?? MAX_SUBSTEPS;
  const passes = opts.passes ?? SEPARATION_PASSES;
  const pad = opts.hardPadFrac ?? 0;

  let vMax = 0;
  for (const b of bodies) {
    const v = Math.hypot(b.vx, b.vz);
    if (v > vMax) vMax = v;
  }
  const travel = (vMax * dt) / 1000;
  const steps = Math.min(maxSub, Math.max(1, Math.ceil(travel / maxTravel)));
  const subDt = dt / steps;

  for (let s = 0; s < steps; s++) {
    for (const b of bodies) {
      b.x += (b.vx * subDt) / 1000;
      b.z += (b.vz * subDt) / 1000;
      resolveHard(b, b.r, near(b.x, b.z, b.r), RESOLVE_PASSES, pad);
    }
    // Pair separation ↔ hard backstop, interleaved to a fixed depth: each
    // round separates every overlapping pair, then re-seats anyone a pair
    // push left inside a hard body (positional only — the backstop must
    // not eat the walking velocity). Converges in 1 round in the open;
    // the extra rounds handle prop-adjacent squeezes.
    for (let k = 0; k < passes; k++) {
      if (!separateCreatures(bodies, 1)) break;
      for (const b of bodies) {
        backstopScratch.x = b.x;
        backstopScratch.z = b.z;
        backstopScratch.vx = 0;
        backstopScratch.vz = 0;
        if (
          resolveHard(
            backstopScratch,
            b.r,
            near(b.x, b.z, b.r),
            RESOLVE_PASSES,
            pad,
          )
        ) {
          b.x = backstopScratch.x;
          b.z = backstopScratch.z;
        }
      }
    }
  }
}
