/**
 * Reactive IK stepping — pure tests over the analytic solve and the step
 * state machine. The stepper advances only on fed dt, so every sequence is
 * deterministic.
 */

import { describe, expect, it } from 'vitest';
import type { Motifs } from '../../../src/character/interpret';
import { specFromMotifs, type V3 } from '../../../src/character/blendshell/spec';
import {
  createStepper,
  legChainsOf,
  MAX_EXTENSION,
  solveTwoBoneIK,
  swingArc,
} from '../../../src/character/blendshell/step';

const DT = 16;

function motifsOf(over: Partial<Motifs> = {}): Motifs {
  return {
    archetype: 'biped',
    aspect: 1.2,
    torsoFullness: 0.7,
    headSize: 0.6,
    feet: [
      { angle: -0.1, reach: 0.9 },
      { angle: 0.12, reach: 0.9 },
    ],
    limbs: [],
    crown: [{ angle: 0.2, reach: 0.12 }],
    lumpiness: 0.4,
    ...over,
  };
}

const dist = (a: V3, b: V3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('solveTwoBoneIK', () => {
  const hip: V3 = [0, 0.3, 0];
  const l1 = 0.16;
  const l2 = 0.14;

  it('reaches a reachable target within tolerance', () => {
    const target: V3 = [0.05, 0.06, 0.04];
    const { knee, foot, clamped } = solveTwoBoneIK(hip, target, l1, l2, [0, 0, 1]);
    expect(clamped).toBe(false);
    expect(dist(foot, target)).toBeLessThan(1e-9);
    expect(dist(knee, hip)).toBeCloseTo(l1, 6);
    expect(dist(foot, knee)).toBeCloseTo(l2, 6);
  });

  it('clamps unreachable targets to the max extension', () => {
    const target: V3 = [0, -0.5, 0.4];
    const { knee, foot, clamped } = solveTwoBoneIK(hip, target, l1, l2, [0, 0, 1]);
    expect(clamped).toBe(true);
    // Foot pulled onto the reachable shell along the hip→target ray.
    expect(dist(foot, hip)).toBeLessThanOrEqual(l1 + l2 + 1e-9);
    expect(dist(foot, hip)).toBeCloseTo((l1 + l2) * 0.999, 6);
    expect(dist(knee, hip)).toBeCloseTo(l1, 6);
    expect(dist(foot, knee)).toBeCloseTo(l2, 6);
  });

  it('clamps targets inside the annulus (too close to the hip)', () => {
    const target: V3 = [0, 0.3 - 0.005, 0];
    const { foot } = solveTwoBoneIK(hip, target, l1, l2, [0, 0, 1]);
    expect(dist(foot, hip)).toBeGreaterThanOrEqual(Math.abs(l1 - l2));
  });

  it('bends the knee toward the bend direction', () => {
    const target: V3 = [0, 0.02, 0];
    const { knee } = solveTwoBoneIK(hip, target, l1, l2, [0, 0, 1]);
    expect(knee[2]).toBeGreaterThan(0);
  });
});

describe('swingArc', () => {
  it('starts and ends grounded, rises in between', () => {
    expect(swingArc(0).h).toBeCloseTo(0, 9);
    expect(swingArc(1).h).toBeCloseTo(0, 9);
    expect(swingArc(0.4).h).toBeGreaterThan(0.5);
    expect(swingArc(0).u).toBeCloseTo(0, 9);
    expect(swingArc(1).u).toBeCloseTo(1, 9);
  });

  it('plants with ~zero vertical velocity (the flattened last 20%)', () => {
    // Finite-difference slope at the very end of the arc must be near zero —
    // a raw parabola would land at slope 4 (in normalized units).
    const eps = 1e-3;
    const slopeEnd = (swingArc(1).h - swingArc(1 - eps).h) / eps;
    expect(Math.abs(slopeEnd)).toBeLessThan(0.05);
    const slopeParabola = 4; // |d/dt 4t(1−t)| at t=1
    expect(Math.abs(slopeEnd)).toBeLessThan(slopeParabola * 0.02);
  });

  it('never overshoots: u and h stay in [0, 1] and u is monotonic', () => {
    let prev = 0;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const { u, h } = swingArc(t);
      expect(u).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(u).toBeLessThanOrEqual(1 + 1e-9);
      expect(h).toBeGreaterThanOrEqual(-1e-9);
      expect(h).toBeLessThanOrEqual(1 + 1e-9);
      prev = u;
    }
  });
});

