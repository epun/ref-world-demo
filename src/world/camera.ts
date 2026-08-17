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

export class CameraRig {
  readonly camera: OrthographicCamera;

  private readonly targetX: Spring;
  private readonly targetZ: Spring;
  /** View azimuth — rotatable by the user; elevation stays locked at iso. */
  private readonly azimuthSpring: Spring;
  /** Ortho zoom multiplier; wheel retargets (drift settle), pinch is 1:1. */
  private readonly zoomSpring: Spring;
  private zoomTarget = 1;
  private readonly lookTarget = new Vector3();
  private readonly offset = new Vector3();

  constructor(aspect: number) {
    const halfH = FRUSTUM_HEIGHT / 2;
    const halfW = halfH * aspect;
    this.camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, CAMERA_DISTANCE * 4);
    // Reframes slide at t.primary — never snap, never cut (TASTE §2.1).
    this.targetX = new Spring(0, { settleMs: MOTION.primaryMs });
    this.targetZ = new Spring(0, { settleMs: MOTION.primaryMs });
    // User-driven view changes settle faster than reframes but still drift.
    this.azimuthSpring = new Spring(AZIMUTH, { settleMs: MOTION.secondaryMs });
    this.zoomSpring = new Spring(1, { settleMs: MOTION.secondaryMs });
    this.update(0, 0);
  }

  get azimuth(): number {
    return this.azimuthSpring.value;
  }

  /**
   * Slide the framing toward a world point. Springs carry position and
   * velocity over, so mid-flight retargets stay continuous.
   */
  frameAt(point: Vector3): void {
    this.targetX.retarget(point.x);
    this.targetZ.retarget(point.z);
  }

  update(dt: number, nowMs: number): void {
    const x = this.targetX.update(dt);
    const z = this.targetZ.update(dt);
    const az = this.azimuthSpring.update(dt);
    const zoom = this.zoomSpring.update(dt);
    this.offset
      .set(Math.cos(ELEVATION) * Math.sin(az), Math.sin(ELEVATION), Math.cos(ELEVATION) * Math.cos(az))
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

  /** Rotate the view around the look-target (drag): direct 1:1, no rebound. */
  rotateBy(dxPx: number): void {
    this.azimuthSpring.reset(this.azimuthSpring.value + dxPx * 0.006);
  }

  /** Wheel zoom: retargets the spring so steps drift in — never a snap. */
  zoomBy(factor: number): void {
    this.zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoomTarget * factor));
    this.zoomSpring.retarget(this.zoomTarget);
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
    const az = this.azimuthSpring.value;
    const unitsPerPx = FRUSTUM_HEIGHT / Math.max(1, viewportHeight) / Math.max(0.01, this.camera.zoom);
    // Content follows the finger: dragging right moves the look-target left.
    const rightX = Math.cos(az);
    const rightZ = -Math.sin(az);
    const fwdX = -Math.sin(az);
    const fwdZ = -Math.cos(az);
    const dx = -dxPx * unitsPerPx;
    // Vertical screen distance foreshortens by sin(elevation) on the ground.
    const dy = (dyPx * unitsPerPx) / Math.sin(ELEVATION);
    const wx = rightX * dx + fwdX * dy;
    const wz = rightZ * dx + fwdZ * dy;
    this.targetX.reset(this.targetX.value + wx);
    this.targetZ.reset(this.targetZ.value + wz);
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
