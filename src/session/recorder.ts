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
 * TWO CONTINUOUS INPUTS reach this module rather than a discrete seam: a
 * thumb on the stick (`drive`) and a brush on the ground (`paint`). Both are
 * CALLED at input rate and neither RECORDS at it — `drive` quantises the
 * intent and rate-caps it per creature, and `paint` writes one event per dab
 * (a dab is spaced by the brush, not by the display). The rule the module
 * keeps is the one that matters: an idle world still records nothing at all,
 * and no event in this file is a per-frame sample of anything.
 *
 * A hard `limit` bounds memory for a long-running installation. Past it the
 * recorder REFUSES new events rather than dropping old ones — a truncated
 * prefix still replays faithfully, a log with a hole in the middle does not.
 */

import { MOTION } from '../taste/tokens';
import {
  SESSION_SCHEMA,
  SESSION_SCHEMA_VERSION,
  serializeSessionLog,
  type DrawingEvent,
  type DrawingSource,
  type EmoteSource,
  type HatchCause,
  type KeepAction,
  type KeepSource,
  type OperatorAction,
  type PaintEvent,
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

/**
 * [D] Shortest gap between two `drive` samples FOR ONE CREATURE, ms.
 *
 * The tertiary motion token, not a number of its own: it is the shortest
 * interval this project treats as a movement anybody perceives, so it is
 * also the shortest interval at which "they changed direction" is worth a
 * line in the record. A stick pushes at the display's rate — 60 samples a
 * second, times every steered creature — and a log of that is a per-frame
 * dump wearing an event's clothes, which is the one thing this format is
 * built not to be.
 */
export const DEFAULT_DRIVE_MIN_GAP_MS = MOTION.tertiaryMs;

/**
 * [D] Heading quantisation: 1/16 of a turn (22.5°).
 *
 * The change detector, not the value — what lands in the log is the vector
 * as it was pushed. Sixteen is the same order as the compass a person can
 * actually aim a thumb at, so a steady push reads as ONE intent while a
 * genuine turn still crosses a boundary and records.
 */
export const DRIVE_HEADING_STEPS = 16;

/** [D] Magnitude quantisation: tenths. A stick that wobbles between 0.71 and
 * 0.74 is being held still by a hand, not modulated. */
export const DRIVE_MAG_STEP = 0.1;

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
  /** Rate cap on `drive`, per creature — see DEFAULT_DRIVE_MIN_GAP_MS. */
  driveMinGapMs?: number;
}

/** What a drawing event needs, minus the offset the recorder stamps. */
export type DrawingRecord = Omit<DrawingEvent, 't' | 'k'>;

/** One dab, minus the offset the recorder stamps. Rounding happens here, so
 * a caller hands over whatever the brush gave it. */
export type PaintRecord = Omit<PaintEvent, 't' | 'k'> & { tool: string };

/** A steering intent on the ground plane. `null` (or `mag: 0`) is the
 * release — the same shape `CreatureManager.drive` takes. */
export interface DriveVector {
  x: number;
  z: number;
  mag: number;
}

