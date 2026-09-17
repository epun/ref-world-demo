/**
 * World-view minimap (user ask: "in the world view include a mini map in the
 * bottom right hand corner").
 *
 * TASTE §4: UI is icons, hairline rules, thin borders — no filled panels.
 * The map field itself follows the phone precedent (screens/alive.ts): a
 * SURFACE.ground fill inside a deterministic hand-wavering border reads as
 * image, not chrome, and that shipped as on-taste. Everything on it is a
 * hairline mark:
 *
 * - the sea: the whole field filled WORLD.neutralMid, with the ISLAND drawn
 *   back over it in the ground value inside a hairline coast. That is the
 *   lake-island treatment inverted, and it is the same two marks — a fill and
 *   a hairline — so the mark set does not grow (TASTE §4). Drawn FIRST, under
 *   everything, because it is the paper the rest of the map stands on;
 * - water: the ponds and the lake, filled WORLD.neutralMid inside a hairline
 *   WORLD.ink shore, and then the lake's island drawn back over it in the
 *   ground value inside a hairline of its own — an island in a lake, which is
 *   what the world holds. This is the ONE filled shape on the map and it is
 *   not chrome — the world brief's own reference is "isometric village and
 *   mountain maps", and a lake drawn on a map is terrain, exactly like the
 *   prop marks beside it. The mark-set lint (TASTE §4) watches this file:
 *   nothing here has become a panel, a card, or a shadow. Drawn only in the
 *   landscape mode — the plain world the room opens on holds no water, and a
 *   map of it shows none;
 * - prop marks: sparse tiny WORLD.neutral dots, subsampled from the scatter
 *   so the map stays quiet (density is the design, TASTE §2.3);
 * - creatures: small CHARACTER.body dots — on a projection every creature is
 *   an inhabitant and they are all the same mark; eggs are WORLD.light
 *   circles with an ink hairline (unhatched reads lighter, like the shell);
 * - YOU, when this handset has a creature of its own (user ask, 2026-09-09:
 *   *"the mini map should show you where your character is in relation to the
 *   world"*): the same ink dot at 1.6x, inside a WORLD.light ring — drawn
 *   LAST, over everyone. PLAN §7.1 asks for a distinct self mark and the
 *   accent colour that would once have carried it is retired (TASTE §6), so
 *   the distinction is carried in the LIGHT value instead: a ring KNOCKED OUT
 *   of the disc — light middle, dark rim — which is what separates one
 *   near-black dot from the near-black dots around it. Cut into the mark
 *   rather than drawn around it, because light on the paper is a fifteenth
 *   of a stop and light on near-black is the whole range. A ring is a border
 *   mark (TASTE §4) — nothing new joins the mark set. An unhatched self is
 *   the same thing one state earlier: the SHELL at 1.6x, never a near-black
 *   dot, which would say it had already hatched;
 * - camera: a hairline diamond on the current look-target plus a subtle
 *   frustum wedge rotated by the rig azimuth, so panning and rotating stay
 *   legible on the map. Values are read live — the camera already springs,
 *   smoothing here would double-lag it.
 *
 * Clicking the map slides the camera to that world point through
 * cameraRig.frameAt (a t.primary reframe — never a snap). The whole canvas
 * micro-sways on the ambient drift floor: nothing fully arrests (TASTE §3).
 *
 * ── THE PAINTED BODY, on the `ghibli` style only (2026-09-16, user ask:
 * *"the mini map should update to be in the more colored style"*).
 *
 * On `valiocon` the world renders in the envpaint cel look (docs/TASTE.md §9)
 * and the grey paper-and-ink sketch above stopped being a map OF it. So on
 * that style — and on that style alone — the FIELD is painted from the
 * landscape's own region query, in the world's own colours: the sea in three
 * flat bands off the coast, the beach ring in sand, the meadow green, the
 * forest darker, the range in rock, the ponds and the lake in the water value
 * with a pale rim, and a painted trail in dirt. Flat fills off `GHIBLI`
 * tokens, quantised on a grid — a painted map, never a gradient.
 *
 * THE MARKS DO NOT CHANGE. The coast and the still-water shores keep their
 * hairlines, the props keep their dots, the creatures, the eggs, you and the
 * camera are the same marks in the same order (TASTE §4 — icon + ruleLine +
 * border, and the body is a fill on the paper exactly as the lake always
 * was). Only their VALUE moves, and only as far as it must to stay legible on
 * a coloured body: the interior marks take `GHIBLI.ink` (the style's own
 * violet-blue contour) and the BORDER takes `GHIBLI.foam`, because the paper
 * under it is now a dark sea rather than a light field — the same argument
 * the self ring already makes in this file, that a value is only a mark where
 * there is range under it. Measured: ink on sand is 10.6:1 and ink on the
 * deep sea is 1.2:1, foam on the deep sea is 12:1.
 *
 * On `ink` — the public world and every other one — nothing here runs and
 * the map is byte-identical (test/ui/minimap.test.ts pins the draw calls).
 *
 * Pure helpers (mapping, partitioning, subsampling, the body grid) live at
 * module top with no DOM use so test/ui can cover them in node; the border
 * loop and world→map projection are REUSED from src/phone/minimap.ts (also
 * pure).
 */

