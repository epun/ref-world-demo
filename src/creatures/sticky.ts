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
 * 0.6 is what makes the pile legible: an item over half the carrier's own
 * size reads as two creatures in a heap rather than one creature wearing
 * something. It is also the growth curve's throttle — a carrier can only
 * reach the next tier of props by having eaten the one below it.
 */
export const PICKUP_RATIO = 0.6;

/**
 * [D] How much volume actually becomes size.
 *
 * `growth` is a cube root of accumulated volume, so without a coefficient a
 * creature that swallowed its own volume would be 2^(1/3) ≈ 1.26× — barely
 * visible after a dozen pickups. 0.35 makes the first ten seconds cute
 * (a few stones, a noticeable bulge) and twenty seconds of trees enormous,
 * which is the shape of the brief.
 */
export const GROWTH_K = 0.35;

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
 * single pickup. 5cm is under the skin's own order of magnitude at world
 * scale and far below anything a person could see.
 */
export const CONTACT_PAD = 0.05;

/** From the tokens, never a literal: the shortest gap between two drops off
 * the same carrier. A pile that shed on every contact would unravel in one
 * frame against a tree, and a beat is the shortest interval this project
 * treats as a movement anybody perceives. */
export const DROP_MIN_GAP_MS = MOTION.tertiaryMs;

/** The biggest item radius this carrier can take on. */
export function carryLimit(carrierR: number): number {
  return PICKUP_RATIO * carrierR;
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
 * The whole game, in four lines.
 *
 * A ROOTED prop either comes out of the ground or stops you dead — it is
 * never picked up directly, because a tree that flew onto a pile while still
 * standing in its hole is the pile going through the world rather than
 * taking it apart.
 *
 * An UNROOTED item either sticks (small enough, and sticky) or is shoved —
 * and shoved is not a failure, it is the stone rolling away, which the rapier
 * layer does for free.
 */
export function decideContact(a: {
  itemR: number;
  rooted: boolean;
  props: StickyProps;
  impact: number;
  carrierR: number;
}): Outcome {
  if (a.rooted) {
    /*
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
    // `Infinity` means NEVER, and it has to mean that even when it is asked
    // about an infinite impact — `Infinity >= Infinity` is true, which would
    // have handed a building to anyone who managed to overflow a speed.
    if (!Number.isFinite(a.props.breakStrength)) return 'block';
    return a.impact >= a.props.breakStrength ? 'loose' : 'block';
  }
  return a.itemR <= carryLimit(a.carrierR) && a.props.stickiness > 0 ? 'stick' : 'shove';
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
  R: number;
  itemR: number;
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
  const reach = a.R + a.itemR * CLUMP_FIT;
  const wx = (dx / len) * reach;
  const wy = (dy / len) * reach;
  const wz = (dz / len) * reach;
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
