/**
 * Replay against the REAL ingest gate: record a session driven through
 * src/moderation/gate.ts, then replay the log and assert the world that comes
 * back out is the world that was recorded.
 *
 * The properties that matter to a person:
 *   - the same drawers come back, with the same strokes, in the same order;
 *   - a drawing the screen refused never comes back;
 *   - a creature an operator REMOVED stays removed — a replay that lost that
 *     would resurrect something someone deleted;
 *   - a drawing held for approval only appears if it was approved.
 */

import { describe, expect, it } from 'vitest';
import { createIngestGate } from '../../src/moderation/gate';
import {
  createSessionRecorder,
  expectedCreatures,
  parseSessionLog,
  recordGate,
  replayNow,
  replaySession,
  type ReplayDriver,
  type SessionRecorder,
} from '../../src/session';
import type { StrokeList } from '../../src/shape/types';
import { circleBlob, fish, snowman } from '../fixtures/strokes';
import { INNOCENT_SET, PHALLUS_SET } from '../fixtures/moderation';

const innocent = INNOCENT_SET.find((f) => f.name === 'cat')!.strokes;
const offensive = PHALLUS_SET[0]!.strokes;

interface RecordedDrawing {
  id: string;
  name: string | null;
  personality: string | null;
  strokes: StrokeList;
  hatchMs: number;
  source: 'phone' | 'local' | 'dev';
}

/** A world sitting behind the gate, plus the recorder wired to it. */
function session(): {
  gate: ReturnType<typeof createIngestGate<RecordedDrawing>>;
  recorder: SessionRecorder;
  live: Map<string, StrokeList>;
  tick(ms: number): void;
} {
  let clock = 0;
  const live = new Map<string, StrokeList>();
  const recorder = createSessionRecorder({
    epoch: 'wtest',
    room: 'abcd',
    startedAt: '2026-08-18T00:00:00.000Z',
    config: { hatchMs: 20000 },
    now: () => clock,
  });
  const gate = createIngestGate<RecordedDrawing>({
    observer: recordGate(recorder),
    spawn: (d) => {
      live.set(d.id, d.strokes);
      return true;
    },
    clear: (id) => {
      live.delete(id);
    },
    live: (id) => live.has(id),
  });
  return {
    gate,
    recorder,
    live,
    tick: (ms) => {
      clock += ms;
    },
  };
}

function offer(
  gate: ReturnType<typeof createIngestGate<RecordedDrawing>>,
  id: string,
  strokes: StrokeList,
  extra: Partial<RecordedDrawing> = {},
): void {
  gate.offer({
    id,
    name: null,
    personality: null,
    strokes,
    hatchMs: 20000,
    source: 'phone',
    ...extra,
  });
}

/** The replay side: a second, empty world. */
function replayWorld(): { driver: ReplayDriver; live: Map<string, StrokeList>; hatched: string[]; emotes: string[] } {
  const live = new Map<string, StrokeList>();
  const hatched: string[] = [];
  const emotes: string[] = [];
  const driver: ReplayDriver = {
    spawn: (s) => {
      live.set(s.id, s.strokes);
      return true;
    },
    hatch: (id) => {
      hatched.push(id);
    },
    emote: (id, e) => {
      emotes.push(`${id}:${e}`);
    },
    remove: (id) => {
      live.delete(id);
    },
  };
  return { driver, live, hatched, emotes };
}

