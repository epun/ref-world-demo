/**
 * Water (PLAN §7 world, geography from src/world/landscape.ts): four small
 * ponds and one lake with an island, drawn the way the reference draws water —
 * one flat value, a rough drawn shoreline, a few sparse ripple marks, and a
 * great deal of empty surface between them (TASTE §2.3).
 *
 * WHY THE SHORELINE IS ITS OWN MESH. The ground is an unlit disc at y=0 and the
 * ink composite only draws a contour where depth or the normal target breaks.
 * A flat polygon a hair above the ground breaks neither, so left to the pass
 * the water would be a value with no edge — a stain, not a pond. The shore is
 * therefore drawn: an ink ribbon walked around the body's FILL outline, with a
 * pen's varying width and an occasional lifted segment. Walking the fill
 * outline rather than the rings is what gives the lake's land bridge its two
 * banks — that polygon already traces every boundary between water and land,
 * in one direction, so one stroke covers all of it. Same reason the ripples
 * are geometry and not a texture.
 *
 * Everything here is built ONCE from WATER_BODIES. The geography is authored
 * and fixed (it does not ride the scatter seed), so there is no rebuild path —
 * only `update`, which advances the ripples' ambient drift.
 *
 * VALUE [D]: the fill is WORLD.neutralMid, one measured step below the paper.
 * The reference's water is a flat tone rather than a gradient, and neutralMid
 * is a palette grey, so the toon quantize snaps it to itself instead of
 * dragging it into a neighbouring band. Never near-black: that belongs to
 * characters (TASTE §1).
 *
 * NORMALS [D]: every surface here carries an up normal, exactly like the
 * ground. The ink pass reads a normal target; giving the water its own facing
 * would ring each pond in a second, unwanted contour beside the drawn one.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import {
  OUTLINE_POINTS,
  RIPPLE_MARGIN,
  WATER_BODIES,
  isWater,
  rippleSpots,
  waterFillOutline,
  type RippleSpot,
  type WaterBody,
} from './landscape';

// ── lifts [D] ────────────────────────────────────────────────────────────────
// Three hairs above the paper, in drawing order, and all of them UNDER the
// scatter's ticks (0.015) and prop stamps (0.018) and under the creature
// shadows (0.02) — so a creature walking the shore still casts its flat stamp
// across the water instead of being erased by it.

/** The flat water value. */
export const WATER_LIFT = 0.008;
/** The drawn shoreline, over its own fill. */
export const SHORE_LIFT = 0.011;
/** Ripple marks, the topmost water layer. */
export const RIPPLE_LIFT = 0.013;

// ── shoreline [D] ────────────────────────────────────────────────────────────

/** Outline samples per default point, for the ribbon: the pen has to follow
 * the wobble smoothly, and the outline's own default is a polygon budget. */
const SHORE_SUBDIVISION = 4;
/**
 * A pen, not a rule: the stroke swells and thins between these widths. Sized
 * against the ink pass's own contours (2.1 device px) at default framing —
 * a shore is the heavier line of the two, not twice it.
 */
const SHORE_WIDTH_MIN = 0.1;
const SHORE_WIDTH_MAX = 0.2;
/** Miter cap. The offset at a vertex is scaled by 1/cos(half the turn), which
 * runs away at a hairpin — clamped here so the ribbon can never fold over
 * itself at the sharp corner where a bank leg meets an arc. */
const SHORE_MITER_MAX = 2;
/** Vertices per width cell — the width is hashed per cell and eased across
 * it, so the stroke breathes along its length instead of fizzing. */
const SHORE_WIDTH_CELL = 8;
/** Roughly one segment in this many is skipped: the pen lifts off the paper,
 * and a broken contour is what reads as drawn rather than extruded. */
const SHORE_BREAK_ONE_IN = 12;
/** How far a segment midpoint is pushed toward the water to ask whether there
 * is any water on the wet side of it — a guard against drawing a stroke where
 * the geography holds no water at all. */
const SHORE_PROBE = 0.3;

// ── ripples [D] ──────────────────────────────────────────────────────────────

/** Quads per arc — enough that a shallow arc reads as a curve, few enough
 * that the whole field of marks stays one small buffer. */
const RIPPLE_ARC_QUADS = 6;
/** Stroke width of a ripple arc. */
const RIPPLE_WIDTH = 0.05;
/** The trailing arc's length, as a fraction of the leading one. */
const RIPPLE_SECOND_SCALE = 0.6;
/** How far behind the leading arc the trailing one sits. */
const RIPPLE_SECOND_OFFSET = 0.22;
/** Arc depth as a fraction of its length — shallow: a bow, not a crescent. */
const RIPPLE_BOW = 0.16;
/**
 * Ambient drift amplitude, in world units (TASTE §2.1: nothing fully arrests,
 * and the stillness probe samples idle elements). Each mark slides along its
 * own direction on a slow sine — smooth at every instant, never a snap, and
 * small enough that the marks stay where the geography put them.
 */
