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
 * so it wins the same election without a special case anywhere. A HANDSET
 * takes one beginning with '~', which sorts above every generated one, so
 * it hosts only when there is nothing else on the link (see `HostRole`).
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

import { MAX_SCENE_BATCH, readSceneBatch, type SceneEvent } from '../session/scene';

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
  /**
   * The ids still standing as EGGS on the host, when it says (2026-09-10).
   *
   * A `hatch` is a moment and travels once; a viewer that joined after it,
   * or missed the packet on a qos-0 broker, would otherwise hold an egg
   * forever under a world where that creature is walking about. So the
   * roster the host already repeats every ROSTER_REPEAT_MS carries the
   * standing eggs too, and a viewer reconciles against it — see
   * `eggsOpenedByHost`.
   *
   * Optional because ABSENT and EMPTY mean different things. Empty is a
   * host saying "no eggs here", which opens a viewer's; absent is a host
   * that never mentions eggs at all, and hatching a viewer's clutch on the
   * strength of a field that was never sent would open a room of them the
   * instant one old page anywhere published a roster.
   */
  eggs?: string[];
}

/**
 * The host opened one egg, and every screen opens it too (user ask,
 * 2026-09-10: *"in the demo let's pause the hatching until I press h on the
 * keyboard"*).
 *
 * Every phone's world view is its own copy of the world page, following the
 * host's poses. Poses only place creatures that are already alive — a shell
 * breaking is not a position, it is an event — so without this a viewer's
 * egg either sat there while the projection's creature walked away from it,
 * or opened on a local timer at some unrelated moment. Neither is one world.
 *
 * `who` is the CREATURE (the drawer id it was spawned under) and `id` is the
 * page, kept apart for the same reason a drive keeps them apart.
 *
 * NOT a host claim: hearing one never enters its sender into the election —
 * a page that can open eggs is not thereby a candidate to simulate. But it
 * is only honoured FROM the host, exactly as a pose frame is: the hatch is
 * the host's decision to make and nobody else's.
 */
export interface HatchMessage {
  t: 'hatch';
  /** The page that sent it. */
  id: string;
  /** The creature whose shell opened. */
  who: string;
}

/**
 * OPEN THEM ALL — asked by a page that is not the one simulating
 * (user report, 2026-09-10: *"we have a bug where people can't move around
 * the map"*).
 *
 * `h` and `shift+h` are the operator's keys, and in a manual world they are
 * the only thing that turns a clutch of eggs into a cast that can be
 * steered. But the press only ever opened THIS page's eggs, and `hatch`
 * travels one way — down, from the host. So an operator whose projection
 * had lost the election (see `HostRole`) pressed `h`, watched its own eggs
 * open, and every handset in the room kept a shell: an egg has no character
 * to drive, so `drive` returned false on all of them and nobody could move.
 *
 * This is the press travelling UP, like `drive` and for the same reason: it
 * is a request, not a decision. The host receives it and calls its own
 * `hatchAll()`, which broadcasts the hatches back down the way every other
 * hatch already goes. NOT a host claim — asking for the eggs to open is not
 * a bid to simulate the world — and it carries no `who`, because it is the
 * whole clutch or nothing, exactly as the key has always meant.
 */
export interface HatchAllMessage {
  t: 'hatchall';
  /** The page that asked. */
  id: string;
}

/** One frame of the world, packed. */
export interface PoseMessage {
  t: 'poses';
  id: string;
  rev: number;
  /** x, z, heading per creature, in roster order, quantized. */
  p: number[];
}

/**
 * Somebody is steering their own creature (src/world/joystick.ts).
 *
 * The one message that travels UP this topic rather than down it. Poses and
 * rosters are the host describing the world; this is a viewer asking for
 * one thing in it, and only the host acts on it.
 *
 * An INTENT, not a position. Sending "put my creature here" from a handset
 * would hand a phone authority over the simulation and let a laggy one
 * teleport a creature across the field; sending "I am pushing this way"
 * leaves the host's collision, its soft bodies and its speed limits in
 * charge of what actually happens. The worst a bad drive frame can do is
 * walk one creature in a silly direction for 200ms.
 *
 * `who` is the creature — the drawer id it was spawned under — and is
 * deliberately separate from `id`, which is the PAGE. One page steers one
 * creature today, but they are not the same thing and conflating them
 * would make a second stick unrepresentable.
 */
