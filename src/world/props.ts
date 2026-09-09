/**
 * Hand-authored silhouette props (GENERATOR §motif library).
 *
 * TWO construction paths, one variant library:
 *
 * 1. ORGANIC (vegetation, stones): a StrokeList in the same [0,1] y-down
 *    canvas space the drawings use, run ONCE through the shared analyze()
 *    + inflate() pipeline — pillowy, lumpy, the same stuff as the
 *    creatures. Trees, conifers, rocks, bushes, stumps, cacti, monoliths.
 *
 * 2. ARCHITECTURAL (built things): extruded / lathed hand-wobbled profiles
 *    (user report: "the buildings don't look like buildings — they look
 *    like trees"; pillow inflation bowed walls into lobes and puffed roofs
 *    into crowns). Walls stay walls: distinct planes, readable rooflines.
 *    Every profile is seeded-wobbled before construction — walls bow ±2–3%,
 *    corners are cut ~8% of the edge length, rooflines sag — and every
 *    vertex gets a slight continuous jitter after. TASTE §2.5 bans
 *    ENGINEERED hard edges; a wobbled corner reads drawn and passes.
 *    Buildings, palms (trunk + frond blades), picnic tables, water towers.
 *
 * VARIANCE (user direction, 2026-08-17): every kind ships several authored
 * builds, matching the hand-drawn references — a grove is mostly one crown
 * build plus strays, not one tree stamped everywhere.
 *
 * Deliberate seeded hand-wobble rides on every path. Deterministic hash
 * noise, never Math.random — the same world grows on every device.
 *
 * Render intent (GENERATOR §ink rendering pass): these forms carry a LIGHT
 * paper albedo (monoliths step down to the rock mid-band). Their presence
 * in the frame is drawn by the ink pass — wobbly contour lines and
 * hatching — not by a grey mass.
 */

import {
  BufferAttribute,
  BufferGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Shape,
  Vector2,
} from 'three';
import { toBufferGeometry } from '../character/mesh';
import { inflate } from '../inflate/inflate';
import { analyze } from '../shape/analyze';
import type { Stroke, StrokeList } from '../shape/types';

/** Prop kinds that go through the inflate pipeline. New kinds APPEND, so the
 * pre-existing ones keep their index (scatter's roll order and its hash salts
 * are keyed off names, but the pack order is what the outliner reads). */
export const INFLATED_PROP_KINDS = [
  'tree',
  'conifer',
  'rock',
  'bush',
  'stump',
  'cactus',
  'monolith',
  'mountain',
] as const;
export type InflatedPropKind = (typeof INFLATED_PROP_KINDS)[number];

/** Prop kinds built architecturally (extrude / lathe, never inflation). */
export const ARCH_PROP_KINDS = ['building', 'palm', 'picnicTable', 'waterTower'] as const;
export type ArchPropKind = (typeof ARCH_PROP_KINDS)[number];

/** Every prop kind, both construction paths. */
export const PROP_KINDS = [...INFLATED_PROP_KINDS, ...ARCH_PROP_KINDS] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/** Mask resolution for inflated props — smaller than the character's 512.
 * Small, ground-hugging kinds drop to 128: at ~60px on screen the
 * difference is invisible and it keeps the build inside the init budget.
 * Mountains step UP to 224: they are the only kind that fills a large part
 * of the frame, so their contour is the one the ink pass actually draws at
 * size. [D] */
export const PROP_MASK_SIZE = 160;
export const PROP_MASK_SIZE_SMALL = 128;
export const PROP_MASK_SIZE_LARGE = 224;

const SMALL_KINDS: ReadonlySet<InflatedPropKind> = new Set([
  'rock',
  'bush',
  'stump',
  'cactus',
  'monolith',
]);

const LARGE_KINDS: ReadonlySet<InflatedPropKind> = new Set(['mountain']);

/** Mask resolution for one inflated kind — the single rule both
 * buildPropGeometries and the tests read. */
export function propMaskSize(kind: InflatedPropKind): number {
  if (LARGE_KINDS.has(kind)) return PROP_MASK_SIZE_LARGE;
  return SMALL_KINDS.has(kind) ? PROP_MASK_SIZE_SMALL : PROP_MASK_SIZE;
}

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

/** A jittered polyline stroke — a trunk or column drawn by hand, not
 * ruled. The jitter keeps any straight run well under ~15% of the form. */
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

// ── architectural construction (extrude / lathe, hand-wobbled) ───────────────
// Profiles are authored in world units, y-up, at roughly their final size;
// the shared normalize step then scales exactly to the variant height. The
// wobble is applied to the PROFILE (so walls bow and rooflines sag as
// drawn lines do) and again as a slight continuous 3D jitter on the built
// vertices. The jitter field is continuous in position — the same position
// always displaces the same way — so shared edges never crack and planar
// walls tilt by at most a couple of degrees: walls remain walls.

export interface OutlineWobbleOpts {
  /** Corner cut as a fraction of the shorter adjacent edge (drawn corner). */
  corner?: number;
  /** Perpendicular bow amplitude as a fraction of each edge's length. */
  bow?: number;
  /** Absolute per-point jitter along the outline, world units. */
  jitter?: number;
  /** Subdivisions per (chamfered) edge. */
  segs?: number;
}

/** Chamfer every corner (~8% of the edge), then subdivide each edge and
 * bow it perpendicular by a seeded low-frequency amount (walls bow ±2–3%),
 * plus per-point jitter. Deterministic in (points, seed, opts). */
