/**
 * Orthographic isometric camera rig (PLAN §7, TASTE §2.6).
 *
 * True isometric: elevation atan(1/√2) ≈ 35.264°, azimuth 45°. The camera
 * never cuts and never fully stops — reframes slide on ζ≥1 springs at
 * t.primary and settle by drifting into the ambient floor, which runs on the
 * look-target forever. Frustum is sized by viewport height so resizes widen
 * the view without rescaling the world.
 *
 * Two of its numbers are DERIVED from the world rather than chosen: the zoom
 * floor, which is whatever holds the whole island on the narrower screen axis
 * (`zoomMinFor`), and the eye distance, which is whatever keeps the sea disc
 * inside the depth range at any orbit (`CAMERA_DISTANCE`).
 */

import { OrthographicCamera, Vector3 } from 'three';
import { sampleDrift } from '../motion/ambient';
import { Spring } from '../motion/spring';
import { MOTION } from '../taste/tokens';
import { GROUND_RADIUS } from './ground';
import { coastRadius } from './landscape';

/** True isometric elevation: atan(1/√2). */
const ELEVATION = Math.atan(1 / Math.SQRT2);
const AZIMUTH = Math.PI / 4;

/** World units visible top-to-bottom. Width follows the viewport aspect. */
export const FRUSTUM_HEIGHT = 40;

/** Pan CEILING: the look-target stays inside the populated region, so no
 * combination of pan, orbit, and zoom reaches the world's edge. The live bound
 * is this or less — it shrinks as the frame widens (see `panLimitFor`). */
const PAN_LIMIT = 200;

/**
 * Furthest any drawn ground point can sit from the look-target: the sea disc
 * (src/world/ground.ts) plus the whole pannable region, because the target
 * can stand `PAN_LIMIT` off the origin while the disc still reaches
 * `GROUND_RADIUS`. Everything drawn lives inside this ball. [D]
 */
const DEPTH_REACH = GROUND_RADIUS + PAN_LIMIT;

/** [D] Slack on both ends of the depth range, for the terrain's own height,
 * props, and the cloud deck standing above the plane. */
const DEPTH_MARGIN = 200;

/**
 * Distance from look-target along the iso axis. Free for an ortho camera —
 * moving the eye back along the view direction changes nothing on screen —
 * so it is set by the DEPTH RANGE, not by framing: far enough back that no
 * geometry can ever fall behind the near plane.
 *
 * At 120 (the original) a low orbit put the ground between the eye and the
 * target in front of the camera plane and the near plane cut the front edge
 * of the map off (user report, 2026-09-15). At `DEPTH_REACH + DEPTH_MARGIN`
 * the nearest drawable point still sits `DEPTH_MARGIN` in front of the eye.
 */
export const CAMERA_DISTANCE = DEPTH_REACH + DEPTH_MARGIN;

/** Ortho depth range. `far` clears the sea disc on the far side too — at the
 * old `CAMERA_DISTANCE * 4` = 480 the horizon was clipped clean through,
 * which is a hard cut (TASTE §2.1). Ortho depth is linear, so a 3600-unit
 * range costs no precision that matters here. */
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = CAMERA_DISTANCE + DEPTH_REACH + DEPTH_MARGIN;

/** Stable seed for the camera's own ambient drift channel. */
const DRIFT_SEED = 41.7;

/** Zoom ceiling: multiplier on the base frustum (higher = closer). The FLOOR
 * is not a literal — it comes from the island (see `zoomMinFor`). */
const ZOOM_MAX = 2.6;

/** OrbitControls dampingFactor 0.05 at 60hz ≈ exp decay with this τ. */
const ORBIT_DAMPING_TAU_MS = 325;
/** Elevation clamps: the floor keeps the ground filling the frame — at
 * 0.12 the view went nearly edge-on and saw past the plane (user report). */
const ELEVATION_MIN = 0.3;
const ELEVATION_MAX = 1.45;

