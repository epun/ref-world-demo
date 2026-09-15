/**
 * Collider spatial hash — PURE (no Three.js, no DOM, no clocks).
 *
 * The world's props publish footprint circles (src/world/scatter.ts →
 * colliders()); creatures resolve against them every frame. This module is
 * the index that keeps that O(creatures × nearby), never O(creatures ×
 * all-props): circles are binned into ~8-unit grid cells at build time, and
 * queryCircle walks only the cells the query circle touches.
 *
 * Determinism: hashing is integer math on cell coordinates; build order is
 * input order; query results always come back in collider input order
 * (buckets store indices and dedupe via a stamp array, so iteration order is
 * reproducible on every device).
 *
 * Allocation discipline: query reuses one result array per grid — zero
 * allocation per call. Callers must copy if they hold results across
 * queries.
 */

/** A footprint circle on the ground plane (x/z only — the Surface seam owns
 * height). Hard bodies block via positional resolve; soft bodies damp and
 * sway (bushes). */
export interface Collider {
  x: number;
  z: number;
  /** Footprint radius, world units. */
  r: number;
  hard: boolean;
}

/** Grid cell edge, world units. Props are 0.5–2.5u circles and creatures
 * query ~2u neighborhoods, so 8u cells keep buckets small and queries to
 * 1–4 cells. */
export const GRID_CELL_SIZE = 8;

export interface ColliderGrid {
  readonly cellSize: number;
  /** The colliders this grid indexes, in build order. */
  readonly colliders: readonly Collider[];
  /**
   * Every collider whose circle strictly overlaps the query circle
   * (dist < r + c.r — tangency does not count). The returned array is
   * REUSED by the next query on this grid: copy it to hold it.
   */
  queryCircle(x: number, z: number, r: number): readonly Collider[];
}

/** Deterministic cell key. Collisions only merge candidate buckets — the
 * exact circle test filters, so correctness never depends on this hash. */
function cellKey(cx: number, cz: number): number {
  return ((cx * 92837111) ^ (cz * 689287499)) | 0;
}

/** Build a spatial hash over the colliders. Rebuild whenever the collider
 * set changes (scatter exposes a version counter for exactly this). */
export function buildColliderGrid(
  colliders: readonly Collider[],
  cellSize: number = GRID_CELL_SIZE,
): ColliderGrid {
  const cells = new Map<number, number[]>();
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i]!;
    const x0 = Math.floor((c.x - c.r) / cellSize);
    const x1 = Math.floor((c.x + c.r) / cellSize);
    const z0 = Math.floor((c.z - c.r) / cellSize);
    const z1 = Math.floor((c.z + c.r) / cellSize);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = cellKey(cx, cz);
        const bucket = cells.get(key);
        if (bucket) bucket.push(i);
        else cells.set(key, [i]);
      }
    }
  }

  // Query scratch: stamp array dedupes colliders spanning several cells;
  // the result array is reused across calls (no allocation churn).
  const stamps = new Uint32Array(colliders.length);
  let queryId = 0;
  const result: Collider[] = [];
  // Candidate indices gathered first so results return in input order
  // regardless of cell walk order.
  const candidates: number[] = [];

  return {
    cellSize,
    colliders,
    queryCircle(x: number, z: number, r: number): readonly Collider[] {
      queryId = (queryId + 1) >>> 0;
      if (queryId === 0) {
        // Uint32 wrap: clear stale stamps once every ~4e9 queries.
        stamps.fill(0);
        queryId = 1;
      }
      result.length = 0;
      candidates.length = 0;
      const x0 = Math.floor((x - r) / cellSize);
      const x1 = Math.floor((x + r) / cellSize);
      const z0 = Math.floor((z - r) / cellSize);
      const z1 = Math.floor((z + r) / cellSize);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const bucket = cells.get(cellKey(cx, cz));
          if (!bucket) continue;
          for (const i of bucket) {
            if (stamps[i] === queryId) continue;
            stamps[i] = queryId;
            candidates.push(i);
          }
        }
      }
      candidates.sort((a, b) => a - b);
      for (const i of candidates) {
        const c = colliders[i]!;
        const dx = x - c.x;
        const dz = z - c.z;
        const rr = r + c.r;
        if (dx * dx + dz * dz < rr * rr) result.push(c);
      }
      return result;
    },
  };
}