export interface SessionRecorder {
  drawing(record: DrawingRecord): void;
  egg(id: string, x: number, z: number): void;
  hatch(id: string, cause: HatchCause): void;
  retire(id: string, cause: RetireCause): void;
  emote(id: string, emote: string, source: EmoteSource): void;
  /**
   * Somebody is steering this creature. Call it as often as the stick
   * updates — the quantisation and the rate cap live in here, so no caller
   * has to know how often is too often, and every route in (this page's own
   * stick, a handset's intent over the wire, the expiry that lets go for a
   * phone that stopped talking) is capped the same way.
   */
  drive(id: string, vec: DriveVector | null): void;
  /** One dab of the terrain brush, or `{ tool: 'clear' }` for the map. */
  paint(record: PaintRecord): void;
  /** Somebody kept their creature (a photo, a model, a link). */
  keep(id: string, action: KeepAction, source?: KeepSource): void;
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
  const driveMinGapMs = opts.driveMinGapMs ?? DEFAULT_DRIVE_MIN_GAP_MS;
  const startMono = opts.now();
  const events: SessionEvent[] = [];
  let lastT = 0;
  let overflowed = false;
  /** Per creature: the quantised intent last WRITTEN, and when. Bounded by
   * the number of creatures that have ever been steered, not by time. */
  const lastDrive = new Map<string, { key: string; t: number }>();

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
    /**
     * A steering intent, kept to a handful of events a second at most.
     *
     * TWO filters, and they do different jobs:
     *
     *   QUANTISATION decides whether anything changed. The vector is reduced
     *   to a 1/16-turn heading and a tenth of magnitude; a push that stays
     *   inside its cell is the same intent still being held, and records
     *   nothing however many frames it spans.
     *
     *   The RATE CAP decides how often a change may be written. Curving a
     *   thumb around crosses a heading boundary every few frames, which
     *   quantisation alone would happily record; one event per
     *   `driveMinGapMs` per creature is the ceiling.
     *
     * The RELEASE is exempt from the cap and recorded exactly once: it is
     * the event that ends a drive, and a log that dropped it would leave the
     * creature walking for the rest of the replay. A rest while already at
     * rest writes nothing at all.
     *
     * What lands in the log is the vector as it was PUSHED (rounded), not
     * the quantised stand-in — the cell decides when to write, never what.
     */
    drive(id: string, vec: DriveVector | null): void {
      // `null` and `mag: 0` are the same thing — somebody let go — and the
      // manager treats them the same way, so the recorder does too.
      const held = vec && vec.mag > 0 ? vec : null;
      const previous = lastDrive.get(id);
      if (!held) {
        // Nothing to let go of: either never driven, or already released.
        if (!previous || previous.key === REST_KEY) return;
        const t = stamp();
        lastDrive.set(id, { key: REST_KEY, t });
        push({ k: 'drive', t, id, mag: 0 });
        return;
      }
      const key = driveKey(held);
      if (previous && previous.key === key) return;
      const t = stamp();
      // Under the cap the change is DROPPED, not deferred, and `previous`
      // is deliberately left alone: the next sample is compared against
      // what the log actually says, so a change that survives the window
      // still records.
      if (previous && previous.key !== REST_KEY && t - previous.t < driveMinGapMs) return;
      lastDrive.set(id, { key, t });
      push({ k: 'drive', t, id, ax: round3(held.x), az: round3(held.z), mag: round3(held.mag) });
    },
    paint(record: PaintRecord): void {
      // Rounded here rather than at the brush: three decimals of a world
      // unit is well under a texel (0.78u at PAINTED_RES), and a dab is one
      // of thousands in a session.
      push({
        ...record,
        ...(record.x === undefined ? {} : { x: round3(record.x) }),
        ...(record.z === undefined ? {} : { z: round3(record.z) }),
        ...(record.r === undefined ? {} : { r: round3(record.r) }),
        ...(record.strength === undefined ? {} : { strength: round3(record.strength) }),
        ...(record.hardness === undefined ? {} : { hardness: round3(record.hardness) }),
        ...(record.seed === undefined ? {} : { seed: round3(record.seed) }),
        ...(record.flattenTo === undefined ? {} : { flattenTo: round3(record.flattenTo) }),
        k: 'paint',
        t: stamp(),
      });
    },
    keep(id: string, action: KeepAction, source: KeepSource = 'phone'): void {
      push({ k: 'keep', t: stamp(), id, action, source });
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

function round3(v: number): number {
  return Math.round(v * 1e3) / 1e3;
}

/** The cell a released stick sits in — never equal to a live one. */
const REST_KEY = 'rest';

/**
 * The quantised cell one steering intent falls in: heading to 1/16 of a
 * turn, magnitude to a tenth. Pure, and never written to the log — it is the
 * "has this changed?" key and nothing else.
 */
function driveKey(vec: DriveVector): string {
  const turn = Math.atan2(vec.z, vec.x) / (Math.PI * 2);
  // `+ 1` before the modulo so a heading just under a full turn folds to 0
  // rather than to a negative index — the cell either side of due east has
  // to be the same cell.
  const step = (Math.round(turn * DRIVE_HEADING_STEPS) + DRIVE_HEADING_STEPS) % DRIVE_HEADING_STEPS;
  const level = Math.round(vec.mag / DRIVE_MAG_STEP);
  return `${step}:${level}`;
}

/** Re-export for the wiring seams, so a caller needs one import. */
export type {
  DrawingSource,
  EmoteSource,
  HatchCause,
  KeepAction,
  KeepSource,
  OperatorAction,
  RetireCause,
};
