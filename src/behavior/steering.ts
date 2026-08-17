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
 * Determinism: candidate sampling pulls from the injected rand01 stream.
 * No Three.js, no DOM, no Math.random.
 */

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
 */
export function pickWanderTarget(
  self: Vec2,
  peers: readonly Vec2[],
  quadrantVisits: readonly [number, number, number, number],
  energy: number,
  rand01: () => number,
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
    const candidate = { x: cx, z: cz };

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
