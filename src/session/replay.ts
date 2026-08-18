/**
 * Replay: drive a world through a recorded session.
 *
 * The log holds inputs and decisions, not frames (see events.ts). So replay is
 * not a video scrubber — it re-runs the session against a live world:
 *
 *   drawing (admitted)      → spawn the same id with the same strokes
 *   drawing (held)          → hold the payload; spawn only if an operator
 *                             approve event follows
 *   drawing (refused|blocked|unusable)
 *                           → never spawn. A verdict a person or the screen
 *                             made is not re-litigated at replay time.
 *   operator remove|block   → remove that creature
 *   hatch                   → force that egg open at the recorded offset
 *   emote                   → play the recorded emote on that creature
 *   world                   → hand the recorded control change to the driver
 *
 * Because generation is deterministic in the strokes and the id, and the
 * behaviour agent is seeded from the id, the same ids and the same strokes at
 * the same offsets reproduce the same population — that is the whole trick.
 *
 * Pure: the driver is an interface, the scheduler is injected. `replayNow`
 * needs neither and runs the entire log synchronously, which is how the tests
 * (and a "catch up instantly" restore) use it.
 */

import type { StrokeList } from '../shape/types';
import type { OperatorAction, SessionEvent, SessionLog } from './events';

/** One creature to bring back, exactly as the session first saw it. */
export interface ReplaySpawn {
  id: string;
  strokes: StrokeList;
  name: string | null;
  personality: string | null;
  hatchMs: number;
}

/** The world side of a replay. `src/main.ts` implements this over the live
 * creature manager; a test implements it with three arrays. */
export interface ReplayDriver {
  /** Spawn one creature. Returns false when the ink is unusable. */
  spawn(spawn: ReplaySpawn): boolean;
  /** Force this egg open now. */
  hatch(id: string): void;
  /** Play an emote on this creature. */
  emote(id: string, emote: string): void;
  /** Take this creature out of the world. */
  remove(id: string): void;
  /** A world control the operator changed. Optional. */
  world?(field: string, value: number | string | boolean | null, kind?: string): void;
  /** A moderation tap, for a driver that wants to mirror the operator state
   * (hold mode, the block list). Optional — replay drives removals itself. */
  operator?(action: OperatorAction, id: string | null, on?: boolean): void;
}

export interface ReplayState {
  /** Drawing payloads by id, so a later approve can still spawn them. */
  payloads: Map<string, ReplaySpawn>;
  /** Ids currently standing in the replayed world. */
  live: Set<string>;
}

export function createReplayState(): ReplayState {
  return { payloads: new Map(), live: new Set() };
}

function payloadOf(event: Extract<SessionEvent, { k: 'drawing' }>): ReplaySpawn {
  return {
    id: event.id,
    strokes: event.strokes,
    name: event.name,
    personality: event.personality,
    hatchMs: event.hatchMs,
  };
}

/** Apply one event. Exported for a scrubber or a partial restore. */
export function applyEvent(
  event: SessionEvent,
  driver: ReplayDriver,
  state: ReplayState,
): void {
  switch (event.k) {
    case 'drawing': {
      const spawn = payloadOf(event);
      state.payloads.set(event.id, spawn);
      // Only an admitted drawing entered the world at this offset. Held ones
      // wait for their operator event; refused, blocked and unusable ones
      // never spawn at all.
      if (event.disposition !== 'admitted') return;
      if (driver.spawn(spawn)) state.live.add(event.id);
      return;
    }
    case 'operator': {
      driver.operator?.(event.action, event.id, event.on);
      const id = event.id;
      if (id === null) return;
      if (event.action === 'approve') {
        const spawn = state.payloads.get(id);
        if (spawn && driver.spawn(spawn)) state.live.add(id);
        return;
      }
      if (event.action === 'remove' || event.action === 'block') {
        // A removal a person made must survive the replay — this is the
        // event whose loss would resurrect something someone deleted.
        driver.remove(id);
        state.live.delete(id);
      }
      return;
    }
    case 'retire': {
      // The population guard and a slot replacement reproduce themselves from
      // the same spawn sequence; only the ones a person or a reset caused are
      // driven explicitly.
      if (event.cause === 'operator' || event.cause === 'cleared') {
        driver.remove(event.id);
      }
      state.live.delete(event.id);
      return;
    }
    case 'hatch': {
      if (state.live.has(event.id)) driver.hatch(event.id);
      return;
    }
    case 'emote': {
      if (state.live.has(event.id)) driver.emote(event.id, event.emote);
      return;
    }
    case 'world': {
      driver.world?.(event.field, event.value, event.kind);
      return;
    }
    case 'egg':
      // Consequence of the drawing, not an input: placement is deterministic
      // from the spawn order, so replay never sets a position. The recorded
      // spot is the cross-check, read by the verification, not by replay.
      return;
  }
}

