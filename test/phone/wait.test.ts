/**
 * Wait-screen pure logic: the timer→hatch progress mapping (the same
 * elapsed/total read the world uses) and the late crack teaser scrub.
 *
 * The countdown LINE was removed on 2026-08-20 (*"let's remove the count
 * down and the hatch button. i want to set the hatch timing on my end."*)
 * and asked for again on 2026-08-27 (*"for the user on mobile we should
 * show the count down for the egg"*). Only the text came back — the hatch
 * BUTTON is still gone, and the line still opens nothing: the world's
 * `hatched` message is the only thing that breaks a shell, so the label is
 * a forecast reading the same timer that ramps the wobble and teases the
 * cracks.
 */

import { describe, expect, it } from 'vitest';
import {
  PORTRAIT_FIT,
  PORTRAIT_SHARE,
  portraitHalfExtent,
  portraitUnitsPerPixel,
} from '../../src/phone/screens/alive';
import {
  blendFraming,
  CAMERA_FOV,
  countdownLabel,
  crackTeaser,
  CRACK_TEASER,
  EGG_FRAMING,
  fitDistance,
  hatchProgress,
  type Framing,
} from '../../src/phone/screens/wait';
import { CORE_SHARE } from '../../src/phone/states';

describe('hatchProgress', () => {
  it('is the world mapping: elapsed over total', () => {
    expect(hatchProgress(20_000, 20_000)).toBe(0);
    expect(hatchProgress(10_000, 20_000)).toBeCloseTo(0.5);
    expect(hatchProgress(5_000, 20_000)).toBeCloseTo(0.75);
    expect(hatchProgress(0, 20_000)).toBe(1);
  });

  it('clamps to [0, 1]', () => {
    expect(hatchProgress(-3_000, 20_000)).toBe(1);
    expect(hatchProgress(30_000, 20_000)).toBe(0);
  });

  it('rests at 0 while the timer is unknown or degenerate', () => {
    expect(hatchProgress(null, 20_000)).toBe(0);
    expect(hatchProgress(10_000, null)).toBe(0);
    expect(hatchProgress(10_000, 0)).toBe(0);
    expect(hatchProgress(null, null)).toBe(0);
  });

  it('is monotone as the countdown advances', () => {
    let prev = -1;
    for (let remaining = 20_000; remaining >= 0; remaining -= 500) {
      const p = hatchProgress(remaining, 20_000);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('crackTeaser', () => {
  it('holds zero until the final stretch (p < 0.62)', () => {
    for (const p of [0, 0.2, 0.5, 0.62]) {
      expect(crackTeaser(p)).toBe(0);
    }
  });

  it('drifts up to the teaser ceiling at p = 1, never beyond', () => {
    expect(crackTeaser(1)).toBeCloseTo(CRACK_TEASER);
    expect(crackTeaser(2)).toBeCloseTo(CRACK_TEASER);
    for (let p = 0; p <= 1; p += 0.01) {
      expect(crackTeaser(p)).toBeLessThanOrEqual(CRACK_TEASER + 1e-9);
      expect(crackTeaser(p)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is monotone and smooth — no step at the threshold', () => {
    let prev = 0;
    for (let p = 0; p <= 1.0001; p += 0.005) {
      const c = crackTeaser(p);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = c;
    }
    // smoothstep: zero slope entering the ramp — the value just past the
    // threshold is still nearly zero.
    expect(crackTeaser(0.63)).toBeLessThan(0.003);
  });
});

// ── The reframe (the hatch's camera) ────────────────────────────────────────

describe('blendFraming', () => {
  const to: Framing = {
    azimuth: 0,
    elevation: 0,
    lookX: 0.4,
    lookY: 1.9,
    distance: 11,
  };

  it('is the egg framing at rest and the creature framing at settle', () => {
    expect(blendFraming(0, EGG_FRAMING, to)).toEqual(EGG_FRAMING);
    expect(blendFraming(1, EGG_FRAMING, to)).toEqual(to);
  });

  it('clamps, so a spring that has not quite settled cannot run past', () => {
    expect(blendFraming(-0.4, EGG_FRAMING, to)).toEqual(EGG_FRAMING);
    expect(blendFraming(1.4, EGG_FRAMING, to)).toEqual(to);
  });

  it('moves every term continuously — a reframe is a slide, never a cut', () => {
    let prev = blendFraming(0, EGG_FRAMING, to);
    for (let t = 0.01; t <= 1.0001; t += 0.01) {
      const now = blendFraming(t, EGG_FRAMING, to);
      // No step bigger than the whole travel times the step size.
      expect(Math.abs(now.azimuth - prev.azimuth)).toBeLessThan(
        Math.abs(to.azimuth - EGG_FRAMING.azimuth) * 0.02 + 1e-9,
      );
      expect(Math.abs(now.distance - prev.distance)).toBeLessThan(
        Math.abs(to.distance - EGG_FRAMING.distance) * 0.02 + 1e-9,
      );
      prev = now;
    }
    expect(prev.azimuth).toBeCloseTo(to.azimuth);
  });

  it('ends head-on, where the portrait already looks from', () => {
    expect(to.azimuth).toBe(0);
    expect(to.elevation).toBe(0);
  });
});

describe('the wait camera lands on the portrait', () => {
  /**
   * The load-bearing claim of the whole fix: at the end of the swap the
   * creature this screen is showing and the creature the portrait is
   * fading in are the same mesh at the same rendered SIZE, so the
   * cross-fade has nothing to dissolve. Stated as arithmetic on the two
   * screens' own shared constants rather than on copied numbers.
   */
  const wellPx = 273; // DEVICE §3: the well at 390px wide
  const portraitPx = wellPx * CORE_SHARE.alive * PORTRAIT_SHARE;
  const half = portraitHalfExtent(2.8, 3.5);

  it('renders the same world units per pixel as the portrait will', () => {
    // The wait canvas is the whole core, and the alive core is the well.
    const canvasPx = wellPx * CORE_SHARE.alive;
    const distance = fitDistance(
      portraitUnitsPerPixel(half, portraitPx),
      canvasPx,
      CAMERA_FOV,
    );
    const visible = 2 * distance * Math.tan((CAMERA_FOV * Math.PI) / 360);
    expect(visible / canvasPx).toBeCloseTo(portraitUnitsPerPixel(half, portraitPx), 9);
  });

  it('holds that size while the core grows through the swap', () => {
    const unitsPerPx = portraitUnitsPerPixel(half, portraitPx);
    let previous = 0;
    for (const share of [CORE_SHARE.wait, 0.8, 0.9, CORE_SHARE.alive]) {
      const canvasPx = wellPx * share;
      const distance = fitDistance(unitsPerPx, canvasPx, CAMERA_FOV);
      const visible = 2 * distance * Math.tan((CAMERA_FOV * Math.PI) / 360);
      // Same units per pixel at every box size — the creature's rendered
      // size does not change while the box travels around it.
      expect(visible / canvasPx).toBeCloseTo(unitsPerPx, 9);
      // And the camera really does pull back as the box grows.
      expect(distance).toBeGreaterThan(previous);
      previous = distance;
    }
  });

  it('frames the creature inside the wait core, with air around it', () => {
    const unitsPerPx = portraitUnitsPerPixel(half, portraitPx);
    const canvasPx = wellPx * CORE_SHARE.wait;
    const visible = canvasPx * unitsPerPx;
    // The creature's own larger extent, which the half-extent pads.
    const creature = half / PORTRAIT_FIT;
    expect(creature).toBeLessThan(visible);
    // Real air, not a hair: at least a tenth of the frame on each side.
    expect(creature / visible).toBeLessThan(0.9);
  });
});

describe('countdownLabel', () => {
  it('counts down in minutes and seconds, lowercase throughout', () => {
    expect(countdownLabel(20_000)).toBe('hatching in 0:20');
    expect(countdownLabel(65_000)).toBe('hatching in 1:05');
    expect(countdownLabel(600_000)).toBe('hatching in 10:00');
  });

  it('never renders uppercase — the taste rule, on the one string a stranger reads', () => {
    for (const ms of [20_000, 65_000, 600_000, 1, 0, -5_000]) {
      const label = countdownLabel(ms);
      if (label === null) continue;
      expect(label).toBe(label.toLowerCase());
    }
  });

  it('rounds up, so a fresh 20s timer never opens on 0:19', () => {
    expect(countdownLabel(19_999)).toBe('hatching in 0:20');
    // And never shows 0:00 while there is still time on the clock.
    expect(countdownLabel(1)).toBe('hatching in 0:01');
  });

  it('says a word rather than sitting on zero', () => {
    // The world and the handset are two clocks started at different
    // instants, so the last second is a coin flip. A timer parked at 0:00
    // reads as broken; a word does not.
    expect(countdownLabel(0)).toBe('hatching');
    expect(countdownLabel(-5_000)).toBe('hatching');
  });

  it('shows nothing at all when there is no timer', () => {
    // Not "--:--", not "0:00". An empty brow is a state of the slot; a
    // placeholder is a bug on screen.
    expect(countdownLabel(null)).toBeNull();
  });
});
