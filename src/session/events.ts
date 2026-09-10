/**
 * The session log format — pure data (PLAN §2 purity contract).
 *
 * WHY THIS SHAPE. The generation pipeline is already pure and deterministic:
 * `src/shape/`, `src/inflate/` and `src/character/interpret.ts` take a stroke
 * list and an identity id and produce a byte-identical creature on every
 * device, and every behaviour agent is seeded from the slot id
 * (`src/creatures/manager.ts` → `behaviorSeed`). So a faithful recording does
 * NOT need per-frame positions. It needs the INPUTS (the strokes, the id, the
 * name, the personality answer) and the DECISIONS (what the moderation gate
 * ruled, what the operator tapped, when an egg was forced to hatch), each
 * stamped with an offset from session start. Replay re-drives the same world
 * with the same inputs and the same decisions, and the same creatures come
 * back out.
 *
 * That is the whole reason this file has no positions, no rotations, no
 * per-frame samples and no float dumps in it.
 *
 * TIME. Every `t` in the body is milliseconds since session start. There is
 * exactly one wall clock in the format — `startedAt` in the header — and it is
 * never read during replay. Offsets are monotonically non-decreasing.
 *
 * PURITY. No Three.js, no DOM, no clock, no randomness in this directory. The
 * recorder takes its clock as an injected function, so the whole module runs
 * under node and is unit-testable (test/session/).
 */

import type { StrokeList } from '../shape/types';

/** Format tag written into every log so a reader can recognise the file. */
export const SESSION_SCHEMA = 'refworld.session';

/**
 * Schema version. Bump on any change that an older reader could not honour;
 * `parseSessionLog` refuses versions it does not know.
 *
 * 2 — `drive`, `paint` and `keep` (2026-09-09). Additive kinds, but the bump
 * is NOT optional: `isEvent` below refuses an unrecognised `k`, and one bad
 * event fails the WHOLE file, so a v1 reader handed a log with a drive in it
 * would refuse it as junk rather than as a newer format. The version says
 * which of those two it is. Reading DOWN still works — a v1 log parses here
 * exactly as it always did.
 */
export const SESSION_SCHEMA_VERSION = 2;

// ── event kinds ─────────────────────────────────────────────────────────────

/** Where a drawing came in from. */
export type DrawingSource =
  /** the draw-to-3d mqtt feed (a phone) */
  | 'phone'
  /** the world page's own draw overlay (press d) */
  | 'local'
  /** the ghost panel's fallback fixtures */
  | 'dev';

/** What made a creature emote. */
export type EmoteSource = 'phone' | 'key' | 'panel';

/** What a person chose to keep, in the words the handset shows them
 * (src/phone/keepui.ts labels them `photo`, `3d model`, `link`). */
export type KeepAction = 'photo' | 'model' | 'link';

/** Where a keep came from. Only a handset can save today; the field exists
 * so a later one (an operator export, say) does not need a new kind. */
export type KeepSource = 'phone';

/** Why an egg opened: its own timer, or a person/preset forcing it. */
export type HatchCause = 'timer' | 'forced';

/** Why a creature left the world. */
export type RetireCause =
  /** the population guard retired the oldest slot */
  | 'population'
  /** an operator removed or blocked it */
  | 'operator'
  /** the same drawer sent a new drawing, replacing their slot */
  | 'replaced'
  /** clear-all / reset world */
  | 'cleared';

/** One tap in the moderation panel. `hold` carries `on`. */
export type OperatorAction =
  | 'approve'
  | 'discard'
  | 'remove'
  | 'block'
  | 'unblock'
  | 'hold';

interface EventBase {
  /** Milliseconds since session start. Never a wall clock. */
  t: number;
}

/**
 * A drawing arrived and the gate ruled on it. THE LOAD-BEARING EVENT: the
 * stroke list here is the exact input the generator ran on, so replay can
 * rebuild the identical creature.
 */
export interface DrawingEvent extends EventBase {
  k: 'drawing';
  /** The id the world spawns under — the creature's identity, and the salt
   * for within-band synthesis. Reproducing it is what makes replay faithful. */
  id: string;
  name: string | null;
  personality: string | null;
  source: DrawingSource;
  strokes: StrokeList;
  /** ms until auto-hatch this drawing was admitted with. */
  hatchMs: number;
  /** The gate's ruling: admitted | refused | held | blocked | unusable. */
  disposition: string;
  /** The automatic screen's verdict: allow | hold | refuse. */
  verdict: string;
  reason: string | null;
  confidence: number;
}

/** An egg was placed in the world. Informational — replay derives it from the
 * drawing — but the recorded spot is the cross-check that placement stayed
 * deterministic. */
