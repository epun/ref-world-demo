/**
 * The SCENE — the part of a session everybody has to be looking at.
 *
 * WHY (2026-09-09, the demo plan): *"update the url without resetting the
 * scene and losing everyone's eggs… then I'll start painting and manipulating
 * the scene."* Drawings already survive both of those — they live in the
 * store and come back grown (docs/PUBLIC.md). The world the operator sculpts
 * in front of the room did not: the landscape switch, the three terrain dials
 * and every dab of the brush lived in the page that made them, so a phone
 * watching the same world saw the flat plain, and a redeploy threw the whole
 * evening's sculpting away.
 *
 * The fix is not a second channel. The session log is ALREADY the canonical
 * record of those changes, and `src/session/replay.ts` already knows how to
 * apply them. So the scene layer is a SUBSET of the log — the kinds that
 * describe the ground rather than the cast — shipped over the world sync
 * topic (src/net/worldsync.ts) and into `refworld:<world>:scene` (api/), and
 * applied on every page through the one driver. No second apply path, and
 * nothing here that a replay could not already do.
 *
 * PURE, like everything else in this directory: no DOM, no Three.js, no
 * clock, no randomness. It is imported by the wire, by the browser and by a
 * serverless handler, so it has to be all three-safe.
 *
 * UNTRUSTED INPUT. These events arrive over a public broker and out of a
 * database that a moderator writes. `readSceneEvent` is the door: it narrows
 * an arbitrary parsed value and CLAMPS what it lets through, exactly as
 * `readWorldSyncMessage` clamps a drive — the world should be unable to be
 * handed a brush of radius one thousand, whatever sent it.
 */

import type { PaintEvent, SessionEvent, WorldEvent } from './events';

/**
 * The `world` fields that describe the GROUND rather than the light or the
 * cast. Weather, time of day, grain and the paper colour are deliberately not
 * here: they are look, they are cheap to set on each page, and a room where
 * one person's phone re-tints everybody else's is a worse room. What has to
 * agree is the shape of the land people's creatures are standing on.
 */
export const SCENE_WORLD_FIELDS = ['landscape', 'terrain'] as const;

export type SceneWorldField = (typeof SCENE_WORLD_FIELDS)[number];

/**
 * One change to the shared scene: a world dial that shapes the ground, or a
 * dab of the terrain brush.
 *
 * A `WorldEvent` is only a scene event when its `field` is one of
 * SCENE_WORLD_FIELDS — the type cannot say that, so `isSceneEvent` does.
 */
export type SceneEvent = WorldEvent | PaintEvent;

/**
 * Ceiling on stored events, past which the list is compacted rather than
 * grown. Twenty thousand dabs is a long evening of sculpting and about a
 * megabyte of json; the compaction below is what keeps a world that has been
 * painted every day for a month loading in one request.
 */
export const MAX_SCENE_EVENTS = 20000;

/**
 * Ceiling on one wire message and one store write.
 *
 * The broker is a free public one and a single mqtt packet carrying a whole
 * session's sculpting is a way to get disconnected. The outbox chunks at this
 * (src/net/sceneoutbox.ts) and both doors refuse more.
 */
export const MAX_SCENE_BATCH = 500;

/**
 * The terrain dials' inclusive ranges, MIRRORED from `TERRAIN_LIMITS` in
 * src/world/landscape.ts.
 *
 * Copied rather than imported because this directory may only import pure
 * siblings (test/session/purity.test.ts pins that, and landscape.ts is a
 * world module however pure it is). test/session/scene.test.ts asserts the
 * two agree, so the copy cannot drift silently.
 */
export const SCENE_TERRAIN_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  elevation: [0, 2],
  tierStep: [0.6, 4],
  relief: [0.5, 2.5],
};

/**
 * Half-extent of the painted map in world units — MIRRORED from
 * `PAINTED_SIZE` in src/world/painted.ts, for the same reason as the dials
 * above, and pinned by the same test.
 *
 * Used as a bound, not as a conversion: a dab outside the map does nothing
 * anyway, and clamping is cheaper than trusting.
 */
export const SCENE_EXTENT = 400;

