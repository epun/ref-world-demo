/**
 * The handset's tray, under the world.
 *
 * On a phone the world is the whole view (user ruling, 2026-08-25), which
 * leaves the three things a person there actually needs with nowhere to
 * live. So they get one row along the bottom, in the order they are
 * reached for:
 *
 *     [ qr | device ]                      [ minimap ]
 *      join   yours                            where
 *
 * The device sits in the LEFT corner (user ruling, 2026-08-25), in the
 * same cell the join code uses — which is what makes them exchangeable
 * rather than two things competing for the middle.
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

import { BUBBLE_EMOJI } from '../character/bubble';
import { DEVICE_VIEWBOX, DEVICE_WELL } from '../phone/device';
import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import { PHONE_EMOTES } from '../phone/emotes';
import { mountMiniCreature, type MiniCreatureHandle } from './minicreature';
import type { EmoteName } from '../net/protocol';
import type { StrokeList } from '../shape/types';

/**
 * The six, in the phone's own order — not a copy of them.
 *
 * A hand-written copy here drifted from the case within a day: the tray
 * offered 💃 for `dance` and 😮 for `surprised` while the companion and
 * the world's speech bubbles used 🎶 and 😲 (user report, 2026-08-25).
 * Same person, same creature, two different pictures of the same feeling.
 * Both the list and the glyphs now come from where they are defined.
 */
export const TRAY_EMOTES: readonly EmoteName[] = PHONE_EMOTES;

/** How long a press has to last before it means "the emotes", not "open". */
export const HOLD_MS = 320;

/**
 * The hint above the device, the first time somebody lands here.
 *
 * Press-and-hold is not discoverable. Nothing on screen suggests the
 * device does anything but open, so the emotes — the one thing a person
 * can do to their own creature from the world — go unfound (user ruling,
 * 2026-08-26).
 *
 * Said once and never again: this is a hint, not a label, and a label that
 * never leaves is a thing to look at forever. Remembered per browser, so a
 * second visit is clean.
 */
const HINT_KEY = 'refworld:hinted-emote';
const HINT_TEXT = 'tap and hold to emote';
/**
 * How long the hint stays up.
 *
 * Measured at two ambient periods it was readable for about two seconds —
 * it fades in over t.secondary, and a person who has just landed is
 * looking at the creatures, not the corner. It also dismisses the moment
 * they touch the device, so there is no cost to leaving it up longer and
 * a real cost to it being gone before it was read.
 */
const HINT_LIFE_MS = MOTION.ambientMs * 4;

/** Has this browser already been told? Storage may throw; then just tell them. */
function alreadyHinted(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberHinted(): void {
  try {
    window.localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* private window: the hint simply shows again next time */
  }
}

/** The mini device's width on screen. Everything else is derived from it. */
const DEVICE_W_PX = 62;
/** ...including its height, from the real artwork's proportions. */
const DEVICE_H_PX = (DEVICE_W_PX * DEVICE_VIEWBOX.height) / DEVICE_VIEWBOX.width;
/**
 * Air between the top of the device and the emote ring.
 *
 * The ring used to sit at a picked 76px, which is SHORTER than the device
 * it belongs to — so the device covered the thing the hold had just opened
 * (user report, 2026-08-25). Deriving the offset from the device's own
 * height is what stops that recurring the next time the device resizes.
 */
const RING_GAP_PX = 12;

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
  /** Open the companion. The tray does not navigate — see companionpanel.ts. */
  openCompanion(): void;
  /**
   * This handset's own drawing, for the creature in the mini screen. Absent
   * (or unbuildable) leaves the screen empty rather than faking one.
   */
  strokes?: StrokeList;
  /** Their drawing id, so the mini creature matches the world's exactly. */
  identity?: string;
  /** Play an emote. Returns false when there is no creature to play it on. */
  emote(name: EmoteName): boolean;
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
  /**
   * Stop drawing the creature in the mini screen — for when the companion
   * panel is covering the whole tray. A no-op when there is no creature.
   */
  setPortraitPaused(paused: boolean): void;
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
  /* Two ends and the air between them: whatever is yours on the left,
     where you are on the right. Nothing takes the middle — the middle is
     the world. */
  grid-template-columns: auto 1fr auto;
  align-items: end;
  gap: 3vw;
  padding: 0 4vw calc(env(safe-area-inset-bottom, 0px) + 3vw);
  pointer-events: none;
}
.world-tray > * { pointer-events: auto; }
.tray-left { justify-self: start; }
.tray-right { justify-self: end; }

