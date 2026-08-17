/**
 * Teddy-style inflation (PLAN §3.3, simplified Igarashi '99): the smoothed
 * contour is triangulated, and every interior vertex is displaced along ±z by
 * a sqrt profile of the distance transform — `z = depthScale · sqrt(dt · dtMax)`,
 * so z ∝ sqrt(dt) with the peak at ≈ depthScale · dtMax. The sqrt is the
 * pillowy spherical cross-section; linear would read as an origami cone-tent
 * and violate "organic or softened".
 *
 * Triangulation choice (the plan allows either grid-stitching or earcut +
 * refinement): the contour polygon is ear-clipped for connectivity, then
 * refined by iterative conforming midpoint bisection — every edge longer than
 * `gridStep` is split at its midpoint and each triangle is re-emitted against
 * its split edges. Because the split criterion is a pure function of the edge,
 * both triangles sharing an edge always agree, so the mesh stays crack-free
 * (no T-junctions) with no constrained-triangulation machinery. This was
 * chosen over a clipped interior grid + boundary stitching because stitching
 * an arbitrary grid boundary to the contour is fragile for concave shapes,
 * while edge bisection is robust for any simple polygon and trivially
 * deterministic. Interior vertices land on chord-bisection points rather than
 * a regular lattice, but their spacing is ≤ gridStep, which is all the
 * sampling contract requires.
 *
 * The head-on silhouette invariant (CLAUDE.md): rim vertices are the contour
 * points themselves, pinned to z = 0 exactly and shared by the front and back
 * sheets (welded — each rim vertex appears once). Midpoints created on rim
 * edges are also pinned to the rim, so refinement can never open a crack or
 * move the silhouette.
 *
 * Pure module: no Three.js, no DOM, no Math.random, no Date.
 */

import type { DistanceField, ShapeAnalysis } from '../shape/types';
import { earcut } from './earcut';
import type { InflatedMesh, InflateOptions } from './types';

/** Vertex-pair edge key. Vertex counts stay far below 2^21. */
const KEY = 0x200000; // 2^21

/** Refinement guards: passes halve the longest edge, so 16 is generous. */
const MAX_PASSES = 16;
const MAX_VERTS = 262144;

function edgeKey(a: number, b: number): number {
  return a < b ? a * KEY + b : b * KEY + a;
}

/** Bilinear sample of the distance field at continuous pixel coordinates. */
function sampleDistance(field: DistanceField, x: number, y: number): number {
  const s = field.size;
  const cx = Math.min(Math.max(x, 0), s - 1);
  const cy = Math.min(Math.max(y, 0), s - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, s - 1);
  const y1 = Math.min(y0 + 1, s - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const d = field.data;
  const d00 = d[y0 * s + x0]!;
  const d10 = d[y0 * s + x1]!;
  const d01 = d[y1 * s + x0]!;
  const d11 = d[y1 * s + x1]!;
  const top = d00 + (d10 - d00) * fx;
  const bot = d01 + (d11 - d01) * fx;
  return top + (bot - top) * fy;
}

/**
 * Re-emit one triangle against the midpoints created this pass (−1 = edge not
 * split). Orientation of every child matches the parent.
 */
function emitSplit(
  out: number[],
  a: number,
  b: number,
  c: number,
  mab: number,
  mbc: number,
  mca: number,
  xs: number[],
  ys: number[],
): void {
  const count = (mab >= 0 ? 1 : 0) + (mbc >= 0 ? 1 : 0) + (mca >= 0 ? 1 : 0);
  if (count === 0) {
    out.push(a, b, c);
    return;
  }
  if (count === 3) {
    out.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca);
    return;
  }
  if (count === 1) {
    if (mab >= 0) out.push(a, mab, c, mab, b, c);
    else if (mbc >= 0) out.push(b, mbc, a, mbc, c, a);
    else out.push(c, mca, b, mca, a, b);
    return;
  }
  // Two split edges: rotate (a, b, c) so the unsplit edge is c→a, with m1 on
  // a→b and m2 on b→c.
  let A = a, B = b, C = c, m1 = mab, m2 = mbc;
  if (mab < 0) {
    A = b; B = c; C = a; m1 = mbc; m2 = mca;
  } else if (mbc < 0) {
    A = c; B = a; C = b; m1 = mca; m2 = mab;
  }
  out.push(m1, B, m2);
  // Quad (A, m1, m2, C): split along the shorter diagonal, ties toward A–m2.
  const dA = (xs[A]! - xs[m2]!) ** 2 + (ys[A]! - ys[m2]!) ** 2;
  const dM = (xs[m1]! - xs[C]!) ** 2 + (ys[m1]! - ys[C]!) ** 2;
  if (dA <= dM) out.push(A, m1, m2, A, m2, C);
  else out.push(A, m1, C, m1, m2, C);
}

