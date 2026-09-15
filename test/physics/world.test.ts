/**
 * The rigid-body world (src/physics/world.ts) — no Three.js, no DOM. The
 * compat build of rapier inlines its wasm as base64, so the real solver runs
 * here under node.
 *
 * The first block is the one that matters: rapier's heightfield is an
 * nalgebra `DMatrix`, which is COLUMN-major and maps matrix rows to local Z
 * and columns to local X. That convention is not documented anywhere we can
 * cite, so it is pinned EMPIRICALLY, exactly as envpaint pins it: raise the
 * +X half of the field, drop a ball on each side, and assert which one rests
 * higher. Get `buildHeightfieldHeights` transposed and this fails.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildHeightfieldHeights,
  createPhysicsWorld,
  FIXED_STEP_S,
  HEIGHTFIELD_SEGMENTS,
  MAX_SUBSTEPS,
  TERRAIN_REBUILD_MIN_MS,
} from '../../src/physics/world';
import { MOTION } from '../../src/taste/tokens';
import type { Surface } from '../../src/world/surface';

/** The test field: 200 units a side, so a 256-cell heightfield is fine. */
const FIELD = 200;
const STEP_HEIGHT = 5;
const BALL_RADIUS = 0.5;

/** A surface raised on the +X half and flat on the -X half. */
const stepSurface: Surface = {
  sampleHeight: (x) => (x > 0 ? STEP_HEIGHT : 0),
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
};

const flatSurface: Surface = {
  sampleHeight: () => 0,
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
};

describe('buildHeightfieldHeights', () => {
  it('lays (segments + 1)^2 samples out column-major, x on the columns', () => {
    const segments = 4;
    const heights = buildHeightfieldHeights((u, v) => u * 10 + v, segments);
    const n = segments + 1;
    expect(heights.length).toBe(n * n);
    // heights[ix * n + iz] — the column-major convention itself.
    for (let ix = 0; ix < n; ix++) {
      for (let iz = 0; iz < n; iz++) {
        expect(heights[ix * n + iz]).toBeCloseTo((ix / segments) * 10 + iz / segments, 6);
      }
    }
  });

  it('defaults to the shipped segment count', () => {
    const heights = buildHeightfieldHeights(() => 0);
    expect(heights.length).toBe((HEIGHTFIELD_SEGMENTS + 1) ** 2);
  });
});

describe('physics world terrain collider', () => {
  let world: Awaited<ReturnType<typeof createPhysicsWorld>>;

  beforeAll(async () => {
    world = await createPhysicsWorld(stepSurface, FIELD);
  });

  it('samples the Surface so the +X half of the field is the raised one', () => {
    const rapier = world.rapier;
    const drop = (x: number, z: number) => {
      const body = world.addRigidBody(
        rapier.RigidBodyDesc.dynamic().setTranslation(x, STEP_HEIGHT + 6, z),
        rapier.ColliderDesc.ball(BALL_RADIUS).setRestitution(0),
      );
      return body;
    };
    const high = drop(50, 0);
    const low = drop(-50, 0);

    // 600 fixed steps — well past a settle from 6 units up.
    for (let i = 0; i < 300; i++) world.step(1000 / 30);

    const dy = high.translation().y - low.translation().y;
    expect(dy).toBeGreaterThan(STEP_HEIGHT - 1);
    expect(dy).toBeLessThan(STEP_HEIGHT + 1);
    expect(low.translation().y).toBeCloseTo(BALL_RADIUS, 0);
    expect(high.translation().y).toBeCloseTo(STEP_HEIGHT + BALL_RADIUS, 0);

    world.remove(high);
    world.remove(low);
  });

  it('spans Z independently of X', () => {
    const rapier = world.rapier;
    const drop = (x: number, z: number) =>
      world.addRigidBody(
        rapier.RigidBodyDesc.dynamic().setTranslation(x, STEP_HEIGHT + 4, z),
        rapier.ColliderDesc.ball(BALL_RADIUS).setRestitution(0),
      );
    // Same (raised) X half, opposite corners in Z.
    const a = drop(40, 70);
    const b = drop(40, -70);
    for (let i = 0; i < 300; i++) world.step(1000 / 30);
    expect(a.translation().y).toBeCloseTo(STEP_HEIGHT + BALL_RADIUS, 0);
    expect(b.translation().y).toBeCloseTo(STEP_HEIGHT + BALL_RADIUS, 0);
    world.remove(a);
    world.remove(b);
  });
});

describe('fixed-step accumulator', () => {
  it('runs at most MAX_SUBSTEPS fixed steps per call', async () => {
    const physics = await createPhysicsWorld(flatSurface, FIELD);
    const rapier = physics.rapier;
    // A body in free fall, far above the ground: its fall is a clean measure
    // of how much simulated time actually ran.
    const body = physics.addRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0, 500, 0).setLinearDamping(0),
      rapier.ColliderDesc.ball(BALL_RADIUS),
    );
    // Hand it ten seconds in one frame. The accumulator may only run
    // MAX_SUBSTEPS of them; the rest is DROPPED, never fast-forwarded.
    physics.step(10_000);
    const fallen = 500 - body.translation().y;
    // Free fall over MAX_SUBSTEPS * 1/60 s is millimetres, not metres.
    // (semi-implicit integration overshoots the closed form slightly)
    const ceiling = 1.05 * 0.5 * 9.81 * (MAX_SUBSTEPS * FIXED_STEP_S) ** 2 + 1e-3;
    expect(fallen).toBeGreaterThan(0);
    expect(fallen).toBeLessThanOrEqual(ceiling);
    physics.dispose();
  });

  it('throttles a requested terrain rebuild', async () => {
    // A rebuild is one pass over the whole field, so counting the seam's
    // samples is an exact record of whether one happened.
    let samples = 0;
    const counting: Surface = {
      sampleHeight: () => {
        samples++;
        return 0;
      },
      normalAt: () => ({ x: 0, y: 1, z: 0 }),
    };
    const physics = await createPhysicsWorld(counting, FIELD);
    // The build at construction: the collider is seated on the seam.
    expect(samples).toBe((HEIGHTFIELD_SEGMENTS + 1) ** 2);
    samples = 0;

    // Asked for, then a frame far inside the window: nothing resampled.
    physics.requestTerrainRebuild();
    physics.step(1);
    expect(samples).toBe(0);

    // Past the window it happens, once.
    physics.step(TERRAIN_REBUILD_MIN_MS);
    expect(samples).toBe((HEIGHTFIELD_SEGMENTS + 1) ** 2);
    samples = 0;
    physics.step(TERRAIN_REBUILD_MIN_MS);
    expect(samples).toBe(0);
    physics.dispose();
  });

  it('wakes every body when the terrain is rebuilt under them', async () => {
    const physics = await createPhysicsWorld(flatSurface, FIELD);
    const rapier = physics.rapier;
    const body = physics.addRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0, BALL_RADIUS, 0),
      rapier.ColliderDesc.ball(BALL_RADIUS).setRestitution(0),
    );
    for (let i = 0; i < 400; i++) physics.step(1000 / 60);
    expect(body.isSleeping()).toBe(true);

    // The ground moved: nothing may stay asleep on top of where it used to be.
    physics.rebuildTerrain();
    expect(body.isSleeping()).toBe(false);
    physics.dispose();
  });

  it('throttles on a motion token, not a literal', () => {
    expect(TERRAIN_REBUILD_MIN_MS).toBe(MOTION.tertiaryMs / 2);
  });
});
