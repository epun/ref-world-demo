/**
 * The camera rig's DEPTH and its zoom FLOOR — the two numbers that stopped
 * being arbitrary when the map became an island.
 *
 * 2026-09-15, user ask: *"I want the camera to be able to zoom out so that
 * you can see the entire island on pinch."* The floor is therefore derived
 * from the authored coast (src/world/landscape.ts) and the live viewport
 * aspect, not from a literal — a portrait phone is bound by the width of the
 * island, a landscape one by its foreshortened height.
 *
 * Same day, same user: *"the front edge of the map gets obscured and cut off
 * as it's next to the camera and you tilt below the horizon line."* That was
 * the near plane: the eye stood 120 units off the target, so at a low orbit
 * the ground between eye and target fell behind it. Orthographic depth costs
 * nothing, so the eye moved back past the sea disc instead. Both ends of the
 * range are pinned here: nothing drawn can fall in front of `near` or behind
 * `far`, at any orbit the rig allows.
 *
 * No WebGL: an OrthographicCamera is plain maths.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  CAMERA_DISTANCE,
  CAMERA_FAR,
  CAMERA_NEAR,
  CameraRig,
  FRUSTUM_HEIGHT,
  ISLAND_VIEW_MARGIN,
  zoomMinFor,
} from '../../src/world/camera';
import { GROUND_RADIUS } from '../../src/world/ground';
import { coastRadius } from '../../src/world/landscape';

/** The island's widest reach, measured here at twice the rig's own angular
 * resolution — so this is a bound on the rig's number, not a copy of it.
 * `coastRadius` reads `ISLAND_LOBES` directly and so does not ride the
 * landscape mode: the floor is the same in the plain world. */
const COAST_MAX = (() => {
  let max = 0;
  for (let i = 0; i < 720; i++) max = Math.max(max, coastRadius((i / 720) * Math.PI * 2));
  return max;
})();

/** The iso elevation the rig rests at — `atan(1/√2)`; the ground plane's
 * vertical extent on screen is `2R·sin` of it. */
const ISO_SIN = Math.sin(Math.atan(1 / Math.SQRT2));

/** World units of ground visible across and up the frame at a zoom. */
function visibleWidth(aspect: number, zoom: number): number {
  return (FRUSTUM_HEIGHT * aspect) / zoom;
}
function visibleHeight(zoom: number): number {
  return FRUSTUM_HEIGHT / zoom;
}

/** Slack the assertions demand beyond the island itself: 15 units of sea on
 * each side, comfortably inside the rig's own 20-unit margin. Measured on the
 * GROUND, so the foreshortened axis carries `·sin(iso)` of it. */
const SEA_SHOWN = 15;

describe('zoomMinFor', () => {
  it('fits the whole island across a portrait phone, where width binds', () => {
    const aspect = 0.5;
    const zoom = zoomMinFor(aspect);
    expect(visibleWidth(aspect, zoom)).toBeGreaterThanOrEqual(2 * (COAST_MAX + SEA_SHOWN));
    // Width is the narrow axis here, so it is the constraint that set the
    // floor: the frame is taller than the island needs.
    expect(visibleHeight(zoom)).toBeGreaterThan(2 * COAST_MAX * ISO_SIN);
  });

  it('fits the whole island up a landscape phone, foreshortening included', () => {
    const aspect = 1.78;
    const zoom = zoomMinFor(aspect);
    expect(visibleHeight(zoom)).toBeGreaterThanOrEqual(2 * (COAST_MAX + SEA_SHOWN) * ISO_SIN);
    // Height binds at this aspect (1.78 > 1/sin(iso) ≈ 1.73), and the extra
    // width is free.
    expect(visibleWidth(aspect, zoom)).toBeGreaterThan(2 * (COAST_MAX + SEA_SHOWN));
  });

  it('falls as the viewport narrows — the floor is not a constant', () => {
    // Less width per unit of height means the view has to open WIDER to hold
    // the island, so a portrait floor sits below a landscape one.
    expect(zoomMinFor(0.5)).toBeLessThan(zoomMinFor(0.9));
    expect(zoomMinFor(0.5)).toBeLessThan(zoomMinFor(1.78));
  });

  it('is the island plus its margin, on the narrower axis', () => {
    const r = COAST_MAX + ISLAND_VIEW_MARGIN;
    // Portrait: width. Two samples of the closed form, to pin the derivation
    // rather than only its consequences.
    expect(zoomMinFor(0.5)).toBeCloseTo((FRUSTUM_HEIGHT * 0.5) / (2 * r), 3);
    expect(zoomMinFor(1.78)).toBeCloseTo(FRUSTUM_HEIGHT / (2 * r * ISO_SIN), 3);
  });
});

