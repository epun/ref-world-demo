/**
 * World-minimap pure helpers: the fixed-extent world↔canvas mapping, the
 * egg/character partition of manager.positions(), deterministic prop
 * subsampling, and the ground look-target intersection. Imports the phone's
 * pure minimap helpers directly to prove the reuse compiles in node.
 *
 * …and one drawn test, against a recording 2d context: what the map puts on
 * the paper for the lake. That one is not a helper — it is the picture.
 *
 * THE MODE. The map draws water only where the world has water: the room
 * opens on a flat plain (src/world/landscape.ts `LandscapeMode`) and the
 * geography is revealed live. So the drawn tests run with the map on, and the
 * last one runs with it off and pins the empty paper.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  mapBorderInset,
  mapMarkScale,
  wavyBorderPoints,
  worldToMap,
  type MapFrame,
} from '../../src/phone/minimap';
import {
  groundLookTarget,
  installWorldMinimap,
  mapToWorld,
  partitionInhabitants,
  selfMark,
  subsample,
  WORLD_MAP_EXTENT,
  type Inhabitant,
} from '../../src/ui/minimap';
import { CHARACTER, SURFACE, WORLD } from '../../src/taste/tokens';
import {
  WATER_BODIES,
  islandOutline,
  setLandscapeMode,
  waterOutline,
} from '../../src/world/landscape';

beforeAll(() => setLandscapeMode('landscape'));
afterAll(() => setLandscapeMode('plain'));

const frame: MapFrame = { w: 200, h: 200, inset: 14 };

describe('fixed world extent', () => {
  it('covers the scattered region (±160) with breathing room', () => {
    // The field scaled up with the spread-out layout (2026-09-03): scatter
    // reaches ±160 and the range runs out to z ≈ -147, so the map has to.
    expect(WORLD_MAP_EXTENT).toBeGreaterThanOrEqual(160);
    expect(WORLD_MAP_EXTENT).toBeLessThanOrEqual(220);
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

describe('water on the map', () => {
  it('maps every pond and the lake inside the mapped square', () => {
    // The map draws the authored geography directly (no option, no rebuild) —
    // so the fixed extent has to actually contain it.
    for (const body of WATER_BODIES) {
      const poly = waterOutline(body);
      expect(poly.length).toBeGreaterThan(3);
      for (const [x, z] of poly) {
        expect(Math.abs(x)).toBeLessThan(WORLD_MAP_EXTENT);
        expect(Math.abs(z)).toBeLessThan(WORLD_MAP_EXTENT);
        const at = worldToMap(x, z, WORLD_MAP_EXTENT, frame);
        expect(at.px).toBeGreaterThan(0);
        expect(at.px).toBeLessThan(frame.w);
        expect(at.py).toBeGreaterThan(0);
        expect(at.py).toBeLessThan(frame.h);
      }
    }
  });
});

// ── the drawn map ────────────────────────────────────────────────────────────

interface FillCall {
  style: string;
  points: [number, number][];
}

interface StrokeCall {
  style: string;
  width: number;
  points: [number, number][];
}

/** A 2d context that records the paths it is asked to fill, in the
 * coordinates they were handed in (no transform is applied — the map's only
 * transform is its ambient drift, which is a translate). */
