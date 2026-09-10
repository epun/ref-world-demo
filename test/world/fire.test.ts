/**
 * `burnState` — the fire brush's whole model (src/world/fire.ts).
 *
 * Pure, so this file needs no canvas and no clock: every case here is the
 * same function given two painted layers and a time. What is pinned is the
 * three rules the tool would be dangerous without — it spreads ONLY over
 * painted grass, the wind biases the front, and a fire that has finished
 * leaves scorch and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { BURN_MS, burnState, SPREAD_TEXELS_PER_S } from '../../src/world/fire';

const RES = 32;

/** A blank pair of layers at RES², plus the stamp-time array beside them. */
function layers(): { fire: Float32Array; fireAt: Float32Array; grass: Float32Array } {
  return {
    fire: new Float32Array(RES * RES),
    fireAt: new Float32Array(RES * RES),
    grass: new Float32Array(RES * RES),
  };
}

const at = (x: number, y: number): number => y * RES + x;

/** A horizontal band of fuel across the middle row, from x0 to x1. */
function fuelRow(grass: Float32Array, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) grass[at(x, y)] = 1;
}

describe('burnState', () => {
  it('spreads only over painted grass', () => {
    const { fire, fireAt, grass } = layers();
    // Fuel from x=10 to x=20 on one row; the fire is lit at x=10. x=21 and
    // beyond is bare paper.
    fuelRow(grass, 16, 10, 20);
    fire[at(10, 16)] = 1;
    fireAt[at(10, 16)] = 0;
    // Long enough for the front to have crossed the whole band several times.
    const nowMs = (20 / SPREAD_TEXELS_PER_S) * 1000 + BURN_MS * 2;
    const field = burnState({ fire, fireAt, grass, res: RES, nowMs, windAzimuth: 0 });

    // Every fuel texel caught…
    for (let x = 10; x <= 20; x++) {
      expect(Number.isFinite(field.ignite[at(x, 16)] as number)).toBe(true);
    }
    // …and nothing off the fuel did, in any direction.
    expect(field.ignite[at(21, 16)]).toBe(Infinity);
    expect(field.ignite[at(9, 16)]).toBe(Infinity);
    expect(field.ignite[at(15, 15)]).toBe(Infinity);
    expect(field.ignite[at(15, 17)]).toBe(Infinity);
    expect(field.scorch[at(21, 16)]).toBe(0);
  });

  it('a source on bare paper burns out where it stands', () => {
    const { fire, fireAt, grass } = layers();
    fire[at(16, 16)] = 1;
    const field = burnState({
      fire,
      fireAt,
      grass,
      res: RES,
      nowMs: BURN_MS * 3,
      windAzimuth: 0,
    });
    expect(field.scorch[at(16, 16)]).toBe(1);
    expect(field.ignite[at(17, 16)]).toBe(Infinity);
    expect(field.active).toBe(false);
  });

  it('the wind hurries the front downwind and holds it back upwind', () => {
    const { fire, fireAt, grass } = layers();
    fuelRow(grass, 16, 4, 28);
    fire[at(16, 16)] = 1;
    // Azimuth 0 is +z in this world's convention, so a wind blowing along +x
    // is a quarter turn on from it.
    const east = burnState({
      fire,
      fireAt,
      grass,
      res: RES,
      nowMs: 0,
      windAzimuth: Math.PI / 2,
    });
    const downwind = east.ignite[at(24, 16)] as number;
    const upwind = east.ignite[at(8, 16)] as number;
    expect(downwind).toBeLessThan(upwind);

    // …and with no wind at all the two sides are symmetric.
    const still = burnState({ fire, fireAt, grass, res: RES, nowMs: 0, windAzimuth: 0 });
    expect(still.ignite[at(24, 16)]).toBeCloseTo(still.ignite[at(8, 16)] as number, 6);
  });

  it('burn-out leaves scorch and nothing alight', () => {
    const { fire, fireAt, grass } = layers();
    fuelRow(grass, 16, 14, 18);
    fire[at(16, 16)] = 1;

    // Mid-burn: something is alight, and the fire is still going.
    const during = burnState({
      fire,
      fireAt,
      grass,
      res: RES,
      nowMs: BURN_MS * 0.5,
      windAzimuth: 0,
    });
    expect(during.burning[at(16, 16)]).toBeGreaterThan(0);
    expect(during.active).toBe(true);

    // Long after: every texel that ever caught is scorch, nothing is alight,
    // and the driver is told it can stop asking.
    const after = burnState({
      fire,
      fireAt,
      grass,
      res: RES,
      nowMs: (10 / SPREAD_TEXELS_PER_S) * 1000 + BURN_MS * 4,
      windAzimuth: 0,
    });
    expect(after.active).toBe(false);
    for (let x = 14; x <= 18; x++) {
      expect(after.burning[at(x, 16)]).toBe(0);
      expect(after.scorch[at(x, 16)]).toBe(1);
    }
  });

  it('an unpainted world is three empty fields', () => {
    const { fire, fireAt, grass } = layers();
    const field = burnState({ fire, fireAt, grass, res: RES, nowMs: 12345, windAzimuth: 0.4 });
    expect(field.active).toBe(false);
    expect(field.burning.some((v) => v !== 0)).toBe(false);
    expect(field.scorch.some((v) => v !== 0)).toBe(false);
  });

  it('is deterministic — the same paint and time answer the same field', () => {
    const { fire, fireAt, grass } = layers();
    fuelRow(grass, 16, 10, 22);
    fire[at(12, 16)] = 1;
    const a = burnState({ fire, fireAt, grass, res: RES, nowMs: 4000, windAzimuth: 1.1 });
    const b = burnState({ fire, fireAt, grass, res: RES, nowMs: 4000, windAzimuth: 1.1 });
    expect(Array.from(a.ignite)).toEqual(Array.from(b.ignite));
    expect(Array.from(a.scorch)).toEqual(Array.from(b.scorch));
  });
});
