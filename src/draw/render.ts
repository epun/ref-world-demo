/**
 * Stroke-list rendering for live draw feedback and the egg paint-on reveal.
 *
 * Canvas-2D only, no Three.js. Colors come straight from the taste tokens:
 * SURFACE.canvas ground, CHARACTER.body ink — the phone canvas is the one
 * place the near-black mark and the light ground meet directly.
 *
 * Width along a stroke is w * widthScale, interpolated per segment; round
 * caps and joins let adjacent segments of different widths fuse into one
 * continuous, hand-carved edge rather than reading as stacked rectangles.
 */

import type { Stroke, StrokeList } from '../shape/types';
import { CHARACTER, SURFACE } from '../taste/tokens';

/**
 * Paint the full stroke list into a sizePx × sizePx square at the context's
 * current transform origin, background included.
 */
export function renderStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: StrokeList,
  sizePx: number,
): void {
  renderStrokesPartial(ctx, strokes, sizePx, 1);
}

/**
 * Progressive reveal for the egg paint-on: t ∈ [0, 1] shows the first
 * floor(t · totalPoints) captured points, in capture order, across stroke
 * boundaries. t = 1 is exactly renderStrokes.
 */
export function renderStrokesPartial(
  ctx: CanvasRenderingContext2D,
  strokes: StrokeList,
  sizePx: number,
  t: number,
): void {
  ctx.save();
  ctx.fillStyle = SURFACE.canvas;
  ctx.fillRect(0, 0, sizePx, sizePx);

  const total = strokes.reduce((n, s) => n + s.pts.length, 0);
  const clamped = Math.min(1, Math.max(0, t));
  let budget = clamped >= 1 ? total : Math.floor(clamped * total);

  ctx.strokeStyle = CHARACTER.body;
  ctx.fillStyle = CHARACTER.body;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    if (budget <= 0) break;
    const count = Math.min(stroke.pts.length, budget);
    drawStroke(ctx, stroke, sizePx, count);
    budget -= count;
  }
  ctx.restore();
}

/** Draw the first `count` points of one stroke. */
function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  sizePx: number,
  count: number,
): void {
  const wBase = stroke.w * sizePx;
  const first = stroke.pts[0];
  if (count <= 0 || first === undefined) return;

  if (count === 1) {
    // A tap, or a pen that just landed: a round dot at the point's width.
    const [x, y, ws] = first;
    ctx.beginPath();
    ctx.arc(x * sizePx, y * sizePx, (wBase * ws) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // One sub-stroke per segment so lineWidth can follow the interpolated
  // widthScale; round caps overlap at the shared endpoints and fuse the
  // segments into a continuous variable-width mark.
  let prev = first;
  for (let i = 1; i < count; i++) {
    const pt = stroke.pts[i];
    if (pt === undefined) break;
    ctx.beginPath();
    ctx.lineWidth = wBase * ((prev[2] + pt[2]) / 2);
    ctx.moveTo(prev[0] * sizePx, prev[1] * sizePx);
    ctx.lineTo(pt[0] * sizePx, pt[1] * sizePx);
    ctx.stroke();
    prev = pt;
  }
}
