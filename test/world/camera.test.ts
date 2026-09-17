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
 * 2026-09-16, a phone on the `valiocon` world: *"when I zoom out and scale and
 * move the map, you see the shader clips out of view, and you don't get to see
 * the entire island."* The zoom floor above had made the frame as wide as the
 * island, but the PAN bound was still the literal 200 units it had been when
 * the frame was always 40 units tall — so one small drag at the floor pushed
 * most of the island off the screen and left a frame of open sea. The bound is
 * the frame's now (`panLimitFor`), and the third block below is what pins it:
 * wide open the pan closes to nothing, so the island cannot leave the frame.
 *
 * No WebGL: an OrthographicCamera is plain maths.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  CAMERA_DISTANCE,
  CAMERA_FAR,
  CAMERA_NEAR,
  CameraRig,
  FOLLOW_FRAME_FILL,
  FOLLOW_HEADROOM,
  FOLLOW_STAND_HEIGHT,
  FRUSTUM_HEIGHT,
  HATCH_CLOSE_ZOOM,
  ISLAND_VIEW_MARGIN,
  PHONE_FOLLOW_ZOOM,
  PHONE_ZOOM_MAX,
  ZOOM_WRITE_EPSILON,
  cameraDistance,
  cameraFar,
  followSpringLag,
  followZoomFor,
  frameHalfGround,
  headroomZoom,
  panLimitFor,
  zoomMinFor,
} from '../../src/world/camera';
import { createFollowAim } from '../../src/world/follow';
import { MOTION } from '../../src/taste/tokens';
import { GROUND_RADIUS, groundRadius } from '../../src/world/ground';
import { coastRadius, mapScale, setIslandMode } from '../../src/world/landscape';

// The island floor and the frame-relative pan bound are the ISLAND's — every
// test below that reads them is asking about the katamari world's camera.
beforeAll(() => setIslandMode(true));
afterAll(() => setIslandMode(false));

describe('with the island off, the camera is the one that shipped', () => {
  it('keeps the 0.45 zoom floor and the 200-unit pan bound on the plain', () => {
    setIslandMode(false);
    try {
      expect(zoomMinFor(0.5)).toBe(0.45);
      expect(zoomMinFor(1.78)).toBe(0.45);
      expect(panLimitFor(390 / 844, 0.05)).toBe(200);
      expect(panLimitFor(1.78, 1)).toBe(200);
      // …and the depth range is the one the public world shipped with, to the
      // unit: the two functions answer their own constants with no island.
      expect(groundRadius()).toBe(GROUND_RADIUS);
      expect(cameraDistance()).toBe(CAMERA_DISTANCE);
      expect(cameraFar()).toBe(CAMERA_FAR);
    } finally {
      setIslandMode(true);
    }
  });
});

/**
 * The island's widest reach, measured here at twice the rig's own angular
 * resolution — so this is a bound on the rig's number, not a copy of it.
 * `coastRadius` reads `ISLAND_LOBES` directly and so does not ride the
 * landscape mode: the floor is the same in the plain world.
 *
 * MEASURED ON DEMAND and memoised, never at module load: the lobes ride the
 * map's own scale (src/world/landscape.ts `MAP_SCALE`) and `setIslandMode`
 * re-points them, which happens in `beforeAll` — after this module has been
 * evaluated. Measured 176.26 at the authored size, 352.52 doubled.
 */
let coastMaxCache: number | null = null;
const coastMax = (): number => {
  if (coastMaxCache === null) {
    let max = 0;
    for (let i = 0; i < 720; i++) max = Math.max(max, coastRadius((i / 720) * Math.PI * 2));
    coastMaxCache = max;
  }
  return coastMaxCache;
};

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
    expect(visibleWidth(aspect, zoom)).toBeGreaterThanOrEqual(2 * (coastMax() + SEA_SHOWN));
    // Width is the narrow axis here, so it is the constraint that set the
    // floor: the frame is taller than the island needs.
    expect(visibleHeight(zoom)).toBeGreaterThan(2 * coastMax() * ISO_SIN);
  });

  it('fits the whole island up a landscape phone, foreshortening included', () => {
    const aspect = 1.78;
    const zoom = zoomMinFor(aspect);
    expect(visibleHeight(zoom)).toBeGreaterThanOrEqual(2 * (coastMax() + SEA_SHOWN) * ISO_SIN);
    // Height binds at this aspect (1.78 > 1/sin(iso) ≈ 1.73), and the extra
    // width is free.
    expect(visibleWidth(aspect, zoom)).toBeGreaterThan(2 * (coastMax() + SEA_SHOWN));
  });

  it('falls as the viewport narrows — the floor is not a constant', () => {
    // Less width per unit of height means the view has to open WIDER to hold
    // the island, so a portrait floor sits below a landscape one.
    expect(zoomMinFor(0.5)).toBeLessThan(zoomMinFor(0.9));
    expect(zoomMinFor(0.5)).toBeLessThan(zoomMinFor(1.78));
  });

  it('is the island plus its margin, on the narrower axis', () => {
    const r = coastMax() + ISLAND_VIEW_MARGIN;
    // Portrait: width. Two samples of the closed form, to pin the derivation
    // rather than only its consequences.
    expect(zoomMinFor(0.5)).toBeCloseTo((FRUSTUM_HEIGHT * 0.5) / (2 * r), 3);
    expect(zoomMinFor(1.78)).toBeCloseTo(FRUSTUM_HEIGHT / (2 * r * ISO_SIN), 3);
  });
});

