/**
 * The ink pass's ghibli settings — envpaint's `pencil` line style
 * (src/core/PostFX.js `LINE_STYLES.pencil`) and its `ghibli-toon` style's own
 * `post` block (src/styles/ghibli-toon.js), ported onto `src/world/ink.ts`
 * (docs/TASTE.md §9, docs/ghibli-port.md).
 *
 * envpaint's ink pass has seven dials here; this world's has four
 * (`InkParams`), and two of those four are the same dial by the same name.
 * So this module is honest about the map rather than pretending the shapes
 * are the same:
 *
 *   | envpaint          | ref-world `InkParams`  | notes                    |
 *   | ----------------- | ---------------------- | ------------------------ |
 *   | `lineWidth` 1.4   | `lineWidth`            | device pixels, same unit |
 *   | `wobble` 0.8      | `wobble`               | device pixels, same unit |
 *   | `hatch` 0.3       | `hatchStrength`        | overlay opacity, 0–1     |
 *   | `break` 0.25      | — **not ported**       | see below                |
 *   | `inkOpacity` 0.85 | — **not ported**       | see below                |
 *   | `hatchScale` 3.5  | — **not ported**       | see below                |
 *   | `pooling` 0.15    | — **not ported**       | see below                |
 *
 * WHY THE FOUR ARE NOT PORTED, and what would have to happen first:
 *
 *   - **`break`** — envpaint erases sections of a contour from a noise field,
 *     so a line is drawn in strokes rather than as one continuous edge. This
 *     world's ink pass already wobbles its lines but always draws them whole;
 *     breaking them is a change to `src/world/ink.ts`'s fragment shader,
 *     which is not this port's file.
 *   - **`inkOpacity`** — the contour's own alpha. `ink.ts` composites at full
 *     strength and takes the ink COLOUR from the style (it already swaps to
 *     `GHIBLI.ink` on this style), so an opacity dial would be a new uniform.
 *   - **`hatchScale`** — `ink.ts` derives its hatch period from the device
 *     pixel ratio instead, and quantises it to whole device pixels so the
 *     stroke lattice never beats against the pixel grid. That is a better
 *     rule than a style constant and it stays.
 *   - **`pooling`** — ink darkening at an object's boundary, which needs the
 *     edge mask envpaint writes into destination alpha. This world has no
 *     such mask (the ink pass reads depth and normals), so there is nothing
 *     for a pooling term to key off.
 *
 * `applyGhibliPost` writes only what exists. It does NOT touch
 * `edgeThreshold`: that value was landed by screenshot iteration against this
 * world's own geometry (src/world/ink.ts `DEFAULTS`) and has no envpaint
 * counterpart in the same units.
 */

import type { InkParams } from '../ink';

/**
 * The ported dial set. `lineWidth` / `wobble` / `break` / `inkOpacity` are
 * `LINE_STYLES.pencil`; `hatch` / `hatchScale` / `pooling` are the
 * `ghibli-toon` style's `post` block. Kept whole — including the four this
 * world cannot use yet — so the port is legible as a port.
 */
export const GHIBLI_POST = {
  lineWidth: 1.4,
  wobble: 0.8,
  break: 0.25,
  inkOpacity: 0.85,
  hatch: 0.3,
  hatchScale: 3.5,
  pooling: 0.15,
} as const;

/** Exactly the subset `InkParams` can carry. */
export const GHIBLI_INK_PARAMS: Partial<InkParams> = {
  lineWidth: GHIBLI_POST.lineWidth,
  wobble: GHIBLI_POST.wobble,
  hatchStrength: GHIBLI_POST.hatch,
};

/** The narrow slice of `InkPass` this needs — so a test can pass a stub. */
export interface InkParamSink {
  setParams(next: Partial<InkParams>): void;
}

/**
 * Point the ink pass at the ghibli line. Call it AFTER `ink.setStyle('ghibli')`
 * (which owns the quantize switch and the ink colour) — this only moves the
 * three dials above, and leaves `edgeThreshold` where the screenshots put it.
 */
export function applyGhibliPost(ink: InkParamSink): void {
  ink.setParams({ ...GHIBLI_INK_PARAMS });
}
