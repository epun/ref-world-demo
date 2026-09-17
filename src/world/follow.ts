/**
 * Does the camera ride your own creature right now?
 *
 * On a handset the world view is the whole screen and the person holding it
 * has exactly one thing in there that is theirs. Once they can walk it
 * (src/world/joystick.ts) the default has to be that the camera goes with
 * it — a stick that steers a creature off the edge of the frame is a stick
 * that steers nothing you can see (user ask, 2026-09-09).
 *
 * Following moves the camera's LOOK TARGET and nothing else. The angle is
 * still entirely the person's: a one-finger drag orbits (CameraRig.rotateBy
 * touches azimuth and elevation only) and two fingers pinch, and neither of
 * those goes anywhere near the target. So "follow" and "orbit" are not two
 * modes competing for the camera — they are two different halves of it, and
 * both are live at once.
 *
 * The one thing that genuinely conflicts is asking to look SOMEWHERE ELSE:
 * a tap on the minimap says "show me over there", and a follow that
 * immediately drags the frame back would make that tap do nothing. So the
 * map suspends following, and the next push of the stick resumes it —
 * walking is the person saying "come with me" in the only vocabulary this
 * view has. Nothing else suspends it, and in particular orbiting does not:
 * turning the camera around your creature is looking AT it, not away.
 *
 * This is a decision, not a mechanism: no scene, no camera, no DOM. That is
 * what lets the rule be tested on its own, and it is the rule — not the
 * plumbing — that is easy to get wrong.
 */

import { followSpringLag, followZoomFor } from './camera';
import { MOTION } from '../taste/tokens';

/**
 * Does THIS hatch close the camera in on THIS page's creature?
 *
 * > User ask, 2026-09-17: *"on hatch for mobile we should have the cam zoom
 * > in to people's character."*
 *
 * Four conditions, and three of them are the ones the stick, the minimap's
 * self mark and this module's own `enabled` already answer:
 *
 *   - the KATAMARI world and nowhere else (src/world/game.ts, the 2026-09-15
 *     ruling). Every other world's camera is the one that shipped;
 *   - a page that can follow at all, which is a handset with a creature —
 *     `FollowOptions.enabled`. A projection frames the room, and the
 *     presentation tour has its own answer to a hatch (src/world/tour.ts);
 *   - the shell that opened is MINE. Sixty-seven other people's hatches are
 *     not an invitation to move this person's camera;
 *   - and there is a creature to name at all: an empty `mine` must not match
 *     an empty `hatched`, or a page with no drawing would close in on the
 *     first hatch in the room.
 *
 * Pure and here rather than in main.ts for the reason the whole module is:
 * it is the RULE that is easy to get wrong, not the plumbing.
 */
export function shouldCloseOnHatch(a: {
  game: string;
  /** The creature whose shell just opened. */
  hatched: string;
  /** This page's own creature, or '' when it has none. */
  mine: string;
  /** Can this page follow at all (`FollowOptions.enabled`)? */
  canFollow: boolean;
}): boolean {
  if (a.game !== 'katamari') return false;
  if (!a.canFollow) return false;
  if (a.mine.length === 0) return false;
  return a.hatched === a.mine;
}

export interface FollowOptions {
  /**
   * Is following possible on this page at all?
   *
   * False on a projection, on a desktop, and on a handset whose owner has
   * not drawn yet — all of which are pages with nothing of their own to
   * follow. A master switch rather than a starting state: `resume()` must
   * not be able to turn following on for a page that has no creature, or
   * the frame loop would spend forever asking for a position that will
   * never exist.
   */
  enabled?: boolean;
}

export interface Follow {
  /** Should this frame retarget the camera onto the creature? */
  active(): boolean;
  /**
   * Look somewhere else for a while — the minimap's tap, a pinch, a pan.
   *
   * A NO-OP WHILE THE STICK IS HELD (2026-09-17, the ask that the camera
   * focus back on the creature when the joystick is used): a thumb on the
   * stick is a continuous statement that the creature is the subject, and a
   * gesture made with the other hand must not be able to contradict it
   * mid-drive. The gesture still does its own job — a drag still orbits, a
   * pinch still zooms — it just does not let go. The moment the stick is
   * released the next gesture suspends again.
   */
  suspend(): void;
  /** Come back to me — any non-zero stick input. */
  resume(): void;
  /**
   * Is a thumb on the stick right now? Set from the stick's own `onChange`,
   * both edges, and read by `suspend`.
   */
  driving(held: boolean): void;
  /** Is the stick held (a readout, for the tests and for nothing else). */
  held(): boolean;
}

/**
 * Following is ON from the moment the page has a creature to follow.
 *
 * Not "on after the first nudge": the creature exists before it moves (it
 * spends its first minute as an egg) and the frame it stands in is the one
 * a person arriving wants to be looking at. Waiting for input would open
 * the world on a view of somebody else's corner of it.
 */
