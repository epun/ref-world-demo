/**
 * Painted water — PURE (no Three.js, no DOM, no clocks, no Math.random, and
 * no `envpaint` import).
 *
 * Plan step 4 (envpaint docs/port-meridian.md §2.2, §5): the one genuinely
 * new piece of the port. An authored body of water is a blob whose shoreline
 * is walked round a centre; a painted one has no blob. This module turns the
 * painted LEVEL layer (src/world/painted.ts `PaintedMap.water`) into bodies —
 * connected components with one level each — and into a signed distance field
 * to the nearest shoreline, and traces the zero contour of that field into the
 * rings the water renderer, the reed walk, the ripple placement and the
 * collider tiling already know how to consume.
 *
 * The distance field is the workhorse: it is what `terrainHeight` cuts the
 * basin from (the same shore-ramp maths as an authored body, with `-shore`
 * standing in for the distance outside a wobbled radius), what keeps ripple
 * marks off the shore, what the hex collider tiling shrinks by, and what the
 * outlines are the zero-crossing of — so the ground, the ink, the fill and the
 * colliders all agree on where the water ends, by construction.
 */

import { DRY, type PaintedMap } from './painted';

export { DRY };

/** A body of painted water, traced from the painted level layer. */
export interface PaintedBody {
  /** 0-based, in raster order of each body's first texel. */
  id: number;
  /** Absolute surface height of the sheet, world units. */
  level: number;
  /** Hash salt for pen lifts and ripple placement: the body's first texel
   * index, so the same painted shape always draws the same. */
  seed: number;
  /** Outer shoreline, counter-clockwise in world x/z, last point not repeated. */
  outline: [number, number][];
  /** Islands inside it: each ring counter-clockwise as well (like `islandOutline`). */
  holes: [number, number][][];
  /** World-unit bounds of the outline. */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  /** Water texels in the body. */
  texels: number;
}

/** What the geography reads from a painted water map. */
export interface PaintedWaterField {
  /** Signed distance to the nearest painted shoreline, world units: > 0
   * inside water, < 0 on land. Continuous (bilinear between texel centres).
   * Outside the map, and everywhere when the map holds no water, it is
   * `-PAINTED_SHORE_FAR`. */
  shore(x: number, z: number): number;
  /** Level of the painted body whose shore `shore(x, z)` measured (nearest
   * water texel). Meaningful wherever `shore(x, z) > -TERRAIN.shoreRamp *
   * relief`; 0 outside the map. */
  level(x: number, z: number): number;
  bodies: readonly PaintedBody[];
}

/** "No shore anywhere near" — far larger than any ramp the geography uses. */
export const PAINTED_SHORE_FAR = 1e4;

/**
 * [D] Fewer texels than this and a water component is spatter, not a body.
 *
 * A brush with an edge shape throws droplets: EnvPaint's stamps are noisy at
 * the rim by design (TASTE §2.5 — no clean discs), so a stroke of water lands
 * with a scattering of one- and two-texel specks around it. Twelve texels at
 * the shipped resolution is about 7 u² — a puddle a creature could stand in
 * without getting its feet wet. Anything smaller is a mark, and a mark that
 * became a body would get a shoreline, reeds, ripples and colliders of its
 * own, which is a lot of world for a droplet.
 */
export const MIN_BODY_TEXELS = 12;

/** [D] The same argument in the mirror: a land component this small inside a
 * body is a hole the brush missed, not an island. It is filled with the
 * water's own level rather than kept, because an island is a place you look
 * at (landscape.ts) and a 7 u² one is a gap in the paint. */
export const MIN_HOLE_TEXELS = 12;

// ── the derivation ───────────────────────────────────────────────────────────

/** Squared distance meaning "no source in this row/column at all". */
const INF = Infinity;

/**
 * One exact Euclidean distance transform over a `res × res` boolean mask,
 * squared distances in texels, with the index of the nearest source texel.
 *
 * Felzenszwalb & Huttenlocher's separable method: a row pass that finds the
 * nearest source IN EACH ROW by two sweeps, then a column pass that takes the
 * lower envelope of the parabolas those row distances define. Exact — not the
 * chamfer approximation — which matters because the zero contour of the field
 * is the shoreline every other system reads, and a chamfer's error is
 * anisotropic: a shore traced from it would be visibly flat-sided on the
 * diagonals.
 *
 * Rows with no source at all are SKIPPED in the column pass rather than
 * carrying an infinite parabola, which would make the intersection maths
 * `Infinity - Infinity`.
 */
