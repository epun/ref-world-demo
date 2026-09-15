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
  monolith: {
    tier: 'large',
    rooted: true,
    breakStrength: 8,
    attachmentStrength: 10,
    stickiness: 1,
  },
  waterTower: {
    tier: 'large',
    rooted: true,
    breakStrength: 8,
    attachmentStrength: 10,
    stickiness: 1,
  },
  // ── building ─────────────────────────────────────────────────────────────
  // `Infinity` FOR NOW, and the seam is deliberate: the destruction task
  // replaces these two numbers with staged collapse, and until it does a
  // building is the thing you cannot eat rather than a thing that vanishes.
  building: {
    tier: 'building',
    rooted: true,
    breakStrength: Infinity,
    attachmentStrength: 10,
    stickiness: 1,
  },
  mountain: {
    tier: 'building',
    rooted: true,
    breakStrength: Infinity,
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
export type Outcome = 'block' | 'loose' | 'shove' | 'stick';

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
