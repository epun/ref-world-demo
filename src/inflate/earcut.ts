/**
 * Minimal ear-clipping triangulation for a single simple polygon (no holes).
 *
 * Self-contained on purpose — no npm dependency. Determinism is load-bearing
 * for src/inflate/ (PLAN §6.3), so the exact clipping order lives in-repo
 * where it can never drift under us.
 *
 * Input winding is normalized first using the signedArea convention from
 * src/shape/contour.ts, so callers may pass either winding. Every emitted
 * triangle (a, b, c) satisfies cross(b − a, c − a) > 0 in the input
 * coordinate space; the caller owns any subsequent axis flips.
 */

import type { Point } from '../shape/types';
import { signedArea } from '../shape/contour';

/** z-component of (b − a) × (c − a). */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Boundary-inclusive point-in-triangle for a positively wound triangle. */
function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

/** Collinearity / degeneracy tolerance for cross products in pixel space. */
const EPS = 1e-9;

/**
 * Triangulate a simple polygon by ear clipping. Returns a flat list of index
 * triples into `polygon`. O(n²) with n ≈ 120 contour points — negligible.
 *
 * Degenerate corners (collinear triples) are dropped without emitting a
 * triangle. If no ear is found in a full sweep (only possible for
 * self-intersecting input, which the contour tracer never produces), the
 * current corner is clipped anyway so termination is guaranteed and the
 * output stays deterministic.
 */
export function earcut(polygon: Point[]): number[] {
  const n = polygon.length;
  if (n < 3) return [];

  // Doubly linked list over the original indices, normalized so traversal
  // follows the positive-signed-area orientation.
  const next = new Int32Array(n);
  const prev = new Int32Array(n);
  const positive = signedArea(polygon) >= 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (positive) {
      next[i] = j;
      prev[j] = i;
    } else {
      next[j] = i;
      prev[i] = j;
    }
  }

  const out: number[] = [];
  let remaining = n;
  let v = 0;
  let sinceLastClip = 0;

  while (remaining > 3) {
    const p = prev[v]!;
    const nx = next[v]!;
    const a = polygon[p]!;
    const b = polygon[v]!;
    const c = polygon[nx]!;
    const area2 = cross(a, b, c);

    let clip = false;
    let emit = false;

    if (area2 > -EPS && area2 < EPS) {
      // Collinear corner: remove it, emit nothing.
      clip = true;
    } else if (area2 > 0) {
      // Convex corner: an ear unless another remaining vertex sits inside.
      let blocked = false;
      for (let w = next[nx]!; w !== p; w = next[w]!) {
        if (inTriangle(polygon[w]!, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        clip = true;
        emit = true;
      }
    }

    if (!clip && sinceLastClip >= remaining) {
      // Full sweep with no ear — degenerate input. Force progress.
      clip = true;
      emit = area2 > EPS;
    }

    if (clip) {
      if (emit) out.push(p, v, nx);
      next[p] = nx;
      prev[nx] = p;
      remaining--;
      v = nx;
      sinceLastClip = 0;
    } else {
      v = nx;
      sinceLastClip++;
    }
  }

  const p = prev[v]!;
  const nx = next[v]!;
  if (cross(polygon[p]!, polygon[v]!, polygon[nx]!) > EPS) out.push(p, v, nx);
  return out;
}
