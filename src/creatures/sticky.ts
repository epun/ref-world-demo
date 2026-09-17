/**
 * The sticky-world rules — PURE.
 *
 * > User brief, 2026-09-15: *the world should feel increasingly unstable as
 * > a creature's mass grows… first ten seconds cute, last twenty out of
 * > control.*
 *
 * Every decision about what sticks to what, what comes out of the ground and
 * how big a pile has made its carrier is arithmetic in here. Nothing in this
 * file knows about three.js, rapier, the scene graph or the clock — which is
 * what lets `test/creatures/sticky.test.ts` pin the game's actual rules
 * rather than pinning a screenshot of them, and what lets the same numbers be
 * quoted by the creature layer, the recorder and the docs without drifting
 * apart.
 *
 * WHERE THE DECISIONS THEN GO. Only the page that simulates ever calls
 * `decideContact` or `shouldDrop` (docs/PLAN.md §7.6): a viewer applies the
 * `stick`/`drop`/`loose`/`settle` events it is sent and decides nothing. That
 * is not a performance concession — two pages deciding independently, off two
 * rapier simulations that are not bit-identical, is two rooms.
 *
 * THE NUMBERS ARE **[D]**. The taste briefs have nothing to say about a
 * katamari, so none of this is attributable to them (the world brief:
 * *"never invent a rule and attribute it to this taste"*). They are tuned to
 * the arc the brief asks for and are meant to be tuned again.
 */

import { MOTION } from '../taste/tokens';
import type { PropKind } from '../world/props';
import { propVariantMeta } from '../world/props-source';

/**
 * How a prop behaves when a creature runs into it.
 *
 * A tier rather than a per-kind table of behaviours, because the thing the
 * rules turn on is scale: a stone goes on the pile, a bush comes out of the
 * ground, a tree needs a running start, a building is the level. `large` and
 * `building` are the seams the destruction task hangs off (docs/PLAN.md
 * §7.6) — that is the whole reason they are distinguished here rather than
 * both being "immovable".
 */
export type Tier = 'small' | 'medium' | 'large' | 'building';

export interface StickyProps {
  tier: Tier;
  /** In the ground. A rooted prop is never picked up — it is knocked LOOSE
   * first, and is then an unrooted item like any other. */
  rooted: boolean;
  /** Impact at which it comes out of the ground. `Infinity` never does. */
  breakStrength: number;
  /**
   * Impact at which it BREAKS instead of coming out of the ground whole —
   * the `large` tier's second threshold (user brief, 2026-09-15: *"large
   * props break into major chunks that become independent debris"*).
   *
   * Absent means never: a bush that a big enough pile hit would otherwise
   * shatter, and a bush has no chunks. Where it is present it must be
   * ABOVE `breakStrength`, so the escalation still reads — a monolith comes
   * out of the ground first and only comes apart when hit harder than that.
   * **[D]**
   */
  shatterStrength?: number;
  /**
   * Cumulative impact thresholds for a STAGED collapse (user brief: *"impact
   * 1 → cracks, impact 2 → a section removed, impact 3 → collapse into
   * rubble"*). Three numbers, ascending; `stageFor` reads them.
   *
   * Cumulative and not per-hit, which is the whole point: a building
   * "initially resists, and can become loose after repeated impact". The
   * accumulator lives on the host (src/creatures/manager.ts) because damage
   * is a decision and decisions travel as events.
   *
   * Absent means the kind has no stages — it breaks whole, or not at all.
   */
  stages?: readonly [number, number, number];
  /** Impact at which a carrier sheds it again (see `shouldDrop`). */
  attachmentStrength: number;
  /** 0 means it never sticks to anything, whatever its size. */
  stickiness: number;
}

/**
 * Every prop kind's rules.
 *
 * `rock` is the only UNROOTED kind, and it is unrooted because it already
 * was: the scatter's stones have been dynamic rapier bodies since the physics
 * layer landed (src/world/rocks.ts), so a creature pushing one is a thing the
 * world already did. Everything else is planted and has to be knocked down
 * before it can be carried.
 *
 * `cloud` is the one kind with `stickiness: 0`. It is scenery in the sky with
 * no collider at all (`colliderFor` returns null for it), and a creature that
 * grew tall enough to reach one should not wear it.
 */
