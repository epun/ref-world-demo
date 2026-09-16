/**
 * The ingest queue (src/moderation/ingestQueue.ts) — the thing that stands
 * between two hundred handsets re-publishing after a refresh and the one
 * thread that has a world to draw.
 *
 * Two properties carry the whole design and both are pinned here:
 *
 *  - **order is exact.** The pipelines finish out of order, on purpose; the
 *    OFFERS must not. The gate's arrival number and the session log's event
 *    order are what an operator's list, an eviction decision and a replay are
 *    built on, so a queue that offered whichever pipeline finished first
 *    would be a different room on replay.
 *  - **nothing is lost.** A pipeline that comes back empty still offers the
 *    drawing, with no prepared half, so the gate builds it inline exactly as
 *    it did before the queue existed.
 *
 * The clock and the yield are injected, so the budget is tested rather than
 * timed.
 */

import { describe, expect, it } from 'vitest';
import { createIngestQueue } from '../../src/moderation/ingestQueue';

interface Drawing {
  id: string;
}

/** A queue whose pipelines resolve when the test says so, in any order. */
function harness(opts: { budgetMs?: number; ahead?: number; standing?: Set<string> } = {}): {
  queue: ReturnType<typeof createIngestQueue<Drawing, string>>;
  offered: { id: string; prepared: string | null }[];
  release(id: string, prepared: string | null): void;
  started: string[];
  yields: number;
  tick(ms: number): void;
  clock(): number;
} {
  const offered: { id: string; prepared: string | null }[] = [];
  const started: string[] = [];
  const gates = new Map<string, (value: string | null) => void>();
  let now = 0;
  const state = { yields: 0 };
  const queue = createIngestQueue<Drawing, string>({
    prepare: (drawing) => {
      started.push(drawing.id);
      return new Promise<string | null>((resolve) => gates.set(drawing.id, resolve));
    },
    offer: (drawing, prepared) => offered.push({ id: drawing.id, prepared }),
    has: (id) => opts.standing?.has(id) ?? false,
    yieldFrame: (): Promise<void> => {
      state.yields++;
      return Promise.resolve();
    },
    now: () => now,
    budgetMs: opts.budgetMs ?? 8,
    ahead: opts.ahead ?? 3,
  });
  return {
    queue,
    offered,
    started,
    get yields(): number {
      return state.yields;
    },
    release: (id, prepared): void => {
      const resolve = gates.get(id);
      if (!resolve) throw new Error(`nothing started for ${id}`);
      gates.delete(id);
      resolve(prepared);
    },
    tick: (ms): void => {
      now += ms;
    },
    clock: () => now,
  };
}

/** Let every queued microtask run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('the ingest queue', () => {
  it('offers in ARRIVAL order however the pipelines finish', async () => {
    const h = harness({ ahead: 4 });
    for (const id of ['a', 'b', 'c', 'd']) h.queue.push({ id });
    await settle();
    // Four pipelines are running at once (that is the point of `ahead`).
    expect(h.started).toEqual(['a', 'b', 'c', 'd']);
    // Finish them backwards.
    h.release('d', 'D');
    h.release('c', 'C');
    await settle();
    // Nothing has been offered: the head is still waiting on its own.
    expect(h.offered).toEqual([]);
    h.release('b', 'B');
    await settle();
    expect(h.offered).toEqual([]);
    h.release('a', 'A');
    await h.queue.idle();
    expect(h.offered).toEqual([
      { id: 'a', prepared: 'A' },
      { id: 'b', prepared: 'B' },
      { id: 'c', prepared: 'C' },
      { id: 'd', prepared: 'D' },
    ]);
  });

  it('runs at most `ahead` pipelines at a time', async () => {
    const h = harness({ ahead: 2 });
    for (const id of ['a', 'b', 'c', 'd']) h.queue.push({ id });
    await settle();
    expect(h.started).toEqual(['a', 'b']);
    h.release('a', 'A');
    await settle();
    // One finished, so one more is claimed — never more than two in flight.
    expect(h.started).toEqual(['a', 'b', 'c']);
    h.release('b', 'B');
    h.release('c', 'C');
    await settle();
    expect(h.started).toEqual(['a', 'b', 'c', 'd']);
    h.release('d', 'D');
    await h.queue.idle();
    expect(h.offered.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('offers a drawing whose pipeline came back empty, with no prepared half', async () => {
    const h = harness();
    h.queue.push({ id: 'a' });
    await settle();
    h.release('a', null);
    await h.queue.idle();
    expect(h.offered).toEqual([{ id: 'a', prepared: null }]);
  });

  it('skips one that is already standing', async () => {
    const standing = new Set(['b']);
    const h = harness({ standing });
    for (const id of ['a', 'b', 'c']) h.queue.push({ id });
    await settle();
    for (const id of ['a', 'b', 'c']) h.release(id, id.toUpperCase());
    await h.queue.idle();
    expect(h.offered.map((o) => o.id)).toEqual(['a', 'c']);
  });

  it('hands the frame back once the slice has spent its budget, and not before', async () => {
    const h = harness({ budgetMs: 10, ahead: 4 });
    for (const id of ['a', 'b', 'c']) h.queue.push({ id });
    await settle();
    h.release('a', 'A');
    await settle();
    expect(h.yields).toBe(0);
    // The slice has now been open long enough.
    h.tick(11);
    h.release('b', 'B');
    await settle();
    expect(h.yields).toBe(1);
    h.release('c', 'C');
    await h.queue.idle();
    // The budget restarted after the yield, so no second one.
    expect(h.yields).toBe(1);
  });

  it('takes a drawing pushed while it is already draining', async () => {
    const h = harness({ ahead: 1 });
    h.queue.push({ id: 'a' });
    await settle();
    expect(h.queue.running()).toBe(true);
    h.queue.push({ id: 'b' });
    expect(h.queue.pending()).toBe(2);
    h.release('a', 'A');
    await settle();
    h.release('b', 'B');
    await h.queue.idle();
    expect(h.offered.map((o) => o.id)).toEqual(['a', 'b']);
    expect(h.queue.running()).toBe(false);
    expect(h.queue.pending()).toBe(0);
  });

  it('is idle immediately when nothing has been pushed', async () => {
    const h = harness();
    await h.queue.idle();
    expect(h.queue.running()).toBe(false);
  });

  it('keeps at least one pipeline in flight however small `ahead` is asked to be', async () => {
    const h = harness({ ahead: 0 });
    h.queue.push({ id: 'a' });
    await settle();
    expect(h.started).toEqual(['a']);
    h.release('a', 'A');
    await h.queue.idle();
    expect(h.offered.map((o) => o.id)).toEqual(['a']);
  });
});
