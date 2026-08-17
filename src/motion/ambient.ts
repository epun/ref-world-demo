/**
 * The ambient drift floor (TASTE §3).
 *
 * "Settles by drifting, not springing back" is taken literally: a persistent
 * low-amplitude, low-frequency drift runs underneath everything on screen,
 * forever — including elements that have finished animating. This is what
 * separates "settles by drifting" from "settles". The stillness probe gate
 * samples idle elements and requires nonzero motion.
 *
 * Deterministic value-noise (hash-based, seeded per channel) rather than
 * Math.random, so two devices rendering the same entity drift identically.
 */

import { MOTION } from '../taste/tokens';

/** Cheap deterministic hash → [0, 1). */
function hash(n: number): number {
  let x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

/** 1D value noise: smooth interpolation between hashed lattice points. */
function valueNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  const a = hash(i * 127.1 + seed * 311.7);
  const b = hash((i + 1) * 127.1 + seed * 311.7);
  return (a + (b - a) * u) * 2 - 1; // [-1, 1]
}

export interface DriftSample {
  x: number;
  y: number;
  rot: number;
}

/**
 * Sample the ambient drift for an entity at time `nowMs`.
 *
 * @param seed   stable per-entity seed (e.g. hash of its id)
 * @param scale  the entity's world scale; amplitude is a fraction of it
 */
export function sampleDrift(nowMs: number, seed: number, scale: number): DriftSample {
  const t = nowMs / MOTION.ambientMs;
  const amp = scale * MOTION.ambientAmplitude;
  return {
    x: valueNoise(t, seed) * amp,
    y: valueNoise(t, seed + 1) * amp,
    rot: valueNoise(t * 0.7, seed + 2) * MOTION.ambientAmplitude,
  };
}