export interface EggEvent extends EventBase {
  k: 'egg';
  id: string;
  x: number;
  z: number;
}

export interface HatchEvent extends EventBase {
  k: 'hatch';
  id: string;
  cause: HatchCause;
}

export interface RetireEvent extends EventBase {
  k: 'retire';
  id: string;
  cause: RetireCause;
}

export interface EmoteEvent extends EventBase {
  k: 'emote';
  id: string;
  emote: string;
  source: EmoteSource;
}

/** An operator acted in the moderation panel. A replay that silently lost one
 * of these would resurrect something a person deleted. */
export interface OperatorEvent extends EventBase {
  k: 'operator';
  action: OperatorAction;
  /** The drawer acted on; null for the hold-mode toggle. */
  id: string | null;
  /** Only for `hold`: the new state of hold-arrivals mode. */
  on?: boolean;
}

/**
 * Somebody steered a creature: a thumb on the stick, or a handset's intent
 * applied by the page that simulates (src/main.ts, src/net/worldsync.ts).
 *
 * NOT per-frame state, and this is the one kind where that has to be argued
 * rather than assumed. A stick pushes at the display's rate; what is
 * RECORDED is the intent when it changes — the recorder quantises the vector
 * and rate-caps it per creature (src/session/recorder.ts) — so a minute of
 * steering is a handful of events and not 3600. The creature's path is not
 * in the log at all: it is re-derived by re-driving the same intents at the
 * same offsets, exactly as every other kind is.
 */
export interface DriveEvent extends EventBase {
  k: 'drive';
  /** The creature being steered — the id it was spawned under. */
  id: string;
  /** Ground-space direction, x. Absent at rest. */
  ax?: number;
  /** Ground-space direction, z. Absent at rest. */
  az?: number;
  /** 0 is the release — the hand came off the stick. */
  mag: number;
}

/**
 * One dab of the terrain brush, or the tap that cleared the map
 * (src/dev/paint.ts, envpaint's port plan §5 step 6).
 *
 * One event per STAMP, not per stroke: a stroke replays because every dab
 * carries its own place, size and seed. `tool: 'clear'` carries no geometry.
 */
export interface PaintEvent extends EventBase {
  k: 'paint';
  /** `raise` | `lower` | `flatten` | `smooth` on the height layer, `pond` |
   * `drain` on the water one, or `clear` for the whole map. */
  tool: string;
  /** Ground-space centre of the dab — world units, the same space `egg`
   * records, converted from the brush's uv at the seam. Absent on `clear`. */
  x?: number;
  z?: number;
  /** Radius in world units. Absent on `clear`. */
  r?: number;
  /** Per-dab amount, already scaled by the brush. */
  strength?: number;
  hardness?: number;
  /** The stamp mode actually used — a tool erases and alt-smooths, so the
   * tool id alone does not say what the dab did. */
  mode?: string;
  /** The dab's own rim seed, so a replayed stroke has the same edge. */
  seed?: number;
  /** `flatten` only: the height the stroke levelled toward. */
  flattenTo?: number;
  /** Water tools only: the absolute surface height the dab filled to, so a
   * replay lays the same plane without re-reading a bank that may since have
   * moved. Absent on a drain, which fills to nothing. */
  level?: number;
  /**
   * `waterfall` only: the y rotation the mark was stamped facing, radians
   * (2026-09-10, user ask: *"i want to match the brushes for env paint
   * exactly"*).
   *
   * Recorded rather than re-derived for the same reason `level` is: the
   * facing comes off the terrain gradient at stamp time, and by the time a
   * log is replayed that ground may have been sculpted. A dab without one —
   * an older log, or a sender that left it off — falls back to the gradient
   * as it now stands, which is the best guess available.
   */
  yaw?: number;
}

/**
 * Somebody kept their creature — a photo, a 3d model, or a link
 * (src/phone/keepui.ts). Informational: it changes nothing in the world, and
 * replay ignores it exactly as it ignores `egg`. It is in the log because
 * "somebody wanted to take this home" is the thing a session is judged on
 * afterwards, and nothing else in the record says it happened.
 */
export interface KeepEvent extends EventBase {
  k: 'keep';
  /** The drawer id — whose creature was saved. */
  id: string;
  action: KeepAction;
  source: KeepSource;
}

/** A world-level control an operator changed — weather, time of day, density,
 * grain, paper colour. Discrete samples only: nothing here is read per frame. */
export interface WorldEvent extends EventBase {
  k: 'world';
  field: string;
  value: number | string | boolean | null;
  /** Prop kind, for the per-kind density/scale sliders. */
  kind?: string;
}