export const STICKY: Record<PropKind, StickyProps> = {
  // ── small ────────────────────────────────────────────────────────────────
  // A stone is the pile's bread and butter: already loose, cheap, everywhere.
  rock: { tier: 'small', rooted: false, breakStrength: 0, attachmentStrength: 3, stickiness: 1 },
  // Rooted, but barely — 0.6 is a walk into it. The soft-body slowdown
  // (SOFT_SPEED_FACTOR) still happens on the way through; this is the bush
  // losing the argument.
  bush: { tier: 'small', rooted: true, breakStrength: 0.6, attachmentStrength: 3, stickiness: 1 },
  stump: { tier: 'small', rooted: true, breakStrength: 0.6, attachmentStrength: 3, stickiness: 1 },
  cactus: { tier: 'small', rooted: true, breakStrength: 0.6, attachmentStrength: 3, stickiness: 1 },
  // ── medium ───────────────────────────────────────────────────────────────
  // 4 is a creature with some pile on it at some speed — the first thing in
  // the world that says no to a small creature and yes to a big one, which is
  // the whole arc the brief asks for.
  tree: { tier: 'medium', rooted: true, breakStrength: 4, attachmentStrength: 6, stickiness: 1 },
  conifer: { tier: 'medium', rooted: true, breakStrength: 4, attachmentStrength: 6, stickiness: 1 },
  palm: { tier: 'medium', rooted: true, breakStrength: 4, attachmentStrength: 6, stickiness: 1 },
  picnicTable: {
    tier: 'medium',
    rooted: true,
    breakStrength: 4,
    attachmentStrength: 6,
    stickiness: 1,
  },
  // ── large ────────────────────────────────────────────────────────────────
  /*
   * 8 is the last twenty seconds: reachable, and only by a pile.
   *
   * IT WAS 14, AND 14 WAS UNREACHABLE. Impact is `speed × radius`, so at the
   * driven speed of 1.68 u/s a break strength of 14 needs a body radius of
   * 8.3 — and because `growth` is a cube root, getting a typical 0.9u
   * creature there takes about 1650 units of absorbed volume, which is some
   * 490 tree-sized items. Nothing in a demo meets 490 trees, so the whole
   * `large` tier was decoration and the destruction seam that keys off it was
   * dead. (The number only became checkable once the units bug in the
   * manager's impact was fixed — until then NO tier was reachable, so the
   * ceiling never showed.)
   *
   * 8 needs radius 4.8, which is about 90 tree-sized items from a small
   * creature and far fewer from a large one — and by then the creature is
   * twice the height of the trees it is eating, which is what "out of
   * control" should look like. The tiers still escalate strictly: a walk
   * takes a bush, ~11 trees unlock trees, a real pile unlocks a monolith. [D]
   */
  /*
   * 11 is `breakStrength` plus a bit under half again: a pile that can lift
   * a monolith out of the ground is not yet a pile that can burst one, and
   * the gap is where the escalation lives. Impact is `speed x radius`, so at
   * the driven speed it is the difference between a radius of 4.8 and 6.5 —
   * a few dozen more trees, which is the last stretch of the twenty seconds.
   * **[D]**
   */
  monolith: {
    tier: 'large',
    rooted: true,
    breakStrength: 8,
    shatterStrength: 11,
    attachmentStrength: 10,
    stickiness: 1,
  },
  waterTower: {
    tier: 'large',
    rooted: true,
    breakStrength: 8,
    shatterStrength: 11,
    attachmentStrength: 10,
    stickiness: 1,
  },
  // ── building ─────────────────────────────────────────────────────────────
  /*
   * `breakStrength` STAYS `Infinity` and that is not a leftover: a building
   * never comes out of the ground whole. What it does instead is wear down —
   * `stages` are cumulative impact, so the first hit cracks it, the second
   * takes a section out and the third brings it down as rubble, which is the
   * brief's own three beats. Nothing about a building is ever carried.
   *
   * 6 / 9 / 12 against the monolith's 8: one impact that would have freed a
   * monolith only cracks a building, and the whole collapse costs about half
   * again what bursting a monolith does. A mountain is the level itself —
   * 9 / 13 / 18, roughly half again the building's — and it comes down over
   * its own lump stages (src/world/chunks.ts `LUMP_TIERS`). **[D]**
   */
  building: {
    tier: 'building',
    rooted: true,
    breakStrength: Infinity,
    stages: [6, 9, 12],
    attachmentStrength: 10,
    stickiness: 1,
  },
  mountain: {
    tier: 'building',
    rooted: true,
    breakStrength: Infinity,
    stages: [9, 13, 18],
    attachmentStrength: 10,
    stickiness: 1,
  },
  // ── the library's own tiers (2026-09-15, the katamari object library) ────
  /*
   * `small` / `medium` / `large` are the junk a pile actually rolls up — the
   * mugs and cans, the benches and vending machines, the cars and lamp posts
   * (docs/katamari-props.md §d). They have no authored geometry in this
   * world at all, so on every world but a katamari one their variant count
   * is 0 and these rows are never consulted.
   *
   * Each row is its TIER's shape, taking the numbers the tier already
   * carries: a small thing is loose on the ground like a stone, a medium one
   * is planted and comes up at 4, a large one comes up at 8 and bursts at
   * 11. Where a MODEL disagrees with its kind — a bench is not planted, a
   * mailbox is — the catalog's `rooted` wins through `stickyFor` below,
   * which is the whole reason that function exists.
   */
  small: { tier: 'small', rooted: false, breakStrength: 0, attachmentStrength: 3, stickiness: 1 },
  medium: {
    tier: 'medium',
    rooted: true,
    breakStrength: 4,
    attachmentStrength: 6,
    stickiness: 1,
  },
  large: {
    tier: 'large',
    rooted: true,
    breakStrength: 8,
    shatterStrength: 11,
    attachmentStrength: 10,
    stickiness: 1,
  },
  // ── the sky ──────────────────────────────────────────────────────────────
  cloud: {
    tier: 'small',
    rooted: true,
    breakStrength: Infinity,
    attachmentStrength: 0,
    stickiness: 0,
  },
};

/**
 * The rules for one (kind, VARIANT) — `STICKY[kind]`, overridden by the
 * facts the active prop source knows about that particular variant.
 *
 * WHY THE LOOKUP MOVED DOWN A LEVEL. A stock kind's variants all agree
 * about rootedness and tier: every authored tree is planted, every authored
 * rock is loose. A library kind's do not — in one catalog row a vending
 * machine is bolted to the pavement and in the next a folding chair is
 * leaning against it — and the pickup rules turn on exactly that
 * (docs/katamari-props.md §d, decision 2 of the wiring). So every read of
 * `STICKY[kind]` that has a variant in hand comes through here, and the
 * ones that only know the kind (the `hasOwnProperty` guards that ask whether
 * a string names a prop at all) still read the table directly.
 *
 * Still pure, and still no three: the override comes from
 * `activePropSource()`, which is a plain table installed once per world.
 */
