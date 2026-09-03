/**
 * Does this world open with a population already standing in it?
 *
 * The public world does. The twenty-three creatures recovered from the
 * designers-and-machines room are its EXHIBIT — nobody is offering them and
 * nobody is deciding on them, they are what is already in the field the way
 * trees are — and an empty field is a bad landing for a link anyone can
 * open.
 *
 * A client's world does not. Its deployment starts clean and fills only
 * with what its own people draw. Somebody else's creatures there are not a
 * welcome, they are clutter with no story attached, and a client watching
 * their first drawing arrive into an empty field is the whole proposition.
 *
 * The setting is per-world data (worlds.json), baked into the page at build
 * time as `<meta name="refworld:residents">` by scripts/world-build.mjs.
 * The public build injects nothing, which is why the absent tag has to mean
 * `shipped`.
 */
export type Residents = 'shipped' | 'none';

/**
 * Read the setting off the tag's content, or off nothing at all.
 *
 * Anything unrecognised means `shipped`, deliberately: this decides whether
 * a world is populated, and a typo in a config file must not be able to
 * empty one. Only the word that was asked for does that.
 */
export function residentsFrom(metaContent: string | null): Residents {
  return (metaContent ?? '').trim().toLowerCase() === 'none' ? 'none' : 'shipped';
}
