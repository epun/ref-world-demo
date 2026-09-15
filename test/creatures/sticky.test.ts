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
  CLUMP_FIT,
  clumpLocalOffset,
  clumpLocalRotation,
  decideContact,
  DROP_MIN_GAP_MS,
  growth,
  impactOf,
  PICKUP_RATIO,
  rollAxis,
  rollDelta,
  shouldDrop,
  STICKY,
  type Quat,
} from '../../src/creatures/sticky';
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

  it('makes the rock the one unrooted kind — it is already a rigid body', () => {
    const unrooted = PROP_KINDS.filter((k) => !STICKY[k].rooted);
    expect(unrooted).toEqual(['rock']);
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

  it('blocks a rooted prop below its break strength and looses it at or above', () => {
    expect(at('tree', STICKY.tree.breakStrength - 0.001, 1, 4)).toBe('block');
    expect(at('tree', STICKY.tree.breakStrength, 1, 4)).toBe('loose');
    expect(at('tree', STICKY.tree.breakStrength + 5, 1, 4)).toBe('loose');
  });

  it('never looses a building however hard it is hit', () => {
    expect(at('building', 1e9, 8, 40)).toBe('block');
    expect(at('mountain', Infinity, 20, 90)).toBe('block');
  });

  it('yields a bush to a walk — that is what a tiny break strength means', () => {
    // A 1u creature at a stroll: impact 0.9 > the bush's 0.6.
    expect(at('bush', impactOf(0.9, 1), 0.8, 1)).toBe('loose');
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
    // A tree at a fixed speed: too small, then big enough. Monotone in
    // carrier radius, because impact is.
    const speed = 2;
    const small = at('tree', impactOf(speed, 1), 1, 1);
    const large = at('tree', impactOf(speed, 6), 1, 6);
    expect(small).toBe('block');
    expect(large).toBe('loose');
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
  const base = {
    centreX: 0,
    centreY: 0,
    centreZ: 0,
    headingX: 0,
    headingZ: 1,
    R: 2,
    itemR: 0.5,
    growth: 1,
    clumpWorldQ: { x: 0, y: 0, z: 0, w: 1 } as Quat,
  };

  it('seats an item on the side it was struck from, at the pile surface', () => {
    const o = clumpLocalOffset({ ...base, itemX: 5, itemY: 0, itemZ: 0 });
    const reach = base.R + base.itemR * CLUMP_FIT;
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

  it('sinks the item into the pile rather than perching it tangent', () => {
    const o = clumpLocalOffset({ ...base, itemX: 5, itemY: 0, itemZ: 0 });
    expect(o.x).toBeLessThan(base.R + base.itemR);
    expect(o.x).toBeGreaterThan(base.R);
  });

  it('uses the heading when the hit is exactly at the centre', () => {
    const o = clumpLocalOffset({ ...base, itemX: 0, itemY: 0, itemZ: 0 });
    const reach = base.R + base.itemR * CLUMP_FIT;
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
    const reach = base.R + base.itemR * CLUMP_FIT;
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