/* The device, small. Same artwork, further away. */
.tray-device {
  justify-self: start;
  position: relative;
  width: ${DEVICE_W_PX}px;
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
/*
 * The screen. A live creature, not a picture of one — see minicreature.ts.
 * Clipped to the well the artwork already draws, so the shell's own rounded
 * corner is what frames it.
 */
.tray-device-screen {
  position: absolute;
  left: ${DEVICE_WELL.leftPct}%;
  top: ${DEVICE_WELL.topPct}%;
  width: ${DEVICE_WELL.widthPct}%;
  height: ${DEVICE_WELL.heightPct}%;
  display: block;
  pointer-events: none;
}

/*
 * The first-run hint. Type over a hairline rule, sitting above the device
 * — the same mark the way back to the world uses (TASTE §4: icon +
 * ruleLine + border, no filled bubble and no card).
 *
 * It SLIDES in and out like everything else, and it is out of the way of
 * pointer events entirely: a hint that can swallow the tap it is
 * explaining would be worse than no hint.
 */
.tray-hint {
  position: fixed;
  left: 4vw;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 3vw + ${Math.round(DEVICE_H_PX + RING_GAP_PX)}px);
  padding-bottom: 0.5em;
  border-bottom: 1px solid ${WORLD.ink};
  color: ${WORLD.ink};
  font: 400 13px/1.3 "helvetica neue", helvetica, arial, sans-serif;
  pointer-events: none;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.tray-hint.in { opacity: 1; transform: translateY(0); }

/* The emote ring — only while held. */
.tray-emotes {
  position: fixed;
  /* Above the device, clear of it: the offset is the device's own height
     plus air, so it cannot end up shorter than the thing it must clear. */
  bottom: calc(env(safe-area-inset-bottom, 0px) + 3vw + ${Math.round(DEVICE_H_PX + RING_GAP_PX)}px);
  /* LEFT-ALIGNED TO THE DEVICE (user ruling, 2026-08-25), sharing the
     tray's own 4vw gutter — so the ring's left edge and the device's left
     edge are the same line, and the ring reads as belonging to the thing
     that opened it rather than floating over the middle of the world. */
  left: 4vw;
  transform: translate(0, 10px);
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
.tray-emotes.open { opacity: 1; transform: translate(0, 0); pointer-events: auto; }
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

  // Assigned below, once the device is built; the ring's handlers close
  // over this rather than over the handle, because the ring is built first.
  let miniRef: MiniCreatureHandle | null = null;

  const ring = document.createElement('div');
  ring.className = 'tray-emotes';
  ring.setAttribute('role', 'group');
  ring.setAttribute('aria-label', 'react');
  for (const name of TRAY_EMOTES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tray-emote';
    b.textContent = BUBBLE_EMOJI[name];
    b.setAttribute('aria-label', name);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      // Play it locally too, exactly as the companion does: the portrait
      // is the identical pipeline, so it needs nothing from the wire, and
      // a round trip through the broker would put visible lag on the
      // person's own tap.
      if (options.emote(name)) miniRef?.emote(name);
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
  const going = false;

  const startPress = (): void => {
    // Touching the device answers the hint — leave it up and it is telling
    // somebody something they are already doing.
    dropHint();
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
    setOpen(false);
    // The move belongs to the panel: the companion slides up from the
    // bottom over a world that stays exactly where it is. Nothing here
    // navigates, so nothing unloads and nothing is rebuilt on the way back.
    //
    // `going` is deliberately NOT latched — the panel can be opened again
    // after it closes, and this page never goes away to reset it.
    options.openCompanion();
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

  // The left corner holds whichever of the two this person needs, and the
  // spacer keeps the minimap at the far end either way.
  let mini: MiniCreatureHandle | null = null;
  // The first-run hint, above the device it explains.
  let hint: HTMLElement | null = null;
  let hintTimer = 0;
  const dropHint = (): void => {
    if (!hint) return;
    const el = hint;
    hint = null;
    window.clearTimeout(hintTimer);
    el.classList.remove('in');
    // Let it slide out before it goes, like everything else here.
    window.setTimeout(() => el.remove(), MOTION.secondaryMs);
  };

  if (options.hasCreature) {
    if (options.strokes && options.strokes.length > 0 && options.identity) {
      // A live creature in the screen, built from this handset's own
      // strokes through the same pure pipeline the world used — so it is
      // the same creature, not a likeness of it.
      mini = mountMiniCreature({ strokes: options.strokes, identity: options.identity });
      if (mini) {
        device.appendChild(mini.canvas);
        miniRef = mini;
      }
    }
    tray.append(device, document.createElement('div'), right);
    root.append(tray, ring);

    // Only for somebody who has a creature to emote WITH, and only once.
    if (!alreadyHinted()) {
      hint = document.createElement('div');
      hint.className = 'tray-hint';
      hint.textContent = HINT_TEXT;
      root.append(hint);
      // Two frames, not one: an element appended this frame has no rendered
      // state to transition FROM, so a class added immediately is simply
      // its initial style and nothing animates. Same trap as the panel.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => hint?.classList.add('in'));
      });
      rememberHinted();
      hintTimer = window.setTimeout(dropHint, HINT_LIFE_MS);
    }
  } else {
    // No creature yet: the join code stands where the device would, so the
    // corner means one thing — "yours" — whether or not you have one.
    tray.append(left, document.createElement('div'), right);
    root.append(tray);
  }

  return {
    root: tray,
    showsJoinCode: !options.hasCreature,
    left,
    right,
    setPortraitPaused: (next: boolean): void => mini?.setPaused(next),
    setEmotesOpen: setOpen,
    emotesOpen: () => open,
    destroy(): void {
      window.clearTimeout(holdTimer);
      window.clearTimeout(hintTimer);
      hint?.remove();
      window.removeEventListener('pointerdown', dismiss, true);
      mini?.dispose();
      tray.remove();
      ring.remove();
    },
  };
}