describe('panLimitFor', () => {
  /** The phone that filed the report: 390×844 CSS pixels. */
  const PHONE = 390 / 844;

  it('closes the pan to nothing at the zoom floor, on every aspect', () => {
    // The floor is exactly "the island fills the narrower axis", so there is
    // no room left to pan and the bound says so: the island cannot be moved
    // out of the frame it was zoomed out to fit.
    for (const aspect of [PHONE, 0.5, 0.75, 1, 1.78, 2.16]) {
      expect(panLimitFor(aspect, zoomMinFor(aspect))).toBeCloseTo(0, 6);
    }
  });

  it('keeps the whole island in frame at the bound, wherever the frame holds it', () => {
    // The statement: pan as far as the bound allows and the island is still
    // inside the frame — for every zoom whose frame can hold the island and
    // half of its margin of sea.
    for (const aspect of [PHONE, 0.5, 1, 1.78]) {
      for (let zoom = zoomMinFor(aspect); zoom <= 2.6; zoom *= 1.05) {
        const half = Math.min(
          visibleWidth(aspect, zoom) / 2,
          visibleHeight(zoom) / 2 / ISO_SIN,
        );
        if (half < coastMax() + ISLAND_VIEW_MARGIN / 2) continue;
        expect(half - panLimitFor(aspect, zoom)).toBeGreaterThanOrEqual(coastMax());
      }
    }
  });

  it('opens back up as the frame narrows, and never past the shipped ceiling', () => {
    const aspect = PHONE;
    const floor = zoomMinFor(aspect);
    // Monotone in the zoom: every step in is a step more pan. That continuity
    // is what lets a parked pan drift home instead of stepping (TASTE §2.1).
    let previous = -1;
    for (let zoom = floor; zoom <= 2.6; zoom *= 1.1) {
      const limit = panLimitFor(aspect, zoom);
      expect(limit).toBeGreaterThan(previous);
      // …and never past the ceiling, which rides the map (`MAP_SCALE`): a
      // 200-unit ceiling on an island whose coast reaches 352 would have put
      // the far shore out of reach at every zoom.
      expect(limit).toBeLessThanOrEqual(200 * mapScale());
      previous = limit;
    }
    // …and at the default framing it is all but the frame's own half-width, so
    // nothing about panning a world you are standing in has changed.
    expect(panLimitFor(aspect, 1)).toBeGreaterThan(180);
  });

  it('reads the frame, not the viewport: a low orbit sees further and pans less', () => {
    // The ground's own extent up the screen is `/sin(elevation)`, so tilting
    // toward the horizon widens the frame — and the bound tightens with it.
    // Read on a landscape phone, where the foreshortened axis is the narrower
    // one and so the one that decides (as it is for the zoom floor).
    const flat = panLimitFor(2.16, 0.25, Math.atan(1 / Math.SQRT2));
    const grazing = panLimitFor(2.16, 0.25, 0.3);
    expect(flat).toBeGreaterThan(0);
    expect(grazing).toBeGreaterThan(0);
    expect(grazing).toBeLessThan(flat);
  });
});

