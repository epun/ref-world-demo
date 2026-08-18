/**
 * The ingest gate: the one place a drawing becomes a creature.
 *
 * Everything that arrives — phone feed or the world's own draw overlay —
 * is offered here first. The gate applies, in order:
 *
 *   1. the drawer block list      (an operator decision, absolute)
 *   2. the automatic screen       (src/moderation/screen.ts)
 *   3. the hold-for-approval mode (a live-event operator decision)
 *
 * and only then calls `spawn`. Refusal is SILENT by design: nothing is
 * drawn on the projection, nothing is sent back to the phone. A public
 * installation must never reward the drawing with a reaction; the only
 * trace is the operator readout in the ghost panel.
 *
 * Pure of platform: no DOM, no Three.js, no Math.random, no Date. Arrival
 * order comes from a monotonic counter, so the whole module stays testable
 * and deterministic like src/shape.
 */

import type { StrokeList } from '../shape/types';
import { screenDrawing, type ScreenResult, type Verdict } from './screen';

export interface GateDrawing {
  id: string;
  name?: string | null;
  strokes: StrokeList;
}

/** What the gate did with one offer. */
export type Disposition =
  /** spawned */
  | 'admitted'
  /** the screen refused it; it never spawns */
  | 'refused'
  /** waiting for an operator (screen held it, or hold-all is on) */
  | 'held'
  /** this drawer is blocked */
  | 'blocked'
  /** spawn ran and reported the ink unusable */
  | 'unusable';

export interface GateEntry<T extends GateDrawing = GateDrawing> {
  /** Monotonic arrival number — newest is highest. Not a clock. */
  seq: number;
  id: string;
  name: string | null;
  drawing: T;
  disposition: Disposition;
  verdict: Verdict;
  reason: string | null;
  confidence: number;
}

/**
 * One tap an operator can make. The session recorder (src/session/) mirrors
 * this list — a replay that silently lost a removal would resurrect something
 * a person deleted.
 */
export type GateOperatorAction =
  | 'approve'
  | 'discard'
  | 'remove'
  | 'block'
  | 'unblock'
  | 'hold';

/**
 * A passive witness to what the gate did. Structural on purpose: the session
 * recorder implements it (src/session/wire.ts) without this module importing
 * anything, so moderation stays a leaf. Called once per decision and once per
 * operator tap — never per frame.
 */
export interface GateObserver<T extends GateDrawing = GateDrawing> {
  /** One offer resolved. The entry's disposition is final when this runs. */
  decision(entry: GateEntry<T>): void;
  /** An operator acted. `on` carries the new state of hold-arrivals mode. */
  operator(action: GateOperatorAction, id: string | null, on?: boolean): void;
}

export interface GateOptions<T extends GateDrawing> {
  /** Spawn one admitted drawing. Returns false when the ink is unusable. */
  spawn(drawing: T): boolean;
  /** Remove a live creature by the id it was spawned under. */
  clear?(id: string): void;
  /** Is a creature with this id still in the world? Stale rows are hidden
   * from the admitted list when this is supplied. */
  live?(id: string): boolean;
  /** Screen override (tests). Defaults to screenDrawing. */
  screen?(strokes: StrokeList): ScreenResult;
  /** How many decisions the readout log keeps. */
  logLimit?: number;
  /** Session recorder (or any witness). Optional; absent in tests. */
  observer?: GateObserver<T>;
}

/**
 * The read/act surface an operator ui needs. Ungeneric on purpose: the
 * ghost panel holds whatever gate the world built without knowing the
 * drawing payload's shape (src/dev/index.ts).
 */
export interface ModerationConsole {
  holdAll(): boolean;
  setHoldAll(on: boolean): void;
  pending(): GateEntry[];
  approve(id: string): boolean;
  discard(id: string): boolean;
  approveAll(): number;
  discardAll(): number;
  admitted(): GateEntry[];
  remove(id: string): boolean;
  block(id: string): void;
  unblock(id: string): boolean;
  blocked(): string[];
  log(): GateEntry[];
  onChange(listener: () => void): () => void;
}

export interface IngestGate<T extends GateDrawing = GateDrawing>
  extends ModerationConsole {
  /** Offer one incoming drawing. Returns what the gate did with it. */
  offer(drawing: T): GateEntry<T>;
  /** Waiting for approval, oldest first (the order an operator works). */
  pending(): GateEntry<T>[];
  /** Creatures the gate admitted, newest first. */
  admitted(): GateEntry<T>[];
  /** Recent decisions, newest first — the dev-panel readout. */
  log(): GateEntry<T>[];
}

const DEFAULT_LOG_LIMIT = 40;

