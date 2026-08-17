/**
 * Steering (GENERATOR.md §Behavior, PLAN §7.1 dispersal) — PURE.
 *
 * Target selection and desired heading/speed per tick. NO position
 * integration here — the agent integrates through its ζ≥1 springs, the
 * manager applies the result to the scene graph.
 *
 * Dispersal is a system, not a hope (PLAN §7.1): wander targets are scored
 * away from crowded areas and toward the least-visited world quadrant, so a
 * population spreads instead of clumping around spawn. Energy scales the
 * roam radius (adventure creatures travel far; sleepy ones potter).
 *
 * Obstacles: wander/approach targets are never inside a hard collider
 * (projected out with clearance), and a light repulsion inside ~2 units of
 * a hard surface bends the desired heading so creatures flow around props —
 * the manager's positional resolve is a rare backstop, not the path.
 *
 * Determinism: candidate sampling pulls from the injected rand01 stream.
 * No Three.js, no DOM, no Math.random.
 */

import type { Collider, ColliderGrid } from '../physics/colliders';

export interface Vec2 {
  x: number;
  z: number;
}

export interface Steer {
  /** Desired facing, radians. rotation.y convention: forward = (sin h, cos h). */
  heading: number;
  /** Desired ground speed, world units per second. */
  speed: number;
}

/** Half-extent of the roamable field; wander targets stay inside. */
export const WORLD_EXTENT = 40;

/** Sit-beside / walk-together stand-off: approach targets sit this far
 * short of the peer. Never overlap — the emergent moment is two creatures
 * sitting NEXT to each other. */
export const STAND_OFF = 1.6;

/** Following trails a touch farther back than a direct approach. */
export const FOLLOW_STAND_OFF = 1.9;

/** Arrival slowing radius: inside it, desired speed ramps linearly to zero,
 * so the speed spring settles into a drift-stop, never a brake. */
export const ARRIVE_RADIUS = 3;

/** Candidate targets sampled per wander pick. */
const WANDER_CANDIDATES = 8;

/** Hard colliders start bending the heading inside this surface distance. */
export const AVOID_DISTANCE = 2;

/** Repulsion blend gain against the unit forward vector. */
export const AVOID_GAIN = 1.4;

/** Steering targets keep at least this clearance outside any hard collider
 * surface (≈ a creature body radius). */
export const TARGET_CLEARANCE = 0.9;

/**
 * Project a point out of every hard collider it sits inside (plus
 * clearance). Sweeps until clean — a projection can land inside an
 * overlapping neighbor, so single-pass is not enough in dense clusters —
 * capped for safety. Returns the input object untouched when already clear.
 */
export function projectOutOfHard(
  p: Vec2,
  colliders: ColliderGrid | null | undefined,
  clearance: number = TARGET_CLEARANCE,
): Vec2 {
  if (!colliders) return p;
  let x = p.x;
  let z = p.z;
  let moved = false;
  for (let pass = 0; pass < 8; pass++) {
    let corrected = false;
    for (const c of colliders.queryCircle(x, z, clearance)) {
      if (!c.hard) continue;
      const dx = x - c.x;
      const dz = z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + clearance;
      if (d >= min) continue;
      if (d < 1e-6) {
        x = c.x + min; // dead center: deterministic +x
      } else {
        x = c.x + (dx / d) * min;
        z = c.z + (dz / d) * min;
      }
      corrected = true;
      moved = true;
    }
    if (!corrected) break;
  }
  return moved ? { x, z } : p;
}

/**
 * Bend a desired heading away from nearby hard colliders. Per collider the
 * repulsion weight grows quadratically as the gap closes over
 * AVOID_DISTANCE, so the bend is smooth and monotone with proximity; the
 * repulsion blends into the unit forward vector and the result flows
 * through the caller's ζ≥1 heading spring — never a jerk. Head-on contacts
 * get a small tangential bias so the flow picks a side (deterministically,
 * by cross-product sign) instead of stalling against the normal.
 */
export function avoidanceBend(
  self: Vec2,
  desiredHeading: number,
  nearby: readonly Collider[],
): number {
  const fx = Math.sin(desiredHeading);
  const fz = Math.cos(desiredHeading);
  let rx = 0;
  let rz = 0;
  for (const c of nearby) {
    if (!c.hard) continue;
    const dx = self.x - c.x;
    const dz = self.z - c.z;
    const d = Math.hypot(dx, dz);
    const gap = d - c.r;
    if (gap >= AVOID_DISTANCE) continue;
    const t = 1 - Math.max(gap, 0) / AVOID_DISTANCE;
    const w = t * t;
    const nx = d > 1e-6 ? dx / d : 1;
    const nz = d > 1e-6 ? dz / d : 0;
    rx += nx * w;
    rz += nz * w;
    // Head-on: steer around, not just back. Side by the sign of the 2d
    // cross product forward × normal (ties break to +1 — deterministic).
    const head = -(fx * nx + fz * nz);
    if (head > 0.6) {
      const side = fx * nz - fz * nx >= 0 ? 1 : -1;
      rx += nz * side * w * head * 0.6;
      rz += -nx * side * w * head * 0.6;
    }
  }
  if (rx === 0 && rz === 0) return desiredHeading;
  const vx = fx + rx * AVOID_GAIN;
  const vz = fz + rz * AVOID_GAIN;
  if (Math.hypot(vx, vz) < 1e-6) return desiredHeading;
  return Math.atan2(vx, vz);
}

