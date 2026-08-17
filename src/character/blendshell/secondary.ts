/**
 * Secondary motion (BLENDSHELL step 5) — verlet ropes for crown/tail chains.
 *
 * Each crown/tail appendage in the spec is a chain of 2+ fused segments; the
 * rope nodes ARE those segments' endpoints, so the appendage stays welded to
 * the head/torso through the smooth-min while it flops (the segments are
 * SdfParts — the shader re-blends the union every frame).
 *
 * Damping law (the taste's ζ≥1 rule, translated to verlet): velocity carries
 * a heavy per-second decay, and the rest-shape return is applied as a pure
 * POSITIONAL drift — the same delta is added to both the current and previous
 * positions, so returning home injects zero velocity and can never overshoot.
 * The rope trails and settles; it does not spring back.
 *
 * PURE module: no Three.js, no DOM, no Math.random, no Date.
 */

import type { CharacterSpec, SdfPart, V3 } from './spec';

/** Velocity decay per second — heavy; a pendulum under it cannot oscillate. */
export const ROPE_DAMPING = 16;

/** Rest-shape return rate per second (positional drift, never a spring). */
export const ROPE_RETURN = 6;

/** Gravity in spec units/s² — a gentle droop, not a physics sim. */
const GRAVITY = 0.6;

/** Backward drag per (spec unit/s) of travel speed — appendages trail. */
const DRAG = 0.8;

/** Length-constraint relaxation passes per update. */
const CONSTRAINT_ITERATIONS = 3;

const clampDt = (dt: number): number => Math.min(Math.max(dt, 0), 33);

// ── the rope ─────────────────────────────────────────────────────────────────

export interface Rope {
  /** Node positions, anchor first. Mutated in place by update(). */
  readonly nodes: V3[];
  /** Segment rest lengths. */
  readonly lengths: number[];
  /**
   * Advance by dt ms. `anchor` pins node 0; `force` is an acceleration
   * (spec units/s²) applied to the free nodes.
   */
  update(dt: number, anchor: V3, force: V3): void;
}

/** Build a damped verlet rope from an initial polyline (node 0 = anchor). */
export function createRope(points: readonly V3[]): Rope {
  const nodes: V3[] = points.map((p) => [...p] as V3);
  const prev: V3[] = points.map((p) => [...p] as V3);
  const lengths: number[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    lengths.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  // Rest offsets relative to the anchor — the shape the rope drifts home to.
  const restRel: V3[] = nodes.map((n) => [
    n[0] - nodes[0]![0],
    n[1] - nodes[0]![1],
    n[2] - nodes[0]![2],
  ]);

  return {
    nodes,
    lengths,
    update(dt: number, anchor: V3, force: V3): void {
      const h = clampDt(dt) / 1000;
      if (h <= 0) return;
      const damp = Math.max(0, 1 - ROPE_DAMPING * h);
      const home = Math.min(1, ROPE_RETURN * h);

      for (let i = 1; i < nodes.length; i++) {
        const x = nodes[i]!;
        const p = prev[i]!;
        const vx = (x[0] - p[0]) * damp;
        const vy = (x[1] - p[1]) * damp;
        const vz = (x[2] - p[2]) * damp;
        let nx = x[0] + vx + force[0] * h * h;
        let ny = x[1] + vy + force[1] * h * h;
        let nz = x[2] + vz + force[2] * h * h;
        // Rest-shape return as pure positional drift: shift position AND
        // history by the same delta — zero velocity injected, no overshoot.
        const rx = anchor[0] + restRel[i]![0];
        const ry = anchor[1] + restRel[i]![1];
        const rz = anchor[2] + restRel[i]![2];
        const dxh = (rx - nx) * home;
        const dyh = (ry - ny) * home;
        const dzh = (rz - nz) * home;
        prev[i] = [x[0] + dxh, x[1] + dyh, x[2] + dzh];
        nodes[i] = [nx + dxh, ny + dyh, nz + dzh];
      }
      nodes[0] = [...anchor] as V3;
      prev[0] = [...anchor] as V3;

      // Distance constraints, anchor-dominant: each pass walks out from the
      // anchor moving only the child node, so the chain stays attached.
      for (let pass = 0; pass < CONSTRAINT_ITERATIONS; pass++) {
        for (let i = 0; i < nodes.length - 1; i++) {
          const a = nodes[i]!;
          const b = nodes[i + 1]!;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const dz = b[2] - a[2];
          const d = Math.hypot(dx, dy, dz) || 1e-9;
          const k = lengths[i]! / d;
          nodes[i + 1] = [a[0] + dx * k, a[1] + dy * k, a[2] + dz * k];
        }
      }
    },
  };
}

// ── spec chains ──────────────────────────────────────────────────────────────

interface SpecChain {
  partIndices: number[];
  rope: Rope;
  /** Rest anchor (chain base) — body lift is added at update time. */
  anchorRest: V3;
}

const near = (a: V3, b: V3): boolean =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-4;

/**
 * Find the crown/tail chains in a spec: consecutive same-group parts whose
 * endpoints connect (part.b ≈ next.a) form one rope.
 */
export function ropeChainsOf(spec: CharacterSpec): { group: string; partIndices: number[] }[] {
  const chains: { group: string; partIndices: number[] }[] = [];
  const parts = spec.parts;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if ((part.group !== 'crown' && part.group !== 'tail') || !part.b) continue;
    const indices = [i];
    while (i + 1 < parts.length) {
      const next = parts[i + 1]!;
      if (next.group !== part.group || !next.b || !near(next.a, parts[i]!.b!)) break;
      indices.push(++i);
    }
    chains.push({ group: part.group, partIndices: indices });
  }
  return chains;
}

export interface Secondary {
  /**
   * Advance all ropes by dt ms and write the node positions back into the
   * spec's crown/tail parts. `lift` is the stepper's body lift (the anchors
   * ride it); `speed` is forward travel in spec units/s (drives the trail).
   */
  update(dt: number, lift: number, speed: number): void;
}

/** Build the verlet layer for a spec's crown/tail chains. */
export function createSecondary(spec: CharacterSpec): Secondary {
  const chains: SpecChain[] = ropeChainsOf(spec).map(({ partIndices }) => {
    const first = spec.parts[partIndices[0]!]!;
    const points: V3[] = [[...first.a] as V3];
    for (const pi of partIndices) points.push([...spec.parts[pi]!.b!] as V3);
    return {
      partIndices,
      rope: createRope(points),
      anchorRest: [...first.a] as V3,
    };
  });

  return {
    update(dt: number, lift: number, speed: number): void {
      const force: V3 = [0, -GRAVITY, -DRAG * Math.max(0, speed)];
      for (const chain of chains) {
        const anchor: V3 = [
          chain.anchorRest[0],
          chain.anchorRest[1] + lift,
          chain.anchorRest[2],
        ];
        chain.rope.update(dt, anchor, force);
        chain.partIndices.forEach((pi, k) => {
          const part: SdfPart = spec.parts[pi]!;
          part.a = [...chain.rope.nodes[k]!] as V3;
          part.b = [...chain.rope.nodes[k + 1]!] as V3;
        });
      }
    },
  };
}
