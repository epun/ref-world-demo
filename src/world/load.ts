/**
 * ONE LOAD THAT STARTS THE ROOM EMPTY — `?fresh=1`.
 *
 * A projection that reloads HEALS ITSELF, and that is the single most
 * valuable property this project has: the store's drawings come back grown,
 * the stored scene comes back in the order it was made, and every handset
 * that drew re-publishes under the same id so the pure pipeline rebuilds the
 * identical creatures (docs/RUNBOOK.md §if the projection dies). Nothing
 * here weakens it. **Every world, valiocon included, restores on a normal
 * load, and demo day depends on that.**
 *
 * What this adds is a TESTING load (user ask, 2026-09-17, doing test runs on
 * valiocon: *"i want the default load to be empty"*, then: *"it doesn't need
 * to start empty on every load but just for testing. on the actual demo day
 * we want to make sure that the world saves and is stored."*). Put
 * `?fresh=1` on the projection's address and THAT ONE LOAD is the same event
 * as the panel's `reset world`: the world steps its generation forward, the
 * store's drawings and scene go, every handset that drew is sent back to the
 * pad KEEPING its drawing (CLAUDE.md — a handset's record is never ours to
 * delete), and the run starts clean.
 *
 * It is a per-LOAD flag and not a per-world setting on purpose: nothing is
 * baked into any build, there is no `<meta>`, no worlds.json field and
 * therefore nothing that could reach meridian or the public world, and
 * `src/main.ts` strips it from the address the way it strips `?mod=` — so
 * the reload after it is an ordinary restoring load and the link an operator
 * copies off the projection cannot empty anybody's room.
 *
 * Pure: no three, no DOM at import, and `fetch` is injected.
 */

/**
 * Was this load asked to start empty?
 *
 * `1` or `on`, nothing else — the same defensive spelling as `?landscape=`,
 * and for the sharpest reason any flag in this project has: a misread value
 * here EMPTIES A ROOM. Anything unrecognised is the load that heals itself.
 */
export function readFreshLoad(search: string): boolean {
  const asked = (new URLSearchParams(search).get('fresh') ?? '').trim().toLowerCase();
  return asked === '1' || asked === 'on';
}

/** What a page does about the run before it, decided once at boot. */
export interface LoadPlan {
  /** Ask the moderator endpoint for a new generation, on load. */
  reset: boolean;
  /** Does this page stand up the drawings the store already holds? */
  absorbStore: boolean;
  /** Does it apply the scene the store already holds? */
  applyStoredScene: boolean;
  /** One lowercase line for the operator's readout, or null when there is
   * nothing to say — which is every ordinary load, and also the fresh load
   * that CAN reset, because there `startFresh` reports what happened
   * instead of what was hoped. */
  note: string | null;
}

/** The shipped rule — what every load without the flag does, unchanged. */
const RESTORE_PLAN: LoadPlan = {
  reset: false,
  absorbStore: true,
  applyStoredScene: true,
  note: null,
};

/**
 * FRESH IS THE PROJECTION'S LOAD, NOT THE ROOM'S RULE.
 *
 * Three cases it deliberately does not touch:
 *
 *   - an INSTALLATION world (`isPublic` false) has no store, no generation
 *     and nothing to reset; a refresh there already is a new world.
 *   - a HANDHELD page — a phone that opened `?view=world` — is a VIEWER
 *     (CLAUDE.md, 2026-09-17). It must see the live creatures the host is
 *     simulating, and a phone that emptied the room by looking at it would
 *     be the worst possible reading of this ask. So a handset never resets
 *     and never suppresses anything, including the phone that happens to be
 *     alone on the link and therefore hosting: it is looking at a live room,
 *     not opening a new run.
 *   - a page with NO SECRET cannot bump the generation, so it cannot ask the
 *     handsets to step down. It still comes up EMPTY — it ignores the
 *     store's drawings and the store's scene for the whole run — and it
 *     says so, because the phones from the last run will keep their
 *     companions and the pad will still refuse them a second drawing.
 */
export function planLoad(input: {
  fresh: boolean;
  isPublic: boolean;
  handheld: boolean;
  hasSecret: boolean;
}): LoadPlan {
  if (!input.fresh || !input.isPublic || input.handheld) return { ...RESTORE_PLAN };
  return {
    reset: input.hasSecret,
    absorbStore: false,
    applyStoredScene: false,
    note: input.hasSecret
      ? null
      : 'empty on this screen only (no secret — open with ?mod=)',
  };
}

/** What the fresh load actually managed to do. */
export interface FreshStart {
  /** Was a reset asked of the store at all? */
  requested: boolean;
  /** Did the world's generation step forward? That is the part the handsets
   * read — it is what sends them back to the pad. */
  bumped: boolean;
  /** May this page stand up what the store holds, from here on? True only
   * when the store was actually emptied. */
  absorbStore: boolean;
  /** The readout line. Lowercase, always (TASTE §5). */
  note: string | null;
}

/** The moderator's endpoint, built the one way. */
export function moderateEndpoint(world: string): string {
  return `/api/moderate?world=${encodeURIComponent(world)}`;
}

/**
 * Start the world over, on load, exactly as the panel's `reset world` does
 * it — the same endpoint, the same body, the same secret.
 *
 * EVERY FAILURE STILL COMES UP EMPTY. A reset that did not land leaves the
 * store holding the last run, which is precisely the state this load must
 * not show, so `absorbStore` stays false whatever went wrong. The failure
 * costs the operator a line, never the run its clean start.
 *
 * It does NOT reload the page (the panel's button does, because it is a
 * screen already full of creatures that no longer exist). This runs before
 * the first pull and before the stored scene, so there is nothing on screen
 * to take back.
 */
export async function startFresh(input: {
  plan: LoadPlan;
  world: string;
  secret: string;
  fetch?: typeof globalThis.fetch;
}): Promise<FreshStart> {
  const { plan } = input;
  if (!plan.reset) {
    return {
      requested: false,
      bumped: false,
      absorbStore: plan.absorbStore,
      note: plan.note,
    };
  }
  const doFetch = input.fetch ?? globalThis.fetch;
  const failed = (note: string): FreshStart => ({
    requested: true,
    bumped: false,
    absorbStore: false,
    note,
  });
  if (typeof doFetch !== 'function') return failed('world not emptied (unreachable)');
  try {
    const res = await doFetch(moderateEndpoint(input.world), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-moderator': input.secret },
      body: JSON.stringify({ reset: true }),
    });
    if (!res.ok) {
      return failed(
        res.status === 404
          ? 'world not emptied (404: wrong secret)'
          : res.status === 503
            ? 'no store on this deployment'
            : `world not emptied (${res.status})`,
      );
    }
  } catch {
    return failed('world not emptied (unreachable)');
  }
  // The store is empty now, so what it reports from here on is this run's.
  return {
    requested: true,
    bumped: true,
    absorbStore: true,
    note: 'this world started over — the room is empty',
  };
}
