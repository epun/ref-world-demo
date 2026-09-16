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
export const DEBRIS_CAP: Record<DeviceTier, number> = {
  projection: 96,
  phone: 24,
};

/**
 * THE TIER IN FORCE, as module state (2026-09-16).
 *
 * `deviceTier` above is the pure read and stays the only place the media
 * query lives. This is the ANSWER, published once so the pure modules that
 * size the terrain can see it: the ground field's cut
 * (`src/world/field.ts`), the shore and region bakes' resolutions
 * (`src/world/ghibli/`) and the physics heightfield's
 * (`src/physics/world.ts`). Each of those is built from a module function
 * with no instance to thread a tier through — the same shape of problem
 * `activeIslandMode` and scatter's `activeSeed` have, and the same answer.
 *
 * `scene.ts`'s `start` sets it beside the pixel cap, BEFORE it builds the
 * ground, the water or any bake. Determinism is unaffected: this is explicit
 * state, not a clock or a benchmark, and the default is `projection` — so a
 * test, a node script and the projection itself all read the same world.
 *
 * ⚠️ Read it THROUGH the function, never copied into a module-scope const
 * evaluated before `start` runs (the same caution `MAP_SCALE` carries).
 */
let activeTier: DeviceTier = 'projection';

/** The tier the world is currently sized for. */
export function renderTier(): DeviceTier {
  return activeTier;
}

/** Publish the tier `deviceTier` resolved. Callers set it once, before they
 * build anything that reads it. */
export function setRenderTier(tier: DeviceTier): void {
  activeTier = tier;
}

/** True on a handset — the one question the terrain budgets below ask. */
export function isPhoneTier(): boolean {
  return activeTier === 'phone';
}

/**
 * COULD RAPIER EVER ARRIVE ON THIS PAGE — the rule, as one pure function
 * (2026-09-16, the slow-network work).
 *
 * > User ask: *"we need to be able to run this on a slow network on people's
 * > devices."*
 *
 * Two `no`s. A world with no game has nothing to simulate (2026-09-15 user
 * ruling, src/world/game.ts). And a HANDSET: `@dimforge/rapier3d-compat` is
 * 2.06 mb of javascript with its wasm inlined, 760 kb compressed, 4.1
 * seconds of a 1.5 Mbit link — and it was paid by every phone testing alone
 * in a room, because a phone alone on the link wins its own election and
 * becomes the host (`HostRole` in src/main.ts).
 *
 * A phone host runs the game off the PURE resolve and the scatter's own
 * colliders instead: rocks and unrooted props stand where they were placed,
 * the resolve still blocks on anything too big to carry, and the sticky pass
 * still decides and still says so as scene events (docs/PLAN.md §7.6 — the
 * decisions were always the events, never the bodies). What it does not have
 * is rolling stones and tumbling debris.
 *
 * Here rather than inside `src/world/scene.ts` so it is testable without a
 * canvas: `WorldHandles.physicsExpected` is this function over the tier
 * `setRenderTier` published, and `src/creatures/manager.ts` reads the handle.
 */
export function physicsExpectedFor(game: string, tier: DeviceTier): boolean {
  if (game !== 'katamari') return false;
  return PHONE_RUNS_RAPIER || tier !== 'phone';
}

/**
 * ONE FLAG TO GIVE THE PHONES RAPIER BACK.
 *
 * `true` restores the behaviour that shipped before 2026-09-16 exactly: a
 * phone that is elected host loads the solver, its stones roll and its debris
 * tumbles, and it pays 760 kb for the privilege. Nothing else in the
 * codebase branches on the tier for physics — the creature manager asks
 * `WorldHandles.physicsExpected()` and gets its answer from here — so this
 * boolean is the whole of the decision and reversing it needs no other edit.
 *
 * It is a constant and not a url parameter or a panel toggle on purpose: a
 * page that could change its mind about whether it holds rigid bodies is a
 * page whose host handover has two shapes, and the host rules are hard
 * enough (docs/PLAN.md §7.6).
 */
export const PHONE_RUNS_RAPIER = false;
