/**
 * Hand-authored silhouette props (GENERATOR §motif library).
 *
 * Every prop is a StrokeList in the same [0,1] y-down canvas space the
 * drawings use, run ONCE through the shared analyze() + inflate() pipeline —
 * so props are made of exactly the same pillowy, organic stuff as the
 * creatures, never assembled from primitives (TASTE §2.5: the grid places,
 * it never forms).
 *
 * VARIANCE (user direction, 2026-08-17): every kind ships several authored
 * builds, matching the hand-drawn forest references — a grove is mostly one
 * crown build plus strays, not one tree stamped everywhere. Buildings join
 * as a kind (absorbing the old 'landmark' mushroom-house): cottage, tower,
 * gate, dome hut, mushroom-house — all hand-wobbled organic silhouettes
 * (bowed walls, sagging rooflines, leaning towers), never boxes.
 *
 * Deliberate seeded hand-wobble rides on every path: blob boundaries are
 * jittered rings, trunks and walls are jittered polylines. Deterministic
 * hash noise, never Math.random — the same world grows on every device.
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
  'building',
  'stump',
] as const;
export type InflatedPropKind = (typeof INFLATED_PROP_KINDS)[number];

/** Mask resolution for props — smaller than the character's 512. Small,
 * ground-hugging kinds drop to 128: at ~60px on screen the difference is
 * invisible and it keeps the ~20-variant build inside the init budget. */
export const PROP_MASK_SIZE = 160;
export const PROP_MASK_SIZE_SMALL = 128;

const SMALL_KINDS: ReadonlySet<InflatedPropKind> = new Set(['rock', 'bush', 'stump']);

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

/** A jittered polyline stroke — a trunk, wall, or roofline drawn by hand,
 * not ruled. The jitter keeps any straight run well under ~15% of the form. */
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

// ── the variant library ──────────────────────────────────────────────────────
// Authored by eye against the forest reference read: multiple deciduous
// crown builds (fat scribbly single lobe / twin-lobe / triple-cluster /
// tall narrow), multiple conifer builds (layered droopy / tall spire /
// short squat), lumpy rocks, low bush clusters, hand-wobbled buildings,
// and squat stump + roofed well. Heights are per-variant [D]: a spire
// out-tops a squat pine, a tower out-tops a dome hut.

interface PropVariantDef {
  /** Debug/name tag — never rendered. */
  name: string;
  strokes: StrokeList;
  /** World-unit height at instance scale 1. */
  height: number;
}

