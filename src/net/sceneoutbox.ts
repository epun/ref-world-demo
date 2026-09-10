/**
 * The scene outbox — what a page has sculpted, on its way to everybody else.
 *
 * WHY IT IS NOT A STRAIGHT PUBLISH (2026-09-09, the demo plan: the operator
 * paints live and *"the phones must see it"*). A brush emits one recorded dab
 * per stamp and a slider drag emits one world event per pointermove. Sending
 * a packet per event would put a few hundred messages a second onto a free
 * public broker and a POST per dab onto the store — which is the same mistake
 * the recorder refuses to make when it records (docs/SESSION.md §the two
 * thinned kinds), one layer further out.
 *
 * So events collect for one tertiary beat, get COMPACTED (the dials collapse
 * to their last value, a `clear` swallows everything before it —
 * src/session/scene.ts), and go out as one batch, chunked at MAX_SCENE_BATCH.
 * A stroke arrives as a stroke rather than as a drip.
 *
 * PURE: no DOM, no timers of its own. The timer is injected, exactly as
 * `replaySession` injects its scheduler, so the batching can be argued with
 * in a test instead of in a demo.
 */

import { MAX_SCENE_BATCH, compactScene, type SceneEvent } from '../session/scene';

export interface SceneOutboxOptions {
  /** Ship one batch. Called once per chunk, in order. */
  send(batch: SceneEvent[]): void;
  /**
   * How long events collect before a batch goes out, ms. The call site
   * passes `MOTION.tertiaryMs` — the shortest interval this project treats
   * as a movement anybody perceives, so also the shortest at which "the
   * ground changed" is worth a packet.
   */
  delayMs: number;
  /** Injected so this module holds no platform; defaults to setTimeout. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface SceneOutbox {
  /** Queue one change. Arms the batch timer if it is not already armed. */
  push(event: SceneEvent): void;
  /** Send whatever is queued now — the page is going away, or an operator
   * pressed something that has to land. */
  flush(): void;
  /** How many events are waiting. For a readout and for tests. */
  pending(): number;
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const timers = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };
  if (typeof timers.setTimeout === 'function') return timers.setTimeout(fn, ms);
  fn();
  return null;
}

function defaultClearTimer(handle: unknown): void {
  const timers = globalThis as { clearTimeout?: (handle: unknown) => void };
  if (typeof timers.clearTimeout === 'function') timers.clearTimeout(handle);
}

export function createSceneOutbox(options: SceneOutboxOptions): SceneOutbox {
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  let queue: SceneEvent[] = [];
  let timer: unknown = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    // Compact BEFORE chunking: a drag that collapses to one event must not
    // be split across two packets first and then fail to collapse at all.
    const batch = compactScene(queue);
    queue = [];
    for (let i = 0; i < batch.length; i += MAX_SCENE_BATCH) {
      options.send(batch.slice(i, i + MAX_SCENE_BATCH));
    }
  };

  return {
    push(event: SceneEvent): void {
      queue.push(event);
      // TRAILING, not leading, for the same reason the terrain dials debounce
      // that way (src/dev/index.ts): what has to go out is where the hand
      // ended up, and a leading edge sends where it started.
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        flush();
      }, options.delayMs);
    },
    flush,
    pending: () => queue.length,
  };
}
