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
  /** Look somewhere else for a while — the minimap's tap. */
  suspend(): void;
  /** Come back to me — any non-zero stick input. */
  resume(): void;
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
  return {
    active: () => enabled && !suspended,
    suspend(): void {
      suspended = true;
    },
    resume(): void {
      suspended = false;
    },
  };
}