export const PROP_VARIANT_DEFS: Record<InflatedPropKind, PropVariantDef[]> = {
  tree: [
    {
      // One fat scribbly lobe — the commonest crown in the reference.
      name: 'fat-lobe',
      height: 4.4,
      strokes: [
        ...wobblyBlob(0.5, 0.32, 0.27, 111.1, { ry: 0.24, lump: 0.24, points: 16 }),
        ...wobblyBlob(0.34, 0.43, 0.12, 112.2, { lump: 0.22 }),
        wobblyPath([[0.5, 0.5], [0.49, 0.7], [0.505, 0.88]], 0.085, 113.3),
      ],
    },
    {
      // Twin-lobe crown: two masses leaning apart over one trunk.
      name: 'twin-lobe',
      height: 4.6,
      strokes: [
        ...wobblyBlob(0.39, 0.31, 0.17, 121.1, { lump: 0.2 }),
        ...wobblyBlob(0.63, 0.36, 0.15, 122.2, { lump: 0.22 }),
        ...wobblyBlob(0.51, 0.43, 0.13, 123.3, { lump: 0.18 }),
        wobblyPath([[0.5, 0.5], [0.51, 0.7], [0.495, 0.88]], 0.085, 124.4),
      ],
    },
    {
      // Triple-cluster crown — the original motif.
      name: 'triple-cluster',
      height: 4.8,
      strokes: [
        ...wobblyBlob(0.5, 0.3, 0.22, 11.1, { lump: 0.18 }),
        ...wobblyBlob(0.35, 0.4, 0.13, 12.2, { lump: 0.2 }),
        ...wobblyBlob(0.65, 0.41, 0.13, 13.3, { lump: 0.2 }),
        ...wobblyBlob(0.51, 0.46, 0.14, 14.4, { lump: 0.18 }),
        wobblyPath([[0.5, 0.52], [0.49, 0.7], [0.505, 0.88]], 0.085, 15.5),
      ],
    },
    {
      // Tall narrow crown: stacked slim lobes, poplar-ish.
      name: 'tall-narrow',
      height: 5.6,
      strokes: [
        ...wobblyBlob(0.5, 0.18, 0.11, 131.1, { ry: 0.13, lump: 0.2 }),
        ...wobblyBlob(0.52, 0.33, 0.13, 132.2, { ry: 0.15, lump: 0.2 }),
        ...wobblyBlob(0.48, 0.48, 0.12, 133.3, { ry: 0.14, lump: 0.2 }),
        wobblyPath([[0.5, 0.58], [0.505, 0.74], [0.495, 0.9]], 0.075, 134.4),
      ],
    },
  ],
  conifer: [
    {
      // Classic layered build — droopy irregular lobes, never a clean triangle.
      name: 'layered-droopy',
      height: 5.2,
      strokes: [
        ...wobblyBlob(0.51, 0.72, 0.2, 21.1, { ry: 0.13, lump: 0.2 }),
        ...wobblyBlob(0.48, 0.57, 0.165, 22.2, { ry: 0.12, lump: 0.22 }),
        ...wobblyBlob(0.52, 0.43, 0.13, 23.3, { ry: 0.11, lump: 0.22 }),
        ...wobblyBlob(0.49, 0.3, 0.1, 24.4, { ry: 0.1, lump: 0.24 }),
        ...wobblyBlob(0.505, 0.18, 0.06, 25.5, { ry: 0.075, lump: 0.26 }),
        wobblyPath([[0.5, 0.78], [0.5, 0.92]], 0.07, 26.6),
      ],
    },
    {
      // Tall skinny spire.
      name: 'spire',
      height: 6.4,
      strokes: [
        ...wobblyBlob(0.5, 0.78, 0.13, 221.1, { ry: 0.09, lump: 0.22 }),
        ...wobblyBlob(0.51, 0.66, 0.115, 222.2, { ry: 0.085, lump: 0.24 }),
        ...wobblyBlob(0.49, 0.54, 0.1, 223.3, { ry: 0.08, lump: 0.24 }),
        ...wobblyBlob(0.505, 0.42, 0.085, 224.4, { ry: 0.075, lump: 0.26 }),
        ...wobblyBlob(0.495, 0.3, 0.065, 225.5, { ry: 0.07, lump: 0.26 }),
        ...wobblyBlob(0.5, 0.19, 0.042, 226.6, { ry: 0.065, lump: 0.28 }),
        wobblyPath([[0.5, 0.84], [0.5, 0.94]], 0.06, 227.7),
      ],
    },
    {
      // Short squat pine.
      name: 'squat',
      height: 3.4,
      strokes: [
        ...wobblyBlob(0.5, 0.66, 0.24, 231.1, { ry: 0.14, lump: 0.2 }),
        ...wobblyBlob(0.51, 0.5, 0.185, 232.2, { ry: 0.13, lump: 0.22 }),
        ...wobblyBlob(0.49, 0.36, 0.125, 233.3, { ry: 0.12, lump: 0.24 }),
        wobblyPath([[0.5, 0.74], [0.5, 0.9]], 0.08, 234.4),
      ],
    },
  ],
  rock: [
    {
      // Boulder with a small companion lump — the original motif.
      name: 'boulder-pair',
      height: 1.3,
      strokes: [
        ...wobblyBlob(0.48, 0.6, 0.3, 31.1, { ry: 0.19, lump: 0.22, points: 12 }),
        ...wobblyBlob(0.68, 0.66, 0.13, 32.2, { ry: 0.1, lump: 0.24 }),
      ],
    },
    {
      // Single rounded dome rock.
      name: 'dome-rock',
      height: 1.5,
      strokes: [
        ...wobblyBlob(0.5, 0.58, 0.29, 331.1, { ry: 0.21, lump: 0.16, points: 13 }),
        ...wobblyBlob(0.38, 0.48, 0.1, 332.2, { ry: 0.08, lump: 0.22 }),
      ],
    },
    {
      // Trio of stones stepping down.
      name: 'stone-trio',
      height: 1.0,
      strokes: [
        ...wobblyBlob(0.35, 0.58, 0.16, 341.1, { ry: 0.13, lump: 0.22, points: 12 }),
        ...wobblyBlob(0.53, 0.62, 0.13, 342.2, { ry: 0.1, lump: 0.24 }),
        ...wobblyBlob(0.68, 0.66, 0.1, 343.3, { ry: 0.08, lump: 0.24 }),
      ],
    },
  ],
  bush: [
    {
      // Three-lobe row — the original motif.
      name: 'lobe-row',
      height: 1.5,
      strokes: [
        ...wobblyBlob(0.35, 0.62, 0.15, 41.1, { ry: 0.13, lump: 0.2 }),
        ...wobblyBlob(0.52, 0.56, 0.18, 42.2, { ry: 0.15, lump: 0.2 }),
        ...wobblyBlob(0.68, 0.63, 0.13, 43.3, { ry: 0.11, lump: 0.22 }),
      ],
    },
    {
      // One wide scribbly mound.
      name: 'mound',
      height: 1.3,
      strokes: [
        ...wobblyBlob(0.5, 0.6, 0.28, 441.1, { ry: 0.16, lump: 0.24, points: 15 }),
      ],
    },
    {
      // Big lobe with a small one leaning in.
      name: 'lean-pair',
      height: 1.4,
      strokes: [
        ...wobblyBlob(0.43, 0.58, 0.19, 451.1, { ry: 0.15, lump: 0.2 }),
        ...wobblyBlob(0.65, 0.64, 0.12, 452.2, { ry: 0.1, lump: 0.24 }),
      ],
    },
  ],
  building: [
    {
      // Cottage: bowed body, sagging gable, leaning chimney.
      name: 'cottage',
      height: 3.8,
      strokes: [
        ...wobblyBlob(0.5, 0.66, 0.27, 511.1, { ry: 0.17, lump: 0.08, points: 16 }),
        wobblyPath(
          [[0.24, 0.53], [0.38, 0.43], [0.5, 0.395], [0.62, 0.43], [0.76, 0.53]],
          0.13,
          512.2,
          0.006,
        ),
        wobblyPath([[0.64, 0.3], [0.648, 0.44]], 0.075, 513.3, 0.005),
      ],
    },
    {
      // Round tower: bowed shaft, overhanging cap, top knob. Leans a touch.
      name: 'tower',
      height: 5.8,
      strokes: [
        wobblyPath([[0.52, 0.3], [0.5, 0.5], [0.515, 0.7], [0.505, 0.88]], 0.2, 521.1, 0.006),
        ...wobblyBlob(0.52, 0.24, 0.2, 522.2, { ry: 0.115, lump: 0.12 }),
        ...wobblyBlob(0.525, 0.15, 0.055, 523.3, { lump: 0.2 }),
      ],
    },
    {
      // Gatehouse: two stout legs, a sagging lintel mass, small top lobe.
      // The gap between the legs is the arch — carved by absence.
      name: 'gate',
      height: 4.4,
      strokes: [
        wobblyPath([[0.34, 0.52], [0.33, 0.7], [0.345, 0.9]], 0.15, 531.1, 0.005),
        wobblyPath([[0.66, 0.52], [0.67, 0.7], [0.655, 0.9]], 0.15, 532.2, 0.005),
        ...wobblyBlob(0.5, 0.44, 0.3, 533.3, { ry: 0.13, lump: 0.1, points: 16 }),
        ...wobblyBlob(0.5, 0.33, 0.12, 534.4, { ry: 0.08, lump: 0.16 }),
      ],
    },
    {
      // Dome hut: one soft dome, top knob, doorway notch cut by ground lobes.
      name: 'dome-hut',
      height: 2.8,
      strokes: [
        ...wobblyBlob(0.5, 0.52, 0.28, 541.1, { ry: 0.2, lump: 0.1, points: 16 }),
        ...wobblyBlob(0.5, 0.3, 0.055, 542.2, { lump: 0.2 }),
        wobblyPath([[0.37, 0.72], [0.37, 0.9]], 0.09, 543.3, 0.005),
        wobblyPath([[0.63, 0.72], [0.63, 0.9]], 0.09, 544.4, 0.005),
      ],
    },
    {
      // Mushroom-house — the original landmark.
      name: 'mushroom-house',
      height: 5.4,
      strokes: [
        ...wobblyBlob(0.5, 0.3, 0.3, 51.1, { ry: 0.22, lump: 0.14 }),
        wobblyPath([[0.5, 0.42], [0.5, 0.62], [0.5, 0.76]], 0.3, 52.2, 0.006),
        wobblyPath([[0.41, 0.78], [0.41, 0.9]], 0.1, 53.3, 0.005),
        wobblyPath([[0.59, 0.78], [0.59, 0.9]], 0.1, 54.4, 0.005),
      ],
    },
  ],
  stump: [
    {
      // Squat cut stump — the original motif.
      name: 'stump',
      height: 1.0,
      strokes: [
        ...wobblyBlob(0.5, 0.55, 0.2, 61.1, { ry: 0.12, lump: 0.18 }),
        ...wobblyBlob(0.5, 0.68, 0.22, 62.2, { ry: 0.13, lump: 0.2 }),
      ],
    },
    {
      // Roofed well: low round body, two posts, a capping roof lobe.
      name: 'well',
      height: 2.2,
      strokes: [
        ...wobblyBlob(0.5, 0.72, 0.21, 661.1, { ry: 0.12, lump: 0.14 }),
        wobblyPath([[0.38, 0.42], [0.375, 0.58], [0.38, 0.74]], 0.06, 662.2, 0.004),
        wobblyPath([[0.62, 0.42], [0.625, 0.58], [0.62, 0.74]], 0.06, 663.3, 0.004),
        ...wobblyBlob(0.5, 0.36, 0.2, 664.4, { ry: 0.09, lump: 0.16 }),
      ],
    },
  ],
};

