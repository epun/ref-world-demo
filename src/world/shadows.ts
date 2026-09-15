/**
 * Flat stamped contact shadows (TASTE §2.4).
 *
 * Shadow as a graphic shape: a single hard-edged value — solid SURFACE.shadow
 * — cut sharp against the ground. No gradient, no blur, no opacity falloff,
 * no penumbra. Each registered entity gets one stamp lying ON the ground,
 * polygon-offset and render-ordered so it never z-fights it.
 *
 * ON the ground, not on y=0: the pass samples the Surface seam (PLAN §7.2)
 * under each stamp for its height AND its up-normal, so a stamp on a terrace
 * riser lies flat against the riser rather than hovering level over it. A
 * caller still only ever says WHERE on the ground plane (x, z) — the height
 * and the tilt are the pass's business, which is the same seam discipline
 * locomotion follows.
 *
 * ONE DRAW CALL for the whole population: every stamp is an instance of a
 * single shared unit disc in one InstancedMesh, not a Mesh of its own. At two
 * hundred creatures the per-stamp design cost two hundred draw calls and two
 * hundred CircleGeometry allocations; instanced, the population is one buffer
 * of matrices uploaded once a frame. The radius that used to be baked into
 * each stamp's geometry now lives in its instance scale, which is the only
 * reason the geometry can be shared at all. Nothing about the LOOK changes:
 * still one flat value cut sharp (TASTE §2.4), because the material is shared
 * by construction — instancing removes the meshes, not the discipline.
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

import {
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { SURFACE } from '../taste/tokens';
import { KEY_DIRECTION } from './lighting';
import { ROLLING_SURFACE, type Surface } from './surface';

/** Just proud of the sampled ground height. */
export const SHADOW_LIFT = 0.02;
const SHADOW_SEGMENTS = 64;

/** Instance slots allocated up front; doubles when full, never shrinks. */
const SHADOW_CAPACITY = 64;

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
  /** Move the stamp on the ground plane. Height and tilt are owned by the
   * pass, which samples them from the Surface — a caster never says y. */
  setPosition(x: number, z: number): void;
}

interface Stamp {
  /** Slot in the InstancedMesh's matrix buffer. Moves on swap-remove. */
  index: number;
  radius: number;
  /** Caster ground position — the ellipse offset is applied on top. */
  x: number;
  z: number;
}

export class FlatShadows {
  /** Add this group to the scene once; stamps live inside it. */
  readonly group = new Group();

  private readonly stamps = new Map<string, Stamp>();

  /** Slot → id, the inverse of `stamps`. Swap-remove needs to know whose
   * matrix it just moved so the map can be corrected. */
  private readonly slots: string[] = [];

  /** The ground every stamp lies on. Defaults to the world's terrain; a
   * caller with no landscape (tests, the phone stage) passes FLAT_SURFACE. */
  private readonly surface: Surface;

  // Orientation scratch, reused every lay() — this runs once per stamp per
  // frame across the whole population.
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly groundNormal = new Vector3();
  private readonly tilt = new Quaternion();
  private readonly spin = new Quaternion();
  private readonly position = new Vector3();
  private readonly orientation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly matrix = new Matrix4();

