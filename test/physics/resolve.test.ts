/**
 * Kinematic resolution (src/physics/resolve.ts) — pure tests.
 *
 * Hard resolve: push-out to exact contact (never past it — a positional
 * overshoot would read as bounce, forbidden at confidence 1.00), inward
 * velocity removed, tangential velocity preserved bit-for-bit, corners clean
 * after the standard two passes. Soft: the damping factor and deepest-
 * overlap pick. Separation: HARD, mutual, symmetric, iterated — creatures
 * never interpenetrate, and a head-on pair glides around instead of
 * stalling. stepCreatures: substepped integration so a clamped 250ms frame
 * can never tunnel a body through a collider.
 */

import { describe, expect, it } from 'vitest';
import { makeRand } from '../../src/behavior/states';
import type { Collider } from '../../src/physics/colliders';
import {
  deepestSoftOverlap,
  MAX_STEP_TRAVEL,
  RESOLVE_SKIN,
  resolveHard,
  separateCreatures,
  SOFT_SPEED_FACTOR,
  stepCreatures,
  type CreatureBody,
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

function body(x: number, z: number, r: number, vx = 0, vz = 0): CreatureBody {
  return { x, z, vx, vz, r };
}

function pairGap(a: CreatureBody, b: CreatureBody): number {
  return Math.hypot(a.x - b.x, a.z - b.z) - (a.r + b.r);
}

describe('separateCreatures — hard non-penetration between creatures', () => {
  it('leaves a non-overlapping pair untouched', () => {
    const a = body(0, 0, 1);
    const b = body(3, 0, 1);
    expect(separateCreatures([a, b])).toBe(false);
    expect(a).toEqual(body(0, 0, 1));
    expect(b).toEqual(body(3, 0, 1));
  });

  it('pushes an overlapping pair to exact contact, split half/half', () => {
    const a = body(0, 0, 1);
    const b = body(0.5, 0, 1);
    expect(separateCreatures([a, b])).toBe(true);
    // Fully separated in ONE call — a hard constraint, not a relaxing nudge.
    expect(pairGap(a, b)).toBeGreaterThanOrEqual(0);
    expect(pairGap(a, b)).toBeLessThanOrEqual(RESOLVE_SKIN + 1e-9);
    // Symmetric: the pair midpoint never moves (no shove, no dominance).
    expect((a.x + b.x) / 2).toBeCloseTo(0.25, 12);
    expect(a.z).toBeCloseTo(0, 12);
    expect(b.z).toBeCloseTo(0, 12);
  });

  it('splits a dead-center stack deterministically (+x)', () => {
    const run = (): [CreatureBody, CreatureBody] => {
      const a = body(1, 1, 0.8);
      const b = body(1, 1, 0.8);
      separateCreatures([a, b]);
      return [a, b];
    };
    const [a1, b1] = run();
    const [a2, b2] = run();
    expect(a1).toEqual(a2);
    expect(b1).toEqual(b2);
    expect(a1.x).toBeGreaterThan(b1.x);
    expect(pairGap(a1, b1)).toBeGreaterThanOrEqual(0);
  });

  it('resolves a chain of three stacked creatures within the pass budget', () => {
    const bodies = [body(0, 0, 1), body(1.2, 0, 1), body(2.4, 0, 1)];
    separateCreatures(bodies);
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        expect(pairGap(bodies[i]!, bodies[j]!)).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('removes only the CLOSING relative velocity — no bounce energy, tangent kept', () => {
    const a = body(0, 0, 1, 1, 0.4);
    const b = body(1.5, 0, 1, -1, 0.4);
    separateCreatures([a, b]);
    // Relative normal velocity is no longer closing.
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    const d = Math.hypot(dx, dz);
    const closing = -((a.vx - b.vx) * (dx / d) + (a.vz - b.vz) * (dz / d));
    expect(closing).toBeLessThanOrEqual(1e-9);
    // The shared tangential velocity is untouched, and no speed was added.
    expect(a.vz).toBeCloseTo(0.4, 12);
    expect(b.vz).toBeCloseTo(0.4, 12);
    expect(Math.hypot(a.vx, a.vz)).toBeLessThanOrEqual(Math.hypot(1, 0.4) + 1e-9);
  });

  it('separating bodies (already parting) keep their velocities bit-for-bit', () => {
    const a = body(0, 0, 1, -0.5, 0.1);
    const b = body(1.5, 0, 1, 0.5, -0.1);
    separateCreatures([a, b]);
    expect(a.vx).toBe(-0.5);
    expect(a.vz).toBe(0.1);
    expect(b.vx).toBe(0.5);
    expect(b.vz).toBe(-0.1);
  });
});

describe('stepCreatures — the per-frame movement law', () => {
  const noProps = (): readonly Collider[] => [];

  it('two creatures driven head-on never overlap and glide past each other', () => {
    const a = body(-3, 0, 0.9, 1.2, 0);
    const b = body(3, 0.01, 0.9, -1.2, 0); // hair off-axis, like real life
    const dt = 16;
    for (let frame = 0; frame < 900; frame++) {
      // Stubborn walkers: the drive re-asserts itself every frame, exactly
      // like the behavior springs do.
      a.vx = 1.2;
      a.vz = 0;
      b.vx = -1.2;
      b.vz = 0;
      stepCreatures([a, b], dt, noProps);
      expect(pairGap(a, b)).toBeGreaterThanOrEqual(-1e-6);
    }
    // ~14s of walking: the tangential slide let them shoulder PAST each
    // other — neither stalled nose to nose.
    expect(a.x).toBeGreaterThan(b.x);
    expect(a.x).toBeGreaterThan(1);
    expect(b.x).toBeLessThan(-1);
  });

  it('a dead-center head-on meeting still resolves deterministically', () => {
    const a = body(-2, 0, 0.8, 1.2, 0);
    const b = body(2, 0, 0.8, -1.2, 0);
    for (let frame = 0; frame < 600; frame++) {
      a.vx = 1.2;
      a.vz = 0;
      b.vx = -1.2;
      b.vz = 0;
      stepCreatures([a, b], 16, noProps);
      expect(pairGap(a, b)).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it('a creature driven at a rock never penetrates it', () => {
    const rock: Collider = { x: 4, z: 0, r: 1.2, hard: true };
    const near = (): readonly Collider[] => [rock];
    const c = body(0, 0.2, 0.8, 1.2, 0);
    for (let frame = 0; frame < 600; frame++) {
      c.vx = 1.2;
      c.vz = 0;
      stepCreatures([c], 16, near);
      const pen = c.r + rock.r - Math.hypot(c.x - rock.x, c.z - rock.z);
      expect(pen).toBeLessThanOrEqual(1e-9);
    }
  });

  it('a big clamped dt at high speed cannot tunnel through a collider', () => {
    // 16 u/s over the 250ms dt clamp = 4u of travel in one frame — ten times
    // the trunk's diameter. Naive integration would land far beyond it.
    const trunk: Collider = { x: 2, z: 0, r: 0.4, hard: true };
    const near = (): readonly Collider[] => [trunk];
    const c = body(0, 0, 0.5, 16, 0);
    stepCreatures([c], 250, near);
    // Blocked at the surface, on the NEAR side — never across.
    expect(c.x).toBeLessThanOrEqual(trunk.x - (trunk.r + c.r) + RESOLVE_SKIN + 1e-9);
    expect(c.x).toBeGreaterThan(1);
  });

  it('substep travel never exceeds MAX_STEP_TRAVEL between resolves', () => {
    // Indirect but load-bearing: a collider thinner than MAX_STEP_TRAVEL in
    // the path still blocks at every driven speed the demo can produce.
    const thin: Collider = { x: 3, z: 0, r: MAX_STEP_TRAVEL / 2, hard: true };
    const near = (): readonly Collider[] => [thin];
    for (const speed of [1.2, 3.6, 8, 14]) {
      const c = body(0, 0, 0.3, speed, 0);
      stepCreatures([c], 250, near);
      expect(c.x).toBeLessThan(thin.x);
    }
  });

  it('a pair squeezed against a wall resolves clear of BOTH wall and each other', () => {
    const wall: Collider = { x: 0, z: 3, r: 2, hard: true };
    const near = (): readonly Collider[] => [wall];
    const a = body(-0.2, 0.4, 0.8, 0, 1.0);
    const b = body(0.2, 0.2, 0.8, 0, 1.0);
    for (let frame = 0; frame < 400; frame++) {
      a.vx = 0;
      a.vz = 1.0;
      b.vx = 0;
      b.vz = 1.0;
      stepCreatures([a, b], 16, near);
      expect(pairGap(a, b)).toBeGreaterThanOrEqual(-0.02);
      for (const c of [a, b]) {
        const pen = c.r + wall.r - Math.hypot(c.x - wall.x, c.z - wall.z);
        expect(pen).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('respects the hard pad fraction (visual-silhouette inflation)', () => {
    const rock: Collider = { x: 2, z: 0, r: 1, hard: true };
    const near = (): readonly Collider[] => [rock];
    const c = body(0, 0, 0.5, 1.2, 0);
    for (let frame = 0; frame < 400; frame++) {
      c.vx = 1.2;
      c.vz = 0;
      stepCreatures([c], 16, near, { hardPadFrac: 0.11 });
    }
    const gap = Math.hypot(c.x - rock.x, c.z - rock.z) - (c.r + rock.r * 1.11);
    expect(gap).toBeGreaterThanOrEqual(-1e-9);
  });

  it('is deterministic for identical inputs', () => {
    const run = (): CreatureBody[] => {
      const bodies = [
        body(-2, 0, 0.8, 1.2, 0),
        body(2, 0.01, 0.8, -1.2, 0),
        body(0, 2, 0.7, 0, -1.0),
      ];
      for (let frame = 0; frame < 200; frame++) {
        bodies[0]!.vx = 1.2;
        bodies[1]!.vx = -1.2;
        bodies[2]!.vz = -1.0;
        stepCreatures(bodies, 16, noProps);
      }
      return bodies;
    };
    expect(run()).toEqual(run());
  });
});
