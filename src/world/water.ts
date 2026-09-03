/**
 * Water (PLAN §7 world, geography from src/world/landscape.ts): four small
 * ponds and one lake with an island, drawn the way the reference draws water —
 * one flat value, a rough drawn shoreline, a few sparse ripple marks, and a
 * great deal of empty surface between them (TASTE §2.3).
 *
 * WHY THE SHORELINE IS ITS OWN MESH. The ground is unlit and — inside a basin —
 * dead flat, and the ink composite only draws a contour where depth or the
 * normal target breaks. A flat polygon a hair above flat ground breaks
 * neither, so left to the pass the water would be a value with no edge — a
 * stain, not a pond. The shore is therefore drawn: an ink ribbon walked around
 * each of the body's shorelines, with a pen's varying width and an occasional
 * lifted segment. Same reason the ripples are geometry and not a texture.
 *
 * A LAKE HAS TWO SHORES. Its fill is the outer outline with the island
 * punched out of it as a HOLE, and it carries two ribbons: one round the
 * outer shore, one round the island. Both rings wind the same way, so the
 * pen's offset flips sign between them — the outer ribbon's water side is
 * inward, the island ribbon's is outward — and each ring is the one polygon
 * its own fill edge is built from, so the grey and the ink coincide by
 * construction rather than by matching sample counts (the lesson of the
 * causeway strip that used to run between them).
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
  Path,
  Shape,
  ShapeGeometry,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import {
  ISLAND_OUTLINE_POINTS,
  OUTLINE_POINTS,
  RIPPLE_MARGIN,
  WATER_BODIES,
  islandOutline,
  isWater,
  rippleSpots,
  waterLevel,
  waterOutline,
  type RippleSpot,
  type WaterBody,
} from './landscape';

// ── lifts [D] ────────────────────────────────────────────────────────────────
// Three hairs above the paper, in drawing order, and all of them UNDER the
// scatter's ticks (0.015) and prop stamps (0.018) and under the creature
// shadows (0.02) — so a creature walking the shore still casts its flat stamp
// across the water instead of being erased by it.
//
// The paper they sit on is the BODY'S OWN water level, not y=0: a basin sinks
// its whole disc to one number (landscape's `waterLevel`), so each body's
// sheets ride that number plus its lift. `waterLevel` is the one height this
// file reads directly — it is not a ground height at all but the flat the
// geography authored for the body, and the terrain is built to meet it.

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
 * whole loop is sampled at one density — and so the fill edge and the pen
 * line can share ONE array of points whatever shape the geography hands over.
 *
 * A no-op for every ring the map currently authors (they are all evenly
 * sampled), and kept for the guarantee rather than the cuts: a polygon with
 * one long leg in it would otherwise draw that leg as a single quad — a
 * ruled line with no width variation, one roll of the pen-lift hash away
 * from vanishing whole. The threshold is the polygon's own median segment,
 * so it self-tunes per body.
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
 * Every ring the geography hands over is counter-clockwise, so `(dz, −dx)` is
 * its outward normal — which points AWAY from the water on an outer shore and
 * INTO it on an island's. `towardWater` is that one bit: −1 for a ring the
 * water is inside of, +1 for a ring the water is outside of. It only steers
 * the probe below; the stroke itself straddles the line either way.
 */
function ribbonGeometry(
  poly: readonly Point[],
  seed: number,
  towardWater: -1 | 1,
): BufferGeometry {
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
  y: number,
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
      // The mark's height is BAKED into the vertex: every body's marks share
      // one buffer and one mesh, and the bodies sit at different levels, so
      // the mesh itself cannot carry the lift.
      positions.push(x, y, z);
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
  /**
   * The OUTER polygon each body's water is built from, in world x/z — the
   * fill edge and the shoreline both ride these exact points. Copies, per
   * call. A lake's fill also has a hole in it, which is not returned here:
   * it is `islandOutline(body)` from the geography, densified the same way,
   * and it carries its own ribbon.
   *
   * x/z only, and that is not a loss: a body's surface is one flat sheet at
   * its own `waterLevel`, so the height is a single number per body that
   * landscape already answers for.
   *
   * NOT what the minimap draws: at map scale a body is a few dozen pixels
   * across, so it re-derives the cheap 96-point outline from the geography
   * instead of carrying a thousand points per body for a sub-pixel gain.
   */
  fills(): [number, number][][];
  /**
   * Re-seat every sheet on its body's `waterLevel` as it now stands — for
   * when the live terrain dials have moved (landscape's `setTerrainParams`,
   * driven by WorldHandles.setTerrain).
   *
   * The GEOGRAPHY does not move: a body's outline, its shore ribbon and its
   * ripple marks are functions of x/z alone and the dials are heights and
   * horizontal scales of the LAND. So the fills and the shores just take a
   * new y, and the ripple buffer — which bakes each mark's height into its
   * vertices, because every body shares one mesh — has its y column
   * rewritten per body.
   */
  refreshLevels(): void;
  dispose(): void;
}

