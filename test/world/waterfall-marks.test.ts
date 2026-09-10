/**
 * The waterfall mark (src/world/waterfall-marks.ts) — pure, no WebGL.
 *
 * Three things are load-bearing and none of them is a look:
 *
 *   THE FACING comes off the Surface's up-normal and points DOWNHILL. Get it
 *   backwards and every fall in the world climbs its own riser.
 *   THE SPAN comes off the Surface at the lip and at the foot, through the
 *   seam and nowhere else (PLAN §7.2) — a mark that derived a height of its
 *   own would be the second height source this project keeps warning about.
 *   THE DRAWING is deterministic: same seed, same geometry, byte for byte,
 *   on every device. That is what lets a handset rebuild an operator's
 *   painted waterfall out of four numbers in the session log.
 */

import { describe, expect, it } from 'vitest';
import type { PaintedMark } from '../../src/world/painted';
import type { Surface } from '../../src/world/surface';
import {
  buildWaterfallGeometries,
  FALL_MAX_DROP,
  FALL_MIN_DROP,
  FALL_RUN,
  nearestWaterfall,
  setWaterfallMarks,
  waterfallDrop,
  waterfallMarks,
  waterfallPlacements,
  waterfallSeed,
  waterfallVariant,
  waterfallYaw,
  WATERFALL_VARIANTS,
} from '../../src/world/waterfall-marks';

/** A ramp falling toward +x at `slope`, with the right up-normal for it. */
function ramp(slope: number): Surface {
  const len = Math.hypot(slope, 1);
  return {
    sampleHeight: (x: number): number => -slope * x,
    // n ∝ (-dh/dx, 1, -dh/dz) = (slope, 1, 0), normalised.
    normalAt: (): { x: number; y: number; z: number } => ({ x: slope / len, y: 1 / len, z: 0 }),
  };
}

const mark = (over: Partial<PaintedMark> = {}): PaintedMark => ({
  kind: 'waterfall',
  x: 0,
  z: 0,
  seed: 3,
  yaw: 0,
  ...over,
});

describe('which way a fall faces', () => {
  it('points down the local gradient', () => {
    // The ground falls toward +x, so the water does: yaw 0 is local +x in the
    // scatter's own convention (rotY about y, +x → (cos, -sin)).
    const yaw = waterfallYaw(ramp(0.5), 0, 0);
    expect(Math.cos(yaw)).toBeCloseTo(1, 6);
    expect(-Math.sin(yaw)).toBeCloseTo(0, 6);
  });

  it('turns round when the ground does', () => {
    const yaw = waterfallYaw(ramp(-0.5), 0, 0);
    expect(Math.cos(yaw)).toBeCloseTo(-1, 6);
  });

  it('answers a direction on ground with no gradient at all', () => {
    // Flat paper has no downhill. It still has to face somewhere finite, or
    // the mark's rotation is NaN and the instance disappears.
    const yaw = waterfallYaw({ sampleHeight: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }) }, 4, 9);
    expect(Number.isFinite(yaw)).toBe(true);
  });
});

describe('how far a fall spans', () => {
  it('is the surface at the lip less the surface at the foot', () => {
    const surface = ramp(0.5);
    const m = mark({ yaw: waterfallYaw(surface, 0, 0) });
    // The foot is FALL_RUN down the facing: 0.5 × 4 = 2 units of drop.
    expect(waterfallDrop(surface, m)).toBeCloseTo(0.5 * FALL_RUN, 6);
  });

  it('clamps a ripple up and a cliff down', () => {
    expect(waterfallDrop(ramp(0.001), mark())).toBe(FALL_MIN_DROP);
    expect(waterfallDrop(ramp(50), mark())).toBe(FALL_MAX_DROP);
  });

  it('never asks the surface for a height it did not sample', () => {
    // The seam, pinned: two reads, both through `sampleHeight`, and no
    // differencing of our own anywhere in this module.
    const seen: number[] = [];
    const spy: Surface = {
      sampleHeight: (x: number): number => {
        seen.push(x);
        return -x;
      },
      normalAt: () => ({ x: 1, y: 1, z: 0 }),
    };
    waterfallDrop(spy, mark({ yaw: 0 }));
    expect(seen).toEqual([0, FALL_RUN]);
  });
});

