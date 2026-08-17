/**
 * Behavior state machine (src/behavior/states.ts) — pure tests.
 *
 * The load-bearing checks: determinism from the injected rand stream, the
 * stillness rule (stationary states dominate expected time with a neutral
 * personality), duration ranges in token multiples, and the structural
 * transition rules (follow needs approach, sleep grows out of settled
 * states, affordances gate approach/observe).
 */

import { describe, expect, it } from 'vitest';
import type { Personality } from '../../src/behavior/personality';
import {
  makeRand,
  nextState,
  NOTICE_RADIUS,
  STATE_DURATION_AMBIENT,
  STATIONARY_STATES,
  type BehaviorContext,
  type BehaviorState,
} from '../../src/behavior/states';
import { MOTION } from '../../src/taste/tokens';

const NEUTRAL: Personality = {
  energy: 0.5,
  curiosity: 0.5,
  social: 0.5,
  playfulness: 0.5,
  sleepiness: 0.5,
};

function ctx(overrides: Partial<BehaviorContext> = {}): BehaviorContext {
  return {
    nearestCreatureDist: Infinity,
    nearestPropDist: Infinity,
    timeInState: 0,
    ...overrides,
  };
}

/** Run n transitions from idle, returning the visited sequence. */
function runSequence(
  seed: number,
  n: number,
  context: BehaviorContext,
  personality: Personality = NEUTRAL,
): { state: BehaviorState; durationMs: number }[] {
  const rand = makeRand(seed);
  const out: { state: BehaviorState; durationMs: number }[] = [];
  let current: BehaviorState = 'idle';
  for (let i = 0; i < n; i++) {
    const choice = nextState(current, personality, context, rand);
    out.push(choice);
    current = choice.state;
  }
  return out;
}

describe('makeRand', () => {
  it('is a deterministic [0, 1) stream', () => {
    const a = makeRand(1234);
    const b = makeRand(1234);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds decorrelate', () => {
    const a = makeRand(1);
    const b = makeRand(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a() === b()) same++;
    expect(same).toBeLessThan(5);
  });
});

describe('nextState', () => {
  it('same seed → same state sequence over 200 evaluated transitions', () => {
    const context = ctx({ nearestCreatureDist: 4, nearestPropDist: 3 });
    const a = runSequence(77, 200, context);
    const b = runSequence(77, 200, context);
    expect(a).toEqual(b);
  });

  it('different seeds produce different sequences', () => {
    const context = ctx();
    const a = runSequence(1, 50, context).map((c) => c.state);
    const b = runSequence(2, 50, context).map((c) => c.state);
    expect(a).not.toEqual(b);
  });

  it('durations land inside each state token range; sit/sleep run 4-10× ambient', () => {
    const context = ctx({ nearestCreatureDist: 4, nearestPropDist: 3 });
    for (const choice of runSequence(31, 400, context)) {
      const [min, max] = STATE_DURATION_AMBIENT[choice.state];
      expect(choice.durationMs).toBeGreaterThanOrEqual(min * MOTION.ambientMs);
      expect(choice.durationMs).toBeLessThanOrEqual(max * MOTION.ambientMs);
      if (choice.state === 'sit' || choice.state === 'sleep') {
        expect(choice.durationMs).toBeGreaterThanOrEqual(4 * MOTION.ambientMs);
        expect(choice.durationMs).toBeLessThanOrEqual(10 * MOTION.ambientMs);
      }
    }
  });

  it('never picks approach/follow with no peer in notice range', () => {
    const context = ctx({ nearestCreatureDist: NOTICE_RADIUS + 1 });
    for (const choice of runSequence(5, 300, context)) {
      expect(choice.state).not.toBe('approach');
      expect(choice.state).not.toBe('follow');
    }
  });

  it('never picks observe with no prop in range', () => {
    const context = ctx({ nearestPropDist: Infinity });
    for (const choice of runSequence(6, 300, context)) {
      expect(choice.state).not.toBe('observe');
    }
  });

  it('follow only continues out of approach or follow', () => {
    const context = ctx({ nearestCreatureDist: 3 });
    const rand = makeRand(9);
    let current: BehaviorState = 'idle';
    for (let i = 0; i < 500; i++) {
      const choice = nextState(current, NEUTRAL, context, rand);
      if (choice.state === 'follow') {
        expect(current === 'approach' || current === 'follow').toBe(true);
      }
      current = choice.state;
    }
  });

  it('sleep only grows out of settled states (idle/sit/observe)', () => {
    const context = ctx({ nearestCreatureDist: 3, nearestPropDist: 3 });
    const rand = makeRand(11);
    let current: BehaviorState = 'idle';
    for (let i = 0; i < 800; i++) {
      const choice = nextState(current, NEUTRAL, context, rand);
      if (choice.state === 'sleep') {
        expect(['idle', 'sit', 'observe']).toContain(current);
      }
      current = choice.state;
    }
  });

  it('a social personality approaches more than a solitary one', () => {
    const context = ctx({ nearestCreatureDist: 3 });
    const social: Personality = { ...NEUTRAL, social: 0.95 };
    const solitary: Personality = { ...NEUTRAL, social: 0.05 };
    const count = (p: Personality): number =>
      runSequence(21, 400, context, p).filter(
        (c) => c.state === 'approach' || c.state === 'follow',
      ).length;
    expect(count(social)).toBeGreaterThan(count(solitary) * 1.5);
  });

  it('stillness dominates: neutral personality, 10 simulated minutes → ≥ 55% stationary', () => {
    // Simulate by state-duration accounting: transitions fire on completion,
    // so summing chosen durations IS the simulated clock. Peers and props in
    // range makes this the hardest case (movement states all available).
    const context = ctx({ nearestCreatureDist: 4, nearestPropDist: 3 });
    for (const seed of [3, 17, 101, 4242]) {
      const rand = makeRand(seed);
      let current: BehaviorState = 'idle';
      let total = 0;
      let stationary = 0;
      while (total < 10 * 60 * 1000) {
        const choice = nextState(current, NEUTRAL, context, rand);
        total += choice.durationMs;
        if (STATIONARY_STATES.has(choice.state)) stationary += choice.durationMs;
        current = choice.state;
      }
      expect(stationary / total).toBeGreaterThanOrEqual(0.55);
    }
  });

  it('high-energy personality still moves noticeably more than neutral', () => {
    const context = ctx();
    const lively: Personality = { ...NEUTRAL, energy: 0.95 };
    const fractionMoving = (p: Personality): number => {
      const rand = makeRand(63);
      let current: BehaviorState = 'idle';
      let total = 0;
      let moving = 0;
      while (total < 10 * 60 * 1000) {
        const choice = nextState(current, p, context, rand);
        total += choice.durationMs;
        if (!STATIONARY_STATES.has(choice.state)) moving += choice.durationMs;
        current = choice.state;
      }
      return moving / total;
    };
    expect(fractionMoving(lively)).toBeGreaterThan(fractionMoving(NEUTRAL));
  });
});
