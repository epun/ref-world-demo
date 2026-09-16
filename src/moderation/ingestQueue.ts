/**
 * The ingest gate's QUEUE — what stands between a burst of arriving drawings
 * and the one thread that has a world to draw.
 *
 * WHY. A refreshed projection heals itself by every handset in the room
 * re-publishing its own drawing (docs/RUNBOOK.md), and the store's own log
 * arrives as one lump beside it. Both used to reach `IngestGate.offer`
 * immediately, and `offer` builds the creature: the whole pure pipeline,
 * ~290ms of main thread each, measured at **57 seconds** for two hundred of
 * them. The tab was not slow, it was gone, and every phone watching the
 * projection was frozen with it (user report, 2026-09-16).
 *
 * WHAT IT DOES, and the two things it must not break:
 *
 *  - **ORDER IS EXACT.** Drawings are offered in the order they arrived,
 *    always. The gate's arrival number and the session log's event order are
 *    what an operator's list, an eviction decision and a replay are all built
 *    on, so a queue that reordered by whichever pipeline finished first would
 *    be a different room on replay. The pipelines run out of order and in
 *    parallel; the OFFERS do not.
 *  - **NOTHING IS LOST.** A drawing whose pipeline came back empty is still
 *    offered — with no blueprint, so the gate builds it inline exactly as it
 *    did before this file existed. The queue is an optimisation and a person's
 *    drawing is not.
 *
 * PURE OF PLATFORM: no DOM, no clock of its own, no `requestAnimationFrame`.
 * The yield and the clock are injected, the same discipline `createSceneOutbox`
 * and `replaySession` keep, so the pacing can be argued with in a test instead
 * of in a demo.
 */

/** What the queue needs of a drawing: an id, to skip one already standing. */
export interface QueuedDrawing {
  id: string;
}

export interface IngestQueueOptions<D extends QueuedDrawing, B> {
  /**
   * Run the expensive pure half for this drawing, off this thread where the
   * page can (src/character/blueprintPool.ts). Resolving null is fine and
   * means "offer it without one".
   */
  prepare(drawing: D): Promise<B | null>;
  /** Offer it to the gate, with the prepared half when there is one. */
  offer(drawing: D, prepared: B | null): void;
  /** Already in the world — a phone that published twice, or the store's own
   * pull got there first. Skipped without being offered. */
  has(id: string): boolean;
  /** Hand the frame back. Awaited; the next slice starts after it. */
  yieldFrame(): Promise<void>;
  /** Milliseconds, monotonic. Injected so a test owns the clock. */
  now(): number;
  /** ms of work per slice before `yieldFrame`. */
  budgetMs: number;
  /** How many `prepare` calls run ahead of the queue's head. At least 1. */
  ahead: number;
}

export interface IngestQueue<D extends QueuedDrawing> {
  /** Take one drawing. Starts the drain if it is not already running. */
  push(drawing: D): void;
  /** How many are waiting. For a readout and for tests. */
  pending(): number;
  /** Whether the drain is in flight. */
  running(): boolean;
  /** Resolves when the queue is empty and the drain has stopped. Tests await
   * it; nothing in the app does. */
  idle(): Promise<void>;
}

export function createIngestQueue<D extends QueuedDrawing, B>(
  options: IngestQueueOptions<D, B>,
): IngestQueue<D> {
  const ahead = Math.max(1, Math.floor(options.ahead));
  const queue: D[] = [];
  /** `prepare` promises for queue[0..], in queue order. */
  const prepared: Promise<B | null>[] = [];
  let running = false;
  let done: (() => void)[] = [];

  /**
   * Start pipelines until `ahead` of them are in flight.
   *
   * Called from `push` as well as from the drain loop, and that matters: a
   * restore pushes the whole log in ONE task, so a queue that only topped up
   * between offers would run exactly one pipeline until the head came back
   * and the workers would sit idle through the burst this file exists for.
   *
   * `prepared[i]` is the pipeline for `queue[i]` — both arrays shift together
   * in the drain, so claiming at `prepared.length` always claims the first
   * entry that has none.
   */
  const topUp = (): void => {
    while (prepared.length < ahead) {
      const next = queue[prepared.length];
      if (!next) return;
      prepared.push(options.prepare(next));
    }
  };

  const drain = async (): Promise<void> => {
    let slice = options.now();
    while (queue.length > 0) {
      topUp();
      /*
       * Strictly the head, whichever pipeline finished first — see the header
       * on why order is not negotiable.
       *
       * Read, THEN await, THEN shift both together. Shifting `prepared`
       * before the await would leave the two arrays out of step for the whole
       * time the head takes, and a `push` landing in that window would top up
       * against a `queue[0]` whose pipeline is already running — preparing the
       * same drawing twice.
       */
      const ready = await prepared[0];
      prepared.shift();
      const drawing = queue.shift()!;
      if (!options.has(drawing.id)) options.offer(drawing, ready ?? null);
      if (options.now() - slice >= options.budgetMs) {
        await options.yieldFrame();
        slice = options.now();
      }
    }
  };

  return {
    push(drawing): void {
      queue.push(drawing);
      topUp();
      if (running) return;
      running = true;
      void drain().finally(() => {
        running = false;
        const waiting = done;
        done = [];
        for (const resolve of waiting) resolve();
      });
    },
    pending: (): number => queue.length,
    running: (): boolean => running,
    idle(): Promise<void> {
      if (!running) return Promise.resolve();
      return new Promise<void>((resolve) => done.push(resolve));
    },
  };
}
