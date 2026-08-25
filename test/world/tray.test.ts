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
