/**
 * Sun-driven stamp ellipse tests — pure math from src/world/shadows.ts plus
 * the FlatShadows value/transform behavior (no WebGL: meshes and materials
 * are plain scene-graph objects in node).
 *
 * The whole population lives in ONE InstancedMesh, so a stamp's transform is
 * read back out of the instance matrix rather than off a Mesh of its own.
 * That buffer is Float32Array, so transforms round-trip at float32 precision
 * (~1e-7 relative) — MATRIX_DIGITS, below. The pure math is still exact.
 */

import { describe, expect, it } from 'vitest';
import { Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { SURFACE } from '../../src/taste/tokens';
import {
  FlatShadows,
  SHADOW_LIFT,
  STAMP_MAX_STRETCH,
  STAMP_NOON_ALTITUDE,
  STAMP_OFFSET_FRACTION,
  stampEllipse,
  stampRotationY,
  stampStretch,
} from '../../src/world/shadows';
import { sunArc } from '../../src/world/environment';
import { FLAT_SURFACE, ROLLING_SURFACE, type Surface } from '../../src/world/surface';

describe('stampStretch', () => {
  it('is exactly 1 (a circle) at the noon reference altitude and above', () => {
    expect(stampStretch(STAMP_NOON_ALTITUDE)).toBe(1);
    expect(stampStretch(STAMP_NOON_ALTITUDE + 0.3)).toBe(1);
    expect(stampStretch(Math.PI / 2)).toBe(1);
  });

  it('grows monotonically as the altitude falls, up to the clamp', () => {
    let prev = stampStretch(STAMP_NOON_ALTITUDE);
    for (let alt = STAMP_NOON_ALTITUDE; alt >= 0; alt -= 0.01) {
      const s = stampStretch(alt);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(s).toBeLessThanOrEqual(STAMP_MAX_STRETCH);
      prev = s;
    }
  });

  it('hits the ~3.2× clamp at dawn/dusk (and holds it below the horizon)', () => {
    expect(stampStretch(0.02)).toBe(STAMP_MAX_STRETCH);
    expect(stampStretch(0)).toBe(STAMP_MAX_STRETCH);
    expect(stampStretch(-0.4)).toBe(STAMP_MAX_STRETCH);
  });

  it('stretches meaningfully across the modeled day (morning vs noon)', () => {
    // t=0.30 is mid-morning on the environment sun arc: visibly long.
    const morning = stampStretch(sunArc(0.3).altitude);
    const noon = stampStretch(sunArc(0.5).altitude);
    expect(noon).toBeCloseTo(1, 9);
    expect(morning).toBeGreaterThan(1.5);
  });
});

describe('stampEllipse', () => {
  it('is the identity circle at noon: stretch 1, zero offset', () => {
    const e = stampEllipse(1.234, STAMP_NOON_ALTITUDE);
    expect(e.stretch).toBe(1);
    expect(e.offset).toBe(0);
  });

  it('points exactly opposite the sun azimuth', () => {
    for (const az of [0, 0.7, Math.PI / 2, Math.PI, -2.1, 5.5]) {
      const e = stampEllipse(az, 0.2);
      // Sun ground direction is (sin az, cos az); the shadow direction must
      // be its exact negation (unit, dot = -1).
      const dot = e.dirX * Math.sin(az) + e.dirZ * Math.cos(az);
      expect(dot).toBeCloseTo(-1, 12);
      expect(Math.hypot(e.dirX, e.dirZ)).toBeCloseTo(1, 12);
    }
  });

  it('offsets by the offset fraction of the stretch growth, away from the sun', () => {
    const e = stampEllipse(0.9, 0.15);
    expect(e.stretch).toBeGreaterThan(1);
    expect(e.offset).toBeCloseTo(STAMP_OFFSET_FRACTION * (e.stretch - 1), 12);
    expect(e.offset).toBeGreaterThan(0);
  });

  it('is deterministic — same inputs, identical outputs', () => {
    const a = stampEllipse(2.3, 0.31);
    const b = stampEllipse(2.3, 0.31);
    expect(b).toEqual(a);
    expect(stampStretch(0.31)).toBe(stampStretch(0.31));
  });

  it('aligns the mesh long axis with the away direction', () => {
    const e = stampEllipse(0.6, 0.2);
    const rot = stampRotationY(e);
    // rotation.y = θ maps local +X to world (cos θ, 0, -sin θ).
    expect(Math.cos(rot)).toBeCloseTo(e.dirX, 12);
    expect(-Math.sin(rot)).toBeCloseTo(e.dirZ, 12);
  });
});

/** Precision surviving a round trip through the Float32 instance buffer. */
const MATRIX_DIGITS = 5;

/** The single InstancedMesh every stamp draws from. */
const instanced = (shadows: FlatShadows): InstancedMesh =>
  shadows.group.children[0] as InstancedMesh;

interface Stamp {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
}

/** Decompose one instance's matrix back into the transform that composed it. */
const stampAt = (shadows: FlatShadows, index = 0): Stamp => {
  const stamp: Stamp = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(),
  };
  const m = new Matrix4();
  instanced(shadows).getMatrixAt(index, m);
  m.decompose(stamp.position, stamp.quaternion, stamp.scale);
  return stamp;
};

