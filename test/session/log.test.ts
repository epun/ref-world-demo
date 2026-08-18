/**
 * The log format itself: offsets, round-tripping, and the two properties a
 * live installation depends on — appending costs nothing, and nothing in the
 * body is a wall clock.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COALESCE_MS,
  SESSION_SCHEMA,
  SESSION_SCHEMA_VERSION,
  countByKind,
  createSessionRecorder,
  parseSessionLog,
  sessionDurationMs,
} from '../../src/session';
import { circleBlob } from '../fixtures/strokes';

/** A clock the test drives by hand — the recorder holds none of its own. */
function fakeClock(start = 1000): { now(): number; advance(ms: number): void; set(v: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

function recorder(clock = fakeClock()): ReturnType<typeof createSessionRecorder> {
  return createSessionRecorder({
    epoch: 'wtest',
    room: 'abcd',
    startedAt: '2026-08-18T00:00:00.000Z',
    config: { hatchMs: 20000, maxPopulation: 24 },
    now: clock.now,
  });
}

describe('session log — shape', () => {
  it('stamps a header with one wall clock and nothing else', () => {
    const log = recorder().snapshot();
    expect(log.schema).toBe(SESSION_SCHEMA);
    expect(log.version).toBe(SESSION_SCHEMA_VERSION);
    expect(log.epoch).toBe('wtest');
    expect(log.room).toBe('abcd');
    expect(log.startedAt).toBe('2026-08-18T00:00:00.000Z');
    expect(log.events).toEqual([]);
  });

  it('has no wall clock anywhere in the body — every event offset is a small number', () => {
    const clock = fakeClock(1_755_000_000_000); // a plausible performance-free epoch
    const rec = recorder(clock);
    clock.advance(1200);
    rec.egg('a', 1, 2);
    clock.advance(800);
    rec.hatch('a', 'timer');
    const body = JSON.stringify(rec.snapshot().events);
    // A leaked Date.now would show up as a 13-digit number in the body.
    expect(body).not.toMatch(/\d{12,}/);
    expect(rec.snapshot().events.map((e) => e.t)).toEqual([1200, 2000]);
  });
});

describe('session log — offsets', () => {
  it('counts from session start, in ms', () => {
    const clock = fakeClock(5000);
    const rec = recorder(clock);
    clock.advance(250);
    rec.emote('a', 'happy', 'phone');
    clock.advance(1750);
    rec.emote('a', 'wave', 'key');
    expect(rec.snapshot().events.map((e) => e.t)).toEqual([250, 2000]);
    expect(sessionDurationMs(rec.snapshot())).toBe(2000);
  });

  it('never goes backwards, even when the clock does', () => {
    const clock = fakeClock();
    const rec = recorder(clock);
    clock.advance(500);
    rec.hatch('a', 'timer');
    clock.set(600); // clock stepped back below session start + 500
    rec.hatch('b', 'forced');
    const offsets = rec.snapshot().events.map((e) => e.t);
    expect(offsets).toEqual([500, 500]);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    }
  });
});

describe('session log — round trip', () => {
  it('survives json with the strokes intact', () => {
    const rec = recorder();
    const strokes = circleBlob;
    rec.drawing({
      id: 'd-phone-1',
      name: 'ana',
      personality: 'chaos',
      source: 'phone',
      strokes,
      hatchMs: 20000,
      disposition: 'admitted',
      verdict: 'allow',
      reason: null,
      confidence: 1,
    });
    rec.egg('d-phone-1', 3.2, -1.4);
    rec.hatch('d-phone-1', 'forced');
    rec.emote('d-phone-1', 'happy', 'phone');
    rec.operator('remove', 'd-phone-1');
    rec.retire('d-phone-1', 'operator');
    rec.world('weather', 'fog');

    const parsed = parseSessionLog(rec.toJson());
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(rec.snapshot());
    expect(countByKind(parsed!)).toEqual({
      drawing: 1,
      egg: 1,
      hatch: 1,
      emote: 1,
      operator: 1,
      retire: 1,
      world: 1,
    });
    const drawing = parsed!.events.find((e) => e.k === 'drawing');
    expect(drawing?.k).toBe('drawing');
    if (drawing?.k === 'drawing') expect(drawing.strokes).toEqual(strokes);
  });

  it('refuses junk, a foreign schema, a future version, and non-monotonic offsets', () => {
    expect(parseSessionLog('not json')).toBeNull();
    expect(parseSessionLog('[]')).toBeNull();
    const good = JSON.parse(recorder().toJson()) as Record<string, unknown>;
    expect(parseSessionLog(JSON.stringify({ ...good, schema: 'something.else' }))).toBeNull();
    expect(
      parseSessionLog(JSON.stringify({ ...good, version: SESSION_SCHEMA_VERSION + 1 })),
    ).toBeNull();
    expect(
      parseSessionLog(
        JSON.stringify({
          ...good,
          events: [
            { k: 'hatch', t: 900, id: 'a', cause: 'timer' },
            { k: 'hatch', t: 100, id: 'b', cause: 'timer' },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseSessionLog(
        JSON.stringify({ ...good, events: [{ k: 'drawing', t: 1, id: 'a', strokes: 'nope' }] }),
      ),
    ).toBeNull();
  });
});

describe('session log — cost', () => {
  it('appends in O(1) with no per-frame growth: a thousand idle frames add nothing', () => {
    const clock = fakeClock();
    const rec = recorder(clock);
    rec.hatch('a', 'timer');
    const before = rec.count();
    // Whatever the world does between events, the recorder is not wired to
    // any of it — nothing calls in per frame, so nothing accumulates.
    for (let frame = 0; frame < 1000; frame++) clock.advance(16);
    expect(rec.count()).toBe(before);
  });

  it('coalesces a slider drag into one world event instead of one per sample', () => {
    const clock = fakeClock();
    const rec = recorder(clock);
    for (let i = 0; i < 200; i++) {
      clock.advance(8); // ~120Hz pointermove
      rec.world('grain', i / 200);
    }
    expect(rec.count()).toBe(1);
    const last = rec.snapshot().events[0];
    expect(last?.k).toBe('world');
    if (last?.k === 'world') expect(last.value).toBeCloseTo(199 / 200);
  });

  it('starts a new world event once the knob has been still past the window', () => {
    const clock = fakeClock();
    const rec = recorder(clock);
    rec.world('grain', 0.02);
    clock.advance(DEFAULT_COALESCE_MS + 50);
    rec.world('grain', 0.05);
    expect(rec.count()).toBe(2);
  });

  it('never coalesces two different knobs into one', () => {
    const rec = recorder();
    rec.world('kindDensity', 1, 'tree');
    rec.world('kindDensity', 2, 'rock');
    expect(rec.count()).toBe(2);
  });

  it('refuses new events past the limit rather than dropping recorded history', () => {
    const rec = createSessionRecorder({
      epoch: 'w',
      room: 'abcd',
      startedAt: '2026-08-18T00:00:00.000Z',
      config: {},
      now: () => 0,
      limit: 3,
    });
    for (let i = 0; i < 10; i++) rec.hatch(`c${i}`, 'timer');
    expect(rec.count()).toBe(3);
    expect(rec.overflowed()).toBe(true);
    // The kept prefix is the FIRST three — a truncated prefix still replays.
    expect(rec.snapshot().events.map((e) => (e.k === 'hatch' ? e.id : ''))).toEqual([
      'c0',
      'c1',
      'c2',
    ]);
  });
});
