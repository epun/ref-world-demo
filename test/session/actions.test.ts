/**
 * The three kinds added when the log became a record of what people DID and
 * not only of what arrived: `drive` (somebody steered a creature), `paint`
 * (somebody sculpted the ground) and `keep` (somebody took their creature
 * home).
 *
 * The property that matters for `drive` is not that it records — it is that
 * it records LITTLE. A stick pushes at the display's rate, so the naive
 * version of this feature is a per-frame dump in a format whose whole claim
 * is that it holds none. So the sweep below is driven at 60Hz for a second
 * and the assertion is a ceiling, not a shape.
 *
 * The source scans at the end pin the seams: a drive applied without being
 * recorded, or a brush stamping past the hook, would be a hand on the world
 * that the log never saw — and neither can be reached from a unit test,
 * because one is a browser entry module and the other needs a gpu.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRIVE_MIN_GAP_MS,
  applyEvent,
  countByKind,
  createReplayState,
  createSessionRecorder,
  parseSessionLog,
  replayNow,
  replaySession,
  type DriveEvent,
  type KeepEvent,
  type PaintEvent,
  type ReplayDriver,
  type SessionLog,
  type SessionRecorder,
} from '../../src/session';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
/** Strip comments — a call NAMED in prose must not pass a scan on its own. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function clock(start = 0): { now(): number; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function recorder(now: () => number): SessionRecorder {
  return createSessionRecorder({
    epoch: 'wtest',
    room: 'abcd',
    startedAt: '2026-09-09T00:00:00.000Z',
    config: {},
    now,
  });
}

/** Unit vector at a heading in turns (0 = +x), scaled to `mag`. */
function push(turns: number, mag = 1): { x: number; z: number; mag: number } {
  const a = turns * Math.PI * 2;
  return { x: Math.cos(a) * mag, z: Math.sin(a) * mag, mag };
}

const drives = (log: SessionLog): DriveEvent[] =>
  log.events.filter((e): e is DriveEvent => e.k === 'drive');

describe('drive — the rate cap', () => {
  it('a 60Hz second of one held direction is ONE event, not sixty', () => {
    const c = clock();
    const rec = recorder(c.now);
    for (let frame = 0; frame < 60; frame++) {
      rec.drive('a', push(0.25, 0.8));
      c.advance(1000 / 60);
    }
    expect(drives(rec.snapshot())).toHaveLength(1);
  });

  it('a 60Hz sweep through every heading stays under the cap', () => {
    const c = clock();
    const rec = recorder(c.now);
    // A full turn over one second: every frame is a different quantised
    // heading, so only the cap can hold this down.
    for (let frame = 0; frame < 60; frame++) {
      rec.drive('a', push(frame / 60, 1));
      c.advance(1000 / 60);
    }
    const events = drives(rec.snapshot());
    const ceiling = Math.ceil(1000 / DEFAULT_DRIVE_MIN_GAP_MS) + 1;
    expect(events.length).toBeLessThanOrEqual(ceiling);
    expect(events.length).toBeGreaterThan(0);
  });

  it('caps per creature, not per world: four sticks each get their own', () => {
    const c = clock();
    const rec = recorder(c.now);
    for (const id of ['a', 'b', 'c', 'd']) rec.drive(id, push(0, 1));
    expect(drives(rec.snapshot()).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('records a heading change once the window has passed', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0, 1));
    c.advance(DEFAULT_DRIVE_MIN_GAP_MS + 1);
    rec.drive('a', push(0.5, 1));
    expect(drives(rec.snapshot())).toHaveLength(2);
  });

  it('drops a change that arrives inside the window, and keeps comparing against the log', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0, 1));
    c.advance(10);
    rec.drive('a', push(0.5, 1)); // capped — never written
    c.advance(DEFAULT_DRIVE_MIN_GAP_MS + 1);
    rec.drive('a', push(0.5, 1)); // still different from what the log holds
    const events = drives(rec.snapshot());
    expect(events).toHaveLength(2);
    expect(events[1]?.t).toBeGreaterThan(DEFAULT_DRIVE_MIN_GAP_MS);
  });
});