describe('stepper state machine', () => {
  /** Run and record every lift (planted→swinging transition) by side. */
  function runRecordingLifts(
    ms: number,
    speed: number,
    stepper: ReturnType<typeof createStepper>,
  ): (-1 | 1)[] {
    const lifts: (-1 | 1)[] = [];
    let prev = stepper.feet().map((f) => f.planted);
    for (let t = 0; t < ms; t += DT) {
      stepper.update(DT, speed);
      const now = stepper.feet();
      now.forEach((f, i) => {
        if (prev[i] && !f.planted) lifts.push(f.side);
      });
      prev = now.map((f) => f.planted);
    }
    return lifts;
  }

  it('alternates feet while walking (biped)', () => {
    const spec = specFromMotifs(motifsOf(), 42);
    const stepper = createStepper(spec, 42);
    const lifts = runRecordingLifts(12000, 0.25, stepper);
    expect(lifts.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < lifts.length; i++) {
      expect(lifts[i]).not.toBe(lifts[i - 1]);
    }
  });

  it('completes the stride on stop: swing finishes, feet settle home', () => {
    const spec = specFromMotifs(motifsOf(), 42);
    const stepper = createStepper(spec, 42);
    // Walk until a foot is mid-swing.
    let guard = 0;
    while (stepper.feet().every((f) => f.planted) && guard++ < 2000) {
      stepper.update(DT, 0.25);
    }
    expect(stepper.feet().some((f) => !f.planted)).toBe(true);

    // Stop. The in-flight arc must complete, then any displaced foot takes
    // its settling step, then everything rests at the rest slots.
    for (let t = 0; t < 6000; t += DT) stepper.update(DT, 0);
    const chains = legChainsOf(spec);
    const feet = stepper.feet();
    expect(feet.every((f) => f.planted)).toBe(true);
    feet.forEach((f, i) => {
      const home = chains[i]!.foot;
      expect(Math.hypot(f.pos[0] - home[0], f.pos[2] - home[2])).toBeLessThan(
        MAX_EXTENSION * (chains[i]!.upperLen + chains[i]!.lowerLen) * 0.45,
      );
      expect(f.pos[1]).toBeCloseTo(home[1], 4);
    });
    // And nothing lifts again at rest.
    const lifts = runRecordingLifts(2000, 0, stepper);
    expect(lifts.length).toBe(0);
  });

  it('never overreaches: leg chains stay within their length', () => {
    const spec = specFromMotifs(motifsOf(), 7);
    const chains = legChainsOf(spec);
    const stepper = createStepper(spec, 7);
    for (let t = 0; t < 8000; t += DT) {
      stepper.update(DT, 0.35);
      for (const c of chains) {
        const upper = spec.parts[c.upper]!;
        const lower = spec.parts[c.lower]!;
        const hipToFoot = dist(upper.a, lower.b!);
        expect(hipToFoot).toBeLessThanOrEqual(c.upperLen + c.lowerLen + 1e-6);
        // Segment lengths hold — the IK writes true two-bone poses.
        expect(dist(upper.a, upper.b!)).toBeCloseTo(c.upperLen, 6);
        expect(dist(lower.a, lower.b!)).toBeCloseTo(c.lowerLen, 6);
      }
    }
  });

  it('scales cadence with speed', () => {
    const slowSpec = specFromMotifs(motifsOf(), 42);
    const fastSpec = specFromMotifs(motifsOf(), 42);
    const slow = runRecordingLifts(10000, 0.12, createStepper(slowSpec, 42)).length;
    const fast = runRecordingLifts(10000, 0.35, createStepper(fastSpec, 42)).length;
    expect(fast).toBeGreaterThan(slow);
  });

  it('is deterministic for the same (dt, speed) sequence and seed', () => {
    const a = createStepper(specFromMotifs(motifsOf(), 42), 42);
    const b = createStepper(specFromMotifs(motifsOf(), 42), 42);
    for (let t = 0; t < 5000; t += DT) {
      const pa = a.update(DT, 0.3);
      const pb = b.update(DT, 0.3);
      expect(pb).toEqual(pa);
    }
    expect(b.feet()).toEqual(a.feet());
  });

  it('returns a bounded, gentle body pose', () => {
    const spec = specFromMotifs(motifsOf(), 42);
    const stepper = createStepper(spec, 42);
    for (let t = 0; t < 6000; t += DT) {
      const pose = stepper.update(DT, 0.3);
      expect(pose.lift).toBeGreaterThanOrEqual(0);
      expect(pose.lift).toBeLessThan(0.02);
      expect(pose.lean).toBeGreaterThanOrEqual(0);
      expect(pose.lean).toBeLessThanOrEqual(0.1);
    }
  });

  it('degenerates to a no-op glide for a legless blob', () => {
    const spec = specFromMotifs(motifsOf({ archetype: 'blob', feet: [] }), 42);
    const before = JSON.parse(JSON.stringify(spec.parts));
    const stepper = createStepper(spec, 42);
    const pose = stepper.update(DT, 0.4);
    expect(pose.lift).toBe(0);
    expect(stepper.feet().length).toBe(0);
    expect(spec.parts).toEqual(before);
  });
});
