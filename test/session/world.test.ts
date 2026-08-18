/**
 * The recorder against the REAL creature manager (headless Three.js, the same
 * stub world test/creatures/manager.test.ts runs on).
 *
 * This is the claim the whole design rests on: because generation is pure in
 * (strokes, id) and placement is deterministic in the spawn order, a log of
 * inputs and decisions is enough to rebuild the session. So the test records
 * one world, replays the log into a SECOND, empty world, and compares what
 * actually stands in each — ids, egg spots, and body radii after hatch.
 *
 * It also pins the cost claim: a thousand frames of live simulation must add
 * exactly zero events.
 */

import { Scene, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCreatureManager, type CreatureManager } from '../../src/creatures/manager';
import { createIngestGate } from '../../src/moderation/gate';
import {
  createSessionRecorder,
  parseSessionLog,
  recordCreatures,
  recordGate,
  replayNow,
  type ReplayDriver,
  type SessionRecorder,
} from '../../src/session';
import type { StrokeList } from '../../src/shape/types';
import type { WorldHandles } from '../../src/world/scene';
import { circleBlob, fish, quadruped, snowman } from '../fixtures/strokes';

// createEgg paints its shell through a 2d canvas; off-DOM every paint is a
// guarded no-op, but createElement itself must exist.
beforeAll(() => {
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    };
  }
});

function stubWorld(): WorldHandles {
  return {
    scene: new Scene(),
    cameraRig: { frameAt: (_p: Vector3) => {} },
    shadows: {
      addShadow: () => ({ setPosition: () => {} }),
      removeShadow: () => {},
    },
    scatter: {
      colliders: () => [],
      collidersVersion: () => 1,
      positions: () => [],
      nudge: () => {},
    },
  } as unknown as WorldHandles;
}

interface WorldDrawing {
  id: string;
  name: string | null;
  personality: 'friends' | 'snacks' | 'sleep' | 'adventure' | 'chaos' | null;
  strokes: StrokeList;
  hatchMs: number;
  source: 'phone' | 'local' | 'dev';
}

const HATCH_MS = 20000;

/** A recorded world: real manager, real gate, recorder on both seams. */
function recordedWorld(): {
  creatures: CreatureManager;
  gate: ReturnType<typeof createIngestGate<WorldDrawing>>;
  recorder: SessionRecorder;
  clock: { advance(ms: number): void; nowMs(): number };
  frames(count: number, dt?: number): void;
} {
  let clock = 0;
  let frameNow = 0;
  const recorder = createSessionRecorder({
    epoch: 'wtest',
    room: 'abcd',
    startedAt: '2026-08-18T00:00:00.000Z',
    config: { hatchMs: HATCH_MS },
    now: () => clock,
  });
  const creatures = createCreatureManager(stubWorld(), {
    observer: recordCreatures(recorder),
  });
  const gate = createIngestGate<WorldDrawing>({
    observer: recordGate(recorder, { hatchMs: HATCH_MS, source: 'phone' }),
    spawn: (d) =>
      creatures.spawn(d.id, d.strokes, {
        ...(d.name !== null ? { name: d.name } : {}),
        ...(d.personality !== null ? { personality: d.personality } : {}),
        hatchMs: d.hatchMs,
      }),
    clear: (id) => creatures.clear(id),
    live: (id) => creatures.has(id),
  });
  return {
    creatures,
    gate,
    recorder,
    clock: {
      advance: (ms) => {
        clock += ms;
      },
      nowMs: () => clock,
    },
    // dt is in MILLISECONDS (src/world/scene.ts drives the manager that
    // way). The manager stamps its own hatch deadlines off performance.now,
    // so the frame clock starts there; the recorder's clock is separate and
    // stays an offset counter.
    frames(count: number, dtMs = 16.7): void {
      if (frameNow === 0) frameNow = performance.now();
      for (let i = 0; i < count; i++) {
        clock += dtMs;
        frameNow += dtMs;
        creatures.update(dtMs, frameNow);
      }
    },
  };
}

