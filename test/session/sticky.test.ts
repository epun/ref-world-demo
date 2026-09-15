/**
 * The four katamari kinds in the session format (docs/SESSION.md §2, §6).
 *
 * `stick`, `drop`, `loose` and `settle` are the first creature events that are
 * also SCENE events, and the first that a viewer has no way of re-deriving —
 * they depend on where a stone had rolled to, off a rapier simulation that
 * runs on exactly one page. So they travel, which means they go through the
 * door, and the door is what this file is about.
 */

import { describe, expect, it } from 'vitest';
import {
  compactScene,
  createSessionRecorder,
  isSceneEvent,
  parseSessionLog,
  readSceneEvent,
  replayNow,
  SESSION_SCHEMA_VERSION,
  SCENE_EXTENT,
  type ReplayDriver,
  type SceneEvent,
  type SessionEvent,
} from '../../src/session';
import { circleBlob } from '../fixtures/strokes';

function recorder(): ReturnType<typeof createSessionRecorder> {
  let t = 0;
  return createSessionRecorder({
    epoch: 'e1',
    room: 'xkcd',
    startedAt: '2026-09-15T00:00:00.000Z',
    config: { hatchMs: 1, maxPopulation: 4, wanderSpeed: 1, worldScale: 1 },
    now: () => (t += 10),
  });
}

const STICK = {
  k: 'stick' as const,
  t: 1,
  id: 'a',
  item: 'rock:0:1.00:2.00',
  kind: 'rock',
  variant: 0,
  scale: 1.2,
  ox: 1,
  oy: 2,
  oz: 3,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
};

const DROP = {
  k: 'drop' as const,
  t: 2,
  id: 'a',
  item: 'rock:0:1.00:2.00',
  x: 4,
  z: 5,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
};

const SETTLE = {
  k: 'settle' as const,
  t: 3,
  item: 'rock:0:1.00:2.00',
  x: 4,
  z: 5,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
};

const LOOSE = { k: 'loose' as const, t: 1, item: 'tree:1:-3.00:8.00', x: -3, z: 8 };

/** A carrier that is actually STANDING. `state.live` is fed by an admitted
 * drawing and by an operator's approve, not by a bare `hatch` — the same
 * rule an emote and a drive already follow, which is what these tests are
 * about. `spawn` returning true is what admits it. */
const DRAWING = {
  k: 'drawing' as const,
  t: 0,
  id: 'a',
  name: null,
  personality: null,
  source: 'phone',
  strokes: circleBlob,
  hatchMs: 1,
  disposition: 'admitted',
  verdict: 'allow',
  reason: null,
  confidence: 1,
};

describe('schema version', () => {
  it('bumped past the version that did not know these kinds', () => {
    // 3 was the katamari four; 4 is `crack` and `shatter` on top of them
    // (the destruction runtime, 2026-09-15). The argument for each bump is
    // the same: `isEvent` refuses an unrecognised `k` and one bad event
    // fails the WHOLE file, so the version is what tells "junk" from
    // "newer".
    expect(SESSION_SCHEMA_VERSION).toBe(4);
  });

  it('round-trips all four kinds through the log', () => {
    const rec = recorder();
    // The recorder stamps `k` and `t` — a caller hands over the geometry and
    // nothing else, so they come off the fixtures here.
    const { k: _sk, t: _st, ...stick } = STICK;
    const { k: _dk, t: _dt, ...drop } = DROP;
    const { k: _tk, t: _tt, ...settle } = SETTLE;
    rec.stick(stick);
    rec.drop(drop);
    rec.loose('tree:1:-3.00:8.00', -3, 8);
    rec.settle(settle);
    const parsed = parseSessionLog(rec.toJson());
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(4);
    expect(parsed!.events.map((e) => e.k)).toEqual(['stick', 'drop', 'loose', 'settle']);
  });

  it('still reads a v1, v2 and v3 log exactly as it always did', () => {
    for (const version of [1, 2, 3]) {
      const log = JSON.stringify({
        schema: 'refworld.session',
        version,
        epoch: 'e',
        room: 'xkcd',
        startedAt: '2026-09-15T00:00:00.000Z',
        config: { hatchMs: 1, maxPopulation: 1, wanderSpeed: 1, worldScale: 1 },
        events: [{ k: 'hatch', t: 0, id: 'a', cause: 'forced' }],
      });
      expect(parseSessionLog(log), String(version)).not.toBeNull();
    }
  });

  it('refuses a log with a malformed one of the four in it', () => {
    // A whole FILE is refused on one bad event, which is the format's rule:
    // a log with a hole in the middle does not replay faithfully.
    const log = JSON.stringify({
      schema: 'refworld.session',
      version: 3,
      epoch: 'e',
      room: 'xkcd',
      startedAt: '2026-09-15T00:00:00.000Z',
      config: { hatchMs: 1, maxPopulation: 1, wanderSpeed: 1, worldScale: 1 },
      // No `item` at all.
      events: [{ k: 'stick', t: 0, id: 'a' }],
    });
    expect(parseSessionLog(log)).toBeNull();
  });
});

