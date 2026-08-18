/**
 * Who this handset is, and what it already made.
 *
 * One phone owns exactly ONE creature (user ruling). That holds because the
 * drawer id is stable per device and travels as the drawing's id: the world
 * keys creatures by that id and REPLACES a slot of the same id, so a phone
 * can never accumulate a second creature — and its emotes address the same
 * creature forever (src/net/emoteUplink.ts).
 *
 * The submission is persisted per room so a reload lands back on the
 * companion instead of an empty pad. localStorage, not session: closing the
 * tab and returning is exactly the case that must still find the creature.
 *
 * The draw page (public/draw/index.html) is a vendored plain-html page and
 * cannot import this module — it writes the SAME keys inline. Keep the two
 * in step; the shapes are asserted by test/phone/identity.test.ts.
 */

export const DRAWER_KEY = 'refworld:drawer';
export const SUBMISSION_PREFIX = 'refworld:submission:';

/** Storage seam so tests (and a private-mode handset) never throw. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(store?: StorageLike): StorageLike | null {
  if (store) return store;
  try {
    const ls = globalThis.localStorage;
    // A probe: safari in private mode throws on setItem, not on access.
    ls.setItem(DRAWER_KEY + ':probe', '1');
    return ls;
  } catch {
    return null;
  }
}

/** Room-scoped key for a submission record. */
export const submissionKey = (room: string): string => SUBMISSION_PREFIX + room;

/**
 * This handset's stable id, minted once and kept. Randomness at the edge is
 * fine (it never enters the deterministic generation path — it SALTS it),
 * and the id is what makes "one phone, one creature" true.
 */
export function drawerId(deps: { store?: StorageLike; random?: () => number } = {}): string {
  const store = safeStorage(deps.store);
  const rand = deps.random ?? Math.random;
  const mint = (): string => 'd' + Math.floor(rand() * 0xffffffff).toString(36) + Math.floor(rand() * 0xffff).toString(36);
  if (!store) return mint();
  try {
    const existing = store.getItem(DRAWER_KEY);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const minted = mint();
    store.setItem(DRAWER_KEY, minted);
    return minted;
  } catch {
    return mint();
  }
}

/** What this handset drew in a room — the record the companion restores. */
export interface Submission {
  id: string;
  name: string | null;
  /** The kit's wire strokes, exactly as published. */
  strokes: unknown[];
  ts: number;
}

export function readSubmission(
  room: string,
  deps: { store?: StorageLike } = {},
): Submission | null {
  const store = safeStorage(deps.store);
  if (!store) return null;
  try {
    const raw = store.getItem(submissionKey(room));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec['id'] !== 'string' || !Array.isArray(rec['strokes'])) return null;
    if (rec['strokes'].length === 0) return null;
    return {
      id: rec['id'],
      name: typeof rec['name'] === 'string' ? rec['name'] : null,
      strokes: rec['strokes'],
      ts: typeof rec['ts'] === 'number' ? rec['ts'] : 0,
    };
  } catch {
    return null;
  }
}

export function writeSubmission(
  room: string,
  submission: Submission,
  deps: { store?: StorageLike } = {},
): void {
  const store = safeStorage(deps.store);
  if (!store) return;
  try {
    store.setItem(submissionKey(room), JSON.stringify(submission));
  } catch {
    /* full or blocked — the in-page handoff still carries this session */
  }
}