  // One shared material: every shadow is the same single value by
  // construction — the per-frame presence step retints ALL stamps at once,
  // never one of them. MeshBasicMaterial — a shadow must not be lit.
  private readonly material = new MeshBasicMaterial({
    color: SURFACE.shadow,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  // One shared UNIT disc, rotated flat at build time. Every stamp is this
  // geometry scaled by its own radius — there is no per-stamp allocation.
  private readonly geometry = (() => {
    const g = new CircleGeometry(1, SHADOW_SEGMENTS);
    g.rotateX(-Math.PI / 2);
    return g;
  })();

  /** The single mesh the whole population draws from. Replaced (never
   * resized) when it runs out of slots. */
  private mesh: InstancedMesh;

  private readonly groundValue = new Color(SURFACE.ground);
  private readonly shadowValue = new Color(SURFACE.shadow);

  /** Noon default: circle, zero offset — identical to the static pass. */
  private ellipse: StampEllipse = stampEllipse(
    Math.atan2(KEY_DIRECTION.x, KEY_DIRECTION.z),
    STAMP_NOON_ALTITUDE,
  );

  constructor(surface: Surface = ROLLING_SURFACE) {
    this.surface = surface;
    this.mesh = this.makeMesh(SHADOW_CAPACITY);
    this.group.add(this.mesh);
  }

  private makeMesh(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, capacity);
    mesh.renderOrder = 1;
    // The stamps are scattered across the whole map and the mesh's own
    // bounding sphere means nothing once the matrices move.
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    return mesh;
  }

  /** Double the slot count: new mesh, matrices copied across, old one gone.
   * Never shrinks — a population that peaked once will peak again. */
  private grow(): void {
    const next = this.makeMesh(Math.max(1, this.mesh.instanceMatrix.count) * 2);
    next.instanceMatrix.array.set(this.mesh.instanceMatrix.array);
    next.count = this.mesh.count;
    next.instanceMatrix.needsUpdate = true;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = next;
    this.group.add(next);
  }

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

  /**
   * Place one stamp: the sun ellipse decides WHERE on the ground plane, the
   * Surface decides how high the ground is there and which way it faces.
   *
   * The height is sampled at the PUSHED position, not under the caster — a
   * long dusk shadow reaching onto a terrace above lies on that terrace.
   *
   * Orientation is written as a quaternion in one go: align local +y (the
   * disc's own normal — the geometry is rotated flat at build time) to the
   * ground normal, THEN spin about the disc's own axis to point the long
   * axis away from the sun. A quaternion and an Euler must not both be
   * written, so the old `rotation.y` assignment is folded in as that spin
   * rather than living beside it.
   */
  private lay(stamp: Stamp): void {
    const e = this.ellipse;
    const push = e.offset * stamp.radius;
    const px = stamp.x + e.dirX * push;
    const pz = stamp.z + e.dirZ * push;
    this.position.set(px, this.surface.sampleHeight(px, pz) + SHADOW_LIFT, pz);
    const n = this.surface.normalAt(px, pz);
    this.groundNormal.set(n.x, n.y, n.z);
    this.tilt.setFromUnitVectors(this.worldUp, this.groundNormal);
    this.spin.setFromAxisAngle(this.worldUp, stampRotationY(e));
    this.orientation.copy(this.tilt).multiply(this.spin);
    // The unit geometry carries no radius, so the radius rides in the scale:
    // long axis radius × stretch, short axis radius.
    this.scale.set(stamp.radius * e.stretch, 1, stamp.radius);
    this.mesh.setMatrixAt(
      stamp.index,
      this.matrix.compose(this.position, this.orientation, this.scale),
    );
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  addShadow(id: string, radius: number): ShadowHandle {
    this.removeShadow(id);
    if (this.mesh.count >= this.mesh.instanceMatrix.count) this.grow();
    const index = this.mesh.count;
    this.mesh.count = index + 1;
    const stamp: Stamp = { index, radius, x: 0, z: 0 };
    this.stamps.set(id, stamp);
    this.slots[index] = id;
    this.lay(stamp);
    return {
      setPosition: (x: number, z: number): void => {
        stamp.x = x;
        stamp.z = z;
        this.lay(stamp);
      },
    };
  }

  /**
   * Swap-remove: the last instance's matrix is moved down into the freed slot
   * and the count drops by one, so the live instances stay a dense prefix of
   * the buffer. Nothing is reallocated and no other stamp is re-laid.
   */
  removeShadow(id: string): void {
    const stamp = this.stamps.get(id);
    if (!stamp) return;
    const last = this.mesh.count - 1;
    if (stamp.index !== last) {
      this.mesh.getMatrixAt(last, this.matrix);
      this.mesh.setMatrixAt(stamp.index, this.matrix);
      const movedId = this.slots[last]!;
      const moved = this.stamps.get(movedId);
      if (moved) moved.index = stamp.index;
      this.slots[stamp.index] = movedId;
    }
    this.slots.length = last;
    this.mesh.count = last;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.stamps.delete(id);
  }
}