export const RIPPLE_DRIFT = 0.06;
/** [D] Ponds are too small for the default shore clearance — at 1.8 units the
 * smallest one holds no mark at all. 1.0 still keeps every mark off its own
 * shoreline. */
const POND_RIPPLE_MARGIN = 1.0;
/** Drift period: two ambient beats, the slowest thing on screen. */
const RIPPLE_PERIOD_S = (MOTION.ambientMs * 2) / 1000;
const RIPPLE_OMEGA = (Math.PI * 2) / RIPPLE_PERIOD_S;

// ── deterministic hash ───────────────────────────────────────────────────────

/** Same recipe family as landscape/props, and like them independent of the
 * scatter seed: a re-seeded world has the same shorelines. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** A number that is always a glsl float literal (never `2` for `2.0`). */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

// ── pure geometry builders ───────────────────────────────────────────────────

type Point = [number, number];

/**
 * Split any segment much longer than the polygon's own typical one, so the
 * whole loop is sampled at one density.
 *
 * The fill outline is evenly sampled along its arcs but joins them with two
 * LONG straight legs across the land bridge banks. Left alone each bank would
 * be a single quad: a ruled line with no width variation, and — worse — one
 * roll of the pen-lift hash away from vanishing whole. Cut to the same spacing
 * as the arcs beside them, the banks get the same hand as the rest of the
 * shore. The threshold is the polygon's own median segment, so it self-tunes
 * per body and is a no-op for a pond (whose outline is already uniform).
 */
function densify(poly: readonly Point[]): Point[] {
  const n = poly.length;
  const lengths: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    lengths.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const median = [...lengths].sort((x, y) => x - y)[Math.floor(n / 2)] ?? 0;
  if (median <= 1e-9) return [...poly];
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    out.push([a[0], a[1]]);
    if (lengths[i]! <= median * 1.5) continue;
    const cuts = Math.ceil(lengths[i]! / median);
    for (let k = 1; k < cuts; k++) {
      const t = k / cuts;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Pen width at vertex `i` of a closed line of `count` vertices. Hashed per
 * cell, smoothstepped between cells, and wrapped so the seam is invisible. */
function penWidth(seed: number, i: number, count: number): number {
  const cells = Math.max(1, Math.ceil(count / SHORE_WIDTH_CELL));
  const at = i / SHORE_WIDTH_CELL;
  const k = Math.floor(at) % cells;
  const t = at - Math.floor(at);
  const s = t * t * (3 - 2 * t);
  const a = hash(seed + k * 4.7);
  const b = hash(seed + ((k + 1) % cells) * 4.7);
  return SHORE_WIDTH_MIN + (SHORE_WIDTH_MAX - SHORE_WIDTH_MIN) * (a + (b - a) * s);
}

/**
 * The ink ribbon for one closed shoreline: a triangle strip offset ± half the
 * pen width along each vertex's mitered outward normal.
 *
 * The polygon is the body's FILL outline, which is counter-clockwise and
 * encloses exactly the water — so `(dz, −dx)` points away from the water at
 * every single vertex, whichever edge it belongs to: outward on the outer
 * shore, back toward the middle along the island's, and sideways into the land
 * bridge along the two bank legs. One walk draws all of it, banks included.
 * The isWater probe below is therefore a guard rather than a filter now.
 */
function ribbonGeometry(poly: readonly Point[], seed: number): BufferGeometry {
  /** Into the water: the inward side of a counter-clockwise fill outline. */
  const towardWater = -1;
  const n = poly.length;
  const segNx = new Float64Array(n);
  const segNz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    // Outward normal of a counter-clockwise ring in x/z is (dz, −dx).
    segNx[i] = dz / len;
    segNz[i] = -dx / len;
  }
  // Per-vertex offset: the mean of the two adjoining segment normals, scaled
  // by 1/cos(half the turn) so the stroke keeps its width THROUGH a bend
  // instead of pinching on the outside of it — and capped, so the two sharp
  // corners where a bank leg meets an arc read as a pen corner rather than a
  // spike that folds back over the ribbon.
  const offX = new Float64Array(n);
  const offZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n;
    const sx = segNx[p]! + segNx[i]!;
    const sz = segNz[p]! + segNz[i]!;
    const len = Math.hypot(sx, sz);
    if (len < 1e-9) {
      // A hairpin: no mean direction at all. Fall back to the outgoing normal.
      offX[i] = segNx[i]! * SHORE_MITER_MAX;
      offZ[i] = segNz[i]! * SHORE_MITER_MAX;
      continue;
    }
    const miter = Math.min(SHORE_MITER_MAX, 2 / len);
    offX[i] = (sx / len) * miter;
    offZ[i] = (sz / len) * miter;
  }
  const positions: number[] = [];
  const push = (x: number, z: number): void => {
    positions.push(x, 0, z);
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const mx = (a[0] + b[0]) / 2 + segNx[i]! * towardWater * SHORE_PROBE;
    const mz = (a[1] + b[1]) / 2 + segNz[i]! * towardWater * SHORE_PROBE;
    // Guard: no water on the wet side means this is not a shoreline at all.
    if (!isWater(mx, mz)) continue;
    // The pen lifts.
    if (hash(seed + i * 1.37 + 3.1) < 1 / SHORE_BREAK_ONE_IN) continue;
    const j = (i + 1) % n;
    const aw = penWidth(seed, i, n) / 2;
    const bw = penWidth(seed, j, n) / 2;
    const alx = a[0] + offX[i]! * aw;
    const alz = a[1] + offZ[i]! * aw;
    const arx = a[0] - offX[i]! * aw;
    const arz = a[1] - offZ[i]! * aw;
    const blx = b[0] + offX[j]! * bw;
    const blz = b[1] + offZ[j]! * bw;
    const brx = b[0] - offX[j]! * bw;
    const brz = b[1] - offZ[j]! * bw;
    push(alx, alz);
    push(arx, arz);
    push(blx, blz);
    push(arx, arz);
    push(brx, brz);
    push(blx, blz);
  }
  const geometry = new BufferGeometry();
  const count = positions.length / 3;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  return geometry;
}

