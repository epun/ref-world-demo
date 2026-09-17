/**
 * The pile (src/creatures/clump.ts): what is stuck to a ball keeps its own
 * size.
 *
 * User report, 2026-09-16: "some items get larger after you pick them up in
 * your ball." The clump hangs on the creature root and the root's uniform
 * scale IS the growth, so an object seated at its prop scale was drawn
 * `growth` times too big. These pin the world scale of a stuck thing to the
 * size it had on the ground, at the seat and on every frame after, while
 * the ball itself goes on growing.
 */
import { describe, expect, it } from 'vitest';
import { Group, Object3D, Vector3 } from 'three';
import { createClump } from '../../src/creatures/clump';
import {
  CLUMP_FIT,
  clumpLocalOffset,
  growth as growthOf,
} from '../../src/creatures/sticky';

const identityQ = { x: 0, y: 0, z: 0, w: 1 };

/** A root scaled like the manager's `growPass` scales it, with the clump on it. */
function ballOn(baseR: number) {
  const root = new Group();
  const clump = createClump(baseR);
  root.add(clump.group);
  const grow = (): void => {
    root.scale.setScalar(clump.growth());
  };
  return { root, clump, grow };
}

function worldScale(object: Object3D): number {
  object.updateWorldMatrix(true, false);
  return object.getWorldScale(new Vector3()).x;
}

describe('a stuck thing keeps its own size', () => {
  it('seats a prop at its ground scale even when the ball is already grown', () => {
    const { clump, grow } = ballOn(0.9);
    const first = new Object3D();
    clump.add({ key: 'a', object: first, r: 0.8, scale: 1.3, offset: { x: 1, y: 0, z: 0 }, rotation: identityQ });
    grow();
    expect(clump.growth()).toBeGreaterThan(1);
    expect(worldScale(first)).toBeCloseTo(1.3, 6);

    // The second arrives on a ball that is bigger than it was: still 1.3.
    const second = new Object3D();
    clump.add({ key: 'b', object: second, r: 0.8, scale: 0.7, offset: { x: -1, y: 0, z: 0 }, rotation: identityQ });
    grow();
    expect(worldScale(second)).toBeCloseTo(0.7, 6);
    // …and the first did not swell with the pickup.
    clump.update(16);
    expect(worldScale(first)).toBeCloseTo(1.3, 6);
  });

  it('holds that size on every frame as the ball grows further', () => {
    const { clump, grow } = ballOn(0.9);
    const stone = new Object3D();
    clump.add({ key: 'a', object: stone, r: 0.6, scale: 1, offset: { x: 1, y: 0, z: 0 }, rotation: identityQ });
    const before = clump.growth();
    for (let i = 0; i < 12; i++) {
      clump.add({ key: `k${i}`, object: new Object3D(), r: 0.8, scale: 1, offset: { x: 0, y: 1, z: 0 }, rotation: identityQ });
      clump.update(16);
      grow();
      expect(worldScale(stone)).toBeCloseTo(1, 6);
    }
    expect(clump.growth()).toBeGreaterThan(before * 1.5);
  });

  it('a passenger rides at its own live growth, not its carrier’s', () => {
    const { clump, grow } = ballOn(0.9);
    let riderGrowth = 1.2;
    const rider = new Object3D();
    clump.add({
      key: 'rider',
      object: rider,
      r: 0.9,
      worldScale: () => riderGrowth,
      offset: { x: 0, y: 1, z: 0 },
      rotation: identityQ,
    });
    clump.add({ key: 'a', object: new Object3D(), r: 0.9, scale: 1, offset: { x: 1, y: 0, z: 0 }, rotation: identityQ });
    clump.update(16);
    grow();
    expect(worldScale(rider)).toBeCloseTo(1.2, 6);
    riderGrowth = 1.4;
    clump.update(16);
    expect(worldScale(rider)).toBeCloseTo(1.4, 6);
  });

  it('a prop with no scale of its own is drawn at one', () => {
    const { clump, grow } = ballOn(0.9);
    const thing = new Object3D();
    clump.add({ key: 'a', object: thing, r: 0.8, offset: { x: 1, y: 0, z: 0 }, rotation: identityQ });
    grow();
    expect(worldScale(thing)).toBeCloseTo(1, 6);
  });
});

/**
 * WHERE THE ITEMS SIT — the packing, which is the whole of what the pile is.
 *
 * > User direction, 2026-09-17: *"the character should be the object that the
 * > items stick to."*
 *
 * There is no shell and no sphere: the first thing sticks to the CHARACTER at
 * its own drawn radius, and everything after it packs against the character
 * and against what is already there (`packSeatDistance`, src/creatures/sticky.ts).
 * These pin the three properties that make that read as one lump:
 *
 *   nothing is INSIDE the character, nothing FLOATS (every seat touches the
 *   character or another seat), and the packing HOLDS as the growth rises —
 *   the seats are world units, so a pile does not loosen as its carrier's
 *   root is scaled up.
 */
