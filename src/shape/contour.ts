/**
 * Boundary extraction and softening:
 *   marching squares → Ramer–Douglas–Peucker → uniform resample → Chaikin.
 *
 * The Chaikin pass is the hard constraint "no rectilinear geometry with hard
 * edges" (confidence 1.00, both briefs) enforced in code: whatever polygonal
 * artifacts rasterization introduced, corners are cut before anything
 * downstream sees the contour.
 */

import type { Contour, Mask, Point } from './types';

/**
 * Trace the outer boundary of the (single-component) mask with Moore
 * neighborhood tracing. Returns a closed contour in pixel space.
 */
export function traceContour(mask: Mask): Contour {
  const { size, data } = mask;
  const at = (x: number, y: number): number =>
    x >= 0 && x < size && y >= 0 && y < size ? data[y * size + x]! : 0;

  // Find the topmost-leftmost ink pixel.
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (at(x, y) === 1) { sx = x; sy = y; break outer; }
    }
  }
  if (sx < 0) return [];

  // Moore neighborhood, clockwise from west.
  const nbr = [
    [-1, 0], [-1, -1], [0, -1], [1, -1],
    [1, 0], [1, 1], [0, 1], [-1, 1],
  ] as const;

  const contour: Contour = [];
  let cx = sx, cy = sy;
  let backtrack = 0; // came from west
  const maxSteps = size * size;
  for (let step = 0; step < maxSteps; step++) {
    contour.push({ x: cx, y: cy });
    let found = false;
    // Start scanning from the neighbor after the backtrack direction.
    for (let i = 0; i < 8; i++) {
      const dir = (backtrack + 1 + i) % 8;
      const [dx, dy] = nbr[dir]!;
      const nx = cx + dx, ny = cy + dy;
      if (at(nx, ny) === 1) {
        // New backtrack points from the new pixel toward the previous one.
        backtrack = (dir + 4) % 8;
        cx = nx; cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel
    if (cx === sx && cy === sy) break; // closed the loop
  }
  return contour;
}

/** Perpendicular distance from p to segment ab. */
function perpDist(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len = Math.hypot(abx, aby);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * aby - (p.y - a.y) * abx) / len;
}

/** Ramer–Douglas–Peucker on an open polyline. */
function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.slice();
  const first = points[0]!, last = points[points.length - 1]!;
  let maxD = 0, maxI = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i]!, first, last);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD <= epsilon) return [first, last];
  const left = rdp(points.slice(0, maxI + 1), epsilon);
  const right = rdp(points.slice(maxI), epsilon);
  return left.slice(0, -1).concat(right);
}

/** Simplify a closed contour with RDP, splitting at the two farthest-apart points. */
export function simplify(contour: Contour, epsilon = 1.5): Contour {
  if (contour.length < 8) return contour.slice();
  // Split at index 0 and the point farthest from it, run RDP on both halves.
  let farI = 0, farD = 0;
  const p0 = contour[0]!;
  for (let i = 1; i < contour.length; i++) {
    const d = Math.hypot(contour[i]!.x - p0.x, contour[i]!.y - p0.y);
    if (d > farD) { farD = d; farI = i; }
  }
  const a = rdp(contour.slice(0, farI + 1), epsilon);
  const b = rdp(contour.slice(farI).concat([p0]), epsilon);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/** Total perimeter of a closed contour. */
function perimeter(c: Contour): number {
  let p = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i]!, b = c[(i + 1) % c.length]!;
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

/** Resample a closed contour to n uniformly spaced points. */
export function resample(contour: Contour, n = 120): Contour {
  if (contour.length < 3) return contour.slice();
  const total = perimeter(contour);
  const step = total / n;
  const out: Contour = [];
  let acc = 0;
  let i = 0;
  let a = contour[0]!;
  let b = contour[1 % contour.length]!;
  let segLen = Math.hypot(b.x - a.x, b.y - a.y);
  let segPos = 0;
  out.push({ x: a.x, y: a.y });
  for (let k = 1; k < n; k++) {
    const target = k * step;
    while (acc + (segLen - segPos) < target) {
      acc += segLen - segPos;
      i++;
      a = contour[i % contour.length]!;
      b = contour[(i + 1) % contour.length]!;
      segLen = Math.hypot(b.x - a.x, b.y - a.y);
      segPos = 0;
    }
    const need = target - acc;
    const t = segLen < 1e-9 ? 0 : (segPos + need) / segLen;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    segPos += need;
    acc = target;
  }
  return out;
}

/**
 * One pass of Chaikin corner cutting on a closed contour. Two passes are the
 * default softening; each pass doubles point count, so run on the simplified
 * contour before resampling to the final density.
 */
export function chaikin(contour: Contour, passes = 2): Contour {
  let pts = contour;
  for (let p = 0; p < passes; p++) {
    const next: Contour = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    pts = next;
  }
  return pts;
}

/** RDP on an OPEN polyline — endpoints always survive. The §1a
 * corner-preserving chain runs this on the runs BETWEEN pinned corners. */
export function simplifyOpen(points: Point[], epsilon: number): Point[] {
  return rdp(points, epsilon);
}

/**
 * Endpoint-preserving Chaikin on an open polyline: interior corners are cut,
 * the first and last points stay exactly where they are. This is how a
 * pinned corner keeps its full turning angle while the run between corners
 * softens (GENERATOR §1a: "softened by hand-wobble rather than rounded into
 * a blob").
 */
export function chaikinOpen(points: Point[], passes = 2): Point[] {
  let pts = points;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) break;
    const next: Point[] = [pts[0]!];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (i > 0) next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      if (i < pts.length - 2) {
        next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
    }
    next.push(pts[pts.length - 1]!);
    pts = next;
  }
  return pts;
}