function wobbleOutline(
  points: readonly [number, number][],
  seed: number,
  opts: OutlineWobbleOpts = {},
): [number, number][] {
  const corner = opts.corner ?? 0.08;
  const bow = opts.bow ?? 0.025;
  const jitter = opts.jitter ?? 0.012;
  const segs = opts.segs ?? 4;
  const n = points.length;
  // Corner cut: replace each vertex with two points backed off along the
  // adjacent edges — the drawn, slightly-rounded corner.
  const cham: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = points[i]!;
    const [ax, ay] = points[(i - 1 + n) % n]!;
    const [bx, by] = points[(i + 1) % n]!;
    const la = Math.hypot(px - ax, py - ay);
    const lb = Math.hypot(bx - px, by - py);
    const c = corner * Math.min(la, lb);
    cham.push([px + ((ax - px) / la) * c, py + ((ay - py) / la) * c]);
    cham.push([px + ((bx - px) / lb) * c, py + ((by - py) / lb) * c]);
  }
  const m = cham.length;
  const out: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    const [x0, y0] = cham[i]!;
    const [x1, y1] = cham[(i + 1) % m]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    const bowAmp = len * bow * shash(seed + i * 13.7);
    const steps = len < jitter * 4 ? 1 : segs;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const d = bowAmp * Math.sin(Math.PI * t) + (k > 0 ? jitter * shash(seed + i * 7.9 + k * 3.1) : 0);
      out.push([x0 + (x1 - x0) * t + nx * d, y0 + (y1 - y0) * t + ny * d]);
    }
  }
  return out;
}

/** Slight non-uniform vertex jitter after construction — a continuous trig
 * field keyed on position (same position → same offset: no cracks), low
 * frequency so planar faces stay planar within a couple of degrees. */
function jitterVertices(geometry: BufferGeometry, seed: number, amp = 0.02): void {
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const dx = Math.sin(y * 1.9 + z * 1.3 + seed) * Math.cos(y * 0.7 + seed * 1.7);
    const dy = Math.sin(x * 1.6 + z * 0.9 + seed * 2.3);
    const dz = Math.sin(x * 1.1 + y * 1.7 + seed * 3.1);
    pos.setXYZ(i, x + dx * amp, y + dy * amp * 0.6, z + dz * amp);
  }
}

/** Map every vertex through fn — for sags, leans, and leg splays. */
function mapVertices(
  geometry: BufferGeometry,
  fn: (x: number, y: number, z: number) => [number, number, number],
): void {
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setXYZ(i, x, y, z);
  }
}

/**
 * Extrude a hand-wobbled 2D outline (x/y profile, closed, no repeated end
 * point) to `depth` along z, centered on z=0. Walls bow, corners round
 * ~8% of the edge, and a slight continuous vertex jitter rides on top —
 * drawn, not engineered. Deterministic in (profile, depth, seed, opts).
 */
export function extrudeWobbled(
  profile: readonly [number, number][],
  depth: number,
  seed: number,
  opts: OutlineWobbleOpts & { jitter3d?: number } = {},
): BufferGeometry {
  const outline = wobbleOutline(profile, seed, opts);
  const shape = new Shape();
  outline.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 2 });
  geometry.translate(0, 0, -depth / 2);
  jitterVertices(geometry, seed + 71.3, opts.jitter3d ?? 0.02);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Lathe a hand-wobbled radial profile ([radius, y] pairs, bottom → top).
 * The profile is resampled with a seeded low-frequency radial bow (the
 * drawn line's waver), lathed at `segments`, then jittered slightly per
 * vertex. Deterministic in (profile, segments, seed, opts).
 */
export function latheWobbled(
  profile: readonly [number, number][],
  segments: number,
  seed: number,
  opts: { bow?: number; segs?: number; jitter3d?: number } = {},
): BufferGeometry {
  const bow = opts.bow ?? 0.03;
  const segs = opts.segs ?? 3;
  const pts: Vector2[] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i]!;
    const [r1, y1] = profile[i + 1]!;
    const len = Math.hypot(r1 - r0, y1 - y0);
    for (let k = 0; k < segs; k++) {
      const t = k / segs;
      const r =
        r0 + (r1 - r0) * t + shash(seed + i * 9.7 + k * 3.3) * bow * len * Math.sin(Math.PI * t);
      pts.push(new Vector2(Math.max(r, 0.015), y0 + (y1 - y0) * t));
    }
  }
  const last = profile[profile.length - 1]!;
  pts.push(new Vector2(Math.max(last[0], 0.015), last[1]));
  const geometry = new LatheGeometry(pts, segments);
  jitterVertices(geometry, seed + 31.7, opts.jitter3d ?? 0.02);
  geometry.computeVertexNormals();
  return geometry;
}

/** Concatenate parts into one geometry (position + normal, non-indexed).
 * Parts keep their own normals: lathes stay smooth, extrusions stay flat. */
function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const expanded = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of expanded) total += g.getAttribute('position').count;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  let offset = 0;
  for (const g of expanded) {
    positions.set(g.getAttribute('position').array as Float32Array, offset);
    normals.set(g.getAttribute('normal').array as Float32Array, offset);
    offset += g.getAttribute('position').count * 3;
  }
  for (const g of parts) g.dispose();
  for (const g of expanded) g.dispose();
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(positions, 3));
  out.setAttribute('normal', new BufferAttribute(normals, 3));
  return out;
}

// ── the modular building kit ─────────────────────────────────────────────────
// Recreating the user's isometric building pack (upgraded brief): the bar is
// recognizable TYPOLOGY — castle keep, watchtower, gatehouse, walled
// courtyard, adobe flat-roof, pagoda, longhouse, cottage. Each family is
// COMPOSED from kit pieces (wall slabs, round towers, crenellation teeth,
// gable / pagoda / cone roofs, proud door + window insets, plinth slabs)
// and merged into one geometry. Silhouette + openings + teeth + roof shape
// carry the read at game scale; the ink pass draws their edges — no
// textures, no stone courses. Hand-wobble everywhere: nothing is
// engineered-straight, but every wall is still unmistakably a wall.

/** A wobbled wall/box slab: w wide (x) × h tall, extruded d deep (z),
 * grounded at y = 0, centered in x/z. */
function slabBox(
  w: number,
  h: number,
  d: number,
  seed: number,
  opts: OutlineWobbleOpts & { jitter3d?: number } = {},
): BufferGeometry {
  return extrudeWobbled(
    [
      [-w / 2, 0],
      [w / 2, 0],
      [w / 2, h],
      [-w / 2, h],
    ],
    d,
    seed,
    { bow: 0.02, corner: 0.06, jitter: 0.01, jitter3d: 0.016, ...opts },
  );
}