/** One shallow arc of `quads` thin quads, appended to the running buffers. */
function emitArc(
  positions: number[],
  ripple: number[],
  spot: RippleSpot,
  len: number,
  behind: number,
  phase: number,
): void {
  const dx = Math.cos(spot.rot);
  const dz = Math.sin(spot.rot);
  // The bow axis, and the direction the trailing arc sits along.
  const px = -dz;
  const pz = dx;
  const cx = spot.x + px * behind;
  const cz = spot.z + pz * behind;
  const bow = RIPPLE_BOW * len;
  const stations: Point[] = [];
  for (let s = 0; s <= RIPPLE_ARC_QUADS; s++) {
    const t = s / RIPPLE_ARC_QUADS - 0.5;
    const rise = bow * (1 - 4 * t * t);
    stations.push([cx + dx * t * len + px * rise, cz + dz * t * len + pz * rise]);
  }
  const half = RIPPLE_WIDTH / 2;
  for (let s = 0; s < RIPPLE_ARC_QUADS; s++) {
    const a = stations[s]!;
    const b = stations[s + 1]!;
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    const nx = (tz / tl) * half;
    const nz = (-tx / tl) * half;
    const quad: Point[] = [
      [a[0] + nx, a[1] + nz],
      [a[0] - nx, a[1] - nz],
      [b[0] + nx, b[1] + nz],
      [a[0] - nx, a[1] - nz],
      [b[0] - nx, b[1] - nz],
      [b[0] + nx, b[1] + nz],
    ];
    for (const [x, z] of quad) {
      positions.push(x, 0, z);
      // Every vertex of a mark carries the mark's own direction and phase, so
      // the whole mark slides as one piece and no two marks slide together.
      ripple.push(dx, dz, phase);
    }
  }
}

// ── the pass ─────────────────────────────────────────────────────────────────

export interface Water {
  group: Group;
  /** Advance the ambient ripple drift. Call once per frame. */
  update(nowMs: number): void;
  /** For the minimap and tests: the fill polygons in world x/z. */
  fills(): [number, number][][];
  dispose(): void;
}

