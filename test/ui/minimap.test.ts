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
 *
 * THE PAINTED BODY (2026-09-16). The bottom half of this file covers the
 * `ghibli` style's coloured map body: the pure region read (`bodyKindAt`,
 * derived from the coast's own signed field so it follows an island that
 * moves or grows), the sampled grid and its raster, the cache — one repaint
 * per map revision, one blit per frame — and both map sizes. And then the
 * other half of that bargain: a GOLDEN op sequence for the `ink` map, which
 * is the public world's and has to stay exactly the map that shipped.
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
  BODY_CELL_PX,
  BODY_COLORS,
  BODY_GRID_MIN,
  bodyGridRes,
  bodyGridRgba,
  bodyKindAt,
  groundLookTarget,
  installWorldMinimap,
  mapPalette,
  mapToWorld,
  partitionInhabitants,
  sampleBodyGrid,
  SEA_MID_RUN,
  SEA_SHALLOW_RUN,
  selfMark,
  subsample,
  WORLD_MAP_EXTENT,
  worldMapExtent,
  type BodyKind,
  type Inhabitant,
} from '../../src/ui/minimap';
import { CHARACTER, GHIBLI, SURFACE, WORLD } from '../../src/taste/tokens';
import {
  BEACH_WIDTH,
  WATER_BODIES,
  coastInland,
  coastOutline,
  islandOutline,
  mapScale,
  setIslandMode,
  setLandscapeMode,
  waterOutline,
} from '../../src/world/landscape';

/* The island is the katamari world's map and ships OFF (src/world/game.ts).
 * The sea over the whole field and the coast drawn back over it are what this
 * file measures, so it switches the island on with the mode and puts both
 * back — the plain-mode block below is unaffected either way. */
beforeAll(() => {
  setLandscapeMode('landscape');
  setIslandMode(true);
});
afterAll(() => {
  setLandscapeMode('plain');
  setIslandMode(false);
});

const frame: MapFrame = { w: 200, h: 200, inset: 14 };

describe('fixed world extent', () => {
  it('covers the scattered region (±160) with breathing room', () => {
    // The field scaled up with the spread-out layout (2026-09-03): scatter
    // reaches ±160 and the range runs out to z ≈ -147, so the map has to.
    expect(WORLD_MAP_EXTENT).toBeGreaterThanOrEqual(160);
    expect(WORLD_MAP_EXTENT).toBeLessThanOrEqual(220);
    // …and the extent actually drawn rides the map's own scale
    // (src/world/landscape.ts `MAP_SCALE`), so a map of a wider island still
    // contains it: 203.5 against a coast that reaches 193.88 at scale 1.1.
    // `toBeCloseTo`, because 1.1 is not an exact binary float.
    expect(worldMapExtent()).toBeCloseTo(WORLD_MAP_EXTENT * mapScale(), 9);
  });
});

