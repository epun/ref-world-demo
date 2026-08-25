/**
 * The companion, over the world, in the same document.
 *
 * The two views used to be two PAGES, so every toggle was a full
 * navigation: the world unloaded, and coming back re-fetched the drawings
 * and rebuilt all sixty-eight creatures through the pipeline from nothing.
 * Measured on one world → device → world round trip: three documents, the
 * seed fetched twice, and the return costing as much as the first arrival.
 * It was slow, and it was also what made the slide feel rough — the case
 * was animating while the next document booted underneath it (user report,
 * 2026-08-25).
 *
 * So the world stops unloading. It stays exactly where it is, paused, and
 * the companion arrives on top of it.
 *
 * IT IS THE REAL COMPANION, in a frame — not a second implementation of
 * one. `/phone.html` is a whole page with its own boot, its own session
 * and a stage machine that assumes it owns the document; hosting it inside
 * the world would have meant either dragging all of that across or
 * building a lookalike, and a lookalike drifts. This way there is one
 * companion, and the world is simply the thing behind it.
 *
 * The SLIDE is the frame's, not the case's: one composited layer moving,
 * with the page inside it already settled. That is the same move
 * `.device.leaving` makes on the way out, which is what the person asked
 * for — the difference is only that nothing is loading while it happens.
 *
 * Kept alive once opened. The second toggle costs nothing at all.
 */

import { MOTION, SURFACE } from '../taste/tokens';

/** What the framed companion says when it wants to be dismissed. */
export const CLOSE_MESSAGE = 'refworld:companion-close';

const STYLE_ID = 'companion-panel-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.companion-panel {
  position: fixed;
  inset: 0;
  z-index: 60;
  border: 0;
  width: 100%;
  height: 100%;
  display: block;
  background: ${SURFACE.ground};
  /*
   * Off the bottom, and out of reach. Visibility matters as much as the
   * transform: a frame merely translated away still takes taps meant for
   * the tray underneath it.
   */
  transform: translateY(106%);
  visibility: hidden;
  transition:
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    visibility 0s linear ${MOTION.secondaryMs}ms;
}
.companion-panel.open {
  transform: translateY(0);
  visibility: visible;
  /* Visible for the whole of the way in, hidden only once the way out has
     finished — hence the delay on one side and not the other. */
  transition:
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    visibility 0s linear 0s;
}
`;
  document.head.appendChild(style);
}

export interface CompanionPanelOptions {
  /** The companion url. `from=world` is NOT wanted — the frame slides, not
   * the case inside it. */
  href: string;
  /** Called when the panel starts opening and when it has finished closing,
   * so the world can stop and restart drawing. */
  onVisibilityChange?(visible: boolean): void;
}

export interface CompanionPanelHandle {
  /**
   * Build and boot the framed companion NOW, off-screen, so the first tap
   * is only a slide.
   *
   * The companion is a page: a module to parse, a session to open, a
   * portrait to build. Paying that on the tap is what makes the first open
   * feel heavier than the second. Paying it while the person is looking at
   * the world costs them nothing, so long as it waits for a thread that is
   * actually free — hence requestIdleCallback, and never during the load.
   *
   * Idempotent, and a no-op once the panel exists.
   */
  prewarm(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Built on first open and kept; null until then. */
  frame(): HTMLIFrameElement | null;
  destroy(): void;
}

export function createCompanionPanel(
  root: HTMLElement,
  options: CompanionPanelOptions,
): CompanionPanelHandle {
  ensureStyle();

  let frame: HTMLIFrameElement | null = null;
  let open = false;

  const build = (): HTMLIFrameElement => {
    if (frame) return frame;
    const el = document.createElement('iframe');
    el.className = 'companion-panel';
    el.setAttribute('title', 'your creature');
    // Same origin, so the companion can talk back. Nothing else is granted.
    el.src = options.href;
    root.appendChild(el);
    frame = el;
    return el;
  };

  const onMessage = (event: MessageEvent): void => {
    // Same-origin only, and only the one thing we listen for. The frame is
    // ours, but the listener is on `window` and anything can post to it.
    if (event.origin !== window.location.origin) return;
    if (event.data !== CLOSE_MESSAGE) return;
    close();
  };
  window.addEventListener('message', onMessage);

  function open_(): void {
    if (open) return;
    open = true;
    const el = build();
    // The world stops drawing BEFORE the move starts: the frame's first
    // boot is the one expensive moment here, and it should have the main
    // thread to itself.
    options.onVisibilityChange?.(true);
    // A frame appended this same frame has no rendered state to move FROM,
    // so let it lay out first or the slide is a jump.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('open'));
    });
  }

  function close(): void {
    if (!open) return;
    open = false;
    frame?.classList.remove('open');
    // The world comes back only once the panel is fully gone — a world
    // resuming behind a panel still sliding is work nobody can see.
    window.setTimeout(() => options.onVisibilityChange?.(false), MOTION.secondaryMs);
  }

  let idle = 0;
  return {
    prewarm(): void {
      if (frame || idle) return;
      const ric = (window as Window & {
        requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      }).requestIdleCallback;
      // The timeout is the point: on a phone that never goes idle it still
      // boots, just later than a genuinely free moment would have.
      idle = ric
        ? ric(() => build(), { timeout: 8000 })
        : window.setTimeout(() => build(), 4000);
    },
    open: open_,
    close,
    isOpen: () => open,
    frame: () => frame,
    destroy(): void {
      window.removeEventListener('message', onMessage);
      frame?.remove();
      frame = null;
    },
  };
}
