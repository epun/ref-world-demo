/**
 * The scene layer's pure half (src/session/scene.ts, docs/SESSION.md §6).
 *
 * Three claims live here and nowhere else:
 *
 *   1. WHICH events are the scene. A drawing is not; a dab is. Get this wrong
 *      and either the room stops sharing its ground or every phone starts
 *      broadcasting its whole population at everybody else.
 *   2. The DOOR clamps. These arrive over a public broker and out of a
 *      database, so a batch has to be unable to hand the world a brush the
 *      size of the map — the same rule `readWorldSyncMessage` keeps for a
 *      drive, and the reason it is pinned rather than assumed.
 *   3. COMPACTION cannot change what a fresh page ends up looking at. It is
 *      what keeps a world that has been painted every day from becoming a
 *      megabyte on arrival, and it is only allowed to drop what is already
 *      unobservable.
 *
 * Plus the recorder's `onEvent`, which is the seam all of it hangs on.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SCENE_BATCH,
  SCENE_MAX_PATCH_TEXELS,
  SCENE_MAX_TEXEL,
  MAX_SCENE_EVENTS,
  SCENE_EXTENT,
  SCENE_MAX_RADIUS,
  SCENE_TERRAIN_LIMITS,
  SCENE_WORLD_FIELDS,
  compactScene,
  isSceneEvent,
  readSceneBatch,
  readSceneEvent,
  type SceneEvent,
} from '../../src/session/scene';
import { createSessionRecorder, type SessionEvent } from '../../src/session';
import { TERRAIN_LIMITS } from '../../src/world/landscape';
import { decodeFloats, encodeFloats, PAINTED_SIZE } from '../../src/world/painted';

const dab = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  k: 'paint',
  t: 10,
  tool: 'raise',
  x: 4,
  z: -6,
  r: 12,
  strength: 0.4,
  seed: 0.25,
  ...over,
});

describe('the copies of the world constants', () => {
  it('the mirrored terrain limits are the real ones', () => {
    // src/session/ may only import pure siblings (purity.test.ts), so the
    // dials' ranges are copied into the scene module. A copy that drifted
    // would clamp a legitimate dial or let an illegitimate one through, and
    // nothing else in the build would notice.
    expect(SCENE_TERRAIN_LIMITS).toEqual(TERRAIN_LIMITS);
  });

  it('the mirrored map extent is the real one', () => {
    expect(SCENE_EXTENT).toBe(PAINTED_SIZE);
  });
});

describe('which events are the scene', () => {
  it('the ground dials and the brush are', () => {
    expect(isSceneEvent({ k: 'world', t: 0, field: 'landscape', value: 1 })).toBe(true);
    expect(
      isSceneEvent({ k: 'world', t: 0, field: 'terrain', value: 1.2, kind: 'elevation' }),
    ).toBe(true);
    expect(isSceneEvent({ k: 'paint', t: 0, tool: 'raise', x: 0, z: 0, r: 4 })).toBe(true);
    expect(isSceneEvent({ k: 'paint', t: 0, tool: 'clear' })).toBe(true);
  });

  it('the look and the cast are not', () => {
    // Weather and paper are look: cheap to set per page, and a room where one
    // phone re-tints everybody else's is a worse room.
    expect(isSceneEvent({ k: 'world', t: 0, field: 'weather', value: 'fog' })).toBe(false);
    expect(isSceneEvent({ k: 'world', t: 0, field: 'grain', value: 0.3 })).toBe(false);
    expect(isSceneEvent({ k: 'hatch', t: 0, id: 'a', cause: 'timer' })).toBe(false);
    expect(isSceneEvent({ k: 'drive', t: 0, id: 'a', mag: 0 })).toBe(false);
  });

  it('the field list is the two that shape the ground', () => {
    expect([...SCENE_WORLD_FIELDS]).toEqual(['landscape', 'terrain']);
  });
});

describe('the door', () => {
  it('reads a landscape switch as 1 or 0, however it was written', () => {
    expect(readSceneEvent({ k: 'world', t: 1, field: 'landscape', value: true })).toEqual({
      k: 'world',
      t: 1,
      field: 'landscape',
      value: 1,
    });
    expect(readSceneEvent({ k: 'world', t: 1, field: 'landscape', value: 0 })?.k).toBe('world');
  });

  it('lets a waterfall mark through with its seed and its facing', () => {
    // 2026-09-10, user ask: the waterfall tool. The mark's facing is recorded
    // because the ground it was read off may have been sculpted by the time a
    // log replays; the door WRAPS it rather than clamping, because a clamp
    // would turn a wound-up angle into a direction nobody meant.
    const event = readSceneEvent({
      k: 'paint',
      t: 3,
      tool: 'waterfall',
      x: 10,
      z: -20,
      r: 3,
      seed: 41,
      yaw: Math.PI * 2 + 0.5,
    });
    expect(event).toMatchObject({ k: 'paint', tool: 'waterfall', x: 10, z: -20, seed: 41 });
    expect((event as { yaw?: number }).yaw).toBeCloseTo(0.5, 6);
    // Not a number is not an angle.
    expect(readSceneEvent({ k: 'paint', t: 3, tool: 'waterfall', x: 0, z: 0, r: 1, yaw: 'down' }))
      .toBeNull();
    // …and a mark stamped before the field existed still reads, facing
    // whatever the receiving page's gradient says.
    expect(
      readSceneEvent({ k: 'paint', t: 3, tool: 'waterfall', x: 0, z: 0, r: 1 }),
    ).not.toBeNull();
  });

  it('lets a river dab through carrying the plane it filled to', () => {
    const event = readSceneEvent({ k: 'paint', t: 4, tool: 'river', x: 1, z: 2, r: 3, level: -1.5 });
    expect(event).toMatchObject({ k: 'paint', tool: 'river', level: -1.5 });
  });

  it('refuses a landscape switch that is not an answer to a switch', () => {
    expect(readSceneEvent({ k: 'world', t: 1, field: 'landscape', value: 'on' })).toBeNull();
    expect(readSceneEvent({ k: 'world', t: 1, field: 'landscape', value: 7 })).toBeNull();
    expect(readSceneEvent({ k: 'world', t: 1, field: 'landscape', value: null })).toBeNull();
  });

  it('clamps a terrain dial to its own range', () => {
    const high = readSceneEvent({
      k: 'world',
      t: 2,
      field: 'terrain',
      value: 999,
      kind: 'elevation',
    });
    expect(high).toEqual({
      k: 'world',
      t: 2,
      field: 'terrain',
      value: SCENE_TERRAIN_LIMITS['elevation']![1],
      kind: 'elevation',
    });
    const low = readSceneEvent({
      k: 'world',
      t: 2,
      field: 'terrain',
      value: -50,
      kind: 'relief',
    });
    expect((low as { value: number }).value).toBe(SCENE_TERRAIN_LIMITS['relief']![0]);
  });

  it('refuses a dial with no name, an unknown name, or no number', () => {
    expect(readSceneEvent({ k: 'world', t: 2, field: 'terrain', value: 1 })).toBeNull();
    expect(
      readSceneEvent({ k: 'world', t: 2, field: 'terrain', value: 1, kind: 'wobble' }),
    ).toBeNull();
    expect(
      readSceneEvent({ k: 'world', t: 2, field: 'terrain', value: 'a lot', kind: 'relief' }),
    ).toBeNull();
    expect(
      readSceneEvent({ k: 'world', t: 2, field: 'terrain', value: NaN, kind: 'relief' }),
    ).toBeNull();
  });

  it('carries a pond dab\'s plane, clamped like a height', () => {
    const pond = readSceneEvent(dab({ tool: 'pond', level: 3.5 })) as { level?: number };
    expect(pond.level).toBe(3.5);
    const deep = readSceneEvent(dab({ tool: 'pond', level: -1e9 })) as { level?: number };
    expect(deep.level).toBe(-1000);
    expect(readSceneEvent(dab({ tool: 'pond', level: 'wet' }))).toBeNull();
  });

  it('refuses a world field that is not the ground', () => {
    expect(readSceneEvent({ k: 'world', t: 0, field: 'weather', value: 'rain' })).toBeNull();
  });

  it('reads a dab, and clamps its place and its size', () => {
    expect(readSceneEvent(dab())).toEqual({
      k: 'paint',
      t: 10,
      tool: 'raise',
      x: 4,
      z: -6,
      r: 12,
      strength: 0.4,
      seed: 0.25,
    });
    const wild = readSceneEvent(dab({ x: 1e9, z: -1e9, r: 1e6 })) as {
      x: number;
      z: number;
      r: number;
    };
    expect(wild.x).toBe(SCENE_EXTENT);
    expect(wild.z).toBe(-SCENE_EXTENT);
    expect(wild.r).toBe(SCENE_MAX_RADIUS);
  });

  it('a clear carries no geometry and needs none', () => {
    expect(readSceneEvent({ k: 'paint', t: 3, tool: 'clear' })).toEqual({
      k: 'paint',
      t: 3,
      tool: 'clear',
    });
  });

  it('refuses a dab with no place, no size, or a size of nothing', () => {
    expect(readSceneEvent(dab({ x: undefined }))).toBeNull();
    expect(readSceneEvent(dab({ r: undefined }))).toBeNull();
    expect(readSceneEvent(dab({ r: 0 }))).toBeNull();
    expect(readSceneEvent(dab({ r: -3 }))).toBeNull();
    expect(readSceneEvent(dab({ z: 'over there' }))).toBeNull();
  });

  it('refuses labels that are not labels', () => {
    expect(readSceneEvent(dab({ tool: '' }))).toBeNull();
    expect(readSceneEvent(dab({ tool: 'r'.repeat(64) }))).toBeNull();
    expect(readSceneEvent(dab({ mode: 'm'.repeat(64) }))).toBeNull();
    expect(readSceneEvent(dab({ tool: 4 }))).toBeNull();
  });

  it('clamps a dab amount rather than trusting it', () => {
    const huge = readSceneEvent(dab({ strength: 1e6, hardness: 42 })) as {
      strength: number;
      hardness: number;
    };
    expect(huge.strength).toBeLessThanOrEqual(8);
    expect(huge.hardness).toBe(1);
  });

  it('an absent offset is the start of the session, a negative one is junk', () => {
    expect(readSceneEvent({ k: 'paint', t: undefined, tool: 'clear' })?.t).toBe(0);
    expect(readSceneEvent({ k: 'paint', t: -1, tool: 'clear' })).toBeNull();
    expect(readSceneEvent({ k: 'paint', t: Infinity, tool: 'clear' })).toBeNull();
  });

  it('refuses anything that is not an event at all', () => {
    expect(readSceneEvent(null)).toBeNull();
    expect(readSceneEvent('paint')).toBeNull();
    expect(readSceneEvent([])).toBeNull();
    expect(readSceneEvent({ k: 'drawing', t: 0, id: 'a', strokes: [] })).toBeNull();
  });

  it('a batch drops what will not read and keeps what will', () => {
    // Dropping rather than refusing the batch: this is a live world's ground
    // arriving in pieces, and one dent must not cost a phone the landscape.
    const batch = readSceneBatch([dab(), { k: 'paint', t: 0 }, dab({ tool: 'lower' })]);
    expect(batch).toHaveLength(2);
    expect(batch.map((e) => (e as { tool: string }).tool)).toEqual(['raise', 'lower']);
    expect(readSceneBatch('not a list')).toEqual([]);
  });

  it('a batch is capped', () => {
    const many = Array.from({ length: MAX_SCENE_BATCH + 40 }, () => dab());
    expect(readSceneBatch(many)).toHaveLength(MAX_SCENE_BATCH);
    // …and the cap is a wire cap, not a world cap: the store may hold far more.
    expect(readSceneBatch(many, MAX_SCENE_EVENTS)).toHaveLength(many.length);
  });
});

describe('compaction', () => {
  const world = (field: string, value: number, kind?: string): SceneEvent =>
    ({ k: 'world', t: 0, field, value, ...(kind === undefined ? {} : { kind }) }) as SceneEvent;
  const stamp = (tool: string): SceneEvent =>
    ({ k: 'paint', t: 0, tool, x: 0, z: 0, r: 4 }) as SceneEvent;

  it('a dial keeps only its last value', () => {
    const out = compactScene([
      world('terrain', 0.5, 'elevation'),
      world('terrain', 0.9, 'elevation'),
      world('terrain', 1.4, 'elevation'),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as { value: number }).value).toBe(1.4);
  });

  it('each dial is its own knob', () => {
    const out = compactScene([
      world('landscape', 1),
      world('terrain', 1, 'elevation'),
      world('terrain', 2, 'tierStep'),
      world('landscape', 0),
    ]);
    expect(out).toHaveLength(3);
    expect((out[out.length - 1] as { field: string; value: number }).value).toBe(0);
  });

  it('a clear swallows every dab before it, and itself', () => {
    const out = compactScene([
      stamp('raise'),
      stamp('raise'),
      stamp('clear'),
      stamp('lower'),
    ]);
    // A page that never stamped anything has nothing to clear, so the clear
    // goes with the dabs it threw away.
    expect(out).toEqual([stamp('lower')]);
  });

  it('a clear does not touch the dials', () => {
    const out = compactScene([world('landscape', 1), stamp('raise'), stamp('clear')]);
    expect(out).toEqual([world('landscape', 1)]);
  });

  it('what survives keeps its order', () => {
    // A flatten depends on the ground it is flattening, and a landscape
    // switch decides what a dab is landing on.
    const events = [
      stamp('raise'),
      world('landscape', 1),
      stamp('flatten'),
      world('terrain', 1, 'relief'),
      stamp('smooth'),
    ];
    expect(compactScene(events)).toEqual(events);
  });

  it('nothing compacts to nothing', () => {
    expect(compactScene([])).toEqual([]);
  });
});

describe('the recorder tells its observer', () => {
  const recorderWith = (seen: SessionEvent[]) => {
    let clock = 0;
    return createSessionRecorder({
      epoch: 'w-test',
      room: 'abcd',
      startedAt: '2026-09-09T00:00:00.000Z',
      config: {},
      now: () => (clock += 1000),
      onEvent: (event) => seen.push(event),
    });
  };

  it('every appended event reaches it', () => {
    const seen: SessionEvent[] = [];
    const rec = recorderWith(seen);
    rec.paint({ tool: 'raise', x: 1, z: 2, r: 3 });
    rec.emote('a', 'wave', 'panel');
    rec.world('landscape', 1);
    expect(seen.map((e) => e.k)).toEqual(['paint', 'emote', 'world']);
    expect(seen.length).toBe(rec.count());
  });

  it('a coalesced drag reports the rewritten event, not a second one', () => {
    const seen: SessionEvent[] = [];
    let clock = 0;
    const rec = createSessionRecorder({
      epoch: 'w-test',
      room: 'abcd',
      startedAt: '2026-09-09T00:00:00.000Z',
      config: {},
      // Inside the coalesce window, so the second write rewrites the first.
      now: () => (clock += 10),
      onEvent: (event) => seen.push(event),
    });
    rec.world('terrain', 0.4, 'elevation');
    rec.world('terrain', 0.8, 'elevation');
    expect(rec.count()).toBe(1);
    expect(seen).toHaveLength(2);
    // Both notifications describe the one event that is actually in the log —
    // the scene layer downstream must broadcast where the hand ended up.
    expect((seen[1] as { value: number }).value).toBe(0.8);
    expect(seen[1]).toBe(rec.events()[0]);
  });

  it('an event the limit refused is not announced', () => {
    const seen: SessionEvent[] = [];
    let clock = 0;
    const rec = createSessionRecorder({
      epoch: 'w-test',
      room: 'abcd',
      startedAt: '2026-09-09T00:00:00.000Z',
      config: {},
      now: () => (clock += 1000),
      limit: 2,
      onEvent: (event) => seen.push(event),
    });
    rec.paint({ tool: 'raise' });
    rec.paint({ tool: 'raise' });
    rec.paint({ tool: 'raise' });
    expect(rec.overflowed()).toBe(true);
    // An event that is not in the log did not happen, and must not be shared.
    expect(seen).toHaveLength(2);
  });

  it('a recorder with no observer behaves exactly as before', () => {
    let clock = 0;
    const rec = createSessionRecorder({
      epoch: 'w-test',
      room: 'abcd',
      startedAt: '2026-09-09T00:00:00.000Z',
      config: {},
      now: () => (clock += 1000),
    });
    rec.world('landscape', 1);
    expect(rec.count()).toBe(1);
  });
});


describe('an undo travels as texels', () => {
  // The one paint event that is not a dab (docs/SESSION.md §paint): History
  // puts a rectangle back into a layer and no stamp describes what it put
  // there, so the texels themselves travel — and unlike a dab, which is
  // geometry and can be trimmed to the map, a patch is REFUSED rather than
  // clamped. A rect whose data is the wrong length would write a shifted
  // image; a rect naming texels the layer does not have would land on one
  // screen and not another.
  const floats = (n: number): string => {
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = i * 0.5;
    return encodeFloats(values);
  };
  const patch = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    k: 'paint',
    t: 12,
    tool: 'patch',
    layer: 'trees',
    x0: 4,
    y0: 8,
    x1: 6,
    y1: 9,
    data: floats(3 * 2),
    ...over,
  });

  it('reads a well-formed patch whole', () => {
    const read = readSceneEvent(patch());
    expect(read).toEqual({
      k: 'paint',
      t: 12,
      tool: 'patch',
      layer: 'trees',
      x0: 4,
      y0: 8,
      x1: 6,
      y1: 9,
      data: floats(6),
    });
    // …and the floats survive the round trip, exactly.
    expect([...decodeFloats((read as { data: string }).data)]).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
  });

  it('carries the two-channel comb, and only the channel counts a layer can have', () => {
    // The comb is a DIRECTION per texel, two floats (src/world/comb.ts), so
    // its patch carries twice the rect. Without `ch` the door would measure
    // that payload against the texel count and refuse an honest undo.
    const comb = patch({ layer: 'comb', ch: 2, data: floats(3 * 2 * 2) });
    expect(readSceneEvent(comb)).toEqual({ ...comb, k: 'paint', t: 12 });
    // The default is one, and it is not echoed back.
    expect(readSceneEvent(patch())).not.toHaveProperty('ch');
    // A count no paint layer has, or the right count with the wrong payload.
    expect(readSceneEvent(patch({ ch: 3, data: floats(18) }))).toBeNull();
    expect(readSceneEvent(patch({ ch: 2, data: floats(6) }))).toBeNull();
    expect(readSceneEvent(patch({ ch: 2 }))).toBeNull();
  });

  it('refuses a payload that is not the size of the rect it claims', () => {
    expect(readSceneEvent(patch({ data: floats(5) }))).toBeNull();
    expect(readSceneEvent(patch({ data: floats(7) }))).toBeNull();
    expect(readSceneEvent(patch({ data: 'not base64 at all!!' }))).toBeNull();
    expect(readSceneEvent(patch({ data: undefined }))).toBeNull();
  });

  it('refuses a rectangle that is inside out, negative or past the map', () => {
    expect(readSceneEvent(patch({ x1: 3 }))).toBeNull();
    expect(readSceneEvent(patch({ y0: 12 }))).toBeNull();
    expect(readSceneEvent(patch({ x0: -1 }))).toBeNull();
    expect(readSceneEvent(patch({ x0: 1.5 }))).toBeNull();
    expect(readSceneEvent(patch({ x1: SCENE_MAX_TEXEL + 1 }))).toBeNull();
  });

  it('refuses a rectangle bigger than one wire message may carry', () => {
    // The brush splits an undo into tiles at exactly this ceiling rather
    // than the door growing a hole big enough to post a layer through.
    const side = Math.floor(Math.sqrt(SCENE_MAX_PATCH_TEXELS));
    const ok = patch({ x0: 0, y0: 0, x1: side - 1, y1: side - 1, data: floats(side * side) });
    expect(readSceneEvent(ok)).not.toBeNull();
    const tooBig = patch({
      x0: 0,
      y0: 0,
      x1: side,
      y1: side,
      data: floats((side + 1) * (side + 1)),
    });
    expect(readSceneEvent(tooBig)).toBeNull();
  });

  it('refuses a layer id that is not one', () => {
    for (const layer of ['', 'Trees', 'a'.repeat(17), '../height', 42]) {
      expect(readSceneEvent(patch({ layer })), String(layer)).toBeNull();
    }
  });

  it('is a scene event, and a clear still buries it', () => {
    const read = readSceneEvent(patch());
    expect(read).not.toBeNull();
    expect(isSceneEvent(read as never)).toBe(true);
    // A patch before a clear is a patch to a map somebody threw away.
    const later = readSceneEvent(patch({ t: 14 }));
    const kept = compactScene([
      read as never,
      { k: 'paint', t: 13, tool: 'clear' },
      later as never,
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.t).toBe(14);
  });
});