import { Vector3 } from 'three';
import { sampleDrift } from '../motion/ambient';
import {
  WATER_BODIES,
  coastInland,
  coastOutline,
  islandMode,
  mapScale,
  islandOutline,
  landscapeMode,
  sampleLandscape,
  waterOutline,
} from '../world/landscape';
import {
  mapBorderInset,
  mapMarkScale,
  wavyBorderPoints,
  worldToMap,
  type BorderPoint,
  type MapFrame,
} from '../phone/minimap';
import { CHARACTER, GHIBLI, SURFACE, WORLD } from '../taste/tokens';
import type { WorldStyle } from '../world/style';

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Fixed half-extent of the mapped world square — the scattered region plus
 * a little breathing room, so wanderers at the fringe stay on the map.
 *
 * 185 since the map became an island (2026-09-15): the coast reaches 176.3
 * units out at the south-east headland, and at 175 the map cut the corner off
 * it. A map of an island has to contain the island. */
export const WORLD_MAP_EXTENT = 185;

/**
 * …and the half-extent the map is actually drawn at: `WORLD_MAP_EXTENT`
 * through `mapScale` (2026-09-16) — 203.5 at scale 1.1, which holds that
 * coast's measured 193.88 with the same 17.5 units of breathing room the 185
 * above holds over 176.26, because both numbers ride the same factor. A map
 * of an island has to contain the island at any size, and on a world with no
 * island the two are the one number that shipped.
 */
export function worldMapExtent(): number {
  return WORLD_MAP_EXTENT * mapScale();
}

/** Inverse of worldToMap: canvas px → world x/z under the same uniform,
 * centered mapping. Lets a click land where the map says it will. */
export function mapToWorld(
  px: number,
  py: number,
  extent: number,
  frame: MapFrame,
): { x: number; z: number } {
  const safeExtent = extent > 0 ? extent : 1;
  const usable = Math.min(frame.w, frame.h) - frame.inset * 2;
  const scale = Math.max(0, usable) / (2 * safeExtent);
  if (scale === 0) return { x: 0, z: 0 };
  return { x: (px - frame.w / 2) / scale, z: (py - frame.h / 2) / scale };
}

/** Every `stride`th item, deterministically (index-based, no randomness):
 * the same scatter subsamples to the same quiet field on every device. */
export function subsample<T>(items: readonly T[], stride: number): T[] {
  const step = Math.max(1, Math.floor(stride));
  const out: T[] = [];
  for (let i = 0; i < items.length; i += step) out.push(items[i]!);
  return out;
}

export interface Inhabitant {
  x: number;
  z: number;
  r: number;
  /** Lifecycle kind; absent (older manager payloads) reads as a character. */
  kind?: 'egg' | 'character';
}

/** Split manager.positions() output into egg and character marks. */
export function partitionInhabitants(items: readonly Inhabitant[]): {
  characters: Inhabitant[];
  eggs: Inhabitant[];
} {
  const characters: Inhabitant[] = [];
  const eggs: Inhabitant[] = [];
  for (const item of items) {
    if (item.kind === 'egg') eggs.push(item);
    else characters.push(item);
  }
  return { characters, eggs };
}

/**
 * Which mark is yours, and whether it has hatched yet.
 *
 * The self reading is a world point — the creature manager's, read live —
 * and the marks are drawn from the same frame's `positions()`, so the match
 * is exact rather than a search: the tolerance is here only so that a
 * position which travelled through a float round trip still recognises
 * itself. Null when this view has no creature of its own (every projection)
 * or when the id has no live slot (it was retired, or has not spawned yet),
 * and the map draws exactly as it did before.
 */
export function selfMark(
  at: { x: number; z: number } | null | undefined,
  eggs: readonly Inhabitant[],
): { x: number; z: number; egg: boolean } | null {
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.z)) return null;
  const egg = eggs.some((e) => Math.abs(e.x - at.x) < 1e-3 && Math.abs(e.z - at.z) < 1e-3);
  return { x: at.x, z: at.z, egg };
}

/**
 * The camera's ground look-target from its pose: intersect the view ray with
 * the y=0 plane. Pure — the rig's internal target spring stays private, and
 * this reads the same point the frame actually looks at (drift included).
 */