describe('drive — quantisation', () => {
  it('a jitter inside one cell is the same intent: recorded once', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0, 0.71));
    // Well past the cap, so only the quantiser can be holding these back:
    // an eightieth of a turn is inside 1/16, and 0.74 rounds to the same
    // tenth as 0.71.
    for (const [turn, mag] of [
      [0.005, 0.72],
      [0.01, 0.74],
      [-0.005, 0.69],
    ] as const) {
      c.advance(DEFAULT_DRIVE_MIN_GAP_MS + 1);
      rec.drive('a', push(turn, mag));
    }
    expect(drives(rec.snapshot())).toHaveLength(1);
  });

  it('crossing a heading cell records, however gently', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0, 1));
    c.advance(DEFAULT_DRIVE_MIN_GAP_MS + 1);
    rec.drive('a', push(1 / 16, 1));
    expect(drives(rec.snapshot())).toHaveLength(2);
  });

  it('folds the cell either side of due east into one', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0.001, 1));
    c.advance(DEFAULT_DRIVE_MIN_GAP_MS + 1);
    rec.drive('a', push(0.999, 1));
    expect(drives(rec.snapshot())).toHaveLength(1);
  });

  it('writes the vector as it was pushed, not the quantised stand-in', () => {
    const c = clock();
    const rec = recorder(c.now);
    const v = push(0.03, 0.77);
    rec.drive('a', v);
    const event = drives(rec.snapshot())[0];
    expect(event?.ax).toBeCloseTo(v.x, 2);
    expect(event?.az).toBeCloseTo(v.z, 2);
    expect(event?.mag).toBeCloseTo(0.77, 2);
  });
});

describe('drive — the release', () => {
  it('records once when the stick rests, and never again', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0, 1));
    c.advance(16);
    rec.drive('a', null);
    for (let i = 0; i < 30; i++) {
      c.advance(16);
      rec.drive('a', null);
    }
    const events = drives(rec.snapshot());
    expect(events).toHaveLength(2);
    expect(events[1]?.mag).toBe(0);
    expect(events[1]?.ax).toBeUndefined();
  });

  it('is exempt from the cap — letting go is never dropped', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0, 1));
    c.advance(1); // far inside the window
    rec.drive('a', { x: 1, z: 0, mag: 0 });
    expect(drives(rec.snapshot())).toHaveLength(2);
  });

  it('a rest on a creature nobody ever steered records nothing', () => {
    const rec = recorder(clock().now);
    rec.drive('a', null);
    expect(rec.count()).toBe(0);
  });

  it('a push after a release records immediately', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0, 1));
    c.advance(5);
    rec.drive('a', null);
    c.advance(5);
    rec.drive('a', push(0, 1));
    expect(drives(rec.snapshot())).toHaveLength(3);
  });
});

describe('paint and keep — the shapes', () => {
  it('records a dab in world units, rounded', () => {
    const rec = recorder(clock().now);
    rec.paint({
      tool: 'raise',
      x: 12.3456789,
      z: -4.2,
      r: 9.5,
      strength: 0.0625,
      hardness: 0.5,
      mode: 'raise',
      seed: 42.123456,
    });
    const event = rec.snapshot().events[0] as PaintEvent;
    expect(event.k).toBe('paint');
    expect(event.tool).toBe('raise');
    expect(event.x).toBe(12.346);
    expect(event.z).toBe(-4.2);
    expect(event.r).toBe(9.5);
    expect(event.strength).toBe(0.063);
    expect(event.mode).toBe('raise');
    expect(event.seed).toBe(42.123);
  });

  it('records the clear with no geometry at all', () => {
    const rec = recorder(clock().now);
    rec.paint({ tool: 'clear' });
    const event = rec.snapshot().events[0] as PaintEvent;
    expect(event.tool).toBe('clear');
    expect(event.x).toBeUndefined();
    expect(event.r).toBeUndefined();
  });

  it('records a keep with its drawer, its action and its source', () => {
    const rec = recorder(clock().now);
    rec.keep('drawer-1', 'photo');
    rec.keep('drawer-2', 'link', 'phone');
    const events = rec.snapshot().events as KeepEvent[];
    expect(events.map((e) => [e.id, e.action, e.source])).toEqual([
      ['drawer-1', 'photo', 'phone'],
      ['drawer-2', 'link', 'phone'],
    ]);
  });

  it('round-trips all three kinds through the json', () => {
    const c = clock();
    const rec = recorder(c.now);
    rec.drive('a', push(0.125, 1));
    c.advance(10);
    rec.paint({ tool: 'lower', x: 1, z: 2, r: 3, strength: 0.1 });
    c.advance(10);
    rec.keep('a', 'model');
    const parsed = parseSessionLog(rec.toJson());
    expect(parsed).not.toBeNull();
    expect(countByKind(parsed!)).toEqual({ drive: 1, paint: 1, keep: 1 });
  });

  it('refuses a log from a build that reads a lower version than it was written for', () => {
    const rec = recorder(clock().now);
    rec.keep('a', 'link');
    const raw = JSON.parse(rec.toJson()) as { version: number };
    expect(raw.version).toBe(2);
    // A reader that only knows v1 refuses this file — which is exactly what
    // the bump is for: a plain "junk in the events" would be the alternative.
    expect(parseSessionLog(JSON.stringify({ ...raw, version: 99 }))).toBeNull();
  });
});

