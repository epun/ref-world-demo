/**
 * Behavior state machine (GENERATOR.md §Behavior) — PURE.
 *
 * "Stillness is a state, not an absence." The machine is a probability table
 * over eight states, biased by the hidden Personality and evaluated only when
 * the current state completes. Each state carries a seeded duration drawn
 * from a range expressed in MOTION-token multiples (ambientMs units); sit and
 * sleep run long, 4-10× ambientMs.
 *
 * STILLNESS RULE: with a neutral personality the expected fraction of time
 * spent in the stationary states (idle / look-around / sit / sleep / observe)
 * is ≥ 55%. The stillness-dominance test in test/behavior/ holds this as a
 * regression gate — retune the weights against it, never past it.
 *
 * Determinism: every draw comes from an injected rand01 stream (seeded LCG,
 * makeRand). No Math.random. Same seed → same life, on every device.
 *
 * No Three.js, no DOM, no clocks.
 */

import { MOTION } from '../taste/tokens';
import type { Personality } from './personality';

export type BehaviorState =
  | 'idle'
  | 'wander'
  | 'look-around'
  | 'approach'
  | 'follow'
  | 'observe'
  | 'sit'
  | 'sleep';

/** States in which the creature does not travel. Their combined expected
 * time share must dominate (see header). */
export const STATIONARY_STATES: ReadonlySet<BehaviorState> = new Set([
  'idle',
  'look-around',
  'observe',
  'sit',
  'sleep',
]);

/** A peer inside this radius can be noticed (approach/follow become
 * available). World units. */
export const NOTICE_RADIUS = 7;

/** A prop inside this radius affords 'observe'. World units. */
export const OBSERVE_RANGE = 6;

/** What the machine can see of the world when a state completes. Distances
 * are world units; Infinity means "none in range / none known". */
export interface BehaviorContext {
  nearestCreatureDist: number;
  nearestPropDist: number;
  /** ms spent in the state that just completed. */
  timeInState: number;
}

export interface StateChoice {
  state: BehaviorState;
  /** How long the chosen state runs before the next evaluation, ms. */
  durationMs: number;
}

/**
 * Seeded LCG → deterministic [0, 1) stream. One stream per creature; every
 * behavioral draw (transitions, durations, targets, emote gates) pulls from
 * it, so a creature's whole life replays from its seed.
 */
export function makeRand(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) ^ 0x9e3779b9) >>> 0;
  if (s === 0) s = 0x1a2b3c4d;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Duration ranges in ambientMs multiples [min, max]. Sit/sleep run long. */
export const STATE_DURATION_AMBIENT: Record<BehaviorState, readonly [number, number]> = {
  idle: [2, 4],
  wander: [2, 4],
  'look-around': [1, 2],
  approach: [1, 2],
  follow: [1, 3],
  observe: [2, 4],
  sit: [4, 10],
  sleep: [4, 10],
};

function drawDuration(state: BehaviorState, rand01: () => number): number {
  const [min, max] = STATE_DURATION_AMBIENT[state];
  return (min + (max - min) * rand01()) * MOTION.ambientMs;
}

/**
 * Transition weights out of `current`, biased by personality per the
 * GENERATOR table:
 *   friends   → social↑ playfulness↗   (approach/follow grow)
 *   snacks    → curiosity↗             (observe/look-around grow)
 *   sleep     → sleepiness↑ energy↓    (sit/sleep grow, wander shrinks)
 *   adventure → energy↑ curiosity↑     (wander grows, roams far — steering)
 *   chaos     → playfulness↑ energy↗   (motion + follow grow, wider jitter)
 *
 * Structural rules:
 *   - approach/follow need a peer inside NOTICE_RADIUS; observe needs a prop
 *     inside OBSERVE_RANGE (environmental affordance).
 *   - follow only continues out of approach/follow (you follow someone you
 *     already walked toward — never a cold start).
 *   - sleep only grows out of settled states (idle/sit/observe): creatures
 *     wind down, they don't drop.
 *   - completed one-shot states don't immediately repeat (approach twice in
 *     a row reads pushy; look-around twice is a nervous tic). idle, wander
 *     and follow may continue.
 */
function transitionWeights(
  current: BehaviorState,
  p: Personality,
  context: BehaviorContext,
): Record<BehaviorState, number> {
  const peerNear = context.nearestCreatureDist <= NOTICE_RADIUS;
  const propNear = context.nearestPropDist <= OBSERVE_RANGE;

  const w: Record<BehaviorState, number> = {
    idle: 3,
    'look-around': 1.6 * (0.6 + 0.8 * p.curiosity),
    wander: 2.6 * (0.35 + 1.3 * p.energy) * (0.8 + 0.4 * p.playfulness),
    approach: peerNear ? 1.6 * (0.2 + 1.8 * p.social) : 0,
    follow: 0,
    observe: propNear ? 1.4 * (0.4 + 1.6 * p.curiosity) : 0,
    sit: 1.2 * (0.5 + p.sleepiness + 0.6 * (1 - p.energy)),
    sleep: 0,
  };

  if ((current === 'approach' || current === 'follow') && peerNear) {
    w.follow = 1.2 * (0.3 + p.social + 0.7 * p.playfulness);
  }
  if (current === 'idle' || current === 'sit' || current === 'observe') {
    w.sleep = 0.15 + 1.85 * p.sleepiness;
  }
  // One-shot states never repeat back-to-back.
  if (current !== 'idle' && current !== 'wander' && current !== 'follow') {
    w[current] = 0;
  }
  return w;
}

/**
 * Evaluate the table on state completion. Personality biases weights only —
 * every state stays reachable in principle; nothing is scripted.
 */
export function nextState(
  current: BehaviorState,
  personality: Personality,
  context: BehaviorContext,
  rand01: () => number,
): StateChoice {
  const w = transitionWeights(current, personality, context);
  let total = 0;
  for (const state of Object.keys(w) as BehaviorState[]) total += w[state];

  // Degenerate table (should not happen) → settle into idle.
  if (total <= 0) return { state: 'idle', durationMs: drawDuration('idle', rand01) };

  let pick = rand01() * total;
  let chosen: BehaviorState = 'idle';
  for (const state of Object.keys(w) as BehaviorState[]) {
    pick -= w[state];
    if (pick < 0) {
      chosen = state;
      break;
    }
  }
  return { state: chosen, durationMs: drawDuration(chosen, rand01) };
}