export interface DriveMessage {
  t: 'drive';
  /** The page that sent it. */
  id: string;
  /** The creature being steered. */
  who: string;
  x: number;
  z: number;
  mag: number;
}

/**
 * A change to the SHARED SCENE — the landscape switch, a terrain dial, a dab
 * of the brush (src/session/scene.ts, docs/SESSION.md §6).
 *
 * 2026-09-09, the demo plan: the operator sculpts the world live in front of
 * the room, and every phone — each of which is running its own copy of this
 * same page — has to see the ground change under its creature. Poses cannot
 * carry that: they say where the cast is standing, not what it is standing
 * on, and a viewer following poses over a flat plain has its creatures
 * hovering above a world it never heard about.
 *
 * LIKE `drive`, THIS IS NOT A HOST CLAIM. It travels sideways rather than
 * down: whoever moved the ground says so, and every page — host or viewer —
 * applies it, because every page is drawing that ground for itself. Letting
 * it into the election would make a phone with a brush a candidate to
 * simulate the world.
 *
 * `seq` is the sender's own counter. Nothing depends on it today (the events
 * are idempotent and the store is the tiebreak); it is here so a receiver
 * that ever needs to notice a gap can, without a format change.
 *
 * `reset` is the whole scene thrown away — the panel's `reset scene`. It
 * carries no events: there is nothing to describe about an empty map.
 */
export interface SceneMessage {
  t: 'scene';
  id: string;
  seq: number;
  events: SceneEvent[];
  reset?: true;
}

export type WorldSyncMessage =
  | HostClaim
  | RosterMessage
  | PoseMessage
  | DriveMessage
  | SceneMessage
  | HatchMessage
  | HatchAllMessage;

/**
 * How often a held stick repeats its intent.
 *
 * Faster than poses, because this is the leg of the round trip a person
 * feels: their thumb moves, the host hears, the host simulates, a pose
 * comes back. Two of those four are already paced by POSE_HZ and there is
 * no reason to pay that tax twice on the way up.
 */
export const DRIVE_HZ = 12;
export const DRIVE_INTERVAL_MS = 1000 / DRIVE_HZ;

/**
 * A drive this old is from a hand that has gone away.
 *
 * The release message is a single qos-0 packet and the whole point of qos 0
 * is that it may not arrive. Without an expiry, one dropped release leaves
 * a creature walking in a straight line forever, and the person who was
 * steering it has already put their phone in their pocket. Generous enough
 * to ride out a few dropped frames, short enough that nobody watches a
 * creature march off the map.
 */
export const DRIVE_STALE_MS = 600;

/** A creature's place in the world, unpacked. */
export interface Pose {
  id: string;
  x: number;
  z: number;
  heading: number;
}

/**
 * What kind of page is asking for an id — which is the whole election.
 *
 * `forced` is the OPERATOR'S page: pinned with `?host=1`, holding the
 * moderator secret, or running the dev surface. It is the projection in
 * front of the room, and the room's world is its to simulate.
 *
 * `page` is any other browser on the link — a laptop, a second projection,
 * somebody's desktop. The ordinary candidate.
 *
 * `phone` is a HANDSET looking at the world it drew into. It is a candidate
 * of last resort: it goes to sleep in a pocket, it walks out of the room,
 * and its battery saver throttles the timers the whole simulation runs on.
 * A phone hosting a room of phones is how a projection ends up a viewer —
 * and then `h` on the projection opens only its own eggs, every handset
 * keeps a shell it cannot steer, and the room reports that nobody can move
 * (user report, 2026-09-10).
 */
export type HostRole = 'forced' | 'page' | 'phone';

/** The character each role's id is prefixed with, chosen for how it SORTS. */
const ROLE_PREFIX: Record<HostRole, string> = {
  // '!' is below every digit and letter.
  forced: '!',
  page: '',
  // '~' is above every digit and letter — 126, past 'z' at 122.
  phone: '~',
};

/**
 * A page's own id.
 *
 * The role is carried in the id's FIRST CHARACTER and nowhere else, so
 * "the smallest live id wins" already ranks operator over page over phone
 * and the election needs no notion of any of them. A phone still wins when
 * it is the only page on the link — its id is the smallest one there is —
 * which is what keeps a handset's world alive when nothing else is open.
 *
 * `boolean` is still accepted for the old two-way call: true is `forced`.
 */
