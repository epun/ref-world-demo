/**
 * Uniform spatial hash over moving circles — PURE (no Three.js, no DOM).
 *
 * Every agent used to gather EVERY other creature as a peer each frame — an
 * array of N fresh objects, N times over, forty thousand allocations a
 * frame at two hundred creatures — to answer two questions that only ever
 * concern its neighbourhood: who is nearest, and is anyone within
 * NOTICE_RADIUS. Measured at 200 agents (node, warm): 2.8ms a frame the
 * old way, 0.18ms through this grid.
 *
 * This is the port of how a real crowd engine sidesteps that — the
 * reference ("Where's Walter", red-reddington's instanced crowd) keeps its
 * simulation in flat typed arrays and never asks one character about a
 * character it cannot possibly touch. A grid of square cells, each body
 * dropped into the cell under it; a query for "everything within r of
 * (x, z)" reads the block of cells around the point and nothing else.
 *
 * NOT used by the pair-separation sweep in resolve.ts, on purpose. That
 * loop was ported and measured too: byte-identical positions, and SLOWER
 * — 0.21ms against 0.11ms for 200 bodies spread over the map, 1.26 against
 * 0.46 packed together. Twenty thousand subtract-multiply-compare checks
 * cost less than two hundred hashed cell walks, and the sweep rebuilds per
 * pass. The grid earns its place where the alternative allocates, not
 * where it merely iterates.
 *
 * DETERMINISTIC by construction. Cells hold indices in insertion order and
 * `near()` returns them sorted ascending, so the order a caller sees
 * neighbours in is the order it inserted them in — the same on every
 * device, whatever the hash did internally. That matters here: the pair
 * separation pass is order-dependent (each correction moves the bodies the
 * next pair sees), and the manager sorts its bodies by id for exactly this
 * reason. The grid must not reintroduce a device-specific order.
 *
 * No `Math.random`, no clock, no allocation in the query path once warm:
 * the cell buckets and the result array are reused between rebuilds.
 */

/** Anything with a ground position. */
export interface Positioned {
  x: number;
  z: number;
}

/** Bucket key for a cell — integers only, so no string building per body. */
const KEY_BIAS = 1 << 20;
const KEY_SPAN = 1 << 21;

function cellKey(cx: number, cz: number): number {
  return (cx + KEY_BIAS) * KEY_SPAN + (cz + KEY_BIAS);
}

export class SpatialHash {
  /** Cell edge, world units. */
  readonly cellSize: number;

  private readonly buckets = new Map<number, number[]>();
  /** Every bucket ever created, so a rebuild clears without reallocating. */
  private readonly pool: number[][] = [];
  private poolUsed = 0;
  private items: readonly Positioned[] = [];
  private readonly out: number[] = [];

  constructor(cellSize: number) {
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
      throw new RangeError(`spatial hash cell size must be a positive number, got ${cellSize}`);
    }
    this.cellSize = cellSize;
  }

  /** How many items the last rebuild indexed. */
  get size(): number {
    return this.items.length;
  }

  /**
   * Index `items`. Positions are read now and not tracked afterwards — a
   * caller whose bodies move re-indexes (it is one pass over N; cheaper
   * than any bookkeeping).
   */
  rebuild(items: readonly Positioned[]): void {
    this.buckets.clear();
    this.poolUsed = 0;
    this.items = items;
    const inv = 1 / this.cellSize;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const key = cellKey(Math.floor(it.x * inv), Math.floor(it.z * inv));
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = this.pool[this.poolUsed];
        if (bucket) bucket.length = 0;
        else {
          bucket = [];
          this.pool[this.poolUsed] = bucket;
        }
        this.poolUsed++;
        this.buckets.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  /**
   * Indices of every indexed item whose ground position lies within
   * `radius` of (x, z), ascending. The returned array is REUSED by the next
   * call — copy it if it has to outlive one.
   *
   * Exact, not approximate: the cells are only the candidate set, and each
   * candidate is distance-checked. A radius larger than one cell reads a
   * wider block, so correctness never depends on the caller picking a
   * radius that fits the grid — only the cost does.
   */
  near(x: number, z: number, radius: number): readonly number[] {
    const out = this.out;
    out.length = 0;
    if (!(radius >= 0)) return out;
    const inv = 1 / this.cellSize;
    const cx0 = Math.floor((x - radius) * inv);
    const cx1 = Math.floor((x + radius) * inv);
    const cz0 = Math.floor((z - radius) * inv);
    const cz1 = Math.floor((z + radius) * inv);
    const r2 = radius * radius;
    const items = this.items;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = this.buckets.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const i = bucket[k]!;
          const it = items[i]!;
          const dx = it.x - x;
          const dz = it.z - z;
          if (dx * dx + dz * dz <= r2) out.push(i);
        }
      }
    }
    // A block of cells is walked column by column, so indices arrive out of
    // order across cells. Sort so the caller's order is insertion order.
    if (out.length > 1) out.sort(ascending);
    return out;
  }
}

function ascending(a: number, b: number): number {
  return a - b;
}