describe('isSceneEvent', () => {
  it('counts all four — the props are the ground, and the room must agree', () => {
    for (const event of [STICK, DROP, LOOSE, SETTLE]) {
      expect(isSceneEvent(event as SessionEvent), event.k).toBe(true);
    }
  });

  it('still leaves the rest of the cast out of the scene', () => {
    expect(isSceneEvent({ k: 'hatch', t: 0, id: 'a', cause: 'forced' } as SessionEvent)).toBe(
      false,
    );
    expect(
      isSceneEvent({ k: 'emote', t: 0, id: 'a', emote: 'wave', source: 'phone' } as SessionEvent),
    ).toBe(false);
  });
});

describe('readSceneEvent — the door', () => {
  it('reads a well-formed one of each', () => {
    for (const event of [STICK, DROP, LOOSE, SETTLE]) {
      expect(readSceneEvent(event), event.k).not.toBeNull();
    }
  });

  it('clamps a drop, a loose and a settle to the map', () => {
    const far = readSceneEvent({ ...DROP, x: 1e9, z: -1e9 });
    expect(far).toMatchObject({ x: SCENE_EXTENT, z: -SCENE_EXTENT });
    expect(readSceneEvent({ ...LOOSE, x: 1e9 })).toMatchObject({ x: SCENE_EXTENT });
    expect(readSceneEvent({ ...SETTLE, z: 1e9 })).toMatchObject({ z: SCENE_EXTENT });
  });

  it('clamps a clump offset rather than refusing it', () => {
    const read = readSceneEvent({ ...STICK, ox: 1e6, oy: -1e6, oz: 0 }) as {
      ox: number;
      oy: number;
    };
    expect(read.ox).toBe(64);
    expect(read.oy).toBe(-64);
  });

  it('NORMALISES a quaternion rather than clamping it', () => {
    // Four components are not independent: clamping one leaves a rotation
    // that is still not a rotation, and three.js applies it as a shear.
    const read = readSceneEvent({ ...DROP, qx: 3, qy: 0, qz: 0, qw: 4 }) as { qx: number; qw: number };
    expect(Math.hypot(read.qx, read.qw)).toBeCloseTo(1, 10);
    expect(read.qx).toBeCloseTo(0.6, 10);
  });

  it('refuses a quaternion that cannot be normalised', () => {
    expect(readSceneEvent({ ...DROP, qx: 0, qy: 0, qz: 0, qw: 0 })).toBeNull();
    expect(readSceneEvent({ ...SETTLE, qw: Infinity })).toBeNull();
    expect(readSceneEvent({ ...STICK, qw: 'yes' })).toBeNull();
  });

  it('refuses an item id that is not one', () => {
    for (const item of ['', ':leading', 'a'.repeat(120), 'has space', 'x/../y', 42, null]) {
      expect(readSceneEvent({ ...LOOSE, item }), String(item)).toBeNull();
    }
  });

  it('refuses a stick or a drop with no carrier', () => {
    expect(readSceneEvent({ ...STICK, id: undefined })).toBeNull();
    expect(readSceneEvent({ ...DROP, id: '' })).toBeNull();
  });

  it('takes a stick with NO mesh hints — a creature passenger has a mesh', () => {
    const read = readSceneEvent({
      k: 'stick',
      t: 1,
      id: 'a',
      item: 'creature:bob',
      ox: 0,
      oy: 1,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    expect(read).not.toBeNull();
    expect((read as { kind?: string }).kind).toBeUndefined();
  });

  it('refuses HALF a mesh description', () => {
    // A tree drawn at a bush's scale on a page that never had the placement
    // is worse than a tree that does not appear.
    expect(readSceneEvent({ ...STICK, variant: undefined })).toBeNull();
    expect(readSceneEvent({ ...STICK, scale: undefined })).toBeNull();
    expect(readSceneEvent({ ...STICK, scale: 0 })).toBeNull();
    expect(readSceneEvent({ ...STICK, variant: -1 })).toBeNull();
    expect(readSceneEvent({ ...STICK, variant: 1.5 })).toBeNull();
    expect(readSceneEvent({ ...STICK, kind: 'a'.repeat(40) })).toBeNull();
  });
});

describe('compactScene', () => {
  it('cancels a stick with the drop that followed it', () => {
    // A stone picked up and put down again is a stone on the ground, and a
    // fresh page that replayed both would slide it onto the pile and then
    // take it off — which is visible, because the entrance slides.
    const kept = compactScene([STICK, DROP] as SceneEvent[]);
    expect(kept.map((e) => e.k)).toEqual(['drop']);
  });

  it('cancels ONE stick per drop — carried twice and dropped once is carried', () => {
    const kept = compactScene([STICK, DROP, { ...STICK, t: 9 }] as SceneEvent[]);
    expect(kept.map((e) => e.k)).toEqual(['drop', 'stick']);
  });

  it('does not let one carrier cancel a different carrier stick', () => {
    const kept = compactScene([STICK, { ...DROP, id: 'b' }] as SceneEvent[]);
    expect(kept.map((e) => e.k)).toEqual(['stick', 'drop']);
  });

  it('keeps only the LAST settle per item, and every settle of another', () => {
    const kept = compactScene([
      SETTLE,
      { ...SETTLE, t: 10, x: 9 },
      { ...SETTLE, t: 11, item: 'rock:0:9.00:9.00' },
    ] as SceneEvent[]);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ t: 10, x: 9 });
  });

  it('keeps every loose — each one is a different prop leaving the ground', () => {
    const kept = compactScene([
      LOOSE,
      { ...LOOSE, t: 5, item: 'tree:1:4.00:4.00' },
      { ...LOOSE, t: 6, item: 'bush:0:1.00:1.00' },
    ] as SceneEvent[]);
    expect(kept).toHaveLength(3);
  });

  it('is swallowed by a clear, all four of them', () => {
    const kept = compactScene([
      STICK,
      LOOSE,
      SETTLE,
      { k: 'paint', t: 20, tool: 'clear' },
    ] as SceneEvent[]);
    expect(kept).toHaveLength(0);
  });

  it('leaves the world dials standing through a clear, as it always did', () => {
    const kept = compactScene([
      { k: 'world', t: 1, field: 'landscape', value: 1 },
      STICK,
      { k: 'paint', t: 20, tool: 'clear' },
    ] as SceneEvent[]);
    expect(kept.map((e) => e.k)).toEqual(['world']);
  });

  it('preserves relative order of everything that survives', () => {
    const kept = compactScene([
      { k: 'world', t: 1, field: 'landscape', value: 1 },
      LOOSE,
      STICK,
      SETTLE,
    ] as SceneEvent[]);
    expect(kept.map((e) => e.t)).toEqual([1, 1, 1, 3]);
  });
});

