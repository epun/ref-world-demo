/**
 * Hand-authored silhouette props (GENERATOR §motif library).
 *
 * Every prop is a StrokeList in the same [0,1] y-down canvas space the
 * drawings use, run ONCE through the shared analyze() + inflate() pipeline —
 * so props are made of exactly the same pillowy, organic stuff as the
 * creatures, never assembled from primitives (TASTE §2.5: the grid places,
 * it never forms).
 *
 * Deliberate seeded hand-wobble rides on every path: blob boundaries are
 * jittered rings, trunks are jittered polylines. Deterministic hash noise,
 * never Math.random — the same world grows on every device.
 *
 * Render intent (GENERATOR §ink rendering pass): these forms carry a LIGHT
 * paper albedo. Their presence in the frame is drawn by the ink pass —
 * wobbly contour lines and hatching — not by a grey mass.
 */

import type { BufferGeometry } from 'three';
import { toBufferGeometry } from '../character/mesh';
import { inflate } from '../inflate/inflate';
import { analyze } from '../shape/analyze';
import type { Stroke, StrokeList } from '../shape/types';

/** Prop kinds that go through the inflate pipeline ('tick' does not). */
export const INFLATED_PROP_KINDS = [
  'tree',
  'conifer',
  'rock',
  'bush',
  'landmark',
  'stump',
] as const;
export type InflatedPropKind = (typeof INFLATED_PROP_KINDS)[number];

/** Mask resolution for props — smaller than the character's 512: six masks
 * at 160 keep the one-time world init near the ~200ms budget. */
export const PROP_MASK_SIZE = 160;

/** [D] World-unit heights per kind. Trees and the landmark tower over the
 * ~3.5-unit character; rocks and stumps sit low. */
export const PROP_HEIGHTS: Record<InflatedPropKind, number> = {
  tree: 4.6,
  conifer: 5.2,
  rock: 1.3,
  bush: 1.5,
  landmark: 5.4,
  stump: 1.0,
};

// ── seeded hand-wobble ───────────────────────────────────────────────────────

/** Deterministic hash → [0,1). Same recipe family as motion/ambient. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** Signed hash → [-1,1). */
function shash(n: number): number {
  return hash(n) * 2 - 1;
}

/**
 * A lumpy filled blob: a closed ring polyline whose radius jitters per
 * point (the wobbly pen boundary), thick enough to fill outward, plus a
 * center stamp so the interior is solid. `ry` squashes it into an oval.
 */
function wobblyBlob(
  cx: number,
  cy: number,
  rx: number,
  seed: number,
  opts: { ry?: number; lump?: number; points?: number } = {},
): Stroke[] {
  const ry = opts.ry ?? rx;
  const lump = opts.lump ?? 0.16;
  const n = opts.points ?? 14;
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const a = (k / n) * Math.PI * 2;
    const j = 1 + lump * shash(seed + k * 7.31);
    pts.push([cx + Math.cos(a) * rx * 0.68 * j, cy + Math.sin(a) * ry * 0.68 * j, 1]);
  }
  const w = Math.min(rx, ry) * 0.9;
  return [
    { pts, w },
    { pts: [[cx, cy, 1]], w: Math.min(rx, ry) * 1.2 },
  ];
}

/** A jittered polyline stroke — a trunk or stem drawn by hand, not ruled. */
function wobblyPath(
  points: [number, number][],
  w: number,
  seed: number,
  amp = 0.008,
): Stroke {
  // Resample to ~10 points so the jitter has room to read as a pen line.
  const out: [number, number, number][] = [];
  const segs = 9;
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * (points.length - 1);
    const i0 = Math.min(Math.floor(t), points.length - 2);
    const f = t - i0;
    const [x0, y0] = points[i0]!;
    const [x1, y1] = points[i0 + 1]!;
    out.push([
      x0 + (x1 - x0) * f + shash(seed + i * 3.7) * amp,
      y0 + (y1 - y0) * f + shash(seed + i * 3.7 + 51.3) * amp,
      1,
    ]);
  }
  return { pts: out, w };
}

// ── the motif library ────────────────────────────────────────────────────────
// Authored by eye against the reference read: round scribbly tree crowns,
// irregular stacked conifer lobes (never a clean triangle), lumpy rocks, low
// bush clusters, one round-capped mushroom-house landmark with a doorway
// notch cut by two ground lobes, and a squat stump.

