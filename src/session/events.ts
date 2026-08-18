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
 */
export const SESSION_SCHEMA_VERSION = 1;

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