describe('the placements the world draws', () => {
  it('carries the mark place, facing and drop, and nothing else', () => {
    const surface = ramp(0.5);
    const a = mark({ x: 10, z: -4, seed: 1, yaw: 0 });
    setWaterfallMarks([a]);
    expect(waterfallMarks()).toHaveLength(1);
    const [p] = waterfallPlacements(surface);
    expect(p).toBeDefined();
    expect(p!.kind).toBe('waterfall');
    expect(p!.x).toBe(10);
    expect(p!.z).toBe(-4);
    expect(p!.rotY).toBe(0);
    expect(p!.scale).toBeCloseTo(0.5 * FALL_RUN, 6);
    expect(p!.variant).toBe(waterfallVariant(1));
    setWaterfallMarks(null);
    expect(waterfallPlacements(surface)).toHaveLength(0);
  });

  it('keeps every variant inside the authored set', () => {
    for (const seed of [0, 1, 2, 7, 9972, -5]) {
      const v = waterfallVariant(seed);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(WATERFALL_VARIANTS);
    }
  });
});

describe('the eraser', () => {
  it('takes the nearest mark under the brush, and only if one is under it', () => {
    const marks = [mark({ x: 0, z: 0 }), mark({ x: 6, z: 0 }), mark({ x: 40, z: 0 })];
    expect(nearestWaterfall(marks, 5, 0, 3)).toBe(1);
    expect(nearestWaterfall(marks, 1, 0, 3)).toBe(0);
    expect(nearestWaterfall(marks, 20, 0, 3)).toBe(-1);
    expect(nearestWaterfall([], 0, 0, 10)).toBe(-1);
  });
});

describe('the drawing', () => {
  it('is the same geometry every time it is built', () => {
    // No Math.random, no clock: two builds in the same process have to agree
    // vertex for vertex, which is the whole reason a mark can be replayed.
    const a = buildWaterfallGeometries();
    const b = buildWaterfallGeometries();
    expect(a).toHaveLength(WATERFALL_VARIANTS);
    for (let v = 0; v < WATERFALL_VARIANTS; v++) {
      const pa = a[v]!.getAttribute('position').array as Float32Array;
      const pb = b[v]!.getAttribute('position').array as Float32Array;
      expect(pa.length).toBeGreaterThan(0);
      expect(Array.from(pb)).toEqual(Array.from(pa));
    }
  });

  it('hangs one unit below its origin and stays narrow', () => {
    // The placement scales it by the DROP, so the authored form has to span
    // exactly lip (y = 0) to foot (y = -1) — and it must not be so wide that
    // a tall fall becomes a wall (the scale is uniform).
    for (const geometry of buildWaterfallGeometries()) {
      const p = geometry.getAttribute('position');
      let minY = Infinity;
      let maxY = -Infinity;
      let maxXZ = 0;
      for (let i = 0; i < p.count; i++) {
        minY = Math.min(minY, p.getY(i));
        maxY = Math.max(maxY, p.getY(i));
        maxXZ = Math.max(maxXZ, Math.abs(p.getX(i)), Math.abs(p.getZ(i)));
      }
      expect(maxY).toBeLessThanOrEqual(0.02);
      expect(minY).toBeGreaterThanOrEqual(-1.01);
      expect(minY).toBeLessThan(-0.9);
      expect(maxXZ).toBeLessThan(0.45);
    }
  });

  it('seeds a place the same way twice', () => {
    expect(waterfallSeed(12.34, -5.6)).toBe(waterfallSeed(12.34, -5.6));
    expect(waterfallSeed(12.34, -5.6)).not.toBe(waterfallSeed(-5.6, 12.34));
  });
});