/** Variant count per kind — for scatter's pure placement math (no geometry). */
export const PROP_VARIANT_COUNTS: Record<InflatedPropKind, number> = Object.fromEntries(
  INFLATED_PROP_KINDS.map((kind) => [kind, PROP_VARIANT_DEFS[kind].length]),
) as Record<InflatedPropKind, number>;

// ── geometry build ───────────────────────────────────────────────────────────

export interface PropVariant {
  geometry: BufferGeometry;
  /** World-unit height at instance scale 1 (min.y is baked to 0). */
  height: number;
  /** Footprint radius in world units at scale 1, for shadows + exclusions. */
  radius: number;
}

/**
 * Inflate each variant once. Geometry is scaled to its variant height,
 * grounded (min.y = 0) and centered in x/z, so instances only need
 * translate + y-rotation + uniform scale.
 */
export function buildPropGeometries(): Map<InflatedPropKind, PropVariant[]> {
  const out = new Map<InflatedPropKind, PropVariant[]>();
  for (const kind of INFLATED_PROP_KINDS) {
    const size = SMALL_KINDS.has(kind) ? PROP_MASK_SIZE_SMALL : PROP_MASK_SIZE;
    const variants: PropVariant[] = [];
    for (const def of PROP_VARIANT_DEFS[kind]) {
      const analysis = analyze(def.strokes, { size, contourPoints: 96 });
      if (!analysis) throw new Error(`prop '${kind}/${def.name}' produced no usable ink`);
      // Coarse interior refinement: props render at ~100px, so gridStep 10
      // is invisible on screen and keeps ~20 builds inside the init budget.
      const geometry = toBufferGeometry(inflate(analysis, { gridStep: 10 }));
      const box = geometry.boundingBox;
      if (!box || box.isEmpty()) throw new Error(`prop '${kind}/${def.name}' inflated to nothing`);
      const rawHeight = Math.max(box.max.y - box.min.y, 1e-6);
      const s = def.height / rawHeight;
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
      variants.push({ geometry, height: def.height, radius });
    }
    out.set(kind, variants);
  }
  return out;
}
