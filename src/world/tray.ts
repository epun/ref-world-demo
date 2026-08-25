/**
 * The handset's tray, under the world.
 *
 * On a phone the world is the whole view (user ruling, 2026-08-25), which
 * leaves the three things a person there actually needs with nowhere to
 * live. So they get one row along the bottom, in the order they are
 * reached for:
 *
 *     [ qr ]        [ the device ]        [ minimap ]
 *      join            yours                 where
 *
 * The qr and the device are MUTUALLY EXCLUSIVE, because the questions they
 * answer are (user ruling, 2026-08-25). Before you have a creature the qr
 * is the only thing you need and the device would open onto nothing;
 * after, the device is yours and the qr is an invitation you have already
 * accepted. One cell, two states — never both, never neither.
 *
 * The device in the middle is a MINIATURE OF THE REAL ONE — the same
 * `public/device/shell.svg`, not a drawing of a device. It is the same
 * object seen from further away, which is what makes tapping it grow into
 * the full thing read as a move rather than a page change.
 *
 * TAP grows it into the companion. PRESS AND HOLD opens the emotes. That
 * split is deliberate: the common action is the cheap one, and the
 * six-way choice hides until it is asked for, so the tray stays three
 * quiet marks instead of a control panel over the world.
 *
 * Mark set holds (TASTE §4): the qr and minimap keep their own hairline
 * borders, the device is the illustrated prop it already was, and the
 * emote ring is icons on paper. No filled tray, no card, no shadow — the
 * row is a layout, not a surface.
 */

import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import type { EmoteName } from '../net/protocol';

/** The six the phone can send (mirrors src/phone/screens/alive.ts). */
export const TRAY_EMOTES: readonly EmoteName[] = [
  'wave',
  'happy',
  'surprised',
  'dance',
  'sleepy',
  'sad',
];

const GLYPH: Record<string, string> = {
  wave: '👋',
  happy: '😊',
  surprised: '😮',
  dance: '💃',
  sleepy: '😴',
  sad: '😢',
};

/** How long a press has to last before it means "the emotes", not "open". */
export const HOLD_MS = 320;

/** What a finished press meant. Pure, so the split is testable without a DOM. */
export type PressResult = 'open-companion' | 'nothing';

/**
 * What lifting the finger should do.
 *
 * The whole risk in one control with two meanings is that a press does
 * BOTH — the hold opens the emotes and then the release also navigates,
 * and the person who wanted to react ends up on another page. So the rule
 * is written once, here, and the handler only obeys it.
 */
export function pressMeans(state: {
  heldLongEnough: boolean;
  emotesOpen: boolean;
  alreadyGoing: boolean;
}): PressResult {
  if (state.alreadyGoing) return 'nothing';
  if (state.heldLongEnough || state.emotesOpen) return 'nothing';
  return 'open-companion';
}

export interface TrayOptions {
  /**
   * Has this handset already drawn?
   *
   * Decides the left half of the tray outright: with a creature you get the
   * device and no join code, without one you get the join code and no
   * device. Showing both would offer a person a way into a world they are
   * already in, next to a door onto a creature that does not exist.
   */
  hasCreature: boolean;
  /** Where the mini device leads on a tap. */
  companionHref: string;
  /** Play an emote. Returns false when there is no creature to play it on. */
  emote(name: EmoteName): boolean;
  /** Injectable for tests; defaults to a real navigation. */
  navigate?: (href: string) => void;
}

export interface TrayHandle {
  root: HTMLElement;
  /**
   * Does this tray want a join code at all?
   *
   * The caller owns the qr component, so it has to be TOLD not to build
   * one — a tray that merely declines to show it still ends up with a qr
   * mounted into a hidden cell, which is how this went wrong the first
   * time. False when the person already has a creature.
   */
  showsJoinCode: boolean;
  /** Left cell — the join code mounts here, when there is one. */
  left: HTMLElement;
  /** Right cell — the minimap mounts here. */
  right: HTMLElement;
  /** Open/close the emote ring from outside (tests). */
  setEmotesOpen(open: boolean): void;
  emotesOpen(): boolean;
  destroy(): void;
}

const STYLE_ID = 'world-tray-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.world-tray {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  gap: 3vw;
  padding: 0 4vw calc(env(safe-area-inset-bottom, 0px) + 3vw);
  pointer-events: none;
}
.world-tray > * { pointer-events: auto; }
.tray-left { justify-self: start; }
.tray-right { justify-self: end; }
/* the join code, when it is standing where the device would be */
.tray-centre { justify-self: center; }

