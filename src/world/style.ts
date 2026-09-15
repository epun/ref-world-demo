/**
 * Which LOOK is this world rendered in?
 *
 * `ink` is the shipped one and the only one the taste describes: near-achromatic
 * paper, flat stamped shadows, a six-value quantize, wobbly contour lines
 * (docs/TASTE.md §1–§7). Every deployment renders in it unless its own
 * worlds.json entry says otherwise, and the public world always does.
 *
 * `ghibli` is a per-world USER OVERRIDE (2026-09-15, docs/TASTE.md §9): the
 * envpaint cel look — green meadow, warm sun, cool hue-shifted two-tone
 * shadows, a blue sky — on the world `valiocon` and nowhere else. It is
 * recorded as an override rather than argued as taste, and it relaxes exactly
 * two rules (the achromatic palette and the six-luma quantize) while every
 * other constraint still holds.
 *
 * Pure: no three, no DOM at import. The same sanitising rule lives in
 * scripts/world-build.mjs, so the tag a build injects and the app's reading of
 * it can never name two different looks — the same discipline as the world
 * name, `residents` and `hatch`.
 */

export type WorldStyle = 'ink' | 'ghibli';

export const WORLD_STYLES: readonly WorldStyle[] = ['ink', 'ghibli'];

/**
 * Only the exact lowercase word opts a world into the override, for the same
 * reason a typo cannot empty a world: the shipped look is the taste, and a
 * misread setting must fall back to it rather than away from it.
 */
export function sanitizeStyle(raw: unknown): WorldStyle {
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'ghibli'
    ? 'ghibli'
    : 'ink';
}

/**
 * The style this page renders in. `?style=` on the address wins — that is how
 * an operator compares the two looks on a deployed link without a build —
 * then `<meta name="refworld:style">`, which is what the build injects for a
 * world whose entry asked for it. Neither present, or neither naming a look
 * this app knows, is `ink`.
 *
 * Same shape as readHatchMode (src/world/hatchmode.ts): a query value the app
 * does not recognise falls THROUGH to the tag rather than silently resetting
 * the world an operator is standing in.
 */
export function readWorldStyle(search: string, metaContent: string | null): WorldStyle {
  const asked = (new URLSearchParams(search).get('style') ?? '').trim().toLowerCase();
  if ((WORLD_STYLES as readonly string[]).includes(asked)) return asked as WorldStyle;
  return sanitizeStyle(metaContent);
}
