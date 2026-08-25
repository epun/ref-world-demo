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
import { HOLD_MS, TRAY_EMOTES, pressMeans } from '../../src/world/tray';
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

describe('opening the companion', () => {
  const trayFor = () => readFileSync(join(process.cwd(), 'src/world/tray.ts'), 'utf8');

  it('just goes — the tray plays no growth of its own', () => {
    // Scaling the 62px thumbnail up to full screen rasterizes the layer
    // once at thumbnail size and stretches it for the whole flight, so the
    // shell turned to mush and the creature, a real 46px canvas, was blown
    // up six times (user report, 2026-08-25). The move belongs to the
    // companion now.
    const src = trayFor();
    expect(src).not.toMatch(/growing/);
    expect(src).not.toMatch(/companionBox|invertOnto|safeInsets/);
    // No inline geometry left behind on the device either.
    expect(src).not.toMatch(/device\.style\.(transform|position|left|top|width|height)/);
  });

  it('tells the companion where the person came from', () => {
    // The companion slides its case up only for `from=world`; the /draw/
    // handoff must not, because that seam works by the case already being
    // exactly where it was (PHONE-STAGE §4.1).
    const src = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(src).toMatch(/companionHref: `\/phone\.html\?room=\$\{room\}\$\{worldParam\}&from=world`/);
  });

  it('left-aligns the emote ring to the device', () => {
    // User ruling, 2026-08-25. Both sit in the tray's own 4vw gutter, so
    // the ring's left edge and the device's left edge are one line.
    const ring = /\.tray-emotes \{[\s\S]*?\n\}/.exec(trayFor())?.[0] ?? '';
    expect(ring).toMatch(/left: 4vw/);
    expect(ring).not.toMatch(/left: 50%/);
    expect(trayFor()).toMatch(/padding: 0 4vw calc/);
  });
});

describe('the case slides, both directions', () => {
  // One move played forwards and backwards: out to the world, back to the
  // device. Same offset, same duration, same curve — anything else and the
  // two read as unrelated events rather than one gesture reversed.
  const deviceTs = () => readFileSync(join(process.cwd(), 'src/phone/device.ts'), 'utf8');
  const phoneHtml = () => readFileSync(join(process.cwd(), 'phone.html'), 'utf8');

  it('leaves and arrives by the same offset', () => {
    expect(deviceTs()).toMatch(/\.device\.leaving,\s*\n\.device\.arriving \{\s*\n\s*transform: translateY\(106%\);/);
  });

  it('drives the arrival inline, not from the module', () => {
    // The module is ~840kB and does not run for about a second. An arrival
    // that waited for it would leave the person looking at bare paper for
    // that whole second before anything moved.
    const html = phoneHtml();
    expect(html).toMatch(/\.device\.arriving \{[\s\S]*?translateY\(106%\)/);
    expect(html).toMatch(/transition: transform 912ms cubic-bezier\(0\.17, 0\.72, 0\.24, 1\)/);
    // ...and it is set before the first paint, or the case animates the
    // wrong way first.
    expect(html).toMatch(/classList\.add\('arriving'\)/);
    expect(html).toMatch(/requestAnimationFrame\([\s\S]*?requestAnimationFrame/);
  });

  it('only slides in when the person came from the world', () => {
    expect(phoneHtml()).toMatch(/get\('from'\) !== 'world'\) return/);
  });

  it('mirrors the inline duration from the motion token', () => {
    // phone.html cannot import from src/, so the number is copied — and a
    // copy that drifts is the failure mode (DEVICE §3).
    expect(MOTION.secondaryMs).toBe(912);
    expect(MOTION.settleCurve.replace(/\s/g, '')).toBe('cubic-bezier(0.17,0.72,0.24,1.0)');
  });
});