/** Thin base plinth — the pack's tile base, hand-wobbled underfoot. */
function plinthSlab(w: number, d: number, seed: number): BufferGeometry {
  return slabBox(w, 0.16, d, seed, { bow: 0.015, corner: 0.1, jitter3d: 0.012 });
}

/**
 * Crenellated wall strip along x — the pack's signature teeth. A solid
 * base 0→baseH topped with wobbled merlons (heights vary ±15%), extruded
 * to `thick` along z, grounded at y = 0. With a tall base it IS a castle
 * wall; with a sliver base it caps a box or tower platform.
 */
function teethStrip(
  length: number,
  baseH: number,
  thick: number,
  seed: number,
  opts: { toothH?: number; pitch?: number } = {},
): BufferGeometry {
  const toothH = opts.toothH ?? 0.42;
  const pitch = opts.pitch ?? 0.85;
  const n = Math.max(2, Math.round(length / pitch));
  const p = length / n;
  const tw = p * 0.55;
  const top: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const l = -length / 2 + i * p + (p - tw) / 2;
    const r = l + tw;
    const th = baseH + toothH * (1 + 0.15 * shash(seed + i * 7.7));
    top.push([l, baseH], [l, th], [r, th], [r, baseH]);
  }
  const outline: [number, number][] = [
    [-length / 2, 0],
    [length / 2, 0],
    [length / 2, baseH],
    ...top.reverse(),
    [-length / 2, baseH],
  ];
  return extrudeWobbled(outline, thick, seed, {
    bow: 0.018,
    corner: 0.08,
    jitter: 0.006,
    segs: 2,
    jitter3d: 0.012,
  });
}

/** A ring of standalone merlon teeth around a tower platform. */
function crenellationRing(
  r: number,
  y: number,
  teeth: number,
  seed: number,
  center: [number, number] = [0, 0],
): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2 + shash(seed + i * 5.3) * 0.05;
    const tooth = slabBox(0.34, 0.4 * (1 + 0.15 * shash(seed + i * 7.7)), 0.2, seed + i * 3.1, {
      segs: 2,
      jitter: 0.005,
      jitter3d: 0.008,
    });
    tooth.rotateY(-a + Math.PI / 2); // tangent to the ring
    tooth.translate(center[0] + Math.cos(a) * r, y, center[1] + Math.sin(a) * r);
    out.push(tooth);
  }
  return out;
}

/** Round tower shaft with a slight entasis and an overhanging machicolated
 * platform closed flat on top (teeth ring goes on separately). */
function towerRound(r: number, h: number, seed: number, overhang = 1.18): BufferGeometry {
  return latheWobbled(
    [
      [r, 0],
      [r * 0.88, h * 0.5],
      [r * 0.9, h * 0.78],
      [r * overhang, h * 0.86],
      [r * (overhang + 0.03), h],
      [0.02, h],
    ],
    12,
    seed,
    { bow: 0.03, jitter3d: 0.02 },
  );
}

/** Conical roof cap for towers. */
function coneCap(r: number, h: number, seed: number): BufferGeometry {
  return latheWobbled(
    [
      [r, 0],
      [r * 0.5, h * 0.5],
      [0.12, h * 0.92],
      [0.02, h],
    ],
    10,
    seed,
    { bow: 0.04, jitter3d: 0.016 },
  );
}

/** Pitched gable roof prism (extruded triangle) with a sagging ridge. */
function gableRoof(w: number, rise: number, d: number, seed: number, sag = 0.14): BufferGeometry {
  const roof = extrudeWobbled(
    [
      [-w / 2, 0],
      [w / 2, 0],
      [0, rise],
    ],
    d,
    seed,
    { bow: 0.02, corner: 0.07, jitter3d: 0.018 },
  );
  // The ridge sags in the middle of its run — a drawn roofline, not ruled.
  mapVertices(roof, (x, y, z) => {
    const t = Math.max(y, 0) / rise;
    const across = Math.max(1 - (z / (d / 2)) ** 2, 0);
    return [x, y - sag * t * across, z];
  });
  roof.computeVertexNormals();
  return roof;
}

/** Square-plan pagoda roof: a 4-segment lathe of a concave profile with
 * upturned eave tips, corners aligned to the box corners. */
function pagodaRoof(halfW: number, h: number, seed: number): BufferGeometry {
  const R = halfW * Math.SQRT2 * 1.24; // corner radius, with a wide overhang
  const roof = latheWobbled(
    [
      [R * 1.06, h * 0.22],
      [R * 0.98, h * 0.02],
      [R * 0.72, h * 0.3],
      [R * 0.45, h * 0.6],
      [R * 0.2, h * 0.85],
      [0.02, h],
    ],
    4,
    seed,
    { bow: 0.015, segs: 2, jitter3d: 0.014 },
  );
  roof.rotateY(Math.PI / 4);
  return roof;
}

/** A small extruded arched doorway stub — proud of its wall face by
 * ~0.12u; the ink pass draws its edge (recessed reads the same at scale). */
function buildDoorStub(seed: number, scale: number): BufferGeometry {
  const s = scale;
  return extrudeWobbled(
    [
      [-0.5 * s, 0],
      [0.5 * s, 0],
      [0.44 * s, 0.85 * s],
      [0, 1.2 * s],
      [-0.44 * s, 0.85 * s],
    ],
    0.8 * s,
    seed,
    { bow: 0.03, corner: 0.1 },
  );
}

/** Place a door stub against a wall face at z = `face`, proud by ~0.12. */
function doorAt(seed: number, scale: number, face: number): BufferGeometry {
  const door = buildDoorStub(seed, scale);
  door.translate(0, 0, face - (0.8 * scale) / 2 + 0.12);
  return door;
}

/** A small square window inset, proud of its wall by ~0.05. */
function windowSlab(seed: number): BufferGeometry {
  return slabBox(0.36, 0.46, 0.12, seed, { segs: 2, jitter: 0.006, jitter3d: 0.008 });
}

