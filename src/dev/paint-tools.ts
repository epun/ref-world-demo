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

/** The one height layer, and the id its four tools write. */
export const HEIGHT_LAYER = 'height';

/** The height tools, in strip order — hotkeys 1-4 (see TOOL_KEYS). */
export const HEIGHT_TOOL_IDS = ['raise', 'lower', 'flatten', 'smooth'] as const;
export type HeightToolId = (typeof HEIGHT_TOOL_IDS)[number];

/**
 * Which layer a tool id writes into.
 *
 * The planting brushes are named for their layer (`grove` writes `grove`),
 * so this is an identity for them and a fan-in for the height four. A tool
 * id nobody knows returns null rather than defaulting to the height layer:
 * a replayed stamp from a future build must not silently sculpt the ground.
 */
export function layerForTool(tool: string): string | null {
  if ((HEIGHT_TOOL_IDS as readonly string[]).includes(tool)) return HEIGHT_LAYER;
  if ((PLANT_BRUSHES as readonly string[]).includes(tool)) return tool;
  return null;
}

/** True when a tool id is one of the planting brushes. */
export function isPlantTool(tool: string): tool is PlantBrush {
  return (PLANT_BRUSHES as readonly string[]).includes(tool);
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
export const RADIUS_DEFAULT = 12;

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
