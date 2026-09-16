/**
 * Which GAME, if any, runs in this world?
 *
 * `none` is the shipped world and what every deployment does unless its own
 * worlds.json entry says otherwise: a field of creatures wandering, drawn on
 * phones, hatching, emoting, tracked on a minimap. No rigid bodies, no sticky
 * rules, no destruction, no island.
 *
 * `katamari` is a per-world GAME (2026-09-15 user ruling): rapier, the sticky
 * pickup rules, prop destruction, the loose and debris layers and the island
 * map, on the world `valiocon` and nowhere else. It is a switch rather than a
 * branch of the taste — the reason it exists is that the default branch builds
 * every world's production deployment at once, so a change that is right for
 * one world must not be able to reach meridian or the public world. A merge
 * that put the rocks and the pickups on meridian had to be reverted, and this
 * flag is what makes that impossible rather than unlikely.
 *
 * Pure: no three, no DOM at import. The same sanitising rule lives in
 * scripts/world-build.mjs, so the tag a build injects and the app's reading of
 * it can never name two different games — the same discipline as the world
 * name, `residents`, `hatch` and `style`.
 */

export type WorldGame = 'none' | 'katamari';

export const WORLD_GAMES: readonly WorldGame[] = ['none', 'katamari'];

/**
 * Only the exact lowercase word opts a world in, the same defensive rule as
 * sanitizeStyle and for a sharper reason: the shipped world is the DEFAULT,
 * and a misread setting must fall back onto the world every other deployment
 * ships rather than switch a game on somewhere nobody asked for one.
 */
export function sanitizeGame(raw: unknown): WorldGame {
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'katamari'
    ? 'katamari'
    : 'none';
}

/**
 * The game this page runs. `?game=` on the address wins — that is how an
 * operator tries the game on a deployed link without a build — then
 * `<meta name="refworld:game">`, which is what the build injects for a world
 * whose entry asked for it. Neither present, or neither naming a game this
 * app knows, is `none`.
 *
 * Same shape as readWorldStyle (src/world/style.ts): a query value the app
 * does not recognise falls THROUGH to the tag rather than silently switching
 * off the world an operator is standing in.
 */
export function readWorldGame(search: string, metaContent: string | null): WorldGame {
  const asked = (new URLSearchParams(search).get('game') ?? '').trim().toLowerCase();
  if ((WORLD_GAMES as readonly string[]).includes(asked)) return asked as WorldGame;
  return sanitizeGame(metaContent);
}

/**
 * Does this page open with the authored map revealed, or on the plain?
 *
 * Every world OPENS PLAIN (src/world/landscape.ts) unless the address says
 * `?landscape=1` — that is the shipped rule and it stands. A KATAMARI world
 * is the one exception (2026-09-16, user report: "there is no island on the
 * version you pushed"): its map IS the island, and the panel's toggle is not
 * reachable from a phone, so it opens on the map unless the address says
 * `?landscape=0` outright. Pure, so the rule is pinned by a test rather than
 * re-discovered on a deployed link.
 */
export function opensOnLandscape(game: WorldGame, landscapeParam: string | null): boolean {
  const asked = (landscapeParam ?? '').trim().toLowerCase();
  if (asked === '1' || asked === 'on') return true;
  if (asked === '0' || asked === 'off') return false;
  return game === 'katamari';
}
