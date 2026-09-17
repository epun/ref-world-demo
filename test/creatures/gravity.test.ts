/**
 * ZERO GRAVITY, the pure half (src/creatures/gravity.ts).
 *
 * > User ask, 2026-09-17: *"i want a zero gravity mode where i can hit g on
 * > the keyboard and it turns off gravity for the map. characters should float
 * > in space."*
 *
 * What travels is one bit; where a creature ends up is DERIVED on every page
 * from that bit, the slot id and the page's own clock — which is what keeps Y
 * off the wire (docs/PLAN.md §7.6). So these pin the derivation: every
 * creature hangs at its own altitude, the same altitude on every page, the
 * drift never reaches the ground, and nothing ever fully arrests.
 */

import { describe, expect, it } from 'vitest';
import {
  FLOAT_BOB,
  FLOAT_BOB_MS,
  FLOAT_LIFT_MIN,
  FLOAT_LIFT_RANGE,
  FLOAT_TUMBLE,
  FLOAT_TUMBLE_MS,
  floatBob,
  floatHeight,
  floatTumble,
} from '../../src/creatures/gravity';
import { MOTION } from '../../src/taste/tokens';

/** The manager's own `behaviorSeed`, which is what feeds these. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const ids = Array.from({ length: 80 }, (_unused, i) => `drawer-${i}`);

describe('how high a creature floats', () => {
  it('is inside the authored band, for every id', () => {
    for (const id of ids) {
      const h = floatHeight(seedOf(id));
      expect(h).toBeGreaterThanOrEqual(FLOAT_LIFT_MIN);
      expect(h).toBeLessThanOrEqual(FLOAT_LIFT_MIN + FLOAT_LIFT_RANGE);
    }
  });

  it('is the same number every time — the same creature on every page', () => {
    for (const id of ids.slice(0, 10)) {
      expect(floatHeight(seedOf(id))).toBe(floatHeight(seedOf(id)));
    }
  });

  it('spreads a room across the band instead of hanging it on a shelf', () => {
    const heights = ids.map((id) => floatHeight(seedOf(id)));
    const spread = Math.max(...heights) - Math.min(...heights);
    // Eighty creatures cover most of the range…
    expect(spread).toBeGreaterThan(FLOAT_LIFT_RANGE * 0.8);
    // …and land in different places: at least half of them are more than a
    // creature's own height apart from every other.
    const distinct = new Set(heights.map((h) => Math.round(h * 2)));
    expect(distinct.size).toBeGreaterThan(5);
  });
});

describe('the drift up there', () => {
  it('never reaches the ground it lifted off', () => {
    // The bob rides ON the height, so a bob bigger than the lowest altitude
    // would put a floating creature back in the paper.
    expect(FLOAT_BOB).toBeLessThan(FLOAT_LIFT_MIN);
    for (const id of ids.slice(0, 20)) {
      const seed = seedOf(id);
      const base = floatHeight(seed);
      for (let t = 0; t < FLOAT_BOB_MS * 4; t += 97) {
        const y = base + floatBob(t, seed);
        expect(Math.abs(floatBob(t, seed))).toBeLessThanOrEqual(FLOAT_BOB + 1e-12);
        expect(y).toBeGreaterThan(0);
      }
    }
  });

  it('never fully arrests — it is moving at every instant we look', () => {
    // TASTE §3, confidence 1.00. Two incommensurate sines, so there is no
    // window in which the value is constant.
    const seed = seedOf('drawer-3');
    let moves = 0;
    let previous = floatBob(0, seed);
    for (let t = 200; t < FLOAT_BOB_MS * 3; t += 200) {
      const now = floatBob(t, seed);
      if (Math.abs(now - previous) > 1e-9) moves++;
      previous = now;
    }
    // Every single sample moved.
    expect(moves).toBe(Math.floor((FLOAT_BOB_MS * 3 - 200) / 200) + 1);
  });

  it('is slow — its period comes from the motion tokens, not a literal', () => {
    expect(FLOAT_BOB_MS).toBe(MOTION.ambientMs * 2);
    expect(FLOAT_TUMBLE_MS).toBe(MOTION.ambientMs * 3);
    // Slower than the slowest beat the scale has.
    expect(FLOAT_BOB_MS).toBeGreaterThan(MOTION.primaryMs);
  });

  it('starts each creature somewhere else in the cycle', () => {
    const at0 = ids.slice(0, 20).map((id) => floatBob(0, seedOf(id)));
    const distinct = new Set(at0.map((v) => Math.round(v * 1000)));
    expect(distinct.size).toBeGreaterThan(15);
  });
});

describe('the tumble', () => {
  it('is a sway and never a somersault', () => {
    for (const id of ids.slice(0, 20)) {
      const seed = seedOf(id);
      for (let t = 0; t < FLOAT_TUMBLE_MS * 3; t += 131) {
        const { x, z } = floatTumble(t, seed);
        expect(Math.abs(x)).toBeLessThanOrEqual(FLOAT_TUMBLE + 1e-12);
        expect(Math.abs(z)).toBeLessThanOrEqual(FLOAT_TUMBLE + 1e-12);
      }
    }
    // Under a quarter turn, so the creature is never upside down and its
    // topper still faces the heading.
    expect(FLOAT_TUMBLE).toBeLessThan(Math.PI / 4);
  });

  it('turns the two axes on different clocks', () => {
    const seed = seedOf('drawer-7');
    let same = 0;
    for (let t = 0; t < FLOAT_TUMBLE_MS * 2; t += 311) {
      const { x, z } = floatTumble(t, seed);
      if (Math.abs(x - z) < 1e-6) same++;
    }
    // They cross, but they do not travel together.
    expect(same).toBeLessThan(3);
  });
});
