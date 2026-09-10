/**
 * The sculpting tool's PURE half — no DOM, no envpaint, no Three.js.
 *
 * `src/dev/paint.ts` cannot be imported outside a browser (it pulls
 * `envpaint/ui`, which wants a document at import time), and these three
 * rules are the ones worth pinning in a test: which layer a tool id writes,
 * what a tool's opposite is, and how the bracket keys step the radius. They
 * live here so the tests can read them without a canvas, and so the routing
 * a REPLAY uses is the same table the live brush uses (docs/SESSION.md §4:
 * a replayed stamp has to land in the same layer as the one it records).
 *
 * Dev-only, like everything else in src/dev/ — nothing outside this folder
 * imports it, so it leaves the demo build with the rest of the panel.
 */

import { PLANT_BRUSHES, type PlantBrush } from '../world/painted';

/** The one height layer, and the id the sculpt tool writes. */
export const HEIGHT_LAYER = 'height';

/** The one water level layer, and the id the pond tool writes. */
export const WATER_LAYER = 'water';

/**
 * The tools that write the height layer.
 *
 * ONE of them on the strip now (`sculpt`, EnvPaint's own id and key `0`,
 * shift-inverted to lower, ctrl to lower, alt to smooth) — the other three
 * are the ids the old strip recorded its dabs under, kept here so a stored
 * scene still routes to the height layer (see `LEGACY_TOOLS`). `flatten` is
 * gone from the strip entirely and `smooth` is reachable only through alt,
 * exactly as EnvPaint has it.
 */
export const HEIGHT_TOOL_IDS = ['sculpt', 'raise', 'lower', 'flatten', 'smooth'] as const;
export type HeightToolId = (typeof HEIGHT_TOOL_IDS)[number];

/** The first tool that wrote the water level layer, and the one every older
 * scene was recorded under. Kept as its own export because the tests and the
 * legacy table name it. */
export const WATER_TOOL_ID = 'pond';

/**
 * The tools that write the water level layer.
 *
 * `river` joined `pond` on 2026-09-10 (user ask: *"i want to match the
 * brushes for env paint exactly"*). It is the same layer and the same
 * `writeLevelDisc` stamp — what differs is only which plane a dab fills to:
 * a pond picks one for the whole stroke, a river carries a running minimum
 * downhill. `waterfall` is deliberately NOT here: it writes no layer at all,
 * it appends a mark to the painted map, so `layerForTool` refuses it exactly
 * as it refuses any id with no layer behind it.
 */
export const WATER_TOOL_IDS = ['pond', 'river'] as const;

/**
 * The strip, in EnvPaint's own order and with its own hotkeys (2026-09-10,
 * user ask: *"i want to match the brushes for env paint exactly"*).
 *
 *   sculpt 0 · mask 9 · path 8 | grass 1 · comb 2 · flowers w · pond 3 ·
 *   river 4 · waterfall 5 · trees 6 · rocks 7 · fire f · clouds c
 *
 * ALL THIRTEEN are shown, in these three groups — the divider falls after
 * `path` because EnvPaint's own toolbar groups the ground tools (sculpt,
 * mask, path) at the head of the strip, and again before the eraser and the
 * home button that close it. The five this world has not built an
 * environment item for yet are in their places, holding their own keys, and
 * DISABLED (`COMING_TOOL_IDS`) rather than absent: the strip is the picture
 * of the whole kit, and a gap in it would be a different kit.
 */
export const TOOL_KEYS: Readonly<Record<string, string>> = {
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
};

/** The strip's tools in the order they are shown (and registered). */
export const STRIP_TOOL_IDS = [
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
] as const;

/**
 * The tools that are in the strip but cannot paint yet, in the order they
 * are being built.
 *
 * Each is a real EnvPaint tool with nothing behind it in this world: `comb`
 * wants a lean-direction layer the grass reads, `fire` an ink flame mark and
 * a scorch. (`path` was one of these until it landed: it is a weight layer
 * the ground draws as a dirt trail; `river` and `waterfall` landed together
 * on 2026-09-10 — the level layer carries a running minimum downhill and the
 * painted map carries a mark where it falls.) Until one lands its button is disabled and its tooltip
 * says so; nothing routes to it, and `layerForTool` refuses its id exactly as
 * it refuses any id it does not know.
 */
export const COMING_TOOL_IDS = ['comb', 'fire'] as const;

/** True while a strip tool has nothing behind it yet — see COMING_TOOL_IDS. */
export function isComingTool(id: string): boolean {
  return (COMING_TOOL_IDS as readonly string[]).includes(id);
}

/**
 * One retired tool id → what it means now.
 *
 * Stored scenes and session logs carry the pre-EnvPaint ids
 * (`raise`/`lower`/`flatten`/`smooth`/`grove`/`clearing`/`drain`), and an
 * existing scene has to still apply: docs/SESSION.md §4 says a replayed
 * stamp lands in the layer it was recorded from, and a rename is not
 * permission to lose one. Each entry names the tool that replaces it and,
 * where the tool alone no longer says what the dab DID, the mode it did it
 * in — `drain` is a pond dab that erases, `lower` a sculpt dab that lowers.
 * A recorded `mode` always wins: the fallback is for a log old enough not to
 * carry one.
 *
 * `cottages` is deliberately absent: the brush and its weight layer are gone
 * (there is no EnvPaint cottage), so a cottages dab resolves to nothing and
 * `layerForTool` refuses it, which is the same answer it gives any id it does
 * not know.
 */