export function createWater(): Water {
  const group = new Group();
  group.name = 'water';

  const geometries: BufferGeometry[] = [];
  const materials: MeshBasicMaterial[] = [];

  // ── the outlines ──────────────────────────────────────────────────────────
  // ONE polygon per shoreline, shared by the fill edge it cuts and the pen
  // line that draws it. It has to be the same array for both, sampled once at
  // the ribbon's density: a fill sampled coarsely and a ribbon sampled finely
  // sit a chord's sagitta apart on every wobble, which shows as a hair of bare
  // paper between the grey and the ink.
  const outlines = WATER_BODIES.map((body) =>
    densify(waterOutline(body, OUTLINE_POINTS * SHORE_SUBDIVISION)),
  );
  // …and the island's, for the lake: the hole in its fill and a second shore.
  const islands = WATER_BODIES.map((body) => {
    const poly = islandOutline(body, ISLAND_OUTLINE_POINTS * SHORE_SUBDIVISION);
    return poly ? densify(poly) : null;
  });

  // ── the flat value ────────────────────────────────────────────────────────
  // One unlit polygon per body, with a hole in it where the lake's island
  // stands: earcut triangulates around the hole and invents no points, so the
  // sheet's vertices are exactly the two rings'.
  // DoubleSide: a flat sheet has no back to save, and this means a zero-area
  // sliver — whose winding is float noise — can never become a culled hole in
  // the water if the geography is ever re-authored.
  const fillMaterial = new MeshBasicMaterial({ color: WORLD.neutralMid, side: DoubleSide });
  materials.push(fillMaterial);
  /** A ring in shape space: built in (x, −z) and laid flat by a −90° turn
   * about x, which maps (x, y, 0) → (x, 0, −y) — the shape's y comes back as
   * world z, and its +z normal comes back pointing up. */
  const trace = <T extends Shape | Path>(into: T, poly: readonly Point[]): T => {
    into.moveTo(poly[0]![0], -poly[0]![1]);
    for (let i = 1; i < poly.length; i++) into.lineTo(poly[i]![0], -poly[i]![1]);
    into.closePath();
    return into;
  };
  /** Every sheet that rides a body's level, and which body it belongs to —
   * the list `refreshLevels` walks. */
  const sheets: { mesh: Mesh; body: WaterBody; lift: number }[] = [];
  WATER_BODIES.forEach((body: WaterBody, index: number) => {
    const shape = trace(new Shape(), outlines[index]!);
    const island = islands[index];
    if (island) shape.holes.push(trace(new Path(), island));
    const geometry = new ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
    geometries.push(geometry);
    const mesh = new Mesh(geometry, fillMaterial);
    mesh.name = `water-${body.kind}-${index}`;
    mesh.position.y = waterLevel(body) + WATER_LIFT;
    sheets.push({ mesh, body, lift: WATER_LIFT });
    group.add(mesh);
  });

  // ── the drawn shores ──────────────────────────────────────────────────────
  // One ribbon per shoreline, each walked around the very array its fill edge
  // was cut from — a pond has one, the lake has its outer shore and its
  // island's. The island's is seeded off the island so its pen lifts in
  // different places than the shore across the water from it.
  const shoreMaterial = new MeshBasicMaterial({ color: SURFACE.ink, side: DoubleSide });
  materials.push(shoreMaterial);
  const addShore = (
    name: string,
    poly: readonly Point[],
    seed: number,
    towardWater: -1 | 1,
    body: WaterBody,
  ): void => {
    const geometry = ribbonGeometry(poly, seed, towardWater);
    geometries.push(geometry);
    const mesh = new Mesh(geometry, shoreMaterial);
    mesh.name = name;
    mesh.position.y = waterLevel(body) + SHORE_LIFT;
    sheets.push({ mesh, body, lift: SHORE_LIFT });
    group.add(mesh);
  };
  WATER_BODIES.forEach((body: WaterBody, index: number) => {
    // The water is INSIDE the outer ring, and OUTSIDE the island's.
    addShore(`shore-${body.kind}-${index}`, outlines[index]!, body.seed, -1, body);
    const island = islands[index];
    if (island) addShore(`shore-island-${index}`, island, body.island!.seed, 1, body);
  });

  // ── ripple marks ──────────────────────────────────────────────────────────
  // Every mark of every body in ONE buffer with ONE material: the marks never
  // move relative to each other on the cpu, and the drift is a vertex shader
  // away, so this is a single draw call for the whole water surface.
  const positions: number[] = [];
  const ripple: number[] = [];
  /** Which slice of the one shared ripple buffer belongs to which body —
   * `refreshLevels` rewrites the y column of each slice. */
  const rippleRanges: { body: WaterBody; start: number; end: number }[] = [];
  for (const body of WATER_BODIES) {
    const margin = body.kind === 'pond' ? POND_RIPPLE_MARGIN : RIPPLE_MARGIN;
    const y = waterLevel(body) + RIPPLE_LIFT;
    const start = positions.length / 3;
    for (const spot of rippleSpots(body, margin)) {
      const phase = hash(body.seed + spot.x * 3.7 + spot.z * 5.3) * Math.PI * 2;
      emitArc(positions, ripple, spot, spot.len, 0, phase, y);
      emitArc(
        positions,
        ripple,
        spot,
        spot.len * RIPPLE_SECOND_SCALE,
        RIPPLE_SECOND_OFFSET,
        phase,
        y,
      );
    }
    rippleRanges.push({ body, start, end: positions.length / 3 });
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
  // Left at 0 on purpose: the lift is already in the vertices, per body.
  rippleMesh.position.y = 0;
  group.add(rippleMesh);

  return {
    group,
    update: (nowMs: number): void => {
      // A sine of wall-clock time: continuous, unbounded, and identical on
      // every device — no integration, so a dropped frame cannot make the
      // surface jump.
      rippleUniforms.uTime.value = nowMs / 1000;
    },
    fills: (): [number, number][][] => outlines.map((poly) => poly.map((p) => [p[0], p[1]])),
    refreshLevels: (): void => {
      for (const sheet of sheets) sheet.mesh.position.y = waterLevel(sheet.body) + sheet.lift;
      const attr = rippleGeometry.getAttribute('position') as BufferAttribute;
      for (const range of rippleRanges) {
        const y = waterLevel(range.body) + RIPPLE_LIFT;
        for (let i = range.start; i < range.end; i++) attr.setY(i, y);
      }
      attr.needsUpdate = true;
    },
    dispose: (): void => {
      group.clear();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