// ── replay ──────────────────────────────────────────────────────────────────

interface Seen {
  drives: [string, { x: number; z: number; mag: number } | null][];
  paints: PaintEvent[];
  live: Set<string>;
}

function driver(): { seen: Seen; driver: ReplayDriver } {
  const seen: Seen = { drives: [], paints: [], live: new Set() };
  return {
    seen,
    driver: {
      spawn: (s) => {
        seen.live.add(s.id);
        return true;
      },
      hatch: () => {},
      emote: () => {},
      remove: (id) => {
        seen.live.delete(id);
      },
      drive: (id, vec) => seen.drives.push([id, vec]),
      paint: (event) => seen.paints.push(event),
    },
  };
}

/** A log with one admitted drawing, then the events under test. */
function logWith(events: SessionLog['events']): SessionLog {
  return {
    schema: 'refworld.session',
    version: 2,
    epoch: 'wtest',
    room: 'abcd',
    startedAt: '2026-09-09T00:00:00.000Z',
    config: {},
    events: [
      {
        k: 'drawing',
        t: 0,
        id: 'a',
        name: null,
        personality: null,
        source: 'phone',
        strokes: [{ pts: [[0.5, 0.5, 1]], w: 0.05 }],
        hatchMs: 0,
        disposition: 'admitted',
        verdict: 'allow',
        reason: null,
        confidence: 1,
      },
      ...events,
    ],
  };
}

describe('replay — drive, paint, keep', () => {
  it('re-drives the creature at the recorded offsets, release and all', () => {
    const log = logWith([
      { k: 'drive', t: 100, id: 'a', ax: 1, az: 0, mag: 1 },
      { k: 'drive', t: 600, id: 'a', ax: 0, az: 1, mag: 0.5 },
      { k: 'drive', t: 900, id: 'a', mag: 0 },
    ]);
    const { seen, driver: d } = driver();
    const waits: number[] = [];
    replaySession(log, d, {
      schedule: (ms, fn) => {
        waits.push(ms);
        fn();
      },
    });
    expect(seen.drives).toEqual([
      ['a', { x: 1, z: 0, mag: 1 }],
      ['a', { x: 0, z: 1, mag: 0.5 }],
      ['a', null],
    ]);
    // At the recorded offsets: 100 from the drawing, then 500, then 300 —
    // the hold is what makes the wander wait exactly as long as it did live.
    expect(waits).toEqual([100, 500, 300]);
  });

  it('never steers a creature that is not standing', () => {
    const log = logWith([{ k: 'drive', t: 10, id: 'ghost', ax: 1, az: 0, mag: 1 }]);
    const { seen, driver: d } = driver();
    replaySession(log, d, { schedule: (_ms, fn) => fn() });
    expect(seen.drives).toEqual([]);
  });

  it('re-applies paint dabs through the apply path', () => {
    const dab: PaintEvent = {
      k: 'paint',
      t: 20,
      tool: 'raise',
      x: 4,
      z: -8,
      r: 12,
      strength: 0.25,
      seed: 7,
    };
    const log = logWith([dab, { k: 'paint', t: 40, tool: 'clear' }]);
    const { seen, driver: d } = driver();
    replaySession(log, d, { schedule: (_ms, fn) => fn() });
    expect(seen.paints).toEqual([dab, { k: 'paint', t: 40, tool: 'clear' }]);
  });

  it('a keep does nothing at all — informational, like an egg', () => {
    const log = logWith([{ k: 'keep', t: 10, id: 'a', action: 'photo', source: 'phone' }]);
    const { seen, driver: d } = driver();
    // The driver has no `keep` to call; what is pinned is that nothing else
    // fires either, and that the log still replays.
    replaySession(log, d, { schedule: (_ms, fn) => fn() });
    expect(seen.drives).toEqual([]);
    expect(seen.paints).toEqual([]);
    expect([...seen.live]).toEqual(['a']);
  });

  it('a RESTORE skips both: a hold has no duration when every offset is now', () => {
    const log = logWith([
      { k: 'drive', t: 100, id: 'a', ax: 1, az: 0, mag: 1 },
      { k: 'paint', t: 200, tool: 'raise', x: 1, z: 1, r: 2, strength: 0.1 },
      { k: 'keep', t: 300, id: 'a', action: 'link', source: 'phone' },
    ]);
    const { seen, driver: d } = driver();
    replayNow(log, d);
    // The creature is back and is NOT walking off into the distance under a
    // push nobody ever released.
    expect([...seen.live]).toEqual(['a']);
    expect(seen.drives).toEqual([]);
    expect(seen.paints).toEqual([]);
  });

  it('applyEvent applies them by default — instant is the caller opting out', () => {
    const { seen, driver: d } = driver();
    const state = createReplayState();
    state.live.add('a');
    applyEvent({ k: 'drive', t: 0, id: 'a', ax: 1, az: 0, mag: 1 }, d, state);
    expect(seen.drives).toHaveLength(1);
    applyEvent({ k: 'drive', t: 1, id: 'a', mag: 0 }, d, state, { instant: true });
    expect(seen.drives).toHaveLength(1);
  });
});