export function groundLookTarget(
  position: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
): { x: number; z: number } | null {
  if (Math.abs(direction.y) < 1e-6) return null;
  const t = -position.y / direction.y;
  if (t < 0) return null;
  return { x: position.x + direction.x * t, z: position.z + direction.z * t };
}

// ── the painted body (the `ghibli` style only) ───────────────────────────────

/**
 * What ONE cell of the painted map body is.
 *
 * Every one of these is a region the landscape itself already answers for —
 * `sampleLandscape().region` for the land and the water bodies, `coastInland`
 * for how far out to sea a wet cell is, and the painted `path` weight for a
 * trail somebody laid. Nothing here re-derives a shoreline (CLAUDE.md: the
 * geography is authored in one place and every system samples it), and
 * nothing here knows how big the island is — so a coast that moves takes the
 * map with it.
 */
export type BodyKind =
  | 'deep'
  | 'seaMid'
  | 'seaShallow'
  | 'water'
  | 'waterRim'
  | 'sand'
  | 'meadow'
  | 'forest'
  | 'mountain'
  | 'path'
  | 'pathEdge';

/**
 * The body's palette — `GHIBLI` tokens only, and the SAME ones the world
 * renders those regions with, so the map is a small painting of the thing
 * rather than a second opinion about its colour:
 *
 * - the sea's three bands are `createSeaSurfaceMaterial`'s own deep / mid /
 *   shallow (src/world/ghibli/water.ts);
 * - a still body takes the lake shader's mid, and its rim the lake's own
 *   shallow — which is what "a pale rim" is on this palette;
 * - the land values are the ground shader's (src/world/ghibli/ground.ts):
 *   `sand` for the beach, `meadow`, `rock` on the range, `dirt`/`dirtEdge`
 *   for a trail and its edge band;
 * - the forest takes the canopy's SHADE green — the darker green the trees
 *   standing there are drawn in, not a fourth green invented for the map.
 *
 * No token is added: every colour the ask named already existed.
 */
export const BODY_COLORS: Readonly<Record<BodyKind, string>> = {
  deep: GHIBLI.waterTealDeep,
  seaMid: GHIBLI.waterTeal,
  seaShallow: GHIBLI.seaShallow,
  water: GHIBLI.waterTeal,
  waterRim: GHIBLI.waterShallow,
  sand: GHIBLI.sand,
  meadow: GHIBLI.meadow,
  forest: GHIBLI.canopyShade,
  mountain: GHIBLI.rock,
  path: GHIBLI.dirt,
  pathEdge: GHIBLI.dirtEdge,
};

/** Which kinds are wet — the rim pass below needs to know where water stops
 * being water, and the sea bands are water too. */
const WET_KINDS: ReadonlySet<BodyKind> = new Set<BodyKind>([
  'deep',
  'seaMid',
  'seaShallow',
  'water',
  'waterRim',
]);

/**
 * [D] How far out from the coast the sea's light band and its middle band
 * reach, world units.
 *
 * Read against the map's own scale rather than picked: the biggest inset is
 * 264px across 2·`WORLD_MAP_EXTENT` units, so a unit is about 0.64px there
 * and about 0.22px on the smallest phone map. 8 and 22 put the light band at
 * 5px and the middle at 9px on a projection, and at 1.8px and 3px on a
 * handset — three bands that still read as three at the size the map is
 * actually looked at.
 */
export const SEA_SHALLOW_RUN = 8;
export const SEA_MID_RUN = 22;

/**
 * Where a painted trail's core and its darker edge band start.
 *
 * Verbatim from the ghibli ground's own quantize (`pathEdge`/`pathCore` in
 * src/world/ghibli/ground.ts): the map cuts the trail at the same two weights
 * the ground does, so a path is the same width on both.
 */
const PATH_CORE_IN = 0.45;
const PATH_EDGE_IN = 0.15;

/**
 * The body kind at a world point.
 *
 * Order matters and it is the ground shader's, not a new one: water first
 * (nothing grows on it), then a painted trail over whatever it crosses, then
 * the landscape's own dominant `region` label. Using `region` rather than
 * re-thresholding the soft weights is deliberate — the map then says beach,
 * forest and mountain exactly where the world does.
 */
export function bodyKindAt(x: number, z: number): BodyKind {
  const s = sampleLandscape(x, z);
  if (s.region === 'water') {
    // Sea or a still body? The island's own signed field answers it: negative
    // is outside the coast, which is the one place the sea can be. With the
    // island off there is no sea at all, so every wet cell is a body.
    const inland = islandMode() ? coastInland(x, z) : Number.POSITIVE_INFINITY;
    if (inland >= 0) return 'water';
    if (inland > -SEA_SHALLOW_RUN) return 'seaShallow';
    if (inland > -SEA_MID_RUN) return 'seaMid';
    return 'deep';
  }
  const path = s.planting.path;
  if (path >= PATH_CORE_IN) return 'path';
  if (path >= PATH_EDGE_IN) return 'pathEdge';
  switch (s.region) {
    case 'beach':
      return 'sand';
    case 'forest':
      return 'forest';
    case 'mountain':
      return 'mountain';
    // 'plain' and 'island' are both plain land: the meadow, and the green
    // island standing in the lake.
    default:
      return 'meadow';
  }
}

