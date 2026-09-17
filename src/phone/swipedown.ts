/**
 * SWIPE DOWN FROM THE TOP OF THE DEVICE TO GO BACK TO THE WORLD.
 *
 * > User ask, 2026-09-17 (mobile): *"on mobile if you swipe down at the top of
 * > the screen on the device view it should take you back to the world"*.
 *
 * The device view already has one way out — the `view world` button under the
 * case (src/phone/worldlink.ts) — and it is a small target at the bottom of a
 * phone held in one hand. This is the same exit as a GESTURE, and
 * deliberately the gesture a phone already means by it: a pull from the top
 * edge is "give me back what was behind this".
 *
 * THE RULES, and each one is a thing that would otherwise go wrong:
 *
 * - it starts in the TOP BAND only (`TOP_BAND` of the viewport). A swipe that
 *   could start anywhere would fire on every drag of the creature the person
 *   is turning, which is the whole interaction the wait and alive screens are
 *   made of (src/phone/spin.ts);
 * - it is DOWNWARD and mostly vertical: past `SWIPE_PX`, and further down than
 *   across, or a sideways flick with a little droop in it would leave the page;
 * - the browser's own PULL-TO-REFRESH must not fire, so the move is
 *   `preventDefault`ed for as long as the gesture is live — which is also why
 *   the listener cannot be passive. A reload here is the one outcome worse
 *   than nothing: it throws away the drawing screen and comes back to the same
 *   place slower;
 * - and it fires ONCE. The exit navigates (or closes the panel) after the
 *   case's own slide, so a second fire mid-slide would be two navigations for
 *   one thumb.
 *
 * The exit itself is not here: this module recognises the gesture and calls
 * `onSwipe`. The one seam that leaves for the world lives in
 * src/phone/worldlink.ts and is shared with the button and the landing path,
 * so the case slides the same way whichever of the three asked.
 *
 * The pure half — the band, the direction, the threshold — is at the top with
 * no DOM in it.
 */

/**
 * How much of the screen counts as "the top". **[D]**
 *
 * 0.15 — the same fraction of a phone as the status bar plus a little, and on
 * a 844pt screen that is the top 127pt, which is comfortably above the case's
 * screen well (it starts at 22.6% of the device box, docs/DEVICE.md §3). So
 * the band is paper and chrome, never the drawing surface or the creature.
 */
export const TOP_BAND = 0.15;

/**
 * How far the thumb must travel down for a swipe rather than a tap. **[D]**
 *
 * 64 css px. Under a finger's width of movement is a tap with a shake in it;
 * this is unmistakably a pull, and it is still less than a tenth of the
 * screen so nobody has to drag the phone's whole height.
 */
export const SWIPE_PX = 64;

export interface SwipeDrag {
  /** Where the thumb went down, css px from the top of the viewport. */
  startY: number;
  /** Where it started across, for the "mostly vertical" test. */
  startX: number;
  y: number;
  x: number;
  /** The viewport's height, so the band is a fraction and not a number. */
  height: number;
}

/** Did this gesture start in the band that owns it? */
export function startsInBand(startY: number, height: number): boolean {
  if (!Number.isFinite(startY) || !Number.isFinite(height) || height <= 0) return false;
  return startY >= 0 && startY <= height * TOP_BAND;
}

/**
 * Is this drag a swipe down — far enough, and more down than sideways?
 *
 * Both halves matter: without the distance a tap fires it, and without the
 * dominance a horizontal flick with a droop in it fires it.
 */
export function isSwipeDown(drag: SwipeDrag): boolean {
  if (!startsInBand(drag.startY, drag.height)) return false;
  const dy = drag.y - drag.startY;
  const dx = Math.abs(drag.x - drag.startX);
  return dy >= SWIPE_PX && dy > dx;
}

/**
 * The seam this listens on — `document` in the app, a recording double in a
 * test. Deliberately the smallest shape that both satisfy: a handler that
 * takes the touch-like event this module reads and nothing else.
 */
export interface SwipeTarget {
  addEventListener(
    type: string,
    handler: (event: TouchLike) => void,
    options?: { passive?: boolean },
  ): void;
  removeEventListener(type: string, handler: (event: TouchLike) => void): void;
}

export interface SwipeDownOptions {
  /** What the gesture is watched on — the document, or a test's double. */
  target: SwipeTarget;
  /** The viewport's height, read per gesture (a phone rotates). */
  height(): number;
  /** Recognised. Called once per gesture, and once per handle. */
  onSwipe(): void;
}

export interface SwipeDownHandle {
  /** Is a gesture in the band live right now? */
  live(): boolean;
  /** Has it fired? One exit per handle. */
  fired(): boolean;
  destroy(): void;
}

export interface TouchLike {
  touches: { clientX: number; clientY: number }[];
  preventDefault?: () => void;
  cancelable?: boolean;
}

/**
 * Watch for the gesture. Knows nothing about the world, the room or the case
 * — it recognises a pull and says so.
 */
export function installSwipeDown(opts: SwipeDownOptions): SwipeDownHandle {
  let from: { x: number; y: number; height: number } | null = null;
  let fired = false;

  const onStart = (event: TouchLike): void => {
    if (fired) return;
    const touch = event.touches[0];
    // One finger only: two is a pinch, and a pinch is not an exit.
    if (!touch || event.touches.length !== 1) {
      from = null;
      return;
    }
    const height = opts.height();
    if (!startsInBand(touch.clientY, height)) {
      from = null;
      return;
    }
    from = { x: touch.clientX, y: touch.clientY, height };
  };

  const onMove = (event: TouchLike): void => {
    if (fired || !from) return;
    const touch = event.touches[0];
    if (!touch) return;
    /*
     * PULL-TO-REFRESH DIES HERE. The page is at the top of its scroll (the
     * companion's body is fixed and never scrolls, src/phone/main.ts), so
     * chrome and safari both read a downward drag from the top edge as a
     * reload. Preventing the move for as long as the gesture is live is the
     * whole of the fix, and it is why this listener is not passive.
     */
    if (event.cancelable !== false) event.preventDefault?.();
    const drag: SwipeDrag = {
      startX: from.x,
      startY: from.y,
      x: touch.clientX,
      y: touch.clientY,
      height: from.height,
    };
    if (!isSwipeDown(drag)) return;
    fired = true;
    from = null;
    opts.onSwipe();
  };

  const onEnd = (_event: TouchLike): void => {
    from = null;
  };

  opts.target.addEventListener('touchstart', onStart, { passive: true });
  // NOT passive: the move is what cancels the browser's pull-to-refresh.
  opts.target.addEventListener('touchmove', onMove, { passive: false });
  opts.target.addEventListener('touchend', onEnd, { passive: true });
  opts.target.addEventListener('touchcancel', onEnd, { passive: true });

  return {
    live: () => from !== null,
    fired: () => fired,
    destroy(): void {
      opts.target.removeEventListener('touchstart', onStart);
      opts.target.removeEventListener('touchmove', onMove);
      opts.target.removeEventListener('touchend', onEnd);
      opts.target.removeEventListener('touchcancel', onEnd);
    },
  };
}