export const PROP_STROKES: Record<InflatedPropKind, StrokeList> = {
  tree: [
    ...wobblyBlob(0.5, 0.3, 0.22, 11.1, { lump: 0.18 }),
    ...wobblyBlob(0.35, 0.4, 0.13, 12.2, { lump: 0.2 }),
    ...wobblyBlob(0.65, 0.41, 0.13, 13.3, { lump: 0.2 }),
    ...wobblyBlob(0.51, 0.46, 0.14, 14.4, { lump: 0.18 }),
    wobblyPath([[0.5, 0.52], [0.49, 0.7], [0.505, 0.88]], 0.085, 15.5),
  ],
  conifer: [
    ...wobblyBlob(0.51, 0.72, 0.2, 21.1, { ry: 0.13, lump: 0.2 }),
    ...wobblyBlob(0.48, 0.57, 0.165, 22.2, { ry: 0.12, lump: 0.22 }),
    ...wobblyBlob(0.52, 0.43, 0.13, 23.3, { ry: 0.11, lump: 0.22 }),
    ...wobblyBlob(0.49, 0.3, 0.1, 24.4, { ry: 0.1, lump: 0.24 }),
    ...wobblyBlob(0.505, 0.18, 0.06, 25.5, { ry: 0.075, lump: 0.26 }),
    wobblyPath([[0.5, 0.78], [0.5, 0.92]], 0.07, 26.6),
  ],
  rock: [
    ...wobblyBlob(0.48, 0.6, 0.3, 31.1, { ry: 0.19, lump: 0.22, points: 12 }),
    ...wobblyBlob(0.68, 0.66, 0.13, 32.2, { ry: 0.1, lump: 0.24 }),
  ],
  bush: [
    ...wobblyBlob(0.35, 0.62, 0.15, 41.1, { ry: 0.13, lump: 0.2 }),
    ...wobblyBlob(0.52, 0.56, 0.18, 42.2, { ry: 0.15, lump: 0.2 }),
    ...wobblyBlob(0.68, 0.63, 0.13, 43.3, { ry: 0.11, lump: 0.22 }),
  ],
  landmark: [
    // Round cap dome.
    ...wobblyBlob(0.5, 0.3, 0.3, 51.1, { ry: 0.22, lump: 0.14 }),
    // Body under the cap.
    wobblyPath([[0.5, 0.42], [0.5, 0.62], [0.5, 0.76]], 0.3, 52.2, 0.006),
    // Two ground lobes; the gap between them is the doorway notch in the
    // silhouette (strokes are additive, so the notch is carved by absence).
    wobblyPath([[0.41, 0.78], [0.41, 0.9]], 0.1, 53.3, 0.005),
    wobblyPath([[0.59, 0.78], [0.59, 0.9]], 0.1, 54.4, 0.005),
  ],
  stump: [
    ...wobblyBlob(0.5, 0.55, 0.2, 61.1, { ry: 0.12, lump: 0.18 }),
    ...wobblyBlob(0.5, 0.68, 0.22, 62.2, { ry: 0.13, lump: 0.2 }),
  ],
};

// ── geometry build ───────────────────────────────────────────────────────────

export interface PropGeometry {
  geometry: BufferGeometry;
  /** World-unit height at instance scale 1 (min.y is baked to 0). */
  height: number;
  /** Footprint radius in world units at scale 1, for shadows + exclusions. */
  radius: number;
}

/**
 * Inflate each motif once. Geometry is scaled to its kind height, grounded
 * (min.y = 0) and centered in x/z, so instances only need translate +
 * y-rotation + uniform scale.
 */
export function buildPropGeometries(): Record<InflatedPropKind, PropGeometry> {
  const out = {} as Record<InflatedPropKind, PropGeometry>;
  for (const kind of INFLATED_PROP_KINDS) {
    const analysis = analyze(PROP_STROKES[kind], { size: PROP_MASK_SIZE, contourPoints: 96 });
    if (!analysis) throw new Error(`prop motif '${kind}' produced no usable ink`);
    // Coarse interior refinement: props render at ~100px, so gridStep 10
    // is invisible on screen and keeps the six builds inside the init budget.
    const geometry = toBufferGeometry(inflate(analysis, { gridStep: 10 }));
    const box = geometry.boundingBox;
    if (!box || box.isEmpty()) throw new Error(`prop motif '${kind}' inflated to nothing`);
    const rawHeight = Math.max(box.max.y - box.min.y, 1e-6);
    const s = PROP_HEIGHTS[kind] / rawHeight;
    // scale() routes through applyMatrix4, which recomputes the existing
    // boundingBox — so read the scaled box back before grounding/centering.
    geometry.scale(s, s, s);
    const scaled = geometry.boundingBox!;
    geometry.translate(
      -(scaled.min.x + scaled.max.x) / 2,
      -scaled.min.y,
      -(scaled.min.z + scaled.max.z) / 2,
    );
    geometry.computeBoundingBox();
    const b = geometry.boundingBox!;
    const radius = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
    out[kind] = { geometry, height: PROP_HEIGHTS[kind], radius };
  }
  return out;
}
