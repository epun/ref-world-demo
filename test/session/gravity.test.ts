/**
 * ZERO GRAVITY TRAVELS AS A SCENE EVENT — and only lands where there is a game.
 *
 * > User ask, 2026-09-17: *"i want a zero gravity mode where i can hit g on
 * > the keyboard and it turns off gravity for the map. characters should float
 * > in space."*
 *
 * The invariant it has to obey (CLAUDE.md, docs/PLAN.md §7.6): a scene change
 * travels as a session event over the sync topic and into
 * `refworld:<world>:scene`, and applies through the replay driver, never a
 * second path. So it is a `world` event with `field: 'gravity'` — the shape a
 * landscape switch has, which is what gives it the retention and the restore
 * for free — carrying its own optional driver method, installed on a katamari
 * world and nowhere else, exactly like `stick`/`drop`/`loose`.
 *
 * What is NOT here: any height. Poses carry x/z/heading and every page derives
 * its own float from this one bit (src/creatures/gravity.ts).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCENE_WORLD_FIELDS,
  compactScene,
  isSceneEvent,
  readSceneEvent,
  type SceneEvent,
} from '../../src/session/scene';
import {
  applyEvent,
  createReplayState,
  createSessionRecorder,
  replayNow,
  type ReplayDriver,
  type SessionEvent,
  type SessionLog,
} from '../../src/session';

const SRC = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

/** A driver that records which of its methods were reached. */
function spy(): {
  driver: ReplayDriver;
  gravity: boolean[];
  world: { field: string; value: unknown }[];
} {
  const gravity: boolean[] = [];
  const world: { field: string; value: unknown }[] = [];
  return {
    gravity,
    world,
    driver: {
      spawn: () => true,
      hatch: () => {},
      emote: () => {},
      remove: () => {},
      world: (field, value) => world.push({ field, value }),
      gravity: (on) => gravity.push(on),
    },
  };
}

/** …and the same driver with no `gravity` at all: every world but the
 * katamari (src/main.ts installs it with the other six). */
function plainDriver(): {
  driver: ReplayDriver;
  world: { field: string; value: unknown }[];
} {
  const world: { field: string; value: unknown }[] = [];
  return {
    world,
    driver: {
      spawn: () => true,
      hatch: () => {},
      emote: () => {},
      remove: () => {},
      world: (field, value) => world.push({ field, value }),
    },
  };
}

const gravityEvent = (value: 0 | 1, t = 0): SceneEvent => ({
  k: 'world',
  t,
  field: 'gravity',
  value,
});

describe('the gravity bit is a scene event', () => {
  it('is one of the fields the whole room has to agree on', () => {
    expect(SCENE_WORLD_FIELDS).toContain('gravity');
    expect(isSceneEvent(gravityEvent(0) as SessionEvent)).toBe(true);
  });

  it('reads 1/0 and a boolean, and refuses anything else', () => {
    expect(readSceneEvent({ k: 'world', t: 0, field: 'gravity', value: 0 })).toEqual(
      gravityEvent(0),
    );
    expect(readSceneEvent({ k: 'world', t: 5, field: 'gravity', value: 1 })).toEqual(
      gravityEvent(1, 5),
    );
    // A hand-written log reads the way it looks — the same rule `landscape`
    // follows.
    expect(readSceneEvent({ k: 'world', t: 0, field: 'gravity', value: false })).toEqual(
      gravityEvent(0),
    );
    expect(readSceneEvent({ k: 'world', t: 0, field: 'gravity', value: true })).toEqual(
      gravityEvent(1),
    );
    // …and it is a switch, not a dial: there is no "0.5 gravity" to guess at,
    // and a public broker cannot hand the world one.
    for (const value of [0.5, 2, -1, 'off', null, undefined, {}]) {
      expect(readSceneEvent({ k: 'world', t: 0, field: 'gravity', value })).toBeNull();
    }
  });

  it('keeps only its last value, so a late phone comes up weightless', () => {
    // Retention and restore, which is the reason it is shaped as a dial:
    // `compactScene` is what the store keeps and what a fresh page applies.
    const log: SceneEvent[] = [
      gravityEvent(0, 10),
      gravityEvent(1, 20),
      gravityEvent(0, 30),
      { k: 'world', t: 40, field: 'landscape', value: 1 },
    ];
    const compact = compactScene(log);
    const gravity = compact.filter((e) => e.k === 'world' && e.field === 'gravity');
    expect(gravity).toHaveLength(1);
    expect(gravity[0]).toEqual(gravityEvent(0, 30));
    // The landscape switch is still there — one field cannot compact another.
    expect(compact).toHaveLength(2);
  });

  it('reaches the room through the recorder’s one scene tap', () => {
    const seen: SessionEvent[] = [];
    let clock = 0;
    const rec = createSessionRecorder({
      epoch: 'w-test',
      room: 'abcd',
      startedAt: '2026-09-17T00:00:00.000Z',
      config: {},
      now: () => (clock += 1000),
      onEvent: (event) => seen.push(event),
    });
    // ONE PRESS, ONE EVENT (src/main.ts's `g`).
    rec.world('gravity', 0);
    expect(rec.count()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ k: 'world', t: 1000, field: 'gravity', value: 0 });
    expect(isSceneEvent(seen[0]!)).toBe(true);
    // And the press back again is its own event.
    rec.world('gravity', 1);
    expect(rec.count()).toBe(2);
    expect(seen).toHaveLength(2);
    expect((seen[1] as { value: number }).value).toBe(1);
  });
});

