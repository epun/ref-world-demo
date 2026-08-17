/**
 * Flat stamped contact shadows (TASTE §2.4).
 *
 * Shadow as a graphic shape: a single hard-edged value — solid SURFACE.shadow
 * — cut sharp against the ground. No gradient, no blur, no opacity falloff,
 * no penumbra. Each registered entity gets one stamp sitting just above y=0,
 * polygon-offset and render-ordered so it never z-fights the ground.
 *
 * TIME OF DAY (cellshader translation): the reference environment drives its
 * shadow-catcher from sun altitude (length/direction) and a per-weather
 * shadow scalar (opacity). Here that translates to the monochrome system:
 * the SHAPE transforms — each disc becomes an ellipse stretched and pushed
 * along the sun's ground azimuth, longest at dawn/dusk, a plain circle at
 * noon — and the VALUE steps toward the ground as presence falls (night,
 * overcast, fog, rain). The fill itself never gradates: one flat material
 * value shared by every stamp, hard edge preserved. The ellipse math is
 * pure and exported for tests.
 */

import { CircleGeometry, Color, Group, Mesh, MeshBasicMaterial } from 'three';
import { SURFACE } from '../taste/tokens';
import { KEY_DIRECTION } from './lighting';

/** Just proud of the ground plane. */
const SHADOW_LIFT = 0.02;
const SHADOW_SEGMENTS = 64;

// ── sun-stamp ellipse math (pure) ────────────────────────────────────────────

/** Reference noon altitude: the calibrated key's ≈53°. At (or above) this
 * altitude the stamp is the original circle — the default frame is untouched. */
export const STAMP_NOON_ALTITUDE = Math.asin(KEY_DIRECTION.y);

/** Long-axis growth per unit of cot(altitude) beyond the noon baseline. */
export const STAMP_STRETCH_GAIN = 0.45;

/** Dawn/dusk clamp on the long-axis multiplier. */
export const STAMP_MAX_STRETCH = 3.2;

/** tan(altitude) floor — keeps the cotangent finite at the horizon. */
export const STAMP_TAN_FLOOR = 0.05;

/** The ellipse center slides away from the sun by this fraction of the
 * stretch growth (× base radius): the anchored end stays under the caster. */
export const STAMP_OFFSET_FRACTION = 0.4;

export interface StampEllipse {
  /** Long-axis scale multiplier along (dirX, dirZ); 1 = circle. */
  stretch: number;
  /** Center offset along (dirX, dirZ), in units of the stamp's base radius. */
  offset: number;
  /** Unit ground direction pointing AWAY from the sun's azimuth. */
  dirX: number;
  dirZ: number;
}

/**
 * Long-axis multiplier for a sun altitude (radians). 1 exactly at/above the
 * noon reference; grows as cot(altitude) while the sun sinks; clamped to
 * STAMP_MAX_STRETCH near the horizon (and below it — a set sun keeps the
 * dusk shape while presence fades the value out).
 */
export function stampStretch(
  altitude: number,
  noonAltitude: number = STAMP_NOON_ALTITUDE,
): number {
  const cot = 1 / Math.max(Math.tan(Math.max(altitude, 0)), STAMP_TAN_FLOOR);
  const noonCot = 1 / Math.max(Math.tan(Math.max(noonAltitude, 0)), STAMP_TAN_FLOOR);
  return Math.min(STAMP_MAX_STRETCH, 1 + STAMP_STRETCH_GAIN * Math.max(0, cot - noonCot));
}

/**
 * Full stamp transform for a sun position. Azimuth follows the world
 * atan2(x, z) convention (sun ground direction = (sin az, cos az)); the
 * shadow extends the opposite way. Pure and deterministic.
 */
export function stampEllipse(
  azimuth: number,
  altitude: number,
  noonAltitude: number = STAMP_NOON_ALTITUDE,
): StampEllipse {
  const stretch = stampStretch(altitude, noonAltitude);
  return {
    stretch,
    offset: STAMP_OFFSET_FRACTION * (stretch - 1),
    dirX: -Math.sin(azimuth),
    dirZ: -Math.cos(azimuth),
  };
}

/** Mesh y-rotation aligning local +X with the ellipse's away direction. */
export function stampRotationY(ellipse: StampEllipse): number {
  return Math.atan2(-ellipse.dirZ, ellipse.dirX);
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// ── the stamp pass ───────────────────────────────────────────────────────────

export interface ShadowHandle {
  /** Move the stamp on the ground plane. Y is owned by the pass. */
  setPosition(x: number, z: number): void;
}

interface Stamp {
  mesh: Mesh;
  radius: number;
  /** Caster ground position — the ellipse offset is applied on top. */
  x: number;
  z: number;
}

export class FlatShadows {
  /** Add this group to the scene once; stamps live inside it. */
  readonly group = new Group();

  private readonly stamps = new Map<string, Stamp>();

  // One shared material: every shadow is the same single value by
  // construction — the per-frame presence step retints ALL stamps at once,
  // never one of them. MeshBasicMaterial — a shadow must not be lit.
  private readonly material = new MeshBasicMaterial({
    color: SURFACE.shadow,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  private readonly groundValue = new Color(SURFACE.ground);
  private readonly shadowValue = new Color(SURFACE.shadow);

  /** Noon default: circle, zero offset — identical to the static pass. */
  private ellipse: StampEllipse = stampEllipse(
    Math.atan2(KEY_DIRECTION.x, KEY_DIRECTION.z),
    STAMP_NOON_ALTITUDE,
  );

  /**
   * Drive the stamps from the sun (scene.ts calls this every frame with
   * environment-derived values). azimuth/altitude shape the shared ellipse;
   * presence 0–1 picks the ONE flat value all stamps share this frame —
   * at 0 it equals the ground and the stamps vanish (night, storm).
   */
  setSun(azimuth: number, altitude: number, presence: number): void {
    this.ellipse = stampEllipse(azimuth, altitude);
    this.material.color
      .copy(this.groundValue)
      .lerp(this.shadowValue, clamp01(presence));
    for (const stamp of this.stamps.values()) this.lay(stamp);
  }

  private lay(stamp: Stamp): void {
    const e = this.ellipse;
    const push = e.offset * stamp.radius;
    stamp.mesh.position.set(
      stamp.x + e.dirX * push,
      SHADOW_LIFT,
      stamp.z + e.dirZ * push,
    );
    stamp.mesh.scale.set(e.stretch, 1, 1);
    stamp.mesh.rotation.y = stampRotationY(e);
  }

  addShadow(id: string, radius: number): ShadowHandle {
    this.removeShadow(id);
    const geometry = new CircleGeometry(radius, SHADOW_SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new Mesh(geometry, this.material);
    mesh.renderOrder = 1;
    const stamp: Stamp = { mesh, radius, x: 0, z: 0 };
    this.lay(stamp);
    this.group.add(mesh);
    this.stamps.set(id, stamp);
    return {
      setPosition: (x: number, z: number): void => {
        stamp.x = x;
        stamp.z = z;
        this.lay(stamp);
      },
    };
  }

  removeShadow(id: string): void {
    const stamp = this.stamps.get(id);
    if (!stamp) return;
    this.group.remove(stamp.mesh);
    stamp.mesh.geometry.dispose();
    this.stamps.delete(id);
  }
}
