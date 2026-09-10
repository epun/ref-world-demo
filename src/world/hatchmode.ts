/**
 * Who opens the eggs in this world — the clock, or a person?
 *
 * `timer` is what a public link has always done. Nobody is standing in
 * front of it, there is no operator and nobody to wait for, and an egg that
 * never hatched would be a person who drew something and got nothing back.
 *
 * `manual` is a world with somebody in front of it (user ask, 2026-09-10:
 * *"in the demo let's pause the hatching until I press h on the keyboard"*).
 * The eggs stand until the projection presses `h`, and because every phone's
 * world view is its own copy of that same page, the press has to TRAVEL —
 * the hatch rides the world sync topic and every screen opens together
 * (src/net/worldsync.ts, docs/SESSION.md §6).
 *
 * The setting is per-world data (worlds.json), baked into the page at build
 * time as `<meta name="refworld:hatch">` by scripts/world-build.mjs, exactly
 * as `residents` is (src/world/residents.ts). The public build injects
 * nothing, which is why the absent tag has to mean `timer`.
 */
export type HatchMode = 'timer' | 'manual';

/**
 * Read the setting off the tag's content, or off nothing at all.
 *
 * Anything unrecognised means `timer`, deliberately: a typo that PAUSED a
 * world would be a link full of eggs that never open and nobody in the room
 * to press anything. Only the word that was asked for stops the clock.
 */
export function hatchModeFrom(metaContent: string | null): HatchMode {
  return (metaContent ?? '').trim().toLowerCase() === 'manual' ? 'manual' : 'timer';
}

/**
 * The mode this page runs in: `?hatch=` if the address names one, else the
 * baked tag.
 *
 * The query form is an override for previews and dev — looking at a manual
 * world's timer behaviour, or pausing a timer world's hatching for a
 * rehearsal, without a deploy. It is the same shape as `?world=` and
 * `?landscape=`: a setting on the address, not a place.
 *
 * Unlike the tag, BOTH words count here. `?hatch=timer` on a manual world
 * has to be able to hand the eggs back to the clock, so an override that
 * only ever read one word would be half a switch.
 */
export function readHatchMode(query: string | null, metaContent: string | null): HatchMode {
  const asked = (query ?? '').trim().toLowerCase();
  if (asked === 'manual' || asked === 'timer') return asked;
  return hatchModeFrom(metaContent);
}