/**
 * [D] Body grid: CSS px a cell, and the floor and ceiling on the grid itself.
 *
 * A cell is the unit of a FLAT FILL — the body is quantised by construction,
 * which is what keeps it a painted map instead of a photograph. Two px a cell
 * is the coarsest that still draws the beach ring (about 7 world units, so 4px
 * at the largest inset) as a band rather than a dotted line, and the floor of
 * 96 cells takes the phone map down to one cell a pixel, where two would have
 * left the ring a cell and a half wide. The ceiling is a cost guard, not a
 * look: the sample is `sampleLandscape` per cell and 192² of them is about a
 * third of a second.
 */
export const BODY_CELL_PX = 2;
export const BODY_GRID_MIN = 96;
export const BODY_GRID_MAX = 192;

export function bodyGridRes(px: number): number {
  const asked = Math.round(Math.max(0, px) / BODY_CELL_PX);
  return Math.max(BODY_GRID_MIN, Math.min(BODY_GRID_MAX, asked));
}

/**
 * Sample the landscape onto a `res`×`res` grid over the map's own frame —
 * row-major, `res * res` cells, each read at its cell CENTRE through the same
 * `mapToWorld` a click uses, so the body and the marks on it cannot disagree
 * about where a point is.
 *
 * Then the pale rim: a still body's cell that touches dry land is promoted to
 * `waterRim`. A neighbour test rather than a distance field, because at one
 * or two px a cell that IS the shoreline — and it costs one pass over a grid
 * that is already in memory. The sea gets no rim: its light band off the
 * coast is the same mark, and the coast keeps its own hairline besides.
 */
export function sampleBodyGrid(res: number, frame: MapFrame, extent: number): BodyKind[] {
  const n = Math.max(1, Math.floor(res));
  const kinds: BodyKind[] = new Array<BodyKind>(n * n);
  for (let j = 0; j < n; j++) {
    const py = ((j + 0.5) / n) * frame.h;
    for (let i = 0; i < n; i++) {
      const px = ((i + 0.5) / n) * frame.w;
      const at = mapToWorld(px, py, extent, frame);
      kinds[j * n + i] = bodyKindAt(at.x, at.z);
    }
  }
  const out = kinds.slice();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (kinds[k] !== 'water') continue;
      const dry =
        (i > 0 && !WET_KINDS.has(kinds[k - 1]!)) ||
        (i + 1 < n && !WET_KINDS.has(kinds[k + 1]!)) ||
        (j > 0 && !WET_KINDS.has(kinds[k - n]!)) ||
        (j + 1 < n && !WET_KINDS.has(kinds[k + n]!));
      if (dry) out[k] = 'waterRim';
    }
  }
  return out;
}

