/**
 * Fire — where a painted flame has got to, what is alight right now, and
 * what it has already burnt to scorch. PURE (no Three.js, no DOM, no
 * `Date`, no `Math.random`), so a test can run it in node and, far more
 * importantly, so every screen in the room computes the same fire.
 *
 * WHY (2026-09-10, user ask: *"the brushes should have real world physics as
 * well just in the style of ref world"*). A fire brush that spawned particles
 * from a local clock would burn a different patch of grass on every phone in
 * the room. So there is no simulation state anywhere: `burnState` is a
 * FUNCTION of the two painted layers, the per-texel stamp time and the
 * current time. Given the same paint and the same `nowMs` it answers the same
 * field on a phone that joined thirty seconds ago as on the projection that
 * lit the match — which is the same guarantee `src/shape/` gives a drawing,
 * one system over.
 *
 * THE MODEL, and it is deliberately the smallest one that reads:
 *
 *   - every texel the fire brush painted is a SOURCE, alight from the moment
 *     it was stamped (`fireAt`, session-ms — the stamp's own `t`, which is
 *     the one clock every screen agrees on);
 *   - the front advances from a source across CONTIGUOUS PAINTED GRASS at a
 *     fixed rate in texels a second, biased along the wind;
 *   - a texel burns for `BURN_MS` and then is scorch, permanently;
 *   - grass under scorch is consumed — `scatter.ts` treats its weight as 0 at
 *     placement, so the tufts in a burnt cell are simply not placed;
 *   - nothing spreads onto ground with no painted grass on it. A fire brushed
 *     onto bare paper burns its own texels out and stops, which is what makes
 *     the tool safe to hand an operator in front of an audience.
 *
 * Ignition times come out of one Dijkstra pass over the fuel texels — the
 * front is a shortest-time field, so a fire lit at two ends of a patch meets
 * in the middle exactly once and never double-counts. The frontier is
 * restricted to fuel, so an unpainted world costs one pass over an empty
 * source list.
 */

import { MOTION } from '../taste/tokens';

/** [D] Fire weight above which a texel is a source the brush lit itself. */
export const FIRE_MIN = 0.12;

/** [D] Grass weight that counts as fuel. Deliberately low: the edge of a
 * grass stroke fades over half a texel, and a fire that stopped dead at the
 * 50% contour would draw a rim nobody painted (TASTE §2.5). */
export const FUEL_MIN = 0.06;

/**
 * [D] How fast the front crosses fuel, texels a second.
 *
 * At `PLANTING_RES` 256 over 400 units a texel is 1.56 u, so this is ~2.5
 * world units a second — slow enough to watch travel across a painted patch,
 * fast enough that a demo does not wait on it.
 */
export const SPREAD_TEXELS_PER_S = 1.6;

/** [D] How long one texel stays alight before it is scorch. One ambient
 * beat: the fire's own rhythm is the world's (TASTE §2.1, MOTION tokens). */
export const BURN_MS = MOTION.ambientMs;

/**
 * [D] How much the wind hurries the front downwind and holds it back
 * upwind, as a fraction of the base rate. Under 1 by construction — a fire
 * that could not creep upwind at all would burn a painted patch into a
 * clean-edged wedge, and this map has no clean edges.
 */
export const WIND_BIAS = 0.55;

/** [D] The flame's own fade in and out, as a fraction of `BURN_MS`. A texel
 * does not switch on: TASTE §2.1 forbids the hard cut, so the envelope this
 * returns rises and falls and the marks placed from it ride that value. */
const IGNITE_FRAC = 0.18;
const DIE_FRAC = 0.3;

/** [D] How long the scorch takes to darken to full after the flame leaves —
 * half a beat, so the ground blackens as the fire walks off it rather than
 * behind a cut. */
const SCORCH_FADE_MS = MOTION.ambientMs * 0.5;

export interface BurnInput {
  /** The `fire` weight layer, `res²` floats in [0,1]. */
  fire: Float32Array;
  /**
   * Session-ms at which each texel was lit — the `t` of the paint event that
   * stamped it. 0 in every texel no fire has been painted into.
   */
  fireAt: Float32Array;
  /** The `grass` weight layer, `res²` floats in [0,1]. The fuel. */
  grass: Float32Array;
  /** Texels a side. Both layers are square and this size. */
  res: number;
  /** Session-ms now — the same clock `fireAt` is in. */
  nowMs: number;
  /** The world's live wind heading, radians (scatter's `windAzimuth`). */
  windAzimuth: number;
}

export interface BurnField {
  /**
   * Flame envelope per texel, [0,1] — 0 where nothing is alight, rising and
   * falling over the ends of the burn so no flame ever pops.
   */
  burning: Float32Array;
  /** Scorch per texel, [0,1] — permanent once a texel has finished burning. */
  scorch: Float32Array;
  /** Session-ms at which each texel ignites, `Infinity` where it never will.
   * Exposed because it is the whole model, and a test that measures the
   * front measures this. */
  ignite: Float32Array;
  /** True while any texel is still alight or still waiting to catch. When it
   * goes false the fire is out and only scorch remains — the driver stops
   * re-evaluating. */
  active: boolean;
}

/** A tiny binary min-heap over (time, index). No allocation per pop, and
 * deterministic: ties break on insertion order, which is texel order. */
class TimeHeap {
  private readonly t: number[] = [];
  private readonly i: number[] = [];