/**
 * [D] Sea shown past the beach at the widest zoom: one `shoreRamp`-ish 20
 * units, so the coast reads as an edge with water around it rather than as
 * the edge of the frame.
 */
export const ISLAND_VIEW_MARGIN = 20;

/** Angular samples of the coast. The coast is a union of wobbled lobes with
 * no closed form, so its widest reach is MEASURED off the authored geography
 * rather than restated here (CLAUDE.md: never re-derive a shoreline). */
const COAST_SAMPLES = 360;

let coastMaxCache: number | null = null;

/** Largest coast radius from the origin, sampled once and memoized —
 * `coastRadius` is deterministic, so the number is stable per build. */
function coastMaxRadius(): number {
  if (coastMaxCache === null) {
    let max = 0;
    for (let i = 0; i < COAST_SAMPLES; i++) {
      max = Math.max(max, coastRadius((i / COAST_SAMPLES) * Math.PI * 2));
    }
    coastMaxCache = max;
  }
  return coastMaxCache;
}

/**
 * The zoom FLOOR for a viewport aspect: the widest the view is allowed to
 * get, which is exactly wide enough to hold the WHOLE island plus
 * `ISLAND_VIEW_MARGIN` of sea (user ask, 2026-09-15: "zoom out so that you
 * can see the entire island on pinch").
 *
 * The island is a disc of radius R on the ground plane. Seen down the iso
 * axis it measures `2R` across the screen and `2R·sin(elevation)` up it —
 * the ground foreshortens vertically, and only vertically. The frustum is
 * `FRUSTUM_HEIGHT / zoom` tall and `FRUSTUM_HEIGHT·aspect / zoom` wide, so
 * both fits give a ceiling on the zoom and the floor is the smaller one: a
 * portrait phone is bound by its width, a landscape one by its height.
 */
export function zoomMinFor(aspect: number): number {
  const r = coastMaxRadius() + ISLAND_VIEW_MARGIN;
  const byWidth = (FRUSTUM_HEIGHT * Math.max(0.01, aspect)) / (2 * r);
  const byHeight = FRUSTUM_HEIGHT / (2 * r * Math.sin(ELEVATION));
  return Math.min(ZOOM_MAX, byWidth, byHeight);
}

/**
 * How far the look-target may leave the origin AT A GIVEN FRAMING, world
 * units — the other half of `zoomMinFor`, and the answer to the second half
 * of the same user report.
 *
 * `PAN_LIMIT` on its own was written when the frame was always about
 * `FRUSTUM_HEIGHT` units tall. Since the zoom floor became the island's own
 * width (`zoomMinFor`, 2026-09-15) the frame's size in world units varies by
 * a factor of fifty, and a bound in world units cannot serve both ends of
 * that: wide open on a portrait phone the frame is ~390 units across — the
 * island and nothing more — so a 200-unit pan pushes most of the island off
 * the screen and leaves a frame of bare sea. That is a user report
 * (2026-09-16: *"when I zoom out and scale and move the map, you see the
 * shader clips out of view, and you don't get to see the entire island"*),
 * and at the floor one pixel of finger travel is one world unit, so the old
 * bound was reached by the smallest drag a phone can deliver.
 *
 * So the bound is expressed AGAINST THE FRAME rather than against the world:
 * the look-target may stand off the origin by whatever the island's reach has
 * over the frame's own narrower ground half-extent, capped at `PAN_LIMIT`.
 * Zoomed in that is the shipped ceiling all but a few units; at the floor,
 * where the frame IS the island, it closes to nothing and the island cannot
 * leave the frame. Continuous in the zoom — so a view parked at the old bound
 * is drawn home as the frame widens instead of stepping (TASTE §2.1).
 *
 * The frame's two ground half-extents: `aspect·FRUSTUM_HEIGHT/2zoom` across
 * the screen, and `FRUSTUM_HEIGHT/2zoom` up it — which the iso elevation
 * foreshortens, so the GROUND reaches `/sin(elevation)` further that way.
 * The narrower of the two is the one that decides, for the same reason it
 * decides the zoom floor. [D]
 *
 * ON A WORLD WITH NO ISLAND this is the same statement about a different
 * thing, and it is still the right one: `coastMaxRadius` does not ride
 * `islandMode` (neither does the zoom floor), and the number it gives lands
 * within four units of the displaced ground field's own half-extent
 * (`FIELD_SIZE / 2`, src/world/ground.ts). So the bound holds the drawn world
 * in frame on meridian and the public world exactly as it holds the island
 * here.
 */
