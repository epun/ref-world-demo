/**
 * Reactive IK stepping (BLENDSHELL step 4) — the legs are two-part chains
 * (upper/lower capsule per leg) whose part-table entries are re-solved every
 * frame by a 2-segment analytic IK toward foot targets.
 *
 * Stepping model: feet PLANT (their local position recedes as the body
 * travels forward along +z); when a planted foot's extension from its rest
 * slot exceeds the clamp (MAX_EXTENSION × leg length), the trailing foot
 * lifts and swings to a target ahead of travel with per-step seeded wobble.
 * Feet alternate (a foot may lift only while its pair partner is planted),
 * cadence scales with speed, and at stop the swinging foot completes its arc,
 * then any foot still displaced takes one final settling step home — the
 * stride completes, nothing freezes mid-gesture.
 *
 * The swing arc: horizontal progress rides an ease-out cubic (a drift, no
 * overshoot); vertical height is a parabola for the first 80% of the swing —
 * BUT a parabola lands with velocity, which would read as bounce, so the last
 * 20% is replaced by a smoothstep decay to zero: the plant arrives with zero
 * vertical velocity, a drift, honoring the no-bounce constraint at 1.00.
 *
 * Body: a gentle height bob from the average foot swing phase, plus a small
 * lean into travel — both returned to the caller (character assembly) to be
 * composed with the emote channels.
 *
 * PURE module: no Three.js, no DOM, no Math.random — a seeded LCG drives the
 * per-step wobble, so a given (dt, speed) sequence is fully deterministic.
 */

import { MOTION } from '../../taste/tokens';
import type { CharacterSpec, SdfPart, V3 } from './spec';

/** A foot may trail this fraction of its chain length before it must step. */
export const MAX_EXTENSION = 0.55;

/** Swing apex height, × the max-extension distance. */
export const STEP_HEIGHT = 0.5;

/** Per-step target wobble, × the max-extension distance. */
export const STEP_WOBBLE = 0.2;

/** Body bob amplitude at full swing, spec units (~2% of a 1-unit body). */
export const STEP_BOB = 0.018;

/** Lean into travel, radians per (spec unit/s) of speed, clamped. */
const LEAN_PER_SPEED = 0.45;
const LEAN_MAX = 0.1;

/** Below this speed (spec units/s) the stepper treats the body as stopping. */
const SPEED_EPSILON = 1e-3;