/** Largest brush radius a dab may claim, world units. The panel's own dial
 * stops at 40 (src/dev/paint.ts RADIUS_MAX); this is the door's bound, wide
 * enough never to argue with a real stroke. */
export const SCENE_MAX_RADIUS = 200;

/** Longest `tool` / `mode` string. Both are short identifiers. */
const MAX_LABEL = 16;

/** [D] Bound on a dab's amount. The brush's own strength slider is 0.02–1
 * and an erase runs it negative; anything past this is not a stroke. */
const MAX_STRENGTH = 8;

/** [D] Bound on a flatten target, world units of height. The authored map's
 * whole relief is tens of units. */
const MAX_HEIGHT = 1000;

/** Is this recorded event one the whole room has to see? */
export function isSceneEvent(event: SessionEvent): event is SceneEvent {
  if (event.k === 'paint') return true;
  if (event.k !== 'world') return false;
  return (SCENE_WORLD_FIELDS as readonly string[]).includes(event.field);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** An angle onto (-π, π]. A clamp would turn a wound-up rotation into a
 * facing nobody meant; a wrap is the same direction. */
function wrapAngle(v: number): number {
  const tau = Math.PI * 2;
  const wrapped = v - Math.floor((v + Math.PI) / tau) * tau;
  return wrapped;
}

/** A finite number, or null. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The offset, which an untrusted sender may simply have left off. */
function offset(value: unknown): number | null {
  if (value === undefined) return 0;
  const n = num(value);
  if (n === null || n < 0) return null;
  return n;
}

function readWorldScene(rec: Record<string, unknown>, t: number): SceneEvent | null {
  const field = rec['field'];
  if (field === 'landscape') {
    // Recorded as 1/0 by the panel; a boolean is accepted too, so a
    // hand-written log reads the way it looks (same rule as the replay
    // driver in src/main.ts). Anything else is not an answer to this switch.
    const value = rec['value'];
    if (value === true || value === 1) return { k: 'world', t, field: 'landscape', value: 1 };
    if (value === false || value === 0) return { k: 'world', t, field: 'landscape', value: 0 };
    return null;
  }
  if (field === 'terrain') {
    const kind = rec['kind'];
    if (typeof kind !== 'string') return null;
    const limit = SCENE_TERRAIN_LIMITS[kind];
    if (!limit) return null;
    const value = num(rec['value']);
    if (value === null) return null;
    return { k: 'world', t, field: 'terrain', value: clamp(value, limit[0], limit[1]), kind };
  }
  return null;
}

function readPaintScene(rec: Record<string, unknown>, t: number): SceneEvent | null {
  const tool = rec['tool'];
  if (typeof tool !== 'string' || tool.length === 0 || tool.length > MAX_LABEL) return null;
  // The map was thrown away: no geometry, nothing to clamp.
  if (tool === 'clear') return { k: 'paint', t, tool };

  const x = num(rec['x']);
  const z = num(rec['z']);
  const r = num(rec['r']);
  // A dab without a place or a size is not a dab. Missing geometry is
  // malformed; geometry off the end of the map is merely clamped.
  if (x === null || z === null || r === null || r <= 0) return null;

  const strength = rec['strength'] === undefined ? null : num(rec['strength']);
  if (rec['strength'] !== undefined && strength === null) return null;
  const hardness = rec['hardness'] === undefined ? null : num(rec['hardness']);
  if (rec['hardness'] !== undefined && hardness === null) return null;
  const seed = rec['seed'] === undefined ? null : num(rec['seed']);
  if (rec['seed'] !== undefined && seed === null) return null;
  const flattenTo = rec['flattenTo'] === undefined ? null : num(rec['flattenTo']);
  if (rec['flattenTo'] !== undefined && flattenTo === null) return null;
  // A pond dab's plane (src/session/events.ts `level`): without it a synced
  // or restored pond would fall through to the bank rule and lay a different
  // sheet on every screen. Same clamp as the flatten target — it is a height.
  const level = rec['level'] === undefined ? null : num(rec['level']);
  if (rec['level'] !== undefined && level === null) return null;
  // A waterfall mark's facing (src/session/events.ts `yaw`): without it a
  // synced mark would face whatever gradient the receiving page happens to
  // have under it. Wrapped rather than clamped — it is an angle, and every
  // real one is somewhere on the circle.
  const yaw = rec['yaw'] === undefined ? null : num(rec['yaw']);
  if (rec['yaw'] !== undefined && yaw === null) return null;
  const mode = rec['mode'];
  if (mode !== undefined && (typeof mode !== 'string' || mode.length > MAX_LABEL)) return null;

  return {
    k: 'paint',
    t,
    tool,
    x: clamp(x, -SCENE_EXTENT, SCENE_EXTENT),
    z: clamp(z, -SCENE_EXTENT, SCENE_EXTENT),
    r: Math.min(r, SCENE_MAX_RADIUS),
    ...(strength === null ? {} : { strength: clamp(strength, -MAX_STRENGTH, MAX_STRENGTH) }),
    ...(hardness === null ? {} : { hardness: clamp(hardness, 0, 1) }),
    ...(mode === undefined ? {} : { mode: mode as string }),
    ...(seed === null ? {} : { seed }),
    ...(flattenTo === null ? {} : { flattenTo: clamp(flattenTo, -MAX_HEIGHT, MAX_HEIGHT) }),
    ...(level === null ? {} : { level: clamp(level, -MAX_HEIGHT, MAX_HEIGHT) }),
    ...(yaw === null ? {} : { yaw: wrapAngle(yaw) }),
  };
}

/**
 * Narrow an arbitrary parsed value to a scene event, clamped.
 *
 * Returns null for anything malformed rather than a half-read event: a dab
 * with no radius or a dial with no name is not a thing this world can do, and
 * guessing on its behalf is how a public broker gets to move the ground.
 */
export function readSceneEvent(value: unknown): SceneEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const t = offset(rec['t']);
  if (t === null) return null;
  if (rec['k'] === 'world') return readWorldScene(rec, t);
  if (rec['k'] === 'paint') return readPaintScene(rec, t);
  return null;
}

