/**
 * Emotes — pure tests over the choreography data, the frame-driven
 * scheduler, and the CPU twin of the body deformation (deform.ts +
 * emotes.ts). No renderer anywhere: springs are recorders, the scheduler
 * advances only on fed dt, and deformPoint is plain math.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFORM_CHANNELS,
  MIN_SQUASH,
  NEUTRAL_DEFORM,
  deformPoint,
  heightFrac,
  type DeformFrame,
  type DeformState,
} from '../../src/character/deform';
import {
  EMOTES,
  runEmote,
  type EmoteKeypoint,
  type EmoteSprings,
} from '../../src/character/emotes';
import { EXPRESSIONS } from '../../src/character/expressions';
import type { ExpressionName } from '../../src/character/expressions';
import { EMOTE_NAMES } from '../../src/net/protocol';
import { MOTION } from '../../src/taste/tokens';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True when ms is a positive sum a·tertiary + b·secondary + c·primary. */
function isTokenSum(ms: number): boolean {
  if (ms <= 0) return false;
  const { tertiaryMs: t3, secondaryMs: t2, primaryMs: t1 } = MOTION;
  for (let c = 0; c * t1 <= ms; c++) {
    for (let b = 0; b * t2 + c * t1 <= ms; b++) {
      const rest = ms - b * t2 - c * t1;
      if (rest % t3 === 0) return true;
    }
  }
  return false;
}

interface Emission {
  channel: string;
  value: number;
}

function makeRecorder(): { log: Emission[]; springs: EmoteSprings } {
  const log: Emission[] = [];
  const springs = Object.fromEntries(
    DEFORM_CHANNELS.map((channel) => [
      channel,
      { retarget: (value: number) => log.push({ channel, value }) },
    ]),
  ) as unknown as EmoteSprings;
  return { log, springs };
}

/** The emissions a keypoint should produce, in channel-declaration order. */
function keypointEmissions(kp: EmoteKeypoint): Emission[] {
  const out: Emission[] = [];
  for (const channel of DEFORM_CHANNELS) {
    const value = kp[channel];
    if (value !== undefined) out.push({ channel, value });
  }
  return out;
}

const NEUTRAL_EMISSIONS: Emission[] = DEFORM_CHANNELS.map((channel) => ({
  channel,
  value: NEUTRAL_DEFORM[channel],
}));

const FRAME: DeformFrame = { baseY: 0, height: 2 };

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