/** The replay side: an empty world driven only by the log. */
function replayDriverFor(creatures: CreatureManager): ReplayDriver {
  return {
    spawn: (s) =>
      creatures.spawn(s.id, s.strokes, {
        ...(s.name !== null ? { name: s.name } : {}),
        ...(s.personality !== null
          ? { personality: s.personality as 'friends' | 'chaos' | 'sleep' }
          : {}),
        hatchMs: s.hatchMs,
      }),
    hatch: (id) => creatures.hatch(id),
    emote: (id, e) => {
      creatures.emote(id, e as 'happy', 'phone');
    },
    remove: (id) => creatures.clear(id),
  };
}

function offer(world: ReturnType<typeof recordedWorld>, id: string, strokes: StrokeList): void {
  world.gate.offer({
    id,
    name: id,
    personality: null,
    strokes,
    hatchMs: HATCH_MS,
    source: 'phone',
  });
}

/**
 * What is standing, in a form two worlds can be compared on. Deliberately NOT
 * live x/z: an egg's ambient drift and a character's roaming are functions of
 * the world clock, and the point of the log is that it does not need to
 * record those. What must match is WHO is there and WHAT they are — the id,
 * the phase, and the radius the generator produced from their drawing.
 */
function census(creatures: CreatureManager): { count: number; shapes: string[] } {
  return {
    count: creatures.count(),
    shapes: creatures
      .positions()
      .map((p) => `${p.kind} ${p.r.toFixed(4)}`)
      .sort(),
  };
}

/** The deterministic spawn spots the log recorded, in arrival order. */
function eggSpots(log: { events: { k: string }[] }): string[] {
  return log.events
    .filter((e): e is { k: 'egg'; x: number; z: number } => e.k === 'egg')
    .map((e) => `${e.x.toFixed(4)} ${e.z.toFixed(4)}`);
}

/** Drive frames on a bare manager, from the real clock the manager stamps
 * its hatch deadlines against. */
function run(creatures: CreatureManager, count: number, dtMs = 16.7): void {
  let now = performance.now();
  for (let i = 0; i < count; i++) {
    now += dtMs;
    creatures.update(dtMs, now);
  }
}

describe('session recorder against the live world', () => {
  it('records the lifecycle: drawing, egg, hatch cause, emote, removal', () => {
    const w = recordedWorld();
    offer(w, 'd-1', circleBlob);
    w.clock.advance(500);
    offer(w, 'd-2', snowman);
    w.frames(30);
    w.creatures.hatchAll();
    w.frames(120);
    const emoted = w.creatures.emote('d-1', 'happy', 'phone');
    w.clock.advance(300);
    w.gate.remove('d-2');

    const log = parseSessionLog(w.recorder.toJson())!;
    const kinds = log.events.map((e) => `${e.k}:${'id' in e ? e.id : e.k}`);
    expect(kinds).toContain('drawing:d-1');
    expect(kinds).toContain('egg:d-1');
    expect(emoted).toBe(true);

    const hatches = log.events.filter((e) => e.k === 'hatch');
    expect(hatches).toHaveLength(2);
    for (const h of hatches) expect(h.k === 'hatch' && h.cause).toBe('forced');

    const emotes = log.events.filter((e) => e.k === 'emote');
    expect(emotes).toHaveLength(1);
    expect(emotes[0]?.k === 'emote' && emotes[0].source).toBe('phone');

    // The removal shows up twice on purpose: the operator's tap, and the
    // creature leaving. Replay honours either.
    expect(log.events.some((e) => e.k === 'operator' && e.action === 'remove')).toBe(true);
    expect(log.events.some((e) => e.k === 'retire' && e.cause === 'operator')).toBe(true);
  });

  it('records the timer hatch as a timer hatch, not a forced one', () => {
    const w = recordedWorld();
    w.gate.offer({
      id: 'timed',
      name: null,
      personality: null,
      strokes: circleBlob,
      hatchMs: 200,
      source: 'phone',
    });
    w.frames(60); // 1s of frames — past the 200ms timer
    const log = parseSessionLog(w.recorder.toJson())!;
    const hatch = log.events.find((e) => e.k === 'hatch');
    expect(hatch?.k === 'hatch' && hatch.cause).toBe('timer');
  });

  it('adds nothing per frame: a thousand simulated frames leave the log untouched', () => {
    const w = recordedWorld();
    offer(w, 'a', circleBlob);
    offer(w, 'b', fish);
    w.creatures.hatchAll();
    w.frames(200); // hatch bursts land here
    const settled = w.recorder.count();
    w.frames(1000); // pure autonomous simulation — no discrete events
    expect(w.recorder.count()).toBe(settled);
  });
});

