/**
 * Orthographic isometric camera rig (PLAN §7, TASTE §2.6).
 *
 * True isometric: elevation atan(1/√2) ≈ 35.264°, azimuth 45°. The camera
 * never cuts and never fully stops — reframes slide on ζ≥1 springs at
 * t.primary and settle by drifting into the ambient floor, which runs on the
 * look-target forever. Frustum is sized by viewport height so resizes widen
 * the view without rescaling the world.
 */

import { OrthographicCamera, Vector3 } from 'three';
import { sampleDrift } from '../motion/ambient';
import { Spring } from '../motion/spring';
import { MOTION } from '../taste/tokens';

/** True isometric elevation: atan(1/√2). */
const ELEVATION = Math.atan(1 / Math.SQRT2);
const AZIMUTH = Math.PI / 4;

/** World units visible top-to-bottom. Width follows the viewport aspect. */
export const FRUSTUM_HEIGHT = 40;

/** Distance from look-target along the iso axis. Arbitrary for an ortho
 * camera; large enough to keep the whole ground inside the depth range. */
const CAMERA_DISTANCE = 120;

/** Stable seed for the camera's own ambient drift channel. */
const DRIFT_SEED = 41.7;

/** Zoom bounds: multiplier on the base frustum (higher = closer). */
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 2.6;

/** OrbitControls dampingFactor 0.05 at 60hz ≈ exp decay with this τ. */
const ORBIT_DAMPING_TAU_MS = 325;
/** Elevation clamps: the floor keeps the ground filling the frame — at
 * 0.12 the view went nearly edge-on and saw past the plane (user report). */
const ELEVATION_MIN = 0.3;
const ELEVATION_MAX = 1.45;

/** Pan bounds: the look-target stays inside the populated region, so no
 * combination of pan, orbit, and zoom reaches the world's edge. */
const PAN_LIMIT = 200;

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
  /** Continuous azimuth drift rate (rad/s), fed by the presentation tour.
   * Applied to the orbit *target* each frame, so the damped follow smooths
   * every start and stop — no step is representable. */
  private orbitDriftRate = 0;
  private readonly lookTarget = new Vector3();
  private readonly offset = new Vector3();

  constructor(aspect: number) {
    const halfH = FRUSTUM_HEIGHT / 2;
    const halfW = halfH * aspect;
    this.camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, CAMERA_DISTANCE * 4);
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
   * Slide the framing toward a world point. Springs carry position and
   * velocity over, so mid-flight retargets stay continuous.
   */
  frameAt(point: Vector3): void {
    this.targetX.retarget(Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, point.x)));
    this.targetZ.retarget(Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, point.z)));
  }

  update(dt: number, nowMs: number): void {
    const x = this.targetX.update(dt);
    const z = this.targetZ.update(dt);
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
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoomTarget * factor));
    this.zoomSpring.retarget(this.zoomTarget);
  }

  /**
   * Tour zoom: retarget the zoom spring to an absolute level. Always drifts
   * in on the existing ζ≥1 spring — the tour has no direct-manipulation
   * path, so a snap is unrepresentable here (TASTE §2.1).
   */
  zoomTo(target: number): void {
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target));
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
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoomTarget * factor));
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
    this.targetX.reset(Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, this.targetX.value + wx)));
    this.targetZ.reset(Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, this.targetZ.value + wz)));
  }

  /** Preserve the iso frustum on resize: height fixed, width follows aspect. */
  resize(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    const halfH = FRUSTUM_HEIGHT / 2;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }
}