/** Windows at (x, y) spots on the z = `face` wall. */
function windowsAt(
  spots: readonly [number, number][],
  face: number,
  seed: number,
): BufferGeometry[] {
  return spots.map(([wx, wy], i) => {
    const win = windowSlab(seed + i * 6.1);
    win.translate(wx, wy - 0.23, face - 0.01);
    return win;
  });
}

// ── the building families (pack recreation) ──────────────────────────────────

/** 1. Crenellated keep: big box, four corner towers, teeth everywhere,
 * arched door, windows, plinth. The castle thumbnail of the pack. */
function buildKeep(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const half = 1.7;
  const boxH = 4.9;
  parts.push(plinthSlab(4.8, 4.8, seed + 0.1));
  parts.push(slabBox(3.4, boxH, 3.4, seed + 1.1));
  for (const side of [-1, 1]) {
    const front = teethStrip(3.5, 0.14, 0.3, seed + 2.2 + side);
    front.translate(0, boxH, side * 1.55);
    parts.push(front);
    const flank = teethStrip(3.5, 0.14, 0.3, seed + 4.4 + side);
    flank.rotateY(Math.PI / 2);
    flank.translate(side * 1.55, boxH, 0);
    parts.push(flank);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const tSeed = seed + sx * 4.1 + sz * 2.3;
      const tower = towerRound(0.6, 5.7, tSeed);
      tower.translate(sx * half, 0, sz * half);
      parts.push(tower);
      parts.push(...crenellationRing(0.62, 5.7, 6, tSeed + 1.7, [sx * half, sz * half]));
    }
  }
  parts.push(doorAt(seed + 9.9, 1.15, 1.7));
  parts.push(
    ...windowsAt(
      [
        [-0.8, 2.9],
        [0.8, 2.9],
        [0, 4.0],
      ],
      1.72,
      seed + 12.3,
    ),
  );
  return mergeParts(parts);
}

/** 2. Round watchtower: tall lathe, machicolated overhang, teeth ring,
 * small center cone, door. */
function buildWatchtower(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(plinthSlab(3.2, 3.2, seed + 0.1));
  parts.push(towerRound(1.15, 6.3, seed + 1.1, 1.2));
  parts.push(...crenellationRing(1.28, 6.3, 9, seed + 2.2));
  const cone = coneCap(0.66, 1.3, seed + 3.3);
  cone.translate(0, 6.28, 0);
  parts.push(cone);
  parts.push(doorAt(seed + 4.4, 1.0, 1.12));
  parts.push(...windowsAt([[0, 3.6]], 1.02, seed + 5.5));
  return mergeParts(parts);
}

/** 3. Gatehouse: twin crenellated towers flanking an arched wall. */
function buildGatehouse(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const wall = extrudeWobbled(
    [
      [-1.6, 0],
      [-0.72, 0],
      [-0.72, 1.7],
      [-0.6, 2.05],
      [-0.34, 2.28],
      [0, 2.36],
      [0.34, 2.28],
      [0.6, 2.05],
      [0.72, 1.7],
      [0.72, 0],
      [1.6, 0],
      [1.6, 3.3],
      [-1.6, 3.3],
    ],
    1.05,
    seed + 1.1,
    { bow: 0.02, corner: 0.06, jitter3d: 0.02 },
  );
  parts.push(wall);
  const teeth = teethStrip(2.9, 0.14, 0.3, seed + 2.2);
  teeth.translate(0, 3.3, 0);
  parts.push(teeth);
  for (const side of [-1, 1]) {
    const tower = towerRound(0.78, 4.8, seed + 3.3 + side);
    tower.translate(side * 1.85, 0, 0);
    parts.push(tower);
    parts.push(...crenellationRing(0.85, 4.8, 7, seed + 5.5 + side, [side * 1.85, 0]));
    parts.push(...windowsAt([[side * 1.85, 3.4]], 0.72, seed + 7.7 + side));
  }
  return mergeParts(parts);
}

/** 4. Walled courtyard: a low crenellated wall ring (~10u square) with a
 * gate gap and corner posts; the interior stays open ground. */
function buildCourtyard(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const half = 5.1;
  const wallH = 1.55;
  const thick = 0.46;
  const mk = (len: number, s: number): BufferGeometry =>
    teethStrip(len, wallH, thick, seed + s, { toothH: 0.44, pitch: 0.95 });
  const back = mk(10.0, 1.1);
  back.translate(0, 0, -half);
  parts.push(back);
  for (const side of [-1, 1]) {
    const flank = mk(10.0, 2.2 + side);
    flank.rotateY(Math.PI / 2);
    flank.translate(side * half, 0, 0);
    parts.push(flank);
  }
  // Front wall: two runs flanking the walkable gate gap.
  const gateHalf = 1.15;
  for (const side of [-1, 1]) {
    const run = mk(3.9, 4.4 + side);
    run.translate(side * (gateHalf + 1.95), 0, half);
    parts.push(run);
    const post = slabBox(0.52, 2.0, 0.52, seed + 6.6 + side, { segs: 2 });
    post.translate(side * gateHalf, 0, half);
    parts.push(post);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = slabBox(0.66, 2.15, 0.66, seed + 8.8 + sx * 1.3 + sz * 0.7, { segs: 2 });
      post.translate(sx * half, 0, sz * half);
      parts.push(post);
    }
  }
  return mergeParts(parts);
}

