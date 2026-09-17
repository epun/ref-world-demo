/**
 * THE PHONE'S CAMERA, WHEN ITS OWN SHELL OPENS — AND AS THE BALL GROWS.
 *
 * > User ask, 2026-09-17: *"on hatch for mobile we should have the cam zoom in
 * > to people's character."*
 *
 * > Same day: *"we should allow for larger mass sizes than 10 meters for
 * > users."* A 20 m ball framed at the hatch zoom is a wall rather than a
 * > ball, so the follow zoom has to widen with the thing it is following.
 *
 * Three things are pinned here and they are the three that are easy to get
 * wrong:
 *
 *   1. WHOSE hatch moves the camera (`shouldCloseOnHatch`). A room is
 *      sixty-eight shells opening; sixty-seven of them are not an invitation
 *      to move this person's frame, and no world but the katamari one does any
 *      of this at all.
 *   2. that the close-in is a RETARGET and not a cut — the rig arrives over
 *      `MOTION.secondaryMs` on its own ζ≥1 spring, and a pinch afterwards
 *      still wins (TASTE §2.1, confidence 1.00).
 *   3. that `followZoomFor` keeps a ball the same share of the screen at 10 m,
 *      20 m and 40 m, and never closes in TIGHTER than the hatch framing.
 *
 * No WebGL: an OrthographicCamera is plain maths, and the follow rule has no
 * scene in it by design.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  BALL_ZOOM_REF_R,
  CameraRig,
  FRUSTUM_HEIGHT,
  HATCH_CLOSE_ZOOM,
  followZoomFor,
  zoomMinFor,
} from '../../src/world/camera';
import { shouldCloseOnHatch } from '../../src/world/follow';
import { setIslandMode } from '../../src/world/landscape';
import { WORLD_SCALE } from '../../src/world/katamari/rules';

// Everything below is the katamari world's camera, and the island is that
// world's map — the zoom FLOOR comes off the coast.
beforeAll(() => setIslandMode(true));
afterAll(() => setIslandMode(false));

/** A ball of this diameter in METRES, as the ball-size readout means it. */
const radiusForMetres = (m: number): number => (m * WORLD_SCALE) / 2;

describe('whose hatch closes the camera in', () => {
  const mine = 'me';
  it('is mine, on a katamari handset with a creature', () => {
    expect(
      shouldCloseOnHatch({ game: 'katamari', hatched: mine, mine, canFollow: true }),
    ).toBe(true);
  });

  it('is not somebody else’s', () => {
    expect(
      shouldCloseOnHatch({ game: 'katamari', hatched: 'stranger', mine, canFollow: true }),
    ).toBe(false);
  });

  it('is nobody’s on another world — the public page is unchanged', () => {
    for (const game of ['none', '', 'meridian']) {
      expect(shouldCloseOnHatch({ game, hatched: mine, mine, canFollow: true })).toBe(false);
    }
  });

  it('is nobody’s on a page that cannot follow — the projection', () => {
    expect(
      shouldCloseOnHatch({ game: 'katamari', hatched: mine, mine, canFollow: false }),
    ).toBe(false);
  });

  it('never fires for a page with no creature, however the ids compare', () => {
    // The trap: two empty strings are equal, and a projection's `myDrawerId`
    // is the empty string. Without the length check the first hatch in the
    // room would move a wall's camera.
    expect(shouldCloseOnHatch({ game: 'katamari', hatched: '', mine: '', canFollow: true })).toBe(
      false,
    );
  });
});