// ── the seams, scanned in source ────────────────────────────────────────────

describe('the recording seams', () => {
  const main = code(read('src/main.ts'));

  it('every steering intent goes through the one seam that records it', () => {
    expect(main).toMatch(/const applyDrive = \(/);
    // One call to the manager's drive in the whole entry module — the one
    // inside applyDrive — plus the replay driver's, which must NOT record
    // or a watched replay would grow the log it is replaying.
    const applied = main.match(/creatures\.drive\(/g) ?? [];
    expect(applied).toHaveLength(2);
    expect(main).toMatch(/session\.drive\(/);
  });

  it('applies the host-side wire intent and the local stick through it', () => {
    expect(main).toMatch(/applyDrive\(msg\.who,/);
    expect(main).toMatch(/applyDrive\(myDrawerId, v\)/);
    // The expiry too: a release the log loses walks the creature forever.
    expect(main).toMatch(/applyDrive\(who, null\)/);
  });

  it('records a handset save when it hears one', () => {
    expect(main).toMatch(/onKeep:/);
    expect(main).toMatch(/session\.keep\(from, action, 'phone'\)/);
  });

  it('the handset tells the world about a save, and never waits on it', () => {
    const phone = code(read('src/phone/main.ts'));
    // Optional chain: with no uplink (an installation handset, a page with
    // no mqtt) the save is exactly as saved and nothing is sent.
    expect(phone).toMatch(/onKeep: \(action\) => uplink\?\.keep\(action\)/);
    const alive = code(read('src/phone/screens/alive.ts'));
    // keepui's own key for the first row is older than the label; the map
    // to the wire's vocabulary happens at this one seam.
    expect(alive).toMatch(/action === 'picture' \? 'photo' : action/);
    // Only a save that worked: a save that failed is not a save.
    expect(alive).toMatch(/if \(ok\) options\.onKeep\?\./);
  });

  it('the paint hook is wired to the per-dab stamp, not to the stroke', () => {
    const paint = code(read('src/dev/paint.ts'));
    expect(paint).toMatch(/const recordStamp = \(/);
    expect(paint).toMatch(/handles\.session\?\.paint\(/);
    // The `clear map` button records too, or a replay would keep every dab
    // of a map somebody threw away.
    expect(paint).toMatch(/tool: 'clear'/);
    // And the replay seam the world's driver reaches for.
    expect(paint).toMatch(/applyPaint/);
  });
});