describe('CameraRig zoom floor', () => {
  it('clamps a pinch-out to the floor instead of the old 0.45 literal', () => {
    const rig = new CameraRig(0.5);
    rig.zoomDirect(0.01);
    rig.update(16, 0);
    expect(rig.camera.zoom).toBeCloseTo(zoomMinFor(0.5), 6);
    // And the old literal is now reachable — it used to be the wall.
    expect(zoomMinFor(0.5)).toBeLessThan(0.45);
  });

  it('lets the wheel and the tour down to the same floor', () => {
    const rig = new CameraRig(1.78);
    for (let i = 0; i < 400; i++) rig.zoomBy(0.9);
    rig.zoomTo(0.0001);
    for (let i = 0; i < 400; i++) rig.update(16, i * 16);
    expect(rig.camera.zoom).toBeCloseTo(zoomMinFor(1.78), 4);
  });

  it('raises a parked zoom when a resize raises the floor, by drifting', () => {
    const rig = new CameraRig(0.5);
    rig.zoomDirect(0.0001);
    rig.update(16, 0);
    const wide = rig.camera.zoom;
    expect(wide).toBeCloseTo(zoomMinFor(0.5), 6);
    // Rotate a phone parked at the portrait floor to landscape: the frame
    // loses the height that was holding the island, so the floor RISES.
    rig.resize(1780, 1000);
    const narrow = zoomMinFor(1.78);
    expect(narrow).toBeGreaterThan(wide);
    // One frame in it is already moving and has NOT jumped (no cut).
    rig.update(16, 16);
    expect(rig.camera.zoom).toBeGreaterThan(wide);
    expect(rig.camera.zoom).toBeLessThan(narrow);
    for (let i = 0; i < 400; i++) rig.update(16, 32 + i * 16);
    expect(rig.camera.zoom).toBeCloseTo(narrow, 4);
  });
});

describe('CameraRig depth range', () => {
  it('reaches past the sea disc on both sides of the target', () => {
    const rig = new CameraRig(1.78);
    expect(CAMERA_DISTANCE).toBeGreaterThan(GROUND_RADIUS);
    expect(CAMERA_FAR).toBeGreaterThanOrEqual(CAMERA_DISTANCE + GROUND_RADIUS);
    expect(rig.camera.near).toBe(CAMERA_NEAR);
    expect(rig.camera.far).toBe(CAMERA_FAR);
    // The old range stopped 480 units out and cut the horizon.
    expect(CAMERA_FAR).toBeGreaterThan(480);
  });

  it('keeps the near edge of the sea disc in front of the near plane at the lowest orbit', () => {
    const rig = new CameraRig(1.78);
    // Slam the elevation target below the rig's floor and let the damped
    // follow settle on it — `rig.elevation` then reports the true minimum.
    rig.rotateBy(0, -1e6, 800);
    for (let i = 0; i < 600; i++) rig.update(16, i * 16);
    const lowest = rig.elevation;
    expect(lowest).toBeLessThan(0.35);

    const eye = rig.camera.position;
    const look = rig.lookAtPoint();
    const target = new Vector3(look.x, look.y, look.z);
    const view = target.clone().sub(eye).normalize();
    // The horizontal bearing from the target toward the eye, on the ground.
    const toEye = new Vector3(eye.x - target.x, 0, eye.z - target.z).normalize();
    const nearEdge = new Vector3(toEye.x, 0, toEye.z).multiplyScalar(GROUND_RADIUS);
    const farEdge = nearEdge.clone().multiplyScalar(-1);

    const depthOf = (p: Vector3): number => p.clone().sub(eye).dot(view);
    expect(depthOf(nearEdge)).toBeGreaterThan(rig.camera.near);
    expect(depthOf(farEdge)).toBeLessThan(rig.camera.far);
    // And with the pannable region thrown in on top of the disc.
    const panned = nearEdge.clone().multiplyScalar((GROUND_RADIUS + 200) / GROUND_RADIUS);
    expect(depthOf(panned)).toBeGreaterThan(rig.camera.near);
  });
});