export function stickyFor(kind: PropKind, variant = 0): StickyProps {
  const base = STICKY[kind];
  const meta = propVariantMeta(kind, variant);
  if (!meta) return base;
  if (meta.rooted === base.rooted && meta.tier === base.tier) return base;
  return { ...base, rooted: meta.rooted, tier: meta.tier };
}

/**
 * [D] Biggest item a carrier can pick up, as a fraction of its own radius.
 *
 * ONE, and it was 0.6 until 2026-09-16 (user report: *"I don't see the sticky
 * katamari effect where the character gathers objects as it touches them"*).
 * The arithmetic is the whole story: a hatchling measures ~0.9u, so 0.6 put
 * its ceiling at ~0.54u, and the smallest thing on the map is a ~0.5u stone
 * with the rest of the scatter running to 1.7u and a loosened bush at ~1u.
 * There was almost nothing a fresh creature could take, so the growth curve
 * never bootstrapped and the game read as inert.
 *
 * 1.0 is also the reference feel: in Katamari Damacy you roll up things about
 * your own size, and the ball is visibly made of objects as big as it was a
 * minute ago. It stays a throttle — the tiers above the carrier are still out
 * of reach until it has eaten its way up to them — just one whose first rung
 * exists.
 *
 * A PASSENGER IS DECIDED BY `CREATURE_CARRY_RATIO` BELOW, not by this one.
 * They were the same number until 2026-09-16, and at 1.0 that made two
 * creatures of equal size each eligible to carry the other — which is the
 * bug the stuck report turned out to be.
 *
 * 1.15 since 2026-09-17 (user report, twice: *"some users are having issues
 * sticking to objects"*, *"when a user walks into things it doesn't stick"*).
 * The phone-host sweep in scratch/room-drive-smoke.mjs measured the pickup
 * path working and the LIMIT being what people meet: a hatchling's first
 * encounters are with props a few percent either side of its own radius
 * (r 0.908 stuck, r 1.089 shoved past with no feedback), which reads as "it
 * doesn't stick" long before it reads as "that one is bigger than me". A
 * little headroom over the body makes the first rung the common case; the
 * worst first pickup is still under a doubling (growth-ladder test).
 */
export const PICKUP_RATIO = 1.15;

/**
 * [D] How much BIGGER a creature has to be to carry another creature.
 *
 * > User report, 2026-09-16, from a phone on `valiocon`: *"my character got
 * > stuck."*
 *
 * It was riding on somebody else. With the pickup ratio at 1.0 and the same
 * ratio deciding passengers, two hatchlings of the same size were each
 * exactly at the other's limit: the first contact made one of them a
 * passenger (the tie went to the bigger id), and a passenger has no
 * locomotion of its own — so the phone that was pushing the stick watched
 * its creature glued to a stranger's ball with nothing it could do about it.
 *
 * A PROP has no phone and no claim, so 1.0 is right for props: you roll up
 * things about your own size. A CREATURE is somebody's, and taking it out of
 * its own hands is a real thing to do to a person — so it needs a clear size
 * gap rather than a tie. 1.35 is that gap: a third again as wide is visibly
 * the bigger creature from across the field, it is past every wobble in a
 * measured body radius (`measureBodyRadius` reads a real mesh footprint, and
 * two drawings of the same size land within a few percent), and one pickup
 * of a body-sized prop takes a carrier most of the way there — `growth` puts
 * a creature that has eaten its own volume at 1.26×, and three small stones
 * at ~1.2×, so the ladder still reaches a passenger quickly.
 *
 * Being over 1 is the load-bearing part, not the exact value: `a ≥ 1.35 b`
 * and `b ≥ 1.35 a` cannot both hold, so the mutual-eligibility tie is
 * arithmetically unreachable and there is no id tiebreak left to get wrong.
 * Equal-sized creatures do what they did before the katamari: they separate,
 * hard and mutually (src/physics/resolve.ts), and both keep their sticks.
 */
export const CREATURE_CARRY_RATIO = 1.35;

/**
 * [D] How much volume actually becomes size.
 *
 * `growth` is a cube root of accumulated volume, so without a coefficient a
 * creature that swallowed its own volume would be 2^(1/3) ≈ 1.26× — barely
 * visible after a dozen pickups.
 *
 * 0.35 → **4** *(2026-09-17)*, user ask: *"we should allow for larger mass
 * sizes than 10 meters for users."*
 *
 * There was never a CAP — `growth` is a cube root with no ceiling in it and
 * `decideContact` has put size first since 2026-09-16, so a ball big enough
 * to carry a building already carries it whole. What there was, was a PACE.
 * At 0.35 a typical 0.9 u hatchling needed 294 units of absorbed volume to
 * reach a 10 m ball — about 170 tree-sized items — and about 2400, some
 * 1400 of them, to reach 20 m. Nobody meets 1400 trees, so the top of the
 * ladder was decoration for the same reason `breakStrength: 14` was
 * (see `monolith` above): a threshold no pile ever meets is dead.
 *
 * At 4 the ladder is, from a 0.9 u hatchling (volume is `r³`; the radii are
 * the ones the scatter and the object library actually place):
 *
 *   one stone (r 0.5)      → 2.3 m     one pickup is visible
 *   24 stones / 2 trees    → 5 m
 *   15 trees (r 1.2)       → 10 m      "a few minutes"
 *   13 houses (r 2.5)      → 20 m      the rest of a session
 *   39 buildings (r 3.5)   → 40 m      and there is no wall past it
 *
 * The CEILING on the number is the first pickup: a stone at the very top of
 * a hatchling's carry limit (r = `carrierR`, `PICKUP_RATIO` being 1) puts
 * `Σr³ / baseR³` at exactly 1, so the first stone multiplies the creature by
 * `cbrt(1 + K)`. That must stay under 2 — a creature that doubles on its
 * first pickup has no ladder left to climb — which caps K at 7. 4 gives
 * 1.71 for that worst case and 1.19 for the ordinary one, and the test
 * pins both (test/creatures/growth-ladder.test.ts).
 */