  get size(): number {
    return this.i.length;
  }

  push(time: number, index: number): void {
    this.t.push(time);
    this.i.push(index);
    let c = this.i.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if ((this.t[p] as number) <= (this.t[c] as number)) break;
      this.swap(p, c);
      c = p;
    }
  }

  pop(): { time: number; index: number } | null {
    const n = this.i.length;
    if (n === 0) return null;
    const out = { time: this.t[0] as number, index: this.i[0] as number };
    const lastT = this.t.pop() as number;
    const lastI = this.i.pop() as number;
    if (n > 1) {
      this.t[0] = lastT;
      this.i[0] = lastI;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let s = p;
        if (l < this.i.length && (this.t[l] as number) < (this.t[s] as number)) s = l;
        if (r < this.i.length && (this.t[r] as number) < (this.t[s] as number)) s = r;
        if (s === p) break;
        this.swap(s, p);
        p = s;
      }
    }
    return out;
  }

  private swap(a: number, b: number): void {
    const tt = this.t[a] as number;
    this.t[a] = this.t[b] as number;
    this.t[b] = tt;
    const ii = this.i[a] as number;
    this.i[a] = this.i[b] as number;
    this.i[b] = ii;
  }
}

/** The eight neighbour steps, and the texel distance each covers. */
const STEPS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * Where the fire has got to at `nowMs`.
 *
 * Pure and total: same inputs, same arrays out, no state kept between calls.
 * The cost is one Dijkstra over the FUEL texels only, so an unpainted world
 * (no sources) returns three zeroed arrays after one scan of the fire layer.
 */
export function burnState(input: BurnInput): BurnField {
  const { fire, fireAt, grass, res, nowMs, windAzimuth } = input;
  const count = res * res;
  const ignite = new Float32Array(count).fill(Infinity);
  const burning = new Float32Array(count);
  const scorch = new Float32Array(count);

  // The wind, as a unit vector in the layer's own axes: texel +x is world +x
  // and texel +y is world +z (the uv mapping in src/world/painted.ts).
  const windX = Math.sin(windAzimuth);
  const windZ = Math.cos(windAzimuth);

  const heap = new TimeHeap();
  let anySource = false;
  for (let i = 0; i < count; i++) {
    if ((fire[i] ?? 0) <= FIRE_MIN) continue;
    // A texel with no recorded stamp time is one the brush wrote before the
    // fire driver saw it; it is lit as of the epoch, which is the earliest
    // any event can be, so it simply burns first.
    const at = fireAt[i] ?? 0;
    if (at < (ignite[i] as number)) {
      ignite[i] = at;
      // The array is Float32 and the heap key is not: push the value BACK OUT
      // of the array, so the two are the same number. Pushing the float64 and
      // comparing it against the rounded float32 on the way out makes the
      // staleness check below reject a live entry, and the front stops one
      // texel past the source with no error anywhere.
      heap.push(ignite[i] as number, i);
    }
    anySource = true;
  }

  if (anySource) {
    const done = new Uint8Array(count);
    for (;;) {
      const top = heap.pop();
      if (!top) break;
      const i = top.index;
      if (done[i]) continue;
      if (top.time > (ignite[i] as number)) continue;
      done[i] = 1;
      const tx = i % res;
      const ty = (i - tx) / res;
      for (const [sx, sy, dist] of STEPS) {
        const nx = tx + sx;
        const ny = ty + sy;
        if (nx < 0 || nx >= res || ny < 0 || ny >= res) continue;
        const j = ny * res + nx;
        if (done[j]) continue;
        // The one hard rule: no spread beyond painted grass. A neighbour
        // with no fuel on it is not reached at all — not reached slowly.
        if ((grass[j] ?? 0) <= FUEL_MIN) continue;
        const inv = 1 / dist;
        const along = (sx * inv) * windX + (sy * inv) * windZ;
        const rate = SPREAD_TEXELS_PER_S * (1 + WIND_BIAS * along);
        const cost = (dist / rate) * 1000;
        const t = (ignite[i] as number) + cost;
        if (t < (ignite[j] as number)) {
          ignite[j] = t;
          heap.push(ignite[j] as number, j);
        }
      }
    }
  }

  let active = false;
  const inMs = BURN_MS * IGNITE_FRAC;
  const outStart = BURN_MS * (1 - DIE_FRAC);
  for (let i = 0; i < count; i++) {
    const at = ignite[i] as number;
    if (!Number.isFinite(at)) continue;
    const age = nowMs - at;
    if (age < 0) {
      // Painted in the future — a log replayed ahead of itself. Nothing is
      // alight yet, but the fire is not out either.
      active = true;
      continue;
    }
    if (age < BURN_MS) {
      active = true;
      const rise = inMs > 0 ? Math.min(1, age / inMs) : 1;
      const fall =
        age > outStart ? Math.max(0, 1 - (age - outStart) / (BURN_MS - outStart)) : 1;
      burning[i] = Math.min(rise, fall);
      // The ground darkens under the flame rather than after it: by the time
      // the mark leaves, the scorch it stands on is already most of the way
      // there, so nothing on screen changes value in one step.
      scorch[i] = Math.min(1, age / (BURN_MS + SCORCH_FADE_MS));
      continue;
    }
    scorch[i] = Math.min(1, (age - BURN_MS + SCORCH_FADE_MS) / SCORCH_FADE_MS);
  }

  return { burning, scorch, ignite, active };
}