export function panLimitFor(aspect: number, zoom: number, elevation: number = ELEVATION): number {
  const half = FRUSTUM_HEIGHT / 2 / Math.max(1e-3, zoom);
  const acrossFrame = half * Math.max(0.01, aspect);
  const upFrame = half / Math.max(0.25, Math.sin(elevation));
  const r = coastMaxRadius() + ISLAND_VIEW_MARGIN;
  return Math.min(PAN_LIMIT, Math.max(0, r - Math.min(acrossFrame, upFrame)));
}

export class CameraRig {
  readonly camera: OrthographicCamera;

  private readonly targetX: Spring;
  private readonly targetZ: Spring;
  /** Orbit rotation, OrbitControls-style (the cellshader reference feel):
   * drag adjusts targets 1:1, values approach on exponential damping —
   * overshoot-free by construction. Both axes rotate; elevation clamps so
   * the view never dives under the ground or over the pole. */
  private azimuthValue = AZIMUTH;
  private azimuthTarget = AZIMUTH;
  private elevationValue = ELEVATION;
  private elevationTarget = ELEVATION;
  /** Ortho zoom multiplier; wheel retargets (drift settle), pinch is 1:1. */
  private readonly zoomSpring: Spring;
  private zoomTarget = 1;
  /** Live zoom floor — derived from the island and the viewport aspect, so
   * rotating the phone to landscape raises it (see `zoomMinFor`). */
  private zoomMin: number;
  /** Continuous azimuth drift rate (rad/s), fed by the presentation tour.
   * Applied to the orbit *target* each frame, so the damped follow smooths
   * every start and stop — no step is representable. */
  private orbitDriftRate = 0;
  private readonly lookTarget = new Vector3();
  private readonly offset = new Vector3();

  /**
   * Where the rig is looking right now — a COPY, so no caller can move the
   * rig by writing to it. What the dev panel's `drop rock` aims at (it wants
   * the stone to land in frame), and nothing more: the ground under it still
   * comes from the Surface seam.
   */
  lookAtPoint(): { x: number; y: number; z: number } {
    return { x: this.lookTarget.x, y: this.lookTarget.y, z: this.lookTarget.z };
  }

