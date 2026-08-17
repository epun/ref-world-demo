/**
 * World-minimap pure helpers: the fixed-extent world↔canvas mapping, the
 * egg/character partition of manager.positions(), deterministic prop
 * subsampling, and the ground look-target intersection. Imports the phone's
 * pure minimap helpers directly to prove the reuse compiles in node.
 */

import { describe, expect, it } from 'vitest';
import {
  mapBorderInset,
  mapMarkScale,
  wavyBorderPoints,
  worldToMap,
  type MapFrame,
} from '../../src/phone/minimap';
import {
  groundLookTarget,
  mapToWorld,
  partitionInhabitants,
  subsample,
  WORLD_MAP_EXTENT,
  type Inhabitant,
} from '../../src/ui/minimap';

const frame: MapFrame = { w: 200, h: 200, inset: 14 };

describe('fixed world extent', () => {
  it('covers the scattered region (±120) with breathing room', () => {
    expect(WORLD_MAP_EXTENT).toBeGreaterThanOrEqual(120);
    expect(WORLD_MAP_EXTENT).toBeLessThanOrEqual(160);
  });
});

describe('mapToWorld', () => {
  it('is the inverse of the phone worldToMap under the fixed extent', () => {
    for (const [x, z] of [
      [0, 0],
      [37.5, -88],
      [-WORLD_MAP_EXTENT, WORLD_MAP_EXTENT],
      [12.4, 12.4],
    ] as const) {
      const at = worldToMap(x, z, WORLD_MAP_EXTENT, frame);
      const back = mapToWorld(at.px, at.py, WORLD_MAP_EXTENT, frame);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.z).toBeCloseTo(z, 6);
    }
  });

  it('maps the frame center to the world origin', () => {
    const at = mapToWorld(frame.w / 2, frame.h / 2, WORLD_MAP_EXTENT, frame);
    expect(at.x).toBeCloseTo(0);
    expect(at.z).toBeCloseTo(0);
  });

  it('survives a degenerate frame', () => {
    const tiny: MapFrame = { w: 10, h: 10, inset: 5 };
    const at = mapToWorld(5, 5, WORLD_MAP_EXTENT, tiny);
    expect(Number.isFinite(at.x)).toBe(true);
    expect(Number.isFinite(at.z)).toBe(true);
  });
});

describe('partitionInhabitants', () => {
  const items: Inhabitant[] = [
    { x: 1, z: 1, r: 1, kind: 'character' },
    { x: 2, z: 2, r: 1, kind: 'egg' },
    { x: 3, z: 3, r: 1, kind: 'character' },
    { x: 4, z: 4, r: 1, kind: 'egg' },
  ];

  it('splits eggs from characters', () => {
    const { characters, eggs } = partitionInhabitants(items);
    expect(characters.map((c) => c.x)).toEqual([1, 3]);
    expect(eggs.map((e) => e.x)).toEqual([2, 4]);
  });

  it('treats a missing kind as a character (older payloads stay drawable)', () => {
    const { characters, eggs } = partitionInhabitants([{ x: 9, z: 9, r: 1 }]);
    expect(characters.length).toBe(1);
    expect(eggs.length).toBe(0);
  });

  it('handles the empty world', () => {
    const { characters, eggs } = partitionInhabitants([]);
    expect(characters).toEqual([]);
    expect(eggs).toEqual([]);
  });
});

describe('subsample', () => {
  const items = Array.from({ length: 23 }, (_, i) => i);

  it('is deterministic — same input, same quiet field', () => {
    expect(subsample(items, 5)).toEqual(subsample(items, 5));
  });

  it('takes every strideth item starting at the first', () => {
    expect(subsample(items, 5)).toEqual([0, 5, 10, 15, 20]);
  });

  it('keeps everything at stride 1 and clamps silly strides', () => {
    expect(subsample(items, 1)).toEqual(items);
    expect(subsample(items, 0)).toEqual(items);
    expect(subsample(items, 0.4)).toEqual(items);
  });

  it('handles empty input', () => {
    expect(subsample([], 5)).toEqual([]);
  });
});

describe('groundLookTarget', () => {
  it('intersects the view ray with the ground plane', () => {
    // Camera above the origin at 45° down along -z.
    const inv = Math.SQRT1_2;
    const at = groundLookTarget(
      { x: 0, y: 10, z: 10 },
      { x: 0, y: -inv, z: -inv },
    );
    expect(at).not.toBeNull();
    expect(at!.x).toBeCloseTo(0);
    expect(at!.z).toBeCloseTo(0);
  });

  it('offsets stay in world units', () => {
    const at = groundLookTarget({ x: 5, y: 4, z: -3 }, { x: 0, y: -1, z: 0 });
    expect(at).toEqual({ x: 5, z: -3 });
  });

  it('returns null for a ray parallel to or leaving the ground', () => {
    expect(groundLookTarget({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
    expect(groundLookTarget({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull();
  });
});

describe('phone helper reuse', () => {
  it('the world map draws its border and marks with the phone helpers', () => {
    // The same wavering border loop, deterministic per seed…
    const a = wavyBorderPoints(200, 200, mapBorderInset(mapMarkScale(200)), 129.4);
    const b = wavyBorderPoints(200, 200, mapBorderInset(mapMarkScale(200)), 129.4);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    // …and the same uniform world→canvas projection.
    const at = worldToMap(0, 0, WORLD_MAP_EXTENT, frame);
    expect(at.px).toBeCloseTo(frame.w / 2);
    expect(at.py).toBeCloseTo(frame.h / 2);
  });
});