describe('replay', () => {
  function driver(): {
    driver: ReplayDriver;
    seen: string[];
  } {
    const seen: string[] = [];
    return {
      seen,
      driver: {
        spawn: () => true,
        hatch: () => {},
        emote: () => {},
        remove: () => {},
        stick: (e) => seen.push(`stick:${e.id}:${e.item}`),
        drop: (e) => seen.push(`drop:${e.id}:${e.item}`),
        loose: (e) => seen.push(`loose:${e.item}`),
        settle: (e) => seen.push(`settle:${e.item}`),
      },
    };
  }

  function log(events: SessionEvent[]): string {
    return JSON.stringify({
      schema: 'refworld.session',
      version: 3,
      epoch: 'e',
      room: 'xkcd',
      startedAt: '2026-09-15T00:00:00.000Z',
      config: { hatchMs: 1, maxPopulation: 4, wanderSpeed: 1, worldScale: 1 },
      events,
    });
  }

  it('applies a stick only to a carrier that is STANDING', () => {
    const { driver: d, seen } = driver();
    replayNow(
      parseSessionLog(
        log([
          DRAWING as SessionEvent,
          STICK as SessionEvent,
          { ...STICK, id: 'ghost', t: 2 } as SessionEvent,
        ]),
      )!,
      d,
    );
    // `a` hatched; `ghost` never existed, and filing an item against nothing
    // would lose it.
    expect(seen).toEqual(['stick:a:rock:0:1.00:2.00']);
  });

  it('applies a drop only to a carrier that is standing', () => {
    const { driver: d, seen } = driver();
    replayNow(
      parseSessionLog(
        log([
          DRAWING as SessionEvent,
          DROP as SessionEvent,
          { ...DROP, id: 'ghost', t: 5 } as SessionEvent,
        ]),
      )!,
      d,
    );
    expect(seen).toEqual(['drop:a:rock:0:1.00:2.00']);
  });

  it('applies loose and settle with no carrier at all', () => {
    // A tree comes out of the ground on its own account, and which creature
    // hit it is not a thing anybody replays.
    const { driver: d, seen } = driver();
    replayNow(
      parseSessionLog(log([LOOSE as SessionEvent, { ...SETTLE, t: 3 } as SessionEvent]))!,
      d,
    );
    expect(seen).toEqual(['loose:tree:1:-3.00:8.00', 'settle:rock:0:1.00:2.00']);
  });

  it('applies all four on a RESTORE, because a pile is state and not motion', () => {
    // The whole reason they are not skipped the way `drive` is: a restore
    // that dropped them would put the room's stones back on the ground and
    // leave every creature its drawn size, and nobody could tell that from a
    // world where none of it had happened.
    const { driver: d, seen } = driver();
    replayNow(
      parseSessionLog(
        log([
          DRAWING as SessionEvent,
          STICK as SessionEvent,
          DROP as SessionEvent,
          { ...SETTLE, t: 3 } as SessionEvent,
          { ...LOOSE, t: 4 } as SessionEvent,
        ]),
      )!,
      d,
    );
    expect(seen).toHaveLength(4);
  });

  it('passes them through unread on a page with no apply path', () => {
    const bare: ReplayDriver = {
      spawn: () => true,
      hatch: () => {},
      emote: () => {},
      remove: () => {},
    };
    expect(() =>
      replayNow(
        parseSessionLog(
          log([DRAWING as SessionEvent, STICK as SessionEvent]),
        )!,
        bare,
      ),
    ).not.toThrow();
  });
});
