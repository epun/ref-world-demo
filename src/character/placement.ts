/**
 * Eye placement — the pure mask→character-local mapping (PLAN §3.4).
 *
 * The inflater (src/inflate/inflate.ts) maps mask pixels into character-local
 * space as: center on the ink-bounds center, flip y up, scale by 1/maskSize,
 * and lift the front surface by z = depthScale · sqrt(dt · dtMax) · (1/size).
 * The eyes must ride that exact transform or they detach from the face, so
 * this module replicates it verbatim and is unit-tested against it.
 *
 * Pure module: no Three.js, no DOM, no Math.random, no Date — importable by
 * tests (and, later, the phone) without a renderer.
 */

import type { DistanceField, Point, ShapeAnalysis } from '../shape/types';

/**
 * Must equal the InflateOptions.depthScale default (inflate.ts). The
 * character is built with inflate(analysis) — no overrides — so the front
 * surface tops out at depthScale · dtMax mask pixels.
 */
export const EYE_DEPTH_SCALE = 0.9;

/** Half-separation of the eye pair, × the local half-thickness at the head lobe. */
export const EYE_SEPARATION = 0.55;

/** Eye mark radius, × the local half-thickness. Marks, not headlights. */
export const EYE_RADIUS = 0.26;

/** Outward epsilon, × the eye radius, so caps sit just proud of the surface. */
export const EYE_PROUD = 0.3;

/**
 * Bilinear sample of the distance field at continuous pixel coordinates.
 * Replicates inflate.ts's private sampleDistance so eye height and surface
 * height come from the identical reconstruction.
 */
export function sampleDistance(field: DistanceField, x: number, y: number): number {
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

export interface InkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Map a mask-space point (pixels, y-down) into character-local space
 * (unit-ish, y-up), exactly as the inflater does: centered on the ink-bounds
 * center, y flipped, scaled by 1/maskSize.
 */
export function maskToLocal(
  p: Point,
  bounds: InkBounds,
  maskSize: number,
): { x: number; y: number } {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const inv = 1 / maskSize;
  return { x: (p.x - cx) * inv, y: (cy - p.y) * inv };
}

/**
 * Front-surface height (character-local z) at a mask point — the inflation
 * profile z = depthScale · sqrt(dt · dtMax) · (1/size).
 */
export function surfaceZ(
  field: DistanceField,
  x: number,
  y: number,
  depthScale = EYE_DEPTH_SCALE,
): number {
  const dtMax = Math.max(field.max, 1e-6);
  const dt = Math.max(0, sampleDistance(field, x, y));
  return depthScale * Math.sqrt(dt * dtMax) * (1 / field.size);
}

export interface EyePlacement {
  /** Eye centers in character-local space (pre mesh scale), y up, z front. */
  left: { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  /** Eye mark radius, character-local units. */
  radius: number;
  /** Half-separation from the head-lobe axis, character-local units. */
  separation: number;
  /** Local half-thickness at the head lobe, character-local units. */
  thickness: number;
}

/**
 * Place the eye pair straddling the head lobe. Separation and size derive
 * from the head's local half-thickness (the distance field at the lobe);
 * each cap's depth is the front-surface height at its own mask position,
 * plus a small outward epsilon so it floats just proud of the body.
 */
export function computeEyePlacement(
  analysis: Pick<ShapeAnalysis, 'distance' | 'headLobe' | 'bounds'>,
  depthScale = EYE_DEPTH_SCALE,
): EyePlacement {
  const { distance, headLobe, bounds } = analysis;
  const inv = 1 / distance.size;

  // Half-thickness at the anchor, in mask pixels (guarded: a valid head lobe
  // always sits on positive DT, but degenerate fields must not zero the eyes).
  const thicknessPx = Math.max(sampleDistance(distance, headLobe.x, headLobe.y), 1);
  const sepPx = EYE_SEPARATION * thicknessPx;
  const radius = EYE_RADIUS * thicknessPx * inv;
  const proud = EYE_PROUD * radius;

  const eyeAt = (mx: number): { x: number; y: number; z: number } => {
    const local = maskToLocal({ x: mx, y: headLobe.y }, bounds, distance.size);
    return {
      x: local.x,
      y: local.y,
      z: surfaceZ(distance, mx, headLobe.y, depthScale) + proud,
    };
  };

  return {
    left: eyeAt(headLobe.x - sepPx),
    right: eyeAt(headLobe.x + sepPx),
    radius,
    separation: sepPx * inv,
    thickness: thicknessPx * inv,
  };
}
