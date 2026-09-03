/**
 * Eggs and hatches sit on the ground they are given.
 *
 * Neither module knows about terrain and neither should: the placer samples
 * the Surface seam (PLAN §7.2) and hands the answer in — `baseY` for the
 * egg, a `Surface` for the hatch, which needs the live one because the
 * creature is already walking while it rises. Both default to the flat world
 * these modules were written against, which is also the phone's stage.
 *
 * Headless: no renderer, and the shell's canvas paint is a guarded no-op
 * off-DOM (only createElement has to exist).
 */

import { Mesh, Scene } from 'three';
import type { Group } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCharacter } from '../../src/character/character';
import { createEgg, EGG_HEIGHT } from '../../src/egg/egg';
import { startHatch } from '../../src/egg/hatch';
import type { Surface } from '../../src/world/surface';
import { snowman } from '../fixtures/strokes';

beforeAll(() => {
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    };
  }
});

/** A fixed ramp climbing +x, so a height is never accidentally zero. */
const SLOPE = 0.2;
const ramp: Surface = {
  sampleHeight: (x) => x * SLOPE,
  normalAt: () => {
    const len = Math.hypot(SLOPE, 1);
    return { x: -SLOPE / len, y: 1 / len, z: 0 };
  },
};

describe('createEgg baseY — the shell rests on the ground under it', () => {
  it('offsets the whole life of the egg, entrance included', () => {
    const flat = createEgg(snowman, { x: 4, z: -1 });
    const raised = createEgg(snowman, { x: 4, z: -1, baseY: 3.5 });

    // The entrance still slides from above (TASTE §2.1) — from above the
    // GROUND, which is the only thing that changed.
    expect(raised.group.position.y - flat.group.position.y).toBeCloseTo(3.5, 12);
    expect(raised.group.position.y).toBeGreaterThan(3.5);

    // ...and stays exactly one ground apart for every frame after it,
    // through the settle and on into the ambient drift floor.
    for (let f = 0; f < 200; f++) {
      const now = 1000 + f * 16;
      flat.update(16, now);
      raised.update(16, now);
      expect(raised.group.position.y - flat.group.position.y).toBeCloseTo(3.5, 12);
      expect(raised.group.position.x).toBeCloseTo(flat.group.position.x, 12);
    }
    // The slide has landed the shell ON its ground, not near zero.
    expect(raised.group.position.y).toBeCloseTo(3.5, 1);

    flat.dispose();
    raised.dispose();
  });

  it('defaults to the flat world — the phone stage is untouched', () => {
    const egg = createEgg(snowman, { x: 2, z: 2, entrance: false });
    expect(egg.group.position.y).toBe(0);
    expect(egg.hatchPoint().y).toBeCloseTo(EGG_HEIGHT * 0.55, 12);
    egg.dispose();
  });

  it('reports a world-space hatch point, measured from its own ground', () => {
    const egg = createEgg(snowman, { x: 2, z: 2, baseY: 1.75, entrance: false });
    expect(egg.hatchPoint().y).toBeCloseTo(1.75 + EGG_HEIGHT * 0.55, 12);
    egg.dispose();
  });
});

describe('startHatch — the creature rises out of the ground', () => {
  interface Hatched {
    root: Group;
    step(frames: number): void;
    scene: Scene;
  }

  /** Run a hatch to the burst and hand back the character's root. */
  function toBurst(baseY: number, surface?: Surface): Hatched {
    const scene = new Scene();
    const egg = createEgg(snowman, { x: 6, z: 0, baseY, entrance: false });
    scene.add(egg.group);
    const character = createCharacter(snowman, 1, { identity: 'hatchling' });
    expect(character).not.toBeNull();
    let root: Group | null = null;
    const handle = surface
      ? startHatch(
          scene,
          egg,
          character!,
          { onBurst: (r) => (root = r), onDone: () => {} },
          { surface },
        )
      : startHatch(scene, egg, character!, { onBurst: (r) => (root = r), onDone: () => {} });
    let now = 0;
    for (let i = 0; i < 400 && !root; i++) {
      now += 16;
      egg.update(16, now);
      handle.update(16, now);
    }
    expect(root).not.toBeNull();
    return {
      root: root!,
      scene,
      step: (frames: number) => {
        for (let i = 0; i < frames; i++) {
          now += 16;
          handle.update(16, now);
        }
      },
    };
  }

  it("with no Surface, rises to the shell's own resting height", () => {
    // What a flat stage means — and what this module did before terrain.
    const { root, step } = toBurst(2.4);
    expect(root.position.y).toBeCloseTo(2.4 - 0.7, 3);
    step(400);
    // Springs are asymptotic and the exit ends at SETTLE_EPS, so the last
    // hundredth of the rise is never walked — 2cm on a 70cm entrance.
    expect(Math.abs(root.position.y - 2.4)).toBeLessThan(0.02);
  });

  it('with a Surface, rises to the sampled ground under the creature', () => {
    const { root, step } = toBurst(ramp.sampleHeight(6, 0), ramp);
    // Sampled where the root actually is: the shell drifts a little under
    // the ambient floor, and the rise starts wherever it left it.
    const ground = (): number => ramp.sampleHeight(root.position.x, root.position.z);
    expect(root.position.y).toBeCloseTo(ground() - 0.7, 3);
    expect(root.position.y).toBeLessThan(ground());
    step(400);
    expect(Math.abs(root.position.y - ground())).toBeLessThan(0.02);
  });

  it('follows the ground the creature walks onto mid-rise', () => {
    // The burst hands the root to the behavior agent, so it is already
    // moving. A rise pinned to the height it started at would land it off
    // the terrain and correct in one frame when the sequence ended — the
    // hard cut the motion law forbids (TASTE §2.1).
    const { root, step } = toBurst(ramp.sampleHeight(6, 0), ramp);
    step(20);
    root.position.x = -9; // it walked downhill
    step(400);
    expect(Math.abs(root.position.y - ramp.sampleHeight(-9, 0))).toBeLessThan(0.02);
  });

  it('slides the ink ring up from the hatch point, not from y = 0', () => {
    const baseY = 3;
    const { root, scene } = toBurst(baseY);
    expect(root).toBeDefined();
    let ring: Mesh | null = null;
    scene.traverse((node) => {
      if (node instanceof Mesh && node.geometry.type === 'TorusGeometry') ring = node;
    });
    expect(ring).not.toBeNull();
    expect((ring as unknown as Mesh).position.y).toBeCloseTo(baseY + EGG_HEIGHT * 0.55, 6);
  });
});