/**
 * Read a list of them, dropping what will not read and capping the rest.
 *
 * Dropping rather than refusing the whole list, deliberately, and this is the
 * one place it differs from `parseSessionLog`: a log with one bad event in it
 * is a file somebody hands you and can be refused outright, while this is a
 * live world's ground arriving in pieces. Losing one dab is a dent; refusing
 * the batch is a phone that never sees the landscape at all.
 */
export function readSceneBatch(value: unknown, cap: number = MAX_SCENE_BATCH): SceneEvent[] {
  if (!Array.isArray(value)) return [];
  const out: SceneEvent[] = [];
  for (const raw of value) {
    if (out.length >= cap) break;
    const event = readSceneEvent(raw);
    if (event) out.push(event);
  }
  return out;
}

/**
 * The shortest list of events that lands a fresh page on the same scene.
 *
 * Two rules, and neither of them reorders anything:
 *
 *   A DIAL only has its last value. `landscape` and each terrain `kind` are
 *   settings, not strokes: a drag across the elevation slider is thirty
 *   events that all say "the world ended up here", and only the last one is
 *   true. (The recorder already coalesces a drag inside 250ms — this is the
 *   same argument across a whole session.)
 *
 *   A CLEAR is a horizon. Every dab before the last `tool: 'clear'` was
 *   thrown away by the person who painted it, and replaying them onto a
 *   fresh map would put back a map somebody deleted. The clear itself goes
 *   with them: a page that never stamped anything has nothing to clear.
 *
 * Relative order is preserved for everything that survives, because a
 * flatten depends on the ground it is flattening and a landscape switch
 * decides what a dab is landing on.
 */
export function compactScene(events: readonly SceneEvent[]): SceneEvent[] {
  let lastClear = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.k === 'paint' && event.tool === 'clear') {
      lastClear = i;
      break;
    }
  }
  const seen = new Set<string>();
  const out: SceneEvent[] = [];
  // Backwards, so "the last one wins" is simply "the first one seen".
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.k === 'paint') {
      if (i <= lastClear) continue;
      out.push(event);
      continue;
    }
    const key = `${event.field}:${event.kind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  out.reverse();
  return out;
}