export function createIngestGate<T extends GateDrawing = GateDrawing>(
  opts: GateOptions<T>,
): IngestGate<T> {
  const screen = opts.screen ?? ((strokes: StrokeList) => screenDrawing(strokes));
  const logLimit = opts.logLimit ?? DEFAULT_LOG_LIMIT;
  const observer = opts.observer;

  let seq = 0;
  let holdAll = false;
  const blockedIds = new Set<string>();
  const queue: GateEntry<T>[] = [];
  const admittedById = new Map<string, GateEntry<T>>();
  const decisions: GateEntry<T>[] = [];
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const record = (entry: GateEntry<T>): GateEntry<T> => {
    decisions.unshift(entry);
    if (decisions.length > logLimit) decisions.length = logLimit;
    // The single seam every ruling passes through, so the session log cannot
    // miss one (src/session/wire.ts).
    observer?.decision(entry);
    return entry;
  };

  const spawnNow = (entry: GateEntry<T>): GateEntry<T> => {
    const ok = opts.spawn(entry.drawing);
    entry.disposition = ok ? 'admitted' : 'unusable';
    if (ok) admittedById.set(entry.id, entry);
    return entry;
  };

  function offer(drawing: T): GateEntry<T> {
    const entry: GateEntry<T> = {
      seq: seq++,
      id: drawing.id,
      name: drawing.name ?? null,
      drawing,
      disposition: 'admitted',
      verdict: 'allow',
      reason: null,
      confidence: 1,
    };

    if (blockedIds.has(drawing.id)) {
      entry.disposition = 'blocked';
      entry.verdict = 'refuse';
      entry.reason = 'drawer blocked by the operator';
      entry.confidence = 1;
      notify();
      return record(entry);
    }

    const result = screen(drawing.strokes);
    entry.verdict = result.verdict;
    entry.reason = result.reason;
    entry.confidence = result.confidence;

    if (result.verdict === 'refuse') {
      entry.disposition = 'refused';
      notify();
      return record(entry);
    }
    if (result.verdict === 'hold' || holdAll) {
      entry.disposition = 'held';
      // One drawer, one slot: a resend replaces what they had queued.
      const prior = queue.findIndex((q) => q.id === entry.id);
      if (prior >= 0) queue.splice(prior, 1);
      queue.push(entry);
      notify();
      return record(entry);
    }

    spawnNow(entry);
    notify();
    return record(entry);
  }

  function takeFromQueue(id: string): GateEntry<T> | null {
    const index = queue.findIndex((q) => q.id === id);
    if (index < 0) return null;
    return queue.splice(index, 1)[0]!;
  }

  return {
    offer,
    holdAll: () => holdAll,
    setHoldAll(on: boolean): void {
      holdAll = on;
      observer?.operator('hold', null, on);
      notify();
    },
    pending: () => queue.slice(),
    approve(id: string): boolean {
      const entry = takeFromQueue(id);
      if (!entry) return false;
      observer?.operator('approve', id);
      spawnNow(entry);
      notify();
      return entry.disposition === 'admitted';
    },
    discard(id: string): boolean {
      const entry = takeFromQueue(id);
      if (!entry) return false;
      observer?.operator('discard', id);
      entry.disposition = 'refused';
      entry.reason = entry.reason ?? 'discarded by the operator';
      notify();
      return true;
    },
    approveAll(): number {
      let n = 0;
      while (queue.length > 0) {
        const entry = queue.shift()!;
        // One event per drawer, not one for the batch: replay approves the
        // same individuals even if the queue differs on the day.
        observer?.operator('approve', entry.id);
        spawnNow(entry);
        if (entry.disposition === 'admitted') n++;
      }
      notify();
      return n;
    },
    discardAll(): number {
      const n = queue.length;
      for (const entry of queue.splice(0, queue.length)) {
        observer?.operator('discard', entry.id);
        entry.disposition = 'refused';
        entry.reason = entry.reason ?? 'discarded by the operator';
      }
      notify();
      return n;
    },
    admitted(): GateEntry<T>[] {
      const live = opts.live;
      const rows = [...admittedById.values()];
      const kept = live ? rows.filter((r) => live(r.id)) : rows;
      return kept.sort((a, b) => b.seq - a.seq);
    },
    remove(id: string): boolean {
      const had = admittedById.delete(id);
      observer?.operator('remove', id);
      opts.clear?.(id);
      notify();
      return had;
    },
    block(id: string): void {
      observer?.operator('block', id);
      blockedIds.add(id);
      admittedById.delete(id);
      takeFromQueue(id);
      opts.clear?.(id);
      notify();
    },
    unblock(id: string): boolean {
      observer?.operator('unblock', id);
      const had = blockedIds.delete(id);
      notify();
      return had;
    },
    blocked: () => [...blockedIds],
    log: () => decisions.slice(),
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
