/**
 * Exact Euclidean distance transform — Felzenszwalb & Huttenlocher's
 * two-pass lower-envelope algorithm over squared distances, O(n) per row and
 * column. Gives interior "thickness" at every ink pixel; this one array
 * drives inflation depth, medial-axis extraction, and eye placement.
 */

import type { DistanceField, Mask } from './types';

const INF = 1e20;

/** 1D squared-distance transform (lower envelope of parabolas), in place over f. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/**
 * Distance (in pixels) from each ink pixel to the nearest background pixel.
 * Background pixels get 0.
 */
export function distanceTransform(mask: Mask): DistanceField {
  const { size, data } = mask;
  const sq = new Float64Array(size * size);
  for (let i = 0; i < sq.length; i++) sq[i] = data[i] === 1 ? INF : 0;

  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);

  // columns
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) f[y] = sq[y * size + x]!;
    edt1d(f, size, d, v, z);
    for (let y = 0; y < size; y++) sq[y * size + x] = d[y]!;
  }
  // rows
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) f[x] = sq[row + x]!;
    edt1d(f, size, d, v, z);
    for (let x = 0; x < size; x++) sq[row + x] = d[x]!;
  }

  const out = new Float32Array(size * size);
  let max = 0;
  for (let i = 0; i < out.length; i++) {
    const dist = Math.sqrt(sq[i]!);
    out[i] = dist;
    if (dist > max) max = dist;
  }
  return { size, data: out, max };
}
