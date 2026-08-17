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

export class CameraRig {
  readonly camera: OrthographicCamera;

  private readonly targetX: Spring;
  private readonly targetZ: Spring;
  private readonly lookTarget = new Vector3();
  private readonly offset = new Vector3(
    Math.cos(ELEVATION) * Math.sin(AZIMUTH),
    Math.sin(ELEVATION),
    Math.cos(ELEVATION) * Math.cos(AZIMUTH),
  ).multiplyScalar(CAMERA_DISTANCE);

  constructor(aspect: number) {
    const halfH = FRUSTUM_HEIGHT / 2;
    const halfW = halfH * aspect;
    this.camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, CAMERA_DISTANCE * 4);
    // Reframes slide at t.primary — never snap, never cut (TASTE §2.1).
    this.targetX = new Spring(0, { settleMs: MOTION.primaryMs });
    this.targetZ = new Spring(0, { settleMs: MOTION.primaryMs });
    this.update(0, 0);
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
    // The ambient floor: the look-target drifts at ~0.3% of the frame height,
    // forever. Imperceptible frame to frame; nonzero over any 2s idle sample.
    const drift = sampleDrift(nowMs, DRIFT_SEED, FRUSTUM_HEIGHT);
    this.lookTarget.set(x + drift.x, 0, z + drift.y);
    this.camera.position.copy(this.lookTarget).add(this.offset);
    this.camera.lookAt(this.lookTarget);
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