describe('FlatShadows is one instanced draw call', () => {
  it('N stamps → exactly one child in the group, count N', () => {
    const shadows = new FlatShadows(FLAT_SURFACE);
    for (let i = 0; i < 5; i += 1) shadows.addShadow(`s${i}`, 1).setPosition(i, 0);
    expect(shadows.group.children).toHaveLength(1);
    expect(instanced(shadows).count).toBe(5);
    expect(instanced(shadows)).toBeInstanceOf(InstancedMesh);
  });

  it('swap-removes the middle of three; the survivors keep their positions', () => {
    const shadows = new FlatShadows(FLAT_SURFACE);
    shadows.addShadow('a', 1).setPosition(1, 1);
    shadows.addShadow('b', 1).setPosition(2, 2);
    shadows.addShadow('c', 1).setPosition(3, 3);
    shadows.removeShadow('b');

    expect(shadows.group.children).toHaveLength(1);
    expect(instanced(shadows).count).toBe(2);
    const live = [stampAt(shadows, 0), stampAt(shadows, 1)].map((s) => [
      s.position.x,
      s.position.z,
    ]);
    expect(live).toContainEqual([1, 1]);
    expect(live).toContainEqual([3, 3]);
  });

  it('keeps moving a stamp whose slot changed under it', () => {
    const shadows = new FlatShadows(FLAT_SURFACE);
    shadows.addShadow('a', 1).setPosition(1, 1);
    const c = shadows.addShadow('c', 1);
    c.setPosition(3, 3);
    shadows.removeShadow('a'); // 'c' is swapped down into slot 0
    c.setPosition(7, 8);
    expect(instanced(shadows).count).toBe(1);
    expect(stampAt(shadows, 0).position.x).toBeCloseTo(7, MATRIX_DIGITS);
    expect(stampAt(shadows, 0).position.z).toBeCloseTo(8, MATRIX_DIGITS);
  });

  it('removing an unknown id is a no-op', () => {
    const shadows = new FlatShadows(FLAT_SURFACE);
    shadows.addShadow('a', 1).setPosition(1, 1);
    shadows.removeShadow('nobody');
    expect(instanced(shadows).count).toBe(1);
    expect(stampAt(shadows, 0).position.x).toBeCloseTo(1, MATRIX_DIGITS);
  });

  it('grows past the initial capacity with every matrix intact', () => {
    const shadows = new FlatShadows(FLAT_SURFACE);
    const n = 100; // > the 64-slot starting capacity
    for (let i = 0; i < n; i += 1) shadows.addShadow(`s${i}`, 1).setPosition(i, -i);

    expect(shadows.group.children).toHaveLength(1);
    expect(instanced(shadows).count).toBe(n);
    expect(instanced(shadows).instanceMatrix.count).toBeGreaterThanOrEqual(n);

    const first = stampAt(shadows, 0);
    expect(first.position.x).toBeCloseTo(0, MATRIX_DIGITS);
    expect(first.position.z).toBeCloseTo(0, MATRIX_DIGITS);
    const last = stampAt(shadows, n - 1);
    expect(last.position.x).toBeCloseTo(n - 1, MATRIX_DIGITS - 1);
    expect(last.position.z).toBeCloseTo(-(n - 1), MATRIX_DIGITS - 1);
  });
});

