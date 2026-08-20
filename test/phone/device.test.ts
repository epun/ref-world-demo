/**
 * The device's binding geometry (docs/DEVICE.md §2, §3).
 *
 * These numbers are a contract between two documents: `/phone.html` and
 * `public/draw/index.html` both place the stage against them, so a change on
 * one side only would break the seam. The test states them as arithmetic on
 * `public/device/shell.svg`'s viewBox rather than as copied literals, so a
 * drift in either the artwork or the doc shows up as a failure rather than
 * as a misaligned screen on a handset.
 *
 * The DOM half of device.ts (the chrome, the keys, the rings they draw
 * themselves) is measured in a real browser by the device probe — these
 * tests stay node-only, per the phone test discipline.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_BOTTOM_AIR_PX,
  DEVICE_KEYS,
  DEVICE_KEY_ROWS,
  DEVICE_TOP_AIR_PX,
  DEVICE_VIEWBOX,
  DEVICE_WELL,
  KEYS_PER_ROW,
  KEY_COUNT,
  KEY_ROW_NAMES,
  NO_KEYS,
} from '../../src/phone/device';

const VB_W = 100;
const VB_H = 178;

describe('device geometry', () => {
  it('matches the shell artwork viewBox', () => {
    expect(DEVICE_VIEWBOX.width).toBe(VB_W);
    expect(DEVICE_VIEWBOX.height).toBe(VB_H);
  });

  it('pins the screen well to viewBox x 15..85, y 46..134', () => {
    expect(DEVICE_WELL.leftPct).toBeCloseTo((15 / VB_W) * 100, 6);
    expect(DEVICE_WELL.widthPct).toBeCloseTo(((85 - 15) / VB_W) * 100, 6);
    expect(DEVICE_WELL.topPct).toBeCloseTo((46 / VB_H) * 100, 6);
    expect(DEVICE_WELL.heightPct).toBeCloseTo(((134 - 46) / VB_H) * 100, 6);
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

  it('pins six keys, in two rows, to the drawn centres', () => {
    expect(KEYS_PER_ROW).toBe(3);
    expect(KEY_ROW_NAMES).toEqual(['top', 'bottom']);
    expect(KEY_COUNT).toBe(6);
    expect(DEVICE_KEYS.centresPct).toEqual([30.5, 50, 70]);
    // The top row occupies the band the `ref` word mark vacated (y 24.6);
    // the bottom row is where the three keys already were (y 145).
    expect(DEVICE_KEYS.rowTopPct.top).toBeCloseTo((26 / VB_H) * 100, 6);
    expect(DEVICE_KEYS.rowTopPct.bottom).toBeCloseTo((156 / VB_H) * 100, 6);
    // The doc quotes these to three decimals; the arithmetic must agree.
    expect(DEVICE_KEYS.rowTopPct.top).toBeCloseTo(14.607, 3);
    expect(DEVICE_KEYS.rowTopPct.bottom).toBeCloseTo(87.640, 3);
    expect(DEVICE_KEYS.diameterPct).toBe(14.4);
  });

  it('draws its own rings at the artwork weight', () => {
    // The shell draws none any more (DEVICE §3) — a hidden row has to leave
    // the case genuinely bare, which an artwork ring could never do. The
    // key's ring is the same 1.5 viewBox units the artwork used, so the
    // case did not change weight when the rings changed owner.
    expect(DEVICE_KEYS.ringStroke).toBe(1.5);
  });

  it('keeps every key whole inside the box', () => {
    const half = DEVICE_KEYS.diameterPct / 2;
    for (const centre of DEVICE_KEYS.centresPct) {
      // The ring's stroke straddles the key's edge, so the outer edge of
      // the ink is half a stroke further out than the key box.
      const edge = half + DEVICE_KEYS.ringStroke / 2;
      expect(centre - edge).toBeGreaterThan(0);
      expect(centre + edge).toBeLessThan(100);
    }
  });

  it('keeps both rows clear of the screen well', () => {
    // The keys are on the case, above and below the screen (DEVICE §2/§3).
    // A key's half-diameter is quoted against the box WIDTH; the row lines
    // are against its HEIGHT, so the clearance is measured in height units.
    const halfHeightPct = ((DEVICE_KEYS.diameterPct / 2) * VB_W) / VB_H;
    const wellTopPct = DEVICE_WELL.topPct;
    const wellBottomPct = DEVICE_WELL.topPct + DEVICE_WELL.heightPct;
    expect(DEVICE_KEYS.rowTopPct.top + halfHeightPct).toBeLessThan(wellTopPct);
    expect(DEVICE_KEYS.rowTopPct.bottom - halfHeightPct).toBeGreaterThan(wellBottomPct);
  });

  it('keeps both rows inside the box', () => {
    const halfHeightPct = ((DEVICE_KEYS.diameterPct / 2) * VB_W) / VB_H;
    expect(DEVICE_KEYS.rowTopPct.top - halfHeightPct).toBeGreaterThan(0);
    expect(DEVICE_KEYS.rowTopPct.bottom + halfHeightPct).toBeLessThan(100);
  });
});

describe('what the case shows, per state (DEVICE §2)', () => {
  it('shows the bottom row alone while drawing', () => {
    expect(DEVICE_KEY_ROWS.draw).toEqual({ top: false, bottom: true });
  });

  it('shows NO keys on the egg — hidden, not dimmed', () => {
    // User ruling: "when the egg is visible on the tamagotchi, let's hide
    // the buttons". Both rows off; the hiding itself is opacity +
    // pointer-events + aria-hidden, never display (asserted in the browser
    // probe, which clicks every key centre and must hit nothing).
    expect(DEVICE_KEY_ROWS.wait).toEqual({ top: false, bottom: false });
    expect(NO_KEYS).toEqual({ top: null, bottom: null });
  });

  it('names the sign state and hides its keys too (DEVICE §2a)', () => {
    // Signing is a state of the /draw/ document's stage, not of the
    // companion's machine — but the CASE is the same object on both sides
    // of the seam, so the contract for its keys lives here.
    expect(DEVICE_KEY_ROWS.sign).toEqual({ top: false, bottom: false });
  });

  it('shows both rows alive — the six emotes are the keys', () => {
    expect(DEVICE_KEY_ROWS.alive).toEqual({ top: true, bottom: true });
  });
});

/**
 * The seam's first paint (docs/PHONE-STAGE.md §4.1).
 *
 * Both documents paint the same paper before any script, which was never the
 * problem — what flashed was the CASE. `/draw/` carries its device in the
 * document; `/phone.html` built its own in device.ts, which cannot run until
 * the phone bundle has parsed and `createSession()` has resolved. Measured in
 * chromium at 390x844: the last frame of `/draw/` showed the case, the first
 * frame of `/phone.html` showed bare paper, and the case stayed gone for
 * ~960ms — the single largest frame-to-frame change anywhere in the flow.
 *
 * These two tests hold the fix in place from both ends: the markup has to be
 * in the document ahead of every script, and mountDevice has to ADOPT it
 * rather than build a second case beside it.
 */
