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
 * Ridge detection on the distance field. Returns a binary skeleton mask.
 * Thresholding at a fraction of local max keeps spurs down before pruning.
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
  return out;
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
 * (neighborCount > 2) or exceeding maxWalk. Short spurs (reach < minReach)
 * are pruned — they're rasterization noise, not limbs.
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

    if (reach >= minReach) {
      leaves.push({
        at: { x: i % size, y: (i / size) | 0 },
        thickness: dist.data[i]!,
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