function distanceTransform(
  res: number,
  source: Uint8Array,
): { dist: Float64Array; nearest: Int32Array } {
  const n = res * res;
  const rowDist = new Float64Array(n);
  const rowSrc = new Int32Array(n);
  for (let y = 0; y < res; y++) {
    const base = y * res;
    let last = -1;
    for (let x = 0; x < res; x++) {
      if (source[base + x] === 1) last = x;
      if (last < 0) {
        rowDist[base + x] = INF;
        rowSrc[base + x] = -1;
      } else {
        rowDist[base + x] = (x - last) * (x - last);
        rowSrc[base + x] = last;
      }
    }
    last = -1;
    for (let x = res - 1; x >= 0; x--) {
      if (source[base + x] === 1) last = x;
      if (last < 0) continue;
      const d = (last - x) * (last - x);
      if (d < rowDist[base + x]!) {
        rowDist[base + x] = d;
        rowSrc[base + x] = last;
      }
    }
  }

  const dist = new Float64Array(n);
  const nearest = new Int32Array(n);
  // Lower-envelope scratch: the parabola vertices `v` and the boundaries `z`
  // between the ranges they win over.
  const v = new Int32Array(res);
  const z = new Float64Array(res + 1);
  for (let x = 0; x < res; x++) {
    let k = -1;
    for (let y = 0; y < res; y++) {
      const f = rowDist[y * res + x]!;
      if (!Number.isFinite(f)) continue;
      if (k < 0) {
        k = 0;
        v[0] = y;
        z[0] = -INF;
        z[1] = INF;
        continue;
      }
      let p = v[k]!;
      let s = (f + y * y - (rowDist[p * res + x]! + p * p)) / (2 * y - 2 * p);
      while (k > 0 && s <= z[k]!) {
        k--;
        p = v[k]!;
        s = (f + y * y - (rowDist[p * res + x]! + p * p)) / (2 * y - 2 * p);
      }
      k++;
      v[k] = y;
      z[k] = s;
      z[k + 1] = INF;
    }
    if (k < 0) {
      for (let y = 0; y < res; y++) {
        dist[y * res + x] = INF;
        nearest[y * res + x] = -1;
      }
      continue;
    }
    let j = 0;
    for (let y = 0; y < res; y++) {
      while (z[j + 1]! < y) j++;
      const p = v[j]!;
      const dy = y - p;
      dist[y * res + x] = dy * dy + rowDist[p * res + x]!;
      nearest[y * res + x] = p * res + rowSrc[p * res + x]!;
    }
  }
  return { dist, nearest };
}

/** Signed area of a closed ring, `½Σ(x_i z_{i+1} − x_{i+1} z_i)`: positive
 * counter-clockwise, the convention `waterOutline` and `walkShore` share. */
