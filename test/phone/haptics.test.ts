/**
 * Haptics: the hatch buzz, and — more importantly — every way a handset
 * can refuse to buzz without breaking the screen.
 */

import { describe, expect, it } from 'vitest';
import {
  canVibrate,
  HATCH_PATTERN,
  hatchPulse,
  pulse,
  type VibrateLike,
} from '../../src/phone/haptics';

function recorder(result: boolean | (() => never) = true): VibrateLike & { calls: (number | number[])[] } {
  const calls: (number | number[])[] = [];
  return {
    calls,
    vibrate(pattern) {
      calls.push(pattern);
      if (typeof result === 'function') result();
      return result as boolean;
    },
  };
}

describe('hatch haptic', () => {
  it('hands the device the hatch pattern', () => {
    const nav = recorder();
    expect(hatchPulse(nav)).toBe(true);
    expect(nav.calls).toEqual([[...HATCH_PATTERN]]);
  });

  it('is a tick, not a ring — the whole thing under a fifth of a second', () => {
    const total = HATCH_PATTERN.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(200);
    // Two buzzes with a gap: crack, then out.
    expect(HATCH_PATTERN).toHaveLength(3);
    for (const ms of HATCH_PATTERN) expect(ms).toBeGreaterThan(0);
  });

  it('copies the pattern — a caller cannot mutate the shared constant', () => {
    const nav = recorder();
    hatchPulse(nav);
    (nav.calls[0] as number[])[0] = 9999;
    expect(HATCH_PATTERN[0]).not.toBe(9999);
  });
});

describe('a handset that will not buzz', () => {
  it('reports no support rather than pretending (every iphone)', () => {
    expect(canVibrate({})).toBe(false);
    expect(canVibrate({ vibrate: undefined })).toBe(false);
    expect(hatchPulse({})).toBe(false);
  });

  it('reports refusal when the browser declines (no engagement yet)', () => {
    const nav = recorder(false);
    expect(hatchPulse(nav)).toBe(false);
    expect(nav.calls).toHaveLength(1);
  });

  it('never throws, whatever the device does', () => {
    const throwing = recorder(() => {
      throw new Error('blocked');
    });
    expect(() => hatchPulse(throwing)).not.toThrow();
    expect(hatchPulse(throwing)).toBe(false);
  });

  it('refuses an empty pattern instead of calling with nothing', () => {
    const nav = recorder();
    expect(pulse([], nav)).toBe(false);
    expect(nav.calls).toHaveLength(0);
  });
});