  constructor(aspect: number) {
    const halfH = FRUSTUM_HEIGHT / 2;
    const halfW = halfH * aspect;
    this.camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, CAMERA_NEAR, CAMERA_FAR);
    this.zoomMin = zoomMinFor(aspect);
    // Reframes slide at t.primary — never snap, never cut (TASTE §2.1).
    this.targetX = new Spring(0, { settleMs: MOTION.primaryMs });
    this.targetZ = new Spring(0, { settleMs: MOTION.primaryMs });
    // User-driven zoom settles faster than reframes but still drifts.
    this.zoomSpring = new Spring(1, { settleMs: MOTION.secondaryMs });
    this.update(0, 0);
  }

  get azimuth(): number {
    return this.azimuthValue;
  }

  get elevation(): number {
    return this.elevationValue;
  }

  /**
   * The live pan bound: `panLimitFor` at this frame's aspect, zoom and
   * elevation. The frustum carries the aspect already — `top` is always half
   * of `FRUSTUM_HEIGHT` — so there is nothing extra to remember.
   */
  private panLimit(
    zoom: number = this.camera.zoom,
    elevation: number = this.elevationValue,
  ): number {
    return panLimitFor(this.camera.right / this.camera.top, zoom, elevation);
  }

  /**
   * Draw the pan back inside the bound this framing allows.
   *
   * The bound shrinks as the frame widens (`panLimitFor`), so a view panned
   * to the edge at one zoom can find itself outside it after a pinch, a
   * rotate or a device rotation — exactly the case where the island slid off
   * the screen. It RETARGETS: the frame drifts home on the same ζ≥1 spring
   * every other reframe uses, never a cut (TASTE §2.1).
   */
  private holdPanInFrame(zoom: number, elevation: number): void {
    const limit = this.panLimit(zoom, elevation);
    if (Math.abs(this.targetX.value) > limit) {
      this.targetX.retarget(Math.sign(this.targetX.value) * limit);
    }
    if (Math.abs(this.targetZ.value) > limit) {
      this.targetZ.retarget(Math.sign(this.targetZ.value) * limit);
    }
  }

  /**
   * Slide the framing toward a world point. Springs carry position and
   * velocity over, so mid-flight retargets stay continuous.
   */
  frameAt(point: Vector3): void {
    const limit = this.panLimit();
    this.targetX.retarget(Math.min(limit, Math.max(-limit, point.x)));
    this.targetZ.retarget(Math.min(limit, Math.max(-limit, point.z)));
  }

  update(dt: number, nowMs: number): void {
    // Tour azimuth drift: advance the target, let the damped follow carry
    // the value — starts and stops glide, never step.
    this.azimuthTarget += this.orbitDriftRate * (dt / 1000);
    // OrbitControls-equivalent damping (factor 0.05 per 60hz frame, the
    // cellshader default): an exponential approach with τ ≈ 325ms. Pure
    // decay — it cannot cross its target, so no overshoot is possible.
    const k = 1 - Math.exp(-dt / ORBIT_DAMPING_TAU_MS);
    this.azimuthValue += (this.azimuthTarget - this.azimuthValue) * k;
    this.elevationValue += (this.elevationTarget - this.elevationValue) * k;
    const az = this.azimuthValue;
    const el = this.elevationValue;
    const zoom = this.zoomSpring.update(dt);
    // The frame's own size decides how far the pan may go, so this comes
    // after the zoom and the orbit have moved and before the pan springs are
    // advanced — one frame's slide, not next frame's.
    this.holdPanInFrame(zoom, el);
    const x = this.targetX.update(dt);
    const z = this.targetZ.update(dt);
    this.offset
      .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
      .multiplyScalar(CAMERA_DISTANCE);
    if (Math.abs(this.camera.zoom - zoom) > 1e-4) {
      this.camera.zoom = zoom;
      this.camera.updateProjectionMatrix();
    }
    // The ambient floor: the look-target drifts at ~0.3% of the frame height,
    // forever. Imperceptible frame to frame; nonzero over any 2s idle sample.
    const drift = sampleDrift(nowMs, DRIFT_SEED, FRUSTUM_HEIGHT);
    this.lookTarget.set(x + drift.x, 0, z + drift.y);
    this.camera.position.copy(this.lookTarget).add(this.offset);
    this.camera.lookAt(this.lookTarget);
  }

  /**
   * Orbit both axes from a drag delta, OrbitControls-mapped (the cellshader
   * reference): a full viewport-height drag sweeps 2π at rotateSpeed 1.
   * Values follow on the damped approach in update().
   */
  rotateBy(dxPx: number, dyPx: number, viewportHeight: number): void {
    const per = (2 * Math.PI) / Math.max(1, viewportHeight);
    this.azimuthTarget -= dxPx * per;
    this.elevationTarget = Math.min(
      ELEVATION_MAX,
      Math.max(ELEVATION_MIN, this.elevationTarget + dyPx * per),
    );
  }

  /** Wheel zoom: retargets the spring so steps drift in — never a snap. */
  zoomBy(factor: number): void {
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(this.zoomMin, this.zoomTarget * factor));
    this.zoomSpring.retarget(this.zoomTarget);
  }

  /**
   * Tour zoom: retarget the zoom spring to an absolute level. Always drifts
   * in on the existing ζ≥1 spring — the tour has no direct-manipulation
   * path, so a snap is unrepresentable here (TASTE §2.1).
   */
  zoomTo(target: number): void {
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(this.zoomMin, target));
    this.zoomSpring.retarget(this.zoomTarget);
  }

  /**
   * Continuous azimuth drift (rad/s) for the presentation tour's dwells.
   * Pass 0 to stop drifting; the damped orbit follow eases both edges.
   */
  orbitDrift(radPerSec: number): void {
    this.orbitDriftRate = radPerSec;
  }

  /** Pinch zoom: direct 1:1 while the fingers move. */
  zoomDirect(factor: number): void {
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(this.zoomMin, this.zoomTarget * factor));
    this.zoomSpring.reset(this.zoomTarget);
  }

  /**
   * Pan by a screen-pixel delta (user drag). Screen x maps to the camera's
   * ground-plane right vector; screen y maps to ground-plane forward,
   * unforeshortened by the iso elevation. Direct manipulation tracks the
   * finger 1:1 — the springs are reset to the dragged value (velocity zero),
   * so release simply rests where the hand left it and the ambient floor
   * keeps the frame alive. No overshoot is possible by construction.
   */
  panBy(dxPx: number, dyPx: number, viewportHeight: number): void {
    const az = this.azimuthValue;
    const unitsPerPx = FRUSTUM_HEIGHT / Math.max(1, viewportHeight) / Math.max(0.01, this.camera.zoom);
    // Content follows the finger: dragging right moves the look-target left.
    const rightX = Math.cos(az);
    const rightZ = -Math.sin(az);
    const fwdX = -Math.sin(az);
    const fwdZ = -Math.cos(az);
    const dx = -dxPx * unitsPerPx;
    // Vertical screen distance foreshortens by sin(elevation) on the ground.
    const dy = (dyPx * unitsPerPx) / Math.max(0.25, Math.sin(this.elevationValue));
    const wx = rightX * dx + fwdX * dy;
    const wz = rightZ * dx + fwdZ * dy;
    // The bound is the FRAME's, not the world's (`panLimitFor`): wide open it
    // closes to nothing, so no drag can push the island off the screen.
    const limit = this.panLimit();
    this.targetX.reset(Math.min(limit, Math.max(-limit, this.targetX.value + wx)));
    this.targetZ.reset(Math.min(limit, Math.max(-limit, this.targetZ.value + wz)));
  }

  /**
   * Back to the world's default view: azimuth 45°, the true iso elevation,
   * zoom 1, look-target on the origin. The strip's home button and the paint
   * skill's `resetView` handle (src/dev/paint.ts).
   *
   * Every axis RETARGETS — it never assigns a value — so the view slides home
   * on the same ζ≥1 springs and damped follows every other move uses: no cut,
   * no snap, no overshoot (TASTE §2.1). The azimuth goes to the nearest
   * equivalent of 45° rather than to 45° itself, so a view that has been
   * orbited three times round takes the short way home instead of unwinding
   * every turn.
   */
  resetView(): void {
    const turns = Math.round((this.azimuthTarget - AZIMUTH) / (Math.PI * 2));
    this.azimuthTarget = AZIMUTH + turns * Math.PI * 2;
    this.elevationTarget = ELEVATION;
    this.zoomTo(1);
    this.targetX.retarget(0);
    this.targetZ.retarget(0);
  }

  /** Preserve the iso frustum on resize: height fixed, width follows aspect. */
  resize(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    // The floor moves with the aspect — a portrait frame can open wider than
    // a landscape one before the island runs out of room — so a view parked
    // at the old floor can find itself below the new one (rotate a phone to
    // landscape). It RETARGETS: the zoom drifts up on its ζ≥1 spring, never
    // a cut (TASTE §2.1).
    this.zoomMin = zoomMinFor(aspect);
    if (this.zoomTarget < this.zoomMin) {
      this.zoomTarget = this.zoomMin;
      this.zoomSpring.retarget(this.zoomTarget);
    }
    const halfH = FRUSTUM_HEIGHT / 2;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }
}
