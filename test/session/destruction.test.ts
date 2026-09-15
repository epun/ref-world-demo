/**
 * The two destruction kinds through the session layer (`crack`, `shatter`).
 *
 * Same three things the katamari four are pinned for, because they travel the
 * same path: the DOOR (an untrusted broker cannot hand the world a stage of
 * seven or a monolith the size of the map), the COMPACTION (what a fresh page
 * has to replay to see the same ruins), and the REPLAY (both are state, so a
 * restore applies them).
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_SCHEMA_VERSION,
  parseSessionLog,
  type CrackEvent,
  type SessionEvent,
  type ShatterEvent,
} from '../../src/session/events';
import { createSessionRecorder } from '../../src/session/recorder';
import {
  compactScene,
  isSceneEvent,
  readSceneEvent,
  SCENE_EXTENT,
  type SceneEvent,
} from '../../src/session/scene';
import { applyEvent, createReplayState, type ReplayDriver } from '../../src/session/replay';

const CRACK: CrackEvent = { k: 'crack', t: 10, item: 'building:0:10.00:-4.00', stage: 2 };
const SHATTER: ShatterEvent = {
  k: 'shatter',
  t: 20,
  item: 'monolith:1:-8.00:3.00',
  x: -8,
  z: 3,
  rotY: 0.4,
  scale: 1.3,
  kind: 'monolith',
  variant: 1,
};

function recorder(): ReturnType<typeof createSessionRecorder> {
  let t = 0;
  return createSessionRecorder({
    epoch: 'e',
    room: 'xkcd',
    startedAt: '2026-09-15T00:00:00.000Z',
    config: { hatchMs: 1, maxPopulation: 1, wanderSpeed: 1, worldScale: 1 },
    now: () => (t += 10),
  });
}

describe('the log', () => {
  it('round-trips both kinds at the current schema version', () => {
    const rec = recorder();
    rec.crack({ item: CRACK.item, stage: CRACK.stage });
    const { k: _k, t: _t, ...shatter } = SHATTER;
    rec.shatter(shatter);
    const parsed = parseSessionLog(rec.toJson());
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(SESSION_SCHEMA_VERSION);
    expect(parsed!.events.map((e) => e.k)).toEqual(['crack', 'shatter']);
    const out = parsed!.events[1] as ShatterEvent;
    expect(out.kind).toBe('monolith');
    expect(out.scale).toBeCloseTo(1.3, 3);
  });

  it('refuses a whole file for a crack with no stage in it', () => {
    const log = JSON.stringify({
      schema: 'refworld.session',
      version: SESSION_SCHEMA_VERSION,
      epoch: 'e',
      room: 'xkcd',
      startedAt: '2026-09-15T00:00:00.000Z',
      config: {},
      events: [{ k: 'crack', t: 0, item: 'building:0:1.00:1.00' }],
    });
    expect(parseSessionLog(log)).toBeNull();
  });
});

describe('the scene', () => {
  it('counts both — a building that is rubble on one screen and standing on another is two worlds', () => {
    expect(isSceneEvent(CRACK)).toBe(true);
    expect(isSceneEvent(SHATTER)).toBe(true);
  });

  it('reads a well-formed one of each', () => {
    expect(readSceneEvent({ ...CRACK })).toEqual(CRACK);
    const shatter = readSceneEvent({ ...SHATTER }) as ShatterEvent;
    expect(shatter.item).toBe(SHATTER.item);
    expect(shatter.variant).toBe(1);
    expect(shatter.rotY).toBeCloseTo(0.4, 6);
  });

  it('takes a chunk id — the `#` form a picked-up fragment travels under', () => {
    const stick = readSceneEvent({
      k: 'stick',
      t: 1,
      id: 'drawer',
      item: 'monolith:1:-8.00:3.00#2',
      kind: 'monolith',
      variant: 1,
      scale: 1.3,
      ox: 0,
      oy: 1,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
    expect(stick).not.toBeNull();
    expect((stick as { item: string }).item).toBe('monolith:1:-8.00:3.00#2');
  });

  it('REFUSES a stage that is not one, rather than clamping it', () => {
    // A stage is an enumeration: there is no closest stage to seven, and a
    // building cannot be in stage 0 by announcement.
    for (const stage of [0, 4, -1, 1.5, 'two', undefined]) {
      expect(readSceneEvent({ ...CRACK, stage }), String(stage)).toBeNull();
    }
  });

  it('refuses half a shatter and clamps the place of a whole one', () => {
    for (const missing of ['kind', 'variant', 'scale', 'rotY', 'x', 'z']) {
      const rec: Record<string, unknown> = { ...SHATTER };
      delete rec[missing];
      expect(readSceneEvent(rec), missing).toBeNull();
    }
    const far = readSceneEvent({ ...SHATTER, x: 1e9, z: -1e9 }) as ShatterEvent;
    expect(far.x).toBe(SCENE_EXTENT);
    expect(far.z).toBe(-SCENE_EXTENT);
  });
});

describe('compactScene', () => {
  const at = (event: SceneEvent, t: number): SceneEvent => ({ ...event, t });

  it('keeps only the last crack per item — the event is the state', () => {
    const out = compactScene([
      at({ ...CRACK, stage: 1 }, 1),
      at({ ...CRACK, stage: 2 }, 2),
      at({ ...CRACK, stage: 3 }, 3),
    ]);
    expect(out.length).toBe(1);
    expect((out[0] as CrackEvent).stage).toBe(3);
  });

  it('keeps a crack per item, and does not let one building speak for another', () => {
    const other: CrackEvent = { ...CRACK, item: 'building:0:99.00:0.00', stage: 1 };
    const out = compactScene([at({ ...CRACK, stage: 1 }, 1), at(other, 2)]);
    expect(out.length).toBe(2);
  });

  it('lets a shatter swallow the cracks of its own item', () => {
    const crackOfIt: CrackEvent = { ...CRACK, item: SHATTER.item, stage: 1 };
    const out = compactScene([at(crackOfIt, 1), at({ ...CRACK, stage: 2 }, 2), at(SHATTER, 3)]);
    // The monolith's crack is gone; the building's own crack stands.
    expect(out.map((e) => e.k)).toEqual(['crack', 'shatter']);
    expect((out[0] as CrackEvent).item).toBe(CRACK.item);
  });

  it('keeps every shatter — one per prop that came apart', () => {
    const second: ShatterEvent = { ...SHATTER, item: 'monolith:0:40.00:40.00' };
    expect(compactScene([at(SHATTER, 1), at(second, 2)]).length).toBe(2);
  });

  it('is buried by a clear, like the katamari four', () => {
    const out = compactScene([
      at(CRACK, 1),
      at(SHATTER, 2),
      { k: 'paint', t: 3, tool: 'clear' },
    ]);
    expect(out).toEqual([]);
  });
});

describe('replay', () => {
  function driver(): { seen: string[]; api: ReplayDriver } {
    const seen: string[] = [];
    return {
      seen,
      api: {
        spawn: () => true,
        hatch: () => {},
        emote: () => {},
        remove: () => {},
        crack: (event) => seen.push(`crack:${event.item}:${event.stage}`),
        shatter: (event) => seen.push(`shatter:${event.item}`),
      },
    };
  }

  it('applies both with no carrier alive — a building is the world’s, not a creature’s', () => {
    const d = driver();
    const state = createReplayState();
    applyEvent(CRACK as SessionEvent, d.api, state);
    applyEvent(SHATTER as SessionEvent, d.api, state);
    expect(d.seen).toEqual([`crack:${CRACK.item}:2`, `shatter:${SHATTER.item}`]);
  });

  it('applies both on a RESTORE, because a ruin is state and not motion', () => {
    const d = driver();
    const state = createReplayState();
    applyEvent(CRACK as SessionEvent, d.api, state, { instant: true });
    applyEvent(SHATTER as SessionEvent, d.api, state, { instant: true });
    expect(d.seen.length).toBe(2);
  });

  it('passes them through unread on a page with no apply path', () => {
    const state = createReplayState();
    const bare: ReplayDriver = {
      spawn: () => true,
      hatch: () => {},
      emote: () => {},
      remove: () => {},
    };
    expect(() => {
      applyEvent(CRACK as SessionEvent, bare, state);
      applyEvent(SHATTER as SessionEvent, bare, state);
    }).not.toThrow();
  });
});
