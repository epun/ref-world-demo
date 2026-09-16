/**
 * The ink pass's depth constants — the one thing that had to move when the
 * camera rig widened its ortho depth range (src/world/camera.ts, 2026-09-15).
 *
 * The shader reads a DEPTH TEXTURE, which holds `(z - near) / (far - near)`.
 * So every constant compared against it — the contour threshold, the fog
 * band — is a statement about the range as much as about the world, and the
 * range just grew 7.5x to stop the near plane cutting the front edge of the
 * map off. Left alone, the contours would have thinned to nothing and the fog
 * would have collapsed onto the horizon.
 *
 * What is pinned: the constants are WORLD UNITS, normalised per camera, and
 * at the range they were calibrated at they reproduce the landed numbers.
 */

import { describe, expect, it } from 'vitest';
import { EDGE_WORLD_UNITS, depthConstants } from '../../src/world/ink';
import { CAMERA_DISTANCE, CAMERA_FAR, CAMERA_NEAR } from '../../src/world/camera';

/** The range the look was landed at: near 0.1, far 480 — the rig's old
 * `CAMERA_DISTANCE * 4`, with the eye 120 units off the look-target. */
const CAL_NEAR = 0.1;
const CAL_FAR = 480;
const CAL_EYE = 120;
const CAL_RANGE = CAL_FAR - CAL_NEAR;
const LIVE_RANGE = CAMERA_FAR - CAMERA_NEAR;

describe('ink depth constants', () => {
  it('reproduces the calibrated screenshot numbers at the calibration range', () => {
    const d = depthConstants(CAL_NEAR, CAL_FAR, EDGE_WORLD_UNITS, CAL_EYE);
    expect(d.edgeThreshold).toBeCloseTo(0.004, 6);
    expect(d.fogStart).toBeCloseTo(0.2, 6);
    expect(d.fogSpan).toBeCloseTo(0.12, 6);
  });

  it('normalises the threshold by the live range, for any far plane', () => {
    for (const far of [CAL_FAR, 3600]) {
      const d = depthConstants(CAL_NEAR, far, EDGE_WORLD_UNITS);
      expect(d.edgeThreshold).toBeCloseTo(EDGE_WORLD_UNITS / (far - CAL_NEAR), 12);
    }
    // The wide range shrinks it — exactly the shrink that would have made the
    // lines vanish had the number stayed a literal 0.004.
    const wide = depthConstants(CAMERA_NEAR, CAMERA_FAR, EDGE_WORLD_UNITS);
    expect(wide.edgeThreshold).toBeLessThan(0.004);
    expect(wide.edgeThreshold * LIVE_RANGE).toBeCloseTo(EDGE_WORLD_UNITS, 9);
  });

  it('keeps the fog band the same world-unit slab at any range', () => {
    const cal = depthConstants(CAL_NEAR, CAL_FAR, EDGE_WORLD_UNITS, CAL_EYE);
    const live = depthConstants(CAMERA_NEAR, CAMERA_FAR, EDGE_WORLD_UNITS);
    expect(live.fogSpan * LIVE_RANGE).toBeCloseTo(cal.fogSpan * CAL_RANGE, 6);
    // And it still begins the same distance in FRONT of the look-target: the
    // eye moved back, the wash did not.
    const calAhead = CAL_EYE - (cal.fogStart * CAL_RANGE + CAL_NEAR);
    const liveAhead = CAMERA_DISTANCE - (live.fogStart * LIVE_RANGE + CAMERA_NEAR);
    expect(liveAhead).toBeCloseTo(calAhead, 6);
  });

  it('never divides by a degenerate range', () => {
    const d = depthConstants(1, 1, EDGE_WORLD_UNITS);
    expect(Number.isFinite(d.edgeThreshold)).toBe(true);
    expect(Number.isFinite(d.fogSpan)).toBe(true);
  });
});
