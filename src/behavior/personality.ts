/**
 * Hidden personality (GENERATOR.md §Behavior).
 *
 * Five traits in [0, 1] bias the behavior state machine's transition
 * probabilities — and nothing else. Personality is never inspectable in UI;
 * it is only experienced ("that little one is mine" … "what is it doing?").
 *
 * Derived deterministically from the audience personality answer plus a
 * per-creature seed: same answer + same seed → the same creature on every
 * device. Hash-noise only — no Math.random anywhere in src/behavior/.
 *
 * PURE: no Three.js, no DOM.
 */

export interface Personality {
  energy: number;
  curiosity: number;
  social: number;
  playfulness: number;
  sleepiness: number;
}

/** The audience answer to "what does your little creature want most?". */
export type PersonalityChoice =
  | 'friends'
  | 'snacks'
  | 'sleep'
  | 'adventure'
  | 'chaos'
  | null;

export const TRAIT_NAMES = [
  'energy',
  'curiosity',
  'social',
  'playfulness',
  'sleepiness',
] as const satisfies readonly (keyof Personality)[];

/** Neutral midpoint every derivation jitters around. */
export const NEUTRAL_TRAIT = 0.5;

/** Seeded jitter half-width: mild by default, wider for chaos (per the
 * GENERATOR table — chaos raises transition noise). */
export const JITTER_MILD = 0.08;
export const JITTER_CHAOS = 0.2;

/**
 * The GENERATOR mapping (docs/GENERATOR.md §Behavior). ↑ is a strong push,
 * ↗ a lighter one. Biases are added to the jittered neutral and clamped.
 */
const CHOICE_BIAS: Record<
  Exclude<PersonalityChoice, null>,
  Partial<Personality>
> = {
  friends: { social: 0.34, playfulness: 0.18 },
  snacks: { curiosity: 0.22 },
  sleep: { sleepiness: 0.34, energy: -0.28 },
  adventure: { energy: 0.3, curiosity: 0.26 },
  chaos: { playfulness: 0.3, energy: 0.18 },
};

/** Deterministic hash → [0, 1). Same construction as the ambient drift's
 * value-noise hash, decorrelated per trait channel. */
function hash01(seed: number, channel: number): number {
  const x = Math.sin(seed * 127.1 + channel * 311.7 + 74.7) * 43758.5453123;
  return x - Math.floor(x);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Derive a Personality from the audience answer and a per-creature seed.
 * null (no answer / unknown value on the wire) → mild seeded variation
 * around the 0.5 neutral, so even default creatures differ a little.
 */
export function personalityFromChoice(
  choice: PersonalityChoice,
  seed: number,
): Personality {
  const jitter = choice === 'chaos' ? JITTER_CHAOS : JITTER_MILD;
  const bias = choice ? CHOICE_BIAS[choice] : {};
  const out = {} as Personality;
  TRAIT_NAMES.forEach((trait, i) => {
    const noise = (hash01(seed, i) * 2 - 1) * jitter;
    out[trait] = clamp01(NEUTRAL_TRAIT + noise + (bias[trait] ?? 0));
  });
  return out;
}