export const LEGACY_TOOLS: Readonly<Record<string, { tool: string; mode?: string }>> = {
  raise: { tool: 'sculpt', mode: 'raise' },
  lower: { tool: 'sculpt', mode: 'lower' },
  flatten: { tool: 'sculpt', mode: 'flatten' },
  smooth: { tool: 'sculpt', mode: 'smooth' },
  grove: { tool: 'trees' },
  clearing: { tool: 'mask' },
  drain: { tool: 'pond', mode: 'erase' },
};

/**
 * A recorded (tool, mode) pair as this build understands it.
 *
 * The one place a legacy id is translated, so the live brush, the replay and
 * the sync all agree — and an id that is already current passes through
 * untouched.
 */
export function resolveTool(
  tool: string,
  mode?: string,
): { tool: string; mode: string | undefined } {
  const legacy = LEGACY_TOOLS[tool];
  if (!legacy) return { tool, mode };
  return { tool: legacy.tool, mode: mode ?? legacy.mode };
}

/**
 * Which layer a tool id writes into.
 *
 * The planting brushes are named for their layer (`trees` writes `trees`),
 * so this is an identity for them and a fan-in for the height ids. Legacy
 * ids resolve first, so a stored `grove` dab lands in the `trees` layer. A
 * tool id nobody knows returns null rather than defaulting to the height
 * layer: a replayed stamp from a future build must not silently sculpt the
 * ground.
 */
export function layerForTool(tool: string): string | null {
  const id = resolveTool(tool).tool;
  if ((HEIGHT_TOOL_IDS as readonly string[]).includes(id)) return HEIGHT_LAYER;
  if ((WATER_TOOL_IDS as readonly string[]).includes(id)) return WATER_LAYER;
  if ((PLANT_BRUSHES as readonly string[]).includes(id)) return id;
  return null;
}

/** True when a tool id is one of the planting brushes (legacy ids resolved
 * first, so `grove` counts as the `trees` brush it became). */
export function isPlantTool(tool: string): tool is PlantBrush {
  return (PLANT_BRUSHES as readonly string[]).includes(resolveTool(tool).tool);
}

/**
 * The opposite of a stamp mode (2026-09-09, user ask: *"holding shift while
 * painting will have the opposite brush effect i.e. so removing elevation
 * etc."*).
 *
 * Raise ↔ lower on the height layer, add ↔ erase on the planting layers.
 * `smooth` and `flatten` have NO opposite — un-smoothing is not a thing a
 * brush can do, and the inverse of "level this ground" is the ground it
 * already left behind — so shift leaves them exactly as they are rather
 * than inventing a second meaning for the key.
 */
export function invertStampMode(mode: string): string {
  switch (mode) {
    case 'raise':
      return 'lower';
    case 'lower':
      return 'raise';
    case 'add':
      return 'erase';
    case 'erase':
      return 'add';
    default:
      return mode;
  }
}

/**
 * [D] Brush radius range in world units, 0.5-40.
 *
 * NOT EnvPaint's own: its `Brush.setRadius` clamps to 0.3-12, sized for a
 * 48-unit world, and Meridian's field is 400 across. A dab that can only
 * ever be a twelfth of the forest is not a landscape tool, so the panel
 * writes `settings.radius` (a public field) and calls `flashRadius`, which
 * is what `setRadius` does either side of the clamp. Reported upstream in
 * the port notes rather than worked around silently.
 */
export const RADIUS_MIN = 0.5;
export const RADIUS_MAX = 40;
/**
 * The radius a fresh panel opens on, world units (2026-09-10, user ask: the
 * brush should open on EnvPaint's own numbers — radius 3.0, strength 0.28).
 *
 * The RANGE above is still this world's (a 400-unit field), only the opening
 * value is EnvPaint's: a 12-unit default drew a stroke wider than most of
 * what anybody wants to plant, and a first dab that covers a tenth of the
 * map reads as the tool being broken rather than as a big brush.
 */
export const RADIUS_DEFAULT = 3;

/** EnvPaint's own bracket ratio (Brush.js `RADIUS_STEP`), kept identical so
 * the keys feel the same in both worlds — only the clamp differs. */
export const RADIUS_STEP = 1.15;

export function clampRadius(r: number): number {
  if (!Number.isFinite(r)) return RADIUS_DEFAULT;
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, r));
}

/**
 * One press of `[` (direction -1) or `]` (+1): a RATIO step, so the radius
 * changes by the same proportion at 1 unit as at 30, and clamped into this
 * world's range rather than EnvPaint's — past 12 units its own handler would
 * simply stop responding, which is the bug this replaces.
 */
export function steppedRadius(current: number, direction: -1 | 1): number {
  const base = clampRadius(current);
  return clampRadius(direction > 0 ? base * RADIUS_STEP : base / RADIUS_STEP);
}
