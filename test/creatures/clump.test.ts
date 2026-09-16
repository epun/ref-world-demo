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
