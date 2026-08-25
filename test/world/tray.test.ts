/**
 * The handset tray's one genuinely tricky rule.
 *
 * The device in the middle carries two meanings on one pointer: a tap
 * opens the companion, a hold opens the emotes. Everything that can go
 * wrong is that split going wrong — most damagingly a hold that ALSO
 * navigates, which takes somebody who wanted to react and puts them on
 * another page instead.
 *
 * The DOM wiring is verified in a real browser (this project keeps no
 * jsdom); the decision itself is pure and lives here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOLD_MS,
  TRAY_EMOTES,
  companionBox,
  invertOnto,
  pressMeans,
} from '../../src/world/tray';
import {
  DEVICE_BOTTOM_AIR_PX,
  DEVICE_TOP_AIR_PX,
  DEVICE_VIEWBOX,
} from '../../src/phone/device';
import { PHONE_EMOTES } from '../../src/phone/emotes';
import { BUBBLE_EMOJI } from '../../src/character/bubble';
import { EMOTE_NAMES } from '../../src/net/protocol';

describe('what a press means', () => {
  it('a short press opens the companion', () => {
    expect(pressMeans({ heldLongEnough: false, emotesOpen: false, alreadyGoing: false }))
      .toBe('open-companion');
  });

  it('a long press does NOT also navigate', () => {
    expect(pressMeans({ heldLongEnough: true, emotesOpen: false, alreadyGoing: false }))
      .toBe('nothing');
  });

  it('a release while the emotes are up does nothing', () => {
    // The finger lifting after the ring opened is the END of the hold, not
    // a new tap. Without this a hold reliably navigated on release.
    expect(pressMeans({ heldLongEnough: false, emotesOpen: true, alreadyGoing: false }))
      .toBe('nothing');
  });

  it('a second tap while already going is ignored', () => {
    expect(pressMeans({ heldLongEnough: false, emotesOpen: false, alreadyGoing: true }))
      .toBe('nothing');
  });
});

describe('the tray emotes', () => {
  it('are the six the phone sends, and all real emotes', () => {
    expect(TRAY_EMOTES).toHaveLength(6);
    for (const name of TRAY_EMOTES) {
      expect(EMOTE_NAMES).toContain(name);
    }
  });

  it('leave `angry` out, as the phone does', () => {
    // It stays in EMOTE_NAMES because the world uses it autonomously; this
    // is the person's set, not the protocol's (docs/DEVICE.md §2).
    expect(TRAY_EMOTES).not.toContain('angry');
  });

  it('ARE the phone list, not a copy of it', () => {
    // A hand-written copy drifted within a day: the tray offered 💃/😮 for
    // dance and surprised while the case and the world's speech bubbles
    // used 🎶/😲 (user report, 2026-08-25). One person, one creature, two
    // pictures of the same feeling. Identity, not deep equality — a second
    // array that happens to match today can be edited apart tomorrow.
    expect(TRAY_EMOTES).toBe(PHONE_EMOTES);
  });

  it('draw their glyphs from the same table the speech bubbles do', () => {
    // Pinned as a source fact: the rendering is DOM-shaped and this project
    // keeps no jsdom, so the browser check covers the painting and this
    // covers where the glyphs come from.
    const src = readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');
    expect(src).toMatch(/BUBBLE_EMOJI\[name\]/);
    // ...and no second table to fall out of step with it.
    expect(src).not.toMatch(/const GLYPH/);
    for (const name of TRAY_EMOTES) {
      expect(BUBBLE_EMOJI[name]).toBeTruthy();
    }
  });

  it('holds long enough to be deliberate and short enough to feel instant', () => {
    expect(HOLD_MS).toBeGreaterThanOrEqual(250);
    expect(HOLD_MS).toBeLessThanOrEqual(500);
  });
});

describe('the qr and the device are never both there', () => {
  // They answer questions that cannot both be open: "how do I join" and
  // "where is mine". Offering both would put a way into a world somebody is
  // already in next to a door onto a creature that does not exist.
  it('is a single decision, taken from one flag', () => {
    // Pinned as a source fact because the branch is DOM-shaped and this
    // project keeps no jsdom — the rendering is checked in a real browser.
    const src = readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');
    // exactly one branch — not two independent conditions that could both
    // be true, which is how a qr and a device end up side by side
    expect(src.match(/if \(options\.hasCreature\)/g)?.length).toBe(1);
    // ...and the flag the caller reads is DERIVED from that same one, never
    // decided a second time. The caller owns the qr component, so a tray
    // that merely hides the code still gets one mounted into a dead cell.
    expect(src).toMatch(/showsJoinCode: !options\.hasCreature/);
  });
});

describe('the tray layout', () => {
  const src = () => readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');

  it('puts what is yours in the left corner, not the middle', () => {
    // User ruling, 2026-08-25. The corner means one thing — "yours" —
    // whether that is a join code or your own device, which is what makes
    // them exchangeable rather than two things competing for the centre.
    // The middle column is the spacer, so nothing sits over the world.
    expect(src()).toMatch(/grid-template-columns:\s*auto 1fr auto/);
    expect(src()).toMatch(/\.tray-device \{[^}]*justify-self: start/);
  });

  it('lifts the emote ring by the device HEIGHT, never a picked number', () => {
    // The ring sat at a literal 76px — shorter than the 118px device it
    // belongs to — so the device covered the thing the hold had just
    // opened (user report, 2026-08-25). A number picked by eye can be
    // shorter than the thing it must clear; one derived from that thing
    // cannot.
    expect(src()).toMatch(/bottom: calc\([\s\S]*?DEVICE_H_PX \+ RING_GAP_PX/);
    expect(src()).toMatch(
      /DEVICE_H_PX = \(DEVICE_W_PX \* DEVICE_VIEWBOX\.height\) \/ DEVICE_VIEWBOX\.width/,
    );
  });
});

describe('the way back to the world, on the companion', () => {
  it('sits inside the screen well, not pinned to the viewport', () => {
    // Fixed to the bottom of the viewport it landed under the case's own
    // bottom edge on a phone — visible nowhere, tappable nowhere (user
    // report, 2026-08-25). The well is the positioned ancestor, so
    // `position: absolute` here means "in the screen, below the creature".
    const src = readFileSync(join(process.cwd(), 'src/phone/device.ts'), 'utf8');
    const rule = /\.world-link \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/position: absolute/);
    expect(rule).not.toMatch(/position: fixed/);
  });

  it('is mounted into the well, so that absolute has something to hold to', () => {
    // The rule above is inert if the element is still a child of <body>.
    const src = readFileSync(join(process.cwd(), 'src/phone/main.ts'), 'utf8');
    expect(src).toMatch(/querySelector<HTMLElement>\('\.device-well'\)/);
    expect(src).toMatch(/mountWorldLink\(wellForLink \?\? document\.body/);
  });
});

describe('growing into the companion', () => {
  // The mini device as the tray places it: 62 wide, the artwork's
  // proportions, sitting in the 4vw gutter above the 3vw bottom padding.
  const miniAt = (vw: number, vh: number, insetBottom: number) => {
    const width = 62;
    const height = (width * DEVICE_VIEWBOX.height) / DEVICE_VIEWBOX.width;
    const bottom = vh - insetBottom - vw * 0.03;
    return { left: vw * 0.04, top: bottom - height, width, height };
  };

  const VIEWPORTS = [
    { w: 390, h: 844, top: 0, bottom: 0 },
    { w: 414, h: 896, top: 0, bottom: 0 },
    { w: 360, h: 640, top: 0, bottom: 0 },
    // a notched phone, where guessing zero insets would land it wrong
    { w: 393, h: 852, top: 59, bottom: 34 },
  ];

  it('puts the device where the companion draws it', () => {
    for (const v of VIEWPORTS) {
      const box = companionBox({ width: v.w, height: v.h }, { top: v.top, bottom: v.bottom });

      // Recompute the companion's own layout independently (src/phone/
      // device.ts: .device is the viewport inset by the safe area plus its
      // air; .device-box is the largest box of the artwork's proportions
      // that fits, centred).
      const padTop = v.top + DEVICE_TOP_AIR_PX;
      const padBottom = v.bottom + DEVICE_BOTTOM_AIR_PX;
      const containerH = v.h - padTop - padBottom;
      const w = Math.min(v.w, (containerH * DEVICE_VIEWBOX.width) / DEVICE_VIEWBOX.height);
      const h = (w * DEVICE_VIEWBOX.height) / DEVICE_VIEWBOX.width;

      expect(box.width).toBeCloseTo(w, 3);
      expect(box.height).toBeCloseTo(h, 3);
      expect(box.left).toBeCloseTo((v.w - w) / 2, 3);
      expect(box.top).toBeCloseTo(padTop + (containerH - h) / 2, 3);
      // It keeps the artwork's proportions, never stretching the line work.
      expect(box.height / box.width).toBeCloseTo(
        DEVICE_VIEWBOX.height / DEVICE_VIEWBOX.width,
        6,
      );
      // ...and it fits inside the band it is allowed.
      expect(box.top).toBeGreaterThanOrEqual(padTop - 0.001);
      expect(box.top + box.height).toBeLessThanOrEqual(v.h - padBottom + 0.001);
      expect(box.left).toBeGreaterThanOrEqual(-0.001);
    }
  });

  it('inverts the FULL-SIZE box back onto the thumbnail, not the reverse', () => {
    // The direction is the whole fix. Laid out at 62px and scaled up, the
    // layer is rasterized once at thumbnail size and stretched for the
    // whole flight — the shell turns to mush and the creature, a real 46px
    // canvas, is blown up six times (user report, 2026-08-25). Laid out at
    // full size and inverted, every raster is full resolution.
    for (const v of VIEWPORTS) {
      const box = companionBox({ width: v.w, height: v.h }, { top: v.top, bottom: v.bottom });
      const mini = miniAt(v.w, v.h, v.bottom);
      const inv = invertOnto(box, mini);

      // A DOWN-scale: the element is bigger than the thumbnail it starts on.
      expect(inv.scale).toBeGreaterThan(0);
      expect(inv.scale).toBeLessThan(1);

      // Applied with a top-left origin, it lands exactly on the thumbnail.
      expect(box.left + inv.dx).toBeCloseTo(mini.left, 3);
      expect(box.top + inv.dy).toBeCloseTo(mini.top, 3);
      expect(box.width * inv.scale).toBeCloseTo(mini.width, 3);
      expect(box.height * inv.scale).toBeCloseTo(mini.height, 1);
    }
  });

  it('releases to identity, so the end of the move is exactly the box', () => {
    // The animation runs the inverse to `transform: none`, so the resting
    // state has to BE the destination with no transform applied.
    const src = readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');
    expect(src).toMatch(/transform = 'translate\(0px, 0px\) scale\(1\)'/);
    // The inverted start must not itself animate, or it is a move of its own.
    expect(src).toMatch(/transition = 'none'/);
    expect(src).toMatch(/void device\.offsetWidth/);
  });

  it('moves — it does not dissolve', () => {
    // A solid object that fades on its way somewhere is two things
    // happening. It used to scale to a fixed 6x and fade to nothing.
    const src = readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');
    const rule = /\.tray-device\.growing \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(rule).toBeTruthy();
    expect(rule).not.toMatch(/opacity/);
    expect(rule).toMatch(/transition: transform/);
    // The destination depends on the viewport, so it cannot be a constant.
    expect(rule).not.toMatch(/transform:/);
  });

  it('left-aligns the emote ring to the device', () => {
    // User ruling, 2026-08-25. Both sit in the tray's own 4vw gutter, so
    // the ring's left edge and the device's left edge are one line.
    const src = readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');
    const ring = /\.tray-emotes \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(ring).toMatch(/left: 4vw/);
    expect(ring).not.toMatch(/left: 50%/);
    // The tray's gutter is the same 4vw the ring aligns to.
    expect(src).toMatch(/padding: 0 4vw calc/);
  });
});
