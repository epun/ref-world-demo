/**
 * Wait-screen pure logic: the lowercase countdown line and the deterministic
 * egg wobble (continuous, bounded, never zero-amplitude for long).
 */

import { describe, expect, it } from 'vitest';
import { countdownLabel, eggWobble } from '../../src/phone/screens/wait';

describe('countdownLabel', () => {
  it('reads lowercase and rounds seconds up', () => {
    expect(countdownLabel(18_000)).toBe('hatches in 18s');
    expect(countdownLabel(17_001)).toBe('hatches in 18s');
    expect(countdownLabel(500)).toBe('hatches in 1s');
  });

  it('handles the endpoints', () => {
    expect(countdownLabel(0)).toBe('hatching');
    expect(countdownLabel(-250)).toBe('hatching');
    expect(countdownLabel(null)).toBe('the egg is warming');
  });

  it('never emits uppercase (TASTE §5)', () => {
    for (const ms of [null, 0, 900, 5_000, 61_000]) {
      const label = countdownLabel(ms);
      expect(label).toBe(label.toLowerCase());
    }
  });
});

describe('eggWobble', () => {
  it('is deterministic per seed and time', () => {
    expect(eggWobble(1234, 7.7)).toBe(eggWobble(1234, 7.7));
    expect(eggWobble(1234, 7.7)).not.toBe(eggWobble(1234, 8.8));
  });

  it('stays gentle — bounded well under a radian', () => {
    for (let t = 0; t < 60_000; t += 250) {
      expect(Math.abs(eggWobble(t, 7.7))).toBeLessThan(0.06);
    }
  });

  it('never stops — motion over any 2s idle window (stillness probe)', () => {
    for (let start = 0; start < 30_000; start += 2000) {
      const a = eggWobble(start, 7.7);
      const b = eggWobble(start + 1000, 7.7);
      const c = eggWobble(start + 2000, 7.7);
      expect(a === b && b === c).toBe(false);
    }
  });
});
