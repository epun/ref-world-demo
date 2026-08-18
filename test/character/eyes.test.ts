/**
 * Eyes — pure-logic tests (PLAN §3.4).
 *
 * Covers the two pure modules that back the eye system: expressions
 * (uniform parameter sets + lerp) and placement (the mask→character-local
 * mapping that must replicate the inflater's world transform exactly).
 * No Three.js in any tested path — both modules import nothing renderable.
 */

import { MeshPhysicalMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { DEFORM_CHANNELS } from '../../src/character/deform';
import { EMOTES, runEmote, type EmoteSprings } from '../../src/character/emotes';
import { applyEyes, type EyeState } from '../../src/character/eyes';
import {
  clampPupil,
  eyeAperture,
  EXPRESSIONS,
  EXPRESSION_BOUNDS,
  EXPRESSION_NAMES,
  lerpExpression,
  MARK_R,
  normalizeExpression,
  PUPIL_FRAC,
  resolveExpression,
  type Expression,
} from '../../src/character/expressions';
import { auditDamping } from '../../src/motion/spring';
import { EMOTE_NAMES } from '../../src/net/protocol';
import { MOTION } from '../../src/taste/tokens';
import type { ShapeAnalysis } from '../../src/shape/types';
import {
  computeEyePlacement,
  maskToLocal,
  sampleDistance,
  surfaceZ,
  EYE_DEPTH_SCALE,
  EYE_PROUD,
  EYE_RADIUS,
  EYE_SEPARATION,
} from '../../src/character/placement';
import type { DistanceField } from '../../src/shape/types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A synthetic distance field filled from fn(x, y). */
function field(size: number, fn: (x: number, y: number) => number): DistanceField {
  const data = new Float32Array(size * size);
  let max = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fn(x, y);
      data[y * size + x] = v;
      if (v > max) max = v;
    }
  }
  return { size, data, max };
}

const SIZE = 64;
const BOUNDS = { minX: 16, minY: 16, maxX: 47, maxY: 47 };
const CENTER = { x: (16 + 47) / 2, y: (16 + 47) / 2 }; // (31.5, 31.5)

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