describe('replay — the same session comes back', () => {
  it('reproduces the same ids and the same strokes, in the same order', () => {
    const s = session();
    offer(s.gate, 'd-phone-1', circleBlob, { name: 'ana' });
    s.tick(900);
    offer(s.gate, 'd-phone-2', snowman, { name: 'bo', personality: 'chaos' });
    s.tick(1500);
    offer(s.gate, 'd-phone-3', fish, { source: 'local' });

    const log = parseSessionLog(s.recorder.toJson())!;
    const replayed = replayWorld();
    replayNow(log, replayed.driver);

    expect([...replayed.live.keys()]).toEqual([...s.live.keys()]);
    for (const [id, strokes] of s.live) {
      expect(replayed.live.get(id)).toEqual(strokes);
    }
    expect(expectedCreatures(log)).toEqual([...s.live.keys()].sort());
  });

  it('carries the name and the personality through, since generation reads them', () => {
    const s = session();
    offer(s.gate, 'd1', circleBlob, { name: 'ana', personality: 'sleep' });
    const log = parseSessionLog(s.recorder.toJson())!;
    const spawns: { id: string; name: string | null; personality: string | null }[] = [];
    replayNow(log, {
      spawn: (x) => {
        spawns.push({ id: x.id, name: x.name, personality: x.personality });
        return true;
      },
      hatch: () => {},
      emote: () => {},
      remove: () => {},
    });
    expect(spawns).toEqual([{ id: 'd1', name: 'ana', personality: 'sleep' }]);
  });

  it('never brings back a drawing the screen refused', () => {
    const s = session();
    offer(s.gate, 'good', innocent);
    offer(s.gate, 'bad', offensive);
    expect(s.live.has('bad')).toBe(false);

    const log = parseSessionLog(s.recorder.toJson())!;
    // The refusal IS in the log — the decision is auditable — but it never
    // becomes a creature again.
    const refused = log.events.find((e) => e.k === 'drawing' && e.id === 'bad');
    expect(refused?.k === 'drawing' && refused.disposition).toBe('refused');

    const replayed = replayWorld();
    replayNow(log, replayed.driver);
    expect([...replayed.live.keys()]).toEqual(['good']);
  });

  it('keeps an operator removal removed', () => {
    const s = session();
    offer(s.gate, 'keep', circleBlob);
    offer(s.gate, 'delete-me', snowman);
    s.tick(4000);
    s.gate.remove('delete-me');
    expect([...s.live.keys()]).toEqual(['keep']);

    const log = parseSessionLog(s.recorder.toJson())!;
    const replayed = replayWorld();
    replayNow(log, replayed.driver);
    expect([...replayed.live.keys()]).toEqual(['keep']);
    expect(expectedCreatures(log)).toEqual(['keep']);
  });

  it('keeps a blocked drawer out, on the replay too', () => {
    const s = session();
    offer(s.gate, 'nuisance', circleBlob);
    s.gate.block('nuisance');
    s.tick(500);
    offer(s.gate, 'nuisance', snowman); // they try again
    expect(s.live.size).toBe(0);

    const log = parseSessionLog(s.recorder.toJson())!;
    const replayed = replayWorld();
    replayNow(log, replayed.driver);
    expect(replayed.live.size).toBe(0);
  });

  it('spawns a held drawing only when the operator approved it', () => {
    const s = session();
    s.gate.setHoldAll(true);
    offer(s.gate, 'yes', circleBlob);
    offer(s.gate, 'no', snowman);
    expect(s.live.size).toBe(0);
    s.tick(3000);
    s.gate.approve('yes');
    s.gate.discard('no');
    expect([...s.live.keys()]).toEqual(['yes']);

    const log = parseSessionLog(s.recorder.toJson())!;
    const held = log.events.find((e) => e.k === 'drawing' && e.id === 'yes');
    expect(held?.k === 'drawing' && held.disposition).toBe('held');

    const replayed = replayWorld();
    replayNow(log, replayed.driver);
    expect([...replayed.live.keys()]).toEqual(['yes']);
    // And the approval landed at the offset it was made, not at arrival.
    const approve = log.events.find((e) => e.k === 'operator' && e.action === 'approve');
    expect(approve?.t).toBe(3000);
  });

  it('replays hatches and emotes onto the creature that had them', () => {
    const s = session();
    offer(s.gate, 'a', circleBlob);
    offer(s.gate, 'b', snowman);
    s.tick(2000);
    s.recorder.hatch('a', 'forced');
    s.recorder.emote('a', 'happy', 'phone');
    s.recorder.hatch('b', 'timer');

    const log = parseSessionLog(s.recorder.toJson())!;
    const replayed = replayWorld();
    replayNow(log, replayed.driver);
    expect(replayed.hatched).toEqual(['a', 'b']);
    expect(replayed.emotes).toEqual(['a:happy']);
  });

  it('does not emote a creature that was already removed', () => {
    const s = session();
    offer(s.gate, 'a', circleBlob);
    s.gate.remove('a');
    s.recorder.emote('a', 'wave', 'phone');
    const log = parseSessionLog(s.recorder.toJson())!;
    const replayed = replayWorld();
    replayNow(log, replayed.driver);
    expect(replayed.emotes).toEqual([]);
  });
});

describe('replay — in time', () => {
  it('fires each event at its recorded offset through the injected scheduler', () => {
    const s = session();
    offer(s.gate, 'a', circleBlob);
    s.tick(1000);
    offer(s.gate, 'b', snowman);
    s.tick(2500);
    s.gate.remove('a');

    const log = parseSessionLog(s.recorder.toJson())!;
    // A hand-cranked clock: every scheduled wait is collected, never run.
    const waits: number[] = [];
    const queue: (() => void)[] = [];
    const replayed = replayWorld();
    replaySession(log, replayed.driver, {
      schedule: (ms, fn) => {
        waits.push(ms);
        queue.push(fn);
      },
    });
    // Nothing past the first offset has happened until the clock is turned.
    expect([...replayed.live.keys()]).toEqual(['a']);
    while (queue.length > 0) queue.shift()!();
    expect([...replayed.live.keys()]).toEqual(['b']);
    // Gaps, not absolute offsets: 0ms → 1000ms → 2500ms.
    expect(waits).toEqual([1000, 2500]);
  });

  it('honours a speed multiplier and can be stopped mid-session', () => {
    const s = session();
    offer(s.gate, 'a', circleBlob);
    s.tick(4000);
    offer(s.gate, 'b', snowman);

    const log = parseSessionLog(s.recorder.toJson())!;
    const waits: number[] = [];
    const queue: (() => void)[] = [];
    const replayed = replayWorld();
    const handle = replaySession(log, replayed.driver, {
      speed: 4,
      schedule: (ms, fn) => {
        waits.push(ms);
        queue.push(fn);
      },
    });
    expect(waits).toEqual([1000]);
    handle.stop();
    while (queue.length > 0) queue.shift()!();
    expect([...replayed.live.keys()]).toEqual(['a']);
    expect(handle.done()).toBe(true);
  });
});
