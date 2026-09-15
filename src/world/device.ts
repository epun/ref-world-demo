/**
 * Which KIND of screen is this, in the one sense the world cares about.
 *
 * Most people watch the katamari from a phone (user brief, 2026-09-15) —
 * and a phone watching the world is running the same `main.ts`, the same
 * four render passes and the same cast as the projection is. So "how much
 * can this page afford" is a question several layers ask, and until now each
 * of them answered it for itself: the pixel-ratio cap in
 * `src/world/scene.ts` read `(pointer: coarse)` inline, and the destruction
 * task is about to need a debris ceiling that asks the same question again.
 *
 * ONE read, here, pure and injectable. A coarse pointer is the honest proxy:
 * it is what the platform actually tells us, it does not lie about a small
 * laptop window the way a width query does, and it is the test the pixel cap
 * has been using since it shipped.
 *
 * Deliberately NOT a benchmark. A frame-time probe would be more accurate
 * and would also mean the world looked different on its second run than its
 * first, which is a world that cannot be demonstrated.
 */

export type DeviceTier = 'projection' | 'phone';

/** The live query, read through `window.matchMedia` when there is one. */
function defaultMatch(query: string): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof mm === 'function' ? mm.call(globalThis, query).matches === true : false;
}

/**
 * `phone` for a coarse pointer, `projection` otherwise.
 *
 * The matcher is injectable so this is testable under node and so a caller
 * that has already read the query (scene.ts reads it for the pixel cap) can
 * hand its answer in rather than asking the platform twice.
 */
export function deviceTier(matches: (query: string) => boolean = defaultMatch): DeviceTier {
  return matches('(pointer: coarse)') ? 'phone' : 'projection';
}

/**
 * [D] How many loose fragments a page will carry at once, by tier.
 *
 * For the destruction task that lands next: breaking a building into chunks
 * is the one thing in this design that can multiply the world's object count
 * without anybody asking it to, and the cap is what keeps a phone watching
 * the room from becoming the thing that decides how much of the room there
 * is. 96 against 24 is the same four-to-one the pixel cap is built on —
 * a projection has a desktop gpu and the picture is the point; a phone is
 * holding a minimap and a joystick as well.
 *
 * Exported and not yet read by anything. Said plainly rather than left for
 * the next task to invent twice.
 */
export const DEBRIS_CAP: Record<DeviceTier, number> = { projection: 96, phone: 24 };
