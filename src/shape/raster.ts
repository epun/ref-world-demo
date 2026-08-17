/**
 * Stroke list → binary mask, without a canvas. Pure and deterministic: the
 * phone and the world must rasterize identically, so we do not use
 * CanvasRenderingContext2D (whose antialiasing is implementation-defined).
 * Strokes are stamped as filled discs along each segment — a binary mask
 * needs no antialiasing.
 */

import type { Mask, StrokeList } from './types';

/** Stamp a filled disc into the mask. */
function stampDisc(mask: Uint8Array, size: number, cx: number, cy: number, r: number): void {
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(size - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy;
    const half = Math.sqrt(Math.max(0, r2 - dy * dy));
    const minX = Math.max(0, Math.floor(cx - half));
    const maxX = Math.min(size - 1, Math.ceil(cx + half));
    const row = y * size;
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) mask[row + x] = 1;
    }
  }
}

/**
 * Rasterize strokes into a size×size binary mask.
 * Coordinates in the stroke list are [0,1]; widths are fractions of size.
 */
export function rasterize(strokes: StrokeList, size = 512): Mask {
  const data = new Uint8Array(size * size);
  for (const stroke of strokes) {
    const baseR = (stroke.w * size) / 2;
    const pts = stroke.pts;
    if (pts.length === 0) continue;
    const first = pts[0]!;
    stampDisc(data, size, first[0] * size, first[1] * size, Math.max(0.75, baseR * first[2]));
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay, aw] = pts[i - 1]!;
      const [bx, by, bw] = pts[i]!;
      const x0 = ax * size, y0 = ay * size;
      const x1 = bx * size, y1 = by * size;
      const dist = Math.hypot(x1 - x0, y1 - y0);
      // Step at ≤ half the min radius so consecutive discs overlap seamlessly.
      const rMin = Math.max(0.75, baseR * Math.min(aw, bw));
      const steps = Math.max(1, Math.ceil(dist / (rMin * 0.5)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const r = Math.max(0.75, baseR * (aw + (bw - aw) * t));
        stampDisc(data, size, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r);
      }
    }
  }
  return { size, data };
}

/**
 * Keep the largest 4-connected component; drop everything else. Components
 * under `minFraction` of total ink are treated as stray dots (PLAN §3.2).
 * Returns a new mask plus how much ink was discarded (for dev telemetry).
 */
export function largestComponent(
  mask: Mask,
  minFraction = 0.005,
): { mask: Mask; discardedFraction: number } {
  const { size, data } = mask;
  const labels = new Int32Array(size * size); // 0 = unvisited/background
  let nextLabel = 0;
  const areas: number[] = [];
  const stack: number[] = [];

  for (let i = 0; i < data.length; i++) {
    if (data[i] === 1 && labels[i] === 0) {
      nextLabel++;
      let area = 0;
      stack.push(i);
      labels[i] = nextLabel;
      while (stack.length > 0) {
        const p = stack.pop()!;
        area++;
        const x = p % size;
        const y = (p / size) | 0;
        // 4-connectivity
        if (x > 0 && data[p - 1] === 1 && labels[p - 1] === 0) { labels[p - 1] = nextLabel; stack.push(p - 1); }
        if (x < size - 1 && data[p + 1] === 1 && labels[p + 1] === 0) { labels[p + 1] = nextLabel; stack.push(p + 1); }
        if (y > 0 && data[p - size] === 1 && labels[p - size] === 0) { labels[p - size] = nextLabel; stack.push(p - size); }
        if (y < size - 1 && data[p + size] === 1 && labels[p + size] === 0) { labels[p + size] = nextLabel; stack.push(p + size); }
      }
      areas.push(area);
    }
  }

  if (nextLabel <= 1) return { mask, discardedFraction: 0 };

  let best = 1;
  for (let l = 2; l <= nextLabel; l++) {
    if (areas[l - 1]! > areas[best - 1]!) best = l;
  }
  const totalInk = areas.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) {
    if (labels[i] === best) out[i] = 1;
  }
  const kept = areas[best - 1]!;
  void minFraction; // small components are dropped regardless; threshold kept for future merge logic
  return { mask: { size, data: out }, discardedFraction: (totalInk - kept) / totalInk };
}