export function createWater(): Water {
  const group = new Group();
  group.name = 'water';

  const geometries: BufferGeometry[] = [];
  const materials: MeshBasicMaterial[] = [];
  const fillPolys: Point[][] = [];

  // ── the flat value ────────────────────────────────────────────────────────
  // One unlit polygon per body. The lake's is a C — the land bridge is cut out
  // of it so the water reads as a ring you can walk into the middle of.
  const fillMaterial = new MeshBasicMaterial({ color: WORLD.neutralMid });
  materials.push(fillMaterial);
  WATER_BODIES.forEach((body: WaterBody, index: number) => {
    const poly = waterFillOutline(body);
    fillPolys.push(poly);
    const shape = new Shape();
    // Built in (x, −z) and laid flat by a −90° turn about x, which maps
    // (x, y, 0) → (x, 0, −y): the shape's y comes back as world z, and the
    // shape's +z normal comes back pointing up.
    shape.moveTo(poly[0]![0], -poly[0]![1]);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i]![0], -poly[i]![1]);
    shape.closePath();
    const geometry = new ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    geometries.push(geometry);
    const mesh = new Mesh(geometry, fillMaterial);
    mesh.name = `water-${body.kind}-${index}`;
    mesh.position.y = WATER_LIFT;
    group.add(mesh);
  });

  // ── the drawn shore ───────────────────────────────────────────────────────
  // ONE ribbon per body, walked around its fill outline. For a pond that is
  // just its shore; for the lake it is the outer shore, the bank of the land
  // bridge, the island's shore and the far bank, in a single closed stroke —
  // the whole edge between water and land, drawn as the pen would draw it.
  const shoreMaterial = new MeshBasicMaterial({ color: SURFACE.ink, side: DoubleSide });
  materials.push(shoreMaterial);
  WATER_BODIES.forEach((body: WaterBody, index: number) => {
    const geometry = ribbonGeometry(
      densify(waterFillOutline(body, OUTLINE_POINTS * SHORE_SUBDIVISION)),
      body.seed,
    );
    geometries.push(geometry);
    const mesh = new Mesh(geometry, shoreMaterial);
    mesh.name = `shore-${body.kind}-${index}`;
    mesh.position.y = SHORE_LIFT;
    group.add(mesh);
  });

  // ── ripple marks ──────────────────────────────────────────────────────────
  // Every mark of every body in ONE buffer with ONE material: the marks never
  // move relative to each other on the cpu, and the drift is a vertex shader
  // away, so this is a single draw call for the whole water surface.
  const positions: number[] = [];
  const ripple: number[] = [];
  for (const body of WATER_BODIES) {
    const margin = body.kind === 'pond' ? POND_RIPPLE_MARGIN : RIPPLE_MARGIN;
    for (const spot of rippleSpots(body, margin)) {
      const phase = hash(body.seed + spot.x * 3.7 + spot.z * 5.3) * Math.PI * 2;
      emitArc(positions, ripple, spot, spot.len, 0, phase);
      emitArc(positions, ripple, spot, spot.len * RIPPLE_SECOND_SCALE, RIPPLE_SECOND_OFFSET, phase);
    }
  }
  const rippleGeometry = new BufferGeometry();
  const rippleCount = positions.length / 3;
  rippleGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  rippleGeometry.setAttribute('aRipple', new BufferAttribute(new Float32Array(ripple), 3));
  const rippleNormals = new Float32Array(rippleCount * 3);
  for (let i = 0; i < rippleCount; i++) rippleNormals[i * 3 + 1] = 1;
  rippleGeometry.setAttribute('normal', new BufferAttribute(rippleNormals, 3));
  geometries.push(rippleGeometry);

  const rippleUniforms = { uTime: { value: 0 } };
  const rippleMaterial = new MeshBasicMaterial({ color: SURFACE.ink, side: DoubleSide });
  // The one live uniform, parked where the dev panel and the tests can read it
  // without the material pretending to be a ShaderMaterial.
  rippleMaterial.userData.rippleUniforms = rippleUniforms;
  rippleMaterial.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, rippleUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime;\nattribute vec3 aRipple;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float rippleSlide = sin(uTime * ${glslFloat(RIPPLE_OMEGA)} + aRipple.z) * ${glslFloat(RIPPLE_DRIFT)};
  transformed.x += aRipple.x * rippleSlide;
  transformed.z += aRipple.y * rippleSlide;
}`,
      );
  };
  rippleMaterial.customProgramCacheKey = (): string => 'water-ripple-drift-v1';
  materials.push(rippleMaterial);
  const rippleMesh = new Mesh(rippleGeometry, rippleMaterial);
  rippleMesh.name = 'ripples';
  rippleMesh.position.y = RIPPLE_LIFT;
  group.add(rippleMesh);

  return {
    group,
    update: (nowMs: number): void => {
      // A sine of wall-clock time: continuous, unbounded, and identical on
      // every device — no integration, so a dropped frame cannot make the
      // surface jump.
      rippleUniforms.uTime.value = nowMs / 1000;
    },
    fills: (): [number, number][][] => fillPolys.map((poly) => poly.map((p) => [p[0], p[1]])),
    dispose: (): void => {
      group.clear();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