/** `#rrggbb` → the three bytes, for the raster below. */
function bodyRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** One RGBA byte per channel per cell, opaque — ready for `putImageData`. */
export function bodyGridRgba(kinds: readonly BodyKind[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(kinds.length * 4);
  const cache = new Map<BodyKind, [number, number, number]>();
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!;
    let rgb = cache.get(kind);
    if (!rgb) {
      rgb = bodyRgb(BODY_COLORS[kind]);
      cache.set(kind, rgb);
    }
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

/**
 * The two values the MARKS take, per style.
 *
 * `ink` returns `WORLD.ink` for both, which is what the map has always drawn
 * every mark in — so the shipped map's draw calls are unchanged, byte for
 * byte. On `ghibli` the interior marks take the style's own contour violet
 * and the border takes foam: see the header for the measured reason the two
 * differ.
 */
export interface MapPalette {
  /** Hairlines, dots and the camera indicator, inside the field. */
  ink: string;
  /** The frame itself, drawn over the field's edge. */
  border: string;
}

export function mapPalette(style: WorldStyle): MapPalette {
  return style === 'ghibli'
    ? { ink: GHIBLI.ink, border: GHIBLI.foam }
    : { ink: WORLD.ink, border: WORLD.ink };
}

// ── canvas inset ─────────────────────────────────────────────────────────────

/**
 * Corner inset size (square), scaled to the browser window (user ask): a
 * fraction of the smaller viewport axis, clamped so it stays a glance on a
 * huge display and stays legible on a small one. The draw loop re-reads the
 * element's box every frame and re-derives the mark scale from it, so the
 * map redraws correctly at any size with no resize listener.
 *
 * The floor is deliberately low. At 132px the clamp engaged below a ~776px
 * viewport — i.e. for most resized desktop windows — so shrinking the
 * window stopped shrinking the map (user report). 96px keeps the vmin term
 * live down to a ~565px viewport, and marks (mapMarkScale, floored at 0.5
 * ≈ 120px) stay legible a little past it.
 */
const MAP_SIZE_MIN_PX = 96;
const MAP_SIZE_MAX_PX = 264;
/** Share of the smaller viewport axis (vmin). */
const MAP_SIZE_VMIN = 17;
const MAP_SIZE_CSS = `clamp(${MAP_SIZE_MIN_PX}px, ${MAP_SIZE_VMIN}vmin, ${MAP_SIZE_MAX_PX}px)`;
/** Draw cadence — the map is a glance, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;
/** Prop subsampling stride: every ~5th mark keeps the field quiet. */
const PROP_STRIDE = 5;
/** Stable seed for the border waver and the ambient sway channel. */
const MAP_SEED = 129.4;
/** Half-angle of the frustum wedge, radians — a hint, not a measurement. */
const WEDGE_HALF_ANGLE = 0.42;

/** The ordinary creature and egg marks, at map scale 1. */
const CREATURE_DOT_R = 2.2;
const EGG_DOT_R = 2.6;
/**
 * Yours: the same mark, half again as big. Bigger than that and it stops
 * being one of the inhabitants and starts being a cursor.
 *
 * It scales the EGG too, not only the dot. The knockout ring is what
 * separates a near-black dot from the near-black dots around it, and on an
 * egg there is nothing for it to knock out of: `WORLD.light` on
 * `SURFACE.ground` is a fifteenth of a stop, invisible at 1.5px (measured
 * on the shipped paper). So while the creature is still a shell the SIZE
 * carries the distinction and the ring rides along, and the rule stays one
 * rule — yours is the ordinary mark at SELF_SCALE, inside a light ring.
 */
const SELF_SCALE = 1.6;
/**
 * The knockout ring, as fractions of the mark it is cut into.
 *
 * INSIDE the mark, not around it — which is what a knockout is, and here
 * it is also the only thing that works. `WORLD.light` against
 * `SURFACE.ground` is a fifteenth of a stop: a light ring drawn on the
 * paper OUTSIDE the dot is invisible (measured on the shipped paper, at
 * both map sizes). Against `CHARACTER.body` it is the full range. So the
 * ring is carved out of the near-black disc — a light middle inside a dark
 * rim — and it scales with the mark rather than being a picked px, so it
 * survives the smallest inset the map clamps to.
 */
const SELF_RING_RADIUS = 0.56;
const SELF_RING_WIDTH = 0.4;

const STYLE_ID = 'world-minimap-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.world-minimap {
  position: fixed;
  right: calc(env(safe-area-inset-right, 0px) + 20px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 20px);
  z-index: 5;
  width: ${MAP_SIZE_CSS};
  height: ${MAP_SIZE_CSS};
  display: block;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
`;
  document.head.appendChild(style);
}

/** Closed loop with quadratic midpoint smoothing — same hand as the phone
 * map (screens/alive.ts): corners round off, the waver reads hand-drawn. */
function traceLoop(ctx: CanvasRenderingContext2D, points: BorderPoint[]): void {
  const n = points.length;
  if (n < 3) return;
  const last = points[n - 1]!;
  const first = points[0]!;
  ctx.beginPath();
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const next = points[(i + 1) % n]!;
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  ctx.closePath();
}

export interface WorldMinimapOptions {
  manager: {
    positions(): Inhabitant[];
  };
  cameraRig: {
    readonly azimuth: number;
    frameAt(point: Vector3): void;
    readonly camera: {
      position: { x: number; y: number; z: number };
      getWorldDirection(target: Vector3): Vector3;
    };
  };
  scatter?: {
    positions(): { x: number; z: number }[];
    /**
     * Bumps on every scatter rebuild — and every path that MOVES THE MAP goes
     * through one: `WorldHandles.setLandscape`, `setTerrain`, and a painted
     * pond or trail (which end on `scatter.refreshLandscape()`, see
     * src/dev/paint.ts). So this is the revision the painted body caches
     * against, and it is already on the handle the map is handed.
     *
     * Optional: a caller without it simply paints the body once per frame
     * size, which is the shipped scatter-less test harness.
     */
    rebuildVersion?(): number;
  };
  /**
   * The LOOK this page renders in (src/world/style.ts) — read per draw, like
   * the landscape mode beside it, because the dev panel can switch styles
   * live (`WorldHandles.setStyle`) and the body has to repaint when it does.
   * Absent is `ink`: the shipped map, unchanged.
   */
  style?(): WorldStyle;
  /**
   * Somebody asked to look somewhere else.
   *
   * Called with the world point the tap landed on, alongside the reframe —
   * not instead of it. The map still owns the camera move; this is only so
   * a caller that is doing something else with the framing can stand down.
   * On a handset that is the follow camera (src/world/follow.ts): a tap
   * here means "show me over there", and a follow that dragged the frame
   * straight back would make the tap do nothing at all.
   */
  onFocus?(x: number, z: number): void;
  /**
   * Where YOUR creature is, if this view has one.
   *
   * Read live, per frame, exactly like the camera indicator: the creature
   * is already walking on its own springs and a smoothed copy here would
   * only lag behind the dot it is meant to be a ring around. A projection
   * passes nothing and the map is unchanged — a wall has no self.
   */
  self?(): { x: number; z: number } | null;
  mount: HTMLElement;
}

export interface WorldMinimapHandle {
  dispose(): void;
}

export function installWorldMinimap(opts: WorldMinimapOptions): WorldMinimapHandle {
  ensureStyle();

  const canvas = document.createElement('canvas');
  canvas.className = 'world-minimap';
  canvas.setAttribute('aria-label', 'world map');
  opts.mount.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const viewDir = new Vector3();

  // Prop marks change only on scatter rebuilds; sample per draw is cheap
  // enough (subsampled array build), but cache between frames anyway keyed
  // by source length so a static world does no per-frame filtering.
  let propCache: { x: number; z: number }[] = [];
  let propCacheLen = -1;
  const propMarks = (): { x: number; z: number }[] => {
    const source = opts.scatter?.positions() ?? [];
    if (source.length !== propCacheLen) {
      propCache = subsample(source, PROP_STRIDE);
      propCacheLen = source.length;
    }
    return propCache;
  };

  // The geography is authored and global — no option to pass, and no rebuild
  // path: these polygons are the same on every device forever. Mapping them to
  // canvas px is the only per-size work, so it is cached against the frame.
  const waterFills: [number, number][][] = WATER_BODIES.map((body) => waterOutline(body));
  const islandFills: [number, number][][] = WATER_BODIES.map((body) =>
    islandOutline(body),
  ).filter((poly): poly is [number, number][] => poly !== null);
  // The coast, at map scale. The world draws it at `coastOutlinePoints` and
  // subdivides that fourfold for the pen; the map is a couple of hundred pixels
  // across, so the cheap ring is the whole of the gain — the same call the lake
  // makes.
  const coastFill: [number, number][] = coastOutline();
  let waterCache: { px: number; py: number }[][] = [];
  let islandCache: { px: number; py: number }[][] = [];
  let coastCache: { px: number; py: number }[] = [];
  let waterCacheKey = '';
  const project = (
    polys: readonly [number, number][][],
    frame: MapFrame,
  ): { px: number; py: number }[][] =>
    polys.map((poly) => poly.map(([x, z]) => worldToMap(x, z, worldMapExtent(), frame)));
  const waterMarks = (frame: MapFrame): void => {
    const key = `${frame.w}|${frame.h}|${frame.inset}`;
    if (key !== waterCacheKey) {
      waterCache = project(waterFills, frame);
      islandCache = project(islandFills, frame);
      coastCache = project([coastFill], frame)[0] ?? [];
      waterCacheKey = key;
    }
  };

  const frameFor = (w: number, h: number, inset: number, scale: number): MapFrame => ({
    w,
    h,
    inset: inset + 5 * scale,
  });

  // ── the painted body, cached (the `ghibli` style only) ────────────────────
  //
  // One offscreen raster, repainted only when the MAP or the frame changes —
  // the landscape mode, the island, the scatter's rebuild version (which is
  // what a painted pond, a painted trail and a terrain dial all end on) and
  // the style. The dots, the eggs, you and the camera draw over it per frame
  // exactly as they always did: the expensive thing here is `sampleLandscape`
  // once a cell, and it must not happen 30 times a second.
  let bodyCanvas: HTMLCanvasElement | null = null;
  let bodyKey = '';
  const bodyFor = (frame: MapFrame, px: number, style: WorldStyle): HTMLCanvasElement | null => {
    const res = bodyGridRes(px);
    const key = [
      style,
      res,
      frame.w,
      frame.h,
      frame.inset,
      landscapeMode(),
      islandMode() ? 1 : 0,
      opts.scatter?.rebuildVersion?.() ?? 0,
    ].join('|');
    if (bodyCanvas && key === bodyKey) return bodyCanvas;
    const surface = bodyCanvas ?? document.createElement('canvas');
    surface.width = res;
    surface.height = res;
    const bodyCtx = surface.getContext('2d');
    if (!bodyCtx) return null;
    const image = bodyCtx.createImageData(res, res);
    image.data.set(bodyGridRgba(sampleBodyGrid(res, frame, worldMapExtent())));
    bodyCtx.putImageData(image, 0, 0);
    bodyCanvas = surface;
    bodyKey = key;
    return bodyCanvas;
  };

  const draw = (now: number): void => {
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const scale = mapMarkScale(Math.min(w, h));
    const inset = mapBorderInset(scale);
    // The LOOK, read live beside the landscape mode and for the same reason:
    // the dev panel switches it while the map is on screen.
    const style = opts.style?.() ?? 'ink';
    const palette = mapPalette(style);

    // The ambient floor: the whole map drifts imperceptibly, forever.
    const drift = sampleDrift(now, MAP_SEED, 140 * scale);
    ctx.translate(drift.x, drift.y);

    const border = wavyBorderPoints(w, h, inset, MAP_SEED);
    const frame = frameFor(w, h, inset, scale);

    // Map field — the phone precedent: ground value inside the border.
    traceLoop(ctx, border);
    ctx.fillStyle = SURFACE.ground;
    ctx.fill();

    ctx.save();
    traceLoop(ctx, border);
    ctx.clip();

    // Water: the map's terrain, drawn under everything that stands on it —
    // the same flat value the world uses, inside the same drawn shore. Then
    // the island back over the lake in the ground value: at map scale a hole
    // in the fill and a shape painted over it are the same picture, and this
    // one is a shape with its own drawn shore.
    //
    // …in the landscape mode. The plain world has no water in it, so the map
    // of it has none either. Read per draw, not once at creation: the mode is
    // a live switch (WorldHandles.setLandscape) and this is one branch.
    const mapped = landscapeMode() === 'landscape';
    waterMarks(frame);
    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.ink;
    const trace = (poly: { px: number; py: number }[]): boolean => {
      if (poly.length < 3) return false;
      ctx.beginPath();
      ctx.moveTo(poly[0]!.px, poly[0]!.py);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i]!.px, poly[i]!.py);
      ctx.closePath();
      return true;
    };
    const ring = (poly: { px: number; py: number }[], fill: string): void => {
      if (!trace(poly)) return;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.stroke();
    };
    if (style === 'ghibli') {
      // ── the painted body ──────────────────────────────────────────────────
      // The whole field in the world's own colours, off the cached raster.
      // Nearest-neighbour on purpose: a cell is a FLAT FILL, and letting the
      // browser interpolate between two regions would turn a shoreline into
      // a gradient (docs/TASTE.md §9 relaxes the palette, not the flatness).
      const body = bodyFor(frame, Math.min(w, h), style);
      if (body) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(body, 0, 0, w, h);
      }
      // …and the hairlines the body does NOT replace: the coast, and the
      // drawn shore of every still body and its island. Same marks, same
      // order, same one-px pen as the ink map — a fill is what the raster
      // took over, not a line (TASTE §4).
      if (mapped) {
        if (islandMode() && trace(coastCache)) ctx.stroke();
        for (const poly of waterCache) if (trace(poly)) ctx.stroke();
        for (const poly of islandCache) if (trace(poly)) ctx.stroke();
      }
    } else if (mapped) {
      // The sea first, over the whole field: the map is a map of an island, so
      // water is the default and land is the shape drawn on it. The border loop
      // is the field, and the clip above is already it, so filling the loop in
      // the water value IS the ocean.
      //
      // …in the KATAMARI world, which is the one the island belongs to
      // (src/world/game.ts). Read per draw beside the mode and for the same
      // reason: the projection of the coast is cached either way — the ring is
      // authored geography and the same on every device forever — and what the
      // flag decides is whether it is drawn. Elsewhere the map is the flat
      // field with its lakes on it, exactly as before the island landed.
      if (islandMode()) {
        traceLoop(ctx, border);
        ctx.fillStyle = WORLD.neutralMid;
        ctx.fill();
        // …and the island back over it in the ground value inside its hairline
        // coast — the lake island's own treatment, inverted.
        ring(coastCache, SURFACE.ground);
      }
      for (const poly of waterCache) ring(poly, WORLD.neutralMid);
      for (const poly of islandCache) ring(poly, SURFACE.ground);
    }

    // Prop marks: sparse neutral dots, the terrain at a glance.
    ctx.fillStyle = WORLD.neutral;
    for (const p of propMarks()) {
      const at = worldToMap(p.x, p.z, worldMapExtent(), frame);
      ctx.beginPath();
      ctx.arc(at.px, at.py, 1.1 * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    const { characters, eggs } = partitionInhabitants(opts.manager.positions());

    // Eggs: light shell circles with an ink hairline.
    ctx.fillStyle = WORLD.light;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1;
    for (const egg of eggs) {
      const at = worldToMap(egg.x, egg.z, worldMapExtent(), frame);
      ctx.beginPath();
      ctx.arc(at.px, at.py, EGG_DOT_R * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Characters: the near-black marks — inhabitants, no "self" here.
    ctx.fillStyle = CHARACTER.body;
    for (const c of characters) {
      const at = worldToMap(c.x, c.z, worldMapExtent(), frame);
      ctx.beginPath();
      ctx.arc(at.px, at.py, CREATURE_DOT_R * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    // Camera indicator: hairline diamond on the look-target + a subtle
    // frustum wedge opening the way the camera looks (rotates with azimuth).
    // Live reads — the rig's own springs already carry the motion.
    const camPos = opts.cameraRig.camera.position;
    opts.cameraRig.camera.getWorldDirection(viewDir);
    const look = groundLookTarget(camPos, viewDir);
    if (look) {
      const at = worldToMap(look.x, look.z, worldMapExtent(), frame);
      const az = opts.cameraRig.azimuth;
      // Ground view direction: from the camera toward the target is
      // (-sin az, -cos az) in world x/z; map is north-up (x→px, z→py).
      const va = Math.atan2(-Math.cos(az), -Math.sin(az));

      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';

      // Wedge: two hairline rays from just outside the diamond.
      const r0 = 7 * scale;
      const r1 = 16 * scale;
      ctx.beginPath();
      for (const side of [-1, 1]) {
        const a = va + side * WEDGE_HALF_ANGLE;
        ctx.moveTo(at.px + Math.cos(a) * r0, at.py + Math.sin(a) * r0);
        ctx.lineTo(at.px + Math.cos(a) * r1, at.py + Math.sin(a) * r1);
      }
      ctx.stroke();

      // Diamond, drawn as a soft-cornered loop (nothing rectilinear reads
      // hard at this size; the rotated square stays an icon mark).
      const d = 4.4 * scale;
      ctx.beginPath();
      ctx.moveTo(at.px, at.py - d);
      ctx.lineTo(at.px + d, at.py);
      ctx.lineTo(at.px, at.py + d);
      ctx.lineTo(at.px - d, at.py);
      ctx.closePath();
      ctx.stroke();
    }

    // You. Last, over every other mark including the camera's — the whole
    // question this answers is "where am I in all that", and a mark that
    // can be covered by the thing it is being located against does not
    // answer it. Still inside the clip: it is a mark on the map, not a
    // label over it.
    const mine = selfMark(opts.self?.(), eggs);
    if (mine) {
      const at = worldToMap(mine.x, mine.z, worldMapExtent(), frame);
      // Your OWN mark, whichever one you are — the same shape as everybody
      // else's, at SELF_SCALE, redrawn over the ordinary one it replaces.
      const inner = (mine.egg ? EGG_DOT_R : CREATURE_DOT_R) * SELF_SCALE;
      ctx.beginPath();
      ctx.arc(at.px, at.py, inner * scale, 0, Math.PI * 2);
      if (mine.egg) {
        // Still a shell: light fill, ink hairline. A near-black dot here
        // would say the creature had already hatched.
        ctx.fillStyle = WORLD.light;
        ctx.fill();
        ctx.strokeStyle = palette.ink;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = CHARACTER.body;
        ctx.fill();
      }
      // The ring, cut into the mark. On a shell it is light on light and
      // says nothing — deliberately the same code path, because there the
      // SIZE is already the whole distinction and a special case here
      // would be a second rule for one transient state.
      ctx.strokeStyle = WORLD.light;
      ctx.lineWidth = inner * SELF_RING_WIDTH * scale;
      ctx.beginPath();
      ctx.arc(at.px, at.py, inner * SELF_RING_RADIUS * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // The hairline border itself, over the clipped field.
    traceLoop(ctx, border);
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  };

  // ── ~30fps loop: own rAF, skipping frames ─────────────────────────────────
  let raf = 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    draw(now);
  };
  const start = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    if (raf === 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  // ── click → pan the camera there ──────────────────────────────────────────
  // The reframe slides on the rig's t.primary springs — cheap and delightful,
  // never a snap. Pointer events stay on the map; nothing bleeds through to
  // the world canvas underneath.
  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const scale = mapMarkScale(Math.min(w, h));
    const inset = mapBorderInset(scale);
    const at = mapToWorld(
      event.clientX - rect.left,
      event.clientY - rect.top,
      worldMapExtent(),
      frameFor(w, h, inset, scale),
    );
    // Clamp to the mapped region so a border click stays on the ground.
    const extent = worldMapExtent();
    const x = Math.max(-extent, Math.min(extent, at.x));
    const z = Math.max(-extent, Math.min(extent, at.z));
    // Told BEFORE the reframe: whoever else is framing has to have let go
    // by the time this slide starts, or it fights the first frame of it.
    opts.onFocus?.(x, z);
    opts.cameraRig.frameAt(new Vector3(x, 0, z));
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('click', onClick);

  return {
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('click', onClick);
      canvas.remove();
    },
  };
}
