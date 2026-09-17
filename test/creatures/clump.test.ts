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
 * WHERE THE BALL'S SURFACE IS — the geometry the drawn sphere has to match.
 *
 * > User report, 2026-09-17: *"currently there is a bug where the characters
 * > are floating in space."*
 *
 * The pile is the ball: `clumpLocalOffset` seats every item at
 * `(R + itemR × CLUMP_FIT) / growth` out from the clump's origin, and the
 * root's uniform scale is that growth — so in the WORLD every item sits a
 * radius out from the clump's origin, bedded in by `CLUMP_FIT`. That makes
 * the sphere the mesh has to be exact rather than a matter of taste: centre
 * at the clump's origin, world radius `clump.R()`. `src/creatures/ball.ts`
 * draws radius 1 scaled by `baseR` under a root scaled by the growth, which
 * is the same number; the manager's own pins assert the drawn one.
 */
describe('the ball the items are seated on', () => {
  it('puts every seat a world radius out from the clump’s origin', () => {
    const baseR = 0.9;
    const itemR = 1.4;
    const { root, clump, grow } = ballOn(baseR);
    // Three items, all seated at the growth the pile ENDS at — the same
    // shape of record the manager's `applyStick` path produces.
    const objects = [new Object3D(), new Object3D(), new Object3D()];
    const volumes = objects.map(() => itemR * itemR * itemR);
    const growth = growthOf(baseR, volumes);
    const R = baseR * growth;
    objects.forEach((object, i) => {
      const th = (i / objects.length) * Math.PI * 2;
      const seat = clumpLocalOffset({
        // A contact out on the ball's equator, in world units.
        itemX: Math.cos(th) * (R + itemR),
        itemY: baseR * growth,
        itemZ: Math.sin(th) * (R + itemR),
        centreX: 0,
        centreY: baseR * growth,
        centreZ: 0,
        headingX: 1,
        headingZ: 0,
        R,
        itemR,
        clumpWorldQ: identityQ,
        growth,
      });
      clump.add({
        key: `k${i}`,
        object,
        r: itemR,
        scale: 1,
        offset: seat,
        rotation: identityQ,
      });
    });
    grow();
    expect(clump.R()).toBeCloseTo(R, 9);
    // Settle the entrance slides, then measure in the world.
    for (let f = 0; f < 400; f++) clump.update(33);
    root.updateWorldMatrix(true, true);
    const origin = clump.group.getWorldPosition(new Vector3());
    for (const object of objects) {
      const out = object.getWorldPosition(new Vector3()).distanceTo(origin);
      // ON the surface of a sphere of radius R, sunk in by CLUMP_FIT — which
      // is the sphere src/creatures/ball.ts draws.
      expect(out).toBeCloseTo(R + itemR * CLUMP_FIT, 6);
    }
  });
});
