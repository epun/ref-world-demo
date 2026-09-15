/**
 * The gust-front field (src/world/wind.ts).
 *
 * The fixtures below are NOT hand-derived: they were produced by running
 * envpaint's own `Wind.sampleAt` (its `src/core/Wind.js`, over its
 * `src/core/noise.js`) once in a scratch node script, with the wind pinned
 * to its default 30° heading, strength 1, speed 1 and gust 0.5, and pasted
 * in. They are the port's proof — if `windAt` drifts from envpaint's field,
 * or from the GLSL half it mirrors, these move.
 */

import { describe, expect, it } from 'vitest';
import { gustAt, windAt, WIND_FIELD_GLSL, type WindField } from '../../src/world/wind';

/** envpaint's default heading, normalised — cos30°, sin30°. */
const DIR_X = 0.8660254037844387;
const DIR_Z = 0.49999999999999994;

const field = (gust = 0.5): WindField => ({
  dirX: DIR_X,
  dirZ: DIR_Z,
  strength: 1,
  speed: 1,
  gust,
});

/** From envpaint's `Wind.sampleAt` at gust 0.5. */
const FIXTURES: { x: number; z: number; t: number; wx: number; wz: number }[] = [
  { x: 0, z: 0, t: 0, wx: 0.7560685125142885, wz: 0.43651635922592436 },
  { x: 12.5, z: -7.25, t: 3.5, wx: 0.29123453167022606, wz: 0.16814433525711955 },
  { x: -40, z: 80, t: 11.75, wx: 0.11691342951089924, wz: 0.06749999999999999 },
  { x: 100, z: 100, t: 60, wx: 0.2892305348027612, wz: 0.16698732712623354 },
];

describe('windAt', () => {
  it("matches envpaint's sampleAt to float precision", () => {
    for (const f of FIXTURES) {
      const w = windAt(f.x, f.z, f.t, field());
      expect(w.x).toBeCloseTo(f.wx, 12);
      expect(w.z).toBeCloseTo(f.wz, 12);
    }
  });

  it('scales with the gust envelope exactly as envpaint does', () => {
    const w = windAt(12.5, -7.25, 3.5, field(0.9));
    expect(w.x).toBeCloseTo(0.3844295818046984, 12);
    expect(w.z).toBeCloseTo(0.22195052253939784, 12);
  });

  it('pushes ALONG the wind direction, always', () => {
    for (const f of FIXTURES) {
      const w = windAt(f.x, f.z, f.t, field());
      const mag = Math.hypot(w.x, w.z);
      expect(w.x).toBeCloseTo(DIR_X * mag, 12);
      expect(w.z).toBeCloseTo(DIR_Z * mag, 12);
    }
  });

  it('is pure — same inputs, same push, with no state between calls', () => {
    const a = windAt(3.5, -9, 4.25, field());
    windAt(1000, -1000, 77, field(0.1));
    const b = windAt(3.5, -9, 4.25, field());
    expect(b).toEqual(a);
  });

  it('scales linearly with strength and stays inside the field envelope', () => {
    // The field's own bounds: (0.18..1) x (0.75..1.25) x (0.6..1.4).
    for (let i = 0; i < 400; i++) {
      const t = i * 0.37;
      const w = windAt(i * 1.7 - 200, i * -2.3 + 50, t, field());
      const mag = Math.hypot(w.x, w.z);
      expect(mag).toBeGreaterThan(0.18 * 0.75 * 0.6 - 1e-9);
      expect(mag).toBeLessThan(1 * 1.25 * 1.4 + 1e-9);
      const twice = windAt(i * 1.7 - 200, i * -2.3 + 50, t, { ...field(), strength: 2 });
      expect(Math.hypot(twice.x, twice.z)).toBeCloseTo(mag * 2, 10);
    }
  });

  it('races the front DOWNWIND rather than pulsing in place', () => {
    // The field's signature: a sample downwind at a later time sees roughly
    // what an upwind sample saw earlier. Strictly: the field is not constant
    // in time at a fixed point, and not constant in space at a fixed time.
    const f = field();
    const atPoint = [0, 1, 2, 3].map((t) => windAt(20, 5, t, f).x);
    expect(new Set(atPoint.map((v) => v.toFixed(6))).size).toBeGreaterThan(1);
    const atTime = [0, 8, 16, 24].map((x) => windAt(x, 5, 2.5, f).x);
    expect(new Set(atTime.map((v) => v.toFixed(6))).size).toBeGreaterThan(1);
  });
});

describe('gustAt', () => {
  it("matches envpaint's gust walk, made pure in time", () => {
    expect(gustAt(0)).toBeCloseTo(0.557001641176163, 12);
    expect(gustAt(1.5)).toBeCloseTo(0.5078935669447151, 12);
    expect(gustAt(7.25)).toBeCloseTo(0.48511449281526703, 12);
    expect(gustAt(40)).toBeCloseTo(0.6139875312230285, 12);
  });

  it('stays in [0, 1] and is pure in time', () => {
    for (let i = 0; i < 2000; i++) {
      const t = i * 0.19;
      const g = gustAt(t);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(gustAt(t)).toBe(g);
    }
  });

  it('wanders smoothly — no step between adjacent frames', () => {
    let previous = gustAt(0);
    for (let i = 1; i < 600; i++) {
      const g = gustAt(i / 60);
      expect(Math.abs(g - previous)).toBeLessThan(0.05);
      previous = g;
    }
  });
});

describe('the glsl half', () => {
  it('declares refWindAt and its own namespaced noise chain', () => {
    expect(WIND_FIELD_GLSL).toContain(
      'vec2 refWindAt(vec2 p, float t, vec2 dir, float strength, float gust)',
    );
    expect(WIND_FIELD_GLSL).toContain('float windFbm(vec2 p, int octaves)');
    expect(WIND_FIELD_GLSL).toContain('float windVnoise(vec2 p)');
    expect(WIND_FIELD_GLSL).toContain('float windHash21(vec2 p)');
  });

  it("never redeclares the scatter's own wind helpers", () => {
    // src/world/scatter.ts already declares windHash(float) and
    // windNoise(float, float) in the same shader. A duplicate name is a
    // compile failure, and a compile failure is a blank world.
    expect(WIND_FIELD_GLSL).not.toMatch(/float windHash\s*\(/);
    expect(WIND_FIELD_GLSL).not.toMatch(/float windNoise\s*\(/);
  });

  it('carries the same constants as the typescript mirror', () => {
    for (const constant of ['0.07', '0.4', '3.1', '0.30, 0.62', '1.15', '0.55', '3.6', '0.18', '0.82', '0.75', '0.6', '0.8']) {
      expect(WIND_FIELD_GLSL).toContain(constant);
    }
  });
});