describe('the driver installs it only where there is a game', () => {
  it('routes the bit to its own method, not to the world handler', () => {
    const { driver, gravity, world } = spy();
    const state = createReplayState();
    applyEvent(gravityEvent(0) as SessionEvent, driver, state);
    applyEvent(gravityEvent(1) as SessionEvent, driver, state);
    expect(gravity).toEqual([false, true]);
    // `world` must not see it: a handler that had to know about gravity would
    // be the second apply path this layer exists to prevent.
    expect(world).toHaveLength(0);
  });

  it('does nothing at all on a world that installs no handler', () => {
    const { driver, world } = plainDriver();
    const state = createReplayState();
    // meridian and the public world: the bit arrives off the shared topic or
    // out of a restored log and is simply not a kind this page drives.
    expect(() => applyEvent(gravityEvent(0) as SessionEvent, driver, state)).not.toThrow();
    expect(world).toHaveLength(0);
    // …while the fields that world DOES drive still arrive.
    applyEvent(
      { k: 'world', t: 0, field: 'landscape', value: 1 } as SessionEvent,
      driver,
      state,
    );
    expect(world).toEqual([{ field: 'landscape', value: 1 }]);
  });

  it('is applied by a RESTORE too — it is state, not motion', () => {
    const { driver, gravity } = spy();
    const log: SessionLog = {
      header: {
        schema: 'refworld-session',
        version: 1,
        epoch: 'w-test',
        room: 'abcd',
        startedAt: '2026-09-17T00:00:00.000Z',
        config: {},
      },
      events: [gravityEvent(0, 10) as SessionEvent],
    } as unknown as SessionLog;
    replayNow(log, driver);
    // A refreshed projection healing itself comes back weightless, the same
    // way it comes back with its piles on.
    expect(gravity).toEqual([false]);
  });
});

describe('the key that emits it', () => {
  /*
   * The handler itself lives in src/main.ts, which is a browser module with a
   * world in it — so what is pinned here is its CONTRACT, the same way
   * test/net/two-page-room.test.ts pins the three lines it mirrors.
   */
  const main = (): string => SRC('src/main.ts');

  it('is plain `g`, katamari-gated, and emits exactly one event', () => {
    const src = main();
    const handler = src.slice(src.indexOf("if (event.key === 'g'"));
    expect(handler.startsWith("if (event.key === 'g' && !overlayOpen")).toBe(true);
    // The whole toggle is inside the game's gate…
    const block = handler.slice(0, handler.indexOf('// Camera tour toggle'));
    expect(block).toContain('if (katamari)');
    // …it reads the state back off the manager rather than keeping a second
    // copy that a bit off the wire could disagree with…
    expect(block).toContain('!creatures.gravity()');
    // …it applies through the one driver…
    expect(block).toContain('replayDriver.gravity?.(next)');
    // …and it records (which is what sends it) exactly once.
    expect(block.match(/session\.world\('gravity'/g)).toHaveLength(1);
    // One press is one event: nothing in the block loops or repeats.
    expect(block).not.toContain('for (');
    expect(block).not.toContain('setInterval');
  });

  it('is NOT dev-gated — it is a demo control, like h and shift+R', () => {
    const src = main();
    const block = src.slice(
      src.indexOf("if (event.key === 'g'"),
      src.indexOf('// Camera tour toggle'),
    );
    expect(block).not.toContain('isDev');
  });

  it('never fires while somebody is typing', () => {
    const src = main();
    expect(src).toContain('const isTypingInto =');
    const block = src.slice(
      src.indexOf("if (event.key === 'g'"),
      src.indexOf('// Camera tour toggle'),
    );
    expect(block).toContain('!isTypingInto(event.target)');
  });
});
