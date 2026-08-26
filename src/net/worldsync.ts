/**
 * One world, many screens.
 *
 * Every browser that opened the public link used to run its OWN simulation.
 * The cast was shared — the pipeline is pure, so the same drawings build the
 * same creatures everywhere — but the choreography was not: agents advance
 * on local frame timing, so two tabs diverged from the first frame, and
 * somebody arriving later started everyone back at their spawn spots. Two
 * people on the same url saw two different worlds and had no way to know
 * (user report, 2026-08-25).
 *
 * There was a second half to that: `publishToPhones` was never gated on
 * anything, so EVERY open viewer was broadcasting poses to the handsets in
 * that room. Two laptops on the live link meant phones receiving two
 * interleaved simulations.
 *
 * So one instance simulates and everybody else watches it.
 *
 * ── who ──────────────────────────────────────────────────────────────────
 * Nobody is appointed. Each page publishes a claim carrying its own id and
 * heartbeats it; the winner is simply the smallest live id anyone can see,
 * which every page computes for itself and agrees on without a round of
 * negotiation. A page that goes away stops heartbeating, its claim goes
 * stale, and the next-smallest id takes over within a few seconds.
 *
 * That means a person who opens the link alone becomes the host of their
 * own world and sees it living — the alternative, a world that only moves
 * when a projection happens to be running, is a dead link at three in the
 * morning. A projection can still be pinned as host with `?host=1`: it
 * takes an id beginning with '!', which sorts below every generated one,
 * so it wins the same election without a special case anywhere.
 *
 * ── what ─────────────────────────────────────────────────────────────────
 * Positions, quantized, on a roster of ids sent separately. Ids are much
 * bigger than coordinates, and at conference scale re-sending them at frame
 * rate is most of the traffic: 300 creatures costs ~50KB/s with ids inline
 * and ~27KB/s without. The roster carries a revision; a pose frame names
 * the revision it was packed against, and a viewer that does not have that
 * revision yet ignores the frame rather than applying it to the wrong
 * creatures.
 *
 * Everything here is pure — no MQTT, no DOM, no Three.js. The transport is
 * wired in src/main.ts.
 */

/** How often the host repeats its claim. */
export const HOST_HEARTBEAT_MS = 2000;
/** A claim older than this is from a page that has gone away. Three beats,
 * so one dropped message never causes a takeover. */
export const HOST_STALE_MS = 6000;
/**
 * How often a page re-checks whether it is still the host.
 *
 * Much shorter than the heartbeat on purpose. Publishing a claim is what
 * tells everyone else you exist; deciding whether you are still the one
 * simulating is free, and the window where two pages both think they are
 * is the thing worth keeping small.
 */
export const ROLE_SETTLE_MS = 500;

/** Pose frames per second. Creatures move at 1.2 u/s, so this is plenty to
 * interpolate between and it keeps a public broker comfortable. */
export const POSE_HZ = 5;
export const POSE_INTERVAL_MS = 1000 / POSE_HZ;
/** Re-send the roster this often even when unchanged, so a viewer that
 * joined mid-stream does not wait for a creature to arrive or leave. */
export const ROSTER_REPEAT_MS = 2000;

/** Positions are sent as hundredths of a world unit. */
const POS_SCALE = 100;
/** Headings as thousandths of a radian. */
const ROT_SCALE = 1000;

/** A page saying "I am here, and this is when". */
export interface HostClaim {
  t: 'host';
  id: string;
  at: number;
}

/** The ordered ids a pose frame's numbers line up with. */
export interface RosterMessage {
  t: 'roster';
  id: string;
  rev: number;
  ids: string[];
}

/** One frame of the world, packed. */
export interface PoseMessage {
  t: 'poses';
  id: string;
  rev: number;
  /** x, z, heading per creature, in roster order, quantized. */
  p: number[];
}

export type WorldSyncMessage = HostClaim | RosterMessage | PoseMessage;

/** A creature's place in the world, unpacked. */
export interface Pose {
  id: string;
  x: number;
  z: number;
  heading: number;
}

/**
 * A page's own id.
 *
 * A forced host takes an id beginning with '!', which sorts below every
 * digit and letter — so "the smallest live id wins" already prefers it and
 * the election needs no notion of forcing at all.
 */
export function makeHostId(forced: boolean, random: () => number = Math.random): string {
  const body = random().toString(36).slice(2, 10).padEnd(8, '0');
  return forced ? `!${body}` : body;
}

/** Is an id one that was pinned with `?host=1`? */
export function isForcedId(id: string): boolean {
  return id.startsWith('!');
}

