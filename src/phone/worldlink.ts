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
  el.textContent = 'the world';
  const href = worldHref(options.room, options.world);
  el.href = href;

  const go = options.navigate ?? ((to: string) => { window.location.href = to; });

  el.addEventListener('click', (event) => {
    // Let a long-press / open-in-new-tab behave normally; only the plain
    // tap gets the choreography.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (el.dataset['going'] === 'true') return;
    el.dataset['going'] = 'true';

    options.device?.classList.add('leaving');
    el.classList.remove('in');
    el.classList.add('out');
    // The case is mid-slide; navigating now would cut it. Waiting for the
    // move it is already making is the whole seam.
    window.setTimeout(() => go(href), MOTION.secondaryMs);
  });

  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));

  return {
    el,
    destroy(): void {
      el.remove();
    },
  };
}