/** A resting foot further than this × maxExt from home takes a settling step. */
const REST_TRIGGER = 0.3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Same LCG recipe as spec.ts — deterministic per seed. */
function makeRng(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

// ── chains ───────────────────────────────────────────────────────────────────

export interface LegChain {
  /** Part indices into spec.parts. */
  upper: number;
  lower: number;
  side: -1 | 1;
  /** Rest pose, cloned at creation. */
  hip: V3;
  foot: V3;
  upperLen: number;
  lowerLen: number;
}

/**
 * Derive the leg chains from the spec's emission contract: leg parts arrive
 * as consecutive (upper, lower) pairs sharing a group, interleaved l/r.
 */
export function legChainsOf(spec: CharacterSpec): LegChain[] {
  const chains: LegChain[] = [];
  const parts = spec.parts;
  for (let i = 0; i < parts.length - 1; i++) {
    const g = parts[i]!.group;
    if ((g === 'leg-l' || g === 'leg-r') && parts[i + 1]!.group === g) {
      const upper = parts[i]!;
      const lower = parts[i + 1]!;
      chains.push({
        upper: i,
        lower: i + 1,
        side: g === 'leg-l' ? -1 : 1,
        hip: [...upper.a],
        foot: [...(lower.b ?? lower.a)],
        upperLen: len3(sub(upper.b ?? upper.a, upper.a)),
        lowerLen: len3(sub(lower.b ?? lower.a, lower.a)),
      });
      i++; // consume the pair
    }
  }
  return chains;
}

// ── analytic two-bone IK ─────────────────────────────────────────────────────

export interface IkSolution {
  knee: V3;
  /** The foot actually reached — equals the target unless clamped. */
  foot: V3;
  clamped: boolean;
}

/**
 * 2-segment analytic IK: place the knee so |hip→knee| = l1 and |knee→foot|
 * = l2, bending toward `bend`. Unreachable targets are clamped onto the
 * reachable shell (foot pulled to max/min extension along the hip→target
 * ray) — legs never overreach.
 */
export function solveTwoBoneIK(hip: V3, target: V3, l1: number, l2: number, bend: V3): IkSolution {
  let d = sub(target, hip);
  let dist = len3(d);
  if (dist < 1e-9) {
    d = [0, -1, 0];
    dist = 1e-9;
  }
  const min = Math.abs(l1 - l2) + 1e-5;
  const max = (l1 + l2) * 0.999;
  const reach = clamp(dist, min, max);
  const clamped = reach !== dist;
  const axis: V3 = [d[0] / dist, d[1] / dist, d[2] / dist];
  const foot: V3 = [hip[0] + axis[0] * reach, hip[1] + axis[1] * reach, hip[2] + axis[2] * reach];

  // Law of cosines for the knee's along-axis and perpendicular offsets.
  const along = (l1 * l1 + reach * reach - l2 * l2) / (2 * reach);
  const perp2 = Math.max(l1 * l1 - along * along, 0);
  const perp = Math.sqrt(perp2);

  // Bend direction: the component of `bend` perpendicular to the axis.
  let bx = bend[0] - axis[0] * (bend[0] * axis[0] + bend[1] * axis[1] + bend[2] * axis[2]);
  let by = bend[1] - axis[1] * (bend[0] * axis[0] + bend[1] * axis[1] + bend[2] * axis[2]);
  let bz = bend[2] - axis[2] * (bend[0] * axis[0] + bend[1] * axis[1] + bend[2] * axis[2]);
  let bl = Math.hypot(bx, by, bz);
  if (bl < 1e-6) {
    // Bend parallel to the axis — fall back to +z, then +x.
    bx = -axis[1] * axis[0];
    by = 1 - axis[1] * axis[1];
    bz = -axis[1] * axis[2];
    bl = Math.hypot(bx, by, bz);
    if (bl < 1e-6) {
      bx = 1;
      by = 0;
      bz = 0;
      bl = 1;
    }
  }
  const knee: V3 = [
    hip[0] + axis[0] * along + (bx / bl) * perp,
    hip[1] + axis[1] * along + (by / bl) * perp,
    hip[2] + axis[2] * along + (bz / bl) * perp,
  ];
  return { knee, foot, clamped };
}

// ── swing arc ────────────────────────────────────────────────────────────────

/**
 * Normalized swing arc at progress t ∈ [0,1]:
 * - u: horizontal progress, ease-out cubic (derivative 0 at t=1 — the foot
 *   arrives as a drift, matching the settle curve's character).
 * - h: vertical height 0..1 — parabolic to t=0.8, then a smoothstep decay
 *   whose derivative is zero at t=1 (the flattened plant; see module doc).
 */
export function swingArc(t: number): { u: number; h: number } {
  const tc = clamp(t, 0, 1);
  const inv = 1 - tc;
  const u = 1 - inv * inv * inv;
  let h: number;
  if (tc < 0.8) {
    h = 4 * tc * (1 - tc);
  } else {
    const s = clamp((tc - 0.8) / 0.2, 0, 1);
    const ease = 1 - s * s * (3 - 2 * s); // smoothstep decay, zero end slope
    h = 4 * 0.8 * 0.2 * ease;
  }
  return { u, h };
}

// ── the stepper ──────────────────────────────────────────────────────────────

export interface FootView {
  side: -1 | 1;
  planted: boolean;
  /** Current local position (recedes at −z while planted and moving). */
  pos: V3;
}

export interface StepPose {
  /** Body lift from the average foot swing phase, spec units. */
  lift: number;
  /** Forward lean into travel, radians. */
  lean: number;
}

export interface Stepper {
  /**
   * Advance by dt ms at the current forward speed (SPEC units/s — the
   * assembly divides world speed by the mesh scale). Mutates the spec's leg
   * parts via IK and shifts all non-leg parts by the body lift. Returns the
   * body pose for the caller to compose with the emote channels.
   */
  update(dt: number, speed: number): StepPose;
  /** Read-only foot states, for tests and dev probes. */
  feet(): FootView[];
}

interface FootState {
  chain: LegChain;
  pos: V3;
  planted: boolean;
  swingT: number;
  swingMs: number;
  from: V3;
  to: V3;
}

/**
 * Create the reactive stepper for a spec. Keeps a rest clone of every part;
 * each update rewrites leg parts from the IK solve and offsets body parts by
 * the bob. A spec with no legs (blob) degenerates to a no-op glide.
 */
export function createStepper(spec: CharacterSpec, seed: number): Stepper {
  const rng = makeRng((seed ^ 0x51ed270b) >>> 0);
  const chains = legChainsOf(spec);
  const rest = spec.parts.map((p) => ({
    a: [...p.a] as V3,
    b: p.b ? ([...p.b] as V3) : undefined,
  }));
  const legPartIndices = new Set<number>();
  for (const c of chains) {
    legPartIndices.add(c.upper);
    legPartIndices.add(c.lower);
  }

  const feet: FootState[] = chains.map((chain) => ({
    chain,
    pos: [...chain.foot] as V3,
    planted: true,
    swingT: 0,
    swingMs: MOTION.secondaryMs,
    from: [...chain.foot] as V3,
    to: [...chain.foot] as V3,
  }));

  /** Pair partner: the opposite-side foot of the same girdle (l/r interleave). */
  const partner = (i: number): FootState | undefined => feet[i ^ 1];

  const maxExtOf = (f: FootState): number =>
    MAX_EXTENSION * (f.chain.upperLen + f.chain.lowerLen);

  const extension = (f: FootState): number =>
    Math.hypot(f.pos[0] - f.chain.foot[0], f.pos[2] - f.chain.foot[2]);

  const swingDuration = (f: FootState, speed: number): number => {
    const maxExt = maxExtOf(f);
    return clamp((1000 * 0.9 * maxExt) / Math.max(speed, 0.05), 240, MOTION.secondaryMs);
  };

  const lift = (f: FootState, speed: number, home: boolean): void => {
    const maxExt = maxExtOf(f);
    f.planted = false;
    f.swingT = 0;
    f.swingMs = swingDuration(f, speed);
    f.from = [...f.pos] as V3;
    const wob = home ? STEP_WOBBLE * 0.4 : STEP_WOBBLE;
    const ahead = home
      ? 0
      : Math.min(maxExt * 0.9, maxExt * 0.5 + speed * (f.swingMs / 1000) * 0.5);
    f.to = [
      f.chain.foot[0] + (rng() * 2 - 1) * wob * maxExt,
      f.chain.foot[1],
      f.chain.foot[2] + ahead + (rng() * 2 - 1) * wob * maxExt,
    ];
  };

  return {
    update(dt: number, speed: number): StepPose {
      const s = Math.max(0, speed);
      const dz = (s * dt) / 1000;

      // Advance feet: planted feet recede with travel; swinging feet fly
      // their arc and plant on arrival (even at speed 0 — stride completion).
      let swinging = 0;
      let phaseSum = 0;
      for (const f of feet) {
        if (f.planted) {
          f.pos[2] -= dz;
        } else {
          f.swingT += dt / f.swingMs;
          if (f.swingT >= 1) {
            f.planted = true;
            f.pos = [...f.to] as V3;
          } else {
            const { u, h } = swingArc(f.swingT);
            const maxExt = maxExtOf(f);
            f.pos = [
              f.from[0] + (f.to[0] - f.from[0]) * u,
              f.chain.foot[1] + h * STEP_HEIGHT * maxExt,
              f.from[2] + (f.to[2] - f.from[2]) * u,
            ];
            swinging++;
            phaseSum += h;
          }
        }
      }

      // Trigger the next step: the most-extended planted foot whose partner
      // is planted (alternation by construction — for a biped this is strict).
      const maxSimultaneous = Math.max(1, Math.floor(feet.length / 2));
      if (swinging < maxSimultaneous) {
        let candidate: FootState | null = null;
        let candidateExt = 0;
        feet.forEach((f, i) => {
          if (!f.planted) return;
          const p = partner(i);
          if (p && !p.planted) return;
          const ext = extension(f);
          if (ext > candidateExt) {
            candidateExt = ext;
            candidate = f;
          }
        });
        if (candidate) {
          const c: FootState = candidate;
          if (s > SPEED_EPSILON && candidateExt > maxExtOf(c)) {
            lift(c, s, false);
          } else if (
            s <= SPEED_EPSILON &&
            swinging === 0 &&
            candidateExt > REST_TRIGGER * maxExtOf(c)
          ) {
            // Stopped with a foot still displaced: one settling step home.
            lift(c, 0, true);
          }
        }
      }

      // Body pose: gentle lift from the mean swing phase + lean into travel.
      const liftY = feet.length > 0 ? STEP_BOB * (phaseSum / feet.length) : 0;
      const lean = clamp(s * LEAN_PER_SPEED, 0, LEAN_MAX);

      // Write the spec: body parts ride the lift; legs re-solve via IK.
      spec.parts.forEach((part, i) => {
        if (legPartIndices.has(i)) return;
        const r = rest[i]!;
        part.a = [r.a[0], r.a[1] + liftY, r.a[2]];
        if (r.b) part.b = [r.b[0], r.b[1] + liftY, r.b[2]];
      });
      for (const f of feet) {
        const { chain } = f;
        const hip: V3 = [chain.hip[0], chain.hip[1] + liftY, chain.hip[2]];
        const ik = solveTwoBoneIK(hip, f.pos, chain.upperLen, chain.lowerLen, [0, 0, 1]);
        const upper = spec.parts[chain.upper]!;
        const lower = spec.parts[chain.lower]!;
        upper.a = hip;
        upper.b = ik.knee;
        lower.a = [...ik.knee] as V3;
        lower.b = ik.foot;
      }

      return { lift: liftY, lean };
    },
    feet(): FootView[] {
      return feet.map((f) => ({
        side: f.chain.side,
        planted: f.planted,
        pos: [...f.pos] as V3,
      }));
    },
  };
}