describe('replay against the live world', () => {
  it('rebuilds the same creatures, on the same deterministic spawn spots', () => {
    const w = recordedWorld();
    offer(w, 'd-1', circleBlob);
    w.clock.advance(400);
    offer(w, 'd-2', snowman);
    w.clock.advance(400);
    offer(w, 'd-3', quadruped);
    w.frames(60);
    const recordedCensus = census(w.creatures);
    expect(['d-1', 'd-2', 'd-3'].filter((id) => w.creatures.has(id))).toEqual([
      'd-1',
      'd-2',
      'd-3',
    ]);

    const log = parseSessionLog(w.recorder.toJson())!;

    // A brand new world, driven only by the log — and recording itself, so
    // the two runs can be compared log to log.
    const replayRecorder = createSessionRecorder({
      epoch: 'wreplay',
      room: 'abcd',
      startedAt: '2026-08-18T01:00:00.000Z',
      config: { hatchMs: HATCH_MS },
      now: () => 0,
    });
    const fresh = createCreatureManager(stubWorld(), {
      observer: recordCreatures(replayRecorder),
    });
    replayNow(log, replayDriverFor(fresh));
    run(fresh, 60);

    expect(['d-1', 'd-2', 'd-3'].filter((id) => fresh.has(id))).toEqual(['d-1', 'd-2', 'd-3']);
    expect(census(fresh)).toEqual(recordedCensus);
    // The spawn spiral is deterministic in the arrival order, so the eggs
    // land in exactly the same places without the log carrying a position.
    expect(eggSpots(replayRecorder.snapshot())).toEqual(eggSpots(log));
  });

  it('reaches the same hatched population, with the same generated radii', () => {
    const w = recordedWorld();
    offer(w, 'd-1', circleBlob);
    offer(w, 'd-2', fish);
    w.frames(20);
    w.creatures.hatchAll();
    w.frames(400);
    const recordedCensus = census(w.creatures);
    expect(recordedCensus.shapes.every((s) => s.startsWith('character'))).toBe(true);
    // Two different drawings, two different bodies — not one shared constant.
    expect(new Set(recordedCensus.shapes).size).toBe(2);

    const log = parseSessionLog(w.recorder.toJson())!;
    const fresh = createCreatureManager(stubWorld());
    replayNow(log, replayDriverFor(fresh));
    run(fresh, 420);
    expect(census(fresh)).toEqual(recordedCensus);
  });

  it('a creature the operator removed does not come back', () => {
    const w = recordedWorld();
    offer(w, 'keep', circleBlob);
    offer(w, 'gone', snowman);
    w.frames(30);
    w.gate.remove('gone');
    w.frames(30);
    expect(w.creatures.has('gone')).toBe(false);

    const log = parseSessionLog(w.recorder.toJson())!;
    const fresh = createCreatureManager(stubWorld());
    replayNow(log, replayDriverFor(fresh));
    expect(fresh.has('keep')).toBe(true);
    expect(fresh.has('gone')).toBe(false);
    expect(fresh.count()).toBe(1);
  });
});