describe('CameraRig pan bound', () => {
  /** Settle the rig: enough frames for a t.primary spring to arrive. */
  const settle = (rig: CameraRig, from = 0): void => {
    for (let i = 0; i < 400; i++) rig.update(16, from + i * 16);
  };
  /** The ambient drift rides on the look-target forever, so nothing here can
   * assert an exact zero — this is its amplitude with room to spare. */
  const DRIFT = 0.5;

  it('will not drag the island out of a frame zoomed out to hold it', () => {
    const rig = new CameraRig(390 / 844);
    rig.zoomDirect(0.0001);
    settle(rig);
    // A full-screen drag, both axes, at the floor — where one pixel is about
    // one world unit and the old bound was reached by a flick.
    rig.panBy(2000, 2000, 844);
    settle(rig, 6400);
    const look = rig.lookAtPoint();
    expect(Math.abs(look.x)).toBeLessThan(DRIFT);
    expect(Math.abs(look.z)).toBeLessThan(DRIFT);
  });

  it('draws a pan made up close back home as the view opens, by drifting', () => {
    const rig = new CameraRig(390 / 844);
    // Panned to the bound at the default framing: legal, and off to one side.
    rig.panBy(-4000, 0, 844);
    settle(rig);
    const panned = rig.lookAtPoint();
    expect(Math.hypot(panned.x, panned.z)).toBeGreaterThan(150);

    // Now pinch all the way out. The bound closes, so the frame has to come
    // back — and it SLIDES: one frame in it has moved and has not arrived.
    rig.zoomDirect(0.0001);
    rig.update(16, 6400);
    const first = rig.lookAtPoint();
    expect(Math.hypot(first.x, first.z)).toBeLessThan(Math.hypot(panned.x, panned.z));
    expect(Math.hypot(first.x, first.z)).toBeGreaterThan(50);

    settle(rig, 6416);
    const home = rig.lookAtPoint();
    expect(Math.abs(home.x)).toBeLessThan(DRIFT);
    expect(Math.abs(home.z)).toBeLessThan(DRIFT);
  });

  it('clamps a reframe onto a far subject to the same bound', () => {
    const rig = new CameraRig(390 / 844);
    rig.zoomDirect(0.0001);
    settle(rig);
    // The follow driver retargets onto the tracked creature every frame; at
    // the floor the whole island is on screen, so the frame stays put.
    for (let i = 0; i < 400; i++) {
      rig.frameAt(new Vector3(170, 0, -170));
      rig.update(16, 6400 + i * 16);
    }
    const look = rig.lookAtPoint();
    expect(Math.abs(look.x)).toBeLessThan(DRIFT);
    expect(Math.abs(look.z)).toBeLessThan(DRIFT);
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
    // WITHIN THE PROJECTION DEADBAND, and not a decimal place: `update` stops
    // rewriting `camera.zoom` once the spring is inside
    // `ZOOM_WRITE_EPSILON` of it (src/world/camera.ts), so a parked camera
    // reports its floor to exactly that accuracy and no better — on either
    // side of it. The remainder inside the band is not a settle time and
    // more frames do not shrink it; it is wherever the last write landed,
    // and it is a different number at every map scale (9.0e-5 at `MAP_SCALE`
    // 1.32, 4.9e-5 below the floor on the resize path underneath). The claim
    // is that both paths reach the FLOOR, which is what this measures.
    expect(Math.abs(rig.camera.zoom - zoomMinFor(1.78))).toBeLessThanOrEqual(
      ZOOM_WRITE_EPSILON,
    );
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
    // …and it arrives at the raised floor within the same projection
    // deadband the test above reads (`ZOOM_WRITE_EPSILON`), from below.
    expect(Math.abs(rig.camera.zoom - narrow)).toBeLessThanOrEqual(ZOOM_WRITE_EPSILON);
  });
});

describe('CameraRig depth range', () => {
  it('reaches past the sea disc on both sides of the target', () => {
    const rig = new CameraRig(1.78);
    // `cameraDistance` / `cameraFar` and not the two constants: the sea disc
    // rides the island's scale (src/world/field.ts `groundRadius`), so the
    // depth range that has to clear it rides with it — 3200 / 6400 on the
    // doubled island against the 1800 / 3800 the plain world keeps. The
    // constants ARE those plain numbers, and the two agree with the island
    // off (pinned below).
    expect(cameraDistance()).toBeGreaterThan(groundRadius());
    expect(cameraFar()).toBeGreaterThanOrEqual(cameraDistance() + groundRadius());
    expect(rig.camera.near).toBe(CAMERA_NEAR);
    expect(rig.camera.far).toBe(cameraFar());
    // The old range stopped 480 units out and cut the horizon.
    expect(cameraFar()).toBeGreaterThan(480);
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
    const nearEdge = new Vector3(toEye.x, 0, toEye.z).multiplyScalar(groundRadius());
    const farEdge = nearEdge.clone().multiplyScalar(-1);

    const depthOf = (p: Vector3): number => p.clone().sub(eye).dot(view);
    expect(depthOf(nearEdge)).toBeGreaterThan(rig.camera.near);
    expect(depthOf(farEdge)).toBeLessThan(rig.camera.far);
    // And with the pannable region thrown in on top of the disc.
    const panned = nearEdge
      .clone()
      .multiplyScalar((groundRadius() + 200 * mapScale()) / groundRadius());
    expect(depthOf(panned)).toBeGreaterThan(rig.camera.near);
  });
});