/**
 * Inflate a shape analysis into a closed, welded, outward-wound triangle
 * mesh. Coordinates: x right, y up (mask rows are y-down, so y is flipped),
 * z toward the viewer for the front sheet; centered on the ink bounds and
 * scaled by 1/maskSize so the result is roughly unit-sized.
 */
export function inflate(analysis: ShapeAnalysis, opts: InflateOptions = {}): InflatedMesh {
  const depthScale = opts.depthScale ?? 0.9;
  const gridStep = opts.gridStep ?? 6;
  const contour = analysis.contour;
  const size = analysis.mask.size;

  // --- 2D vertex set, seeded with the rim (the contour itself) -------------
  const nRim = contour.length;
  const xs: number[] = new Array<number>(nRim);
  const ys: number[] = new Array<number>(nRim);
  const rim: boolean[] = new Array<boolean>(nRim);
  for (let i = 0; i < nRim; i++) {
    const p = contour[i]!;
    xs[i] = p.x;
    ys[i] = p.y;
    rim[i] = true;
  }

  let tris = earcut(contour);
  if (tris.length === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  // Rim edges (consecutive contour points). Midpoints born on these stay rim.
  const boundary = new Set<number>();
  for (let i = 0; i < nRim; i++) boundary.add(edgeKey(i, (i + 1) % nRim));

  // --- Conforming midpoint refinement --------------------------------------
  const maxLen2 = gridStep * gridStep;
  for (let pass = 0; pass < MAX_PASSES && xs.length <= MAX_VERTS; pass++) {
    const mids = new Map<number, number>();
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const u = tris[t + e]!;
        const v = tris[t + ((e + 1) % 3)]!;
        const k = edgeKey(u, v);
        if (mids.has(k)) continue;
        const dx = xs[u]! - xs[v]!;
        const dy = ys[u]! - ys[v]!;
        if (dx * dx + dy * dy <= maxLen2) continue;
        const m = xs.length;
        xs.push((xs[u]! + xs[v]!) * 0.5);
        ys.push((ys[u]! + ys[v]!) * 0.5);
        const onRim = boundary.has(k);
        rim.push(onRim);
        if (onRim) {
          boundary.delete(k);
          boundary.add(edgeKey(u, m));
          boundary.add(edgeKey(m, v));
        }
        mids.set(k, m);
      }
    }
    if (mids.size === 0) break;
    const next: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]!;
      const b = tris[t + 1]!;
      const c = tris[t + 2]!;
      emitSplit(
        next,
        a, b, c,
        mids.get(edgeKey(a, b)) ?? -1,
        mids.get(edgeKey(b, c)) ?? -1,
        mids.get(edgeKey(c, a)) ?? -1,
        xs, ys,
      );
    }
    tris = next;
  }

  // --- Inflation profile ----------------------------------------------------
  // z = depthScale · sqrt(dt / dtMax) · dtMax = depthScale · sqrt(dt · dtMax):
  // z ∝ sqrt(dt), peaking at ≈ depthScale · dtMax where dt = dtMax. Rim
  // vertices are pinned to exactly 0 so the head-on silhouette is the drawing.
  const nFront = xs.length;
  const dtMax = Math.max(analysis.distance.max, 1e-6);
  const z = new Float64Array(nFront);
  for (let i = 0; i < nFront; i++) {
    if (rim[i]) continue;
    const dt = Math.max(0, sampleDistance(analysis.distance, xs[i]!, ys[i]!));
    z[i] = depthScale * Math.sqrt(dt * dtMax);
  }

  // --- Mirror: back sheet shares the rim ring (weld) ------------------------
  const backIndex = new Int32Array(nFront);
  let nBack = 0;
  for (let i = 0; i < nFront; i++) {
    backIndex[i] = rim[i]! ? i : nFront + nBack++;
  }
  const totalV = nFront + nBack;

  // --- World transform: center on ink bounds, flip y up, scale to ~unit ----
  const cx = (analysis.bounds.minX + analysis.bounds.maxX) / 2;
  const cy = (analysis.bounds.minY + analysis.bounds.maxY) / 2;
  const inv = 1 / size;
  const positions = new Float32Array(totalV * 3);
  for (let i = 0; i < nFront; i++) {
    const wx = (xs[i]! - cx) * inv;
    const wy = (cy - ys[i]!) * inv; // y_world = (size − y_px) − (size − cy)
    const wz = z[i]! * inv;
    positions[i * 3] = wx;
    positions[i * 3 + 1] = wy;
    positions[i * 3 + 2] = wz;
    if (!rim[i]!) {
      const j = backIndex[i]! * 3;
      positions[j] = wx;
      positions[j + 1] = wy;
      positions[j + 2] = -wz;
    }
  }

  // --- Indices --------------------------------------------------------------
  // The pixel-space triangulation is positively wound in y-down coordinates;
  // the y flip mirrors orientation, so the front sheet reverses index order
  // to face +z, and the back sheet (mirrored again in z) keeps it to face −z.
  // The result is a closed manifold with consistent outward winding.
  const nTri = tris.length / 3;
  const indices = new Uint32Array(nTri * 6);
  let w = 0;
  for (let t = 0; t < tris.length; t += 3) {
    indices[w++] = tris[t]!;
    indices[w++] = tris[t + 2]!;
    indices[w++] = tris[t + 1]!;
  }
  for (let t = 0; t < tris.length; t += 3) {
    indices[w++] = backIndex[tris[t]!]!;
    indices[w++] = backIndex[tris[t + 1]!]!;
    indices[w++] = backIndex[tris[t + 2]!]!;
  }

  // --- Smooth normals: accumulate area-weighted face normals ---------------
  const acc = new Float64Array(totalV * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 3;
    const ib = indices[t + 1]! * 3;
    const ic = indices[t + 2]! * 3;
    const ax = positions[ia]!, ay = positions[ia + 1]!, az = positions[ia + 2]!;
    const e1x = positions[ib]! - ax, e1y = positions[ib + 1]! - ay, e1z = positions[ib + 2]! - az;
    const e2x = positions[ic]! - ax, e2y = positions[ic + 1]! - ay, e2z = positions[ic + 2]! - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    acc[ia] = acc[ia]! + nx; acc[ia + 1] = acc[ia + 1]! + ny; acc[ia + 2] = acc[ia + 2]! + nz;
    acc[ib] = acc[ib]! + nx; acc[ib + 1] = acc[ib + 1]! + ny; acc[ib + 2] = acc[ib + 2]! + nz;
    acc[ic] = acc[ic]! + nx; acc[ic + 1] = acc[ic + 1]! + ny; acc[ic + 2] = acc[ic + 2]! + nz;
  }
  const normals = new Float32Array(totalV * 3);
  for (let i = 0; i < totalV; i++) {
    const nx = acc[i * 3]!, ny = acc[i * 3 + 1]!, nz = acc[i * 3 + 2]!;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    } else {
      normals[i * 3 + 2] = 1;
    }
  }

  return { positions, normals, indices };
}
