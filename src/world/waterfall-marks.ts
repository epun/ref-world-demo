/**
 * The waterfall mark — an ink drawing of water going over a riser
 * (2026-09-10, user ask: *"i want to match the brushes for env paint
 * exactly"*; EnvPaint's tool `5`).
 *
 * EnvPaint answers a waterfall with a lit sheet, streaks, mist and a
 * particle emitter. None of that is available here: TASTE §6 has six
 * near-achromatic greys, §2.4 allows one flat hard value, and §1 keeps
 * near-black for characters. So a waterfall in this world is what every
 * other environment texture already is — a MARK: vertical hatched lines
 * falling from the lip to the foot, with splash ticks under them, in the
 * same ink material and through the same instanced mark path as the grass
 * ticks and reeds (src/world/scatter.ts). It is drawn, not simulated.
 *
 * PURE apart from `three`'s geometry containers: every wobble comes from
 * `fallHash`, never from `Math.random`, so the same seed draws the same fall
 * on every device — which is what lets a handset rebuild an operator's
 * painted waterfall from four numbers in the session log.
 *
 * WHERE THE MARKS LIVE: on the painted map (`PaintedMap.marks`), because the
 * map is the one object a projection restores. This module is the registry
 * the world reads them through — the same shape as `setPaintedWater` in
 * landscape.ts, and for the same reason: the scatter must not have to be
 * handed a new argument by everyone who rebuilds it.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import type { PaintedMark } from './painted';
import type { Surface } from './surface';

/** [D] Authored variants. Two: one broad fall and one narrow chute. Enough
 * that a pair of falls side by side are not the same drawing, few enough
 * that each is a considered mark rather than a parameter sweep. */
export const WATERFALL_VARIANTS = 2;

/**
 * [D] How far downstream of the lip the foot is looked for, world units.
 *
 * The mark spans the surface at the lip to the surface at the foot, and the
 * foot is simply "one brush-ish run down the gradient" — a riser in this
 * world is a terrace step, and 4 u clears one comfortably.
 */
export const FALL_RUN = 4;

/** [D] Shortest and tallest a fall may draw, world units. A drop under the
 * minimum is a ripple and would render as a smear; the maximum keeps a mark
 * stamped on a cliff face from becoming the tallest thing on the field. */
export const FALL_MIN_DROP = 0.9;
export const FALL_MAX_DROP = 20;

/** Deterministic hash → [-1,1). Same recipe family as scatter's `markHash`
 * and props' `shash` — one arithmetic family across the whole world. */
function fallHash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * The seed a stamp with no brush seed behind it gets: the place itself.
 *
 * Quantised to a tenth of a unit so a dab and its replay — which travel
 * through a uv round trip — cannot land on two different seeds.
 */
export function waterfallSeed(x: number, z: number): number {
  return Math.abs(Math.round(x * 10) * 31 + Math.round(z * 10) * 17) % 9973;
}

/**
 * Which way the water falls at (x, z): the y rotation whose local +x points
 * DOWN the local gradient.
 *
 * Read off the Surface's up-normal, never off a height derived here (PLAN
 * §7.2): for a height field the normal's horizontal part already points
 * downhill, so this is one sample and no differencing of our own. On ground
 * flat enough to have no gradient at all the fall faces +z, which is the
 * camera's own downhill on this map.
 */
export function waterfallYaw(surface: Surface, x: number, z: number): number {
  const n = surface.normalAt(x, z);
  const len = Math.hypot(n.x, n.z);
  if (len < 1e-4) return Math.atan2(-1, 0);
  return Math.atan2(-n.z / len, n.x / len);
}

/** The drop a mark spans: the surface at its lip, less the surface one
 * `FALL_RUN` down its own facing, clamped to the drawable range. */
export function waterfallDrop(surface: Surface, mark: PaintedMark): number {
  const dirX = Math.cos(mark.yaw);
  const dirZ = -Math.sin(mark.yaw);
  const lip = surface.sampleHeight(mark.x, mark.z);
  const foot = surface.sampleHeight(mark.x + dirX * FALL_RUN, mark.z + dirZ * FALL_RUN);
  const drop = lip - foot;
  return Math.min(FALL_MAX_DROP, Math.max(FALL_MIN_DROP, drop));
}

/** The variant a seed draws. */
export function waterfallVariant(seed: number): number {
  return Math.abs(Math.round(seed)) % WATERFALL_VARIANTS;
}

// ── the registry ─────────────────────────────────────────────────────────────

let placed: readonly PaintedMark[] = [];

/**
 * Hand the world the painted marks, or none. Same seam as landscape.ts's
 * `setPaintedWater`: the brush calls it after every change and the scatter
 * reads it on its next rebuild, so nobody in between carries the list.
 */
export function setWaterfallMarks(marks: readonly PaintedMark[] | null): void {
  placed = marks ?? [];
}

/** The marks the world is holding. */
export function waterfallMarks(): readonly PaintedMark[] {
  return placed;
}

/** The index of the mark nearest (x, z) within `r`, or -1. What the eraser
 * removes — a mark has no area, so the brush deletes the nearest one under
 * it rather than every one it covers. */