export type SessionEvent =
  | DrawingEvent
  | EggEvent
  | HatchEvent
  | RetireEvent
  | EmoteEvent
  | DriveEvent
  | PaintEvent
  | KeepEvent
  | OperatorEvent
  | WorldEvent;

export type SessionEventKind = SessionEvent['k'];

// ── header ──────────────────────────────────────────────────────────────────

/**
 * The generation-affecting configuration this session ran under. Anything
 * that changes what a stroke list turns into belongs here, so a replay on a
 * later build can tell whether it is comparing like with like.
 */
export interface SessionConfig {
  [key: string]: number | string | boolean | null;
}

export interface SessionHeader {
  schema: typeof SESSION_SCHEMA;
  version: number;
  /** The world session id `src/main.ts` mints (its `epoch`). */
  epoch: string;
  /** The room this world hosted. */
  room: string;
  /** The one and only wall clock in the format (iso 8601). Replay ignores it. */
  startedAt: string;
  config: SessionConfig;
}

export interface SessionLog extends SessionHeader {
  events: SessionEvent[];
}

// ── serialise / parse ───────────────────────────────────────────────────────

export function serializeSessionLog(log: SessionLog): string {
  return JSON.stringify(log);
}

const EVENT_KINDS = new Set<string>([
  'drawing',
  'egg',
  'hatch',
  'retire',
  'emote',
  'drive',
  'paint',
  'keep',
  'operator',
  'world',
]);

function isStrokeList(value: unknown): value is StrokeList {
  if (!Array.isArray(value)) return false;
  for (const stroke of value) {
    if (typeof stroke !== 'object' || stroke === null) return false;
    const rec = stroke as Record<string, unknown>;
    if (typeof rec['w'] !== 'number' || !Number.isFinite(rec['w'])) return false;
    const pts = rec['pts'];
    if (!Array.isArray(pts)) return false;
    for (const p of pts) {
      if (!Array.isArray(p) || p.length < 2) return false;
      for (const n of p) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return false;
      }
    }
  }
  return true;
}

function isEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  const kind = rec['k'];
  if (typeof kind !== 'string' || !EVENT_KINDS.has(kind)) return false;
  if (typeof rec['t'] !== 'number' || !Number.isFinite(rec['t']) || rec['t'] < 0) return false;
  if (kind === 'drawing') return typeof rec['id'] === 'string' && isStrokeList(rec['strokes']);
  if (kind === 'world') return typeof rec['field'] === 'string';
  if (kind === 'operator') return typeof rec['action'] === 'string';
  // A dab is addressed by its tool, not by a creature id — the map is what
  // it acts on. `clear` is the one that carries no geometry at all.
  if (kind === 'paint') return typeof rec['tool'] === 'string';
  if (kind === 'drive') {
    return typeof rec['id'] === 'string' && typeof rec['mag'] === 'number';
  }
  if (kind === 'keep') {
    return typeof rec['id'] === 'string' && typeof rec['action'] === 'string';
  }
  return typeof rec['id'] === 'string';
}

/**
 * Read a log back. Returns null on anything that is not a log this build
 * understands — a wrong schema tag, a future version, junk in the events —
 * rather than half-replaying a file. Offsets are also checked for monotonicity,
 * because a log whose clock went backwards cannot be scheduled.
 */
export function parseSessionLog(text: string): SessionLog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return readSessionLog(parsed);
}

/** The same validation over an already-parsed value (a structured clone, a
 * fetch's json, a postMessage payload). */
export function readSessionLog(parsed: unknown): SessionLog | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['schema'] !== SESSION_SCHEMA) return null;
  const version = rec['version'];
  if (typeof version !== 'number' || version > SESSION_SCHEMA_VERSION || version < 1) return null;
  if (typeof rec['epoch'] !== 'string') return null;
  if (typeof rec['room'] !== 'string') return null;
  if (typeof rec['startedAt'] !== 'string') return null;
  const config = rec['config'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const events = rec['events'];
  if (!Array.isArray(events)) return null;
  let last = -1;
  for (const event of events) {
    if (!isEvent(event)) return null;
    if (event.t < last) return null;
    last = event.t;
  }
  return {
    schema: SESSION_SCHEMA,
    version,
    epoch: rec['epoch'],
    room: rec['room'],
    startedAt: rec['startedAt'],
    config: config as SessionConfig,
    events: events as SessionEvent[],
  };
}

/** Offset of the last event, in ms — how long the session ran. */
export function sessionDurationMs(log: SessionLog): number {
  const last = log.events[log.events.length - 1];
  return last ? last.t : 0;
}

/** Count events by kind — the panel readout, and a cheap test assertion. */
export function countByKind(log: SessionLog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of log.events) out[event.k] = (out[event.k] ?? 0) + 1;
  return out;
}