/**
 * THE PHONE'S FRAME SITS ON ITS OWN CREATURE (user ask, 2026-09-17: *"on
 * mobile the camera perspective is too zoomed out on the character. we should
 * be focused on the user's character and always have it in frame. if a user
 * wants to zoom out and pan around they still can, but at the start and when
 * the user uses the joystick we should smoothly focus back on the
 * character."*).
 *
 * Four claims, and the fourth is the one that is easy to get wrong: a tight
 * frame is 5.4 world units across and the rig's reframe spring takes
 * t.primary to arrive, so a creature at the rolling ceiling would be almost
 * six units behind the middle of it — off the screen. The lead is what fixes
 * that and the zoom is the net under it; both are measured here against the
 * REAL rig, projecting the creature through the real camera.
 */
describe('the phone follow framing', () => {
  /** The phone that filed the report: 390x844 CSS pixels. */
  const PHONE = 390 / 844;
  /** The katamari ceilings (src/creatures/manager.ts): walk and roll. */
  const WALK = 4.5;
  const ROLL = 10.8;

  it('is tighter than the hatch close-in, and not at the pinch ceiling', () => {
    expect(PHONE_FOLLOW_ZOOM).toBeGreaterThan(HATCH_CLOSE_ZOOM);
    // A page whose resting frame IS its ceiling can only be pinched one way.
    expect(PHONE_FOLLOW_ZOOM).toBeLessThan(PHONE_ZOOM_MAX);
    expect(PHONE_ZOOM_MAX / PHONE_FOLLOW_ZOOM).toBeGreaterThan(1.2);
  });

  it('frames a hatchling as a third of the narrow axis of the frame', () => {
    // A hatchling is about 1.9 u across. The frame's narrower GROUND axis is
    // what a portrait phone is bound by, and this is the number the constant
    // was tuned against on the render (scratch/follow-frame-smoke.mjs).
    const half = frameHalfGround(PHONE, PHONE_FOLLOW_ZOOM);
    expect(1.9 / (2 * half)).toBeGreaterThan(0.3);
    expect(1.9 / (2 * half)).toBeLessThan(0.45);
    // …and the framing the hatch used to leave was less than half as tight.
    expect(frameHalfGround(PHONE, HATCH_CLOSE_ZOOM)).toBeGreaterThan(half * 1.5);
  });

  it('is the FLOOR of the follow zoom — nothing asks for tighter', () => {
    for (let r = 0; r < 60; r = r * 1.3 + 0.05) {
      for (const behind of [0, 1, 3, 12]) {
        expect(
          followZoomFor(r, { close: PHONE_FOLLOW_ZOOM, aspect: PHONE, behind }),
        ).toBeLessThanOrEqual(PHONE_FOLLOW_ZOOM);
      }
    }
    // With nothing to hold and no frame given it IS the framing.
    expect(followZoomFor(0, { close: PHONE_FOLLOW_ZOOM })).toBe(PHONE_FOLLOW_ZOOM);
    expect(followZoomFor(0.4, { close: PHONE_FOLLOW_ZOOM, aspect: PHONE })).toBe(
      PHONE_FOLLOW_ZOOM,
    );
  });

  it('widens just enough to hold the subject, and monotonically', () => {
    const at = (bodyR: number, behind: number): number =>
      followZoomFor(bodyR, { close: PHONE_FOLLOW_ZOOM, aspect: PHONE, behind });
    // The statement: whatever it hands back, the thing it is holding fits
    // inside the frame's narrower ground half-extent with the fill's margin.
    for (const bodyR of [0.9, 2, 5, 9, 15]) {
      for (const behind of [0, 2, 5, 9]) {
        const reach = bodyR + behind;
        const half = frameHalfGround(PHONE, at(bodyR, behind));
        expect(half).toBeGreaterThanOrEqual(reach - 1e-9);
        // …and it is not wider than it needs to be: either the fill is met
        // exactly or the tight framing is what bound it.
        const exact = Math.abs(half * FOLLOW_FRAME_FILL - reach) < 1e-6;
        expect(exact || at(bodyR, behind) === PHONE_FOLLOW_ZOOM).toBe(true);
      }
    }
    // Monotone in both inputs — a frame that stepped would be a cut.
    let previous = Infinity;
    for (const behind of [0, 1, 2, 4, 8, 16]) {
      const zoom = at(2, behind);
      expect(zoom).toBeLessThanOrEqual(previous);
      previous = zoom;
    }
  });

  it('reads the spring’s own lag rather than inventing a number', () => {
    // A ζ=1 spring tracking a ramp sits 2v/ω behind, ω = 6.64/settleMs.
    const omega = 6.64 / MOTION.primaryMs;
    expect(followSpringLag(WALK)).toBeCloseTo((2 * (WALK / 1000)) / omega, 6);
    expect(followSpringLag(WALK)).toBeCloseTo(2.47, 2);
    expect(followSpringLag(ROLL)).toBeCloseTo(5.93, 2);
    expect(followSpringLag(0)).toBe(0);
    // Which is the whole reason the aim leads: the lag at the rolling ceiling
    // is more than twice the tight frame's half-extent.
    expect(followSpringLag(ROLL)).toBeGreaterThan(frameHalfGround(PHONE, PHONE_FOLLOW_ZOOM));
  });

  /**
   * One rig, one `followAim`, and a creature walked across the ground — the
   * arrangement src/main.ts's frame loop is, with the scene taken out.
   */
  const drive = (
    steps: number,
    velocity: (step: number) => { vx: number; vz: number },
    bodyR = 0.95,
  ): { worst: number; zooms: number[]; misses: number[] } => {
    const rig = new CameraRig(PHONE);
    // The ceiling the handset raises for itself (src/main.ts), or the tight
    // framing would be clamped at the 2.6 every other page keeps.
    rig.raiseZoomCeiling(PHONE_ZOOM_MAX);
    const aim = createFollowAim({ close: PHONE_FOLLOW_ZOOM });
    let x = 0;
    let z = 0;
    let lastZoom = 0;
    let worst = 0;
    const zooms: number[] = [];
    const misses: number[] = [];
    for (let i = 0; i < steps; i++) {
      const { vx, vz } = velocity(i);
      x += (vx * 16) / 1000;
      z += (vz * 16) / 1000;
      const look = rig.lookAtPoint();
      const a = aim({
        x,
        z,
        bodyR,
        lookX: look.x,
        lookZ: look.z,
        aspect: rig.aspect,
        dtMs: 16,
      });
      rig.frameAt(new Vector3(a.x, 0, a.z));
      if (Math.abs(a.zoom - lastZoom) > 0.01) {
        lastZoom = a.zoom;
        rig.zoomTo(a.zoom);
      }
      rig.update(16, i * 16);
      zooms.push(rig.camera.zoom);
      misses.push(Math.hypot(x - rig.lookAtPoint().x, z - rig.lookAtPoint().z));
      // WHERE THE CREATURE LANDS ON THE SCREEN, through the real camera —
      // its FEET and its TOPPER, because the frame is centred on the ground
      // point and the whole creature is drawn upwards from there.
      rig.camera.updateMatrixWorld();
      for (const y of [0, FOLLOW_STAND_HEIGHT]) {
        const ndc = new Vector3(x, y, z).project(rig.camera);
        worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
      }
    }
    return { worst, zooms, misses };
  };

  it('opens on the creature at the tight framing, sliding not cutting', () => {
    const { worst, zooms } = drive(400, () => ({ vx: 0, vz: 0 }));
    // In frame the whole way in, and it ARRIVES at the tight framing.
    expect(worst).toBeLessThan(1);
    expect(zooms[zooms.length - 1]).toBeCloseTo(PHONE_FOLLOW_ZOOM, 3);
    // The slide is monotone and never passes the framing (no overshoot, ζ≥1).
    let last = zooms[0] ?? 0;
    expect(last).toBeLessThan(PHONE_FOLLOW_ZOOM);
    for (const zoom of zooms) {
      expect(zoom).toBeGreaterThanOrEqual(last - 1e-9);
      expect(zoom).toBeLessThanOrEqual(PHONE_FOLLOW_ZOOM + 1e-9);
      last = zoom;
    }
  });

  it('keeps a creature at the WALK ceiling inside the viewport', () => {
    const { worst, misses } = drive(600, (i) => {
      const ramp = Math.min(1, i / 30);
      return { vx: WALK * ramp, vz: 0 };
    });
    expect(worst).toBeLessThan(1);
    // The lead is what does it: once the speed is steady the frame is ON the
    // creature rather than `followSpringLag(WALK)` = 2.47 u behind it.
    expect(misses[misses.length - 1]).toBeLessThan(0.3);
  });

  it('keeps a creature at the ROLLING ceiling inside the viewport, turning', () => {
    // A full-speed roll with a turn in it — the case the lead alone does not
    // cover, and the one the zoom's net is for.
    const { worst, misses } = drive(900, (i) => {
      const ramp = Math.min(1, i / 30);
      const th = (i / 900) * Math.PI * 2;
      return { vx: ROLL * ramp * Math.cos(th), vz: ROLL * ramp * Math.sin(th) };
    });
    expect(worst).toBeLessThan(1);
    // …and it is a real drive, not a creature that never left the middle.
    expect(Math.max(...misses)).toBeGreaterThan(0.5);
  });

  it('leaves the creature’s own HEIGHT room, which is what sets the ceiling', () => {
    // The look-target is on the GROUND, so the creature stands above the
    // middle of the frame and its topper is the thing that leaves it first.
    // The statement: at whatever zoom the rule hands back, the top of the
    // creature is inside `FOLLOW_HEADROOM` of the half-frame.
    for (const bodyR of [0, 0.95, 2, 7.5, 20]) {
      for (const behind of [0, 1, 4, 9]) {
        const zoom = followZoomFor(bodyR, {
          close: PHONE_FOLLOW_ZOOM,
          aspect: PHONE,
          behind,
        });
        const up = Math.max(FOLLOW_STAND_HEIGHT, 2 * bodyR);
        const onScreen =
          up * Math.cos(Math.atan(1 / Math.SQRT2)) + behind * ISO_SIN;
        expect(onScreen).toBeLessThanOrEqual(
          (FRUSTUM_HEIGHT / 2 / zoom) * FOLLOW_HEADROOM + 1e-9,
        );
      }
    }
    // …and the RESTING framing is the constant rather than the accident of
    // this bound: a hatchling at rest sits just inside it.
    expect(headroomZoom(0.95)).toBeGreaterThan(PHONE_FOLLOW_ZOOM);
    expect(headroomZoom(0.95)).toBeLessThan(PHONE_FOLLOW_ZOOM * 1.15);
    // It tightens with the lag and with the pile, and never the other way.
    expect(headroomZoom(0.95, 3)).toBeLessThan(headroomZoom(0.95));
    expect(headroomZoom(9)).toBeLessThan(headroomZoom(0.95));
  });

  it('holds a 15 m pile in frame at the same time', () => {
    const bodyR = 15 / 2;
    const { worst } = drive(
      600,
      (i) => ({ vx: ROLL * Math.min(1, i / 30), vz: 0 }),
      bodyR,
    );
    expect(worst).toBeLessThan(1);
  });
});