export const GROWTH_K = 4;

/**
 * [D] How far an item beds INTO the pile, as a fraction of its own radius.
 *
 * 0.7 rather than 1.0 on purpose: seating every item exactly tangent to the
 * clump sphere reads as a bristling ball of separate objects. Sinking it 30%
 * makes the pile one shape with things stuck in it, which is the silhouette
 * rule the whole project turns on (TASTE: a character must read as one solid
 * shape).
 */
export const CLUMP_FIT = 0.7;

/**
 * [D] How many times the seat search may be pushed outward before it gives up
 * and takes where it got to.
 *
 * The search is "slide out along the contact direction until nothing is in the
 * way" (`packSeatDistance`), and each pass can uncover a neighbour the last
 * push slid past — so it repeats. A pile is a few dozen items and each pass
 * strictly increases the distance, so it converges in a handful; this is the
 * bound that keeps a pathological pile from spending a frame on one pickup.
 */
export const PACK_PASSES = 8;

/**
 * WHERE A NEW ITEM SITS ON THE PILE — the distance from the pile's centre
 * along the contact direction, in WORLD units. PURE.
 *
 * > User direction, 2026-09-17: *"the character should be the object that the
 * > items stick to."*
 *
 * Until then the pile was a SPHERE of radius `R` (`baseR × growth`) and every
 * item was seated on its surface: as the growth rose the shell grew and the
 * items rode outward on it, which is why the drawn mass needed a body of its
 * own to not be a cloud of props around nothing, and why the creature ended up
 * either on top of that body or inside it. There is no shell now. The
 * CHARACTER is the thing items stick to, at its own drawn radius, and each
 * item after the first packs against the ones already there:
 *
 *   start at the character's own surface (`selfR + itemR × CLUMP_FIT` — the
 *   same bedding that has always made a pile read as one lump rather than a
 *   bristle of separate objects), then, for every seat already taken, if the
 *   new item would be inside it, slide outward along the direction until it is
 *   only bedded into it by the same `CLUMP_FIT`. Repeat, because sliding past
 *   one neighbour can bring another into reach.
 *
 * So the pile grows OUTWARD from the creature, in the direction each thing was
 * actually struck from, with no gaps and no invisible sphere. It is a greedy
 * one-dimensional search and not a packing solver: every item keeps the
 * direction it arrived on, which is what makes the pile a record of where the
 * creature has been rather than an arrangement.
 *
 * PURE and order-dependent in the seats it is given — which is exactly what
 * the wire needs: the page that DECIDES runs this once and the offset travels
 * on the `stick` event (docs/PLAN.md §7.6), so no two pages can pack
 * differently.
 */
