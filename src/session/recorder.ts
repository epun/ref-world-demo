/**
 * The recorder: an append-only event log for one world session.
 *
 * Pure — no DOM, no Three.js, no clock of its own. The monotonic clock is
 * injected (`now`), so the world passes `performance.now` and a test passes a
 * counter. That is what keeps the whole log format testable under node.
 *
 * COST. Appending is one object literal and one array push: O(1), no scan, no
 * copy, no serialisation. NOTHING here runs per frame — the recorder is wired
 * only to discrete seams (a drawing arriving, an egg hatching, an operator
 * tapping a row), so a world sitting idle for an hour records nothing at all.
 * The one exception is a continuous panel control: dragging a slider would
 * otherwise append a sample per pointermove, so `world()` REWRITES its own
 * previous sample when the same field is written again inside `coalesceMs`.
 * That is the only rewrite in the format; every other kind only appends.
 *
 * A hard `limit` bounds memory for a long-running installation. Past it the
 * recorder REFUSES new events rather than dropping old ones — a truncated
 * prefix still replays faithfully, a log with a hole in the middle does not.
 */

import {
  SESSION_SCHEMA,
  SESSION_SCHEMA_VERSION,
  serializeSessionLog,
  type DrawingEvent,
  type DrawingSource,
  type EmoteSource,
  type HatchCause,
  type OperatorAction,
  type RetireCause,
  type SessionConfig,
  type SessionEvent,
  type SessionLog,
} from './events';

/** Default ceiling on recorded events (see the module note on refusal). */
export const DEFAULT_EVENT_LIMIT = 50000;

/** Default window in which a repeated write to the same world field
 * overwrites its own last sample instead of appending. */
export const DEFAULT_COALESCE_MS = 250;

export interface RecorderOptions {
  /** The world session id (`epoch` in src/main.ts). */
  epoch: string;
  room: string;
  /**
   * The single wall-clock stamp for the whole log, iso 8601. Passed in (never
   * read here) so this module holds no `Date`.
   */
  startedAt: string;
  /** Generation-affecting configuration — see SessionConfig. */
  config: SessionConfig;
  /** Monotonic millisecond clock. `performance.now` in the browser. */
  now(): number;
  limit?: number;
  coalesceMs?: number;
}

/** What a drawing event needs, minus the offset the recorder stamps. */
export type DrawingRecord = Omit<DrawingEvent, 't' | 'k'>;

export interface SessionRecorder {
  drawing(record: DrawingRecord): void;
  egg(id: string, x: number, z: number): void;
  hatch(id: string, cause: HatchCause): void;
  retire(id: string, cause: RetireCause): void;
  emote(id: string, emote: string, source: EmoteSource): void;
  operator(action: OperatorAction, id: string | null, on?: boolean): void;
  world(field: string, value: number | string | boolean | null, kind?: string): void;
  /** Live view of the events — do not mutate. */
  events(): readonly SessionEvent[];
  count(): number;
  /** Offset of the newest event, ms since session start. */
  durationMs(): number;
  /** True once the limit refused an append. */
  overflowed(): boolean;
  /** A complete log: header plus a copy of the events. */
  snapshot(): SessionLog;
  /** The log as json — what the ghost panel downloads. */
  toJson(): string;
}

export function createSessionRecorder(opts: RecorderOptions): SessionRecorder {
  const limit = opts.limit ?? DEFAULT_EVENT_LIMIT;
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;
  const startMono = opts.now();
  const events: SessionEvent[] = [];
  let lastT = 0;
  let overflowed = false;

  /** Offset since session start, clamped monotonic: a clock that stalls or
   * steps back can never write an event before one already in the log. */
  function stamp(): number {
    const t = Math.round(opts.now() - startMono);
    lastT = t > lastT ? t : lastT;
    return lastT;
  }

  function push(event: SessionEvent): void {
    if (events.length >= limit) {
      overflowed = true;
      return;
    }
    events.push(event);
  }

  return {
    drawing(record: DrawingRecord): void {
      push({ ...record, k: 'drawing', t: stamp() });
    },
    egg(id: string, x: number, z: number): void {
      // Rounded: the spot is a cross-check, not an input. Six decimals keeps
      // the log small and still catches a placement drift.
      push({ k: 'egg', t: stamp(), id, x: round6(x), z: round6(z) });
    },
    hatch(id: string, cause: HatchCause): void {
      push({ k: 'hatch', t: stamp(), id, cause });
    },
    retire(id: string, cause: RetireCause): void {
      push({ k: 'retire', t: stamp(), id, cause });
    },
    emote(id: string, emote: string, source: EmoteSource): void {
      push({ k: 'emote', t: stamp(), id, emote, source });
    },
    operator(action: OperatorAction, id: string | null, on?: boolean): void {
      push({ k: 'operator', t: stamp(), id, action, ...(on === undefined ? {} : { on }) });
    },
    world(field: string, value: number | string | boolean | null, kind?: string): void {
      const t = stamp();
      const previous = events[events.length - 1];
      if (
        previous &&
        previous.k === 'world' &&
        previous.field === field &&
        previous.kind === kind &&
        t - previous.t <= coalesceMs
      ) {
        // Same knob, still moving: overwrite its own last sample so a drag is
        // one event, not one per pointermove.
        previous.value = value;
        previous.t = t;
        return;
      }
      push({ k: 'world', t, field, value, ...(kind === undefined ? {} : { kind }) });
    },
    events: () => events,
    count: () => events.length,
    durationMs: () => lastT,
    overflowed: () => overflowed,
    snapshot(): SessionLog {
      return {
        schema: SESSION_SCHEMA,
        version: SESSION_SCHEMA_VERSION,
        epoch: opts.epoch,
        room: opts.room,
        startedAt: opts.startedAt,
        config: { ...opts.config },
        events: events.slice(),
      };
    },
    toJson(): string {
      return serializeSessionLog(this.snapshot());
    },
  };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Re-export for the wiring seams, so a caller needs one import. */
export type { DrawingSource, EmoteSource, HatchCause, OperatorAction, RetireCause };
