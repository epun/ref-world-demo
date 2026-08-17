/**
 * Kinematic resolution (src/physics/resolve.ts) — pure tests.
 *
 * Hard resolve: push-out to exact contact (never past it — a positional
 * overshoot would read as bounce, forbidden at confidence 1.00), inward
 * velocity removed, tangential velocity preserved bit-for-bit, corners clean
 * after the standard two passes. Soft: the damping factor and deepest-
 * overlap pick. Separation: mutual, symmetric, overlap capped at ~40%.
 */

import { describe, expect, it } from 'vitest';
import { makeRand } from '../../src/behavior/states';
import type { Collider } from '../../src/physics/colliders';
import {
  deepestSoftOverlap,
  MAX_CREATURE_OVERLAP,
  RESOLVE_SKIN,
  resolveHard,
  separationOffsets,
  SOFT_SPEED_FACTOR,
  type KinematicBody,
} from '../../src/physics/resolve';

const R = 0.5; // creature body radius used throughout

function penetration(body: KinematicBody, r: number, c: Collider): number {
  return r + c.r - Math.hypot(body.x - c.x, body.z - c.z);
}

describe('resolveHard', () => {
  it('pushes out along the normal to contact — never short, never a rebound', () => {
    const c: Collider = { x: 0, z: 0, r: 1, hard: true };
    const body: KinematicBody = { x: 0.5, z: 0, vx: 0, vz: 0 };
    expect(resolveHard(body, R, [c])).toBe(true);
    // On the contact circle (r + c.r = 1.5) plus at most the 1mm skin —
    // a rebound would land far past it.
    const d = Math.hypot(body.x, body.z);
    expect(d).toBeGreaterThanOrEqual(1.5);
    expect(d).toBeLessThanOrEqual(1.5 + RESOLVE_SKIN + 1e-9);
    expect(body.z).toBeCloseTo(0, 9);
  });

  it('removes the inward normal velocity and preserves the tangential exactly', () => {
    const c: Collider = { x: 0, z: 0, r: 1, hard: true };
    const body: KinematicBody = { x: 1.2, z: 0, vx: -1, vz: 0.5 };
    resolveHard(body, R, [c]);
    // Normal is +x: the -1 inward component is gone, the 0.5 tangent stays.
    expect(body.vx).toBe(0);
    expect(body.vz).toBe(0.5);
  });

  it('leaves an outward-moving velocity untouched (slide, not stick)', () => {
    const c: Collider = { x: 0, z: 0, r: 1, hard: true };
    const body: KinematicBody = { x: 1.2, z: 0, vx: 0.8, vz: -0.3 };
    resolveHard(body, R, [c]);
    expect(body.vx).toBe(0.8);
    expect(body.vz).toBe(-0.3);
  });

  it('ignores soft colliders and non-overlapping circles', () => {
    const soft: Collider = { x: 0, z: 0, r: 2, hard: false };
    const far: Collider = { x: 10, z: 10, r: 1, hard: true };
    const body: KinematicBody = { x: 0.1, z: 0, vx: -1, vz: 0 };
    expect(resolveHard(body, R, [soft, far])).toBe(false);
    expect(body).toEqual({ x: 0.1, z: 0, vx: -1, vz: 0 });
  });

  it('resolves a corner (two circles) with no residual penetration', () => {
    const a: Collider = { x: 0, z: -0.9, r: 1, hard: true };
    const b: Collider = { x: 0, z: 0.9, r: 1, hard: true };
    const body: KinematicBody = { x: 0.6, z: 0.1, vx: -1, vz: 0 };
    resolveHard(body, R, [a, b]);
    expect(penetration(body, R, a)).toBeLessThanOrEqual(1e-9);
    expect(penetration(body, R, b)).toBeLessThanOrEqual(1e-9);
    // Slide only removes velocity — it never adds any (no bounce energy).
    expect(Math.hypot(body.vx, body.vz)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('fuzz: seeded overlap pairs always end penetration-free (200 rolls)', () => {
    const rand = makeRand(2026);
    for (let i = 0; i < 200; i++) {
      const a: Collider = { x: (rand() - 0.5) * 4, z: (rand() - 0.5) * 4, r: 0.5 + rand(), hard: true };
      // Second circle offset so a corner pocket forms but stays escapable.
      const angle = rand() * Math.PI * 2;
      const gap = a.r + 0.5 + rand() * 1.5;
      const b: Collider = {
        x: a.x + Math.cos(angle) * gap,
        z: a.z + Math.sin(angle) * gap,
        r: 0.5 + rand(),
        hard: true,
      };
      const body: KinematicBody = {
        x: a.x + (rand() - 0.5) * 2 * a.r,
        z: a.z + (rand() - 0.5) * 2 * a.r,
        vx: (rand() - 0.5) * 2,
        vz: (rand() - 0.5) * 2,
      };
      resolveHard(body, R, [a, b]);
      expect(penetration(body, R, a)).toBeLessThanOrEqual(1e-9);
      expect(penetration(body, R, b)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('dead-center overlap resolves deterministically (+x)', () => {
    const c: Collider = { x: 2, z: 3, r: 1, hard: true };
    const body: KinematicBody = { x: 2, z: 3, vx: 0, vz: 0 };
    resolveHard(body, R, [c]);
    expect(body.x).toBeCloseTo(2 + 1.5 + RESOLVE_SKIN, 9);
    expect(body.z).toBeCloseTo(3, 9);
  });
});

describe('soft bodies', () => {
  it('damps ~55% off the ground speed', () => {
    expect(SOFT_SPEED_FACTOR).toBeCloseTo(0.45);
  });

  it('deepestSoftOverlap picks the deepest soft circle and ignores hard ones', () => {
    const shallow: Collider = { x: 1.3, z: 0, r: 1, hard: false };
    const deep: Collider = { x: 0.2, z: 0, r: 1, hard: false };
    const hard: Collider = { x: 0, z: 0.1, r: 1, hard: true };
    expect(deepestSoftOverlap(0, 0, R, [shallow, deep, hard])).toBe(deep);
    expect(deepestSoftOverlap(10, 0, R, [shallow, deep, hard])).toBeNull();
  });
});

describe('separationOffsets — creatures brush past, never stack', () => {
  it('returns null when circles do not overlap', () => {
    expect(separationOffsets(0, 0, 1, 3, 0, 1, 16)).toBeNull();
  });

  it('is mutual and symmetric (half each, opposite signs)', () => {
    const off = separationOffsets(0, 0, 1, 0.4, 0, 1, 16)!;
    expect(off.ax).toBeCloseTo(-off.bx, 12);
    expect(off.az).toBeCloseTo(-off.bz, 12);
    expect(off.ax).toBeLessThan(0); // a is left of b: pushed further left
  });

  it('caps overlap at MAX_CREATURE_OVERLAP immediately', () => {
    const ar = 1;
    const br = 1;
    const sum = ar + br;
    // Deep stack: 90% overlap.
    const off = separationOffsets(0, 0, ar, 0.2, 0, br, 16)!;
    const d = Math.hypot(0 + off.ax - (0.2 + off.bx), off.az - off.bz);
    const pen = sum - d;
    expect(pen).toBeLessThanOrEqual(MAX_CREATURE_OVERLAP * sum + 1e-9);
  });

  it('relaxes the remaining overlap out over repeated frames (no snap)', () => {
    let ax = 0;
    let bx = 1.4; // overlap 0.6 of sum 2 — under the 0.8 cap, soft path only
    const singleFramePush = separationOffsets(ax, 0, 1, bx, 0, 1, 16)!;
    // One frame moves a small fraction, not the whole overlap: a drift.
    expect(Math.abs(singleFramePush.ax)).toBeLessThan(0.1);
    for (let i = 0; i < 400; i++) {
      const off = separationOffsets(ax, 0, 1, bx, 0, 1, 16);
      if (!off) break;
      ax += off.ax;
      bx += off.bx;
    }
    expect(bx - ax).toBeGreaterThan(1.9); // essentially separated
  });

  it('splits a dead-center stack deterministically', () => {
    const a = separationOffsets(1, 1, 0.8, 1, 1, 0.8, 16)!;
    const b = separationOffsets(1, 1, 0.8, 1, 1, 0.8, 16)!;
    expect(a).toEqual(b);
    expect(a.ax).toBeGreaterThan(0); // +x split
  });

  it('writes into the provided out object (allocation-free path)', () => {
    const out = { ax: 0, az: 0, bx: 0, bz: 0 };
    const res = separationOffsets(0, 0, 1, 0.5, 0, 1, 16, out);
    expect(res).toBe(out);
  });
});
