/**
 * The sculpting tool's pure rules (src/dev/paint-tools.ts): which layer a
 * tool id writes, what shift inverts, and how the bracket keys step the
 * radius (2026-09-09, user ask: *"we should use the brackets to hot key the
 * radius of the brush and holding shift while painting will have the
 * opposite brush effect i.e. so removing elevation etc."*).
 *
 * `src/dev/paint.ts` itself cannot be imported here — it pulls `envpaint/ui`,
 * which wants a document at import time — which is exactly why these three
 * rules live in a module of their own.
 */

import { describe, expect, it } from 'vitest';
import {
  clampRadius,
  HEIGHT_LAYER,
  HEIGHT_TOOL_IDS,
  invertStampMode,
  isPlantTool,
  layerForTool,
  RADIUS_DEFAULT,
  RADIUS_MAX,
  RADIUS_MIN,
  RADIUS_STEP,
  steppedRadius,
} from '../../src/dev/paint-tools';
import { PLANT_BRUSHES } from '../../src/world/painted';

describe('tool → layer routing', () => {
  it('sends every height tool to the one height layer', () => {
    for (const tool of HEIGHT_TOOL_IDS) {
      expect(layerForTool(tool), tool).toBe(HEIGHT_LAYER);
      expect(isPlantTool(tool), tool).toBe(false);
    }
  });

  it('sends every planting brush to the layer it is named for', () => {
    for (const brush of PLANT_BRUSHES) {
      expect(layerForTool(brush), brush).toBe(brush);
      expect(isPlantTool(brush), brush).toBe(true);
    }
  });

  it('refuses a tool id it does not know rather than defaulting to height', () => {
    // A replayed stamp from a future build must not silently sculpt the
    // ground because its tool id was unrecognised (docs/SESSION.md §4).
    expect(layerForTool('rivers')).toBeNull();
    expect(layerForTool('clear')).toBeNull();
    expect(layerForTool('')).toBeNull();
  });
});

describe('shift inverts', () => {
  it('swaps raise ↔ lower and add ↔ erase', () => {
    expect(invertStampMode('raise')).toBe('lower');
    expect(invertStampMode('lower')).toBe('raise');
    expect(invertStampMode('add')).toBe('erase');
    expect(invertStampMode('erase')).toBe('add');
  });

  it('is its own inverse — shift twice is no shift at all', () => {
    for (const mode of ['raise', 'lower', 'add', 'erase', 'smooth', 'flatten']) {
      expect(invertStampMode(invertStampMode(mode)), mode).toBe(mode);
    }
  });

  it('leaves the modes with no opposite exactly as they are', () => {
    // Un-smoothing is not a thing a brush can do, and the inverse of "level
    // this ground" is the ground it already left behind.
    expect(invertStampMode('smooth')).toBe('smooth');
    expect(invertStampMode('flatten')).toBe('flatten');
    expect(invertStampMode('set')).toBe('set');
  });
});

describe('the radius keys', () => {
  it('steps by EnvPaint’s own ratio, in both directions', () => {
    expect(steppedRadius(10, 1)).toBeCloseTo(10 * RADIUS_STEP, 6);
    expect(steppedRadius(10, -1)).toBeCloseTo(10 / RADIUS_STEP, 6);
    // A ratio, not an increment: the same proportion at either end.
    expect(steppedRadius(2, 1) / 2).toBeCloseTo(steppedRadius(20, 1) / 20, 6);
  });

  it('clamps into THIS world’s range, not EnvPaint’s 0.3-12', () => {
    // The bug this replaces: past 12 units EnvPaint's own handler stops
    // responding, and this world's field is 400 across.
    expect(steppedRadius(12, 1)).toBeGreaterThan(12);
    let r = RADIUS_DEFAULT;
    for (let i = 0; i < 100; i++) r = steppedRadius(r, 1);
    expect(r).toBe(RADIUS_MAX);
    for (let i = 0; i < 200; i++) r = steppedRadius(r, -1);
    expect(r).toBe(RADIUS_MIN);
  });

  it('never returns a radius outside the range, from any input', () => {
    for (const start of [Number.NaN, -5, 0, 0.01, 1, 39.9, 1e6, Infinity]) {
      for (const dir of [-1, 1] as const) {
        const r = steppedRadius(start, dir);
        expect(r, `${start} ${dir}`).toBeGreaterThanOrEqual(RADIUS_MIN);
        expect(r, `${start} ${dir}`).toBeLessThanOrEqual(RADIUS_MAX);
      }
    }
    expect(clampRadius(Number.NaN)).toBe(RADIUS_DEFAULT);
  });
});