describe('FlatShadows.setSun', () => {
  const material = (shadows: FlatShadows): Color =>
    // Every stamp shares the one material — it hangs off the instanced mesh.
    (instanced(shadows).material as unknown as { color: Color }).color;

  it('presence 0 → the stamp value equals the ground (invisible)', () => {
    const shadows = new FlatShadows();
    shadows.addShadow('a', 1.5);
    shadows.setSun(1.0, 0.4, 0);
    expect(material(shadows).equals(new Color(SURFACE.ground))).toBe(true);
  });

  it('presence 1 → the full flat shadow value', () => {
    const shadows = new FlatShadows();
    shadows.addShadow('a', 1.5);
    shadows.setSun(1.0, 0.4, 1);
    expect(material(shadows).equals(new Color(SURFACE.shadow))).toBe(true);
  });

  it('stretches and offsets the stamp away from the sun; noon restores it', () => {
    const shadows = new FlatShadows();
    const radius = 2;
    const handle = shadows.addShadow('a', radius);
    handle.setPosition(5, -3);

    const az = 0.8;
    shadows.setSun(az, 0.1, 1);
    const e = stampEllipse(az, 0.1);
    const low = stampAt(shadows);
    // The radius rides in the scale now that the geometry is a unit disc.
    expect(low.scale.x).toBeCloseTo(radius * e.stretch, MATRIX_DIGITS);
    expect(low.scale.z).toBeCloseTo(radius, MATRIX_DIGITS); // short axis: the plain radius
    expect(low.position.x).toBeCloseTo(5 + e.dirX * e.offset * radius, MATRIX_DIGITS);
    expect(low.position.z).toBeCloseTo(-3 + e.dirZ * e.offset * radius, MATRIX_DIGITS);

    // Back to the noon reference: the original circle at the caster.
    shadows.setSun(az, STAMP_NOON_ALTITUDE, 1);
    const noon = stampAt(shadows);
    expect(noon.scale.x).toBeCloseTo(radius, MATRIX_DIGITS);
    expect(noon.position.x).toBeCloseTo(5, MATRIX_DIGITS);
    expect(noon.position.z).toBeCloseTo(-3, MATRIX_DIGITS);
  });

  it('applies the live ellipse to stamps added after setSun', () => {
    const shadows = new FlatShadows();
    shadows.setSun(2.2, 0.12, 1);
    shadows.addShadow('late', 1);
    expect(stampAt(shadows).scale.x).toBeCloseTo(
      stampEllipse(2.2, 0.12).stretch,
      MATRIX_DIGITS,
    );
  });
});