describe('the pinch ceiling', () => {
  it('is 2.6 on every page that never raises it — the projection', () => {
    const rig = new CameraRig(1280 / 800);
    for (let i = 0; i < 200; i++) rig.zoomBy(1.2);
    rig.zoomTo(99);
    rig.zoomDirect(99);
    expect(rig.zoomAim()).toBe(2.6);
  });

  it('goes up for the handset that follows, and only up', () => {
    const rig = new CameraRig(390 / 844);
    rig.raiseZoomCeiling(PHONE_ZOOM_MAX);
    rig.zoomTo(99);
    expect(rig.zoomAim()).toBe(PHONE_ZOOM_MAX);
    // A lower ask cannot take the range away again.
    rig.raiseZoomCeiling(1.2);
    rig.zoomTo(99);
    expect(rig.zoomAim()).toBe(PHONE_ZOOM_MAX);
  });

  it('raising it moves nothing by itself — it cannot be a cut', () => {
    const rig = new CameraRig(390 / 844);
    for (let i = 0; i < 400; i++) rig.update(16, i * 16);
    const before = rig.camera.zoom;
    rig.raiseZoomCeiling(PHONE_ZOOM_MAX);
    rig.update(16, 6400);
    expect(rig.camera.zoom).toBeCloseTo(before, 6);
  });
});
