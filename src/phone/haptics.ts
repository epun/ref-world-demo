/**
 * Haptics on the handset, for the one moment that earns them: the egg
 * hatching in your hand.
 *
 * The Vibration API and nothing else — no audio tricks, no hidden inputs.
 * It is absent on iOS (Safari has never shipped it), so on an iPhone this
 * is silently a no-op: `canVibrate` reports that honestly rather than the
 * caller pretending something happened. Chrome also requires the page to
 * have been engaged by the person before it will buzz, which the draw and
 * send taps satisfy in the normal flow.
 *
 * NOTE on durations: these are NOT motion tokens. The token scale starts
 * at t.tertiary (456ms), and a 456ms buzz is a phone ringing, not a tick.
 * Haptic lengths are physical — a few tens of milliseconds is the whole
 * vocabulary — so they are their own small constants, named and explained
 * here rather than borrowed from a scale that means something else.
 */

/** The hatch: a light crack, a pause, then a fuller one as it comes out.
 * 120ms end to end — felt as one gesture, never a buzz. */
export const HATCH_PATTERN: readonly number[] = [16, 70, 34];

/** The slice of navigator we use; injectable so tests need no browser. */
export interface VibrateLike {
  vibrate?(pattern: number | number[]): boolean;
}

function target(nav?: VibrateLike): VibrateLike | null {
  const n = nav ?? (globalThis as { navigator?: VibrateLike }).navigator;
  if (!n || typeof n.vibrate !== 'function') return null;
  return n;
}

/** Can this handset buzz at all? False on every iPhone. */
export function canVibrate(nav?: VibrateLike): boolean {
  return target(nav) !== null;
}

/**
 * Play a pattern. Returns whether it was handed to the device — false when
 * there is no vibration support, the pattern is empty, or the browser
 * refused it (no user engagement yet). Never throws: a handset that will
 * not buzz must not break the screen it was buzzing for.
 */
export function pulse(pattern: readonly number[], nav?: VibrateLike): boolean {
  const n = target(nav);
  if (!n || pattern.length === 0) return false;
  try {
    return n.vibrate!([...pattern]) !== false;
  } catch {
    return false;
  }
}

/** The hatch moment. */
export function hatchPulse(nav?: VibrateLike): boolean {
  return pulse(HATCH_PATTERN, nav);
}