describe('FlatShadows lies on the ground it is given', () => {
  /**
   * A fixed 30° ramp climbing +x. Deliberately not the authored landscape:
   * this proves the pass USES the seam, not what the world's terrain
   * happens to be at some coordinate (which is free to change).
   */
  const SLOPE = Math.tan(Math.PI / 6);
  const RAMP_LEN = Math.hypot(SLOPE, 1);
  const ramp: Surface = {
    sampleHeight: (x) => x * SLOPE,
    normalAt: () => ({ x: -SLOPE / RAMP_LEN, y: 1 / RAMP_LEN, z: 0 }),
  };

  /** The stamp's own up axis in world space — the flat disc's normal. */
  const upAxis = (stamp: { quaternion: Quaternion }): Vector3 =>
    new Vector3(0, 1, 0).applyQuaternion(stamp.quaternion);

  it('a flat surface keeps the old behaviour: at the lift, dead level', () => {
    const shadows = new FlatShadows(FLAT_SURFACE);
    shadows.addShadow('a', 1.5).setPosition(9, -4);
    shadows.setSun(0.8, 0.35, 1);
    const stamp = stampAt(shadows);
    expect(stamp.position.y).toBeCloseTo(SHADOW_LIFT, MATRIX_DIGITS);
    const up = upAxis(stamp);
    expect(Math.abs(up.x)).toBeLessThan(1e-3);
    expect(Math.abs(up.y - 1)).toBeLessThan(1e-3);
    expect(Math.abs(up.z)).toBeLessThan(1e-3);
  });

  it('sits at sampleHeight + lift, and its up axis is the ground normal', () => {
    const shadows = new FlatShadows(ramp);
    shadows.addShadow('a', 2).setPosition(6, 3);
    shadows.setSun(0.8, 0.2, 1);
    const stamp = stampAt(shadows);

    // Sampled where the stamp ACTUALLY lands: the low sun has pushed it off
    // the caster, and on a slope that push changes the height.
    expect(stamp.position.y).toBeCloseTo(
      ramp.sampleHeight(stamp.position.x, stamp.position.z) + SHADOW_LIFT,
      MATRIX_DIGITS,
    );
    expect(stamp.position.y).not.toBeCloseTo(SHADOW_LIFT, 6);

    const n = ramp.normalAt(stamp.position.x, stamp.position.z);
    const up = upAxis(stamp);
    expect(Math.abs(up.x - n.x)).toBeLessThan(1e-3);
    expect(Math.abs(up.y - n.y)).toBeLessThan(1e-3);
    expect(Math.abs(up.z - n.z)).toBeLessThan(1e-3);
  });

  it('the sun ellipse still stretches and offsets on a slope', () => {
    const radius = 2;
    const shadows = new FlatShadows(ramp);
    shadows.addShadow('a', radius).setPosition(5, -3);

    const az = 0.8;
    shadows.setSun(az, 0.1, 1);
    const e = stampEllipse(az, 0.1);
    const stamp = stampAt(shadows);
    expect(stamp.scale.x).toBeCloseTo(radius * e.stretch, MATRIX_DIGITS);
    expect(stamp.scale.z).toBeCloseTo(radius, MATRIX_DIGITS); // short axis: the radius
    expect(stamp.position.x).toBeCloseTo(5 + e.dirX * e.offset * radius, MATRIX_DIGITS);
    expect(stamp.position.z).toBeCloseTo(-3 + e.dirZ * e.offset * radius, MATRIX_DIGITS);

    // ...and the long axis still points away from the sun — now measured in
    // the tilted disc's own plane, which is where the away direction lands
    // once it is carried onto the slope.
    const n = ramp.normalAt(0, 0);
    const tilt = new Quaternion().setFromUnitVectors(
      new Vector3(0, 1, 0),
      new Vector3(n.x, n.y, n.z),
    );
    const want = new Vector3(e.dirX, 0, e.dirZ).applyQuaternion(tilt);
    const got = new Vector3(1, 0, 0).applyQuaternion(stamp.quaternion);
    expect(got.dot(want)).toBeCloseTo(1, 6);
  });

  it('follows the world terrain by default — no caster ever says a height', () => {
    // Default construction is the world's own surface. Compared against the
    // seam rather than a number: the map is allowed to change.
    const shadows = new FlatShadows();
    shadows.addShadow('a', 1).setPosition(18, -9);
    shadows.setSun(0.5, STAMP_NOON_ALTITUDE, 1);
    const stamp = stampAt(shadows);
    expect(stamp.position.y).toBeCloseTo(
      ROLLING_SURFACE.sampleHeight(stamp.position.x, stamp.position.z) + SHADOW_LIFT,
      MATRIX_DIGITS,
    );
  });
});
