/**
 * Emote choreography (PLAN §3.5, §6.3) — pure data + a frame-driven scheduler.
 *
 * Each of the seven emotes is one EmoteScript: an eye expression plus a body
 * envelope. The envelope is a schedule of SPRING RETARGETS, never a tween:
 * keypoint k's channel values are handed to the ζ≥1 springs when keypoint
 * k−1's deadline passes (keypoint 0 fires at trigger), and `atMs` is the
 * deadline the body drifts toward that pose until. After the last deadline
 * every channel retargets to neutral and the body settles into the ambient
 * drift floor — emotes end by drifting home, never by stopping.
 *
 * Choreography constraints (TASTE §2.1, confidence 1.00): every emote is a
 * SINGLE ARC — no oscillating loops that read as bounce, no repeats. Dance is
 * one slow S-figure, not a loop; wave is a held whole-body reach-lean (the
 * drawn character has no articulated arm — the whole body waves). All timing
 * is sums of MOTION tokens, never literals. And every frame stays a valid
 * corpus still: the deform channels move the whole silhouette; nothing here
 * can introduce interior detail.
 *
 * Pure module: no Three.js, no DOM, no timers — runEmote() advances only on
 * the dt the caller feeds it, so it is deterministic given a dt sequence.
 */

import type { EmoteName } from '../net/protocol';
import { MOTION } from '../taste/tokens';
import { DEFORM_CHANNELS, NEUTRAL_DEFORM, type DeformState } from './deform';
import type { ExpressionName } from './expressions';

/** One scheduled retarget: drift toward these channel values until atMs. */
export interface EmoteKeypoint extends Partial<DeformState> {
  /** Deadline, ms from trigger — always a positive sum of MOTION tokens. */
  atMs: number;
}

export interface EmoteScript {
  /** Eye expression set at trigger (eyes glide there on their own springs). */
  expression: ExpressionName;
  /** Keypoints, strictly ascending in atMs. */
  envelope: readonly EmoteKeypoint[];
}

const T3 = MOTION.tertiaryMs;
const T2 = MOTION.secondaryMs;
const T1 = MOTION.primaryMs;

/**
 * The seven emotes (protocol EMOTE_NAMES), each a single arc:
 *
 * - happy      gentle squash-down (quick, tertiary) then a tall drift back
 *              with a whisper of reach over a primary; release drifts the
 *              reach out. Down once, up once.
 * - sad        slow forward droop (secondary attack) held through a primary,
 *              then a long drift back upright.
 * - sleepy     one long squash settle over a primary — the body sinking into
 *              itself — held heavy for another, then released.
 * - angry      quick small coil (twist + forward lean + a hard-ish crouch,
 *              tertiary attack — the sharpest onset in the set) whose squash
 *              eases most of the way out while the coil holds, then a
 *              drifting release.
 * - surprised  the upper body reaches upward over a secondary (eyes go wide
 *              on their own springs), holds tall, then drifts back down.
 * - dance      ONE slow S-figure over 2× primary: lean left with a hint of
 *              twist, sweep through center to the right, then drift home.
 *              A single arc through center — not a loop.
 * - wave       whole-body wave: reach up + lean to the side, held over a
 *              primary, then a drifting release. No arm exists to articulate.
 */
export const EMOTES: Record<EmoteName, EmoteScript> = {
  happy: {
    expression: 'happy',
    envelope: [
      { atMs: T3, squash: 0.86 },
      { atMs: T3 + T1, squash: 1, reach: 0.05 },
    ],
  },
  sad: {
    expression: 'sad',
    envelope: [
      { atMs: T2, squash: 0.96, leanX: 0.24 },
      { atMs: T2 + T1, squash: 0.96, leanX: 0.24 },
    ],
  },
  sleepy: {
    expression: 'sleepy',
    envelope: [
      { atMs: T1, squash: 0.88, leanX: 0.1 },
      { atMs: T1 + T1, squash: 0.88, leanX: 0.1 },
    ],
  },
  angry: {
    expression: 'angry',
    envelope: [
      { atMs: T3, squash: 0.93, leanX: 0.12, twist: -0.22 },
      { atMs: T3 + T2, squash: 0.97, leanX: 0.12, twist: -0.22 },
    ],
  },
  surprised: {
    expression: 'surprised',
    envelope: [
      { atMs: T2, reach: 0.16 },
      { atMs: T2 + T2, reach: 0.16 },
    ],
  },
  dance: {
    expression: 'happy',
    envelope: [
      { atMs: T1, leanZ: 0.16, twist: 0.09 },
      { atMs: T1 + T1, leanZ: -0.16, twist: -0.09 },
    ],
  },
  wave: {
    expression: 'happy',
    envelope: [
      { atMs: T2, reach: 0.12, leanZ: -0.15 },
      { atMs: T2 + T1, reach: 0.12, leanZ: -0.15 },
    ],
  },
};

/** Anything with a retarget — a ζ≥1 Spring in production, a recorder in tests. */
export interface Retargetable {
  retarget(target: number): void;
}

/** One spring per deform channel; owned by the caller (character.ts). */
export type EmoteSprings = Record<keyof DeformState, Retargetable>;

export interface EmoteHooks {
  /** Called with the script's expression at trigger, 'neutral' at release. */
  onExpression?: (e: ExpressionName) => void;
}

/**
 * A running emote — the scheduler. character.update() advances it with dt;
 * it emits spring retargets at keypoint boundaries and reports done after
 * the release retarget. Frame-driven and deterministic: no timers, no clock,
 * only the dt sequence it is fed.
 */
export interface EmoteRun {
  readonly name: EmoteName;
  readonly done: boolean;
  /** Advance by dt ms. Returns true once the release has been emitted. */
  update(dt: number): boolean;
}

/**
 * Start an emote: sets the eye expression, emits keypoint 0's retargets
 * immediately, and returns the scheduler. Interruption is free by design —
 * starting a new run simply retargets the SAME springs mid-flight (position
 * and velocity carry over; nothing snaps), so callers just replace the old
 * run with the new one.
 */
export function runEmote(springs: EmoteSprings, name: EmoteName, hooks: EmoteHooks = {}): EmoteRun {
  const { expression, envelope } = EMOTES[name];
  let elapsed = 0;
  /** Next keypoint to emit; envelope[next] fires when envelope[next-1] passes. */
  let next = 1;
  let done = false;

  const emit = (kp: EmoteKeypoint): void => {
    for (const channel of DEFORM_CHANNELS) {
      const v = kp[channel];
      if (v !== undefined) springs[channel].retarget(v);
    }
  };

  const release = (): void => {
    for (const channel of DEFORM_CHANNELS) {
      springs[channel].retarget(NEUTRAL_DEFORM[channel]);
    }
    hooks.onExpression?.('neutral');
    done = true;
  };

  hooks.onExpression?.(expression);
  const first = envelope[0];
  if (first) emit(first);

  return {
    name,
    get done(): boolean {
      return done;
    },
    update(dt: number): boolean {
      if (done) return true;
      elapsed += dt;
      while (next < envelope.length && elapsed >= envelope[next - 1]!.atMs) {
        emit(envelope[next]!);
        next++;
      }
      const last = envelope[envelope.length - 1];
      if (!last || elapsed >= last.atMs) release();
      return done;
    },
  };
}
