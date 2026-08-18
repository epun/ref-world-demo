/**
 * Mask geometry for the moderation screen.
 *
 * Pure and deterministic, the same discipline as src/shape/: data in, data
 * out. No DOM, no Three.js, no Math.random, no Date. Every number here is a
 * function of the stroke list alone, so a drawing screened on one device
 * screens identically on every other.
 */

import { distanceTransform } from '../shape/distance';
import { fillHoles, largestComponent, rasterize } from '../shape/raster';
import type { DistanceField, Mask, StrokeList } from '../shape/types';

/** Screening raster size. Small on purpose: the screen runs on the world
 * thread at ingest, and every metric here is a ratio, not a pixel count. */
export const SCREEN_SIZE = 160;

/** Ink pixels projected onto the shape's own principal axes. */
export interface InkFrame {
  mask: Mask;
  distance: DistanceField;
  /** Ink pixel count. */
  count: number;
  /** Ink centroid, mask pixel space. */
  cx: number;
  cy: number;
  /** Major axis (unit), then the minor axis perpendicular to it. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Per-ink-pixel coordinates in the (major, minor) frame, centred. */
  u: Float32Array;
  v: Float32Array;
  /** Pixel coordinates of the same ink pixels, index-aligned with u/v. */
  px: Int32Array;
  py: Int32Array;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/**
 * Build the screening mask from a stroke list: rasterize, optionally keep
 * only the largest connected component, then fill enclosed background.
 *
 * Filling matters — most doodles arrive as outlines, and an unfilled outline
 * has none of the mass structure the detectors measure (GENERATOR §1a fills
 * them for the body too, so this screens the same solid the world builds).
 */
export function screenMask(
  strokes: StrokeList,
  opts: { size?: number; largestOnly?: boolean } = {},
): Mask {
  const size = opts.size ?? SCREEN_SIZE;
  const raw = rasterize(strokes, size);
  const base = opts.largestOnly === true ? largestComponent(raw).mask : raw;
  return fillHoles(base);
}

/** How much of the ink the largest connected component holds (1 = one mass). */
export function largestComponentShare(mask: Mask): number {
  let total = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] === 1) total++;
  if (total === 0) return 1;
  let kept = 0;
  const only = largestComponent(mask).mask;
  for (let i = 0; i < only.data.length; i++) if (only.data[i] === 1) kept++;
  return kept / total;
}

/**
 * Principal-axis frame of a mask's ink. Returns null when there is too
 * little ink to measure (a dot, an empty canvas).
 */
export function inkFrame(mask: Mask): InkFrame | null {
  const { size, data } = mask;
  let count = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 1) count++;
  if (count < 24) return null;

  const px = new Int32Array(count);
  const py = new Int32Array(count);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      if (data[row + x] !== 1) continue;
      px[n] = x;
      py[n] = y;
      sx += x;
      sy += y;
      n++;
    }
  }
  const cx = sx / count;
  const cy = sy / count;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < count; i++) {
    const dx = px[i]! - cx;
    const dy = py[i]! - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= count;
  syy /= count;
  sxy /= count;

  // Major eigenvector of the 2x2 covariance, in closed form. The tie case
  // (a perfect disc) resolves to the x axis, deterministically.
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  let ax: number;
  let ay: number;
  if (Math.abs(sxy) > 1e-9) {
    ax = l1 - syy;
    ay = sxy;
  } else {
    ax = sxx >= syy ? 1 : 0;
    ay = sxx >= syy ? 0 : 1;
  }
  const len = Math.hypot(ax, ay) || 1;
  ax /= len;
  ay /= len;
  // Canonical orientation: the axis always points into the +x half plane
  // (or +y when vertical), so the frame is a function of the ink alone.
  if (ax < 0 || (ax === 0 && ay < 0)) {
    ax = -ax;
    ay = -ay;
  }
  const bx = -ay;
  const by = ax;

  const u = new Float32Array(count);
  const v = new Float32Array(count);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < count; i++) {
    const dx = px[i]! - cx;
    const dy = py[i]! - cy;
    const uu = dx * ax + dy * ay;
    const vv = dx * bx + dy * by;
    u[i] = uu;
    v[i] = vv;
    if (uu < uMin) uMin = uu;
    if (uu > uMax) uMax = uu;
    if (vv < vMin) vMin = vv;
    if (vv > vMax) vMax = vv;
  }

  return {
    mask,
    distance: distanceTransform(mask),
    count,
    cx,
    cy,
    ax,
    ay,
    bx,
    by,
    u,
    v,
    px,
    py,
    uMin,
    uMax,
    vMin,
    vMax,
  };
}

/** Ink at a pixel, with bounds check. */
export function inkAt(mask: Mask, x: number, y: number): boolean {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= mask.size || yi >= mask.size) return false;
  return mask.data[yi * mask.size + xi] === 1;
}

/** Distance-transform value at a pixel (0 outside the mask). */
export function dtAt(dist: DistanceField, x: number, y: number): number {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= dist.size || yi >= dist.size) return 0;
  return dist.data[yi * dist.size + xi]!;
}

/**
 * Fraction of ink that maps onto ink when the shape is rotated about its
 * own centroid by `radians`. 1 = perfectly self-similar under that rotation.
 */
export function rotationSelfSimilarity(frame: InkFrame, radians: number): number {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  let hit = 0;
  for (let i = 0; i < frame.count; i++) {
    const dx = frame.px[i]! - frame.cx;
    const dy = frame.py[i]! - frame.cy;
    const rx = dx * cos - dy * sin + frame.cx;
    const ry = dx * sin + dy * cos + frame.cy;
    if (inkAt(frame.mask, rx, ry)) hit++;
  }
  return hit / frame.count;
}

/**
 * Fraction of ink that maps onto ink when the shape is mirrored about the
 * line through its centroid at `radians`.
 */
export function mirrorSelfSimilarity(frame: InkFrame, radians: number): number {
  // Reflection about a line at angle t: [cos2t, sin2t; sin2t, -cos2t].
  const c = Math.cos(2 * radians);
  const s = Math.sin(2 * radians);
  let hit = 0;
  for (let i = 0; i < frame.count; i++) {
    const dx = frame.px[i]! - frame.cx;
    const dy = frame.py[i]! - frame.cy;
    const rx = dx * c + dy * s + frame.cx;
    const ry = dx * s - dy * c + frame.cy;
    if (inkAt(frame.mask, rx, ry)) hit++;
  }
  return hit / frame.count;
}

/** Best mirror symmetry over a sweep of axis angles (coarse then refined). */
export function bestMirrorSymmetry(frame: InkFrame, steps = 24): number {
  let best = 0;
  for (let i = 0; i < steps; i++) {
    const score = mirrorSelfSimilarity(frame, (Math.PI * i) / steps);
    if (score > best) best = score;
  }
  return best;
}
