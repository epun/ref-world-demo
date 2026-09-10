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
  COMING_TOOL_IDS,
  HEIGHT_LAYER,
  HEIGHT_TOOL_IDS,
  invertStampMode,
  isComingTool,
  isPlantTool,
  layerForTool,
  LEGACY_TOOLS,
  resolveTool,
  STRIP_TOOL_IDS,
  TOOL_KEYS,
  WATER_LAYER,
  WATER_TOOL_ID,
  WATER_TOOL_IDS,
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

  it('sends the pond to the one water layer', () => {
    expect(layerForTool(WATER_TOOL_ID)).toBe(WATER_LAYER);
    expect(isPlantTool(WATER_TOOL_ID)).toBe(false);
  });

  it('refuses every tool that has nothing behind it yet', () => {
    // The five are in the strip, keyed and disabled (src/dev/paint.ts), but
    // nothing routes to them: an id with no layer must not fall back to one.
    for (const id of COMING_TOOL_IDS) {
      expect(layerForTool(id), id).toBeNull();
      expect(isComingTool(id), id).toBe(true);
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

describe("EnvPaint's own strip", () => {
  // 2026-09-10, user ask: *"i want to match the brushes for env paint
  // exactly"*. The picture they sent, as a table: order, groups and keys.
  it('is the thirteen tools, in EnvPaint’s order', () => {
    expect([...STRIP_TOOL_IDS]).toEqual([
      'sculpt',
      'mask',
      'path',
      'grass',
      'comb',
      'flowers',
      'pond',
      'river',
      'waterfall',
      'trees',
      'rocks',
      'fire',
      'clouds',
    ]);
  });

  it('gives every one of them EnvPaint’s own hotkey', () => {
    expect(TOOL_KEYS).toEqual({
      sculpt: '0',
      mask: '9',
      path: '8',
      grass: '1',
      comb: '2',
      flowers: 'w',
      pond: '3',
      river: '4',
      waterfall: '5',
      trees: '6',
      rocks: '7',
      fire: 'f',
      clouds: 'c',
    });
    // Every strip tool is keyed, and no two share a key.
    const keys = STRIP_TOOL_IDS.map((id) => TOOL_KEYS[id]);
    expect(keys.filter(Boolean)).toHaveLength(STRIP_TOOL_IDS.length);
    expect(new Set(keys).size).toBe(keys.length);
    // No uppercase, anywhere (TASTE §5) — the letter keys included.
    for (const key of keys) expect(key).toBe(key?.toLowerCase());
  });

  it('routes every tool it can paint with, and refuses the rest', () => {
    for (const id of STRIP_TOOL_IDS) {
      // `waterfall` paints, but into no LAYER: it appends a mark to the
      // painted map (src/world/waterfall-marks.ts), so `layerForTool` refuses
      // it exactly as it refuses a tool that is not built yet. That is the
      // right answer — a replayed waterfall dab must never sculpt anything.
      if (isComingTool(id) || id === 'waterfall') expect(layerForTool(id), id).toBeNull();
      else expect(layerForTool(id), id).not.toBeNull();
    }
  });

  it('sends both water tools to the level layer', () => {
    // 2026-09-10, user ask: *"i want to match the brushes for env paint
    // exactly"*. The river is the pond's own machinery with a level that can
    // only fall, so it writes the pond's own layer.
    for (const id of WATER_TOOL_IDS) expect(layerForTool(id), id).toBe(WATER_LAYER);
    expect(isPlantTool('river')).toBe(false);
    expect(isComingTool('river')).toBe(false);
    expect(isComingTool('waterfall')).toBe(false);
  });
});

describe('the ids a stored scene was written under', () => {
  // A rename is not permission to lose a scene: stored scenes and session
  // logs carry raise / lower / flatten / smooth / grove / clearing / drain,
  // and docs/SESSION.md §4 says a replayed stamp lands in the layer it was
  // recorded from.
  it('maps every retired id onto the tool that replaced it', () => {
    expect(resolveTool('raise')).toEqual({ tool: 'sculpt', mode: 'raise' });
    expect(resolveTool('lower')).toEqual({ tool: 'sculpt', mode: 'lower' });
    expect(resolveTool('smooth')).toEqual({ tool: 'sculpt', mode: 'smooth' });
    expect(resolveTool('flatten')).toEqual({ tool: 'sculpt', mode: 'flatten' });
    expect(resolveTool('grove')).toEqual({ tool: 'trees', mode: undefined });
    expect(resolveTool('clearing')).toEqual({ tool: 'mask', mode: undefined });
    // A drain is a pond dab that erases — the tool alone no longer says so.
    expect(resolveTool('drain')).toEqual({ tool: 'pond', mode: 'erase' });
  });

  it('keeps the recorded mode when there is one', () => {
    // The log says what the dab DID; the table's mode is only the fallback
    // for an event old enough not to carry one.
    expect(resolveTool('raise', 'lower')).toEqual({ tool: 'sculpt', mode: 'lower' });
    expect(resolveTool('grove', 'erase')).toEqual({ tool: 'trees', mode: 'erase' });
    expect(resolveTool('drain', 'erase')).toEqual({ tool: 'pond', mode: 'erase' });
  });

  it('lands every retired id in the layer its live tool writes', () => {
    for (const [old, to] of Object.entries(LEGACY_TOOLS)) {
      expect(layerForTool(old), old).toBe(layerForTool(to.tool));
      expect(layerForTool(old), old).not.toBeNull();
    }
    // …including the two that changed names rather than modes.
    expect(layerForTool('grove')).toBe('trees');
    expect(layerForTool('clearing')).toBe('mask');
    expect(isPlantTool('grove')).toBe(true);
    expect(isPlantTool('clearing')).toBe(true);
  });

  it('leaves a current id exactly as it is', () => {
    for (const id of STRIP_TOOL_IDS) {
      expect(resolveTool(id), id).toEqual({ tool: id, mode: undefined });
      expect(resolveTool(id, 'add'), id).toEqual({ tool: id, mode: 'add' });
    }
  });

  it('does not resurrect the cottages brush', () => {
    // The brush and its weight layer are gone (EnvPaint has no cottage), so
    // a stored cottages dab resolves to nothing and routes nowhere — the
    // same answer any unknown id gets, rather than a silent sculpt.
    expect(LEGACY_TOOLS.cottages).toBeUndefined();
    expect(layerForTool('cottages')).toBeNull();
  });
});
