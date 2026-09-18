/**
 * The sticky-world rules (src/creatures/sticky.ts).
 *
 * The game itself is in here — what sticks, what comes out of the ground, how
 * fast a pile grows, where an item is seated on it and how far the pile has
 * rolled. All of it pure, which is the point: these tests pin the actual rules
 * rather than a screenshot of them, and the numbers they pin are the same ones
 * every screen in the room arrives at.
 */

import { describe, expect, it } from 'vitest';
import {
  carryLimit,
  clearanceLift,
  CLEARANCE_PAD,
  CLEARANCE_POINTS,
  CLEARANCE_RING,
  CLUMP_FIT,
  clumpLocalOffset,
  BLOCK_RATIO,
  clumpLocalRotation,
  packCandidateDirections,
  packSeatDirection,
  packSeatDistance,
  PACK_ELEVATION_MAX,
  CREATURE_CARRY_RATIO,
  creatureCarryLimit,
  decideContact,
  DROP_MIN_GAP_MS,
  growth,
  impactOf,
  passLimit,
  PICKUP_RATIO,
  rollAxis,
  rollDelta,
  shouldDrop,
  STICKY,
  type Quat,
} from '../../src/creatures/sticky';
import { MAX_SPEED } from '../../src/behavior/agent';
import { MOTION } from '../../src/taste/tokens';
import { PROP_KINDS } from '../../src/world/props';

/** Rotate a vector by a quaternion, the long way round, so the test does not
 * reuse the module's own helper to check the module. */
function rotate(q: Quat, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const t = { x: 2 * (q.y * v.z - q.z * v.y), y: 2 * (q.z * v.x - q.x * v.z), z: 2 * (q.x * v.y - q.y * v.x) };
  return {
    x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y),
    y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z),
    z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x),
  };
}

function multiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function axisAngle(axis: { x: number; y: number; z: number }, theta: number): Quat {
  const h = theta / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

describe('STICKY — every prop kind has a row', () => {
  it('covers every kind the scatter can place, with no gaps', () => {
    for (const kind of PROP_KINDS) {
      const props = STICKY[kind];
      expect(props, kind).toBeDefined();
      expect(props.attachmentStrength, kind).toBeGreaterThanOrEqual(0);
      expect(props.stickiness, kind).toBeGreaterThanOrEqual(0);
    }
  });

  it('makes the rock the one unrooted AUTHORED kind — it is already a rigid body', () => {
    const unrooted = PROP_KINDS.filter((k) => !STICKY[k].rooted);
    // `small` joins it (2026-09-16, the katamari object library): the junk
    // tier is mugs, cans and shells lying on the ground, which is what the
    // rock's row already described. Every library kind's rootedness can be
    // overridden per MODEL — a bench is not planted and the vending machine
    // beside it is — through `stickyFor`, which is tested below; these rows
    // are the kind's common case.
    expect(unrooted).toEqual(['rock', 'small']);
  });

  it('never lets a cloud be worn', () => {
    expect(STICKY.cloud.stickiness).toBe(0);
    expect(STICKY.cloud.breakStrength).toBe(Infinity);
  });

  it('leaves buildings and the mountain unbreakable — the destruction seam', () => {
    expect(STICKY.building.breakStrength).toBe(Infinity);
    expect(STICKY.mountain.breakStrength).toBe(Infinity);
    expect(STICKY.building.tier).toBe('building');
    expect(STICKY.mountain.tier).toBe('building');
  });

  it('escalates break strength up the tiers, which is the arc of the game', () => {
    expect(STICKY.bush.breakStrength).toBeLessThan(STICKY.tree.breakStrength);
    expect(STICKY.tree.breakStrength).toBeLessThan(STICKY.monolith.breakStrength);
    expect(STICKY.bush.attachmentStrength).toBeLessThan(STICKY.tree.attachmentStrength);
    expect(STICKY.tree.attachmentStrength).toBeLessThan(STICKY.monolith.attachmentStrength);
  });
});

describe('carryLimit / impactOf', () => {
  it('is the pickup ratio of the carrier radius', () => {
    expect(carryLimit(2)).toBeCloseTo(PICKUP_RATIO * 2, 12);
    expect(carryLimit(0)).toBe(0);
  });

  /**
   * THE FIRST RUNG HAS TO EXIST (user report, 2026-09-16: *"I don't see the
   * sticky katamari effect where the character gathers objects as it touches
   * them"*).
   *
   * At 0.6 a ~0.9u hatchling's ceiling was ~0.54u and the smallest stone on
   * the map is ~0.5u, with the rest of the scatter running to 1.7u — so
   * almost nothing could start a pile and the growth curve never left the
   * ground. This is that arithmetic, as an assertion rather than a comment:
   * an item the carrier's OWN size sticks.
   */
  it('lets a fresh creature take a stone its own size — the pile has to start', () => {
    const hatchling = 0.9;
    // A little over its own radius since 2026-09-17 (PICKUP_RATIO 1.15).
    expect(carryLimit(hatchling)).toBeCloseTo(PICKUP_RATIO * hatchling, 12);
    expect(carryLimit(hatchling)).toBeGreaterThan(hatchling);
    for (const stone of [0.5, 0.7, 0.9]) {
      expect(
        decideContact({
          itemR: stone,
          rooted: false,
          props: STICKY.rock,
          impact: 1,
          carrierR: hatchling,
        }),
      ).toBe('stick');
    }
    // And the tier above it is still out of reach until it has grown.
    expect(
      decideContact({
        itemR: 1.7,
        rooted: false,
        props: STICKY.rock,
        impact: 1,
        carrierR: hatchling,
      }),
    ).toBe('shove');
  });

  /**
   * A CREATURE IS NOT A PROP (`CREATURE_CARRY_RATIO`, 2026-09-16 — the stuck
   * report).
   *
   * The pickup limit is 1.0 of the carrier's radius, so two creatures of the
   * same size were each exactly at the other's limit and one of them became
   * somebody's luggage on contact — with its stick doing nothing, which is
   * what *"my character got stuck"* was. A creature is somebody's, so it
   * takes a clear size gap: a third again as big, which no pair can satisfy
   * in both directions.
   */
  it('needs a size GAP to carry another creature, not a tie', () => {
    expect(CREATURE_CARRY_RATIO).toBeGreaterThan(1);
    // Equal size: neither carries the other, whichever way round it is asked.
    expect(1.4 <= creatureCarryLimit(1.4)).toBe(false);
    // And the gap is reachable — a creature a third again as wide carries.
    expect(1.4 <= creatureCarryLimit(1.4 * CREATURE_CARRY_RATIO)).toBe(true);
    // Mutual eligibility has no solution at all: no id tiebreak can exist.
    for (const a of [0.4, 0.9, 1.4, 2.7, 6]) {
      for (const b of [0.4, 0.9, 1.4, 2.7, 6]) {
        expect(b <= creatureCarryLimit(a) && a <= creatureCarryLimit(b)).toBe(false);
      }
    }
    // A PROP the same size still sticks: the two limits are different rules.
    expect(carryLimit(1.4)).toBeGreaterThanOrEqual(1.4);
  });

  it('is speed times radius — linear in size, so escalation stays readable', () => {
    expect(impactOf(3, 2)).toBeCloseTo(6, 12);
    expect(impactOf(6, 4)).toBeCloseTo(4 * impactOf(3, 2), 12);
  });
});

describe('decideContact', () => {
  const at = (
    kind: keyof typeof STICKY,
    impact: number,
    itemR: number,
    carrierR: number,
  ): ReturnType<typeof decideContact> =>
    decideContact({
      itemR,
      rooted: STICKY[kind].rooted,
      props: STICKY[kind],
      impact,
      carrierR,
    });

  /*
   * EVERY CASE BELOW HANDS IT AN ITEM BIGGER THAN THE CARRIER, and that is
   * deliberate since the 2026-09-16 ruling: `decideContact` asks about SIZE
   * first, so anything inside the carry limit is simply stuck and none of
   * these thresholds are consulted at all. The ladder they pin is what
   * happens above the limit — which is the only place a prop can still say
   * no. The size branch itself is pinned just below.
   */
  it('blocks a rooted prop below its break strength and looses it at or above', () => {
    expect(at('tree', STICKY.tree.breakStrength - 0.001, 4, 1)).toBe('block');
    expect(at('tree', STICKY.tree.breakStrength, 4, 1)).toBe('loose');
    expect(at('tree', STICKY.tree.breakStrength + 5, 4, 1)).toBe('loose');
  });

  it('never looses a building however hard it is hit', () => {
    expect(at('building', 1e9, 8, 4)).toBe('block');
    expect(at('mountain', Infinity, 20, 9)).toBe('block');
  });

  it('yields a bush to a walk — that is what a tiny break strength means', () => {
    // A creature too small to wear the bush, at a stroll: impact 0.9 > the
    // bush's 0.6, so it comes out of the ground and is left lying there.
    expect(at('bush', impactOf(0.9, 1), 0.8, 0.5)).toBe('loose');
    // And a creature big enough to wear it does not knock it loose at all —
    // it takes it (2026-09-16: the character has priority).
    expect(at('bush', impactOf(0.9, 1), 0.8, 1)).toBe('stick');
  });

  it('sticks an unrooted item inside the carry limit and shoves one outside it', () => {
    expect(at('rock', 2, carryLimit(4) - 0.01, 4)).toBe('stick');
    expect(at('rock', 2, carryLimit(4), 4)).toBe('stick');
    expect(at('rock', 2, carryLimit(4) + 0.01, 4)).toBe('shove');
  });

  it('shoves a zero-stickiness item whatever its size', () => {
    expect(
      decideContact({ itemR: 0.1, rooted: false, props: STICKY.cloud, impact: 9, carrierR: 40 }),
    ).toBe('shove');
  });

  it('is the same whichever way a growing creature approaches the table', () => {
    // A tree at a fixed speed, too big for either creature to carry: too
    // small to fell it, then big enough. Monotone in carrier radius, because
    // impact is.
    const speed = 2;
    const small = at('tree', impactOf(speed, 1), 8, 1);
    const large = at('tree', impactOf(speed, 6), 8, 6);
    expect(small).toBe('block');
    expect(large).toBe('loose');
  });

  /**
   * THE SIZE BRANCH, which now comes first (user ruling, 2026-09-16: *"the
   * user's character has priority; objects should stick to it as it moves or
   * rolls over the object. It shouldn't impede the character from moving
   * unless the mass isn't big enough to overtake the object"*).
   */
  it('sticks a ROOTED prop inside the carry limit at zero impact', () => {
    // No threshold is cleared and it still comes up: uprooting something
    // smaller than you costs nothing.
    expect(at('tree', 0, 0.5, 1)).toBe('stick');
    expect(at('building', 0, 3, 4)).toBe('stick');
    // Not the cloud, whatever its size — `stickiness: 0` means never. It is
    // `shove` rather than `block` because it is well inside the block ratio,
    // and academic either way: a cloud publishes no collider at all.
    expect(at('cloud', 0, 0.01, 40)).toBe('shove');
  });

  it('shoves an unrooted item it cannot carry instead of blocking on it', () => {
    // The ruling's other half: a creature is never impeded by something it
    // can move, and a stone it cannot carry rolls away.
    expect(at('rock', 0, 4, 1)).toBe('shove');
  });

  /**
   * BLOCKING IS THE EXCEPTION (`BLOCK_RATIO`, 2026-09-16: *"my character
   * keeps on getting stuck on objects … relax the actual physics a little
   * bit"*).
   *
   * One centimetre of prop radius used to be the difference between rolling
   * something up and being stopped dead by it. Now there is a band above the
   * carry limit where a planted prop is pushed PAST — slowed, damaged, never
   * a wall — and only past `BLOCK_RATIO` of the limit does anything stop the
   * creature at all.
   */
  it('pushes past a rooted prop until it is BLOCK_RATIO bigger than the limit', () => {
    const body = 1;
    expect(passLimit(body)).toBeCloseTo(BLOCK_RATIO * carryLimit(body), 12);
    // Inside the carry limit: worn.
    expect(at('tree', 0, carryLimit(body) * 0.9, body)).toBe('stick');
    // In the band: pushed past, at any impact under the break threshold.
    expect(at('tree', 0, carryLimit(body) * 1.2, body)).toBe('shove');
    expect(at('tree', 0, passLimit(body) - 0.01, body)).toBe('shove');
    // Over the line: a wall, exactly as before.
    expect(at('tree', 0, passLimit(body) + 0.01, body)).toBe('block');
    // And the break ladder is untouched on both sides of it: the same impact
    // that used to free a prop still frees it.
    expect(at('tree', STICKY.tree.breakStrength, passLimit(body) + 0.01, body)).toBe('loose');
    expect(at('tree', STICKY.tree.breakStrength, carryLimit(body) * 1.2, body)).toBe('loose');
  });

  it('never lets a building be carried, and still wears it down', () => {
    // A building's `breakStrength` is Infinity, so the band only changes
    // whether it STOPS the creature — its stages accumulate either way
    // (docs/PLAN.md §7.6, `hitRooted`).
    const body = 1;
    expect(at('building', 0, passLimit(body) + 0.01, body)).toBe('block');
    expect(at('building', 1e6, passLimit(body) + 0.01, body)).toBe('block');
    expect(at('building', 0, carryLimit(body) * 1.2, body)).toBe('shove');
  });
});

describe('the table against the speeds the world actually reaches', () => {
  /*
   * ANCHORED TO `MAX_SPEED`, not to numbers picked here.
   *
   * Every other test in this file hands `impactOf` its arguments directly, so
   * all of them passed throughout the life of a units bug in the manager that
   * made real impacts a thousand times too small (see the end-to-end test in
   * test/creatures/manager.test.ts). These tie the thresholds to the one
   * speed constant the world is built on and to the radii the generator
   * actually produces (~0.9 for a small drawing, ~2.7 for a large one), so a
   * table that drifted out of reach of a walking creature would fail here.
   */
  const SMALL_BODY = 0.9;
  const LARGE_BODY = 2.7;

  it('lets a small creature at full tilt flatten a bush and nothing more', () => {
    const impact = impactOf(MAX_SPEED, SMALL_BODY);
    expect(impact).toBeGreaterThan(STICKY.bush.breakStrength);
    expect(impact).toBeLessThan(STICKY.tree.breakStrength);
    expect(impact).toBeLessThan(STICKY.monolith.breakStrength);
  });

  it('puts a tree out of reach until the creature has grown into one', () => {
    expect(impactOf(MAX_SPEED, SMALL_BODY)).toBeLessThan(STICKY.tree.breakStrength);
    expect(impactOf(MAX_SPEED, LARGE_BODY * 1.3)).toBeGreaterThan(STICKY.tree.breakStrength);
  });

  it('keeps the large tier out of reach until there is a real pile', () => {
    // Nothing unaugmented touches it…
    expect(impactOf(MAX_SPEED, LARGE_BODY)).toBeLessThan(STICKY.monolith.breakStrength);
  });

  it('but the large tier IS reachable — a threshold no pile meets is dead', () => {
    /*
     * The assertion that was missing, and the one that caught a break
     * strength of 14: at the driven speed that needed a body radius of 8.3,
     * which is ~490 tree-sized items through a cube-root growth curve.
     * Nothing in a demo meets 490 trees, so the tier — and the destruction
     * seam that keys off `tier === 'large'` — was decoration.
     *
     * A hundred items is a busy but real evening. If a future tuning puts
     * the large tier back out of that reach, this fails and says so.
     */
    const driven = MAX_SPEED * 1.4; // × the wander multiplier the world ships
    const pile = Array.from({ length: 100 }, () => 1.5 ** 3); // tree-sized
    const bodyR = SMALL_BODY * growth(SMALL_BODY, pile);
    expect(impactOf(driven, bodyR)).toBeGreaterThan(STICKY.monolith.breakStrength);
    // And still strictly above the medium tier, so the ordering is real
    // rather than everything collapsing into one threshold.
    expect(STICKY.monolith.breakStrength).toBeGreaterThan(STICKY.tree.breakStrength);
  });

  it('unlocks the medium tier at about a dozen trees, not a hundred', () => {
    const driven = MAX_SPEED * 1.4;
    const dozen = Array.from({ length: 12 }, () => 1.5 ** 3);
    const bodyR = SMALL_BODY * growth(SMALL_BODY, dozen);
    expect(impactOf(driven, bodyR)).toBeGreaterThan(STICKY.tree.breakStrength);
  });

  it('sheds a stone off a small carrier at speed, and holds a monolith on', () => {
    const impact = impactOf(MAX_SPEED, SMALL_BODY);
    // Under a stone's attachment strength at a walk — a pile does not fall
    // apart just for moving.
    expect(shouldDrop(STICKY.rock, impact)).toBe(false);
    // And well over it once there is a real pile swinging around.
    expect(shouldDrop(STICKY.rock, impactOf(MAX_SPEED, LARGE_BODY * 1.5))).toBe(true);
    // A monolith, once won, stays won: nothing a pile can reach shakes it off.
    expect(shouldDrop(STICKY.monolith, impactOf(MAX_SPEED, LARGE_BODY * 1.5))).toBe(false);
  });
});

describe('growth', () => {
  it('is exactly 1 with nothing carried', () => {
    expect(growth(2, [])).toBe(1);
    expect(growth(2, [0])).toBe(1);
  });

  it('is monotone non-decreasing in accumulated volume', () => {
    let last = growth(2, []);
    const volumes: number[] = [];
    for (let i = 0; i < 40; i++) {
      volumes.push(0.5 ** 3);
      const next = growth(2, volumes);
      expect(next).toBeGreaterThanOrEqual(last);
      last = next;
    }
    expect(last).toBeGreaterThan(1);
  });

  it('is cube-root shaped: eight times the volume is twice the excess radius', () => {
    const base = 1;
    const one = growth(base, [1]);
    const eight = growth(base, [8]);
    // g = cbrt(1 + k·V). So (g³ − 1) is linear in V.
    expect(eight ** 3 - 1).toBeCloseTo(8 * (one ** 3 - 1), 10);
    // Which means the RADIUS grows far slower than the volume does.
    expect(eight - 1).toBeLessThan(8 * (one - 1));
  });

  it('scales by the carrier, not by the world: a big creature is less impressed', () => {
    expect(growth(1, [1])).toBeGreaterThan(growth(10, [1]));
  });

  it('refuses to divide by a zero base', () => {
    expect(growth(0, [1])).toBe(1);
  });
});

describe('shouldDrop', () => {
  it('sheds strictly above the attachment strength, and holds at it', () => {
    expect(shouldDrop(STICKY.rock, STICKY.rock.attachmentStrength)).toBe(false);
    expect(shouldDrop(STICKY.rock, STICKY.rock.attachmentStrength + 0.001)).toBe(true);
  });

  it('holds a large prop on through an impact that would shed a stone', () => {
    const impact = STICKY.rock.attachmentStrength + 1;
    expect(shouldDrop(STICKY.rock, impact)).toBe(true);
    expect(shouldDrop(STICKY.monolith, impact)).toBe(false);
  });
});

describe('DROP_MIN_GAP_MS', () => {
  it('comes from the motion tokens and never from a literal', () => {
    expect(DROP_MIN_GAP_MS).toBe(MOTION.tertiaryMs);
  });
});

describe('rollAxis / rollDelta', () => {
  it('is the horizontal perpendicular of travel, right-handed', () => {
    const east = rollAxis(1, 0)!;
    expect([east.x, east.y, east.z]).toEqual([0, 0, -1]);
    const north = rollAxis(0, 1)!;
    // Written out rather than `toEqual`: the perpendicular of due north has a
    // NEGATIVE zero in it, and `-0` is not `0` to a deep-equality check.
    expect(north.x).toBe(1);
    expect(north.y).toBe(0);
    expect(north.z).toBeCloseTo(0, 12);
  });

  it('is a unit vector for any travel', () => {
    for (const [dx, dz] of [
      [3, 4],
      [-1, 7],
      [0.01, -0.02],
    ]) {
      const a = rollAxis(dx!, dz!)!;
      expect(Math.hypot(a.x, a.y, a.z)).toBeCloseTo(1, 12);
      expect(a.y).toBe(0);
    }
  });

  it('is null for a creature standing still — there is nothing to normalise', () => {
    expect(rollAxis(0, 0)).toBeNull();
    expect(rollAxis(1e-9, -1e-9)).toBeNull();
  });

  it('turns arc length into radians, and never divides by a zero radius', () => {
    expect(rollDelta(2, 1)).toBeCloseTo(2, 12);
    expect(rollDelta(2, 4)).toBeCloseTo(0.5, 12);
    expect(rollDelta(2, 0)).toBe(0);
  });

  it('rolls a pile back to identity over 2πR travelled in a straight line', () => {
    const R = 1.7;
    let q: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const steps = 720;
    const per = (2 * Math.PI * R) / steps;
    const axis = rollAxis(1, 0)!;
    for (let i = 0; i < steps; i++) {
      q = multiply(axisAngle(axis, rollDelta(per, R)), q);
    }
    // A full turn is w = ±1 with a vanishing vector part. Either sign is the
    // same rotation — a quaternion double-covers.
    expect(Math.abs(q.w)).toBeCloseTo(1, 6);
    expect(Math.hypot(q.x, q.y, q.z)).toBeCloseTo(0, 6);
  });

  it('rolls HALF as far for twice the radius, which is why a big pile turns slowly', () => {
    expect(rollDelta(10, 2)).toBeCloseTo(rollDelta(10, 1) / 2, 12);
  });
});

describe('clumpLocalOffset', () => {
  /*
   * `selfR` is the CHARACTER's own radius since 2026-09-17 (*"the character
   * should be the object that the items stick to"*): there is no shell, so the
   * first item is seated on the creature and the rest pack outward against
   * what is already there (`seats`, and `packSeatDistance` below). With an
   * empty pile the answer is the creature's surface, which is what these ask.
   */
  const base = {
    centreX: 0,
    centreY: 0,
    centreZ: 0,
    headingX: 0,
    headingZ: 1,
    selfR: 2,
    itemR: 0.5,
    seats: [] as { x: number; y: number; z: number; r: number }[],
    growth: 1,
    clumpWorldQ: { x: 0, y: 0, z: 0, w: 1 } as Quat,
  };

  it('seats an item on the side it was struck from, against the creature', () => {
    const o = clumpLocalOffset({ ...base, itemX: 5, itemY: 0, itemZ: 0 });
    const reach = (base.selfR + base.itemR) * CLUMP_FIT;
    expect(o.x).toBeCloseTo(reach, 12);
    expect(o.y).toBeCloseTo(0, 12);
    expect(o.z).toBeCloseTo(0, 12);
  });

  it('keeps the direction and replaces the distance', () => {
    const near = clumpLocalOffset({ ...base, itemX: 2.1, itemY: 0, itemZ: 0 });
    const far = clumpLocalOffset({ ...base, itemX: 90, itemY: 0, itemZ: 0 });
    expect(near.x).toBeCloseTo(far.x, 12);
    expect(near.y).toBeCloseTo(far.y, 12);
    expect(near.z).toBeCloseTo(far.z, 12);
  });

  it('sinks the item into the creature rather than perching it tangent', () => {
    const o = clumpLocalOffset({ ...base, itemX: 5, itemY: 0, itemZ: 0 });
    expect(o.x).toBeLessThan(base.selfR + base.itemR);
    // Touching the creature since 2026-09-18 (*"there shouldn't be space
    // between the character and the objects"*): the centre distance is
    // `CLUMP_FIT` of the two radii summed, so it overlaps the body's own
    // bounding sphere but its centre stays outside it.
    expect(o.x).toBeGreaterThan(0);
    expect(o.x).toBeLessThan(base.selfR);
  });

  it('uses the heading when the hit is exactly at the centre', () => {
    const o = clumpLocalOffset({ ...base, itemX: 0, itemY: 0, itemZ: 0 });
    const reach = (base.selfR + base.itemR) * CLUMP_FIT;
    expect(o.x).toBeCloseTo(0, 12);
    expect(o.z).toBeCloseTo(reach, 12);
  });

  it('round-trips out of the clump frame onto the world point it came from', () => {
    const clumpWorldQ = axisAngle({ x: 0.5773502692, y: 0.5773502692, z: 0.5773502692 }, 1.1);
    const g = 1.8;
    const item = { itemX: 4, itemY: 3, itemZ: -6 };
    const centre = { centreX: 1, centreY: 2, centreZ: -1 };
    const o = clumpLocalOffset({ ...base, ...centre, ...item, clumpWorldQ, growth: g });
    // Undo the two transforms the function applied.
    const world = rotate(clumpWorldQ, { x: o.x * g, y: o.y * g, z: o.z * g });
    const dx = item.itemX - centre.centreX;
    const dy = item.itemY - centre.centreY;
    const dz = item.itemZ - centre.centreZ;
    const len = Math.hypot(dx, dy, dz);
    const reach = (base.selfR + base.itemR) * CLUMP_FIT;
    // Same direction as the hit, at exactly the seated distance.
    expect(world.x).toBeCloseTo((dx / len) * reach, 10);
    expect(world.y).toBeCloseTo((dy / len) * reach, 10);
    expect(world.z).toBeCloseTo((dz / len) * reach, 10);
  });

  it('never returns a non-finite number, whatever it is handed', () => {
    const o = clumpLocalOffset({
      ...base,
      itemX: 0,
      itemY: 0,
      itemZ: 0,
      headingX: 0,
      headingZ: 0,
      growth: 0,
    });
    expect(Number.isFinite(o.x + o.y + o.z)).toBe(true);
  });
});

describe('clumpLocalRotation', () => {
  it('is the item rotation expressed in the clump frame', () => {
    const clump = axisAngle({ x: 0, y: 1, z: 0 }, 0.7);
    const item = axisAngle({ x: 1, y: 0, z: 0 }, 0.3);
    const local = clumpLocalRotation(item, clump);
    // clump × local must be the item's world rotation again.
    const back = multiply(clump, local);
    expect(back.x).toBeCloseTo(item.x, 10);
    expect(back.y).toBeCloseTo(item.y, 10);
    expect(back.z).toBeCloseTo(item.z, 10);
    expect(back.w).toBeCloseTo(item.w, 10);
  });

  it('is the item rotation itself when the pile has not rolled', () => {
    const item = axisAngle({ x: 0, y: 0, z: 1 }, 0.42);
    const local = clumpLocalRotation(item, { x: 0, y: 0, z: 0, w: 1 });
    expect(local.x).toBeCloseTo(item.x, 12);
    expect(local.w).toBeCloseTo(item.w, 12);
  });
});

describe('clearanceLift — the ball rides on its whole footprint', () => {
  /**
   * > User report, 2026-09-16: *"the ball is glitching through the map floor
   * > if it's big enough."*
   *
   * The pure half: a centre height, a ring of samples at
   * `bodyR × CLEARANCE_RING`, and the lift that keeps the ball's underside
   * above the highest of them. The manager eases a ζ ≥ 1 spring onto the
   * answer and writes it through the one ground pass; nothing in here knows
   * about a spring, a root or a frame.
   */
  const pad = (bodyR: number): number => bodyR * CLEARANCE_PAD;

  it('is the pad alone on flat ground — nothing is lifted for nothing', () => {
    expect(clearanceLift(0, 0, 3, () => 4.2)).toBeCloseTo(pad(3), 12);
  });

  it('rides up on the uphill side of a slope, by the ring’s own rise', () => {
    const slope = 0.5;
    const bodyR = 3;
    const lift = clearanceLift(0, 0, bodyR, (x) => x * slope);
    // The highest ring sample is the one straight uphill, at
    // `bodyR × CLEARANCE_RING` out.
    expect(lift).toBeCloseTo(bodyR * CLEARANCE_RING * slope + pad(bodyR), 12);
  });

  it('clears a step that only the ring can see', () => {
    const bodyR = 3;
    const inside = bodyR * CLEARANCE_RING * 0.5;
    // A 1.6 u riser inside the footprint but well away from the centre: the
    // centre sample knows nothing about it, which is the whole bug.
    const lift = clearanceLift(0, 0, bodyR, (x) => (x > inside ? 1.6 : 0));
    expect(lift).toBeCloseTo(1.6 + pad(bodyR), 12);
  });

  it('never pushes a creature DOWN into the ground', () => {
    // A hollow: every ring sample is below the centre. The answer is the pad
    // and never a negative number — this is a clearance, not a second
    // opinion about where the ground is.
    const lift = clearanceLift(0, 0, 3, (x, z) => (Math.hypot(x, z) > 0.001 ? -9 : 0));
    expect(lift).toBeCloseTo(pad(3), 12);
    expect(lift).toBeGreaterThan(0);
  });

  it('is zero for a creature with no size at all', () => {
    expect(clearanceLift(0, 0, 0, () => 1)).toBe(0);
    expect(clearanceLift(0, 0, -1, () => 1)).toBe(0);
  });

  it('samples the centre and the ring, and nothing else', () => {
    const seen: { x: number; z: number }[] = [];
    const bodyR = 2;
    clearanceLift(5, -7, bodyR, (x, z) => {
      seen.push({ x, z });
      return 0;
    });
    expect(seen.length).toBe(1 + CLEARANCE_POINTS);
    expect(seen[0]).toEqual({ x: 5, z: -7 });
    for (const point of seen.slice(1)) {
      expect(Math.hypot(point.x - 5, point.z + 7)).toBeCloseTo(bodyR * CLEARANCE_RING, 12);
    }
  });

  it('is deterministic — the same terrain gives every page the same number', () => {
    const terrain = (x: number, z: number): number => Math.sin(x * 0.3) + Math.cos(z * 0.2);
    const first = clearanceLift(3, 4, 2.5, terrain);
    const second = clearanceLift(3, 4, 2.5, terrain);
    expect(second).toBe(first);
  });
});

describe('packSeatDirection — the mass fills in rather than spiking out', () => {
  /**
   * > User, 2026-09-18, with the Katamari Damacy reference: *"We should see a
   * > mass of objects together not an invisible sphere."*
   *
   * A purely radial pack seats every item along the direction it was struck
   * from, so a creature that walks a line grows a spike down that line. The
   * fan tries a bounded set of directions around the contact and keeps the
   * TIGHTEST seat, so each item tucks into the emptiest hollow it can reach.
   */
  const selfR = 1.2;

  /** Walk a creature in one direction and hand back the pile it builds. */
  function walkLine(fan: boolean): { x: number; y: number; z: number; r: number }[] {
    const seats: { x: number; y: number; z: number; r: number }[] = [];
    for (let n = 0; n < 24; n++) {
      const itemR = 0.35 + (n % 5) * 0.05;
      const d = { x: 0.12 * ((n % 3) - 1), y: 0.05 * (n % 2), z: 1 };
      const l = Math.hypot(d.x, d.y, d.z);
      const dir = { x: d.x / l, y: d.y / l, z: d.z / l };
      const p = fan
        ? packSeatDirection({ dirX: dir.x, dirY: dir.y, dirZ: dir.z, itemR, selfR, seats })
        : {
            dirX: dir.x,
            dirY: dir.y,
            dirZ: dir.z,
            reach: packSeatDistance({
              dirX: dir.x,
              dirY: dir.y,
              dirZ: dir.z,
              itemR,
              selfR,
              seats,
            }),
          };
      seats.push({ x: p.dirX * p.reach, y: p.dirY * p.reach, z: p.dirZ * p.reach, r: itemR });
    }
    return seats;
  }

  const outerOf = (seats: readonly { x: number; y: number; z: number; r: number }[]): number =>
    seats.reduce((m, s) => Math.max(m, Math.hypot(s.x, s.y, s.z) + s.r), 0);

  it('keeps the struck direction when the pile is empty — the fan only ever tightens', () => {
    const p = packSeatDirection({ dirX: 0, dirY: 0, dirZ: 1, itemR: 0.5, selfR, seats: [] });
    expect(p.dirZ).toBeCloseTo(1, 12);
    expect(p.reach).toBeCloseTo((selfR + 0.5) * CLUMP_FIT, 12);
  });

  it('is never looser than the radial seat it starts from', () => {
    const seats = walkLine(true);
    for (const dir of [
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 0 },
      { x: 0.6, y: 0.5, z: -0.6 },
    ]) {
      const l = Math.hypot(dir.x, dir.y, dir.z);
      const d = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
      const radial = packSeatDistance({
        dirX: d.x,
        dirY: d.y,
        dirZ: d.z,
        itemR: 0.4,
        selfR,
        seats,
      });
      const fan = packSeatDirection({ dirX: d.x, dirY: d.y, dirZ: d.z, itemR: 0.4, selfR, seats });
      // Priced by PACK_DRIFT_COST, so the WINNER's score is what is bounded;
      // its reach is the thing that must not be worse.
      expect(fan.reach).toBeLessThanOrEqual(radial + 1e-9);
    }
  });

  it('turns a line-walked spike into a lump — half the outer radius, and rounder', () => {
    const radial = walkLine(false);
    const fan = walkLine(true);
    // Measured 2026-09-18: outer 7.75 -> 2.84 world units over 24 props.
    expect(outerOf(fan)).toBeLessThan(outerOf(radial) * 0.5);
    const extent = (
      seats: readonly { x: number; y: number; z: number; r: number }[],
      k: 'x' | 'y' | 'z',
    ): number =>
      Math.max(...seats.map((s) => s[k] + s.r)) - Math.min(...seats.map((s) => s[k] - s.r));
    // The walk was along +z. Radially the pile is 2.5x longer that way than
    // wide; packed, it is no longer than it is wide.
    expect(extent(radial, 'z') / extent(radial, 'x')).toBeGreaterThan(2);
    expect(extent(fan, 'z') / extent(fan, 'x')).toBeLessThan(1.2);
  });

  it('packs above AND below, and never straight up or down', () => {
    /*
     * BELOW is allowed since 2026-09-18 (*"All the objects should be cluster
     * into one ball like the real katamari"*) — with nothing under the
     * equator a grown pile spread into a pancake of props lying on the grass.
     * What the band still forbids is a column: a seat exactly on the axis has
     * no side to it and every item taking it would stack in one line.
     */
    let below = 0;
    for (const dirY of [-0.9, -0.3, 0, 0.3, 0.95]) {
      const hl = Math.sqrt(Math.max(0, 1 - dirY * dirY));
      for (const c of packCandidateDirections(hl, dirY, 0)) {
        const elevation = Math.atan2(c.y, Math.hypot(c.x, c.z));
        expect(Math.abs(elevation)).toBeLessThanOrEqual(PACK_ELEVATION_MAX + 1e-9);
        if (c.y < 0) below++;
      }
    }
    expect(below).toBeGreaterThan(0);
  });

  it('is deterministic — the same pile and hit give the same seat every time', () => {
    const seats = walkLine(true);
    const once = packSeatDirection({ dirX: 0, dirY: 0, dirZ: 1, itemR: 0.4, selfR, seats });
    const twice = packSeatDirection({ dirX: 0, dirY: 0, dirZ: 1, itemR: 0.4, selfR, seats });
    expect(twice).toEqual(once);
  });
});