/** Wrap an angle to [-π, π). */
export function wrapAngle(a: number): number {
  const tau = Math.PI * 2;
  let r = (a + Math.PI) % tau;
  if (r < 0) r += tau;
  return r - Math.PI;
}

/** Signed shortest rotation from `from` to `to` — the heading spring's
 * unwrap: retarget to from + shortestDelta so it never takes the long way. */
export function shortestDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Heading from one point toward another (rotation.y convention). */
export function headingTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** World quadrant index of a point: 0:(+x,+z) 1:(-x,+z) 2:(-x,-z) 3:(+x,-z). */
export function quadrantOf(p: Vec2): 0 | 1 | 2 | 3 {
  if (p.z >= 0) return p.x >= 0 ? 0 : 1;
  return p.x < 0 ? 2 : 3;
}

/**
 * Pick a wander target near `self`: seeded candidates scored by
 *   - crowding penalty — summed nearness to every peer (dispersal), and
 *   - novelty bonus — toward the least-visited world quadrant.
 *
 * @param quadrantVisits per-agent visit tallies, indexed by quadrantOf
 * @param energy scales roam radius: 0 → potter nearby, 1 → travel far
 * @param colliders when present, every candidate is projected clear of hard
 *   colliders before scoring — a wander target is never inside a trunk or
 *   rock (draws no extra rand: determinism is unchanged by the grid)
 */
export function pickWanderTarget(
  self: Vec2,
  peers: readonly Vec2[],
  quadrantVisits: readonly [number, number, number, number],
  energy: number,
  rand01: () => number,
  colliders: ColliderGrid | null = null,
): Vec2 {
  const roamRadius = 5 + 20 * energy;
  const maxVisits = Math.max(...quadrantVisits);

  let best: Vec2 = self;
  let bestScore = -Infinity;
  for (let i = 0; i < WANDER_CANDIDATES; i++) {
    const angle = rand01() * Math.PI * 2;
    const radius = roamRadius * (0.35 + 0.65 * rand01());
    let cx = self.x + Math.sin(angle) * radius;
    let cz = self.z + Math.cos(angle) * radius;

    // Keep the field: fold overshoot back inside the extent.
    const fromOrigin = Math.hypot(cx, cz);
    const limit = WORLD_EXTENT * 0.95;
    if (fromOrigin > limit) {
      cx *= limit / fromOrigin;
      cz *= limit / fromOrigin;
    }
    const candidate = projectOutOfHard({ x: cx, z: cz }, colliders);

    let crowd = 0;
    for (const peer of peers) crowd += 1 / (1 + dist(candidate, peer));

    const visits = quadrantVisits[quadrantOf(candidate)];
    const novelty = (maxVisits - visits) / (maxVisits + 1);

    const score = novelty * 0.8 - crowd * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * Approach / sit-beside target: STAND_OFF short of the peer, on the
 * creature's own side — by construction never closer to the peer than the
 * stand-off, so bodies never overlap.
 */
export function approachTarget(
  self: Vec2,
  peer: Vec2,
  standOff: number = STAND_OFF,
): Vec2 {
  let dx = self.x - peer.x;
  let dz = self.z - peer.z;
  let d = Math.hypot(dx, dz);
  if (d < 1e-6) {
    // Degenerate overlap: step aside deterministically.
    dx = 1;
    dz = 0;
    d = 1;
  }
  return { x: peer.x + (dx / d) * standOff, z: peer.z + (dz / d) * standOff };
}

/**
 * Desired heading + speed toward a target with arrival slowing. Inside
 * ARRIVE_RADIUS desired speed ramps linearly to zero — through the agent's
 * speed spring that reads as a drift to rest, never an abrupt stop.
 *
 * @param currentHeading kept when the target is effectively reached
 */
export function arrive(
  self: Vec2,
  target: Vec2,
  maxSpeed: number,
  currentHeading: number,
  slowRadius: number = ARRIVE_RADIUS,
): Steer {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) return { heading: currentHeading, speed: 0 };
  return {
    heading: Math.atan2(dx, dz),
    speed: maxSpeed * Math.min(1, d / slowRadius),
  };
}