describe('emote scripts', () => {
  it('covers every EMOTE_NAME, exactly', () => {
    for (const name of EMOTE_NAMES) {
      expect(EMOTES[name]).toBeDefined();
      expect(EMOTES[name].envelope.length).toBeGreaterThan(0);
    }
    expect(Object.keys(EMOTES).sort()).toEqual([...EMOTE_NAMES].sort());
  });

  it('uses only known eye expressions', () => {
    for (const name of EMOTE_NAMES) {
      expect(EXPRESSIONS[EMOTES[name].expression]).toBeDefined();
    }
  });

  it('keypoint times are positive token sums, strictly ascending', () => {
    for (const name of EMOTE_NAMES) {
      const env = EMOTES[name].envelope;
      let prev = 0;
      for (const kp of env) {
        expect(kp.atMs, `${name} atMs ${kp.atMs}`).toBeGreaterThan(0);
        expect(isTokenSum(kp.atMs), `${name} atMs ${kp.atMs} is a token sum`).toBe(true);
        expect(kp.atMs, `${name} sorted`).toBeGreaterThan(prev);
        prev = kp.atMs;
      }
    }
  });

  it('every keypoint carries at least one channel', () => {
    for (const name of EMOTE_NAMES) {
      for (const kp of EMOTES[name].envelope) {
        expect(keypointEmissions(kp).length).toBeGreaterThan(0);
      }
    }
  });

  it('stays inside sane whole-body bounds (single arcs, not contortions)', () => {
    for (const name of EMOTE_NAMES) {
      for (const kp of EMOTES[name].envelope) {
        if (kp.squash !== undefined) {
          expect(kp.squash).toBeGreaterThan(0.5);
          expect(kp.squash).toBeLessThanOrEqual(1.1);
        }
        for (const angle of [kp.leanX, kp.leanZ, kp.twist]) {
          if (angle !== undefined) expect(Math.abs(angle)).toBeLessThan(0.5);
        }
        if (kp.reach !== undefined) {
          expect(kp.reach).toBeGreaterThanOrEqual(0);
          expect(kp.reach).toBeLessThan(0.3);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

describe('runEmote scheduler', () => {
  it('emits keypoint 0 and the expression at trigger', () => {
    const { log, springs } = makeRecorder();
    const seen: ExpressionName[] = [];
    runEmote(springs, 'happy', { onExpression: (e) => seen.push(e) });
    expect(seen).toEqual([EMOTES.happy.expression]);
    expect(log).toEqual(keypointEmissions(EMOTES.happy.envelope[0]!));
  });

  it('emits retargets in envelope order under stepped dt, then releases to neutral', () => {
    for (const name of EMOTE_NAMES) {
      const { log, springs } = makeRecorder();
      const seen: ExpressionName[] = [];
      const run = runEmote(springs, name, { onExpression: (e) => seen.push(e) });

      // Advance in awkward, non-token steps until done (bounded).
      let done = false;
      for (let i = 0; i < 200 && !done; i++) done = run.update(97);
      expect(done).toBe(true);
      expect(run.done).toBe(true);

      const expected = [
        ...EMOTES[name].envelope.flatMap(keypointEmissions),
        ...NEUTRAL_EMISSIONS,
      ];
      expect(log, name).toEqual(expected);
      expect(seen, name).toEqual([EMOTES[name].expression, 'neutral']);

      // After release: no further emissions, update stays done.
      const len = log.length;
      expect(run.update(1000)).toBe(true);
      expect(log.length).toBe(len);
    }
  });

  it('fires each keypoint only once its predecessor deadline has passed', () => {
    const { log, springs } = makeRecorder();
    const run = runEmote(springs, 'sad', { onExpression: () => {} });
    const env = EMOTES.sad.envelope;
    const first = keypointEmissions(env[0]!);
    expect(log.length).toBe(first.length);

    // Just before the first deadline: nothing new.
    run.update(env[0]!.atMs - 1);
    expect(log.length).toBe(first.length);

    // Crossing it: keypoint 1 fires.
    run.update(2);
    expect(log.length).toBe(first.length + keypointEmissions(env[1]!).length);
    expect(run.done).toBe(false);
  });

  it('is deterministic given the same dt sequence', () => {
    const steps = [16, 33, 7, 250, 16, 900, 1200, 16, 16, 2000];
    const a = makeRecorder();
    const b = makeRecorder();
    const runA = runEmote(a.springs, 'dance');
    const runB = runEmote(b.springs, 'dance');
    for (const dt of steps) {
      expect(runA.update(dt)).toBe(runB.update(dt));
    }
    expect(a.log).toEqual(b.log);
  });
});

// ---------------------------------------------------------------------------
// deformPoint — the CPU twin of the vertex shader
// ---------------------------------------------------------------------------

describe('deformPoint', () => {
  const samples = [
    { x: 0.3, y: 0.1, z: -0.2 },
    { x: -0.5, y: 1.0, z: 0.4 },
    { x: 0.0, y: 1.9, z: 0.0 },
    { x: 0.2, y: -0.3, z: 0.1 }, // below the base — h clamps to 0
  ];

  it('is the identity at neutral uniforms', () => {
    for (const p of samples) {
      const d = deformPoint(p, NEUTRAL_DEFORM, FRAME);
      expect(d.x).toBeCloseTo(p.x, 12);
      expect(d.y).toBeCloseTo(p.y, 12);
      expect(d.z).toBeCloseTo(p.z, 12);
    }
  });

  it('squash preserves the sign of y and bulges x/z', () => {
    for (const squash of [0.5, 0.8, 0.99]) {
      const state: DeformState = { ...NEUTRAL_DEFORM, squash };
      for (const p of samples) {
        const d = deformPoint(p, state, FRAME);
        expect(Math.sign(d.y), `y sign at squash ${squash}`).toBe(Math.sign(p.y));
        // Volume feel: x/z grow by exactly 1/sqrt(squash).
        expect(Math.abs(d.x)).toBeCloseTo(Math.abs(p.x) / Math.sqrt(squash), 10);
        expect(Math.abs(d.z)).toBeCloseTo(Math.abs(p.z) / Math.sqrt(squash), 10);
        // And |y| shrinks toward the base.
        expect(Math.abs(d.y)).toBeLessThanOrEqual(Math.abs(p.y) + 1e-12);
      }
    }
    // The squash floor guards degenerate values.
    const flat = deformPoint({ x: 0, y: 1, z: 0 }, { ...NEUTRAL_DEFORM, squash: 0 }, FRAME);
    expect(flat.y).toBeCloseTo(MIN_SQUASH, 10);
  });

  it('twist angle increases monotonically with height', () => {
    const state: DeformState = { ...NEUTRAL_DEFORM, twist: 0.6 };
    let prev = -1;
    for (const y of [0.25, 0.75, 1.25, 1.75, 2.0]) {
      const d = deformPoint({ x: 0.5, y, z: 0 }, state, FRAME);
      // Recover the rotation angle about y from the displaced (x, z).
      const angle = Math.atan2(-d.z, d.x);
      expect(angle).toBeCloseTo(0.6 * heightFrac(y, FRAME), 10);
      expect(angle).toBeGreaterThan(prev);
      prev = angle;
    }
    // Above the frame top the ramp clamps — no runaway.
    const over = deformPoint({ x: 0.5, y: 5, z: 0 }, state, FRAME);
    expect(Math.atan2(-over.z, over.x)).toBeCloseTo(0.6, 10);
  });

  it('lean displacement increases monotonically with height (both axes)', () => {
    for (const [key, read] of [
      ['leanX', (d: { z: number }) => Math.abs(d.z)],
      ['leanZ', (d: { x: number }) => Math.abs(d.x)],
    ] as const) {
      const state: DeformState = { ...NEUTRAL_DEFORM, [key]: 0.4 };
      let prev = -1;
      for (const y of [0.25, 0.75, 1.25, 1.75, 2.0]) {
        const d = deformPoint({ x: 0, y, z: 0 }, state, FRAME);
        const off = read(d as { x: number; z: number });
        expect(off, `${key} at y=${y}`).toBeGreaterThan(prev);
        prev = off;
      }
    }
  });

  it('reach stretches only the upper half', () => {
    const state: DeformState = { ...NEUTRAL_DEFORM, reach: 0.2 };
    // Bottom half: untouched.
    for (const y of [0, 0.4, 1.0]) {
      const d = deformPoint({ x: 0, y, z: 0 }, state, FRAME);
      expect(d.y).toBeCloseTo(y, 12);
    }
    // Top: raised by the full reach fraction of the height.
    const top = deformPoint({ x: 0, y: 2, z: 0 }, state, FRAME);
    expect(top.y).toBeCloseTo(2 + 0.2 * FRAME.height, 12);
    // And in between, monotonically more lift with height.
    let prevLift = -1;
    for (const y of [1.1, 1.4, 1.7, 2.0]) {
      const d = deformPoint({ x: 0, y, z: 0 }, state, FRAME);
      const lift = d.y - y;
      expect(lift).toBeGreaterThan(prevLift);
      prevLift = lift;
    }
  });

  it('respects a non-zero base (deforms about frame.baseY, not world 0)', () => {
    const frame: DeformFrame = { baseY: -1, height: 2 };
    const state: DeformState = { ...NEUTRAL_DEFORM, squash: 0.5 };
    // The base itself never moves.
    const base = deformPoint({ x: 0, y: -1, z: 0 }, state, frame);
    expect(base.y).toBeCloseTo(-1, 12);
    // A point above the base compresses toward it.
    const mid = deformPoint({ x: 0, y: 0, z: 0 }, state, frame);
    expect(mid.y).toBeCloseTo(-1 + 1 * 0.5, 12);
  });
});
