/**
 * Sun-driven stamp ellipse tests — pure math from src/world/shadows.ts plus
 * the FlatShadows value/transform behavior (no WebGL: meshes and materials
 * are plain scene-graph objects in node).
 */

import { describe, expect, it } from 'vitest';
import { Color, Quaternion, Vector3 } from 'three';
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

describe('FlatShadows.setSun', () => {
  const material = (shadows: FlatShadows): Color =>
    // Every stamp shares the one material — read it off any stamp mesh.
    ((shadows.group.children[0] as { material?: { color: Color } }).material as {
      color: Color;
    }).color;

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
    const mesh = shadows.group.children[0]!;

    const az = 0.8;
    shadows.setSun(az, 0.1, 1);
    const e = stampEllipse(az, 0.1);
    expect(mesh.scale.x).toBeCloseTo(e.stretch, 12);
    expect(mesh.scale.z).toBe(1); // short axis untouched — radius is baked in
    expect(mesh.position.x).toBeCloseTo(5 + e.dirX * e.offset * radius, 12);
    expect(mesh.position.z).toBeCloseTo(-3 + e.dirZ * e.offset * radius, 12);

    // Back to the noon reference: the original circle at the caster.
    shadows.setSun(az, STAMP_NOON_ALTITUDE, 1);
    expect(mesh.scale.x).toBeCloseTo(1, 12);
    expect(mesh.position.x).toBeCloseTo(5, 12);
    expect(mesh.position.z).toBeCloseTo(-3, 12);
  });

  it('applies the live ellipse to stamps added after setSun', () => {
    const shadows = new FlatShadows();
    shadows.setSun(2.2, 0.12, 1);
    shadows.addShadow('late', 1);
    const mesh = shadows.group.children[0]!;
    expect(mesh.scale.x).toBeCloseTo(stampEllipse(2.2, 0.12).stretch, 12);
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
  const upAxis = (mesh: { quaternion: Quaternion }): Vector3 =>
    new Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);

  it('a flat surface keeps the old behaviour: at the lift, dead level', () => {
    const shadows = new FlatShadows(FLAT_SURFACE);
    shadows.addShadow('a', 1.5).setPosition(9, -4);
    shadows.setSun(0.8, 0.35, 1);
    const mesh = shadows.group.children[0]!;
    expect(mesh.position.y).toBeCloseTo(SHADOW_LIFT, 12);
    const up = upAxis(mesh);
    expect(Math.abs(up.x)).toBeLessThan(1e-3);
    expect(Math.abs(up.y - 1)).toBeLessThan(1e-3);
    expect(Math.abs(up.z)).toBeLessThan(1e-3);
  });

  it('sits at sampleHeight + lift, and its up axis is the ground normal', () => {
    const shadows = new FlatShadows(ramp);
    shadows.addShadow('a', 2).setPosition(6, 3);
    shadows.setSun(0.8, 0.2, 1);
    const mesh = shadows.group.children[0]!;

    // Sampled where the stamp ACTUALLY lands: the low sun has pushed it off
    // the caster, and on a slope that push changes the height.
    expect(mesh.position.y).toBeCloseTo(
      ramp.sampleHeight(mesh.position.x, mesh.position.z) + SHADOW_LIFT,
      12,
    );
    expect(mesh.position.y).not.toBeCloseTo(SHADOW_LIFT, 6);

    const n = ramp.normalAt(mesh.position.x, mesh.position.z);
    const up = upAxis(mesh);
    expect(Math.abs(up.x - n.x)).toBeLessThan(1e-3);
    expect(Math.abs(up.y - n.y)).toBeLessThan(1e-3);
    expect(Math.abs(up.z - n.z)).toBeLessThan(1e-3);
  });

  it('the sun ellipse still stretches and offsets on a slope', () => {
    const radius = 2;
    const shadows = new FlatShadows(ramp);
    shadows.addShadow('a', radius).setPosition(5, -3);
    const mesh = shadows.group.children[0]!;

    const az = 0.8;
    shadows.setSun(az, 0.1, 1);
    const e = stampEllipse(az, 0.1);
    expect(mesh.scale.x).toBeCloseTo(e.stretch, 12);
    expect(mesh.scale.z).toBe(1); // short axis untouched — radius is baked in
    expect(mesh.position.x).toBeCloseTo(5 + e.dirX * e.offset * radius, 12);
    expect(mesh.position.z).toBeCloseTo(-3 + e.dirZ * e.offset * radius, 12);

    // ...and the long axis still points away from the sun — now measured in
    // the tilted disc's own plane, which is where the away direction lands
    // once it is carried onto the slope.
    const n = ramp.normalAt(0, 0);
    const tilt = new Quaternion().setFromUnitVectors(
      new Vector3(0, 1, 0),
      new Vector3(n.x, n.y, n.z),
    );
    const want = new Vector3(e.dirX, 0, e.dirZ).applyQuaternion(tilt);
    const got = new Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
    expect(got.dot(want)).toBeCloseTo(1, 6);
  });

  it('follows the world terrain by default — no caster ever says a height', () => {
    // Default construction is the world's own surface. Compared against the
    // seam rather than a number: the map is allowed to change.
    const shadows = new FlatShadows();
    shadows.addShadow('a', 1).setPosition(18, -9);
    shadows.setSun(0.5, STAMP_NOON_ALTITUDE, 1);
    const mesh = shadows.group.children[0]!;
    expect(mesh.position.y).toBeCloseTo(
      ROLLING_SURFACE.sampleHeight(mesh.position.x, mesh.position.z) + SHADOW_LIFT,
      12,
    );
  });
});