export function makeHostId(
  role: HostRole | boolean,
  random: () => number = Math.random,
): string {
  const kind: HostRole = role === true ? 'forced' : role === false ? 'page' : role;
  const body = random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ROLE_PREFIX[kind]}${body}`;
}

/** Is an id one that was pinned with `?host=1` (or holds the secret)? */
export function isForcedId(id: string): boolean {
  return id.startsWith(ROLE_PREFIX.forced);
}

/** Is an id a handset's — the candidate of last resort? */
export function isPhoneId(id: string): boolean {
  return id.startsWith(ROLE_PREFIX.phone);
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

/**
 * Which of MY eggs has the host already opened?
 *
 * The late-joiner's half of the manual hatch. A `hatch` message is a moment
 * and travels once, at qos 0; a page that opened after it — or blinked while
 * it went past — holds an egg for a creature the rest of the room is
 * watching walk around. The roster the host repeats anyway says which ids
 * are alive and which are still eggs, so this is the whole reconciliation:
 * an egg of mine that the host is showing ALIVE is one whose shell already
 * came off, and the viewer plays the same hatch it would have played.
 *
 * Both conditions matter. Not-in-`eggs` on its own would also catch an id
 * the host has never heard of — a drawing that reached this page and not
 * that one — and opening that would be this page inventing a hatch nobody
 * called. With `hostEggs` absent nothing is opened at all: that host is not
 * describing eggs, and silence is not permission.
 *
 * Pure, allocation-light, and safe to call on every roster.
 */
export function eggsOpenedByHost(
  mine: readonly string[],
  hostLive: readonly string[],
  hostEggs: readonly string[] | undefined,
): string[] {
  if (!hostEggs || mine.length === 0) return [];
  const stillEggs = new Set(hostEggs);
  const alive = new Set(hostLive);
  return mine.filter((id) => alive.has(id) && !stillEggs.has(id));
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
    // The standing eggs, when the sender mentions them at all. A malformed
    // list is refused with the rest of the message rather than read as an
    // empty one: "no eggs" opens every egg a viewer is holding, and that is
    // not a thing to infer from a field that did not parse.
    const raw = rec['eggs'];
    if (raw === undefined) return { t: 'roster', id, rev: rec['rev'], ids };
    if (!Array.isArray(raw)) return null;
    const eggs = raw.filter((v): v is string => typeof v === 'string');
    if (eggs.length !== raw.length) return null;
    return { t: 'roster', id, rev: rec['rev'], ids, eggs };
  }
  if (rec['t'] === 'hatch' && typeof rec['who'] === 'string' && rec['who']) {
    return { t: 'hatch', id, who: rec['who'] };
  }
  // The whole clutch, asked for from somewhere else. Nothing to validate
  // past the sender's id: it carries no creature and no number, which is
  // the point — it is the operator's key, not a list of shells.
  if (rec['t'] === 'hatchall') {
    return { t: 'hatchall', id };
  }
  if (rec['t'] === 'drive' && typeof rec['who'] === 'string' && rec['who']) {
    const x = rec['x'];
    const z = rec['z'];
    const mag = rec['mag'];
    if (typeof x !== 'number' || typeof z !== 'number' || typeof mag !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(mag)) return null;
    // Clamped at the door, not trusted and checked later. This arrives from
    // another device over a public broker: the simulation should be unable
    // to be handed a strength of a thousand, whatever sent it.
    return {
      t: 'drive',
      id,
      who: rec['who'],
      x: Math.max(-1, Math.min(1, x)),
      z: Math.max(-1, Math.min(1, z)),
      mag: Math.max(0, Math.min(1, mag)),
    };
  }
  if (rec['t'] === 'scene') {
    // Every event goes through the scene module's own door, which clamps
    // (src/session/scene.ts). One bad event is DROPPED and the rest of the
    // batch stands: this is a live world's ground arriving in pieces, and
    // refusing the packet over one dent means a phone that never sees the
    // landscape at all.
    const seq = typeof rec['seq'] === 'number' && Number.isFinite(rec['seq']) ? rec['seq'] : 0;
    const events = readSceneBatch(rec['events'], MAX_SCENE_BATCH);
    return {
      t: 'scene',
      id,
      seq,
      events,
      // Only the exact word. A truthy anything must not be able to wipe the
      // world's map.
      ...(rec['reset'] === true ? { reset: true as const } : {}),
    };
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