export function createFollow(options: FollowOptions = {}): Follow {
  const enabled = options.enabled ?? true;
  let suspended = false;
  let holding = false;
  return {
    active: () => enabled && !suspended,
    suspend(): void {
      // A gesture made mid-drive is ignored, not queued: the stick is the
      // subject for as long as it is held (see the interface).
      if (holding) return;
      suspended = true;
    },
    resume(): void {
      suspended = false;
    },
    driving(held: boolean): void {
      holding = held;
    },
    held: () => holding,
  };
}

/**
 * WHERE THE FRAME AIMS AND HOW WIDE IT SITS, while it is following.
 *
 * > User ask, 2026-09-17: *"on mobile the camera perspective is too zoomed out
 * > on the character. we should be focused on the user's character and always
 * > have it in frame."*
 *
 * Two answers, and both of them are about the same thing: the rig's reframe
 * spring takes t.primary to arrive, so a frame that simply retargets onto a
 * moving creature sits `followSpringLag` BEHIND it — 2.47 u at the katamari
 * walk ceiling and 5.93 u at the rolling one, against a half-frame of 2.9 u
 * at `PHONE_FOLLOW_ZOOM`. Tight framing and a walking creature are therefore
 * the same problem, and it is not one the zoom should solve alone (a frame
 * that opens to five times its size every time somebody moves is the report
 * this work came from, upside down).
 *
 *   - THE AIM LEADS. The point handed to `frameAt` is the creature plus the
 *     lag its own speed earns, so the spring's steady state IS the creature:
 *     retarget a ζ=1 spring at `p + 2v/ω` and it settles at `p`. Nothing is
 *     made faster and no duration is invented — the lead is read off the
 *     spring's own settle time (`followSpringLag`).
 *   - THE ZOOM IS THE SAFETY NET. Acceleration, a turn and a pile that grew
 *     are all transients the lead does not cover, so the zoom widens by
 *     whatever the frame is ACTUALLY behind by (`behind`, measured against the
 *     live look-target), which is a reading and not a model. There is no
 *     feedback in it: how far the spring is behind does not depend on how wide
 *     the frame is.
 *
 * The velocity is SMOOTHED over t.tertiary. A viewer's creature is placed
 * from the host's 5 Hz poses (already led — `followPoses`), and the frame
 * clock is not the pose clock, so the raw per-frame difference is a staircase;
 * the aim would jitter by the lead's whole length at every step. Exponential,
 * with the token as its time constant, so it cannot overshoot the speed it is
 * following.
 *
 * Pure: no scene, no rig, no DOM — a position in, a point and a zoom out. The
 * two framing rules it reads (`followSpringLag`, `followZoomFor`) are pure
 * functions in src/world/camera.ts, where the frustum they are about is
 * defined; nothing here touches a camera. That is what lets the whole rule be
 * argued with in a test.
 */
export interface FollowAimInput {
  /** Where the creature is, this frame. */
  x: number;
  z: number;
  /** The pile's radius (`ballDiameter/2`), 0 before the shell opens. */
  bodyR: number;
  /** Where the rig is looking right now (`CameraRig.lookAtPoint`). */
  lookX: number;
  lookZ: number;
  /** The frame's aspect (`CameraRig.aspect`). */
  aspect: number;
  /** This frame's delta, ms. */
  dtMs: number;
}

export interface FollowAim {
  /** The point to retarget the look-target at — the creature, led. */
  x: number;
  z: number;
  /** The zoom this framing wants. */
  zoom: number;
  /** How far the frame is behind the creature, world units (a readout). */
  behind: number;
}

export interface FollowAimOptions {
  /** The tight end of the framing — `PHONE_FOLLOW_ZOOM` on a handset. */
  close: number;
}

/**
 * A little state — the last position and the smoothed velocity — and the two
 * pure rules above. One per page, made where the follow is (src/main.ts).
 */
export function createFollowAim(options: FollowAimOptions): (a: FollowAimInput) => FollowAim {
  let lastX: number | null = null;
  let lastZ = 0;
  let vx = 0;
  let vz = 0;
  return (a: FollowAimInput): FollowAim => {
    const dt = Math.max(1, Math.min(250, a.dtMs));
    if (lastX === null) {
      lastX = a.x;
      lastZ = a.z;
    }
    const rawX = ((a.x - lastX) / dt) * 1000;
    const rawZ = ((a.z - lastZ) / dt) * 1000;
    lastX = a.x;
    lastZ = a.z;
    // Exponential approach with t.tertiary as its time constant — it cannot
    // cross the speed it is following, so no overshoot is representable.
    const k = 1 - Math.exp(-dt / MOTION.tertiaryMs);
    vx += (rawX - vx) * k;
    vz += (rawZ - vz) * k;
    const speed = Math.hypot(vx, vz);
    const lead = speed > 1e-6 ? followSpringLag(speed) / speed : 0;
    const behind = Math.hypot(a.x - a.lookX, a.z - a.lookZ);
    return {
      x: a.x + vx * lead,
      z: a.z + vz * lead,
      zoom: followZoomFor(a.bodyR, { close: options.close, aspect: a.aspect, behind }),
      behind,
    };
  };
}
