/**
 * The handset heals the store.
 *
 * A handset keeps the only copy of its drawing that survives anything
 * (docs/PUBLIC.md §one creature per person, CLAUDE.md: never delete it).
 * The store is supposed to keep the other one — and sometimes it did not:
 *
 * - the drawing was made before the kv integration was connected, so the
 *   POST answered 503 and the world has never heard of it;
 * - the POST was cancelled by the hand-off navigation before it landed
 *   (fixed in public/draw/index.html with `keepalive`, but every drawing
 *   sent before that fix is still missing);
 * - the deployment was rebuilt against a different store.
 *
 * In a NAMED world nothing repairs that on its own. The world's epoch is
 * `w-<world>` forever, so the handset's record can never go stale, so the
 * pad refuses a second drawing and the companion restores a creature the
 * world has never had — "it shows in the companion but not on the map"
 * (user report, 2026-09-09).
 *
 * So the handset offers it back. It reads the world's own log, and only if
 * that log is readable AND does not contain this handset's id does it post
 * the same wire strokes the pad posts, under the same id. Nothing here is
 * privileged: it is the ordinary submission endpoint, the ordinary screen,
 * the ordinary one-creature-per-device claim.
 *
 * THE FAILURES ALL MEAN "LEAVE EVERYTHING ALONE". A store that cannot be
 * read is not a store that lost the drawing, a 409 means the store has this
 * device under a record of its own (including one a moderator has refused),
 * and neither is ever a reason to touch the local record or free the pad.
 *
 * Silent, always. Nothing here is a message to the person holding the
 * phone: their creature is either in the world already or it is on its way,
 * and a notice about a database is not theirs to read.
 */

/** What the world's log says about one handset's id. */
export type StoreHas = 'yes' | 'no' | 'unreadable';

/**
 * Does this log carry a drawing under `id`?
 *
 * `unreadable` is its own answer and the important one: anything that is
 * not a `refworld.session` log — an error page, a proxy's html, a truncated
 * body, a null — must never be read as "the drawing is missing".
 */
export function storeHas(body: unknown, id: string): StoreHas {
  if (id.length === 0) return 'unreadable';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'unreadable';
  const rec = body as Record<string, unknown>;
  if (rec['schema'] !== 'refworld.session') return 'unreadable';
  const events = rec['events'];
  if (!Array.isArray(events)) return 'unreadable';
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const e = event as Record<string, unknown>;
    if (e['k'] === 'drawing' && e['id'] === id) return 'yes';
  }
  return 'no';
}

/** What the store had to say, for the log and for the tests. */
export type HealOutcome =
  /** No named world, or nothing on this handset to offer. */
  | 'nothing-to-do'
  /** The world already has it. The ordinary case, and the quiet one. */
  | 'already-there'
  /** It was missing and the store took it. */
  | 'healed'
  /** The store has this device under a record of its own. Hands off. */
  | 'claimed'
  /** No store, no network, or an answer we could not read. Hands off. */
  | 'unreachable';

/** The drawing as the wire carries it — the exact shape the pad posts. */
export interface HealSubmission {
  id: string;
  name: string | null;
  strokes: unknown[];
}

export interface HealDeps {
  /** Injectable for the tests; defaults to the page's own fetch. */
  fetch?: typeof globalThis.fetch;
}

/** The endpoint, built the one way, so a world can never be dropped here. */
export function healEndpoint(world: string): string {
  return `/api/drawings?world=${encodeURIComponent(world)}`;
}

export async function healStore(
  world: string,
  submission: HealSubmission | null,
  deps: HealDeps = {},
): Promise<HealOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (world.length === 0) return 'nothing-to-do';
  if (!submission || submission.id.length === 0) return 'nothing-to-do';
  if (!Array.isArray(submission.strokes) || submission.strokes.length === 0) {
    return 'nothing-to-do';
  }
  if (typeof doFetch !== 'function') return 'unreachable';

  const endpoint = healEndpoint(world);

  let body: unknown;
  try {
    // `no-store`: a cached copy from before the drawing was sent would say
    // it is missing when it is not, and that is a needless write.
    const res = await doFetch(endpoint, { cache: 'no-store' });
    if (!res.ok) return 'unreachable';
    body = await res.json();
  } catch {
    return 'unreachable';
  }

  const has = storeHas(body, submission.id);
  if (has !== 'no') return has === 'yes' ? 'already-there' : 'unreachable';

  try {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: submission.id,
        name: submission.name ?? '',
        strokes: submission.strokes,
      }),
    });
    if (res.status === 409) return 'claimed';
    if (!res.ok) return 'unreachable';
    return 'healed';
  } catch {
    return 'unreachable';
  }
}