export function packSeatDistance(a: {
  /** Unit direction from the pile's centre toward where the item was struck. */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** The new item's own radius, world units. */
  itemR: number;
  /** The CHARACTER's radius — the body everything sticks to. */
  selfR: number;
  /** What is already on the pile: world offsets from the centre, and radii. */
  seats: readonly { x: number; y: number; z: number; r: number }[];
}): number {
  const fit = CLUMP_FIT;
  // Clear of the character itself, bedded into it by the same fraction a
  // stone is bedded into the pile.
  let t = Math.max(0, a.selfR + a.itemR * fit);
  for (let pass = 0; pass < PACK_PASSES; pass++) {
    let moved = false;
    for (const seat of a.seats) {
      const want = (a.itemR + seat.r) * fit;
      // The distance along the ray where the new item would just clear this
      // seat: the far root of |t·d − p|² = want².
      const along = seat.x * a.dirX + seat.y * a.dirY + seat.z * a.dirZ;
      const lenSq = seat.x * seat.x + seat.y * seat.y + seat.z * seat.z;
      const gap = want * want - (lenSq - along * along);
      // The ray passes outside this seat entirely: nothing to do, whatever t
      // is — and this is most pairs on a real pile.
      if (gap <= 0) continue;
      const far = along + Math.sqrt(gap);
      if (t < far) {
        t = far;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return t;
}

/**
 * [D] How many of a carrier's stuck items get a physics collider.
 *
 * A stuck bench swinging into a tree has to COUNT — that is where the brief's
 * instability comes from — but a pile of eighty stones does not need eighty
 * colliders on one kinematic body. The nearest 24 are the ones on the
 * outside, which are the ones that hit things.
 */
export const STUCK_COLLIDERS_MAX = 24;

/**
 * [D] Slack on "touching", world units.
 *
 * The pure resolve separates every creature pair to EXACT contact plus a 1mm
 * skin and pushes every creature out of a hard prop the same way
 * (src/physics/resolve.ts), and rapier keeps its own bodies a hair apart too.
 * So by the time anything asks whether two things are touching, they provably
 * are not — quite — and a strict `d <= rA + rB` test could never fire a
 * single pickup.
 *
 * 0.05 → **0.25** *(2026-09-16)*, user ask: *"relax the actual physics a
 * little bit so that it's a bit easier to … pick things up to your character
 * and have them stick to your character."* 5 cm was the solver's own slop and
 * nothing more, so a pickup needed the two circles to be all but exactly
 * tangent on the one frame the pass looked — and at 7.2 u/s a frame is 0.24 u
 * of travel, which is wider than the window the old pad left open. A
 * quarter-unit reach is a hand's width at world scale: invisible on a 0.9 u
 * creature, and it means a thing the ball rolls NEAR is a thing the ball
 * gets.
 */
export const CONTACT_PAD = 0.25;

/**
 * [D] How far ABOVE the carry limit a rooted prop has to be before it stops
 * the creature dead.
 *
 * > User ask, 2026-09-16: *"My character keeps on getting stuck on objects …
 * > I think we can relax the actual physics a little bit."*
 *
 * The priority ruling gave the creature everything inside its carry limit and
 * a wall at 1.0 of it: one unlucky centimetre of prop radius was the
 * difference between rolling something up and being stopped by it. Between
 * the limit and 1.6× it, a planted prop is now `shove` — the ball pushes
 * past, slowed like a bush and doing the prop the same damage it always did,
 * but never held. Only past 1.6× does a rooted thing block, which is where
 * "that is bigger than me" is something a person can see rather than a
 * rounding error in a measured radius.
 *
 * 1.6 rather than 2: two would mean a hatchling ploughing through trunks
 * nearly twice its size, and the escalation the brief asks for — first ten
 * seconds cute, last twenty out of control — needs *something* to say no.
 * The break ladder is untouched underneath: the same impact that used to
 * knock a prop loose still does, whichever side of this line it is on.
 */
export const BLOCK_RATIO = 1.6;

/** The biggest ROOTED prop this carrier can push past instead of being
 * stopped by — `BLOCK_RATIO` of what it can actually carry. */
export function passLimit(carrierR: number): number {
  return BLOCK_RATIO * carryLimit(carrierR);
}

/** From the tokens, never a literal: the shortest gap between two drops off
 * the same carrier. A pile that shed on every contact would unravel in one
 * frame against a tree, and a beat is the shortest interval this project
 * treats as a movement anybody perceives. */
export const DROP_MIN_GAP_MS = MOTION.tertiaryMs;

/**
 * [D] Items on the pile at which a creature stops walking and starts rolling.
 *
 * > User ask, 2026-09-16: *"let's have them start walking at first and once
 * > they hit a few objects they begin to roll because they have mass."*
 *
 * THREE, because three is the smallest number that reads as "a few" and as a
 * pile: one stone stuck to a creature is a creature carrying a stone, and two
 * is a coincidence. Three is a lump with a shape of its own, and at a typical
 * hatchling it is also about where `growth` first makes the silhouette
 * obviously bigger than the drawing.
 */
export const ROLL_MASS_ITEMS = 3;

/**
 * [D] …or this much bigger than it started, whichever comes first.
 *
 * Mass, not count: one thing its own size is more mass than three pebbles,
 * and a creature that has swallowed a tree should roll whether or not it has
 * collected two more. 1.08 is an eighth of the way to `growth`'s first
 * doubling and is about one body-sized item — visible as a bulge, and past
 * anything a rounding error in a measured radius could produce.
 */
export const ROLL_GROWTH = 1.08;

/**
 * Should this creature be ROLLING? — the pure half of the walk/roll blend.
 *
 * A target, not a state: the manager retargets a ζ ≥ 1 spring at it over
 * `MOTION.primaryMs`, so the change of locomotion is a slide and never a cut
 * (TASTE §2.1, confidence 1.00). Either threshold is enough, and the answer
 * falls back to 0 when a pile is shed — a creature that has been robbed walks
 * again.
 *
 * Derived from the CLUMP alone (item count and growth), which is why it can
 * live here: every page holds the same clump state, off the same `stick` and
 * `drop` events, so every page reaches the same blend without a byte on the
 * wire about it.
 */
export function rollTarget(items: number, growth: number): 0 | 1 {
  return items >= ROLL_MASS_ITEMS || growth >= ROLL_GROWTH ? 1 : 0;
}

/**
 * [D] Where the ball's FOOTPRINT is sampled, as a fraction of `bodyR`.
 *
 * > User report, 2026-09-16: *"the ball is glitching through the map floor if
 * > it's big enough."*
 *
 * A creature is placed on the ground under its CENTRE (the Surface seam, PLAN
 * §7.2), which is exactly right for a 0.9 u hatchling and wrong for a ball
 * several units across: the contact patch of a big ball is a disc, and on any
 * slope, terrace riser or basin lip the ground under the uphill edge of that
 * disc is *above* the ground under the middle. The ball's underside sits at
 * the root (`clump.group` is at `(0, baseR, 0)` and the root's scale is the
 * growth, so the ball's centre is `root.y + bodyR` and its bottom is exactly
 * `root.y`) — so whatever the highest ground under the footprint is, the root
 * has to be at least that high or the downhill half of the ball, and the
 * items seated low on the pile, are inside the hill.
 *
 * 0.8 rather than 1.0: a sphere's silhouette touches the ground at one point
 * and the terrain has to rise a long way to meet it at the very rim, so
 * sampling the outermost ring would lift the ball off gentle ground for
 * nothing. Four fifths of the way out is where a ball resting in a dip is
 * actually in contact, and `CLEARANCE_PAD` covers the rest.
 */
export const CLEARANCE_RING = 0.8;

/**
 * [D] How many points on that ring.
 *
 * Eight — the four cardinals and the four diagonals, so a riser approached
 * square and a riser approached at 45° are sampled the same. Sixteen would
 * halve the worst-case miss between two spokes and double a per-frame cost
 * paid by every grown creature on the island; the pad below is the cheaper
 * half of the same job.
 */
export const CLEARANCE_POINTS = 8;

/**
 * [D] A little more, as a fraction of `bodyR`.
 *
 * Two jobs. The ring samples at `CLEARANCE_RING` and the ground goes on
 * rising outside it; and an item is seated `CLUMP_FIT` into the pile's
 * surface, so the small stones on the underside of a ball hang below the
 * ball's own silhouette. 6% of the radius is under two centimetres on a
 * hatchling and 18 on a 3 u ball — invisible as a float, enough that the
 * pebbles on the bottom of the pile do not scrape through the paper.
 *
 * It is NOT a fix for a boulder seated at the very bottom of a pile: an item
 * of radius `itemR` reaches `1.7 × itemR` past the ball's surface
 * (`CLUMP_FIT`), and no constant fraction of `bodyR` covers the carry limit's
 * worst case. What the pad covers is the common pile.
 */
export const CLEARANCE_PAD = 0.06;

/**
 * The ring's directions — a unit circle, `CLEARANCE_POINTS` of them,
 * precomputed so no frame pays for a `cos`/`sin` and so every page walks the
 * same points in the same order (the lift is derived on every page, never
 * sent, so two pages that sampled different points would disagree about the
 * height of the same creature).
 */
export const CLEARANCE_DIRS: readonly { x: number; z: number }[] = Array.from(
  { length: CLEARANCE_POINTS },
  (_unused, i) => {
    const a = (i / CLEARANCE_POINTS) * Math.PI * 2;
    return { x: Math.cos(a), z: Math.sin(a) };
  },
);

/**
 * How far to lift the ball's root so its underside clears the ground.
 *
 * `max(0, highest ring height − centre height) + pad`: a ball on a slope
 * rides up on its uphill side, a ball on the flat gets the pad alone, and
 * nothing is ever pushed DOWN into the ground — the Surface's own height
 * under the centre stays the floor of the answer, so this can only ever be a
 * clearance and never a second opinion about where the ground is.
 *
 * Pure, and pure in the way this file means it: the sampler is handed in, so
 * the same three numbers come out for the same terrain on every page and the
 * lift never has to travel on the wire (docs/PLAN.md §7.6 — poses carry
 * x/z/heading, and Y is always local).
 *
 * A TARGET, not a placement: the manager eases the root onto it with a ζ ≥ 1
 * spring over `MOTION.primaryMs`, so a terrace edge is a slide and not a step
 * (TASTE §2.1, confidence 1.00).
 */
export function clearanceLift(
  x: number,
  z: number,
  bodyR: number,
  sampleHeight: (x: number, z: number) => number,
): number {
  if (!(bodyR > 0)) return 0;
  return footprintRise(x, z, bodyR, sampleHeight) + bodyR * CLEARANCE_PAD;
}

/**
 * HOW MUCH HIGHER THE GROUND IS UNDER THE EDGE of a footprint this wide than
 * it is under the middle, world units. PURE, and never negative.
 *
 * The ring half of `clearanceLift` on its own, because the ground pass wants
 * exactly that and NOT the pad (2026-09-17, the *"characters are floating"*
 * report): the pad is a fraction of a RADIUS, and a pile is sat down by its
 * own lowest point now, so adding a fraction of anything to it is a creature
 * held off the paper by a number with nothing under it. The pad stays where
 * it was earned — inside `clearanceLift`, which the ball's own silhouette
 * still uses.
 */
export function footprintRise(
  x: number,
  z: number,
  radius: number,
  sampleHeight: (x: number, z: number) => number,
): number {
  if (!(radius > 0)) return 0;
  const centre = sampleHeight(x, z);
  const ringR = radius * CLEARANCE_RING;
  let highest = centre;
  for (const dir of CLEARANCE_DIRS) {
    const h = sampleHeight(x + dir.x * ringR, z + dir.z * ringR);
    if (h > highest) highest = h;
  }
  return Math.max(0, highest - centre);
}

/** The biggest item radius this carrier can take on. */
export function carryLimit(carrierR: number): number {
  return PICKUP_RATIO * carrierR;
}

/**
 * The biggest OTHER CREATURE this carrier can take on — its own radius over
 * `CREATURE_CARRY_RATIO`, which is the same statement as
 * `carrierR >= CREATURE_CARRY_RATIO * otherR` and is the form the manager's
 * pass wants (one number per carrier, compared against each neighbour).
 */
export function creatureCarryLimit(carrierR: number): number {
  return carrierR / CREATURE_CARRY_RATIO;
}

/**
 * How hard that was, in the one currency the rules are denominated in.
 *
 * Speed × radius, not speed alone and not a real momentum: mass would be
 * radius cubed, and cubing it means a big creature flattens a forest by
 * standing near it. Linear in radius keeps the escalation readable — twice
 * as big and twice as fast is four times the impact, which is four props
 * up the table rather than thirty-two.
 */
export function impactOf(speed: number, carrierR: number): number {
  return speed * carrierR;
}

/** What one creature-meets-item contact does. */
export type Outcome = 'block' | 'loose' | 'shove' | 'stick' | 'break';

/**
 * Which stage of a staged collapse `accumulated` damage has reached.
 *
 * 0 is intact, 3 is rubble. Inclusive at each threshold, the same
 * `>=` `decideContact` uses for coming out of the ground, and monotonic in
 * the accumulator — the host adds impact to a running total and asks this,
 * so a stage can only ever advance.
 *
 * A kind with no `stages` is never staged and answers 0 for any damage at
 * all: a tree does not crack, it comes down.
 */
export function stageFor(props: StickyProps, accumulated: number): 0 | 1 | 2 | 3 {
  const stages = props.stages;
  if (!stages || !(accumulated > 0)) return 0;
  if (accumulated >= stages[2]) return 3;
  if (accumulated >= stages[1]) return 2;
  if (accumulated >= stages[0]) return 1;
  return 0;
}

/**
 * [D] How long a piece of debris lives, by the tier of the prop it broke off.
 *
 * > User brief, 2026-09-15: *"debris is lightweight, has LIFETIMES (small
 * > 5–10 s, medium 10–20 s, important persistent), never grows without
 * > bound."*
 *
 * From the tokens, never a literal (CLAUDE.md): two ambient beats is 7.3s,
 * which sits in the brief's small band, and four is 14.6s, which sits in its
 * medium one. A `large` or `building` chunk is the brief's "important" case
 * and persists — a fallen section of a building is a landmark of what
 * happened in the room, and a piece that faded out from under a pile
 * halfway through collecting it would be the world taking something back.
 *
 * The CAP is what actually bounds the count (`DEBRIS_CAP` in
 * src/world/device.ts, oldest-first): a lifetime keeps the field tidy, a cap
 * keeps a phone alive.
 */
export function debrisLifetimeMs(props: StickyProps): number {
  if (props.tier === 'small') return MOTION.ambientMs * 2;
  if (props.tier === 'medium') return MOTION.ambientMs * 4;
  return Infinity;
}

/**
 * The whole game, in four lines — and SIZE IS THE FIRST QUESTION.
 *
 * > User ruling, 2026-09-16: *"The user's character has priority; objects
 * > should stick to it as it moves or rolls over the object. It shouldn't
 * > impede the character from moving unless the mass isn't big enough to
 * > overtake the object."*
 *
 * So the order is: can I carry it? Then it is MINE, rooted or not — a bush,
 * a sign or a sapling the ball rolls over comes out of the ground and onto
 * the pile in one step, with no impact threshold to clear and no `loose`
 * round trip on the way. Uprooting something smaller than you costs nothing;
 * that is what having priority means.
 *
 * Only what is too big to carry can stop you, it has to be ROOTED, and since
 * 2026-09-16 it has to be a good deal bigger than the limit as well
 * (`BLOCK_RATIO` — *"relax the actual physics a little bit"*):
 *
 *  - rooted and over `BLOCK_RATIO` of the limit → `block`, and the old impact
 *    ladder decides whether the block also breaks it (`shatterStrength` →
 *    `break`, `breakStrength` → `loose`, a building's `stages` accumulating
 *    behind both). That ladder is unchanged.
 *  - rooted and merely over the CARRY limit → `shove`: too big to wear, not
 *    big enough to stop you. The ball pushes past it, slowed like a bush, and
 *    the prop takes the damage it always took.
 *  - unrooted and too big → `shove`. Never a block: a stone you cannot carry
 *    rolls away, which the rapier layer does for free, and the ruling says a
 *    creature is not impeded by what it can move.
 *
 * `stickiness: 0` still means never, whatever the size — the cloud is scenery
 * in the sky and a creature tall enough to reach one does not wear it.
 */
export function decideContact(a: {
  itemR: number;
  rooted: boolean;
  props: StickyProps;
  impact: number;
  carrierR: number;
}): Outcome {
  /*
   * SIZE FIRST, and rootedness is not consulted: small enough is stuck.
   *
   * NOR IS `breakStrength`, AND THAT INCLUDES A BUILDING (2026-09-17). A
   * building's `breakStrength` is `Infinity` and its `stages` are how it
   * comes down for a carrier too small to lift it — but a ball whose radius
   * has passed the building's takes it out of the ground whole, like
   * anything else inside the limit. Nothing here is a tier check: the rule
   * is the ruling (*"objects should stick to it as it moves or rolls over
   * the object"*), and a `building` row that opted out of it would be the
   * ceiling the 2026-09-17 ask is about. Its rubble, once it HAS partly
   * collapsed, arrives as loose items and sticks the way loose items do.
   */
  if (a.itemR <= carryLimit(a.carrierR) && a.props.stickiness > 0) return 'stick';
  // Too big, and loose: it gets out of the way rather than standing in it.
  if (!a.rooted) return 'shove';
  /*
   * Too big AND planted — the only thing in the world that says no.
   *
   * BREAK TAKES PRECEDENCE over coming out of the ground, and it is asked
   * first for exactly that reason: `shatterStrength` is above
   * `breakStrength`, so an impact that reaches it has already passed the
   * looser test and a prop hit that hard should come apart rather than be
   * lifted whole onto a pile. It is asked even of a kind whose
   * `breakStrength` is `Infinity`, because those two thresholds are
   * independent — though nothing in `STICKY` sets both today.
   */
  const shatter = a.props.shatterStrength;
  if (shatter !== undefined && Number.isFinite(shatter) && a.impact >= shatter) return 'break';
  /*
   * IT HELD — but holding is not the same as STOPPING (`BLOCK_RATIO`,
   * 2026-09-16: *"my character keeps on getting stuck on objects … relax the
   * actual physics a little bit"*).
   *
   * Between the carry limit and `BLOCK_RATIO` of it a planted prop is
   * `shove`d: the ball pushes past, slowed down and doing the prop the same
   * damage it always did, and the staged ladder above still runs on it —
   * `shove` and `block` are one verdict to everything except the resolve, and
   * the resolve is exactly the thing this changes. Only a rooted prop over
   * that line is a wall.
   */
  const stops = a.itemR > passLimit(a.carrierR);
  // `Infinity` means NEVER, and it has to mean that even when it is asked
  // about an infinite impact — `Infinity >= Infinity` is true, which would
  // have handed a building to anyone who managed to overflow a speed.
  if (!Number.isFinite(a.props.breakStrength)) return stops ? 'block' : 'shove';
  if (a.impact >= a.props.breakStrength) return 'loose';
  return stops ? 'block' : 'shove';
}

/**
 * Uniform scale for a carrier whose base radius is `baseR` and which is
 * carrying items of volumes `volumes`.
 *
 * Volume adds, radius is its cube root: a pile is a solid, and a creature
 * that has eaten eight identical stones should be twice the stone's diameter
 * bigger, not eight times. The `1 +` is what makes an empty carrier exactly
 * itself, so this can be applied unconditionally every frame.
 *
 * An item's volume is taken as `r³` — the cube of the radius, dropping the
 * 4π/3 as a constant that `GROWTH_K` absorbs. Same for the carrier's own
 * `baseR³` in the denominator, so the ratio is dimensionless.
 */
export function growth(baseR: number, volumes: readonly number[]): number {
  if (!(baseR > 0)) return 1;
  let sum = 0;
  for (const v of volumes) sum += v;
  if (!(sum > 0)) return 1;
  return Math.cbrt(1 + (GROWTH_K * sum) / (baseR * baseR * baseR));
}

/**
 * Has this item been knocked off?
 *
 * Strictly greater, so an `attachmentStrength` of 0 still sheds on any real
 * contact and a contact of exactly the threshold holds — the same
 * >= / > asymmetry `decideContact` uses for coming out of the ground, so a
 * prop with equal numbers cannot both break free and fall off at one impact.
 */
export function shouldDrop(props: StickyProps, impact: number): boolean {
  return impact > props.attachmentStrength;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * The axis a ball rolls about when it travels `(dx, dz)` on the ground.
 *
 * The horizontal perpendicular of the travel, right-handed: moving along +x
 * rotates about -z, which takes the top of the ball forward. Null below
 * 1e-6 — a creature standing still has no roll axis, and normalising a zero
 * vector is how a pile ends up full of NaN.
 */
export function rollAxis(dx: number, dz: number): { x: number; y: number; z: number } | null {
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-6)) return null;
  return { x: dz / len, y: 0, z: -dx / len };
}

/** Radians of roll for `distance` travelled by a ball of radius `R`. Arc
 * length over radius, which is the no-slip condition and nothing more. */
export function rollDelta(distance: number, R: number): number {
  if (!(R > 1e-6)) return 0;
  return distance / R;
}

/** Conjugate of a unit quaternion, which is its inverse. */
function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Hamilton product. `a × b` applies b first, then a. */
function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Rotate a vector by a quaternion (`q × v × q⁻¹`, expanded). */
function rotate(q: Quat, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return {
    x: x + q.w * tx + (q.y * tz - q.z * ty),
    y: y + q.w * ty + (q.z * tx - q.x * tz),
    z: z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * Where on the pile an item that was just hit at `(itemX, itemY, itemZ)`
 * belongs, in the CLUMP's own local frame.
 *
 * The direction is kept and the distance is replaced: an item sticks on the
 * side it was struck from (which is the only thing that makes a pile look
 * like it was assembled by running into things), seated at the clump's
 * surface plus its own radius, sunk in by `CLUMP_FIT`.
 *
 * Then out of world space and into the clump's: `inverse(clumpWorldQ)`
 * undoes the pile's accumulated roll, and the divide by `growth` undoes the
 * carrier root's uniform scale — so the offset stored on the item is the one
 * that keeps it in the same place on the pile as the pile rolls and grows.
 * That is also exactly the number the `stick` event carries, which is why it
 * is computed here rather than left to three.js: every screen has to arrive
 * at the same seat from the same three floats.
 *
 * A hit exactly at the centre has no direction to keep, so the heading is
 * used — the item lands in front of the creature, which is where it was.
 *
 * HOW FAR OUT is `packSeatDistance` (2026-09-17, *"the character should be the
 * object that the items stick to"*): the character's own surface for the first
 * thing, and on top of what is already there for everything after. It used to
 * be `R + itemR × CLUMP_FIT` — the surface of a sphere of radius
 * `baseR × growth` — which is the shell that had to be drawn for the pile to
 * make sense, and is gone.
 */
export function clumpLocalOffset(a: {
  itemX: number;
  itemY: number;
  itemZ: number;
  centreX: number;
  centreY: number;
  centreZ: number;
  headingX: number;
  headingZ: number;
  /** The CHARACTER's own radius — what the first item sticks to. */
  selfR: number;
  itemR: number;
  /** What is already on the pile (world offsets from its centre, and radii),
   * which is what everything after the first item packs against. */
  seats: readonly { x: number; y: number; z: number; r: number }[];
  clumpWorldQ: Quat;
  growth: number;
}): { x: number; y: number; z: number } {
  let dx = a.itemX - a.centreX;
  let dy = a.itemY - a.centreY;
  let dz = a.itemZ - a.centreZ;
  let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-6)) {
    dx = a.headingX;
    dy = 0;
    dz = a.headingZ;
    len = Math.hypot(dx, dz);
    // Nowhere to point at all: straight ahead in the clump's own frame.
    if (!(len > 1e-6)) {
      dx = 0;
      dy = 0;
      dz = 1;
      len = 1;
    }
  }
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const reach = packSeatDistance({
    dirX: ux,
    dirY: uy,
    dirZ: uz,
    itemR: a.itemR,
    selfR: a.selfR,
    seats: a.seats,
  });
  const wx = ux * reach;
  const wy = uy * reach;
  const wz = uz * reach;
  const local = rotate(conjugate(a.clumpWorldQ), wx, wy, wz);
  const g = a.growth > 1e-6 ? a.growth : 1;
  return { x: local.x / g, y: local.y / g, z: local.z / g };
}

/**
 * The rotation to store on a stuck item: its live world rotation, expressed
 * in the clump's frame.
 *
 * A fallen tree keeps lying the way it fell — the pile turns under it, the
 * tree does not straighten up. That is `inverse(clumpWorldQ) × itemWorldQ`,
 * the same change of frame the offset goes through.
 */
export function clumpLocalRotation(itemWorldQ: Quat, clumpWorldQ: Quat): Quat {
  return multiply(conjugate(clumpWorldQ), itemWorldQ);
}
