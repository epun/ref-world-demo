/**
 * The Surface seam (PLAN §7.2) — pure. No WebGL, no DOM.
 *
 * The contract other systems build against: sample a height and an up-normal
 * and nothing else derives one. These pin that ROLLING_SURFACE really is the
 * landscape's terrain (not a copy of it that could drift), that
 * FLAT_SURFACE is the y = 0 world it replaced, and that both hand back
 * fresh, unit-length normals.
 */

import { describe, expect, it } from 'vitest';
import { terrainHeight, terrainNormal, WATER_BODIES, waterLevel } from '../../src/world/landscape';
import { FLAT_SURFACE, ROLLING_SURFACE, type Surface } from '../../src/world/surface';

const PROBES: [number, number][] = [];
for (let i = 0; i < 200; i++) {
  PROBES.push([-110 + ((i * 137) % 220), -110 + ((i * 61) % 220)]);
}

describe('surface — the rolling world', () => {
  it('is the landscape terrain, sample for sample', () => {
    for (const [x, z] of PROBES) {
      expect(ROLLING_SURFACE.sampleHeight(x, z)).toBe(terrainHeight(x, z));
      expect(ROLLING_SURFACE.normalAt(x, z)).toEqual(terrainNormal(x, z));
    }
  });

  it('puts every water body on its own flat level', () => {
    for (const body of WATER_BODIES) {
      expect(ROLLING_SURFACE.sampleHeight(body.x, body.z)).toBe(waterLevel(body));
    }
  });

  it('is flat on the hatch clearing', () => {
    expect(ROLLING_SURFACE.sampleHeight(0, 0)).toBe(0);
    const n = ROLLING_SURFACE.normalAt(0, 0);
    expect(n.y).toBe(1);
    // Math.abs: a zero gradient divided out comes back as -0.
    expect(Math.abs(n.x)).toBe(0);
    expect(Math.abs(n.z)).toBe(0);
  });
});

describe('surface — the flat world', () => {
  it('is y = 0 with a straight up normal everywhere', () => {
    for (const [x, z] of PROBES) {
      expect(FLAT_SURFACE.sampleHeight(x, z)).toBe(0);
      expect(FLAT_SURFACE.normalAt(x, z)).toEqual({ x: 0, y: 1, z: 0 });
    }
  });

  it('hands back a fresh normal each call — no shared vector to mutate', () => {
    const a = FLAT_SURFACE.normalAt(0, 0);
    a.y = 99;
    expect(FLAT_SURFACE.normalAt(0, 0).y).toBe(1);
  });
});

describe('surface — both implement the same seam', () => {
  const surfaces: [string, Surface][] = [
    ['rolling', ROLLING_SURFACE],
    ['flat', FLAT_SURFACE],
  ];

  it('answers with a finite height and a unit normal', () => {
    for (const [name, surface] of surfaces) {
      for (const [x, z] of PROBES) {
        expect(Number.isFinite(surface.sampleHeight(x, z)), name).toBe(true);
        const n = surface.normalAt(x, z);
        expect(Math.hypot(n.x, n.y, n.z), name).toBeCloseTo(1, 12);
        // The terrain terraces, so its risers tilt: 0.8 is the flattest
        // normal the 0.6 slope bound allows.
        expect(n.y, name).toBeGreaterThan(0.8);
      }
    }
  });
});
