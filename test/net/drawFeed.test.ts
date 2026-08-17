import { describe, expect, it } from 'vitest';
import {
  feedDrawingToStrokes,
  feedStrokeToStroke,
  normalizeDrawing,
} from '../../src/net/drawFeed';

describe('feedStrokeToStroke', () => {
  it('converts bare [x, y] points to widthScale-1 triples', () => {
    const s = feedStrokeToStroke({ width: 6, pts: [[0.1, 0.2], [0.3, 0.4]] });
    expect(s).not.toBeNull();
    expect(s!.pts).toEqual([
      [0.1, 0.2, 1],
      [0.3, 0.4, 1],
    ]);
  });

  it('normalizes width against the 320px reference and clamps', () => {
    expect(feedStrokeToStroke({ width: 6, pts: [[0, 0]] })!.w).toBeCloseTo(6 / 320, 5);
    expect(feedStrokeToStroke({ width: 1000, pts: [[0, 0]] })!.w).toBeCloseTo(0.12, 5);
    expect(feedStrokeToStroke({ width: 0.1, pts: [[0, 0]] })!.w).toBeCloseTo(0.012, 5);
  });

  it('clamps coordinates into [0,1] and drops malformed points', () => {
    const s = feedStrokeToStroke({
      pts: [[-0.5, 1.5], [Number.NaN, 0.5] as [number, number], [0.5, 0.5]],
    });
    expect(s!.pts).toEqual([
      [0, 1, 1],
      [0.5, 0.5, 1],
    ]);
  });

  it('returns null for empty or fully malformed strokes', () => {
    expect(feedStrokeToStroke({ pts: [] })).toBeNull();
    expect(feedStrokeToStroke({ pts: [[Number.NaN, Number.NaN] as [number, number]] })).toBeNull();
  });
});

describe('normalizeDrawing', () => {
  const drawing = {
    strokes: [{ width: 6, pts: [[0.2, 0.2], [0.8, 0.8]] as [number, number][] }],
  };

  it('uses the wire id when present, stringified', () => {
    expect(normalizeDrawing({ ...drawing, id: 42 })!.id).toBe('42');
  });

  it('derives a deterministic content id when absent', () => {
    const a = normalizeDrawing(drawing)!.id;
    const b = normalizeDrawing(drawing)!.id;
    expect(a).toBe(b);
    expect(a).toMatch(/^d[0-9a-z]+$/);
    const other = normalizeDrawing({
      strokes: [{ pts: [[0.1, 0.9]] as [number, number][] }],
    })!.id;
    expect(other).not.toBe(a);
  });

  it('lowercases names and nulls empty ones', () => {
    expect(normalizeDrawing({ ...drawing, name: '  Robin ' })!.name).toBe('robin');
    expect(normalizeDrawing({ ...drawing, name: '   ' })!.name).toBeNull();
    expect(normalizeDrawing(drawing)!.name).toBeNull();
  });

  it('passes each of the five personality values through', () => {
    for (const p of ['friends', 'snacks', 'sleep', 'adventure', 'chaos'] as const) {
      expect(normalizeDrawing({ ...drawing, personality: p })!.personality).toBe(p);
    }
  });

  it('nulls unknown personality values', () => {
    expect(normalizeDrawing({ ...drawing, personality: 'world-domination' })!.personality).toBeNull();
    expect(normalizeDrawing({ ...drawing, personality: 'Friends' })!.personality).toBeNull();
    expect(normalizeDrawing({ ...drawing, personality: '' })!.personality).toBeNull();
    expect(normalizeDrawing({ ...drawing, personality: 42 as never })!.personality).toBeNull();
  });

  it('nulls absent personality (older phone pages)', () => {
    expect(normalizeDrawing(drawing)!.personality).toBeNull();
    expect(normalizeDrawing({ ...drawing, personality: null })!.personality).toBeNull();
  });

  it('returns null for drawings with no usable strokes', () => {
    expect(normalizeDrawing({ strokes: [] })).toBeNull();
    expect(normalizeDrawing({ strokes: [{ pts: [] }] })).toBeNull();
  });

  it('drops empty strokes but keeps the rest', () => {
    const d = normalizeDrawing({
      strokes: [{ pts: [] }, { width: 6, pts: [[0.5, 0.5]] as [number, number][] }],
    });
    expect(d!.strokes).toHaveLength(1);
  });
});

describe('feedDrawingToStrokes', () => {
  it('handles a missing strokes array', () => {
    expect(feedDrawingToStrokes({ strokes: undefined as never })).toEqual([]);
  });
});