function signedArea(ring: readonly [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * One Chaikin corner-cutting pass over a closed ring: every edge a→b gives
 * back its quarter and three-quarter points, so the point count doubles and
 * every corner is replaced by a short chamfer.
 *
 * ONE pass, not the usual three or four [D]: the rings come off a texel grid
 * and their corners are all right angles, so a single cut is the difference
 * between a staircase and a shoreline; a second would start eating the
 * peninsulas the paint actually has. The ring stays closed and keeps its
 * winding (the output is an affine mix of consecutive inputs).
 */
function chaikin(ring: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    out.push([a[0] + dx * 0.25, a[1] + dz * 0.25]);
    out.push([a[0] + dx * 0.75, a[1] + dz * 0.75]);
  }
  return out;
}

/**
 * Bodies and a shore field from the painted level layer, or null when the map
 * holds no water once the spatter is culled.
 *
 * MUTATES `map.water`: culled specks go back to `DRY`, pinholes are filled,
 * and every texel of a body is levelled to that body's own surface. That is
 * the point — the layer a person paints into and the layer the world reads
 * are the same array, so the tidying has to be visible in the paint or the
 * next stroke would resurrect it. The caller marks the layer dirty on its own
 * terms (the paint skill re-derives after every stroke anyway).
 *
 * The five passes, in order:
 *
 *  1. label the water's 8-connected components,
 *  2. cull the ones under `MIN_BODY_TEXELS`,
 *  3. fill the 4-connected land components under `MIN_HOLE_TEXELS` that do
 *     not reach the map's border — 8-connected water against 4-connected
 *     land is the consistent pairing, the one where a diagonal seam cannot be
 *     both a join and a gap,
 *  4. equalise: one plane a body,
 *  5. the signed distance field, and the zero contour traced off it.
 */
export function deriveWater(map: PaintedMap): PaintedWaterField | null {
  const { res, size } = map;
  const W = map.water;
  const texel = size / res;
  const n = res * res;

  const wet = (i: number): boolean => {
    const v = W[i]!;
    // NaN is dry: a level that is not a number cannot be a surface, and
    // letting one through would poison every min and every bilinear read.
    return Number.isFinite(v) && v !== DRY;
  };

  // ── 1. water components, 8-connected ──────────────────────────────────────
  const label = new Int32Array(n).fill(-1);
  const count: number[] = [];
  const minLevel: number[] = [];
  const first: number[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (label[seed] !== -1 || !wet(seed)) continue;
    const id = count.length;
    count.push(0);
    minLevel.push(INF);
    first.push(seed);
    label[seed] = id;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % res;
      const y = (i - x) / res;
      count[id]!++;
      const lv = W[i]!;
      if (lv < minLevel[id]!) minLevel[id] = lv;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= res) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= res) continue;
          const j = ny * res + nx;
          if (label[j] !== -1 || !wet(j)) continue;
          label[j] = id;
          stack.push(j);
        }
      }
    }
  }

  // ── 2. cull the spatter ───────────────────────────────────────────────────
  let alive = 0;
  for (let id = 0; id < count.length; id++) if (count[id]! >= MIN_BODY_TEXELS) alive++;
  if (alive < count.length) {
    for (let i = 0; i < n; i++) {
      const id = label[i]!;
      if (id < 0 || count[id]! >= MIN_BODY_TEXELS) continue;
      label[i] = -1;
      W[i] = DRY;
    }
  }
  if (alive === 0) return null;

  // ── 3. fill the pinholes ──────────────────────────────────────────────────
  // Land components are 4-connected here on purpose (see the header comment):
  // with 8-connected water, 4-connected land is the pairing where the boundary
  // of an enclosed hole is exactly one water component.
  const landSeen = new Uint8Array(n);
  const hole: number[] = [];
  /** The four edge-sharing neighbours of texel `i`, `-1` off the map. */
  const near = [0, 0, 0, 0];
  const neighbours = (i: number, x: number, y: number): void => {
    near[0] = x > 0 ? i - 1 : -1;
    near[1] = x < res - 1 ? i + 1 : -1;
    near[2] = y > 0 ? i - res : -1;
    near[3] = y < res - 1 ? i + res : -1;
  };
  for (let seed = 0; seed < n; seed++) {
    if (landSeen[seed] === 1 || label[seed]! >= 0) continue;
    hole.length = 0;
    let border = false;
    landSeen[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop()!;
      hole.push(i);
      const x = i % res;
      const y = (i - x) / res;
      if (x === 0 || y === 0 || x === res - 1 || y === res - 1) border = true;
      neighbours(i, x, y);
      for (let k = 0; k < 4; k++) {
        const j = near[k]!;
        if (j < 0 || landSeen[j] === 1 || label[j]! >= 0) continue;
        landSeen[j] = 1;
        stack.push(j);
      }
    }
    if (border || hole.length >= MIN_HOLE_TEXELS) continue;
    // Whose hole is it? Any 4-neighbouring water texel's component — an
    // enclosed 4-connected land component has exactly one round it.
    let owner = -1;
    for (let k = 0; k < hole.length && owner < 0; k++) {
      const i = hole[k]!;
      const x = i % res;
      const y = (i - x) / res;
      neighbours(i, x, y);
      for (let m = 0; m < 4; m++) {
        const j = near[m]!;
        if (j >= 0 && label[j]! >= 0) {
          owner = label[j]!;
          break;
        }
      }
    }
    if (owner < 0) continue;
    for (let k = 0; k < hole.length; k++) {
      const i = hole[k]!;
      label[i] = owner;
      W[i] = minLevel[owner]!;
      count[owner]!++;
    }
  }

  // ── 4. one plane a body ───────────────────────────────────────────────────
  // Where two strokes at different levels ran together, the LOWER wins [D]:
  // water finds the lower basin, and it is the only choice that cannot flood
  // a bank the higher stroke was painted against.
  for (let i = 0; i < n; i++) {
    const id = label[i]!;
    if (id >= 0) W[i] = minLevel[id]!;
  }

  // Compact the ids. The scan above labels in raster order, so the surviving
  // labels are already ordered by their first texel and this only closes the
  // gaps the cull left.
  const ident = new Int32Array(count.length).fill(-1);
  const bodyLevel: number[] = [];
  const bodySeed: number[] = [];
  const bodyTexels: number[] = [];
  for (let id = 0; id < count.length; id++) {
    if (count[id]! < MIN_BODY_TEXELS) continue;
    ident[id] = bodyLevel.length;
    bodyLevel.push(minLevel[id]!);
    bodySeed.push(first[id]!);
    bodyTexels.push(count[id]!);
  }
  const bodyCount = bodyLevel.length;

  // ── 5. the signed distance field ──────────────────────────────────────────
  const water = new Uint8Array(n);
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i]! >= 0) water[i] = 1;
    else land[i] = 1;
  }
  const toWater = distanceTransform(res, water);
  const toLand = distanceTransform(res, land);
  const nearest = toWater.nearest;
  const D = new Float32Array(n);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      if (water[i] === 1) {
        // Outside the map counts as land: a sheet painted right up to the rim
        // has a shore there, and without this its distance would run off to
        // the far side of the map instead.
        let d = toLand.dist[i]!;
        const bx = Math.min((x + 1) * (x + 1), (res - x) * (res - x));
        const by = Math.min((y + 1) * (y + 1), (res - y) * (res - y));
        if (bx < d) d = bx;
        if (by < d) d = by;
        D[i] = (Math.sqrt(d) - 0.5) * texel;
      } else {
        D[i] = -(Math.sqrt(toWater.dist[i]!) - 0.5) * texel;
      }
    }
  }

  // ── the samplers ──────────────────────────────────────────────────────────
  const half = size / 2;

  /** Signed distance to the nearest shore, bilinear between texel centres —
   * the same sampling `sampleHeight` does, with one difference: a texel off
   * the edge of the array reads `-0.5 * texel` (land, half a texel out)
   * rather than 0, so the field stays a distance right up to the rim. */
  const shore = (x: number, z: number): number => {
    const u = x / size + 0.5;
    const v = z / size + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return -PAINTED_SHORE_FAR;
    const fx = u * res - 0.5;
    const fy = v * res - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const az = fy - y0;
    const at = (tex: number, tey: number): number => {
      if (tex < 0 || tex >= res || tey < 0 || tey >= res) return -0.5 * texel;
      return D[tey * res + tex]!;
    };
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * ax;
    const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * ax;
    return top + (bot - top) * az;
  };

  /** The level of the body whose shore `shore` just measured: the nearest
   * texel's nearest WATER texel, read out of the level layer. Nearest and not
   * bilinear on purpose — a body's surface is one plane, and interpolating
   * between two bodies at different levels would invent a third. */
  const level = (x: number, z: number): number => {
    const u = x / size + 0.5;
    const v = z / size + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const tex = Math.min(res - 1, Math.max(0, Math.round(u * res - 0.5)));
    const tey = Math.min(res - 1, Math.max(0, Math.round(v * res - 0.5)));
    const src = nearest[tey * res + tex]!;
    return src < 0 ? 0 : W[src]!;
  };

  // ── the outlines: marching squares on D's zero contour ────────────────────
  // A PADDED grid of corner samples, (res + 2) a side, whose border ring is
  // land half a texel out: every loop then closes inside the grid, so the
  // tracer never has to invent a segment along the map's edge.
  const pad = res + 2;
  const cornerD = (i: number, j: number): number => {
    if (i === 0 || j === 0 || i === pad - 1 || j === pad - 1) return -0.5 * texel;
    return D[(j - 1) * res + (i - 1)]!;
  };
  /** World position of a corner: the centre of the texel it samples (border
   * corners land one texel outside the map, which is where they belong). */
  const cornerX = (i: number): number => (i - 0.5) * texel - half;
  const cornerZ = (j: number): number => (j - 0.5) * texel - half;

  interface Segment {
    /** Edge the next segment of the loop starts on. */
    to: number;
    x: number;
    z: number;
    cell: number;
    used: boolean;
  }
  const segments: Segment[] = [];
  const startsOn = new Map<number, number>();
  // The four corners of a cell, walked TL → TR → BR → BL → TL. With water on
  // the left of that walk an outer ring comes out counter-clockwise, which is
  // the landscape's convention for both a shore and an island.
  const co = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const;
  const cd = [0, 0, 0, 0];
  const kind = [0, 0, 0, 0];
  const edge = [0, 0, 0, 0];
  const px = [0, 0, 0, 0];
  const pz = [0, 0, 0, 0];
  for (let j = 0; j < pad - 1; j++) {
    for (let i = 0; i < pad - 1; i++) {
      let crossings = 0;
      for (let k = 0; k < 4; k++) cd[k] = cornerD(i + co[k]![0], j + co[k]![1]);
      for (let k = 0; k < 4; k++) {
        const a = cd[k]!;
        const b = cd[(k + 1) & 3]!;
        const aWet = a > 0;
        const bWet = b > 0;
        if (aWet === bWet) {
          kind[k] = 0;
          continue;
        }
        // Exit (water → land) or entry (land → water).
        kind[k] = aWet ? 1 : 2;
        crossings++;
        // The edge's own id, so the two cells sharing it agree exactly: the
        // horizontal edge leaving corner (i, j) is `2 * (j * pad + i)`, the
        // vertical one leaving it is that plus 1.
        const ci = i + co[k]![0];
        const cj = j + co[k]![1];
        const cin = i + co[(k + 1) & 3]![0];
        const cjn = j + co[(k + 1) & 3]![1];
        const horizontal = cj === cjn;
        const ei = Math.min(ci, cin);
        const ej = Math.min(cj, cjn);
        edge[k] = 2 * (ej * pad + ei) + (horizontal ? 0 : 1);
        const t = a / (a - b);
        const ax = cornerX(ci);
        const az = cornerZ(cj);
        px[k] = ax + (cornerX(cin) - ax) * t;
        pz[k] = az + (cornerZ(cjn) - az) * t;
      }
      if (crossings === 0) continue;
      for (let k = 0; k < 4; k++) {
        if (kind[k] !== 1) continue;
        // The next crossing round the cycle after an exit is always an entry
        // (the corner signs alternate with them), including in the two saddle
        // cases — where this pairing is what keeps the two water corners
        // joined, matching the 8-connected labelling.
        let m = -1;
        for (let s = 1; s <= 3; s++) {
          const c = (k + s) & 3;
          if (kind[c] !== 0) {
            m = c;
            break;
          }
        }
        if (m < 0) continue;
        // One segment starts on each crossed edge and one ends on it (the two
        // cells sharing an edge traverse it in opposite directions), so this
        // key never collides and the links form closed loops.
        startsOn.set(edge[k]!, segments.length);
        segments.push({
          to: edge[m]!,
          x: px[k]!,
          z: pz[k]!,
          cell: j * pad + i,
          used: false,
        });
      }
    }
  }

  // Link the segments into loops by EDGE ID — integers, not rounded floats, so
  // two cells that met at one crossing meet at exactly one key.
  const outlines: [number, number][][] = Array.from({ length: bodyCount }, () => []);
  const holes: [number, number][][][] = Array.from({ length: bodyCount }, () => []);
  for (let s = 0; s < segments.length; s++) {
    if (segments[s]!.used) continue;
    const ring: [number, number][] = [];
    let cur = s;
    let owner = -1;
    for (;;) {
      const seg = segments[cur]!;
      if (seg.used) throw new Error('painted water: a shore loop crossed itself');
      seg.used = true;
      ring.push([seg.x, seg.z]);
      if (owner < 0) {
        // Which body is this? Any water corner of the loop's first cell — an
        // 8-connected component owns every corner of every cell its contour
        // passes through.
        const ci = seg.cell % pad;
        const cj = (seg.cell - ci) / pad;
        for (let k = 0; k < 4 && owner < 0; k++) {
          const x = ci + co[k]![0];
          const y = cj + co[k]![1];
          if (x < 1 || y < 1 || x > res || y > res) continue;
          const li = label[(y - 1) * res + (x - 1)]!;
          if (li >= 0) owner = ident[li]!;
        }
      }
      const next = startsOn.get(seg.to);
      if (next === undefined) {
        throw new Error('painted water: a shore loop did not close');
      }
      if (next === s) break;
      cur = next;
    }
    if (owner < 0) throw new Error('painted water: a shore loop belongs to no body');
    const area = signedArea(ring);
    // Water on the left of the walk: an outer shore comes out counter-
    // clockwise (positive), an island clockwise. Both are stored CCW, so
    // `(dz, −dx)` points onto land for a shore and into the water for an
    // island, exactly as `walkShore` expects of `islandOutline`.
    if (area >= 0) outlines[owner] = chaikin(ring);
    else holes[owner]!.push(chaikin(ring.slice().reverse()));
  }

  const bodies: PaintedBody[] = [];
  for (let id = 0; id < bodyCount; id++) {
    const outline = outlines[id]!;
    let x0 = INF;
    let z0 = INF;
    let x1 = -INF;
    let z1 = -INF;
    for (let k = 0; k < outline.length; k++) {
      const p = outline[k]!;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1];
      if (p[1] > z1) z1 = p[1];
    }
    bodies.push({
      id,
      level: bodyLevel[id]!,
      seed: bodySeed[id]!,
      outline,
      holes: holes[id]!,
      bounds: { x0, z0, x1, z1 },
      texels: bodyTexels[id]!,
    });
  }

  return { shore, level, bodies };
}
