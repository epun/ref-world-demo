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

/** Signed area (positive = counterclockwise in y-down pixel space). */
export function signedArea(c: Contour): number {
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i]!, b = c[(i + 1) % c.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