/** 5. Adobe flat-roof house: box + parapet rim + small windows + door. */
function buildAdobe(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(plinthSlab(3.3, 2.9, seed + 0.1));
  const boxH = 3.25;
  parts.push(slabBox(2.6, boxH, 2.2, seed + 1.1));
  // Parapet: four thin rim slabs proud of the roofline.
  for (const side of [-1, 1]) {
    const front = slabBox(2.8, 0.42, 0.18, seed + 2.2 + side, { segs: 2 });
    front.translate(0, boxH - 0.06, side * 1.12);
    parts.push(front);
    const flank = slabBox(2.4, 0.42, 0.18, seed + 4.4 + side, { segs: 2 });
    flank.rotateY(Math.PI / 2);
    flank.translate(side * 1.32, boxH - 0.06, 0);
    parts.push(flank);
  }
  parts.push(doorAt(seed + 6.6, 0.95, 1.1));
  parts.push(
    ...windowsAt(
      [
        [-0.75, 2.3],
        [0.75, 2.3],
      ],
      1.12,
      seed + 7.7,
    ),
  );
  const sideWin = windowSlab(seed + 9.9);
  sideWin.rotateY(Math.PI / 2); // rotate first: the slab's normal turns to +x…
  sideWin.translate(1.3, 1.67, 0.5); // …then park it proud of the flank wall
  parts.push(sideWin);
  return mergeParts(parts);
}

/** 6. Pagoda house: two tiers of upturned-eave roofs over stacked boxes,
 * topped with a finial. */
function buildPagoda(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(plinthSlab(3.5, 3.5, seed + 0.1));
  parts.push(slabBox(2.9, 2.05, 2.9, seed + 1.1));
  const roof1 = pagodaRoof(1.62, 1.15, seed + 2.2);
  roof1.translate(0, 1.95, 0);
  parts.push(roof1);
  parts.push((() => {
    const upper = slabBox(1.95, 1.5, 1.95, seed + 3.3);
    upper.translate(0, 2.6, 0);
    return upper;
  })());
  const roof2 = pagodaRoof(1.15, 1.0, seed + 4.4);
  roof2.translate(0, 4.0, 0);
  parts.push(roof2);
  const finial = latheWobbled(
    [
      [0.16, 0],
      [0.1, 0.32],
      [0.14, 0.4],
      [0.02, 0.58],
    ],
    8,
    seed + 5.5,
    { bow: 0.05, jitter3d: 0.01 },
  );
  finial.translate(0, 4.85, 0);
  parts.push(finial);
  parts.push(doorAt(seed + 6.6, 1.0, 1.45));
  return mergeParts(parts);
}

/** 7. Longhouse / barn: long low box, big sagging gable, barn-door arch. */
function buildLonghouse(seed: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  parts.push(plinthSlab(3.1, 5.7, seed + 0.1));
  parts.push(slabBox(2.4, 2.25, 5.2, seed + 1.1));
  const roof = gableRoof(2.75, 1.85, 5.5, seed + 2.2, 0.18);
  roof.translate(0, 2.2, 0);
  parts.push(roof);
  parts.push(doorAt(seed + 3.3, 1.5, 2.6));
  for (const side of [-1, 1]) {
    const win = windowSlab(seed + 4.4 + side);
    win.rotateY(Math.PI / 2); // normal to +x…
    win.translate(1.21, 1.07, side * 1.4); // …proud of the long flank
    parts.push(win);
  }
  return mergeParts(parts);
}

/** 8. Cottage: gabled cross-section extruded, sagging ridge, leaning
 * chimney — upgraded with a door, a window, and a plinth. */
function buildCottage(seed: number): BufferGeometry {
  const w = 1.6; // half-width
  const wall = 2.3;
  const ridge = 3.8;
  const depth = 2.7;
  const body = extrudeWobbled(
    [
      [-w, 0],
      [w, 0],
      [w, wall],
      [0, ridge],
      [-w, wall],
    ],
    depth,
    seed,
    { bow: 0.022, corner: 0.07 },
  );
  // The ridge sags in the middle of its run — a drawn roofline, not ruled.
  mapVertices(body, (x, y, z) => {
    if (y <= wall) return [x, y, z];
    const t = (y - wall) / (ridge - wall);
    const across = 1 - (z / (depth / 2)) ** 2;
    return [x, y - 0.14 * t * Math.max(across, 0), z];
  });
  body.computeVertexNormals();
  // Chimney: a slightly-leaning wobbled box punched through the roof plane.
  const chimney = extrudeWobbled(
    [
      [-0.26, 0],
      [0.26, 0],
      [0.31, 1.6],
      [-0.2, 1.6],
    ],
    0.5,
    seed + 5.1,
    { bow: 0.03, corner: 0.1 },
  );
  chimney.translate(0.95, 2.45, 0.5);
  const plinth = plinthSlab(3.7, 3.1, seed + 7.3);
  const door = doorAt(seed + 8.5, 1.0, 1.35);
  const win = windowSlab(seed + 9.7);
  win.translate(0.85, 1.5, 1.36);
  return mergeParts([body, chimney, plinth, door, win]);
}

/** 9. Mushroom-house — the original landmark, a lathed stem + cap. */
function buildMushroomHouse(seed: number): BufferGeometry {
  const body = latheWobbled(
    [
      [0.95, 0],
      [0.72, 0.8],
      [0.62, 2.4],
      [0.78, 3.15],
      [1.95, 3.35],
      [2.08, 3.75],
      [1.65, 4.6],
      [0.9, 5.15],
      [0.3, 5.36],
      [0.02, 5.4],
    ],
    16,
    seed,
    { bow: 0.05, jitter3d: 0.03 },
  );
  const door = buildDoorStub(seed + 4.3, 0.9);
  door.translate(0, 0, 0.7);
  return mergeParts([body, door]);
}

/** One drooping frond blade, pointing +x from the origin: a thin tapered
 * ribbon with a shallow V cross-section so it reads from the iso camera. */
