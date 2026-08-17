/**
 * Gait controller (PLAN §3.5) — the pure phase/amplitude brain behind the
 * walk cycle. One phase scalar drives everything: the deform layer in
 * deform.ts turns it into alternating leg shear, a 2×-phase bob, and the
 * waddle roll (or, for the blob, a traveling undulation — the undulating
 * glide, never a hop).
 *
 * The controller owns two ζ≥1 springs:
 *  - amplitude follows speed, so starting and stopping blend the walk in and
 *    out as drifts — at speed 0 the amplitude settles to 0 and the body
 *    returns to the ambient floor alone.
 *  - step frequency follows speed / strideLength, so faster travel means
 *    faster steps, and slowing down ALSO slows the stride rather than
 *    freezing it.
 *
 * Stop-completion (hard constraint — nothing is cut off mid-gesture): when
 * speed reaches zero, the phase keeps advancing toward the NEAREST REST PHASE
 * ahead (a multiple of π — legs passing, body level, roll through center)
 * while any amplitude remains, and never past it. The last half-step
 * completes; the walk ends by arriving, not by stopping.
 *
 * Pure module: no Three.js, no DOM, no clock — update() advances only on the
 * dt it is fed, so a given (dt, speed) sequence is fully deterministic.
 */

import { Spring } from '../motion/spring';
import type { Archetype } from '../shape/types';
import { MOTION } from '../taste/tokens';
import type { GaitState } from './deform';

/** Per-archetype gait character (PLAN §3.5's table, as numbers). */
export interface GaitProfile {
  /** World units of travel per full step cycle (blob: one wavelength). */
  stride: number;
  /** Leg-swing shear amplitude, fraction of body height. Blob has none. */
  legShear: number;
  /** Body bob at 2× phase, fraction of height — small, ~1.5%. */
  bob: number;
  /** Roll toward the planted foot, radians. "The roll is the waddle" —
   * strongest for biped/bird, moderate quadruped, none for blob. */
  waddle: number;
  /** Blob undulation amplitude, fraction of height. Zero for leggy bodies. */
  undulate: number;
  /** Blob undulation wave number over the body height. */
  undulateK: number;
}

export const GAIT_PROFILES: Record<Archetype, GaitProfile> = {
  biped: { stride: 0.9, legShear: 0.12, bob: 0.015, waddle: 0.11, undulate: 0, undulateK: 0 },
  bird: { stride: 0.9, legShear: 0.12, bob: 0.015, waddle: 0.13, undulate: 0, undulateK: 0 },
  quadruped: {
    stride: 0.7,
    legShear: 0.1,
    bob: 0.015,
    waddle: 0.055,
    undulate: 0,
    undulateK: 0,
  },
  blob: {
    stride: 1.2,
    legShear: 0,
    bob: 0.008,
    waddle: 0,
    undulate: 0.05,
    undulateK: Math.PI * 2,
  },
} as const;

/** Speed (world units/s) at which the gait reaches full amplitude — just
 * under the agents' cruise, so a wandering creature walks at full read. */
export const FULL_AMP_SPEED = 0.9;

/** Below this speed the controller treats the creature as stopping. */
const SPEED_EPSILON = 1e-3;

/** Amplitude below which the layer no longer reads and phase may rest. */
const AMP_EPSILON = 1e-3;

/** Stop-completion floor: the remaining half-step drifts home over at most
 * one secondary settle — π radians per MOTION.secondaryMs. */
const REST_RATE = Math.PI / MOTION.secondaryMs;

export interface GaitController {
  /**
   * Advance by dt ms with the current ground speed (world units/s) and
   * heading (radians — reserved: the deform layer works in the mesh's local
   * travel frame, which the root's heading rotation already provides).
   * Returns the uniform values for this frame.
   */
  update(dt: number, speed: number, heading: number): GaitState;
  /** Unregister the springs (damping audit hygiene). */
  dispose(): void;
}

export function createGait(archetype: Archetype): GaitController {
  const profile = GAIT_PROFILES[archetype];

  // Amplitude blends the walk in/out as a drift (settles over a secondary);
  // frequency eases with it so deceleration slows the steps too.
  const ampSpring = new Spring(0, { settleMs: MOTION.secondaryMs });
  const freqSpring = new Spring(0, { settleMs: MOTION.secondaryMs });
  let phase = 0;

  return {
    update(dt: number, speed: number, _heading: number): GaitState {
      const s = Math.abs(speed);
      ampSpring.retarget(Math.min(1, s / FULL_AMP_SPEED));
      freqSpring.retarget(s / profile.stride);
      const amp = ampSpring.update(dt);
      const freq = Math.max(0, freqSpring.update(dt));

      if (s > SPEED_EPSILON) {
        // walking: phase rate = 2π × (speed-eased step frequency)
        phase += (2 * Math.PI * freq * dt) / 1000;
      } else if (amp > AMP_EPSILON) {
        // stopping: keep advancing toward the nearest rest phase ahead (a
        // multiple of π) and never past it — the last half-step completes
        // instead of freezing mid-stride.
        const rest = Math.ceil(phase / Math.PI - 1e-9) * Math.PI;
        const rate = Math.max((2 * Math.PI * freq) / 1000, REST_RATE);
        phase = Math.min(rest, phase + rate * dt);
      }

      return {
        phase,
        amp,
        legShear: profile.legShear,
        bob: profile.bob,
        waddle: profile.waddle,
        undulate: profile.undulate,
        undulateK: profile.undulateK,
      };
    },
    dispose(): void {
      ampSpring.dispose();
      freqSpring.dispose();
    },
  };
}
