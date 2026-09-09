/**
 * The keep link, and the names things get saved under.
 *
 * Split out of keepsake.ts and deliberately importing NOTHING. Its
 * siblings there pull in three, the character pipeline and both post
 * passes, and the world page needs exactly one function from this file —
 * enough to recognise a keep link and route it. Importing it from the
 * heavy module put the whole phone companion into the world's bundle.
 *
 * Same split, and the same reason, as src/phone/emotes.ts.
 */

/**
 * A filename somebody can find again.
 *
 * The creature's name, which is the only part a person recognises, plus
 * enough of the id to keep two creatures called the same thing apart.
 * Lowercase throughout — no uppercase type anywhere in this project, and a
 * filename is type.
 */
export function keepsakeFilename(name: string | null, id: string, ext: string): string {
  const safe = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const tail = id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
  const stem = safe.length > 0 ? `${safe}-${tail}` : `creature-${tail}`;
  return `refworld-${stem}.${ext}`;
}

/**
 * The link that opens this creature anywhere, forever.
 *
 * An id and a world, and deliberately nothing else. The strokes are in the
 * store under that id and the pipeline is deterministic, so this is a
 * complete description of the creature in about sixty characters — short
 * enough to be a qr, a text message, or something read aloud.
 *
 * Encoding the strokes into the url instead would mean quantizing them to
 * fit, and a quantized stroke list is a DIFFERENT drawing: it would
 * rebuild a creature that is nearly right, which is worse than one that is
 * either right or absent.
 *
 * `keep` rather than `id`, because a url parameter is read by people as
 * well as by code and what this one means is "the creature you kept".
 */
export function keepUrl(origin: string, where: { world: string; id: string }): string {
  const w = encodeURIComponent(where.world);
  const k = encodeURIComponent(where.id);
  return `${origin}/?world=${w}&keep=${k}`;
}

/** Read a keep id back out of a url's parameters. Null when there is none. */
export function readKeepId(params: URLSearchParams): string | null {
  const raw = params.get('keep') ?? '';
  // The same shape a drawer id has (src/phone/identity.ts mints `d` + base36).
  // Bounded and character-checked because it goes into a store lookup.
  const id = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
  return id.length > 0 ? id : null;
}