describe('expressions', () => {
  it('defines the full emote set', () => {
    for (const name of ['neutral', 'happy', 'sad', 'sleepy', 'angry', 'surprised'] as const) {
      expect(EXPRESSIONS[name]).toBeDefined();
      expect(EXPRESSION_NAMES).toContain(name);
    }
  });

  it('keeps every expression inside the parameter bounds', () => {
    for (const name of EXPRESSION_NAMES) {
      const e = normalizeExpression(EXPRESSIONS[name]);
      for (const [axis, [lo, hi]] of Object.entries(EXPRESSION_BOUNDS)) {
        const v = e[axis as keyof typeof e];
        expect(v, `${name}.${axis}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${name}.${axis}`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('reads at small scale: each expression leans on its dominant axis', () => {
    // surprised = wide + larger than everything else
    expect(EXPRESSIONS.surprised.openness).toBe(1);
    for (const name of EXPRESSION_NAMES) {
      if (name === 'surprised') continue;
      expect(EXPRESSIONS.surprised.size).toBeGreaterThan(EXPRESSIONS[name].size);
    }
    // sleepy = lids nearly down
    expect(EXPRESSIONS.sleepy.openness).toBeLessThan(0.3);
    // happy bends up, sad bends down
    expect(EXPRESSIONS.happy.curve).toBeGreaterThan(0.5);
    expect(EXPRESSIONS.sad.curve).toBeLessThan(-0.5);
    // angry = wedge + slight negative curve, and only angry carries a wedge
    expect(EXPRESSIONS.angry.wedge).toBeGreaterThan(0.5);
    expect(EXPRESSIONS.angry.curve).toBeLessThan(0);
    for (const name of EXPRESSION_NAMES) {
      if (name === 'angry') continue;
      expect(EXPRESSIONS[name].wedge).toBe(0);
    }
  });

  it('lerpExpression hits its endpoints and midpoint', () => {
    const a = EXPRESSIONS.sad;
    const b = EXPRESSIONS.happy;
    expect(lerpExpression(a, b, 0)).toEqual(a);
    expect(lerpExpression(a, b, 1)).toEqual(b);
    const mid = lerpExpression(a, b, 0.5);
    for (const k of ['openness', 'curve', 'wedge', 'size'] as const) {
      expect(mid[k]).toBeCloseTo((a[k] + b[k]) / 2, 10);
    }
  });

  it('resolveExpression accepts names and literals', () => {
    expect(resolveExpression('happy')).toEqual(EXPRESSIONS.happy);
    const literal: Expression = { openness: 0.5, curve: 0.1, wedge: 0, size: 1 };
    expect(resolveExpression(literal)).toBe(literal);
  });
});

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

describe('placement', () => {
  it('maskToLocal centers on the ink bounds and flips y up', () => {
    // The bounds center maps to the local origin.
    const origin = maskToLocal(CENTER, BOUNDS, SIZE);
    expect(origin.x).toBeCloseTo(0, 10);
    expect(origin.y).toBeCloseTo(0, 10);
    // Mask y is down; a point ABOVE center (smaller y) maps to POSITIVE local y.
    const up = maskToLocal({ x: CENTER.x, y: CENTER.y - 10 }, BOUNDS, SIZE);
    expect(up.y).toBeCloseTo(10 / SIZE, 10);
    // And below center maps negative.
    const down = maskToLocal({ x: CENTER.x, y: CENTER.y + 8 }, BOUNDS, SIZE);
    expect(down.y).toBeCloseTo(-8 / SIZE, 10);
    // x scales by 1/maskSize.
    const right = maskToLocal({ x: CENTER.x + 6, y: CENTER.y }, BOUNDS, SIZE);
    expect(right.x).toBeCloseTo(6 / SIZE, 10);
  });

  it('sampleDistance bilinearly interpolates', () => {
    const f = field(4, (x) => x); // ramp: dt = x
    expect(sampleDistance(f, 1, 1)).toBeCloseTo(1, 10);
    expect(sampleDistance(f, 1.5, 2)).toBeCloseTo(1.5, 10);
    // Clamped at the border.
    expect(sampleDistance(f, -5, 0)).toBeCloseTo(0, 10);
    expect(sampleDistance(f, 99, 0)).toBeCloseTo(3, 10);
  });

  it('surfaceZ matches the inflate profile z = depthScale·sqrt(dt·dtMax)/size', () => {
    const DT = 8;
    const f = field(SIZE, () => DT); // constant field: dt = dtMax = 8
    const z = surfaceZ(f, CENTER.x, CENTER.y);
    expect(z).toBeCloseTo((EYE_DEPTH_SCALE * Math.sqrt(DT * DT)) / SIZE, 10);
  });

  it('places the pair straddling the head lobe at the lobe height', () => {
    const DT = 8;
    const analysis = {
      distance: field(SIZE, () => DT),
      headLobe: { x: CENTER.x, y: CENTER.y - 6 }, // above bounds center
      bounds: BOUNDS,
    };
    const p = computeEyePlacement(analysis);
    // Symmetric about the lobe x (= bounds center here → local 0).
    expect(p.left.x).toBeCloseTo(-p.right.x, 10);
    expect(p.left.x).toBeLessThan(0);
    // Both at the lobe's local height, y flipped up.
    expect(p.left.y).toBeCloseTo(6 / SIZE, 10);
    expect(p.right.y).toBeCloseTo(6 / SIZE, 10);
  });

  it('derives separation and radius from the local head thickness', () => {
    const analysisAt = (dt: number) => ({
      distance: field(SIZE, () => dt),
      headLobe: CENTER,
      bounds: BOUNDS,
    });
    const thin = computeEyePlacement(analysisAt(4));
    const thick = computeEyePlacement(analysisAt(8));
    // Positive, and proportional to thickness: double dt → double both.
    expect(thin.separation).toBeGreaterThan(0);
    expect(thin.radius).toBeGreaterThan(0);
    expect(thick.separation).toBeCloseTo(thin.separation * 2, 10);
    expect(thick.radius).toBeCloseTo(thin.radius * 2, 10);
    // Exact constants: sep = 0.55·t, r = 0.26·t (local units).
    expect(thick.separation).toBeCloseTo((EYE_SEPARATION * 8) / SIZE, 10);
    expect(thick.radius).toBeCloseTo((EYE_RADIUS * 8) / SIZE, 10);
    // Marks, not headlights: caps never touch each other.
    expect(thick.radius).toBeLessThan(thick.separation);
  });

  it('floats each cap just proud of the front surface at its own position', () => {
    const DT = 8;
    const analysis = {
      // A gentle ramp so the two eyes land at different surface heights.
      distance: field(SIZE, (x) => DT + x * 0.1),
      headLobe: CENTER,
      bounds: BOUNDS,
    };
    const p = computeEyePlacement(analysis);
    for (const eye of [p.left, p.right]) {
      // Convert the eye's local x back to mask x to sample the surface there.
      const mx = eye.x * SIZE + CENTER.x;
      const surface = surfaceZ(analysis.distance, mx, CENTER.y);
      expect(eye.z).toBeGreaterThan(surface);
      expect(eye.z).toBeCloseTo(surface + EYE_PROUD * p.radius, 10);
    }
    // The ramp means the right eye sits higher off the ground plane than the left.
    expect(p.right.z).toBeGreaterThan(p.left.z);
  });

  it('guards degenerate thickness so the eyes never collapse', () => {
    const p = computeEyePlacement({
      distance: field(SIZE, () => 0),
      headLobe: CENTER,
      bounds: BOUNDS,
    });
    expect(p.radius).toBeGreaterThan(0);
    expect(p.separation).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// the pupil: a CPU twin of the eye's fragment SDF
// ---------------------------------------------------------------------------
//
// The user report this suite pins: "on emote the character's pupil should
// move — currently it stays in place — and for things like singing and happy
// you should see the pupil." Both halves are geometry, so both are provable
// here without a renderer: the SDF below is the same one eyes.ts bakes into
// the fragment shader, evaluated in lid space (q) where the mark is a disc of
// radius MARK_R and every lid is a circle or a line cutting into it.

/** Signed distance to the visible MARK, lid space — twin of EYE_FRAG_BLOCK. */
function markSdf(state: EyeState, qx: number, qy: number): number {
  let d = Math.hypot(qx, qy) - MARK_R;
  const amount = Math.abs(state.curve);
  const sign = state.curve >= 0 ? 1 : -1;
  const cy = -sign * (MARK_R + 0.75 - amount);
  d = Math.max(d, -(Math.hypot(qx, qy - cy) - 0.75));
  d = Math.max(d, (qy - MARK_R * (1.6 - 1.9 * state.wedge)) * 0.78086);
  return d;
}

/**
 * What fraction of the pupil disc actually survives the lids, and how much of
 * the frame the mark itself covers. Both in lid space, so `openness` (which
 * squashes the whole mark, pupil included) is deliberately not a factor — a
 * blink or a sleepy lid should not read here as "the pupil was cut away."
 */
function pupilRead(state: EyeState): { visible: number; markArea: number } {
  const N = 96;
  const span = 2.4;
  let pupil = 0;
  let mark = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const qx = -span / 2 + (span * (i + 0.5)) / N;
      const qy = -span / 2 + (span * (j + 0.5)) / N;
      const d = markSdf(state, qx, qy);
      if (d < 0) mark++;
      const dp = Math.hypot(qx - state.gazeX, qy - state.gazeY) - state.pupilR;
      if (Math.max(dp, d) < 0) pupil++;
    }
  }
  const cell = (span / N) ** 2;
  return {
    visible: (pupil * cell) / (Math.PI * state.pupilR * state.pupilR),
    markArea: mark * cell,
  };
}

/** A synthetic analysis good enough for applyEyes (it reads headLobe, the
 * distance field, and the ink bounds — nothing renderable). */
const EYE_ANALYSIS = {
  distance: field(SIZE, () => 8),
  headLobe: { x: CENTER.x, y: CENTER.y - 6 },
  bounds: BOUNDS,
} as unknown as ShapeAnalysis;

/** Recorder springs: the body deformation is not under test here. */
function bodySprings(): EmoteSprings {
  return Object.fromEntries(
    DEFORM_CHANNELS.map((channel) => [channel, { retarget: (): void => {} }]),
  ) as unknown as EmoteSprings;
}

/** Play one emote on a real Eyes instance, sampling every frame. */
function traceEmote(name: (typeof EMOTE_NAMES)[number], seed: number): EyeState[] {
  const material = new MeshPhysicalMaterial();
  const eyes = applyEyes(material, EYE_ANALYSIS, seed);
  const run = runEmote(bodySprings(), name, {
    onExpression: (e) => eyes.setExpression(e),
    onGaze: (x, y) => eyes.setGaze(x, y),
  });
  const envelope = EMOTES[name].envelope;
  const duration = envelope[envelope.length - 1]!.atMs;
  const states: EyeState[] = [];
  for (let t = 0; t < duration; t += 16) {
    run.update(16);
    eyes.update(16);
    states.push(eyes.state());
  }
  eyes.dispose();
  material.dispose();
  return states;
}

/** Deterministic identity salts — the eye's shape, size, blink and wander
 * schedules all key off these, so nothing below may be seed-lucky. */
const SEEDS = [1, 7, 33, 91, 404, 1234, 2048, 4095];

describe('eye aperture (the slot the lids leave open)', () => {
  it('is the whole mark when neither lid is engaged', () => {
    const { lo, hi } = eyeAperture(0, 0);
    expect(lo).toBeCloseTo(-MARK_R, 6);
    expect(hi).toBeGreaterThanOrEqual(MARK_R - 1e-6);
  });

  it('a happy crescent raises the floor, a sad one drops the ceiling', () => {
    const happy = eyeAperture(0.58, 0);
    expect(happy.lo).toBeCloseTo(0.58 - MARK_R, 6);
    expect(happy.hi).toBeGreaterThanOrEqual(MARK_R - 1e-6);
    const sad = eyeAperture(-0.62, 0);
    expect(sad.lo).toBeCloseTo(-MARK_R, 6);
    expect(sad.hi).toBeCloseTo(MARK_R - 0.62, 6);
  });

  it('the brow wedge cuts from the top only', () => {
    const open = eyeAperture(0, 0);
    const browed = eyeAperture(0, 0.82);
    expect(browed.hi).toBeLessThan(open.hi);
    expect(browed.lo).toBeCloseTo(open.lo, 6);
  });

  it('narrows off-axis, following the rim of the mark itself', () => {
    const middle = eyeAperture(0, 0, 0);
    const edge = eyeAperture(0, 0, 0.5);
    expect(edge.hi - edge.lo).toBeLessThan(middle.hi - middle.lo);
  });

  it('agrees with the rasterized sdf about where the mark ends', () => {
    for (const name of EXPRESSION_NAMES) {
      const e = normalizeExpression(EXPRESSIONS[name]);
      const state: EyeState = {
        ...e,
        gazeX: 0,
        gazeY: 0,
        pupilR: MARK_R * PUPIL_FRAC * e.pupilScale,
      };
      const { lo, hi } = eyeAperture(e.curve, e.wedge, 0);
      // Just inside the slot is mark; just outside it is not.
      expect(markSdf(state, 0, lo + 0.02), `${name} floor`).toBeLessThan(0);
      expect(markSdf(state, 0, hi - 0.02), `${name} ceiling`).toBeLessThan(0);
      expect(markSdf(state, 0, lo - 0.03), `${name} below floor`).toBeGreaterThan(0);
      expect(markSdf(state, 0, hi + 0.03), `${name} above ceiling`).toBeGreaterThan(0);
    }
  });
});

describe('clampPupil', () => {
  const pupilR = MARK_R * PUPIL_FRAC;

  it('leaves a gaze that already sits in the slot untouched', () => {
    const aimed = clampPupil(0, 0, pupilR, 0.1, 0.05);
    expect(aimed.x).toBeCloseTo(0.1, 6);
    expect(aimed.y).toBeCloseTo(0.05, 6);
  });

  it('pulls a swallowed pupil back under the lid rather than losing it', () => {
    // A hard happy crescent with the pupil aimed at the old centre: the lid
    // would eat it whole. The clamp lifts it into what's left.
    const aimed = clampPupil(0.9, 0, pupilR, 0, 0);
    const { lo, hi } = eyeAperture(0.9, 0, aimed.x);
    expect(aimed.y).toBeGreaterThan(0);
    expect(aimed.y).toBeGreaterThanOrEqual(lo);
    expect(aimed.y).toBeLessThanOrEqual(hi);
  });

  it('is continuous as the lid moves — the pupil rides it, never jumps', () => {
    let previous = clampPupil(0, 0, pupilR, 0, 0).y;
    for (let curve = 0; curve <= 1; curve += 0.01) {
      const y = clampPupil(curve, 0, pupilR, 0, 0).y;
      expect(Math.abs(y - previous), `curve ${curve.toFixed(2)}`).toBeLessThan(0.02);
      previous = y;
    }
  });

  it('keeps at least half the pupil inside the mark horizontally', () => {
    const aimed = clampPupil(0, 0, pupilR, 5, 0);
    expect(aimed.x).toBeLessThanOrEqual(MARK_R - pupilR * 0.5 + 1e-9);
  });
});

describe('every expression keeps the pupil in shot', () => {
  it('rests its pupil inside its own aperture', () => {
    for (const name of EXPRESSION_NAMES) {
      const e = normalizeExpression(EXPRESSIONS[name]);
      const pupilR = MARK_R * PUPIL_FRAC * e.pupilScale;
      const aimed = clampPupil(e.curve, e.wedge, pupilR, e.pupilX, e.pupilY);
      // The resting pupil is a real choice, not a value the clamp rescued.
      expect(aimed.x, `${name} pupilX`).toBeCloseTo(e.pupilX, 6);
      expect(aimed.y, `${name} pupilY`).toBeCloseTo(e.pupilY, 6);
    }
  });

  it('reads the pupil at rest, and the lid shape still reads too', () => {
    for (const name of EXPRESSION_NAMES) {
      const e = normalizeExpression(EXPRESSIONS[name]);
      const state: EyeState = {
        ...e,
        gazeX: e.pupilX,
        gazeY: e.pupilY,
        pupilR: MARK_R * PUPIL_FRAC * e.pupilScale,
      };
      const { visible, markArea } = pupilRead(state);
      expect(visible, `${name} pupil visible`).toBeGreaterThan(0.6);
      // …and the expression is still an expression: only neutral and
      // surprised leave the disc uncut.
      const full = Math.PI * MARK_R * MARK_R;
      if (name === 'happy' || name === 'sad' || name === 'angry') {
        expect(markArea, `${name} lid cuts the disc`).toBeLessThan(full * 0.75);
      }
    }
  });

  it('holds the legibility floor on openness — sleepy is the one exception', () => {
    for (const name of EXPRESSION_NAMES) {
      const openness = EXPRESSIONS[name].openness;
      if (name === 'sleepy') expect(openness).toBeLessThan(0.3);
      else expect(openness, `${name} openness`).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('emotes move the pupil', () => {
  it('never lets an emote swallow the pupil, at any seed, on any frame', () => {
    for (const seed of SEEDS) {
      for (const name of EMOTE_NAMES) {
        // Every eighth frame — the lids and the pupil both glide, so the
        // sampled frames bracket everything in between.
        const worst = Math.min(
          ...traceEmote(name, seed)
            .filter((_, i) => i % 8 === 0)
            .map((state) => pupilRead(state).visible),
        );
        expect(worst, `${name} @ ${seed} worst pupil visibility`).toBeGreaterThan(0.5);
      }
    }
  });

  it('moves the pupil across every emote — no emote parks it', () => {
    for (const seed of SEEDS) {
      for (const name of EMOTE_NAMES) {
        const states = traceEmote(name, seed);
        const xs = states.map((s) => s.gazeX);
        const ys = states.map((s) => s.gazeY);
        const travel = states
          .slice(1)
          .reduce(
            (sum, s, i) => sum + Math.hypot(s.gazeX - states[i]!.gazeX, s.gazeY - states[i]!.gazeY),
            0,
          );
        const range = Math.max(
          Math.max(...xs) - Math.min(...xs),
          Math.max(...ys) - Math.min(...ys),
        );
        expect(range, `${name} @ ${seed} gaze range`).toBeGreaterThan(0.05);
        expect(travel, `${name} @ ${seed} gaze path`).toBeGreaterThan(0.1);
      }
    }
  });

  it('gives each emote its own pupil signature, not one shared wobble', () => {
    const mean = (name: (typeof EMOTE_NAMES)[number]): { x: number; y: number } => {
      const states = traceEmote(name, 7);
      return {
        x: states.reduce((a, s) => a + s.gazeX, 0) / states.length,
        y: states.reduce((a, s) => a + s.gazeY, 0) / states.length,
      };
    };
    const m = Object.fromEntries(EMOTE_NAMES.map((n) => [n, mean(n)])) as Record<
      (typeof EMOTE_NAMES)[number],
      { x: number; y: number }
    >;
    // Up for the bright ones, down for the heavy ones — the axis the whole
    // grammar hangs on.
    for (const up of ['happy', 'dance', 'wave', 'surprised'] as const) {
      expect(m[up].y, `${up} looks up`).toBeGreaterThan(0.02);
    }
    for (const down of ['sad', 'sleepy', 'angry'] as const) {
      expect(m[down].y, `${down} casts down`).toBeLessThan(-0.02);
    }
    // Sad sinks further than angry, which only narrows.
    expect(m.sad.y).toBeLessThan(m.angry.y);
    // Wave glances aside; the other happy-lidded emotes do not hold a side.
    expect(m.wave.x).toBeGreaterThan(m.happy.x);
    expect(m.wave.x).toBeGreaterThan(m.dance.x);
  });

  it('gives dance the widest sweep and holds surprised near its stare', () => {
    const spread = (name: (typeof EMOTE_NAMES)[number], seed: number): number => {
      const xs = traceEmote(name, seed).map((state) => state.gazeX);
      return Math.max(...xs) - Math.min(...xs);
    };
    for (const seed of SEEDS) {
      const dance = spread('dance', seed);
      for (const other of EMOTE_NAMES) {
        // Sleepy is out of this comparison: it is the longest emote, so its
        // ambient drift has the most time to roam. Among the emotes that
        // ACT, dance's S-figure is the widest pupil travel in the set.
        if (other === 'dance' || other === 'sleepy') continue;
        expect(dance, `dance vs ${other} @ ${seed}`).toBeGreaterThan(spread(other, seed));
      }
      // The fixed stare: the smallest sweep of the emotes that stay open —
      // but never zero, because the wander floor runs under everything.
      const surprised = spread('surprised', seed);
      expect(surprised, `surprised @ ${seed}`).toBeGreaterThan(0);
      expect(surprised, `surprised vs dance @ ${seed}`).toBeLessThan(dance / 2);
    }
  });

  it('never cuts the pupil from one place to another', () => {
    // No hard cuts (TASTE §2.1, confidence 1.00). Every frame-to-frame step
    // is a spring's own motion or a lid pushing the pupil ahead of it —
    // both continuous, both small at 60fps.
    for (const seed of SEEDS) {
      for (const name of EMOTE_NAMES) {
        const states = traceEmote(name, seed);
        for (let i = 1; i < states.length; i++) {
          const step = Math.hypot(
            states[i]!.gazeX - states[i - 1]!.gazeX,
            states[i]!.gazeY - states[i - 1]!.gazeY,
          );
          expect(step, `${name} @ ${seed} frame ${i}`).toBeLessThan(0.12);
        }
      }
    }
  });

  it('keeps drifting after the emote releases (the ambient floor)', () => {
    const material = new MeshPhysicalMaterial();
    const eyes = applyEyes(material, EYE_ANALYSIS, 7);
    const run = runEmote(bodySprings(), 'happy', {
      onExpression: (e) => eyes.setExpression(e),
      onGaze: (x, y) => eyes.setGaze(x, y),
    });
    for (let t = 0; t < MOTION.primaryMs * 3; t += 16) {
      run.update(16);
      eyes.update(16);
    }
    const settled = eyes.state();
    for (let t = 0; t < MOTION.ambientMs; t += 16) eyes.update(16);
    const later = eyes.state();
    expect(Math.hypot(later.gazeX - settled.gazeX, later.gazeY - settled.gazeY)).toBeGreaterThan(0);
    eyes.dispose();
    material.dispose();
  });

  it('runs every eye spring at zeta >= 1', () => {
    const material = new MeshPhysicalMaterial();
    const eyes = applyEyes(material, EYE_ANALYSIS, 7);
    for (const name of EMOTE_NAMES) {
      const run = runEmote(bodySprings(), name, {
        onExpression: (e) => eyes.setExpression(e),
        onGaze: (x, y) => eyes.setGaze(x, y),
      });
      for (let t = 0; t < MOTION.primaryMs; t += 16) {
        run.update(16);
        eyes.update(16);
      }
    }
    expect(auditDamping()).toEqual([]);
    eyes.dispose();
    material.dispose();
  });

  it('keeps the ambient wander alive under every expression', () => {
    // Surprised damps its wander hardest — that is what sells a fixed stare
    // — but no expression may switch it off. Nothing fully arrests.
    for (const name of EXPRESSION_NAMES) {
      const wander = normalizeExpression(EXPRESSIONS[name]).wander;
      expect(wander, `${name} wander`).toBeGreaterThan(0);
      expect(EXPRESSIONS.surprised.wander, `${name} vs surprised`).toBeLessThanOrEqual(wander);
    }
  });
});
