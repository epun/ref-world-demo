/**
 * One world, many screens — the parts that decide it.
 *
 * The transport is MQTT and lives in src/main.ts; everything that can be
 * WRONG is here: who hosts, what a frame means, and how a viewer catches up
 * without stepping. Two clients over a real broker are exercised separately
 * in a browser — this is the arithmetic those two clients agree on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRoomCode, roomForWorld } from '../../src/net/protocol';
import {
  FOLLOW_TAU_MS,
  HOST_STALE_MS,
  POSE_INTERVAL_MS,
  electHost,
  followFraction,
  isForcedId,
  makeHostId,
  packPoses,
  pruneClaims,
  readWorldSyncMessage,
  shortestAngle,
  unpackPoses,
} from '../../src/net/worldsync';

describe('who simulates', () => {
  it('a page on its own hosts itself', () => {
    // Otherwise the first person to open the link — the whole point of the
    // link — watches a world that never moves.
    expect(electHost('m7', new Map(), 1000)).toBe('m7');
  });

  it('the smallest live id wins, and everyone computes the same winner', () => {
    const now = 10_000;
    const seen = new Map([['aa', now], ['zz', now]]);
    expect(electHost('mm', seen, now)).toBe('aa');
    // ...and the winner agrees that it is the winner.
    expect(electHost('aa', new Map([['mm', now], ['zz', now]]), now)).toBe('aa');
    // ...and a third page does not think it is.
    expect(electHost('zz', new Map([['aa', now], ['mm', now]]), now)).toBe('aa');
  });

  it('a page that stopped heartbeating loses the role', () => {
    const now = 100_000;
    const seen = new Map([['aa', now - HOST_STALE_MS - 1]]);
    expect(electHost('mm', seen, now)).toBe('mm');
    // ...but one beat late is not gone. Three beats of slack, so a single
    // dropped message never causes a takeover.
    expect(electHost('mm', new Map([['aa', now - 2500]]), now)).toBe('aa');
  });

  it('a pinned projection outranks every generated id', () => {
    // `?host=1` takes an id starting with '!', which sorts below digits and
    // letters — so the election needs no special case for it at all.
    const forced = makeHostId(true, () => 0.99);
    const normal = makeHostId(false, () => 0.01);
    expect(isForcedId(forced)).toBe(true);
    expect(isForcedId(normal)).toBe(false);
    expect(forced < normal).toBe(true);
    expect(electHost(normal, new Map([[forced, 5000]]), 5000)).toBe(forced);
  });

  it('forgets pages that are long gone', () => {
    const now = 100_000;
    const seen = new Map([['old', now - HOST_STALE_MS * 3], ['live', now]]);
    pruneClaims(seen, now);
    expect([...seen.keys()]).toEqual(['live']);
  });
});

describe('a frame of the world', () => {
  const poses = [
    { id: 'a', x: 1.234, z: -5.678, heading: 1.5 },
    { id: 'b', x: -12.5, z: 0, heading: -3.1 },
  ];

  it('survives the round trip to within the quantum', () => {
    const roster = ['a', 'b'];
    const back = unpackPoses(packPoses(poses, roster), roster);
    expect(back).toHaveLength(2);
    for (let i = 0; i < poses.length; i++) {
      expect(back[i]!.id).toBe(poses[i]!.id);
      // Hundredths of a world unit: a creature is ~1.2 units across, so
      // this is far below anything visible.
      expect(back[i]!.x).toBeCloseTo(poses[i]!.x, 2);
      expect(back[i]!.z).toBeCloseTo(poses[i]!.z, 2);
      expect(back[i]!.heading).toBeCloseTo(poses[i]!.heading, 3);
    }
  });

  it('keeps roster order even when a creature is missing', () => {
    // A hole would shift every creature after it onto somebody else's id.
    const roster = ['a', 'gone', 'b'];
    const back = unpackPoses(packPoses(poses, roster), roster);
    expect(back.map((p) => p.id)).toEqual(roster);
    expect(back[2]!.x).toBeCloseTo(-12.5, 2);
  });

  it('refuses a frame that does not match its roster', () => {
    // Applying it anyway puts every creature on the wrong position, which
    // is worse than showing the last good one.
    expect(unpackPoses([1, 2, 3], ['a', 'b'])).toEqual([]);
    expect(unpackPoses([], ['a'])).toEqual([]);
  });

  it('sends integers, so the payload stays small at conference scale', () => {
    const packed = packPoses(poses, ['a', 'b']);
    for (const n of packed) expect(Number.isInteger(n)).toBe(true);
  });
});

describe('reading what arrived', () => {
  it('accepts the three shapes', () => {
    expect(readWorldSyncMessage({ t: 'host', id: 'a', at: 1 })).toEqual({ t: 'host', id: 'a', at: 1 });
    expect(readWorldSyncMessage({ t: 'roster', id: 'a', rev: 2, ids: ['x'] })?.t).toBe('roster');
    expect(readWorldSyncMessage({ t: 'poses', id: 'a', rev: 2, p: [1, 2, 3] })?.t).toBe('poses');
  });

  it('rejects anything else, including half-right payloads', () => {
    // It comes off a PUBLIC broker: anyone can publish to this topic.
    expect(readWorldSyncMessage(null)).toBeNull();
    expect(readWorldSyncMessage('poses')).toBeNull();
    expect(readWorldSyncMessage({ t: 'host', id: 'a' })).toBeNull();
    expect(readWorldSyncMessage({ t: 'poses', id: 'a', rev: 1, p: [1, 'x', 3] })).toBeNull();
    expect(readWorldSyncMessage({ t: 'roster', id: 'a', rev: 1, ids: ['x', 2] })).toBeNull();
    expect(readWorldSyncMessage({ t: 'poses', rev: 1, p: [] })).toBeNull();
  });
});

describe('following without stepping', () => {
  it('converges monotonically and never overshoots', () => {
    // Frames land 5 times a second; placing a creature ON each one is a
    // step, which is the hard cut the motion law forbids at confidence
    // 1.00. Exponential easing cannot overshoot however the frames bunch.
    let at = 0;
    const target = 10;
    let previous = -1;
    for (let i = 0; i < 200; i++) {
      at += (target - at) * followFraction(16, FOLLOW_TAU_MS);
      // Non-decreasing, not strictly increasing: once it has converged to
      // the target in floating point it stops, which is the point.
      expect(at).toBeGreaterThanOrEqual(previous);
      expect(at).toBeLessThanOrEqual(target);
      previous = at;
    }
    expect(at).toBeCloseTo(target, 3);
  });

  it('has substantially arrived by the time the next frame lands', () => {
    // ...but is still moving when it does, so nothing ever fully arrests.
    const k = followFraction(POSE_INTERVAL_MS, FOLLOW_TAU_MS);
    expect(k).toBeGreaterThan(0.85);
    expect(k).toBeLessThan(1);
  });

  it('is frame-rate independent', () => {
    // One 32ms step must land where two 16ms steps land, or the world runs
    // at a different speed on a slower phone.
    const one = followFraction(32, FOLLOW_TAU_MS);
    const a = followFraction(16, FOLLOW_TAU_MS);
    expect(1 - (1 - a) * (1 - a)).toBeCloseTo(one, 12);
  });

  it('turns the short way round', () => {
    // Straddling ±π, raw interpolation spins the long way — 350° to face
    // 10° left, which is exactly the unmotivated motion the law is against.
    expect(shortestAngle(3.0, -3.0)).toBeCloseTo(Math.PI * 2 - 6, 6);
    expect(Math.abs(shortestAngle(3.0, -3.0))).toBeLessThan(Math.PI);
    expect(shortestAngle(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
    expect(shortestAngle(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('a named world meets in one room', () => {
  // The store made this invisible: everyone read the same drawings and saw
  // the same population, so it LOOKED shared — but only on the 20s poll.
  // The live seam was per-visitor, because the public link carries a world
  // and no room, so every visitor minted a random one. Arrivals did not
  // cross in real time, and the host election ran inside each visitor's
  // private topic, so every one of them elected itself.
  it('is the same room on every device, forever', () => {
    expect(roomForWorld('public')).toBe(roomForWorld('public'));
    // ...and it does not depend on anything but the name.
    expect(roomForWorld('valiocon')).toBe(roomForWorld('valiocon'));
  });

  it('gives different worlds different rooms', () => {
    const names = ['public', 'valiocon', 'refdesign', 'a', 'b', 'test'];
    const rooms = names.map(roomForWorld);
    expect(new Set(rooms).size).toBe(names.length);
  });

  it('produces a code the rest of the system accepts', () => {
    // It travels in join codes and mqtt topics like any other room.
    for (const name of ['public', 'valiocon', 'x', 'a-very-long-world-name']) {
      expect(isRoomCode(roomForWorld(name))).toBe(true);
    }
  });

  it('is what the world page uses when a world is named', () => {
    const src = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    // An explicit ?room= still wins; only the unnamed case stays random.
    expect(src).toMatch(/isRoomCode\(fromUrl\)\s*\n?\s*\? fromUrl/);
    expect(src).toMatch(/roomForWorld\(worldName\)/);
    expect(src).toMatch(/roomCode\(Math\.random\)/);
  });
});
