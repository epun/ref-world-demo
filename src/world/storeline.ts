/**
 * Is anything drawn here actually being kept?
 *
 * A public world answers `GET /api/drawings` with a session log whether or
 * not a store is connected: with none it returns 200 and an empty list, and
 * only a POST — which a projection never makes — answers 503. So from the
 * world's side a deployment nobody has drawn in and a deployment that
 * CANNOT be drawn in look exactly alike, and the second one silently throws
 * every drawing away.
 *
 * api/drawings.ts already says which it is, in the log's own header:
 * `config.store` is `live` or `none`, "says whether a store is configured,
 * never what or where it is". Nothing read it. This is the reader — the
 * whole of it, pure, so the one line a broken deployment shows can be
 * argued with in a test rather than in front of an audience.
 *
 * Lowercase, always (TASTE §5): no uppercase type anywhere in this world.
 */

/** The log header's config, as loose as the format leaves it. */
export type LogConfig = Record<string, number | string | boolean | null> | null | undefined;

/**
 * The line to say about this world's store, or null when there is nothing
 * to say — which is every correctly configured deployment, and also every
 * older log that carries no `store` key at all. Silence is the default: a
 * world is only ever accused of losing drawings when it has said so itself.
 */
export function storeNote(config: LogConfig, world: string): string | null {
  if (!config) return null;
  if (config['store'] !== 'none') return null;
  const name = world.length > 0 ? world : 'this world';
  return `${name} has no store — nothing drawn here is being kept`;
}
