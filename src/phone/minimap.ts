/**
 * Pure minimap geometry (PLAN §6.3, TASTE §4): world→canvas mapping, peer
 * dot sizing, angle unwrapping for the heading spring, and the deterministic
 * hand-wavering border loop. No DOM, no canvas — screens/alive.ts draws,
 * this module only computes, so test/phone can cover it in a node
 * environment.
 */

import { hash01 } from './seed';

/** Canvas frame the world square maps into, in CSS px. */
export interface MapFrame {
  w: number;
  h: number;
  /** Margin kept clear inside the border on every side. */
  inset: number;
}

/** Default border inset, CSS px. Must exceed BORDER_WAVER. */
export const MAP_INSET = 9;

/**
 * Uniform, centered mapping from world coordinates (x/z in ±extent) into the
 * frame: the world square fits the smaller usable dimension, so nothing ever
 * stretches. Same aspect discipline as the world's own ground.
 */
export function worldToMap(
  x: number,
  z: number,
  extent: number,
  frame: MapFrame,
): { px: number; py: number } {
  const safeExtent = extent > 0 ? extent : 1;
  const usable = Math.min(frame.w, frame.h) - frame.inset * 2;
  const scale = Math.max(0, usable) / (2 * safeExtent);
  return { px: frame.w / 2 + x * scale, py: frame.h / 2 + z * scale };
}

/**
 * Peer marks scale with the cluster count they fold in (RosterEntry.n):
 * clusters read bigger, sqrt keeps the growth gentle, and a cap keeps a busy
 * room from flooding the field. `scale` shrinks every mark proportionally
 * when the map draws small (the corner inset) — quiet, still legible.
 */
export function peerDotRadius(n: number, scale = 1): number {
  const count = Math.max(1, n);
  return Math.min(8, 2.2 + 1.5 * Math.sqrt(count - 1)) * scale;
}

/** Map width the mark sizes above were tuned at, CSS px. */
export const MAP_MARK_BASE_PX = 240;

/**
 * Mark scale for a map drawn `mapPx` wide: proportional below the tuned
 * baseline, capped at 1 (a big map never inflates its marks), floored at
 * 0.5 so dots and the self-marker ring stay legible on the smallest inset.
 */
export function mapMarkScale(mapPx: number): number {
  return Math.min(1, Math.max(0.5, mapPx / MAP_MARK_BASE_PX));
}

/**
 * Border inset for a scaled map — shrinks with the marks so the small inset
 * map keeps its field, but never dips below the waver amplitude plus a
 * hairline's clearance (the border must not clip the canvas).
 */
export function mapBorderInset(scale: number): number {
  return Math.max(BORDER_WAVER + 2.4, MAP_INSET * scale);
}

/**
 * Unwrap `target` to the representation nearest `current`, so a heading
 * spring always turns the short way instead of whipping through ±π.
 */
export function nearestAngleTarget(current: number, target: number): number {
  const tau = Math.PI * 2;
  let t = target;
  while (t - current > Math.PI) t -= tau;
  while (t - current < -Math.PI) t += tau;
  return t;
}

export interface BorderPoint {
  x: number;
  y: number;
}

/** Maximum normal offset of the wavering border, CSS px. */
export const BORDER_WAVER = 1.6;

/** Fraction of each edge left clear at the corners; the gap rounds off when
 * the loop is drawn with midpoint smoothing, giving the organic corner. */
const CORNER_MARGIN = 0.07;

/**
 * The minimap border as a slightly wavering closed loop — hand-drawn feel,
 * fully deterministic per seed (TASTE §4: a thin border, never a card).
 * Points sit on an inset rectangle, nudged along the edge normal by seeded
 * hash noise; corners are skipped so smoothing rounds them organically.
 * Draw it with quadratic midpoint smoothing (see screens/alive.ts).
 */
export function wavyBorderPoints(
  w: number,
  h: number,
  inset: number,
  seed: number,
  perEdge = 12,
): BorderPoint[] {
  const points: BorderPoint[] = [];
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  let k = 0;

  const push = (x: number, y: number, nx: number, ny: number): void => {
    const off = (hash01(k * 12.9898 + seed * 78.233) - 0.5) * 2 * BORDER_WAVER;
    points.push({ x: x + nx * off, y: y + ny * off });
    k++;
  };

  const along = (i: number): number =>
    CORNER_MARGIN + (i / Math.max(1, perEdge - 1)) * (1 - 2 * CORNER_MARGIN);

  for (let i = 0; i < perEdge; i++) push(x0 + along(i) * (x1 - x0), y0, 0, 1); // top
  for (let i = 0; i < perEdge; i++) push(x1, y0 + along(i) * (y1 - y0), -1, 0); // right
  for (let i = 0; i < perEdge; i++) push(x1 - along(i) * (x1 - x0), y1, 0, -1); // bottom
  for (let i = 0; i < perEdge; i++) push(x0, y1 - along(i) * (y1 - y0), 1, 0); // left
  return points;
}