describe('mapToWorld', () => {
  it('is the inverse of the phone worldToMap under the fixed extent', () => {
    for (const [x, z] of [
      [0, 0],
      [37.5, -88],
      [-worldMapExtent(), worldMapExtent()],
      [12.4, 12.4],
    ] as const) {
      const at = worldToMap(x, z, worldMapExtent(), frame);
      const back = mapToWorld(at.px, at.py, worldMapExtent(), frame);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.z).toBeCloseTo(z, 6);
    }
  });

  it('maps the frame center to the world origin', () => {
    const at = mapToWorld(frame.w / 2, frame.h / 2, worldMapExtent(), frame);
    expect(at.x).toBeCloseTo(0);
    expect(at.z).toBeCloseTo(0);
  });

  it('survives a degenerate frame', () => {
    const tiny: MapFrame = { w: 10, h: 10, inset: 5 };
    const at = mapToWorld(5, 5, worldMapExtent(), tiny);
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
    const at = worldToMap(0, 0, worldMapExtent(), frame);
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
        expect(Math.abs(x)).toBeLessThan(worldMapExtent());
        expect(Math.abs(z)).toBeLessThan(worldMapExtent());
        const at = worldToMap(x, z, worldMapExtent(), frame);
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

/** One painted-body blit onto the map canvas. */
interface ImageCall {
  res: number;
  w: number;
  h: number;
  smoothing: boolean;
}

/** One repaint of the offscreen body raster — the thing the cache exists to
 * make rare. */
interface RasterCall {
  res: number;
  data: Uint8ClampedArray;
}

interface Draws {
  fills: FillCall[];
  strokes: StrokeCall[];
  images: ImageCall[];
  rasters: RasterCall[];
  /** The op sequence, for the ink golden: `fill:<style>` / `stroke:<style>` /
   * `image`, in the order the map asked for them. */
  ops: string[];
  /** How many canvases the map created — one is the map itself; a second is
   * the offscreen body. */
  canvases: number;
}

function emptyDraws(): Draws {
  return { fills: [], strokes: [], images: [], rasters: [], ops: [], canvases: 0 };
}

/** A 2d context that records the paths it is asked to fill, in the
 * coordinates they were handed in (no transform is applied — the map's only
 * transform is its ambient drift, which is a translate). */
function recordingCtx(draws: Draws): CanvasRenderingContext2D {
  const fills = draws.fills;
  const strokes = draws.strokes;
  let path: [number, number][] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    imageSmoothingEnabled: true,
    setTransform(): void {},
    clearRect(): void {},
    translate(): void {},
    save(): void {},
    restore(): void {},
    clip(): void {},
    drawImage(source: { width: number }, _x: number, _y: number, w: number, h: number): void {
      draws.images.push({
        res: source.width,
        w,
        h,
        smoothing: Boolean(ctx.imageSmoothingEnabled),
      });
      draws.ops.push('image');
    },
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
      draws.ops.push(`fill:${String(ctx.fillStyle)}`);
    },
    stroke(): void {
      strokes.push({
        style: String(ctx.strokeStyle),
        width: Number(ctx.lineWidth),
        points: [...path],
      });
      draws.ops.push(`stroke:${String(ctx.strokeStyle)}`);
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** The OFFSCREEN canvas the painted body is rastered into: it only ever gets
 * `createImageData` + `putImageData`, and every call is one repaint. */
function stubOffscreen(draws: Draws): Record<string, unknown> {
  const surface: Record<string, unknown> = { width: 0, height: 0 };
  surface.getContext = (): Record<string, unknown> => ({
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (image: { width: number; data: Uint8ClampedArray }): void => {
      draws.rasters.push({ res: image.width, data: image.data.slice() });
    },
  });
  return surface;
}

/** Enough DOM for installWorldMinimap: the map canvas, an offscreen canvas
 * for the painted body, a head to hang a style off, a visibility flag, and a
 * rAF that fires exactly once per driven frame. */
function stubDom(
  draws: Draws,
  size = 200,
): { draw: (now?: number) => void; restore: () => void } {
  const canvas = {
    className: '',
    width: 0,
    height: 0,
    style: {},
    setAttribute(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
    remove(): void {},
    getBoundingClientRect: () => ({ width: size, height: size, left: 0, top: 0 }),
    getContext: () => recordingCtx(draws),
  };
  let frame: FrameRequestCallback | null = null;
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
    createElement: (tag: string) => {
      if (tag !== 'canvas') return { id: '', textContent: '', style: {} };
      draws.canvases += 1;
      // The FIRST canvas is the map; anything after it is the body raster.
      return draws.canvases === 1 ? canvas : stubOffscreen(draws);
    },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  globals.window = { devicePixelRatio: 1 };
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    frame = cb;
    return 1;
  };
  globals.cancelAnimationFrame = (): void => {};
  return {
    // Drive one frame, past the throttle.
    draw: (now = 1000): void => {
      const cb = frame;
      frame = null;
      cb?.(now);
    },
    restore: (): void => {
      globals.document = before.document;
      globals.window = before.window;
      globals.requestAnimationFrame = before.raf;
      globals.cancelAnimationFrame = before.caf;
    },
  };
}

interface DrawOpts {
  positions?: Inhabitant[];
  self?: () => { x: number; z: number } | null;
  /** The LOOK. Absent is `ink` — the shipped map. */
  style?: () => 'ink' | 'ghibli';
  /** The map's own inset size in CSS px (phone vs projection). */
  size?: number;
  /** How many throttled frames to drive. */
  frames?: number;
  /** The scatter handle, for the body cache's revision. */
  scatter?: {
    positions(): { x: number; z: number }[];
    rebuildVersion?(): number;
  };
}

/** N frames of the real map against the recording context. */
function drawFrames(opts: DrawOpts = {}): Draws {
  const draws = emptyDraws();
  const dom = stubDom(draws, opts.size ?? 200);
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
    ...(opts.style ? { style: opts.style } : {}),
    ...(opts.scatter ? { scatter: opts.scatter } : {}),
  });
  const count = Math.max(1, opts.frames ?? 1);
  for (let i = 0; i < count; i++) dom.draw(1000 * (i + 1));
  handle.dispose();
  dom.restore();
  return draws;
}

/** One frame — the shape the drawn tests below were written against. */
function drawOnce(opts: DrawOpts = {}): { fills: FillCall[]; strokes: StrokeCall[] } {
  const draws = drawFrames(opts);
  return { fills: draws.fills, strokes: draws.strokes };
}

describe('the map draws the water and the coast', () => {
  it('fills the lake in the water value, with nothing standing in it', () => {
    const { fills } = drawOnce();

    const scale = mapMarkScale(200);
    const mapFrame: MapFrame = { w: 200, h: 200, inset: mapBorderInset(scale) + 5 * scale };
    const project = (poly: readonly [number, number][]): [number, number][] =>
      poly.map(([x, z]) => {
        const at = worldToMap(x, z, worldMapExtent(), mapFrame);
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
    // The SEA first (2026-09-15, the map became an island): one fill over the
    // whole field, so the map reads as water with land drawn on it. Then one
    // water fill per body, and the lake's is its OUTER shore — nothing is cut
    // out of it on the map.
    expect(water).toHaveLength(WATER_BODIES.length + 1);
    expect(matches(water[1]!, waterOutline(lake))).toBe(true);

    // …and NOTHING is drawn back over it: the lake on the island map has no
    // islet in it (2026-09-17, user ask — src/world/landscape.ts
    // `LAKE_ISLET_ON_ISLAND`), so the only ground fill on the map is the
    // island's own coast. The authored map's islet is painted in the block at
    // the bottom of this file.
    expect(islandOutline(lake)).toBeNull();
    const ground = fills.filter((f) => f.style === SURFACE.ground);
    // The paper, and the coast back over the sea. No third.
    expect(ground).toHaveLength(2);
    expect(matches(ground[1]!, coastOutline())).toBe(true);
  });

  it('draws the sea over the whole field with the island back over it', () => {
    // The lake island's treatment, inverted: the ocean is the default and the
    // land is the shape on it. Two marks, a fill and a hairline — the mark set
    // does not grow (TASTE §4).
    const { fills, strokes } = drawOnce();

    const scale = mapMarkScale(200);
    const mapFrame: MapFrame = { w: 200, h: 200, inset: mapBorderInset(scale) + 5 * scale };
    const coast = coastOutline().map(([x, z]) => {
      const at = worldToMap(x, z, worldMapExtent(), mapFrame);
      return [at.px, at.py] as [number, number];
    });

    const water = fills.filter((f) => f.style === WORLD.neutralMid);
    // The sea is the FIRST water fill and it is the field itself — the border
    // loop, not a body's outline — so it covers the whole map.
    const sea = water[0]!;
    expect(sea.points.length).toBeGreaterThan(8);
    expect(sea.points.length).not.toBe(coastOutline().length);

    // …and the island is filled back over it in the ground value, on the
    // coast's own polygon, with a hairline round it.
    const land = fills.filter(
      (f) =>
        f.style === SURFACE.ground &&
        f.points.length === coast.length &&
        f.points.every(
          ([x, y], i) => Math.abs(x - coast[i]![0]) < 1e-6 && Math.abs(y - coast[i]![1]) < 1e-6,
        ),
    );
    expect(land).toHaveLength(1);
    expect(fills.indexOf(land[0]!)).toBeGreaterThan(fills.indexOf(sea));
    expect(
      strokes.some(
        (st) =>
          st.style === WORLD.ink &&
          st.points.length === coast.length &&
          st.points.every(
            ([x, y], i) => Math.abs(x - coast[i]![0]) < 1e-6 && Math.abs(y - coast[i]![1]) < 1e-6,
          ),
      ),
    ).toBe(true);
    // The island is inside the mapped square, so the coast really is drawn
    // rather than clipped away.
    for (const [x, z] of coastOutline()) {
      expect(Math.abs(x)).toBeLessThan(worldMapExtent());
      expect(Math.abs(z)).toBeLessThan(worldMapExtent());
    }
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
    // is icon + ruleLine + border), so a plain world leaves the paper alone —
    // the SEA included: the plain mode has no coast, so the map of it is not
    // a map of an island.
    expect(fills.filter((f) => f.style === WORLD.neutralMid)).toHaveLength(0);
    // …and no body's outline slipped onto it either. The islet's ring is the
    // one that is null on this map (2026-09-17 — `LAKE_ISLET_ON_ISLAND`), so
    // the shape to look for is the lake's own.
    const lake = WATER_BODIES[0]!;
    expect(islandOutline(lake)).toBeNull();
    const outer = waterOutline(lake);
    for (const f of fills) {
      expect(f.points.length, 'an outline slipped onto the plain map').not.toBe(outer.length);
    }
    // …and it really is the same map otherwise: the field is still drawn.
    expect(fills.some((f) => f.style === SURFACE.ground)).toBe(true);
    // Checked against the mapped world, so this is a difference and not an
    // empty recorder.
    expect(drawOnce().fills.filter((f) => f.style === WORLD.neutralMid)).toHaveLength(
      WATER_BODIES.length + 1,
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
    worldToMap(x, z, worldMapExtent(), mapFrame);
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

// ── the painted body, on the ghibli style only ───────────────────────────────

/**
 * Where the coast is, along one bearing, by bisection on the island's OWN
 * signed field (`coastInland`).
 *
 * Derived rather than written down on purpose: another change is doubling the
 * island's radius, and a test that knew where the shore was would be a test of
 * the old map. This one follows whatever the coast is.
 */
function coastRadiusAt(theta: number): number {
  let lo = 0;
  let hi = 4000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (coastInland(Math.cos(theta) * mid, Math.sin(theta) * mid) >= 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** `d` units past the waterline along `theta` — negative is inland. */
function offCoast(theta: number, d: number): { x: number; z: number } {
  const r = coastRadiusAt(theta) + d;
  return { x: Math.cos(theta) * r, z: Math.sin(theta) * r };
}

describe('bodyKindAt reads the landscape', () => {
  it('paints the sea in three bands off the coast', () => {
    for (const theta of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const shallow = offCoast(theta, 3);
      const mid = offCoast(theta, (SEA_SHALLOW_RUN + SEA_MID_RUN) / 2);
      const deep = offCoast(theta, SEA_MID_RUN + 10);
      // Sanity: these really are outside the coast, by the map's own query.
      expect(coastInland(shallow.x, shallow.z)).toBeLessThan(0);
      expect(bodyKindAt(shallow.x, shallow.z)).toBe('seaShallow');
      expect(bodyKindAt(mid.x, mid.z)).toBe('seaMid');
      expect(bodyKindAt(deep.x, deep.z)).toBe('deep');
    }
  });

  it('rings the coast in sand, outside the meadow', () => {
    for (const theta of [0, Math.PI / 2]) {
      const beach = offCoast(theta, -3);
      const inland = offCoast(theta, -30);
      // The landscape's own beach label reaches half of BEACH_WIDTH inland,
      // so 3 units in is sand and 30 is not.
      expect(coastInland(beach.x, beach.z)).toBeLessThan(BEACH_WIDTH);
      expect(bodyKindAt(beach.x, beach.z)).toBe('sand');
      expect(bodyKindAt(inland.x, inland.z)).toBe('meadow');
    }
  });

  it('takes the forest and the range from the map, not from a new threshold', () => {
    // Two bearings the authored layout puts a wood and a range on — read off
    // `sampleLandscape().region`, which is the only thing that decides it.
    //
    // The probe walks INLAND by a share of the island, not a count of units
    // (2026-09-16, `MAP_SCALE` in src/world/landscape.ts): the features move
    // out with the coast, so a fixed 30 units in on a wider island lands in
    // the open plain outside the western stand rather than inside it.
    const inland = -30 * mapScale();
    const wood = offCoast(Math.PI, inland);
    expect(bodyKindAt(wood.x, wood.z)).toBe('forest');
    const range = offCoast(-Math.PI / 2, inland);
    expect(bodyKindAt(range.x, range.z)).toBe('mountain');
  });

  it('paints a pond in the water value, and the lake all the way across', () => {
    const pond = WATER_BODIES.find((b) => b.kind === 'pond')!;
    expect(bodyKindAt(pond.x, pond.z)).toBe('water');
    // THE LAKE HAS NO ISLAND IN IT on this map (2026-09-17, user ask —
    // src/world/landscape.ts `LAKE_ISLET_ON_ISLAND`), so its centre is water
    // like the rest of it, and so is the spot the authored islet stood on.
    const lake = WATER_BODIES.find((b) => b.kind === 'lake')!;
    expect(lake.island).toBeUndefined();
    expect(bodyKindAt(lake.x, lake.z)).toBe('water');
    expect(bodyKindAt(72 * mapScale(), 62 * mapScale())).toBe('water');
  });

  it('paints the authored lake island back in meadow with the island off', () => {
    // The authored map — the public world's and meridian's — still has the
    // islet, and the body has always shown it: its centre is land, so green.
    setIslandMode(false);
    try {
      const lake = WATER_BODIES.find((b) => b.kind === 'lake' && b.island)!;
      expect(bodyKindAt(lake.island!.x, lake.island!.z)).toBe('meadow');
      // …with water round it. (Not the lake's own centre: the authored islet
      // stands 11.3 units off it, inside its own 14-unit radius, so the
      // centre of that lake is the islet.)
      expect(bodyKindAt(lake.x + lake.r * 0.6, lake.z)).toBe('water');
    } finally {
      setIslandMode(true);
    }
  });

  it('has no sea at all with the island off', () => {
    // The island is the katamari world's (src/world/game.ts). Every other
    // world's map has lakes and no ocean, and the body has to say so.
    const outside = offCoast(0, 40);
    setIslandMode(false);
    try {
      expect(bodyKindAt(outside.x, outside.z)).toBe('meadow');
      expect(bodyKindAt(0, 0)).toBe('meadow');
    } finally {
      setIslandMode(true);
    }
  });

  it('draws only GHIBLI tokens — no colour was invented for the map', () => {
    const tokens = new Set<unknown>(Object.values(GHIBLI));
    for (const [kind, hex] of Object.entries(BODY_COLORS)) {
      expect(tokens.has(hex), `${kind} is not a GHIBLI token`).toBe(true);
    }
  });
});

describe('the body grid', () => {
  const gridFrame: MapFrame = { w: 264, h: 264, inset: 14 };

  it('scales to the map and floors at one cell a pixel on a handset', () => {
    // The projection's biggest inset and the phone's smallest.
    expect(bodyGridRes(264)).toBe(Math.round(264 / BODY_CELL_PX));
    expect(bodyGridRes(96)).toBe(BODY_GRID_MIN);
    expect(bodyGridRes(0)).toBe(BODY_GRID_MIN);
  });

  it('samples every cell and puts the sea at the corners', () => {
    const res = bodyGridRes(264);
    const kinds = sampleBodyGrid(res, gridFrame, worldMapExtent());
    expect(kinds).toHaveLength(res * res);
    // The map is a map of an island: the corners are open water.
    for (const [i, j] of [
      [0, 0],
      [res - 1, 0],
      [0, res - 1],
      [res - 1, res - 1],
    ] as const) {
      expect(kinds[j * res + i]).toBe('deep');
    }
    // …and the middle of it is land.
    const mid = Math.floor(res / 2);
    expect(kinds[mid * res + mid]).toBe('meadow');
  });

  it('puts a pond where the landscape puts one, with a pale rim round it', () => {
    const res = bodyGridRes(264);
    const kinds = sampleBodyGrid(res, gridFrame, worldMapExtent());
    const pond = WATER_BODIES.find((b) => b.kind === 'pond')!;
    const at = worldToMap(pond.x, pond.z, worldMapExtent(), gridFrame);
    const i = Math.floor((at.px / gridFrame.w) * res);
    const j = Math.floor((at.py / gridFrame.h) * res);
    const kind = kinds[j * res + i]!;
    expect(['water', 'waterRim']).toContain(kind);
    expect([BODY_COLORS.water, BODY_COLORS.waterRim]).toContain(BODY_COLORS[kind]);
    // The rim exists: a still body's cells that touch dry land are promoted.
    expect(kinds.filter((k) => k === 'waterRim').length).toBeGreaterThan(0);
    // …and the open sea is still out there, unrimmed: its own light band off
    // the coast is the shore mark, so the rim never appears at sea.
    expect(kinds.filter((k) => k === 'deep').length).toBeGreaterThan(0);
  });

  it('rasters one opaque RGBA cell per kind, off the token', () => {
    const kinds: BodyKind[] = ['deep', 'sand', 'meadow'];
    const data = bodyGridRgba(kinds);
    expect(data).toHaveLength(kinds.length * 4);
    kinds.forEach((kind, i) => {
      const hex = BODY_COLORS[kind];
      expect(data[i * 4]).toBe(parseInt(hex.slice(1, 3), 16));
      expect(data[i * 4 + 1]).toBe(parseInt(hex.slice(3, 5), 16));
      expect(data[i * 4 + 2]).toBe(parseInt(hex.slice(5, 7), 16));
      expect(data[i * 4 + 3]).toBe(255);
    });
  });
});

describe('the ghibli map draws the painted body', () => {
  const ghibliStyle = (): 'ghibli' => 'ghibli';

  it('blits one cached raster per frame, quantised, over the whole field', () => {
    const draws = drawFrames({ style: ghibliStyle, size: 264, frames: 3 });
    // One blit a frame…
    expect(draws.images).toHaveLength(3);
    for (const image of draws.images) {
      expect(image.res).toBe(bodyGridRes(264));
      expect(image.w).toBe(264);
      expect(image.h).toBe(264);
      // Nearest-neighbour: a cell is a flat fill, never a gradient.
      expect(image.smoothing).toBe(false);
    }
    // …off ONE repaint. The landscape sample is the expensive thing here and
    // it must not run 30 times a second.
    expect(draws.rasters).toHaveLength(1);
    expect(draws.rasters[0]!.res).toBe(bodyGridRes(264));
    // One canvas for the map, one offscreen for the body.
    expect(draws.canvases).toBe(2);
  });

  it('repaints when the map changes and not otherwise', () => {
    let version = 7;
    const scatter = {
      positions: (): { x: number; z: number }[] => [],
      rebuildVersion: (): number => version,
    };
    const draws = emptyDraws();
    const dom = stubDom(draws, 200);
    const handle = installWorldMinimap({
      manager: { positions: (): Inhabitant[] => [] },
      cameraRig: {
        azimuth: 0,
        frameAt: (): void => {},
        camera: {
          position: { x: 0, y: 40, z: 40 },
          getWorldDirection: (t: Vector3): Vector3 => t.set(0, -1, -1).normalize(),
        },
      },
      mount: { appendChild: (): void => {} } as unknown as HTMLElement,
      style: ghibliStyle,
      scatter,
    });
    dom.draw(1000);
    dom.draw(2000);
    expect(draws.rasters).toHaveLength(1);
    // A painted pond, a terrain dial and the landscape switch all end on a
    // scatter rebuild (src/dev/paint.ts, src/world/scene.ts), so the bump is
    // the map moving — and the body follows it.
    version = 8;
    dom.draw(3000);
    expect(draws.rasters).toHaveLength(2);
    // Island mode is the other switch, and it is not the scatter's.
    setIslandMode(false);
    try {
      dom.draw(4000);
    } finally {
      setIslandMode(true);
    }
    expect(draws.rasters).toHaveLength(3);
    // …and it really painted a different picture: no ocean this time.
    expect(draws.rasters[2]!.data).not.toEqual(draws.rasters[1]!.data);
    handle.dispose();
    dom.restore();
  });

  it('paints at the handset size too, at its own grid', () => {
    const phone = drawFrames({ style: ghibliStyle, size: 96 });
    expect(phone.images).toHaveLength(1);
    expect(phone.images[0]!.res).toBe(bodyGridRes(96));
    expect(phone.images[0]!.w).toBe(96);
    expect(phone.rasters).toHaveLength(1);
    expect(phone.rasters[0]!.data).toHaveLength(bodyGridRes(96) ** 2 * 4);
  });

  it('keeps the marks, in the style own ink, and drops the grey sea', () => {
    const draws = drawFrames({
      style: ghibliStyle,
      positions: [{ x: 0, z: 0, r: 1, kind: 'character' }],
    });
    // The grey paper sea and the grey lake fills are what the body replaced.
    expect(draws.fills.filter((f) => f.style === WORLD.neutralMid)).toHaveLength(0);
    // The coast keeps its hairline — in the style's own contour violet, over
    // a coloured body (TASTE §4: the mark set does not change, its value does).
    const scale = mapMarkScale(200);
    const mapFrame: MapFrame = { w: 200, h: 200, inset: mapBorderInset(scale) + 5 * scale };
    const coast = coastOutline().map(([x, z]) => {
      const at = worldToMap(x, z, worldMapExtent(), mapFrame);
      return [at.px, at.py] as [number, number];
    });
    expect(
      draws.strokes.some(
        (st) =>
          st.style === GHIBLI.ink &&
          st.points.length === coast.length &&
          st.points.every(
            ([x, y], i) => Math.abs(x - coast[i]![0]) < 1e-6 && Math.abs(y - coast[i]![1]) < 1e-6,
          ),
      ),
      'the coast lost its ink hairline',
    ).toBe(true);
    // Every still body keeps its drawn shore, and the lake's island keeps its
    // own — at least as many hairlines as the ink map draws.
    const shores = draws.strokes.filter((st) => st.style === GHIBLI.ink);
    expect(shores.length).toBeGreaterThanOrEqual(WATER_BODIES.length + 1);
    // The creature dots are untouched: near-black on the painted body.
    expect(draws.fills.some((f) => f.style === CHARACTER.body)).toBe(true);
    // The border takes the light value instead, because the paper under it is
    // a dark sea now (see the module header's measured contrast).
    const border = draws.strokes[draws.strokes.length - 1]!;
    expect(border.style).toBe(GHIBLI.foam);
    expect(border.width).toBeCloseTo(1.25, 6);
    expect(draws.strokes.filter((st) => st.style === WORLD.ink)).toHaveLength(0);
  });
});

// ── the ink map is the one that shipped ──────────────────────────────────────

describe('the ink map is byte-identical', () => {
  it('draws exactly the calls it always did, in the same order', () => {
    // The golden. Every one of these is the shipped map: the paper, the grey
    // sea, the island back over it, the lakes and their shores, the egg, the
    // creature dots, the camera wedge and diamond, you, and the frame.
    //
    // NO ISLET PAIR since 2026-09-17 (user ask — src/world/landscape.ts
    // `LAKE_ISLET_ON_ISLAND`): the lake on the island map has no island in it,
    // so the ground fill and hairline that used to be drawn back over its
    // water are gone and nothing else moved.
    const draws = drawFrames({
      positions: [
        { x: 20, z: 20, r: 1, kind: 'character' },
        { x: -40, z: 12, r: 1, kind: 'egg' },
      ],
      self: () => ({ x: 20, z: 20 }),
    });
    expect(draws.ops).toEqual([
      `fill:${SURFACE.ground}`,
      `fill:${WORLD.neutralMid}`,
      `fill:${SURFACE.ground}`,
      `stroke:${WORLD.ink}`,
      `fill:${WORLD.neutralMid}`,
      `stroke:${WORLD.ink}`,
      `fill:${WORLD.neutralMid}`,
      `stroke:${WORLD.ink}`,
      `fill:${WORLD.neutralMid}`,
      `stroke:${WORLD.ink}`,
      `fill:${WORLD.neutralMid}`,
      `stroke:${WORLD.ink}`,
      `fill:${WORLD.neutralMid}`,
      `stroke:${WORLD.ink}`,
      `fill:${WORLD.light}`,
      `stroke:${WORLD.ink}`,
      `fill:${CHARACTER.body}`,
      `stroke:${WORLD.ink}`,
      `stroke:${WORLD.ink}`,
      `fill:${CHARACTER.body}`,
      `stroke:${WORLD.light}`,
      `stroke:${WORLD.ink}`,
    ]);
  });

  it('paints no body: no second canvas, no blit, no raster', () => {
    const draws = drawFrames({ frames: 3 });
    expect(draws.images).toHaveLength(0);
    expect(draws.rasters).toHaveLength(0);
    // One canvas, the map's own. The offscreen body is never allocated on a
    // world that does not paint one.
    expect(draws.canvases).toBe(1);
  });

  it('draws every mark in WORLD.ink, border included', () => {
    expect(mapPalette('ink')).toEqual({ ink: WORLD.ink, border: WORLD.ink });
    expect(mapPalette('ghibli')).toEqual({ ink: GHIBLI.ink, border: GHIBLI.foam });
  });
});