function recordingCtx(fills: FillCall[], strokes: StrokeCall[]): CanvasRenderingContext2D {
  let path: [number, number][] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    setTransform(): void {},
    clearRect(): void {},
    translate(): void {},
    save(): void {},
    restore(): void {},
    clip(): void {},
    beginPath(): void {
      path = [];
    },
    moveTo(x: number, y: number): void {
      path.push([x, y]);
    },
    lineTo(x: number, y: number): void {
      path.push([x, y]);
    },
    quadraticCurveTo(_cx: number, _cy: number, x: number, y: number): void {
      path.push([x, y]);
    },
    arc(x: number, y: number, r: number): void {
      // The radius matters for the self ring — it is the only mark whose
      // SIZE is the thing being asserted — so it rides along as a third
      // component the fill/stroke assertions simply ignore.
      path.push([x, y, r] as unknown as [number, number]);
    },
    closePath(): void {},
    fill(): void {
      fills.push({ style: String(ctx.fillStyle), points: [...path] });
    },
    stroke(): void {
      strokes.push({
        style: String(ctx.strokeStyle),
        width: Number(ctx.lineWidth),
        points: [...path],
      });
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** Enough DOM for installWorldMinimap: one canvas, a head to hang a style
 * off, a visibility flag, and a rAF that fires exactly once. */
function stubDom(
  fills: FillCall[],
  strokes: StrokeCall[],
): { draw: () => void; restore: () => void } {
  const canvas = {
    className: '',
    width: 0,
    height: 0,
    style: {},
    setAttribute(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
    remove(): void {},
    getBoundingClientRect: () => ({ width: 200, height: 200, left: 0, top: 0 }),
    getContext: () => recordingCtx(fills, strokes),
  };
  const frames: FrameRequestCallback[] = [];
  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    window: globals.window,
    raf: globals.requestAnimationFrame,
    caf: globals.cancelAnimationFrame,
  };
  globals.document = {
    hidden: false,
    head: { appendChild(): void {} },
    getElementById: () => null,
    createElement: (tag: string) =>
      tag === 'canvas' ? canvas : { id: '', textContent: '', style: {} },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  globals.window = { devicePixelRatio: 1 };
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    if (frames.length === 0) frames.push(cb);
    return 1;
  };
  globals.cancelAnimationFrame = (): void => {};
  return {
    // Drive one frame, past the throttle.
    draw: (): void => {
      frames[0]?.(1000);
    },
    restore: (): void => {
      globals.document = before.document;
      globals.window = before.window;
      globals.requestAnimationFrame = before.raf;
      globals.cancelAnimationFrame = before.caf;
    },
  };
}

/** One frame of the real map against the recording context. */
function drawOnce(
  opts: { positions?: Inhabitant[]; self?: () => { x: number; z: number } | null } = {},
): { fills: FillCall[]; strokes: StrokeCall[] } {
  const fills: FillCall[] = [];
  const strokes: StrokeCall[] = [];
  const dom = stubDom(fills, strokes);
  const handle = installWorldMinimap({
    manager: { positions: () => opts.positions ?? [] },
    cameraRig: {
      azimuth: 0,
      frameAt: (): void => {},
      camera: {
        position: { x: 0, y: 40, z: 40 },
        getWorldDirection: (t: Vector3): Vector3 => t.set(0, -1, -1).normalize(),
      },
    },
    mount: { appendChild: (): void => {} } as unknown as HTMLElement,
    ...(opts.self ? { self: opts.self } : {}),
  });
  dom.draw();
  handle.dispose();
  dom.restore();
  return { fills, strokes };
}

describe('the map draws an island in a lake', () => {
  it('fills the lake in the water value and the island back over it in ground', () => {
    const { fills } = drawOnce();

    const scale = mapMarkScale(200);
    const mapFrame: MapFrame = { w: 200, h: 200, inset: mapBorderInset(scale) + 5 * scale };
    const project = (poly: readonly [number, number][]): [number, number][] =>
      poly.map(([x, z]) => {
        const at = worldToMap(x, z, WORLD_MAP_EXTENT, mapFrame);
        return [at.px, at.py];
      });
    const matches = (call: FillCall, poly: readonly [number, number][]): boolean => {
      const want = project(poly);
      if (call.points.length !== want.length) return false;
      return call.points.every(
        ([x, y], i) => Math.abs(x - want[i]![0]!) < 1e-6 && Math.abs(y - want[i]![1]!) < 1e-6,
      );
    };

    const lake = WATER_BODIES[0]!;
    const water = fills.filter((f) => f.style === WORLD.neutralMid);
    // One water fill per body, and the lake's is its OUTER shore — nothing
    // is cut out of it on the map.
    expect(water).toHaveLength(WATER_BODIES.length);
    expect(matches(water[0]!, waterOutline(lake))).toBe(true);

    // …and the island is drawn back over it in the ground value, so the map
    // shows an island in a lake rather than a plain grey disc.
    const island = fills.filter(
      (f) => f.style === SURFACE.ground && matches(f, islandOutline(lake)!),
    );
    expect(island).toHaveLength(1);
    // Drawn AFTER the water it stands in.
    expect(fills.indexOf(island[0]!)).toBeGreaterThan(fills.indexOf(water[0]!));
  });
});

describe('the map of the plain world has no water on it', () => {
  it('draws no water fill and no island when the map is switched off', () => {
    setLandscapeMode('plain');
    let fills: FillCall[];
    try {
      fills = drawOnce().fills;
    } finally {
      setLandscapeMode('landscape');
    }
    // The one filled shape on the map is the water (TASTE §4 — the mark set
    // is icon + ruleLine + border), so a plain world leaves the paper alone.
    expect(fills.filter((f) => f.style === WORLD.neutralMid)).toHaveLength(0);
    const lake = WATER_BODIES[0]!;
    const island = islandOutline(lake)!;
    for (const f of fills) {
      expect(f.points.length, 'an outline slipped onto the plain map').not.toBe(island.length);
    }
    // …and it really is the same map otherwise: the field is still drawn.
    expect(fills.some((f) => f.style === SURFACE.ground)).toBe(true);
    // Checked against the mapped world, so this is a difference and not an
    // empty recorder.
    expect(drawOnce().fills.filter((f) => f.style === WORLD.neutralMid)).toHaveLength(
      WATER_BODIES.length,
    );
  });
});

// ── you, on the map ──────────────────────────────────────────────────────────

describe('selfMark', () => {
  const eggs: Inhabitant[] = [{ x: 12, z: -4, r: 1, kind: 'egg' }];

  it('is null when this view has no creature of its own', () => {
    // Every projection. A wall has no self, and the map is unchanged.
    expect(selfMark(null, eggs)).toBeNull();
    expect(selfMark(undefined, eggs)).toBeNull();
  });

  it('reports a hatched creature as not an egg', () => {
    expect(selfMark({ x: 40, z: 40 }, eggs)).toEqual({ x: 40, z: 40, egg: false });
  });

  it('recognises its own egg, so the ring goes round the shell', () => {
    expect(selfMark({ x: 12, z: -4 }, eggs)?.egg).toBe(true);
    // …through a float round trip, which is the only reason there is a
    // tolerance at all.
    expect(selfMark({ x: 12 + 1e-7, z: -4 - 1e-7 }, eggs)?.egg).toBe(true);
  });

  it('does not claim the egg somebody else left standing nearby', () => {
    expect(selfMark({ x: 13, z: -4 }, eggs)?.egg).toBe(false);
  });

  it('refuses a position that is not a position', () => {
    expect(selfMark({ x: Number.NaN, z: 0 }, eggs)).toBeNull();
    expect(selfMark({ x: 0, z: Number.POSITIVE_INFINITY }, eggs)).toBeNull();
  });
});

describe('the map draws where YOU are', () => {
  const scale = mapMarkScale(200);
  const mapFrame: MapFrame = { w: 200, h: 200, inset: mapBorderInset(scale) + 5 * scale };
  const at = (x: number, z: number): { px: number; py: number } =>
    worldToMap(x, z, WORLD_MAP_EXTENT, mapFrame);
  /** The light-valued rings on the frame. The knockout ring is the ONLY
   * thing on this map drawn in WORLD.light as a stroke — everything else
   * light is a fill (the eggs) or the ground. */
  const rings = (strokes: StrokeCall[]): StrokeCall[] =>
    strokes.filter((s) => s.style === WORLD.light);

  it('paints nothing extra when no self is given', () => {
    // The projection's map, unchanged. This is the control for every
    // assertion below.
    const { strokes } = drawOnce({
      positions: [{ x: 20, z: 20, r: 1, kind: 'character' }],
    });
    expect(rings(strokes)).toHaveLength(0);
  });

  it('rings your creature in the light value, over an ink dot', () => {
    const mine = { x: 20, z: 20 };
    const { fills, strokes } = drawOnce({
      positions: [
        { ...mine, r: 1, kind: 'character' },
        { x: -60, z: 30, r: 1, kind: 'character' },
      ],
      self: () => mine,
    });
    const ring = rings(strokes);
    expect(ring).toHaveLength(1);
    const point = ring[0]!.points[0]! as unknown as [number, number, number];
    const want = at(mine.x, mine.z);
    expect(point[0]).toBeCloseTo(want.px, 6);
    expect(point[1]).toBeCloseTo(want.py, 6);
    // Sized from the mark it is cut into rather than a picked px, so it
    // survives the smallest inset the map clamps to.
    expect(ring[0]!.width).toBeCloseTo(2.2 * 1.6 * 0.4 * scale, 6);

    // …over a bigger ink dot than the inhabitants around it. Two character
    // dots were drawn; the last one on this point is yours.
    const dots = fills.filter((f) => f.style === CHARACTER.body);
    expect(dots.length).toBeGreaterThanOrEqual(3);
    const self = dots[dots.length - 1]!.points[0]! as unknown as [number, number, number];
    const other = dots[0]!.points[0]! as unknown as [number, number, number];
    expect(self[0]).toBeCloseTo(want.px, 6);
    expect(self[2] / other[2]).toBeCloseTo(1.6, 6);
    // KNOCKED OUT of the disc, not drawn around it: a light ring on the
    // paper outside the dot is invisible — WORLD.light against
    // SURFACE.ground is a fifteenth of a stop — and against CHARACTER.body
    // it is the whole range. So it has to be inside the mark.
    expect(point[2]).toBeLessThan(self[2]);
    // …and it leaves a dark rim outside it rather than eating the mark.
    expect(point[2] + ring[0]!.width / 2).toBeLessThan(self[2]);
  });

  it('draws your EGG as a bigger SHELL, never as a creature', () => {
    const mine = { x: -40, z: 12 };
    const { fills, strokes } = drawOnce({
      positions: [{ ...mine, r: 1, kind: 'egg' }],
      self: () => mine,
    });
    expect(rings(strokes)).toHaveLength(1);
    // No near-black dot anywhere: a creature mark on the shell would say
    // it had already hatched.
    expect(fills.filter((f) => f.style === CHARACTER.body)).toHaveLength(0);
    // The shell is redrawn over the ordinary one at 1.6x. It has to be the
    // size that carries this, because a light ring on light paper carries
    // nothing: WORLD.light on SURFACE.ground is invisible at a hairline
    // and a half, which is exactly what the first build of it looked like.
    const shells = fills.filter((f) => f.style === WORLD.light);
    expect(shells).toHaveLength(2);
    const ordinary = shells[0]!.points[0]! as unknown as [number, number, number];
    const self = shells[1]!.points[0]! as unknown as [number, number, number];
    expect(self[2] / ordinary[2]).toBeCloseTo(1.6, 6);
  });

  it('draws you LAST, after every other mark', () => {
    const mine = { x: 0, z: 0 };
    const { strokes } = drawOnce({
      positions: [{ ...mine, r: 1, kind: 'character' }],
      self: () => mine,
    });
    // The border is stroked after the clip is released, and the ring is
    // inside it — so the ring is the last mark ON the map, and the frame
    // is still the last thing drawn.
    const ringIndex = strokes.findIndex((s) => s.style === WORLD.light);
    const inkStrokes = strokes.filter((s) => s.style === WORLD.ink);
    expect(ringIndex).toBeGreaterThan(strokes.indexOf(inkStrokes[0]!));
    expect(strokes.indexOf(inkStrokes[inkStrokes.length - 1]!)).toBeGreaterThan(ringIndex);
  });
});
