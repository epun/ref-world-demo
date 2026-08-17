/**
 * Session pure logic: room-code parsing from the location search, the
 * same-device wander path (deterministic, bounded, alive), and the local
 * name pick. No DOM, no network, no timers.
 */

import { describe, expect, it } from 'vitest';
import {
  LOCAL_EXTENT,
  localName,
  roomFromLocation,
  WANDER_SPAN,
  wanderPose,
} from '../../src/phone/session';
import { strokeSeed } from '../../src/phone/seed';
import { circleBlob, snowman } from '../fixtures/strokes';

describe('roomFromLocation', () => {
  it('parses a valid room code', () => {
    expect(roomFromLocation('?room=abcd')).toBe('abcd');
    expect(roomFromLocation('room=abcd')).toBe('abcd');
    expect(roomFromLocation('?x=1&room=wxyz&y=2')).toBe('wxyz');
  });

  it('rejects wrong length, missing, and out-of-alphabet codes', () => {
    expect(roomFromLocation('')).toBeNull();
    expect(roomFromLocation('?room=abc')).toBeNull();
    expect(roomFromLocation('?room=abcde')).toBeNull();
    expect(roomFromLocation('?other=abcd')).toBeNull();
    // i, l, o are excluded from the room alphabet for legibility.
    expect(roomFromLocation('?room=abio')).toBeNull();
    // No uppercase anywhere — codes are lowercase only.
    expect(roomFromLocation('?room=ABCD')).toBeNull();
  });
});

describe('strokeSeed', () => {
  it('is deterministic and decorrelates per drawing', () => {
    expect(strokeSeed(snowman)).toBe(strokeSeed(snowman));
    expect(strokeSeed(snowman)).not.toBe(strokeSeed(circleBlob));
    expect(strokeSeed([])).toBe(strokeSeed([]));
  });
});

describe('wanderPose', () => {
  const seed = strokeSeed(snowman);

  it('is deterministic — same time, same seed, same pose', () => {
    const a = wanderPose(12_345, seed, LOCAL_EXTENT);
    const b = wanderPose(12_345, seed, LOCAL_EXTENT);
    expect(a).toEqual(b);
  });

  it('stays inside the wander span of the extent', () => {
    const bound = LOCAL_EXTENT * WANDER_SPAN * 1.0001;
    for (let t = 0; t < 240_000; t += 4000) {
      const pose = wanderPose(t, seed, LOCAL_EXTENT);
      expect(Math.abs(pose.x)).toBeLessThanOrEqual(bound);
      expect(Math.abs(pose.z)).toBeLessThanOrEqual(bound);
      expect(Math.abs(pose.heading)).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('actually moves over time — the minimap shows life', () => {
    const a = wanderPose(10_000, seed, LOCAL_EXTENT);
    const b = wanderPose(40_000, seed, LOCAL_EXTENT);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0);
  });

  it('decorrelates by seed', () => {
    const a = wanderPose(20_000, seed, LOCAL_EXTENT);
    const b = wanderPose(20_000, seed + 11.7, LOCAL_EXTENT);
    expect(a.x === b.x && a.z === b.z).toBe(false);
  });
});

describe('localName', () => {
  it('is deterministic, lowercase, nonempty', () => {
    const name = localName(strokeSeed(snowman));
    expect(name).toBe(localName(strokeSeed(snowman)));
    expect(name.length).toBeGreaterThan(0);
    expect(name).toBe(name.toLowerCase());
  });
});