describe('the case is painted before any script (PHONE-STAGE §4.1)', () => {
  const html = readFileSync(
    new URL('../../phone.html', import.meta.url),
    'utf8',
  );

  it('carries the shell as markup, not as something a module inserts', () => {
    expect(html).toContain('class="device-shell"');
    expect(html).toContain('src="/device/shell.svg"');
    expect(html).toContain('class="device-well"');
    expect(html).toContain('class="device-keys"');
  });

  it('puts the case ahead of every script in the document', () => {
    const shell = html.indexOf('class="device-shell"');
    const firstScript = html.indexOf('<script');
    expect(shell).toBeGreaterThan(-1);
    expect(firstScript).toBeGreaterThan(-1);
    // Ahead of the scripts is what makes it the FIRST paint rather than a
    // paint that waits on the network.
    expect(shell).toBeLessThan(firstScript);
  });

  it('resolves the device box from the same measures device.ts does', () => {
    // Mirrored values, not a second geometry (DEVICE §3 — binding on both
    // sides of the seam).
    expect(html).toContain(
      `aspect-ratio: ${DEVICE_VIEWBOX.width} / ${DEVICE_VIEWBOX.height}`,
    );
    expect(html).toContain(
      `calc(100cqh * ${DEVICE_VIEWBOX.width} / ${DEVICE_VIEWBOX.height})`,
    );
    expect(html).toContain(`env(safe-area-inset-top, 0px) + ${DEVICE_TOP_AIR_PX}px`);
    expect(html).toContain(
      `env(safe-area-inset-bottom, 0px) + ${DEVICE_BOTTOM_AIR_PX}px`,
    );
  });
});
