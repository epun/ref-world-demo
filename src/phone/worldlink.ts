/**
 * The way from your creature to the place it lives.
 *
 * A public world is a thing built together, and until now the people who
 * built it were the only ones who could not look at it: the handset showed
 * you your own creature in a case, and the shared world existed only on a
 * projection you were probably not standing in front of.
 *
 * USER RULING, 2026-08-25: the world takes the WHOLE viewport and the
 * device slides away — not the world inside the device's screen well. The
 * well is 74% of a phone's width, and a world seen through it would be a
 * diorama in a keyhole. The device is the thing that is yours; the world is
 * the place. They are different sizes of idea.
 *
 * The seam is the same one `/draw/` → `/phone.html` already uses
 * (PHONE-STAGE §4): the case leaves first, on the settle curve, and only
 * then does the navigation happen — so the last frame here and the first
 * frame there are both bare paper, and there is nothing to flash between.
 */

import { MOTION } from '../taste/tokens';
import { wavyBorderPath, wavyBorderPoints } from './minimap';
import { CLOSE_MESSAGE } from '../world/companionpanel';

/** This control's own hand — not the map's seed, not the join code's. */
const BORDER_SEED = 41.7;
/** Room for the waver to move without clipping at the element's edge. */
const BORDER_INSET = 2.5;

/** Are we the companion inside the world's panel, rather than a page? */
function framed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    // Cross-origin parent: not our panel, so behave as a page.
    return false;
  }
}

export interface WorldLinkOptions {
  /** The room, so the world opens on the same one. */
  room: string;
  /** The public world's name. Without one there is no shared world to see. */
  world: string;
  /** The device, so it can leave before the page does. */
  device?: HTMLElement | null;
  /** Injectable for the tests; defaults to a real navigation. */
  navigate?: (href: string) => void;
}

export interface WorldLinkHandle {
  el: HTMLAnchorElement;
  destroy(): void;
}

/** Where the world view lives, for this room and world. */
export function worldHref(room: string, world: string): string {
  const params = new URLSearchParams();
  if (room) params.set('room', room);
  if (world) params.set('world', world);
  // `view=world` is what stops the world page bouncing a handset straight
  // back to the drawing pad.
  params.set('view', 'world');
  return `/?${params.toString()}`;
}

/**
 * Mount the link under the device. Returns null when there is no public
 * world — an installation handset has no shared place to go, and a control
 * that leads nowhere is worse than no control.
 */
export function mountWorldLink(
  root: HTMLElement,
  options: WorldLinkOptions,
): WorldLinkHandle | null {
  if (!options.world) return null;

  const el = document.createElement('a');
  el.className = 'world-link';
  const href = worldHref(options.room, options.world);
  el.href = href;

  /*
   * A BUTTON, drawn by the same hand as the minimap (user ruling,
   * 2026-08-25). It was type over a hairline rule, which reads as a
   * caption — and this is the only way out of the device, so it has to
   * look like something you press.
   *
   * A border, not a fill and not a shadow: the mark set is icon +
   * ruleLine + border and nothing else (TASTE §4). What makes it a button
   * rather than a card is that the border goes all the way round and the
   * text sits inside it with room to breathe.
   *
   * The border is the project's own wavering loop — the identical
   * generator and smoothing the minimap and the join code frame use, so
   * the three read as drawn by one person rather than three.
   *
   * Lowercase, always: no uppercase type anywhere in this world (TASTE
   * §5), which is why it is 'view world' and not 'View World'.
   */
  const frame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  frame.setAttribute('class', 'world-link-frame');
  frame.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outline.setAttribute('fill', 'none');
  outline.setAttribute('stroke', 'currentColor');
  outline.setAttribute('stroke-width', '1');
  outline.setAttribute('stroke-linejoin', 'round');
  frame.appendChild(outline);

  const label = document.createElement('span');
  label.className = 'world-link-label';
  label.textContent = 'view world';
  el.append(frame, label);

  /** Redraw the border at the element's real size. Idempotent. */
  let drawnAt = '';
  const drawFrame = (): void => {
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);
    if (w < 2 || h < 2) return;
    const key = `${w}x${h}`;
    if (key === drawnAt) return;
    drawnAt = key;
    frame.setAttribute('viewBox', `0 0 ${w} ${h}`);
    outline.setAttribute('d', wavyBorderPath(wavyBorderPoints(w, h, BORDER_INSET, BORDER_SEED)));
  };

  const go = options.navigate ?? ((to: string) => { window.location.href = to; });

  el.addEventListener('click', (event) => {
    // Let a long-press / open-in-new-tab behave normally; only the plain
    // tap gets the choreography.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (el.dataset['going'] === 'true') return;
    el.dataset['going'] = 'true';

    el.classList.remove('in');
    el.classList.add('out');

    if (framed()) {
      // Inside the world's panel: the PANEL slides, and the world behind it
      // is still standing exactly as it was left — nothing to navigate to
      // and nothing to rebuild. Sliding the case as well would be two
      // objects leaving at once for one gesture.
      window.parent.postMessage(CLOSE_MESSAGE, window.location.origin);
      // AND PUT IT BACK. The frame is kept alive between opens (that is
      // the whole point of the panel), so this document is not reloaded —
      // which means the faded-out, already-going state would still be
      // here the next time the panel slid up, and the only way out of the
      // device would be invisible and dead (user report, 2026-08-25).
      // Restored after the panel has finished leaving, so the fade is
      // still seen on the way out.
      window.setTimeout(() => {
        delete el.dataset['going'];
        el.classList.remove('out');
        el.classList.add('in');
      }, MOTION.secondaryMs);
      return;
    }

    options.device?.classList.add('leaving');
    // The case is mid-slide; navigating now would cut it. Waiting for the
    // move it is already making is the whole seam.
    window.setTimeout(() => go(href), MOTION.secondaryMs);
  });

  root.appendChild(el);
  drawFrame();
  // The label's own font may land after this, and the box grows with it.
  const observer = new ResizeObserver(drawFrame);
  observer.observe(el);
  requestAnimationFrame(() => el.classList.add('in'));

  return {
    el,
    destroy(): void {
      observer.disconnect();
      el.remove();
    },
  };
}