/** Resample an open polyline to n points, endpoints preserved exactly. */
export function resampleOpen(points: Point[], n: number): Point[] {
  if (points.length < 2 || n < 2) return points.slice();
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
  }
  const out: Point[] = [{ x: points[0]!.x, y: points[0]!.y }];
  if (total < 1e-9) {
    for (let k = 1; k < n; k++) out.push({ x: points[points.length - 1]!.x, y: points[points.length - 1]!.y });
    return out;
  }
  const step = total / (n - 1);
  let seg = 0;
  let segPos = 0;
  let acc = 0;
  for (let k = 1; k < n - 1; k++) {
    const target = k * step;
    let a = points[seg]!;
    let b = points[seg + 1]!;
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    while (acc + (segLen - segPos) < target && seg < points.length - 2) {
      acc += segLen - segPos;
      seg++;
      segPos = 0;
      a = points[seg]!;
      b = points[seg + 1]!;
      segLen = Math.hypot(b.x - a.x, b.y - a.y);
    }
    const need = target - acc;
    const t = segLen < 1e-9 ? 0 : Math.min(1, (segPos + need) / segLen);
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    segPos += need;
    acc = target;
  }
  out.push({ x: points[points.length - 1]!.x, y: points[points.length - 1]!.y });
  return out;
}

/**
 * Corner detection on a closed contour (assumed roughly uniformly sampled):
 * the turning angle between the chords p[i−w]→p[i] and p[i]→p[i+w] is
 * measured at every point; local maxima above minAngle (radians), separated
 * by at least the window, are corners. Returns ascending indices, capped at
 * `max` strongest. Both convex and concave corners count — a drawn notch is
 * as much identity as a drawn shoulder.
 */
export function detectCorners(
  contour: Contour,
  window: number,
  minAngle: number,
  max = 12,
): number[] {
  const n = contour.length;
  if (n < 2 * window + 3) return [];
  const turn = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = contour[(i - window + n) % n]!;
    const b = contour[i]!;
    const c = contour[(i + window) % n]!;
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    turn[i] = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
  }
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) if (turn[i]! >= minAngle) candidates.push(i);
  candidates.sort((a, b) => turn[b]! - turn[a]! || a - b);
  const kept: number[] = [];
  const minSep = window;
  for (const i of candidates) {
    if (kept.length >= max) break;
    let clear = true;
    for (const k of kept) {
      const d = Math.abs(i - k);
      if (Math.min(d, n - d) < minSep) {
        clear = false;
        break;
      }
    }
    if (clear) kept.push(i);
  }
  kept.sort((a, b) => a - b);
  return kept;
}

/** Signed area (positive = counterclockwise in y-down pixel space). */
export function signedArea(c: Contour): number {
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i]!, b = c[(i + 1) % c.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
