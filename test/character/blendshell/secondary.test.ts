/**
 * Verlet secondary motion — pure tests over the damped rope and the spec
 * write-back. The taste constraint under test: ropes trail and settle, they
 * never oscillate (no sign-flipping velocity after the settle window).
 */

import { describe, expect, it } from 'vitest';
import type { Motifs } from '../../../src/character/interpret';
import { specFromMotifs, type V3 } from '../../../src/character/blendshell/spec';
import {
  createRope,
  createSecondary,
  ropeChainsOf,
} from '../../../src/character/blendshell/secondary';

const DT = 16;

function motifsOf(over: Partial<Motifs> = {}): Motifs {
  return {
    archetype: 'quadruped', // always gets a tail
    aspect: 1.1,
    torsoFullness: 0.7,
    headSize: 0.6,
    feet: [],
    limbs: [],
    crown: [
      { angle: -0.3, reach: 0.15 },
      { angle: 0.3, reach: 0.15 },
    ],
    lumpiness: 0.4,
    ...over,
  };
}

const dist = (a: V3, b: V3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('createRope', () => {
  const points: V3[] = [
    [0, 1, 0],
    [0, 1.1, 0],
    [0, 1.2, 0],
  ];

  it('keeps segment lengths under load', () => {
    const rope = createRope(points);
    for (let t = 0; t < 3000; t += DT) {
      rope.update(DT, [0, 1, 0], [1.5, -0.6, -0.8]);
      for (let i = 0; i < rope.lengths.length; i++) {
        expect(dist(rope.nodes[i]!, rope.nodes[i + 1]!)).toBeCloseTo(rope.lengths[i]!, 6);
      }
    }
  });

  it('pins node 0 to the anchor', () => {
    const rope = createRope(points);
    const anchor: V3 = [0.2, 0.9, -0.1];
    rope.update(DT, anchor, [0, -0.6, 0]);
    expect(rope.nodes[0]).toEqual(anchor);
  });

  it('settles without oscillation — tip velocity never sign-flips after the window', () => {
    const rope = createRope(points);
    // Kick the rope sideways hard for 200ms, then release.
    for (let t = 0; t < 200; t += DT) rope.update(DT, [0, 1, 0], [8, -0.6, 0]);
    // Settle window.
    for (let t = 0; t < 1200; t += DT) rope.update(DT, [0, 1, 0], [0, -0.6, 0]);
    // After the window: track tip x-velocity; a rebound would flip its sign.
    let prevX = rope.nodes[2]![0];
    let prevV: number | null = null;
    for (let t = 0; t < 2000; t += DT) {
      rope.update(DT, [0, 1, 0], [0, -0.6, 0]);
      const x = rope.nodes[2]![0];
      const v = x - prevX;
      if (prevV !== null && Math.abs(v) > 1e-7 && Math.abs(prevV) > 1e-7) {
        expect(Math.sign(v)).toBe(Math.sign(prevV));
      }
      prevV = v;
      prevX = x;
    }
  });

  it('drifts home: released rope returns toward its rest shape', () => {
    const rope = createRope(points);
    for (let t = 0; t < 300; t += DT) rope.update(DT, [0, 1, 0], [6, 0, 4]);
    const displaced = dist(rope.nodes[2]!, [0, 1.2, 0]);
    expect(displaced).toBeGreaterThan(0.02);
    for (let t = 0; t < 4000; t += DT) rope.update(DT, [0, 1, 0], [0, 0, 0]);
    expect(dist(rope.nodes[2]!, [0, 1.2, 0])).toBeLessThan(displaced * 0.2);
  });
});

describe('createSecondary', () => {
  it('finds the crown and tail chains in a spec', () => {
    // A quadruped with no crown has budget for its tail chain…
    const tailed = specFromMotifs(motifsOf({ crown: [] }), 42);
    expect(ropeChainsOf(tailed).map((c) => c.group)).toContain('tail');
    // …and a crowned one always carries at least one rope chain.
    const chains = ropeChainsOf(specFromMotifs(motifsOf(), 42));
    expect(chains.length).toBeGreaterThanOrEqual(1);
    for (const c of chains) expect(c.partIndices.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps chain segments fused while flopping (b of one = a of next)', () => {
    const spec = specFromMotifs(motifsOf(), 42);
    const secondary = createSecondary(spec);
    for (let t = 0; t < 2000; t += DT) secondary.update(DT, 0.005, 0.3);
    for (const chain of ropeChainsOf(spec)) {
      for (let i = 1; i < chain.partIndices.length; i++) {
        const prev = spec.parts[chain.partIndices[i - 1]!]!;
        const next = spec.parts[chain.partIndices[i]!]!;
        expect(dist(prev.b!, next.a)).toBeLessThan(1e-9);
      }
      // The chain base rides the body lift, staying welded to its anchor.
      const first = spec.parts[chain.partIndices[0]!]!;
      expect(first.a[1]).toBeGreaterThan(0);
    }
  });

  it('trails backward under travel and settles home at rest', () => {
    const spec = specFromMotifs(motifsOf(), 42);
    const chains = ropeChainsOf(spec);
    const tail = chains.find((c) => c.group === 'crown') ?? chains[0]!;
    const restTip = [...(spec.parts[tail.partIndices.at(-1)!]!.b as V3)] as V3;
    const secondary = createSecondary(spec);
    // Cruise: the tip lags behind its rest z (drag pulls −z).
    for (let t = 0; t < 3000; t += DT) secondary.update(DT, 0, 0.5);
    const tipMoving = spec.parts[tail.partIndices.at(-1)!]!.b as V3;
    expect(tipMoving[2]).toBeLessThan(restTip[2]);
    // Rest: it drifts back near home (never oscillating — covered above).
    for (let t = 0; t < 6000; t += DT) secondary.update(DT, 0, 0);
    const tipRest = spec.parts[tail.partIndices.at(-1)!]!.b as V3;
    expect(dist(tipRest, restTip)).toBeLessThan(0.02);
  });
});