/**
 * Who should be simulating, given every claim this page has heard.
 *
 * The smallest id that is still live. `me` counts as live by definition —
 * a page always knows it is running — so with no other claims at all the
 * answer is `me`, which is what makes a single visitor's world move.
 */
export function electHost(
  me: string,
  lastSeen: ReadonlyMap<string, number>,
  nowMs: number,
  staleMs: number = HOST_STALE_MS,
): string {
  let best = me;
  for (const [id, at] of lastSeen) {
    if (id === me) continue;
    if (nowMs - at > staleMs) continue;
    if (id < best) best = id;
  }
  return best;
}

/** Drop claims from pages that have gone quiet, so the map cannot grow. */
export function pruneClaims(
  lastSeen: Map<string, number>,
  nowMs: number,
  staleMs: number = HOST_STALE_MS,
): void {
  for (const [id, at] of lastSeen) {
    if (nowMs - at > staleMs * 2) lastSeen.delete(id);
  }
}

/** Pack poses against a roster. Poses not in the roster are skipped. */
export function packPoses(poses: readonly Pose[], roster: readonly string[]): number[] {
  const byId = new Map<string, Pose>();
  for (const pose of poses) byId.set(pose.id, pose);
  const out: number[] = [];
  for (const id of roster) {
    const pose = byId.get(id);
    // A hole would shift every creature after it onto the wrong id, so an
    // absent one is sent as its own zeros and skipped on the other side.
    out.push(
      Math.round((pose?.x ?? 0) * POS_SCALE),
      Math.round((pose?.z ?? 0) * POS_SCALE),
      Math.round((pose?.heading ?? 0) * ROT_SCALE),
    );
  }
  return out;
}

/**
 * Unpack a frame against the roster it was packed with.
 *
 * Returns [] when the roster does not match the frame's length — a frame
 * applied against the wrong roster would put every creature on somebody
 * else's position, which is worse than dropping it.
 */
export function unpackPoses(p: readonly number[], roster: readonly string[]): Pose[] {
  if (p.length !== roster.length * 3) return [];
  const out: Pose[] = [];
  for (let i = 0; i < roster.length; i++) {
    out.push({
      id: roster[i]!,
      x: p[i * 3]! / POS_SCALE,
      z: p[i * 3 + 1]! / POS_SCALE,
      heading: p[i * 3 + 2]! / ROT_SCALE,
    });
  }
  return out;
}

/** Narrow an arbitrary parsed payload to a message we understand. */
export function readWorldSyncMessage(value: unknown): WorldSyncMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  const id = typeof rec['id'] === 'string' ? rec['id'] : '';
  if (!id) return null;
  if (rec['t'] === 'host' && typeof rec['at'] === 'number') {
    return { t: 'host', id, at: rec['at'] };
  }
  if (rec['t'] === 'roster' && typeof rec['rev'] === 'number' && Array.isArray(rec['ids'])) {
    const ids = rec['ids'].filter((v): v is string => typeof v === 'string');
    if (ids.length !== rec['ids'].length) return null;
    return { t: 'roster', id, rev: rec['rev'], ids };
  }
  if (rec['t'] === 'poses' && typeof rec['rev'] === 'number' && Array.isArray(rec['p'])) {
    const p = rec['p'].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (p.length !== rec['p'].length) return null;
    return { t: 'poses', id, rev: rec['rev'], p };
  }
  return null;
}

/**
 * The shortest way round from one heading to another.
 *
 * Interpolating raw radians takes the long way whenever the two straddle
 * ±π, and a creature that spins 350° to face 10° left is the abrupt,
 * unmotivated motion the whole motion law is against.
 */
export function shortestAngle(from: number, to: number): number {
  const tau = Math.PI * 2;
  let d = (to - from) % tau;
  if (d > Math.PI) d -= tau;
  if (d < -Math.PI) d += tau;
  return d;
}

/**
 * How far to move toward a target this frame.
 *
 * Exponential convergence: monotone, never overshoots, never fully arrives
 * — which is exactly the damping the motion law requires (ζ ≥ 1, no
 * overshoot at confidence 1.00) and, conveniently, also what keeps a
 * viewer's creatures drifting between pose frames instead of stepping.
 */
export function followFraction(dtMs: number, tauMs: number): number {
  if (dtMs <= 0) return 0;
  if (tauMs <= 0) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

/**
 * Time constant for following the host, from the pose interval.
 *
 * Derived rather than picked: a little under half the gap between frames,
 * so a creature has substantially arrived when the next one lands but is
 * still moving when it does. Faster and it steps; slower and it lags
 * visibly behind the world it is meant to be showing.
 */
export const FOLLOW_TAU_MS = POSE_INTERVAL_MS * 0.45;