/* The device, small. Same artwork, further away. */
.tray-device {
  justify-self: center;
  position: relative;
  width: 62px;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  /*
   * A press-and-hold is the OS's gesture before it is ours: on a phone it
   * raises the selection handles and the share sheet, and on ios it also
   * fires the image long-press menu on the shell. All three land on top of
   * the emote ring we just opened. The same class of bug as the drag that
   * highlighted the character like a text input — a control that is held
   * has to opt out of being text.
   */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  transform-origin: 50% 100%;
  transition: transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.tray-device img {
  display: block;
  width: 100%;
  height: auto;
  pointer-events: none;
  -webkit-user-drag: none;
}
.tray-device:active { transform: scale(0.96); }
/* Tapped: it grows into the full device before the page changes, so the
 * companion's first frame lands on something already the right size. */
.tray-device.growing {
  transition: transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
              opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
  transform: scale(6);
  opacity: 0;
}

/* The emote ring — only while held. */
.tray-emotes {
  position: fixed;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 3vw + 76px);
  transform: translate(-50%, 10px);
  display: flex;
  gap: 2.5vw;
  padding: 2.5vw 3.5vw;
  border: 1px solid ${WORLD.ink};
  border-radius: 999px;
  background: ${SURFACE.ground};
  opacity: 0;
  pointer-events: none;
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.tray-emotes.open { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.tray-emote {
  font-size: 22px;
  line-height: 1;
  border: 0;
  padding: 4px;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.tray-emote:active { transform: scale(0.88); }
`;
  document.head.appendChild(style);
}

/**
 * Mount the tray. The caller mounts the join code into `left` and the
 * minimap into `right`; this owns only the middle and the ring.
 */
export function mountWorldTray(root: HTMLElement, options: TrayOptions): TrayHandle {
  ensureStyle();
  const go = options.navigate ?? ((href: string) => { window.location.href = href; });

  const tray = document.createElement('div');
  tray.className = 'world-tray';

  const left = document.createElement('div');
  left.className = 'tray-left';
  const right = document.createElement('div');
  right.className = 'tray-right';

  // Only one of these two is ever built.
  const device = document.createElement('button');
  device.type = 'button';
  device.className = 'tray-device';
  device.setAttribute('aria-label', 'your creature — hold to react');
  const shell = document.createElement('img');
  shell.src = '/device/shell.svg';
  shell.alt = '';
  shell.decoding = 'async';
  device.appendChild(shell);

  const ring = document.createElement('div');
  ring.className = 'tray-emotes';
  ring.setAttribute('role', 'group');
  ring.setAttribute('aria-label', 'react');
  for (const name of TRAY_EMOTES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tray-emote';
    b.textContent = GLYPH[name] ?? '·';
    b.setAttribute('aria-label', name);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      options.emote(name);
      setOpen(false);
    });
    ring.appendChild(b);
  }

  let open = false;
  function setOpen(next: boolean): void {
    open = next;
    ring.classList.toggle('open', next);
  }

  // ── the press ───────────────────────────────────────────────────────────
  // A tap opens the companion; a hold opens the emotes. One pointer, two
  // meanings, split on time — so the timer has to be cancelled by anything
  // that ends the press, or a hold that becomes a tap opens both.
  let holdTimer = 0;
  let held = false;
  let going = false;

  const startPress = (): void => {
    if (going) return;
    held = false;
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      held = true;
      setOpen(true);
    }, HOLD_MS);
  };

  const endPress = (): void => {
    window.clearTimeout(holdTimer);
    if (pressMeans({ heldLongEnough: held, emotesOpen: open, alreadyGoing: going }) !== 'open-companion') {
      return;
    }
    going = true;
    // Grow into the full device, THEN navigate. The companion paints its
    // own case on the first frame, so the two sizes meet and nothing cuts.
    device.classList.add('growing');
    window.setTimeout(() => go(options.companionHref), MOTION.secondaryMs);
  };

  const cancelPress = (): void => {
    window.clearTimeout(holdTimer);
  };

  device.addEventListener('pointerdown', startPress);
  device.addEventListener('pointerup', endPress);
  device.addEventListener('pointercancel', cancelPress);
  device.addEventListener('pointerleave', cancelPress);
  // A hold ends when the finger lifts anywhere, and the ring should not
  // outlive a tap on the world behind it.
  const dismiss = (event: Event): void => {
    if (!open) return;
    if (event.target instanceof Node && ring.contains(event.target)) return;
    if (event.target instanceof Node && device.contains(event.target)) return;
    setOpen(false);
  };
  window.addEventListener('pointerdown', dismiss, true);

  if (options.hasCreature) {
    // No join code: an empty cell keeps the three columns, so the device
    // stays centred on the screen rather than drifting to fill the gap.
    tray.append(document.createElement('div'), device, right);
    root.append(tray, ring);
  } else {
    // No creature yet: the join code takes the middle, where the device
    // would be. It is the only thing on this screen a person without a
    // creature can act on, so it gets the place the eye goes.
    left.classList.add('tray-centre');
    tray.append(document.createElement('div'), left, right);
    root.append(tray);
  }

  return {
    root: tray,
    showsJoinCode: !options.hasCreature,
    left,
    right,
    setEmotesOpen: setOpen,
    emotesOpen: () => open,
    destroy(): void {
      window.clearTimeout(holdTimer);
      window.removeEventListener('pointerdown', dismiss, true);
      tray.remove();
      ring.remove();
    },
  };
}
