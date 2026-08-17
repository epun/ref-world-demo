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
 * room from flooding the field.
 */
export function peerDotRadius(n: number): number {
  const count = Math.max(1, n);
  return Math.min(8, 2.2 + 1.5 * Math.sqrt(count - 1));
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
