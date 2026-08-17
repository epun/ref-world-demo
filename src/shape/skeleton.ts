/**
 * Medial-axis extraction and feature reading.
 *
 * The skeleton comes from distance-field ridges: an ink pixel is a ridge
 * pixel if its DT value is a local maximum along at least one axis pair.
 * The ridge set is then thinned into a graph and pruned; leaves are the
 * character's extremities (head, feet, limbs).
 */

import type { DistanceField, Mask, Point, SkeletonLeaf } from './types';

/**
 * Zhang–Suen thinning: erode the ridge set down to 1-px-wide curves while
 * preserving connectivity and endpoints. The raw ridge test marks whole
 * plateaus (uniform tubes, disc interiors) as ridge, so without this pass
 * endpoints never have exactly one neighbor and leaf detection finds nothing.
 */
function thinSkeleton(skel: Uint8Array, size: number): Uint8Array {
  const at = (x: number, y: number): number =>
    x >= 0 && x < size && y >= 0 && y < size ? skel[y * size + x]! : 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const kill: number[] = [];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (at(x, y) !== 1) continue;
          // Neighbors in Zhang–Suen order: p2..p9 clockwise from north.
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue; // endpoint or interior — keep
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
          if (a !== 1) continue; // removal would split the skeleton
          if (pass === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          kill.push(y * size + x);
        }
      }
      for (const i of kill) skel[i] = 0;
      if (kill.length > 0) changed = true;
    }
  }
  return skel;
}

/**
 * Ridge detection on the distance field, thinned to a 1-px skeleton.
 * Returns a binary skeleton mask.
 */
export function extractRidges(dist: DistanceField, mask: Mask): Uint8Array {
  const { size, data } = dist;
  const out = new Uint8Array(size * size);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      if (mask.data[i] !== 1) continue;
      const v = data[i]!;
      if (v < 1.5) continue; // too thin to carry a skeleton
      // Local-maximum along any of the 4 axis pairs
      const ridge =
        (v >= data[i - 1]! && v >= data[i + 1]!) ||
        (v >= data[i - size]! && v >= data[i + size]!) ||
        (v >= data[i - size - 1]! && v >= data[i + size + 1]!) ||
        (v >= data[i - size + 1]! && v >= data[i + size - 1]!);
      if (ridge) out[i] = 1;
    }
  }
  return thinSkeleton(out, size);
}

/** Count 8-neighbors that are skeleton pixels. */
function neighborCount(skel: Uint8Array, size: number, i: number): number {
  const x = i % size, y = (i / size) | 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < size && ny >= 0 && ny < size && skel[ny * size + nx] === 1) n++;
    }
  }
  return n;
}

/**
 * Find skeleton leaves: endpoints of the ridge set, with their path reach.
 * Walks from each endpoint along the skeleton until hitting a junction
 * (neighborCount > 2) or exceeding maxWalk. Pruned as noise, not limbs:
 *   - short spurs (reach < minReach) — rasterization noise;
 *   - branches subsumed by their junction's inscribed disc
 *     (thickness + reach ≈ junction DT) — the radial spokes a round lobe's
 *     medial axis degenerates into, not protrusions;
 *   - stubs thicker than they are long (reach ≤ 1.5 × thickness) — a limb
 *     sticks out.
 */
export function findLeaves(
  skel: Uint8Array,
  dist: DistanceField,
  minReach = 6,
): SkeletonLeaf[] {
  const size = dist.size;
  const leaves: SkeletonLeaf[] = [];
  for (let i = 0; i < skel.length; i++) {
    if (skel[i] !== 1) continue;
    if (neighborCount(skel, size, i) !== 1) continue; // endpoints only

    // Walk toward the junction.
    let reach = 0;
    let prev = -1;
    let cur = i;
    const maxWalk = size;
    while (reach < maxWalk) {
      const x = cur % size, y = (cur / size) | 0;
      let next = -1;
      for (let dy = -1; dy <= 1 && next < 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
          const ni = ny * size + nx;
          if (ni !== prev && skel[ni] === 1) { next = ni; break; }
        }
      }
      if (next < 0) break;
      const branches = neighborCount(skel, size, next);
      prev = cur;
      cur = next;
      reach++;
      if (branches > 2) break; // reached a junction
    }

    const thickness = dist.data[i]!;
    const junction = dist.data[cur]!;
    if (
      reach >= minReach &&
      thickness + reach > junction * 1.2 &&
      reach > thickness * 1.5
    ) {
      leaves.push({
        at: { x: i % size, y: (i / size) | 0 },
        thickness,
        reach,
      });
    }
  }
  return leaves;
}

/**
 * The head lobe: the position of the largest DT value in the upper region of
 * the ink bounds. This anchors the eyes.
 */
export function findHeadLobe(
  dist: DistanceField,
  bounds: { minY: number; maxY: number },
): Point {
  const { size, data } = dist;
  const upperLimit = bounds.minY + (bounds.maxY - bounds.minY) * 0.45;
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < size; y++) {
    if (y > upperLimit) break;
    for (let x = 0; x < size; x++) {
      const v = data[y * size + x]!;
      if (v > best) { best = v; bx = x; by = y; }
    }
  }
  return { x: bx, y: by };
}
