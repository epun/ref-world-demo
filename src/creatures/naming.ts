/**
 * Names for creatures nobody signed.
 *
 * User ruling, 2026-08-18: *"if the user enters a name that is the name of
 * their character. if they skip we default to the system generated one."*
 * Before this, an unsigned creature simply had no name — `hover.ts` showed
 * nothing over it and the companion's brow line sat empty. A creature you
 * cannot refer to is harder to care about, which is the opposite of the
 * point.
 *
 * ONE source of truth: the draw page sends no name when the person skips,
 * and the world names it here. The name then travels down the existing
 * `name` protocol message to the phone, into the hover label, into the
 * outliner and into the session log — nothing else needed a change, and
 * there is no second copy of these word lists to drift out of sync.
 *
 * Deterministic, and that is load-bearing: the name is derived from the
 * creature's identity id, so a replayed session reproduces the same names
 * without the log having to carry them, exactly as the silhouette is
 * reproduced from the strokes (PLAN §6.3). No Math.random, no clock.
 *
 * The words are ordinary, soft and small — the taste is quiet and
 * near-achromatic, and a creature called `voidreaper` would be louder than
 * anything else in the frame. All lowercase, always (TASTE §5).
 */

/**
 * First halves. Short, soft consonants, nothing sharp — these read as
 * something you would call a small animal, not a product.
 */
const HEADS: readonly string[] = [
  'bo', 'mo', 'pip', 'nub', 'tuk', 'wren', 'fen', 'dot',
  'ollie', 'bean', 'moss', 'pim', 'lo', 'nim', 'bug', 'gil',
  'poe', 'rook', 'sog', 'tam', 'wisp', 'yon', 'ash', 'cub',
];

/**
 * Optional second halves. Roughly half the creatures get one, so the
 * population carries both one- and two-part names rather than reading as a
 * single generated pattern.
 */
const TAILS: readonly string[] = [
  'let', 'kin', 'ling', 'o', 'ie', 'en', 'ard', 'bit',
];

/**
 * FNV-1a over the id. A hash, not a PRNG: the same id must give the same
 * name on every device and every build, and string hashing is the whole
 * requirement.
 */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Total distinct names this can produce, for the tests to assert against. */
export const NAME_SPACE = HEADS.length * (TAILS.length + 1);

/**
 * The name for a creature with the given identity id.
 *
 * Same id → same name, on every device, forever. Different ids usually
 * differ, but this is a hash over a small space, not a uniqueness
 * guarantee: at NAME_SPACE = 216 a room of thirty will collide sometimes,
 * and two creatures sharing a name is a charm rather than a bug — they are
 * told apart by their silhouette, which is the point of the whole pipeline.
 */
export function generatedName(id: string): string {
  const h = hash(id);
  const head = HEADS[h % HEADS.length]!;
  // A separate slice of the hash picks the tail, so head and tail are not
  // correlated — using the same bits would tie every `bo` to one ending.
  const tailPick = Math.floor(h / HEADS.length) % (TAILS.length + 1);
  return tailPick === TAILS.length ? head : head + TAILS[tailPick]!;
}

/**
 * The name to show for a creature: what the person signed, or a generated
 * one when they skipped. Whitespace-only counts as skipped — a name of
 * three spaces is not a name.
 *
 * LOWERCASED here, at the one place a creature's name is decided.
 *
 * No type in this world is uppercase (TASTE §5, confidence 1.00) — room
 * codes render `xkcd`, never `XKCD`. But the static gate can only read
 * string literals in the source, so it never sees a name somebody types
 * into a phone. The first real drawing on the public world came in signed
 * `Bob` and went straight past it (2026-08-26).
 *
 * It was half-handled: the companion lowercased at render, the moderation
 * screen did not, and the same creature was `bob` on one screen and `Bob`
 * on another. Doing it at the source means every consumer is consistent
 * and no new one has to remember.
 *
 * What was STORED stays exactly as typed — this is a display decision, and
 * the record of what somebody wrote is theirs, not ours to overwrite.
 */
export function resolveName(signed: string | null | undefined, id: string): string {
  const trimmed = (signed ?? '').trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : generatedName(id);
}
