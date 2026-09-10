/**
 * The scene outbox (src/net/sceneoutbox.ts).
 *
 * What this pins is a cost claim, and it is the reason the module exists at
 * all: a brush emits a recorded dab per stamp and a slider a world event per
 * pointermove, so a straight publish would put hundreds of packets a second
 * on a free public broker and a POST per dab on the store. One batch per
 * tertiary beat, compacted, chunked — and nothing lost on the way out.
 */

import { describe, expect, it } from 'vitest';
import { createSceneOutbox } from '../../src/net/sceneoutbox';
import { MAX_SCENE_BATCH, type SceneEvent } from '../../src/session/scene';

/** A hand-cranked clock: the outbox takes its timer injected, so a test never
 * waits for one. */
function harness(delayMs = 456) {
  const sent: SceneEvent[][] = [];
  let fire: (() => void) | null = null;
  let armed = 0;
  let cleared = 0;
  const outbox = createSceneOutbox({
    delayMs,
    send: (batch) => sent.push(batch),
    setTimer: (fn) => {
      armed++;
      fire = fn;
      return armed;
    },
    clearTimer: () => {
      cleared++;
      fire = null;
    },
  });
  return {
    outbox,
    sent,
    tick: (): void => {
      const fn = fire;
      fire = null;
      fn?.();
    },
    armed: () => armed,
    cleared: () => cleared,
  };
}

const dab = (tool = 'raise'): SceneEvent => ({ k: 'paint', t: 0, tool, x: 1, z: 2, r: 3 });
const dial = (value: number): SceneEvent => ({
  k: 'world',
  t: 0,
  field: 'terrain',
  value,
  kind: 'elevation',
});

describe('the scene outbox', () => {
  it('sends nothing until the beat', () => {
    const h = harness();
    h.outbox.push(dab());
    h.outbox.push(dab());
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.pending()).toBe(2);
    h.tick();
    expect(h.sent).toEqual([[dab(), dab()]]);
  });

  it('arms its timer once for a burst, not once per event', () => {
    const h = harness();
    for (let i = 0; i < 50; i++) h.outbox.push(dab());
    expect(h.armed()).toBe(1);
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toHaveLength(50);
  });

  it('a slider drag leaves the page as one event', () => {
    const h = harness();
    for (let i = 1; i <= 30; i++) h.outbox.push(dial(i / 30));
    h.tick();
    expect(h.sent[0]).toHaveLength(1);
    expect((h.sent[0]![0] as { value: number }).value).toBe(1);
  });

  it('a clear takes the dabs before it off the wire entirely', () => {
    const h = harness();
    h.outbox.push(dab());
    h.outbox.push(dab());
    h.outbox.push(dab('clear'));
    h.outbox.push(dab('lower'));
    h.tick();
    expect(h.sent[0]).toEqual([dab('lower')]);
  });

  it('chunks at the wire cap', () => {
    const h = harness();
    // Distinct dabs, so compaction has nothing to collapse and the chunking
    // is what is being measured.
    for (let i = 0; i < MAX_SCENE_BATCH + 20; i++) {
      h.outbox.push({ k: 'paint', t: i, tool: 'raise', x: i, z: 0, r: 3 });
    }
    h.tick();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toHaveLength(MAX_SCENE_BATCH);
    expect(h.sent[1]).toHaveLength(20);
  });

  it('a flush sends now and disarms the timer', () => {
    const h = harness();
    h.outbox.push(dab());
    h.outbox.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.cleared()).toBe(1);
    // …and the beat that was pending does not send an empty batch after it.
    h.tick();
    expect(h.sent).toHaveLength(1);
  });

  it('a flush with nothing queued sends nothing', () => {
    const h = harness();
    h.outbox.flush();
    expect(h.sent).toHaveLength(0);
  });

  it('the queue is empty after a send, so nothing goes out twice', () => {
    const h = harness();
    h.outbox.push(dab());
    h.tick();
    h.outbox.push(dab('lower'));
    h.tick();
    expect(h.sent).toEqual([[dab()], [dab('lower')]]);
    expect(h.outbox.pending()).toBe(0);
  });

  it('re-arms for the next burst', () => {
    const h = harness();
    h.outbox.push(dab());
    h.tick();
    h.outbox.push(dab());
    expect(h.armed()).toBe(2);
  });
});