export function nearestWaterfall(
  marks: readonly PaintedMark[],
  x: number,
  z: number,
  r: number,
): number {
  let best = -1;
  let bestD = r * r;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const dx = m.x - x;
    const dz = m.z - z;
    const d = dx * dx + dz * dz;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * The placements the instanced mark path draws, one per mark.
 *
 * `scale` is the DROP: the geometry is authored one unit tall, hanging from
 * its origin, so a uniform scale of the drop puts the lip on the ground the
 * mark was stamped on and the foot on the ground below it. Heights come from
 * the Surface and nowhere else.
 */
export function waterfallPlacements(surface: Surface): {
  kind: 'waterfall';
  variant: number;
  x: number;
  z: number;
  scale: number;
  rotY: number;
}[] {
  return placed.map((m) => ({
    kind: 'waterfall' as const,
    variant: waterfallVariant(m.seed),
    x: m.x,
    z: m.z,
    scale: waterfallDrop(surface, m),
    rotY: m.yaw,
  }));
}

// ── the drawing ──────────────────────────────────────────────────────────────

/**
 * One tapered ink ribbon along a spine, its width laid along (wx, wz).
 *
 * Local to this module rather than shared with scatter.ts's own `ribbon`:
 * that one lays its width in a ground direction taken from the blade's
 * plane, and a falling line needs its width chosen per stroke so the curtain
 * never reads edge-on from the iso camera.
 */
function ribbon(
  positions: number[],
  spine: readonly [number, number, number][],
  wx: number,
  wz: number,
  w: number,
  tipW = 0.6,
): void {
  for (let i = 0; i < spine.length - 1; i++) {
    const t0 = i / (spine.length - 1);
    const t1 = (i + 1) / (spine.length - 1);
    const w0 = w * (1 - (1 - tipW) * t0);
    const w1 = w * (1 - (1 - tipW) * t1);
    const [ax, ay, az] = spine[i]!;
    const [bx, by, bz] = spine[i + 1]!;
    positions.push(
      ax - wx * w0, ay, az - wz * w0,
      ax + wx * w0, ay, az + wz * w0,
      bx + wx * w1, by, bz + wz * w1,
      ax - wx * w0, ay, az - wz * w0,
      bx + wx * w1, by, bz + wz * w1,
      bx - wx * w1, by, bz - wz * w1,
    );
  }
}

/**
 * [D] One authored fall, one unit tall: the lip at the origin, the foot at
 * y = -1, the water falling toward local +x.
 *
 * The hatching is the drawing. Each falling line leaves the lip vertical and
 * drifts forward as it falls (t² — water leaves an edge, it does not lean off
 * it), and every line's WIDTH direction alternates between across the fall
 * and along it, so the curtain keeps a silhouette from any camera yaw rather
 * than vanishing edge-on the way one flat plane would. A lip stroke closes
 * the top and three splash ticks kick up off the foot. No fill anywhere:
 * TASTE §7a's flowers settled this for the whole environment kit — an ink
 * mark is lines, and shading is density of mark.
 */
function buildWaterfall(variant: number): BufferGeometry {
  const positions: number[] = [];
  // Broad fall, then narrow chute. Nothing here is rectilinear: every line
  // is wobbled off its nominal place by the hash (TASTE §2.5).
  const lines = variant === 0 ? 7 : 4;
  const halfWidth = variant === 0 ? 0.16 : 0.075;
  const arc = variant === 0 ? 0.11 : 0.16;
  const seed = variant * 91.3 + 13.7;

  for (let i = 0; i < lines; i++) {
    const f = i / (lines - 1);
    const across = (f - 0.5) * 2 * halfWidth + fallHash(seed + i * 3.1) * halfWidth * 0.18;
    // A line may start a little under the lip and stop a little short of the
    // foot — a curtain is not a comb.
    const top = -Math.abs(fallHash(seed + i * 5.7)) * 0.08;
    const bottom = -1 + Math.abs(fallHash(seed + i * 7.3)) * 0.06;
    const segs = 5;
    const spine: [number, number, number][] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const y = top + (bottom - top) * t;
      const fallen = -y;
      const x = arc * fallen * fallen + fallHash(seed + i * 11.9 + s * 2.3) * 0.012;
      spine.push([x, y, across + fallHash(seed + i * 17.1 + s * 1.7) * 0.008]);
    }
    // Alternating width axis — see the header.
    const alongZ = i % 2 === 0;
    ribbon(positions, spine, alongZ ? 0 : 1, alongZ ? 1 : 0, 0.014, 0.55);
  }

  // The lip: one stroke across the top, the edge the water leaves.
  ribbon(
    positions,
    [
      [0, fallHash(seed + 2.2) * 0.01, -halfWidth * 1.1],
      [0.012, 0, 0],
      [0, fallHash(seed + 4.4) * 0.01, halfWidth * 1.1],
    ],
    1,
    0,
    0.013,
    1,
  );

  // Splash ticks at the foot: short marks kicking back up and outward.
  const splashes = variant === 0 ? 3 : 2;
  for (let i = 0; i < splashes; i++) {
    const s = seed + 31.7 + i * 6.1;
    const side = fallHash(s) * halfWidth * 1.6;
    const reach = 0.09 + Math.abs(fallHash(s + 1.3)) * 0.09;
    const rise = 0.07 + Math.abs(fallHash(s + 2.6)) * 0.08;
    const baseX = arc + 0.02 + Math.abs(fallHash(s + 3.9)) * 0.05;
    ribbon(
      positions,
      [
        [baseX, -1, side],
        [baseX + reach * 0.55, -1 + rise, side + fallHash(s + 5.2) * 0.03],
        [baseX + reach, -1 + rise * 0.55, side + fallHash(s + 6.5) * 0.05],
      ],
      i % 2 === 0 ? 0 : 1,
      i % 2 === 0 ? 1 : 0,
      0.012,
      0.4,
    );
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Every authored fall, in variant order — the scatter's mark table reads
 * this exactly as it reads the grass and flower alphabets. */
export function buildWaterfallGeometries(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let v = 0; v < WATERFALL_VARIANTS; v++) out.push(buildWaterfall(v));
  return out;
}
