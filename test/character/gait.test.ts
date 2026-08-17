/**
 * Gait — pure tests over the phase/amplitude controller (gait.ts) and the
 * CPU twin of the gait deformation layer (deform.ts). No renderer: the
 * controller advances only on fed dt, so every assertion is deterministic.
 */

import { describe, expect, it } from 'vitest';
import {
  deformPoint,
  gaitRollAngle,
  HIP_FRAC,
  NEUTRAL_DEFORM,
  NEUTRAL_GAIT,
  type DeformFrame,
  type GaitState,
} from '../../src/character/deform';
import { createGait, FULL_AMP_SPEED, GAIT_PROFILES } from '../../src/character/gait';
import { MOTION } from '../../src/taste/tokens';

const DT = 16;

/** Advance a controller for ms at a constant speed; returns the last state. */
function run(
  gait: ReturnType<typeof createGait>,
  ms: number,
  speed: number,
): GaitState {
  let state = gait.update(DT, speed, 0);
  for (let t = DT; t < ms; t += DT) state = gait.update(DT, speed, 0);
  return state;
}

/** Distance of a phase from the nearest multiple of π (a rest phase). */
function distToRest(phase: number): number {
  const m = ((phase % Math.PI) + Math.PI) % Math.PI;
  return Math.min(m, Math.PI - m);
}

describe('gait controller', () => {
  it('advances phase at a rate proportional to speed / stride', () => {
    const stride = GAIT_PROFILES.biped.stride;
    const speeds = [0.45, 0.9];
    const deltas = speeds.map((speed) => {
      const gait = createGait('biped');
      // let the frequency spring settle (>3x secondary), then measure
      const settled = run(gait, 3200, speed);
      const later = run(gait, 2000, speed);
      gait.dispose();
      return later.phase - settled.phase;
    });
    // absolute: settled rate = 2π · speed/stride rad/s over the 2s window
    for (let i = 0; i < speeds.length; i++) {
      const expected = 2 * Math.PI * (speeds[i]! / stride) * 2;
      expect(deltas[i]!).toBeGreaterThan(expected * 0.95);
      expect(deltas[i]!).toBeLessThan(expected * 1.05);
    }
    // relative: double the speed, double the stepping rate
    expect(deltas[1]! / deltas[0]!).toBeCloseTo(2, 1);
  });

  it('amplitude rises with speed and reaches full read at cruise', () => {
    const gait = createGait('biped');
    const early = run(gait, DT * 4, FULL_AMP_SPEED);
    const mid = run(gait, 400, FULL_AMP_SPEED);
    const late = run(gait, 3200, FULL_AMP_SPEED);
    gait.dispose();
    expect(early.amp).toBeGreaterThanOrEqual(0);
    expect(mid.amp).toBeGreaterThan(early.amp);
    expect(late.amp).toBeGreaterThan(0.95);
    expect(late.amp).toBeLessThanOrEqual(1);
  });

  it('amplitude scales down with slower speeds', () => {
    const slow = createGait('biped');
    const fast = createGait('biped');
    const slowAmp = run(slow, 4000, FULL_AMP_SPEED * 0.4).amp;
    const fastAmp = run(fast, 4000, FULL_AMP_SPEED).amp;
    slow.dispose();
    fast.dispose();
    expect(slowAmp).toBeGreaterThan(0.2);
    expect(slowAmp).toBeLessThan(fastAmp);
  });

  it('amplitude settles to ~0 within a settle window after stopping', () => {
    const gait = createGait('biped');
    run(gait, 3200, FULL_AMP_SPEED);
    const stopped = run(gait, 4 * MOTION.secondaryMs, 0);
    gait.dispose();
    expect(stopped.amp).toBeLessThan(0.02);
  });

  it('completes the last half-step after stop — no mid-stride freeze', () => {
    const gait = createGait('biped');
    const atStop = run(gait, 2000, FULL_AMP_SPEED);
    // stopped mid-stride (dt-quantized walking rarely lands on a rest phase)
    expect(distToRest(atStop.phase)).toBeGreaterThan(0.05);
    const rested = run(gait, 4000, 0);
    gait.dispose();
    // phase kept advancing after the stop...
    expect(rested.phase).toBeGreaterThan(atStop.phase);
    // ...but never past the nearest rest phase ahead (≤ π away)...
    expect(rested.phase - atStop.phase).toBeLessThanOrEqual(Math.PI + 1e-6);
    // ...and it ARRIVED: final phase is a multiple of π (legs passing,
    // body level — the shear/bob/waddle terms are all zero there).
    expect(distToRest(rested.phase)).toBeLessThan(1e-6);
  });

  it('holds the rest phase once arrived (nothing oscillates at rest)', () => {
    const gait = createGait('biped');
    run(gait, 2000, FULL_AMP_SPEED);
    const rested = run(gait, 4000, 0);
    const later = run(gait, 2000, 0);
    gait.dispose();
    expect(later.phase).toBe(rested.phase);
  });

  it('differentiates archetypes: blob undulates, bipeds waddle hardest', () => {
    // blob: no leg shear, no waddle — the undulating glide instead
    expect(GAIT_PROFILES.blob.legShear).toBe(0);
    expect(GAIT_PROFILES.blob.waddle).toBe(0);
    expect(GAIT_PROFILES.blob.undulate).toBeGreaterThan(0);
    expect(GAIT_PROFILES.blob.undulateK).toBeGreaterThan(0);
    // leggy bodies: no undulation, alternating steps instead
    for (const a of ['biped', 'bird', 'quadruped'] as const) {
      expect(GAIT_PROFILES[a].undulate).toBe(0);
      expect(GAIT_PROFILES[a].legShear).toBeGreaterThan(0);
    }
    // the roll is the waddle: strongest for biped/bird, moderate quadruped
    expect(GAIT_PROFILES.biped.waddle).toBeGreaterThan(GAIT_PROFILES.quadruped.waddle);
    expect(GAIT_PROFILES.bird.waddle).toBeGreaterThanOrEqual(GAIT_PROFILES.biped.waddle);
    // the controller carries its profile through to the uniform state
    const blob = createGait('blob');
    const state = run(blob, 1000, FULL_AMP_SPEED);
    blob.dispose();
    expect(state.legShear).toBe(0);
    expect(state.waddle).toBe(0);
    expect(state.undulate).toBe(GAIT_PROFILES.blob.undulate);
  });

  it('is deterministic: same (dt, speed) sequence, same states', () => {
    const speeds = [0, 0.3, 0.9, 0.9, 0.5, 0, 0, 1.2];
    const a = createGait('quadruped');
    const b = createGait('quadruped');
    for (const speed of speeds) {
      for (let t = 0; t < 500; t += DT) {
        const sa = a.update(DT, speed, 0.4);
        const sb = b.update(DT, speed, 0.4);
        expect(sb.phase).toBe(sa.phase);
        expect(sb.amp).toBe(sa.amp);
      }
    }
    a.dispose();
    b.dispose();
  });
});

