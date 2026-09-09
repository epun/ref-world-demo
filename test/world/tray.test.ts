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
  TRAY_COLUMNS,
  TRAY_EMOTES,
  TRAY_GAP_VW,
  TRAY_PAD_VW,
  middleCellCentre,
  pressMeans,
  trayCornerRoom,
} from '../../src/world/tray';
import { PHONE_EMOTES } from '../../src/phone/emotes';
import { BUBBLE_EMOJI } from '../../src/character/bubble';
import { EMOTE_NAMES } from '../../src/net/protocol';
import { MOTION } from '../../src/taste/tokens';

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
    expect(src()).toMatch(/\.tray-device \{[^}]*justify-self: start/);
    expect(src()).toMatch(/\.tray-left \{ justify-self: start/);
    expect(src()).toMatch(/\.tray-right \{ justify-self: end/);
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

describe('the middle cell — where the stick goes', () => {
  const src = () => readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');

  it('is a real cell, not an anonymous spacer', () => {
    // It used to be `document.createElement('div')` inline in both
    // branches — a spacer nothing could ever be put into. The stick has to
    // land between the device and the map (user ask, 2026-09-08), so the
    // middle needs a name and has to come back out of the mount.
    expect(src()).toMatch(/tray\.append\(device, middle, right\)/);
    expect(src()).toMatch(/tray\.append\(left, middle, right\)/);
    expect(src()).not.toMatch(/tray\.append\([^)]*createElement\('div'\)/);
  });

  it('centres its contents and stays a hole through to the world when empty', () => {
    expect(src()).toMatch(/\.tray-middle \{[^}]*justify-self: center/);
    // The cell itself must never eat a pointer, or an empty middle would
    // block dragging the camera across the bottom of the screen.
    expect(src()).toMatch(/\.tray-middle \{[^}]*pointer-events: none/);
    expect(src()).toMatch(/\.tray-middle > \* \{ pointer-events: auto/);
  });

  it('sits on the middle of the SCREEN, whatever the corners weigh', () => {
    // Measured in chromium at 390 x 844, both templates on the same live
    // tray: `auto 1fr auto` resolved to `62px 273.438px 0px` and put the
    // stick's centre at 225.99 against a half-viewport of 195 — 30.99px
    // off, the user's report. The shipped template resolved to
    // `124.812px 85.7969px 124.828px` and centre 194.99 — 0.01px off.
    //
    // `auto 1fr auto` centres the middle in the LEFTOVER, which is only the
    // middle of the frame when the two corners are the same width. They
    // never are. Even fr columns on both sides split the free space equally
    // whatever is inside them, and the tray's gutters are equal, so the
    // middle column lands on the viewport's centre by construction.
    const at = (columns: 'auto 1fr auto' | typeof TRAY_COLUMNS) =>
      middleCellCentre(
        {
          viewportW: 390,
          padPx: (390 * TRAY_PAD_VW) / 100,
          gapPx: (390 * TRAY_GAP_VW) / 100,
          // Mocked corner widths, deliberately unequal — unequal corners
          // are the whole condition the old template got wrong, and the
          // new one has to be indifferent to.
          leftW: 96,
          rightW: 140,
          middleW: 86,
        },
        columns,
      );
    expect(Math.abs(at(TRAY_COLUMNS) - 195)).toBeLessThan(1);
    // ...and the template it replaced really was off, by half the
    // difference the corners make. Pinned so the regression has a number.
    expect(Math.abs(at('auto 1fr auto') - 195)).toBeGreaterThan(1);
  });

  it('declares that template in the sheet it ships', () => {
    // The maths above models the css; this is what stops the two drifting.
    expect(src()).toMatch(/grid-template-columns: \$\{TRAY_COLUMNS\}/);
    expect(TRAY_COLUMNS).toBe('minmax(0, 1fr) auto minmax(0, 1fr)');
    // minmax(0, ...) rather than a bare `1fr`: a bare fr floors at its
    // content's min-content width, so a wide corner would shove the middle
    // off centre again — the same bug wearing a different hat.
    expect(TRAY_COLUMNS).not.toBe('1fr auto 1fr');
    // The gutters are the two numbers the centring depends on, and they
    // have to be the same on both sides.
    expect(src()).toMatch(/padding: 0 \$\{TRAY_PAD_VW\}vw calc\(/);
    expect(src()).toMatch(/gap: \$\{TRAY_GAP_VW\}vw/);
  });

  it('leaves the corners room at the narrowest phone anybody holds', () => {
    // The reason this is a grid and not an absolutely positioned stick at
    // left: 50%. Out of flow, nothing stops a corner growing underneath
    // it; in the grid the corners can see the stick. At 320px the left
    // column still clears the 62px device.
    const room = trayCornerRoom({
      viewportW: 320,
      padPx: (320 * TRAY_PAD_VW) / 100,
      gapPx: (320 * TRAY_GAP_VW) / 100,
      middleW: 84, // STICK_MIN_PX — 22vw is below the floor at this width
    });
    expect(room).toBeGreaterThan(62);
  });

  it('offers the cell only to somebody who has a creature to move', () => {
    // Same rule the corner already follows — a stick that steers nothing
    // is the one control here that would not mean anything. Handed out as
    // null rather than as a hidden element, for the reason `showsJoinCode`
    // exists: a caller that is merely asked not to use a cell still mounts
    // into it, which is how the qr ended up inside a hidden slot.
    expect(src()).toMatch(/middle: options\.hasCreature \? middle : null/);
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

describe('opening the companion', () => {
  const trayFor = () => readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');

  it('opens a panel — it does not navigate', () => {
    // Navigating unloaded the world, and coming back rebuilt all sixty-eight
    // creatures from nothing: three documents and two full rebuilds for one
    // round trip (user report, 2026-08-25). It was slow, and animating a
    // slide while the next document booted is what made it feel rough.
    const src = trayFor();
    expect(src).toMatch(/options\.openCompanion\(\)/);
    expect(src).not.toMatch(/window\.location\.href/);
    expect(src).not.toMatch(/companionHref/);
    // ...and no leftover growth, which is what this replaced.
    expect(src).not.toMatch(/growing|companionBox|invertOnto|safeInsets/);
  });

  it('frames the real companion rather than rebuilding one', () => {
    // A lookalike device in the world page would drift from the actual
    // companion; /phone.html is a whole page with its own boot and stage.
    const src = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(src).toMatch(/createCompanionPanel\(document\.body, \{/);
    // The url itself, not the prose around it: the frame is what slides, so
    // the case inside must NOT be told to (no `from=world`, which is why
    // the arriving class no longer exists anywhere).
    const href = /href: `\/phone\.html\?[^`]*`/.exec(src)?.[0] ?? '';
    expect(href).toBe('href: `/phone.html?room=${room}${worldParam}`');
    expect(readFileSync(join(process.cwd(), 'phone.html'), 'utf8')).not.toMatch(/arriving/);
    expect(readFileSync(join(process.cwd(), 'src/phone/device.ts'), 'utf8')).not.toMatch(/arriving/);
  });

  it('stops drawing what the panel covers', () => {
    const src = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(src).toMatch(/world\.setPaused\(visible\)/);
    // The thumbnail is a second gl context, and it is under the panel too.
    expect(src).toMatch(/tray\?\.setPortraitPaused\(visible\)/);
  });

  it('left-aligns the emote ring to the device', () => {
    // User ruling, 2026-08-25. Both sit in the tray's own 4vw gutter, so
    // the ring's left edge and the device's left edge are one line.
    const ring = /\.tray-emotes \{[\s\S]*?\n\}/.exec(trayFor())?.[0] ?? '';
    expect(ring).toMatch(/left: 4vw/);
    expect(ring).not.toMatch(/left: 50%/);
    // The tray's own gutter, which the ring shares. It reads from the
    // constant now that the grid maths needs the same number.
    expect(TRAY_PAD_VW).toBe(4);
    expect(trayFor()).toMatch(/padding: 0 \$\{TRAY_PAD_VW\}vw calc/);
  });
});

describe('the companion panel', () => {
  const src = () => readFileSync(join(process.cwd(), 'src/world/companionpanel.ts'), 'utf8');

  it('slides by the same offset the case does on the way out', () => {
    // One gesture, one distance: the panel arriving and the case leaving
    // are the same move, so they must not be two different numbers.
    expect(src()).toMatch(/transform: translateY\(106%\)/);
    const deviceTs = readFileSync(join(process.cwd(), 'src/phone/device.ts'), 'utf8');
    expect(deviceTs).toMatch(/\.device\.leaving \{[\s\S]*?translateY\(106%\)/);
  });

  it('takes itself out of reach when closed, not just out of sight', () => {
    // A frame merely translated away still swallows taps meant for the
    // tray underneath it.
    expect(src()).toMatch(/visibility: hidden/);
    expect(src()).toMatch(/visibility 0s linear \$\{MOTION\.secondaryMs\}ms/);
  });

  it('only listens to its own origin', () => {
    // The listener is on `window`; anything on the page can post to it.
    expect(src()).toMatch(/event\.origin !== window\.location\.origin/);
    expect(src()).toMatch(/event\.data !== CLOSE_MESSAGE/);
  });

  it('keeps the frame once built, so the second toggle costs nothing', () => {
    expect(src()).toMatch(/if \(frame\) return frame/);
    // close() must not tear it down.
    const close = /function close\(\)[\s\S]*?\n  \}/.exec(src())?.[0] ?? '';
    expect(close).toBeTruthy();
    expect(close).not.toMatch(/remove\(\)|destroy/);
  });
});

describe('the framed companion asks to be closed', () => {
  it('posts to its parent instead of navigating', () => {
    // Navigating would reload the world it is sitting on top of, which is
    // the entire thing this avoids.
    const src = readFileSync(join(process.cwd(), 'src/phone/worldlink.ts'), 'utf8');
    expect(src).toMatch(/window\.parent\.postMessage\(CLOSE_MESSAGE, window\.location\.origin\)/);
    expect(src).toMatch(/if \(framed\(\)\) \{/);
    // A cross-origin parent is not our panel — behave as a page.
    expect(src).toMatch(/return false;/);
  });

  it('still navigates when it really is a page', () => {
    const src = readFileSync(join(process.cwd(), 'src/phone/worldlink.ts'), 'utf8');
    expect(src).toMatch(/options\.device\?\.classList\.add\('leaving'\)/);
    expect(src).toMatch(/setTimeout\(\(\) => go\(href\), MOTION\.secondaryMs\)/);
  });
});
