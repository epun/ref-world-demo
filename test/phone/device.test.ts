/**
 * The device's binding geometry (docs/DEVICE.md §3).
 *
 * These numbers are a contract between two documents: `/phone.html` and
 * `public/draw/index.html` both place the stage against them, so a change on
 * one side only would break the seam. The test states them as arithmetic on
 * `public/device/shell.svg`'s viewBox rather than as copied literals, so a
 * drift in either the artwork or the doc shows up as a failure rather than
 * as a misaligned screen on a handset.
 *
 * The DOM half of device.ts (the chrome, the keys, the ring alignment) is
 * measured in a real browser by the device probe — these tests stay
 * node-only, per the phone test discipline.
 */

import { describe, expect, it } from 'vitest';
import {
  DEVICE_KEYS,
  DEVICE_VIEWBOX,
  DEVICE_WELL,
  KEY_COUNT,
} from '../../src/phone/device';

const VB_W = 100;
const VB_H = 168;

describe('device geometry', () => {
  it('matches the shell artwork viewBox', () => {
    expect(DEVICE_VIEWBOX.width).toBe(VB_W);
    expect(DEVICE_VIEWBOX.height).toBe(VB_H);
  });

  it('pins the screen well to viewBox x 15..85, y 38..124', () => {
    expect(DEVICE_WELL.leftPct).toBeCloseTo((15 / VB_W) * 100, 6);
    expect(DEVICE_WELL.widthPct).toBeCloseTo(((85 - 15) / VB_W) * 100, 6);
    expect(DEVICE_WELL.topPct).toBeCloseTo((38 / VB_H) * 100, 6);
    expect(DEVICE_WELL.heightPct).toBeCloseTo(((124 - 38) / VB_H) * 100, 6);
  });

  it('leaves the well PORTRAIT, with a band above and below the largest core', () => {
    // 70 viewBox units across, 86 down (DEVICE §3, user ruling "you can
    // make it slightly taller if we need more space"). A square well put
    // the alive core edge to edge and left the brow nowhere to go but on
    // top of the drawing; the band is the whole reason the device grew.
    const wellW = (DEVICE_WELL.widthPct / 100) * VB_W;
    const wellH = (DEVICE_WELL.heightPct / 100) * VB_H;
    expect(wellH).toBeGreaterThan(wellW);
    // The alive core is 100% of the WIDTH — the band it leaves is real.
    const band = (wellH - wellW) / 2;
    expect(band).toBeGreaterThan(0);
    // …and the draw core (95%) leaves a wider one still.
    expect((wellH - wellW * 0.95) / 2).toBeGreaterThan(band);
  });

  it('pins the three keys to the drawn rings', () => {
    expect(KEY_COUNT).toBe(3);
    expect(DEVICE_KEYS.centresPct).toEqual([30.5, 50, 70]);
    expect(DEVICE_KEYS.rowTopPct).toBeCloseTo((145 / VB_H) * 100, 6);
    expect(DEVICE_KEYS.diameterPct).toBe(14.4);
  });

  it('keeps every key whole inside the box', () => {
    const half = DEVICE_KEYS.diameterPct / 2;
    for (const centre of DEVICE_KEYS.centresPct) {
      expect(centre - half).toBeGreaterThan(0);
      expect(centre + half).toBeLessThan(100);
    }
  });

  it('keeps the keys clear of the screen well', () => {
    // The keys are on the case, below the screen (DEVICE §2). Their top
    // edge must sit under the well's bottom edge, or a key would be drawn
    // over the display.
    const wellBottomPct = DEVICE_WELL.topPct + DEVICE_WELL.heightPct;
    const keyTopPctOfHeight =
      DEVICE_KEYS.rowTopPct - ((DEVICE_KEYS.diameterPct / 2) * VB_W) / VB_H;
    expect(keyTopPctOfHeight).toBeGreaterThan(wellBottomPct);
  });
});
