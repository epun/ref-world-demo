/**
 * Deterministic seeds and hashes for the phone screens. Pure — no DOM, no
 * Math.random, no Date: the same drawing must wobble, wander, and waver
 * identically on every device and every reload (PLAN §6.3).
 */

import type { StrokeList } from '../shape/types';

/** Cheap deterministic hash → [0, 1). Same recipe as src/motion/ambient.ts. */
export function hash01(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Stable per-drawing seed (point count + first point coordinates), mirroring
 * the character's drift seed so phone-side motion decorrelates per drawing
 * without ever disagreeing between devices.
 */
export function strokeSeed(strokes: StrokeList): number {
  let points = 0;
  for (const stroke of strokes) points += stroke.pts.length;
  const first = strokes[0]?.pts[0];
  const fx = first ? first[0] : 0;
  const fy = first ? first[1] : 0;
  return (points % 971) * 0.618 + fx * 37.42 + fy * 91.17;
}