function frondBlade(len: number, droop: number, seed: number): BufferGeometry {
  const N = 6;
  const pt = (t: number, side: -1 | 0 | 1): [number, number, number] => {
    const x = t * len * (1 + shash(seed + t * 9.1) * 0.02);
    const y =
      len * (0.38 * t - (0.38 + 0.5 * droop) * t * t) + shash(seed + t * 5.3) * 0.02;
    const w = 0.17 * len * Math.sin(Math.min(t * 1.15, 1) * Math.PI) ** 0.65 + 0.015;
    if (side === 0) return [x, y, 0];
    return [x, y - w * 0.35, side * w * 0.5];
  };
  const positions: number[] = [];
  for (let k = 0; k < N; k++) {
    const t0 = k / N;
    const t1 = (k + 1) / N;
    const c0 = pt(t0, 0);
    const l0 = pt(t0, -1);
    const r0 = pt(t0, 1);
    const c1 = pt(t1, 0);
    const l1 = pt(t1, -1);
    const r1 = pt(t1, 1);
    positions.push(...c0, ...l0, ...l1, ...c0, ...l1, ...c1);
    positions.push(...c0, ...r1, ...r0, ...c0, ...c1, ...r1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Palm: curved lathed trunk + crown knob + 5–7 drooping frond blades.
 * Rendered double-sided; fronds ride the wind sway path strongly. */
function buildPalm(seed: number, h: number, bend: number, fronds: number): BufferGeometry {
  const trunkH = h * 0.72;
  const trunk = latheWobbled(
    [
      [0.36, 0],
      [0.26, trunkH * 0.35],
      [0.2, trunkH * 0.75],
      [0.24, trunkH],
      [0.02, trunkH + 0.05],
    ],
    10,
    seed,
    { bow: 0.06, jitter3d: 0.02 },
  );
  // The trunk curves — x displaces by height fraction squared, the drawn
  // lean every palm in the sheet carries.
  mapVertices(trunk, (x, y, z) => {
    const f = Math.max(y, 0) / trunkH;
    return [x + bend * f * f, y, z];
  });
  trunk.computeVertexNormals();
  const crown = latheWobbled(
    [
      [0.05, -0.3],
      [0.3, -0.1],
      [0.26, 0.2],
      [0.02, 0.34],
    ],
    8,
    seed + 3.3,
    { bow: 0.06, jitter3d: 0.015 },
  );
  crown.translate(bend, trunkH, 0);
  const parts = [trunk, crown];
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + shash(seed + i * 3.7) * 0.35;
    const len = h * 0.42 * (0.85 + 0.3 * hash(seed + i * 5.1));
    const droop = 0.7 + 0.5 * hash(seed + i * 7.7);
    const frond = frondBlade(len, droop, seed + i * 11.3);
    frond.rotateY(a);
    frond.translate(bend, trunkH + 0.12, 0);
    parts.push(frond);
  }
  return mergeParts(parts);
}

/** One wobbled plank: a rounded-rect profile (x/y) extruded along z. */
function plank(
  len: number,
  thick: number,
  width: number,
  seed: number,
): BufferGeometry {
  return extrudeWobbled(
    [
      [-len / 2, -thick / 2],
      [len / 2, -thick / 2],
      [len / 2, thick / 2],
      [-len / 2, thick / 2],
    ],
    width,
    seed,
    { bow: 0.02, corner: 0.12, jitter: 0.008, jitter3d: 0.012 },
  );
}

/** Picnic table: sagging top slab, two benches, A-frame legs and bench
 * braces — hand-wobbled planks merged into one geometry. */
function buildPicnicTable(seed: number, len: number, benchW: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const top = plank(len, 0.13, 1.0, seed);
  top.translate(0, 1.32, 0);
  parts.push(top);
  for (const side of [-1, 1]) {
    const bench = plank(len, 0.1, benchW, seed + side * 2.1);
    bench.translate(0, 0.62, side * 0.8);
    parts.push(bench);
  }
  const endX = len / 2 - 0.32;
  for (const end of [-1, 1]) {
    // Crossed A-frame legs, pivoting at the top, splayed toward the benches.
    for (const lean of [-1, 1]) {
      const leg = extrudeWobbled(
        [
          [-0.07, -1.47],
          [0.07, -1.47],
          [0.07, 0],
          [-0.07, 0],
        ],
        0.24,
        seed + end * 5.3 + lean * 1.7,
        { bow: 0.025, corner: 0.1, jitter: 0.008, jitter3d: 0.012 },
      );
      leg.rotateX(lean * 0.55);
      leg.translate(end * endX, 1.26, 0);
      parts.push(leg);
    }
    // Bench brace: a beam along z carrying both benches.
    const brace = extrudeWobbled(
      [
        [-0.13, 0.5],
        [0.13, 0.5],
        [0.13, 0.62],
        [-0.13, 0.62],
      ],
      1.95,
      seed + end * 7.9,
      { bow: 0.02, corner: 0.1, jitter: 0.008, jitter3d: 0.012 },
    );
    brace.translate(end * endX, 0, 0);
    parts.push(brace);
  }
  return mergeParts(parts);
}

/** Water tower: lathed tank (bellied sides, conical roof, cap knob) on
 * four wobbled legs splaying to the ground. */
function buildWaterTower(seed: number, h: number, splay: number): BufferGeometry {
  const tankBase = h * 0.56;
  const tank = latheWobbled(
    [
      [0.06, tankBase + 0.1],
      [1.0, tankBase],
      [1.22, tankBase + 0.3],
      [1.24, tankBase + 1.65], // near-cylindrical drum, not a balloon
      [1.34, tankBase + 1.72], // eave lip where the roof starts
      [1.28, tankBase + 1.82],
      [0.16, h - 0.16], // conical roof
      [0.2, h - 0.1],
      [0.08, h - 0.02],
      [0.02, h],
    ],
    12,
    seed,
    { bow: 0.025, jitter3d: 0.022 },
  );
  const parts = [tank];
  const legH = tankBase + 0.15;
  for (let i = 0; i < 4; i++) {
    const leg = extrudeWobbled(
      [
        [-0.11, 0],
        [0.11, 0],
        [0.11, legH],
        [-0.11, legH],
      ],
      0.22,
      seed + i * 4.7,
      { bow: 0.02, corner: 0.1, jitter: 0.01, jitter3d: 0.014 },
    );
    // Splay: at the ground the leg stands wide, under the tank it tucks in.
    mapVertices(leg, (x, y, z) => {
      const t = Math.min(Math.max(y / legH, 0), 1);
      const r = splay + (0.74 - splay) * t;
      return [x + r, y, z];
    });
    leg.computeVertexNormals();
    leg.rotateY((i / 4) * Math.PI * 2 + Math.PI / 4 + shash(seed + i * 8.1) * 0.06);
    parts.push(leg);
  }
  return mergeParts(parts);
}

// ── the variant library ──────────────────────────────────────────────────────
// Authored by eye against the forest + hidden-folks environment references.
// Heights are per-variant [D]: a spire out-tops a squat pine, a water
// tower out-tops a cottage.

interface PropVariantDef {
  /** Debug/name tag — never rendered. */
  name: string;
  strokes: StrokeList;
  /** World-unit height at instance scale 1. */
  height: number;
}

interface ArchVariantDef {
  /** Debug/name tag — never rendered. */
  name: string;
  /** World-unit height at instance scale 1. */
  height: number;
  /** Deterministic constructor (seeds baked in). */
  build: () => BufferGeometry;
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
  cactus: [
    {
      // Saguaro with two arms stepping up — organic, pillowy on purpose.
      name: 'two-arm',
      height: 3.2,
      strokes: [
        wobblyPath([[0.5, 0.3], [0.51, 0.52], [0.5, 0.74], [0.5, 0.88]], 0.15, 811.1, 0.006),
        ...wobblyBlob(0.5, 0.27, 0.09, 812.2, { ry: 0.07, lump: 0.14 }),
        wobblyPath([[0.44, 0.55], [0.35, 0.56], [0.34, 0.42]], 0.09, 813.3, 0.005),
        ...wobblyBlob(0.34, 0.4, 0.055, 814.4, { lump: 0.16 }),
        wobblyPath([[0.56, 0.66], [0.65, 0.66], [0.66, 0.53]], 0.085, 815.5, 0.005),
        ...wobblyBlob(0.66, 0.51, 0.05, 816.6, { lump: 0.16 }),
      ],
    },
    {
      // One-armed stray.
      name: 'one-arm',
      height: 2.9,
      strokes: [
        wobblyPath([[0.5, 0.32], [0.49, 0.55], [0.5, 0.76], [0.5, 0.88]], 0.16, 821.1, 0.006),
        ...wobblyBlob(0.5, 0.29, 0.095, 822.2, { ry: 0.07, lump: 0.14 }),
        wobblyPath([[0.57, 0.62], [0.7, 0.62], [0.71, 0.42]], 0.12, 823.3, 0.005),
        ...wobblyBlob(0.71, 0.39, 0.07, 824.4, { lump: 0.16 }),
      ],
    },
  ],
  monolith: [
    {
      // Big standing slab with a base lump — the mid-band stone landmark.
      name: 'standing-slab',
      height: 4.5,
      strokes: [
        ...wobblyBlob(0.5, 0.48, 0.2, 711.1, { ry: 0.38, lump: 0.12, points: 16 }),
        ...wobblyBlob(0.58, 0.84, 0.15, 712.2, { ry: 0.08, lump: 0.18 }),
      ],
    },
    {
      // Leaning finger of stone.
      name: 'leaning-finger',
      height: 4.0,
      strokes: [
        wobblyPath([[0.56, 0.18], [0.5, 0.45], [0.47, 0.72], [0.46, 0.88]], 0.17, 721.1, 0.006),
        ...wobblyBlob(0.5, 0.86, 0.2, 722.2, { ry: 0.1, lump: 0.16 }),
      ],
    },
  ],
  // ── mountains ─────────────────────────────────────────────────────────
  // The landscape's one large kind: a stack of wobbly blobs, widest at the
  // base, narrowing to a small summit. Inflation ROUNDS them and that is
  // the point — a mountain here is a big pillowy mass, not a cone (TASTE
  // §2.5 forbids engineered form outright, and §3's shared law forbids
  // hard-edged geometry at confidence 1.00). Its steep faces are what the
  // ink pass hatches (GENERATOR §ink pass), so the silhouette carries the
  // whole read: wide foot, one clear summit, craggy edge (lump ~0.2–0.26).
  // [D] Heights are authored per variant so a range has a skyline.
  mountain: [
    {
      // One tall tapered mass with a shoulder running off to the east.
      name: 'peak',
      height: 15,
      strokes: [
        ...wobblyBlob(0.5, 0.83, 0.485, 851.1, { ry: 0.1, lump: 0.2, points: 20 }),
        ...wobblyBlob(0.47, 0.69, 0.37, 852.2, { ry: 0.1, lump: 0.22, points: 18 }),
        ...wobblyBlob(0.66, 0.71, 0.17, 853.3, { ry: 0.08, lump: 0.24 }),
        ...wobblyBlob(0.46, 0.54, 0.26, 854.4, { ry: 0.1, lump: 0.24, points: 16 }),
        ...wobblyBlob(0.45, 0.38, 0.16, 855.5, { ry: 0.09, lump: 0.24 }),
        ...wobblyBlob(0.44, 0.24, 0.085, 856.6, { ry: 0.07, lump: 0.26 }),
      ],
    },
    {
      // Two summits over one foot, the western one clearly lower.
      name: 'twin',
      height: 17,
      strokes: [
        ...wobblyBlob(0.5, 0.84, 0.46, 861.1, { ry: 0.1, lump: 0.2, points: 20 }),
        ...wobblyBlob(0.5, 0.7, 0.38, 862.2, { ry: 0.1, lump: 0.22, points: 18 }),
        ...wobblyBlob(0.34, 0.58, 0.2, 863.3, { ry: 0.09, lump: 0.24 }),
        ...wobblyBlob(0.33, 0.46, 0.115, 864.4, { ry: 0.075, lump: 0.26 }),
        ...wobblyBlob(0.61, 0.55, 0.22, 865.5, { ry: 0.1, lump: 0.24 }),
        ...wobblyBlob(0.62, 0.38, 0.15, 866.6, { ry: 0.09, lump: 0.24 }),
        ...wobblyBlob(0.63, 0.24, 0.08, 867.7, { ry: 0.07, lump: 0.26 }),
      ],
    },
    {
      // A long low saddle — the range's connecting ridge, wide and squat.
      name: 'ridge',
      height: 12,
      strokes: [
        ...wobblyBlob(0.5, 0.83, 0.47, 871.1, { ry: 0.09, lump: 0.2, points: 20 }),
        ...wobblyBlob(0.36, 0.7, 0.27, 872.2, { ry: 0.095, lump: 0.22, points: 16 }),
        ...wobblyBlob(0.66, 0.73, 0.24, 873.3, { ry: 0.085, lump: 0.22, points: 16 }),
        ...wobblyBlob(0.34, 0.53, 0.145, 874.4, { ry: 0.075, lump: 0.24 }),
        ...wobblyBlob(0.5, 0.69, 0.13, 875.5, { ry: 0.065, lump: 0.24 }),
        ...wobblyBlob(0.65, 0.64, 0.115, 876.6, { ry: 0.065, lump: 0.24 }),
      ],
    },
  ],
};

/**
 * Authored footprint radius per mountain variant at instance scale 1, in
 * world units — PURE placement code needs a mountain's reach (to clear the
 * ground under it) without building geometry, and geometry only exists
 * once a renderer asks for it. Kept honest by a test: each built variant's
 * measured `radius` must land within 30% of the value here.
 */
export const MOUNTAIN_FOOTPRINT: readonly number[] = [7, 8.2, 9.6];

export const ARCH_VARIANT_DEFS: Record<ArchPropKind, ArchVariantDef[]> = {
  building: [
    { name: 'keep', height: 6.5, build: () => buildKeep(511.1) },
    { name: 'watchtower', height: 7.2, build: () => buildWatchtower(521.1) },
    { name: 'gatehouse', height: 5.6, build: () => buildGatehouse(531.1) },
    { name: 'courtyard', height: 2.4, build: () => buildCourtyard(541.1) },
    { name: 'adobe', height: 4.0, build: () => buildAdobe(551.1) },
    { name: 'pagoda', height: 6.2, build: () => buildPagoda(561.1) },
    { name: 'longhouse', height: 4.6, build: () => buildLonghouse(571.1) },
    { name: 'cottage', height: 3.8, build: () => buildCottage(581.1) },
    { name: 'mushroom-house', height: 5.4, build: () => buildMushroomHouse(51.1) },
  ],
  palm: [
    { name: 'lean', height: 5.5, build: () => buildPalm(911.1, 5.5, 0.55, 6) },
    { name: 'arc', height: 5.1, build: () => buildPalm(921.1, 5.1, 0.9, 5) },
    { name: 'tall-straight', height: 5.8, build: () => buildPalm(931.1, 5.8, 0.3, 7) },
  ],
  picnicTable: [
    { name: 'table', height: 1.4, build: () => buildPicnicTable(941.1, 2.7, 0.34) },
    { name: 'table-short', height: 1.35, build: () => buildPicnicTable(951.1, 2.25, 0.38) },
  ],
  waterTower: [
    { name: 'tank-tall', height: 6.5, build: () => buildWaterTower(961.1, 6.5, 1.32) },
    { name: 'tank-squat', height: 6.0, build: () => buildWaterTower(971.1, 6.0, 1.5) },
  ],
};

/** Index of the walled-courtyard family — scatter caps it at ONE in the
 * whole region (the pack's largest landmark). */
export const BUILDING_COURTYARD_VARIANT = 3;

function variantMetaOf(kind: PropKind): { name: string; height: number }[] {
  return (INFLATED_PROP_KINDS as readonly string[]).includes(kind)
    ? PROP_VARIANT_DEFS[kind as InflatedPropKind]
    : ARCH_VARIANT_DEFS[kind as ArchPropKind];
}

/** Variant count per kind — for scatter's pure placement math (no geometry). */
export const PROP_VARIANT_COUNTS: Record<PropKind, number> = Object.fromEntries(
  PROP_KINDS.map((kind) => [kind, variantMetaOf(kind).length]),
) as Record<PropKind, number>;

// ── geometry build ───────────────────────────────────────────────────────────

export interface PropVariant {
  geometry: BufferGeometry;
  /** World-unit height at instance scale 1 (min.y is baked to 0). */
  height: number;
  /** Footprint radius in world units at scale 1, for shadows + exclusions. */
  radius: number;
}

/** Scale to the variant height, ground (min.y = 0), center in x/z. */
function normalizeVariant(
  geometry: BufferGeometry,
  height: number,
  tag: string,
): PropVariant {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) throw new Error(`prop '${tag}' built to nothing`);
  const rawHeight = Math.max(box.max.y - box.min.y, 1e-6);
  const s = height / rawHeight;
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
  return { geometry, height, radius };
}

/**
 * Build every variant once — inflated kinds through analyze()+inflate(),
 * architectural kinds through their extrude/lathe builders. Geometry is
 * scaled to its variant height, grounded (min.y = 0) and centered in x/z,
 * so instances only need translate + y-rotation + uniform scale.
 */
export function buildPropGeometries(): Map<PropKind, PropVariant[]> {
  const out = new Map<PropKind, PropVariant[]>();
  for (const kind of INFLATED_PROP_KINDS) {
    const size = propMaskSize(kind);
    const variants: PropVariant[] = [];
    for (const def of PROP_VARIANT_DEFS[kind]) {
      const analysis = analyze(def.strokes, { size, contourPoints: 96 });
      if (!analysis) throw new Error(`prop '${kind}/${def.name}' produced no usable ink`);
      // Coarse interior refinement: props render at ~100px, so gridStep 10
      // is invisible on screen and keeps the build inside the init budget.
      const geometry = toBufferGeometry(inflate(analysis, { gridStep: 10 }));
      variants.push(normalizeVariant(geometry, def.height, `${kind}/${def.name}`));
    }
    out.set(kind, variants);
  }
  for (const kind of ARCH_PROP_KINDS) {
    const variants: PropVariant[] = [];
    for (const def of ARCH_VARIANT_DEFS[kind]) {
      variants.push(normalizeVariant(def.build(), def.height, `${kind}/${def.name}`));
    }
    out.set(kind, variants);
  }
  return out;
}