describe('the items pack against the creature', () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };

  /** One pickup, the way the manager's own pass computes it: the seat from
   * the contact direction and the seats already taken, then seated. */
  function stick(
    clump: ReturnType<typeof createClump>,
    baseR: number,
    key: string,
    dir: { x: number; y: number; z: number },
    itemR: number,
  ): Object3D {
    const object = new Object3D();
    const offset = clumpLocalOffset({
      itemX: dir.x * 50,
      itemY: dir.y * 50,
      itemZ: dir.z * 50,
      centreX: 0,
      centreY: 0,
      centreZ: 0,
      headingX: 0,
      headingZ: 1,
      selfR: baseR,
      itemR,
      seats: clump.seats(),
      clumpWorldQ: identity,
      growth: clump.growth(),
    });
    clump.add({ key, object, r: itemR, scale: 1, offset, rotation: identity });
    return object;
  }

  /** Every seat's world distance from the pile's centre. */
  const radii = (clump: ReturnType<typeof createClump>): number[] =>
    clump.seats().map((seat) => Math.hypot(seat.x, seat.y, seat.z));

  it('puts the first item on the character’s own surface', () => {
    const baseR = 0.9;
    const itemR = 0.6;
    const { clump } = ballOn(baseR);
    stick(clump, baseR, 'a', { x: 1, y: 0, z: 0 }, itemR);
    // Bedded in by CLUMP_FIT — touching the creature, not perched on it.
    expect(radii(clump)[0]).toBeCloseTo(baseR + itemR * CLUMP_FIT, 9);
  });

  it('packs the next one outward when it lands on the same side', () => {
    const baseR = 0.9;
    const itemR = 0.6;
    const { clump } = ballOn(baseR);
    stick(clump, baseR, 'a', { x: 1, y: 0, z: 0 }, itemR);
    stick(clump, baseR, 'b', { x: 1, y: 0, z: 0 }, itemR);
    const [first, second] = radii(clump);
    // The second is further out by two radii, less the bedding.
    expect(second!).toBeCloseTo(first! + 2 * itemR * CLUMP_FIT, 9);
  });

  it('leaves the other side alone — a pile is not a sphere', () => {
    const baseR = 0.9;
    const itemR = 0.6;
    const { clump } = ballOn(baseR);
    for (let i = 0; i < 4; i++) stick(clump, baseR, `a${i}`, { x: 1, y: 0, z: 0 }, itemR);
    const behind = stick(clump, baseR, 'behind', { x: -1, y: 0, z: 0 }, itemR);
    const seat = clump.seatOf('behind')!;
    // Four things stacked on the +x side do not push the -x side out at all:
    // this thing is on the creature, where it was struck.
    expect(Math.hypot(seat.x, seat.y, seat.z)).toBeCloseTo(baseR + itemR * CLUMP_FIT, 9);
    expect(behind.position.length()).toBeGreaterThan(0);
  });

  it('never puts anything inside the creature, and never leaves one floating', () => {
    const baseR = 0.88;
    const { clump } = ballOn(baseR);
    // Fifteen things of mixed sizes from all over, the fibonacci spread the
    // headless shot uses — which is the case a real session produces.
    const sizes = [1.161, 0.937, 0.703, 2.869, 1.548];
    const GOLD = Math.PI * (3 - Math.sqrt(5));
    const placed: { x: number; y: number; z: number; r: number }[] = [];
    for (let i = 0; i < 15; i++) {
      const itemR = sizes[i % sizes.length]!;
      const y = 1 - (i / 14) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = GOLD * i;
      stick(
        clump,
        baseR,
        `k${i}`,
        { x: Math.cos(th) * rad, y, z: Math.sin(th) * rad },
        itemR,
      );
      const seat = clump.seatOf(`k${i}`)!;
      placed.push({ ...seat, r: itemR });
    }

    for (const [i, seat] of placed.entries()) {
      const d = Math.hypot(seat.x, seat.y, seat.z);
      // NOT INSIDE: the creature's surface is at `baseR`, and an item may be
      // bedded into it by `CLUMP_FIT` of its own radius and no more.
      expect(d).toBeGreaterThanOrEqual(baseR + seat.r * CLUMP_FIT - 1e-9);
      // NOT FLOATING: it touches the creature, or it touches something that
      // is already seated — within the same bedding tolerance.
      const onCreature = d <= baseR + seat.r + 1e-9;
      const onNeighbour = placed.some((other, j) => {
        if (i === j) return false;
        const gap = Math.hypot(seat.x - other.x, seat.y - other.y, seat.z - other.z);
        return gap <= seat.r + other.r + 1e-9;
      });
      expect(onCreature || onNeighbour, `item ${i} at ${d.toFixed(3)}`).toBe(true);
    }
  });

  it('holds the packing as the pile grows — no loosening', () => {
    const baseR = 0.9;
    const itemR = 1.4;
    const { root, clump, grow } = ballOn(baseR);
    const first = stick(clump, baseR, 'a', { x: 1, y: 0, z: 0 }, itemR);
    grow();
    for (let f = 0; f < 400; f++) clump.update(33);
    root.updateWorldMatrix(true, true);
    const before = first
      .getWorldPosition(new Vector3())
      .distanceTo(clump.group.getWorldPosition(new Vector3()));
    expect(before).toBeCloseTo(baseR + itemR * CLUMP_FIT, 6);

    // Five more things elsewhere on the creature: the growth rises a long way
    // and the FIRST one must not drift outward with it, or the pile would
    // loosen into a cloud as its carrier's root was scaled up (which is what
    // the clump-local frame does if the seat is held in it).
    for (let i = 0; i < 5; i++) {
      const th = (i / 5) * Math.PI * 2;
      stick(clump, baseR, `b${i}`, { x: Math.cos(th), y: 0.2, z: Math.sin(th) }, itemR);
    }
    grow();
    expect(clump.growth()).toBeGreaterThan(2);
    for (let f = 0; f < 400; f++) clump.update(33);
    root.updateWorldMatrix(true, true);
    const after = first
      .getWorldPosition(new Vector3())
      .distanceTo(clump.group.getWorldPosition(new Vector3()));
    expect(after).toBeCloseTo(before, 6);
    // …and it is still drawn at its own size while it sits there.
    expect(worldScale(first)).toBeCloseTo(1, 6);
  });
});
