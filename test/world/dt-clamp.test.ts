/**
 * dt clamp (QA audit D3): the render loop integrates real elapsed time up to
 * DT_CLAMP_MS = 250 so low fps never turns into slow motion, and clamps only
 * beyond it (tab-return lurch guard). That is safe iff springs stepped at
 * 250ms stay on the motion law — no overshoot, no rebound, clean settle —
 * which this file asserts directly against the solver.
 */

import { describe, expect, it } from 'vitest';
import { Spring } from '../../src/motion/spring';
import { MOTION } from '../../src/taste/tokens';
import { DT_CLAMP_MS } from '../../src/world/scene';

describe('dt clamp (qa audit d3)', () => {
  it('integrates up to 250ms and no further', () => {
    expect(DT_CLAMP_MS).toBe(250);
  });

  it('springs stepped at the clamp never cross their target (no overshoot)', () => {
    for (const settleMs of [MOTION.tertiaryMs, MOTION.secondaryMs, MOTION.primaryMs]) {
      const spring = new Spring(0, { settleMs });
      spring.retarget(1);
      let prev = 0;
      for (let step = 0; step < 200; step++) {
        const x = spring.update(DT_CLAMP_MS);
        expect(x).toBeLessThanOrEqual(1 + 1e-9); // never past the target
        expect(x).toBeGreaterThanOrEqual(prev - 1e-9); // monotone approach
        prev = x;
      }
      expect(prev).toBeCloseTo(1, 3); // and it does settle
      spring.dispose();
    }
  });

  it('a 250ms step lands where sixteen 16ms steps land (wall-clock true)', () => {
    const coarse = new Spring(0, { settleMs: MOTION.primaryMs });
    const fine = new Spring(0, { settleMs: MOTION.primaryMs });
    coarse.retarget(1);
    fine.retarget(1);
    coarse.update(256);
    for (let i = 0; i < 16; i++) fine.update(16);
    // The solver substeps internally at 16ms, so the trajectories agree —
    // integrating a clamped-large dt is the same motion, not a slowdown.
    expect(coarse.value).toBeCloseTo(fine.value, 9);
    coarse.dispose();
    fine.dispose();
  });

  it('an interrupted retarget at clamp-sized steps still never rebounds', () => {
    const spring = new Spring(0, { settleMs: MOTION.secondaryMs });
    spring.retarget(1);
    spring.update(DT_CLAMP_MS);
    spring.retarget(0.2); // mid-flight interruption, velocity carries
    let min = Number.POSITIVE_INFINITY;
    for (let step = 0; step < 100; step++) min = Math.min(min, spring.update(DT_CLAMP_MS));
    // Approaching 0.2 from above with inherited upward velocity may coast
    // briefly upward (that is drift, not bounce) but must never dip UNDER
    // the new target — an undershoot-then-return would read as rebound.
    expect(min).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(spring.value).toBeCloseTo(0.2, 3);
    spring.dispose();
  });
});
