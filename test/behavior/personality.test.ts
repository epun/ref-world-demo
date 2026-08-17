/**
 * Personality derivation (src/behavior/personality.ts) — pure tests.
 *
 * The GENERATOR table gives directions, not exact values: each audience
 * answer must push its traits the right way relative to neutral, the null
 * answer must stay a mild seeded scatter around 0.5, and everything must be
 * deterministic from the seed (no Math.random anywhere).
 */

import { describe, expect, it } from 'vitest';
import {
  JITTER_CHAOS,
  JITTER_MILD,
  NEUTRAL_TRAIT,
  personalityFromChoice,
  TRAIT_NAMES,
  type Personality,
  type PersonalityChoice,
} from '../../src/behavior/personality';

const SEEDS = Array.from({ length: 200 }, (_, i) => i * 977 + 13);

function sample(choice: PersonalityChoice): Personality[] {
  return SEEDS.map((seed) => personalityFromChoice(choice, seed));
}

function stddev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

describe('personalityFromChoice', () => {
  it('keeps every trait in [0, 1] for every choice and seed', () => {
    const choices: PersonalityChoice[] = [
      'friends',
      'snacks',
      'sleep',
      'adventure',
      'chaos',
      null,
    ];
    for (const choice of choices) {
      for (const p of sample(choice)) {
        for (const trait of TRAIT_NAMES) {
          expect(p[trait]).toBeGreaterThanOrEqual(0);
          expect(p[trait]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('is deterministic: same choice + same seed → identical personality', () => {
    for (const seed of [1, 42, 987654]) {
      expect(personalityFromChoice('sleep', seed)).toEqual(
        personalityFromChoice('sleep', seed),
      );
      expect(personalityFromChoice(null, seed)).toEqual(
        personalityFromChoice(null, seed),
      );
    }
  });

  it('sleep → sleepiness above neutral, energy below (every seed)', () => {
    for (const p of sample('sleep')) {
      expect(p.sleepiness).toBeGreaterThan(NEUTRAL_TRAIT + 0.1);
      expect(p.energy).toBeLessThan(NEUTRAL_TRAIT - 0.1);
    }
  });

  it('friends → social up strongly, playfulness up lightly', () => {
    for (const p of sample('friends')) {
      expect(p.social).toBeGreaterThan(NEUTRAL_TRAIT + 0.1);
      expect(p.playfulness).toBeGreaterThan(NEUTRAL_TRAIT);
    }
  });

  it('snacks → curiosity up', () => {
    for (const p of sample('snacks')) {
      expect(p.curiosity).toBeGreaterThan(NEUTRAL_TRAIT);
    }
  });

  it('adventure → energy and curiosity up', () => {
    for (const p of sample('adventure')) {
      expect(p.energy).toBeGreaterThan(NEUTRAL_TRAIT + 0.1);
      expect(p.curiosity).toBeGreaterThan(NEUTRAL_TRAIT);
    }
  });

  it('chaos → playfulness up, energy leaning up', () => {
    const all = sample('chaos');
    for (const p of all) {
      expect(p.playfulness).toBeGreaterThan(NEUTRAL_TRAIT - JITTER_CHAOS + 0.29);
    }
    const meanEnergy = all.reduce((a, p) => a + p.energy, 0) / all.length;
    expect(meanEnergy).toBeGreaterThan(NEUTRAL_TRAIT + 0.1);
  });

  it('chaos jitters wider than the mild choices (transition noise up)', () => {
    // social carries no chaos bias, so its spread isolates the jitter width.
    const chaosSpread = stddev(sample('chaos').map((p) => p.social));
    const nullSpread = stddev(sample(null).map((p) => p.social));
    expect(chaosSpread).toBeGreaterThan(nullSpread * 1.5);
  });

  it('null → mild variation around neutral, and seeds differ', () => {
    const all = sample(null);
    for (const p of all) {
      for (const trait of TRAIT_NAMES) {
        expect(Math.abs(p[trait] - NEUTRAL_TRAIT)).toBeLessThanOrEqual(
          JITTER_MILD + 1e-9,
        );
      }
    }
    const energies = new Set(all.map((p) => p.energy));
    expect(energies.size).toBeGreaterThan(SEEDS.length / 2);
  });
});
