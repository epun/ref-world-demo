/**
 * Drag to turn the object (user ruling, 2026-08-20: *"on the mobile view a
 * user should be able to rotate the egg and their character."*).
 *
 * WHY it earns its place: the drawing lives on the creature's BACK now — a
 * knockout mark on the local −z face, hidden from the front (commit
 * 16efcb0). The phone's portrait is head-on, so without a way to turn the
 * creature round the person can never see their own drawing on it. This is
 * the gesture that makes the mark findable, not a toy.
 *
 * The law it has to obey (TASTE §2.1, all confidence 1.00):
 *
 * - **No abrupt stop.** A release does not freeze the object. The throw's
 *   angular velocity is handed to a ζ≥1 spring TARGETED AT ZERO, so it is
 *   the velocity that settles, asymptotically — it approaches the floor and
 *   never lands on it. Underneath, the ambient drift floor (the egg's and
 *   the character's own `drift.rot`) keeps running exactly as before, so
 *   the object is still turning after the throw is spent.
 * - **No overshoot, no bounce, no snap-back.** ζ ≥ 1 on the velocity means
 *   the velocity never crosses zero, so the yaw never reverses; and there
 *   is no restoring term on the ANGLE at all, so nothing pulls the object
 *   back to front. It rests where the person left it, which is the whole
 *   point when what they wanted to see is the back.
 *
 * The spring registers with the damping audit (TASTE §7) like every other
 * spring in the app, so the gate covers this gesture too.
 *
 * Pointer events, not touch events: the same code path serves a finger and
 * a mouse, and pointer capture keeps a drag alive when the finger leaves
 * the element.
 */

import { Spring } from '../motion/spring';
import { MOTION } from '../taste/tokens';

/**
 * [D] One full turn across the width of the surface the gesture is read on.
 * Chosen by feel: a swipe across the screen well turns the object all the
 * way round, so the back of the creature is one gesture away rather than
 * four. Expressed as a ratio rather than degrees-per-pixel so it feels the
 * same on every handset size.
 */
export const TURN_PER_WIDTH = Math.PI * 2;

/** Radians of yaw per pixel of horizontal drag on a surface this wide. */
export function radiansPerPixel(widthPx: number): number {
  return TURN_PER_WIDTH / Math.max(1, widthPx);
}

/**
 * [D] Ceiling on a throw, derived from the token scale rather than picked:
 * a full turn in t.tertiary. A flick that reads faster than that is a
 * slipped finger, not an intention.
 */
export const MAX_SPIN_RATE = TURN_PER_WIDTH / MOTION.tertiaryMs;

/**
 * [D] How much of a new pointer sample enters the velocity estimate. A
 * plain instantaneous rate is hostage to one jittery frame; a blend is the
 * cheapest smoothing that keeps the throw honest. Not a duration.
 */
const VELOCITY_BLEND = 0.5;

/** What a spin carries across a screen swap: where it rests, and how fast
 * it is still turning. Both, because dropping the velocity at the seam
 * would be exactly the abrupt stop the law forbids. */
export interface SpinState {
  /** Accumulated yaw in radians. Unbounded — it is an offset, not a pose. */
  yaw: number;
  /** Current angular velocity, radians per ms. */
  velocity: number;
}

export const SPIN_REST: SpinState = { yaw: 0, velocity: 0 };

export interface SpinOptions {
  /** The element the gesture is read on — the screen well, so the whole
   * display turns the object rather than only the object's own box. */
  surface: HTMLElement;
  /** The width one full turn is measured across, in css pixels. Read per
   * gesture, so a rotation or a resize is picked up without a relisten. */
  width(): number;
  /** Yaw + throw carried in from the previous screen. */
  initial?: SpinState;
  /**
   * While this returns true a NEW gesture is refused — the hatch owns the
   * object while it plays. A throw already in flight is never cut short:
   * only the start of a new drag is held.
   */
  held?(): boolean;
}

export interface SpinHandle {
  /** Advance the throw and return the yaw offset to apply this frame. */
  update(dt: number): number;
  /** The current yaw, without advancing. */
  yaw(): number;
  /** Yaw + velocity, for handing to the next screen. */
  state(): SpinState;
  /** True while a finger is down. */
  dragging(): boolean;
  destroy(): void;
}

/**
 * A pointerdown on a control is that control's, never a drag. Duck-typed
 * rather than `instanceof Element` so the module stays importable — and
 * testable — with no DOM in scope.
 */
function onControl(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('button, input, a, textarea, select, [role="button"]') !== null;
}

export function createSpin(options: SpinOptions): SpinHandle {
  let yaw = options.initial?.yaw ?? SPIN_REST.yaw;
  // The throw decays as a SPRING ON THE VELOCITY, targeted at zero: ζ ≥ 1,
  // so the velocity approaches zero without ever crossing it and the turn
  // can never reverse. There is deliberately no spring on the ANGLE — an
  // angle spring would have a target, and a target is a snap-back.
  const decay = new Spring(options.initial?.velocity ?? SPIN_REST.velocity, {
    settleMs: MOTION.primaryMs,
  });
  decay.retarget(0);

  let pointerId: number | null = null;
  let lastX = 0;
  let lastTime = 0;
  let radPerPx = radiansPerPixel(options.width());

  const clampRate = (v: number): number =>
    Math.min(MAX_SPIN_RATE, Math.max(-MAX_SPIN_RATE, v));

  const onPointerDown = (event: PointerEvent): void => {
    if (pointerId !== null || onControl(event.target)) return;
    if (options.held?.() === true) return;
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastTime = event.timeStamp;
    radPerPx = radiansPerPixel(options.width());
    // A drag that started is this element's: it must not also scroll the
    // page or become a click somewhere else.
    try {
      options.surface.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; the move/up listeners still fire.
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - lastX;
    const dtMs = Math.max(1, event.timeStamp - lastTime);
    lastX = event.clientX;
    lastTime = event.timeStamp;
    const delta = dx * radPerPx;
    yaw += delta;
    // Track the live rate so a release inherits the hand's own speed.
    decay.reset(clampRate(VELOCITY_BLEND * (delta / dtMs) + (1 - VELOCITY_BLEND) * decay.value));
    if (event.cancelable) event.preventDefault();
  };

  const endDrag = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    try {
      options.surface.releasePointerCapture(event.pointerId);
    } catch {
      // Already released — nothing to undo.
    }
    // The throw: whatever the hand was doing, now settling by drifting.
    decay.retarget(0);
  };

  const surface = options.surface;
  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', endDrag);
  surface.addEventListener('pointercancel', endDrag);

  return {
    update(dt: number): number {
      if (pointerId !== null) {
        // The hand owns the angle while it is down; the spring only holds
        // the rate, ready for the release.
        return yaw;
      }
      yaw += decay.update(dt) * dt;
      return yaw;
    },
    yaw(): number {
      return yaw;
    },
    state(): SpinState {
      return { yaw, velocity: decay.value };
    },
    dragging(): boolean {
      return pointerId !== null;
    },
    destroy(): void {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', endDrag);
      surface.removeEventListener('pointercancel', endDrag);
      decay.dispose();
    },
  };
}