/**
 * Run the whole log immediately, in order, with no waiting. The world ends up
 * where the session ended up; only the pacing is lost.
 */
export function replayNow(log: SessionLog, driver: ReplayDriver): void {
  const state = createReplayState();
  for (const event of log.events) applyEvent(event, driver, state);
}

export interface ReplayOptions {
  /**
   * Wall-rate multiplier. 1 replays at the pace it was recorded, 4 runs it
   * four times faster, and `Infinity` degenerates to `replayNow`.
   */
  speed?: number;
  /** Timer, injected so this module holds no platform. Defaults to
   * setTimeout when one exists. Must call back after roughly `ms`. */
  schedule?(ms: number, fn: () => void): void;
  /** Called once the last event has been applied. */
  onDone?(): void;
  /** Called after each event, for a progress readout. */
  onEvent?(event: SessionEvent, index: number): void;
}

export interface ReplayHandle {
  /** Stop before the next event; already-applied events stand. */
  stop(): void;
  /** Index of the next event to apply. */
  index(): number;
  done(): boolean;
}

function defaultSchedule(ms: number, fn: () => void): void {
  const timers = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };
  if (typeof timers.setTimeout === 'function') timers.setTimeout(fn, ms);
  else fn();
}

/**
 * Replay in time: each event fires at its recorded offset (scaled by `speed`).
 * One chained timer, never one per event.
 */
export function replaySession(
  log: SessionLog,
  driver: ReplayDriver,
  options: ReplayOptions = {},
): ReplayHandle {
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const schedule = options.schedule ?? defaultSchedule;
  const state = createReplayState();
  const events = log.events;
  let index = 0;
  let stopped = false;
  let previousT = 0;

  const step = (): void => {
    if (stopped) return;
    const event = events[index];
    if (!event) {
      options.onDone?.();
      return;
    }
    index++;
    applyEvent(event, driver, state);
    options.onEvent?.(event, index - 1);
    previousT = event.t;
    queueNext();
  };

  const queueNext = (): void => {
    if (stopped) return;
    const next = events[index];
    if (!next) {
      options.onDone?.();
      return;
    }
    const wait = Math.max(0, (next.t - previousT) / speed);
    if (!Number.isFinite(wait) || wait <= 0) {
      step();
      return;
    }
    schedule(wait, step);
  };

  queueNext();

  return {
    stop(): void {
      stopped = true;
    },
    index: () => index,
    done: () => stopped || index >= events.length,
  };
}

/**
 * The ids that should be standing in the world when the log ends — computed
 * from the log alone, with no world involved. The verification compares this
 * against what a replayed world actually holds.
 */
export function expectedCreatures(log: SessionLog): string[] {
  const live = new Set<string>();
  const payloads = new Set<string>();
  for (const event of log.events) {
    switch (event.k) {
      case 'drawing':
        payloads.add(event.id);
        if (event.disposition === 'admitted') live.add(event.id);
        break;
      case 'operator':
        if (event.id === null) break;
        if (event.action === 'approve' && payloads.has(event.id)) live.add(event.id);
        if (event.action === 'remove' || event.action === 'block') live.delete(event.id);
        break;
      case 'retire':
        live.delete(event.id);
        break;
      default:
        break;
    }
  }
  return [...live].sort();
}