describe('CameraRig.closeOn', () => {
  it('raises the target zoom to the close level and looks at the creature', () => {
    const rig = new CameraRig(390 / 844);
    expect(rig.zoomAim()).toBe(1);
    rig.closeOn(new Vector3(12, 0, -8));
    expect(rig.zoomAim()).toBe(HATCH_CLOSE_ZOOM);
    // It SLIDES there: one frame in, the zoom has moved and has not arrived.
    rig.update(16, 16);
    expect(rig.camera.zoom).toBeGreaterThan(1);
    expect(rig.camera.zoom).toBeLessThan(HATCH_CLOSE_ZOOM);
    for (let i = 0; i < 400; i++) rig.update(16, 32 + i * 16);
    expect(rig.camera.zoom).toBeCloseTo(HATCH_CLOSE_ZOOM, 3);
    const look = rig.lookAtPoint();
    // Within the ambient drift floor, which runs on the look-target forever
    // and is the settle this taste asks for rather than a stop (TASTE §2.1).
    expect(Math.abs(look.x - 12)).toBeLessThan(0.2);
    expect(Math.abs(look.z + 8)).toBeLessThan(0.2);
  });

  it('never cuts: the zoom is monotone and never overshoots', () => {
    const rig = new CameraRig(390 / 844);
    rig.closeOn(new Vector3(0, 0, 0));
    let last = rig.camera.zoom;
    for (let i = 0; i < 400; i++) {
      rig.update(16, i * 16);
      expect(rig.camera.zoom).toBeGreaterThanOrEqual(last - 1e-9);
      expect(rig.camera.zoom).toBeLessThanOrEqual(HATCH_CLOSE_ZOOM + 1e-9);
      last = rig.camera.zoom;
    }
  });

  it('leaves the pinch in charge afterwards', () => {
    const rig = new CameraRig(390 / 844);
    rig.closeOn(new Vector3(0, 0, 0));
    for (let i = 0; i < 400; i++) rig.update(16, i * 16);
    // Two fingers, opening: direct and 1:1 while they move.
    rig.zoomDirect(0.5);
    rig.update(16, 6400);
    expect(rig.camera.zoom).toBeLessThan(HATCH_CLOSE_ZOOM);
    expect(rig.zoomAim()).toBeLessThan(HATCH_CLOSE_ZOOM);
  });

  it('leaves the orbit alone — the angle is still the person’s', () => {
    const rig = new CameraRig(390 / 844);
    const az = rig.azimuth;
    const el = rig.elevation;
    rig.closeOn(new Vector3(5, 0, 5));
    for (let i = 0; i < 60; i++) rig.update(16, i * 16);
    expect(rig.azimuth).toBeCloseTo(az, 6);
    expect(rig.elevation).toBeCloseTo(el, 6);
  });
});

describe('followZoomFor — a ball stays a ball on screen', () => {
  it('is exactly the hatch framing for anything up to the reference radius', () => {
    expect(followZoomFor(0)).toBe(HATCH_CLOSE_ZOOM);
    expect(followZoomFor(0.45)).toBe(HATCH_CLOSE_ZOOM);
    expect(followZoomFor(BALL_ZOOM_REF_R)).toBe(HATCH_CLOSE_ZOOM);
  });

  it('never closes in tighter than the hatch framing', () => {
    for (let r = 0.05; r < 60; r *= 1.3) {
      expect(followZoomFor(r)).toBeLessThanOrEqual(HATCH_CLOSE_ZOOM);
    }
  });

  it('widens in proportion, so the ball’s share of the frame is constant', () => {
    // The frame's world height is FRUSTUM_HEIGHT / zoom, so "share of the
    // frame" is diameter / height. Past the reference radius it is fixed.
    const share = (r: number): number => (2 * r) / (FRUSTUM_HEIGHT / followZoomFor(r));
    const at = share(BALL_ZOOM_REF_R);
    for (const r of [2, 4, 8, 16, 32]) expect(share(r)).toBeCloseTo(at, 6);
  });

  it('frames a 10 m, a 20 m and a 40 m ball', () => {
    const ten = followZoomFor(radiusForMetres(10));
    const twenty = followZoomFor(radiusForMetres(20));
    const forty = followZoomFor(radiusForMetres(40));
    // Each doubling of the ball halves the zoom — the frame doubles with it.
    expect(twenty).toBeCloseTo(ten / 2, 6);
    expect(forty).toBeCloseTo(ten / 4, 6);
    // And a 20 m ball is a ball: it takes a readable slice of the frame
    // rather than filling it. A 20 m diameter is 18.8 world units, and at
    // this zoom the frame is more than one and a half of them tall.
    const frame = FRUSTUM_HEIGHT / twenty;
    expect(frame).toBeGreaterThan(2 * radiusForMetres(20) * 1.5);
  });

  it('is clamped at the island floor by the rig, not by the arithmetic', () => {
    // A ball the size of the island asks for a zoom below anything the rig
    // allows; the rig hands back the floor, which is the whole island on
    // screen and no wider.
    const aspect = 390 / 844;
    const rig = new CameraRig(aspect);
    rig.zoomTo(followZoomFor(300));
    for (let i = 0; i < 600; i++) rig.update(16, i * 16);
    expect(rig.camera.zoom).toBeCloseTo(zoomMinFor(aspect), 4);
  });
});