describe('gait deformation (CPU twin)', () => {
  const frame: DeformFrame = { baseY: 0, height: 1 };

  const legGait: GaitState = {
    ...NEUTRAL_GAIT,
    phase: Math.PI / 2,
    amp: 1,
    legShear: 0.12,
    bob: 0.015,
  };

  it('is the identity at neutral gait (deformPoint unchanged without it)', () => {
    const p = { x: 0.2, y: 0.4, z: 0.1 };
    const plain = deformPoint(p, NEUTRAL_DEFORM, frame);
    const gated = deformPoint(p, NEUTRAL_DEFORM, frame, NEUTRAL_GAIT);
    expect(gated).toEqual(plain);
  });

  it('shears the legs in antiphase across the midline, below the hip only', () => {
    const y = 0.05;
    const left = deformPoint({ x: -0.3, y, z: 0 }, NEUTRAL_DEFORM, frame, legGait);
    const right = deformPoint({ x: 0.3, y, z: 0 }, NEUTRAL_DEFORM, frame, legGait);
    // opposite z swing — the alternating step read
    expect(right.z).toBeGreaterThan(0.05);
    expect(left.z).toBeLessThan(-0.05);
    expect(left.z).toBeCloseTo(-right.z, 10);
    // above the hip, no leg shear
    const upper = deformPoint(
      { x: 0.3, y: HIP_FRAC + 0.2, z: 0 },
      NEUTRAL_DEFORM,
      frame,
      legGait,
    );
    expect(upper.z).toBeCloseTo(0, 10);
  });

  it('bobs at 2x phase, upward only', () => {
    // phase π/2 → 2x phase π → bob peak; phase 0 → bob zero
    const peak = deformPoint({ x: 0, y: 0.5, z: 0 }, NEUTRAL_DEFORM, frame, legGait);
    expect(peak.y).toBeCloseTo(0.5 + 0.015, 10);
    const atRest = deformPoint(
      { x: 0, y: 0.5, z: 0 },
      NEUTRAL_DEFORM,
      frame,
      { ...legGait, phase: 0 },
    );
    expect(atRest.y).toBeCloseTo(0.5, 10);
  });

  it('waddle rolls the whole body about the travel axis', () => {
    const waddleGait: GaitState = {
      ...NEUTRAL_GAIT,
      phase: Math.PI / 2,
      amp: 1,
      waddle: 0.11,
    };
    const roll = gaitRollAngle(waddleGait);
    expect(roll).toBeCloseTo(0.11, 10);
    const top = deformPoint({ x: 0, y: 1, z: 0 }, NEUTRAL_DEFORM, frame, waddleGait);
    // rotated about the base: the head swings sideways by sin(roll)
    expect(top.x).toBeCloseTo(-Math.sin(roll), 10);
    expect(top.y).toBeCloseTo(Math.cos(roll), 10);
    // at a rest phase the roll vanishes
    expect(gaitRollAngle({ ...waddleGait, phase: Math.PI })).toBeCloseTo(0, 10);
  });

  it('blob undulation travels along the body height', () => {
    const blobGait: GaitState = {
      ...NEUTRAL_GAIT,
      phase: Math.PI / 2,
      amp: 1,
      undulate: 0.05,
      undulateK: Math.PI * 2,
    };
    const base = deformPoint({ x: 0, y: 0, z: 0 }, NEUTRAL_DEFORM, frame, blobGait);
    const mid = deformPoint({ x: 0, y: 0.5, z: 0 }, NEUTRAL_DEFORM, frame, blobGait);
    // sin(π/2 − 0) vs sin(π/2 − π): opposite sway — a traveling wave, not a
    // rigid shift (and no leg shear anywhere: legShear is 0)
    expect(base.x).toBeCloseTo(0.05, 10);
    expect(mid.x).toBeCloseTo(-0.05, 10);
  });
});
