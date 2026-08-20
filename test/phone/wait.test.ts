/**
 * Wait-screen pure logic: the timer→hatch progress mapping (the same
 * elapsed/total read the world uses) and the late crack teaser scrub.
 *
 * The countdown LINE is gone (user ruling, 2026-08-20: *"let's remove the
 * count down and the hatch button. i want to set the hatch timing on my
 * end."*) and `countdownLabel` went with it. The timer itself did not: it
 * still feeds hatchProgress, which is what ramps the shell's wobble and
 * teases the cracks in — so these two are exactly the part that survived,
 * and they are what these tests cover.
 */

import { describe, expect, it } from 'vitest';
import {
  crackTeaser,
  CRACK_TEASER,
  hatchProgress,
} from '../../src/phone/screens/wait';

describe('hatchProgress', () => {
  it('is the world mapping: elapsed over total', () => {
    expect(hatchProgress(20_000, 20_000)).toBe(0);
    expect(hatchProgress(10_000, 20_000)).toBeCloseTo(0.5);
    expect(hatchProgress(5_000, 20_000)).toBeCloseTo(0.75);
    expect(hatchProgress(0, 20_000)).toBe(1);
  });

  it('clamps to [0, 1]', () => {
    expect(hatchProgress(-3_000, 20_000)).toBe(1);
    expect(hatchProgress(30_000, 20_000)).toBe(0);
  });

  it('rests at 0 while the timer is unknown or degenerate', () => {
    expect(hatchProgress(null, 20_000)).toBe(0);
    expect(hatchProgress(10_000, null)).toBe(0);
    expect(hatchProgress(10_000, 0)).toBe(0);
    expect(hatchProgress(null, null)).toBe(0);
  });

  it('is monotone as the countdown advances', () => {
    let prev = -1;
    for (let remaining = 20_000; remaining >= 0; remaining -= 500) {
      const p = hatchProgress(remaining, 20_000);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('crackTeaser', () => {
  it('holds zero until the final stretch (p < 0.62)', () => {
    for (const p of [0, 0.2, 0.5, 0.62]) {
      expect(crackTeaser(p)).toBe(0);
    }
  });

  it('drifts up to the teaser ceiling at p = 1, never beyond', () => {
    expect(crackTeaser(1)).toBeCloseTo(CRACK_TEASER);
    expect(crackTeaser(2)).toBeCloseTo(CRACK_TEASER);
    for (let p = 0; p <= 1; p += 0.01) {
      expect(crackTeaser(p)).toBeLessThanOrEqual(CRACK_TEASER + 1e-9);
      expect(crackTeaser(p)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is monotone and smooth — no step at the threshold', () => {
    let prev = 0;
    for (let p = 0; p <= 1.0001; p += 0.005) {
      const c = crackTeaser(p);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = c;
    }
    // smoothstep: zero slope entering the ramp — the value just past the
    // threshold is still nearly zero.
    expect(crackTeaser(0.63)).toBeLessThan(0.003);
  });
});
