/**
 * THE ALIASING BAND LIMIT (src/world/toon.ts `toonBandLimit`, and the ghibli
 * ground's blade stipple that rides it).
 *
 * The 2026-09-17 user report — *"on mobile when you zoom out the shader
 * glitches out and looks like camo"* — had two causes and this is the second
 * one. Every world-space noise term in the cel chain has a fixed frequency in
 * WORLD units, and the phone's zoom floor is 1.9 world units a pixel
 * (measured, scratch/phone-zoom-camo.mjs): the cel terminator's wobble lands
 * at 0.26 pixels a cycle and the ground's blade stipple at 0.15, so both are
 * sampled more than ten times past nyquist and turn into a hard mottle that
 * changes with every pan.
 *
 * Three things have to stay true, and none of them is visible in a screenshot:
 *
 *   1. the limit function EXISTS in the shader, with the uniform it reads
 *      declared — a missing uniform is a black frame on one style;
 *   2. every term the audit found rides it, by name — which is what stops the
 *      next dial being added without one;
 *   3. the shader declares `precision highp float` itself. An iOS GPU runs a
 *      mediump float at 16 bits, where a world coordinate of 2232 (±372 units
 *      × 6, which the shadow tint does) has a spacing of two and every
 *      `fract` below it returns the same number over whole stretches of the
 *      map.
 *
 * A regex here, not a compiler: same reasoning as
 * test/world/ghibli/shaders.test.ts, which this sits beside.
 */

import { describe, expect, it } from 'vitest';
import { createGroundMaterial } from '../../../src/world/ghibli/ground';
import {
  TOON_LIGHTING_GLSL,
  setToonPixelScale,
  toonUniforms,
} from '../../../src/world/toon';

describe('toonBandLimit', () => {
  it('is declared once, with its uniform', () => {
    expect(TOON_LIGHTING_GLSL).toContain('float toonBandLimit(float cyclesPerUnit)');
    expect(TOON_LIGHTING_GLSL.match(/float toonBandLimit\(/g)).toHaveLength(1);
    expect(TOON_LIGHTING_GLSL).toContain('uniform float uToonUnitsPerPx;');
  });

  it('declares highp itself rather than trusting the driver', () => {
    expect(TOON_LIGHTING_GLSL).toContain('precision highp float;');
  });

  it('band-limits the terminator wobble and the shadow tint break-up', () => {
    // The two terms the audit found, each with its own base frequency.
    expect(TOON_LIGHTING_GLSL).toContain('toonBandLimit(2.0)');
    expect(TOON_LIGHTING_GLSL).toContain('toonBandLimit(6.0)');
  });

  it('defaults to the framing the look was tuned at', () => {
    // 0.05 world units a pixel — the default view. Nothing is limited there,
    // which is why a unit test and a first frame see the shipped look.
    expect(toonUniforms.uToonUnitsPerPx.value).toBe(0.05);
  });
});

describe('setToonPixelScale', () => {
  it('writes the shared uniform, and never a zero', () => {
    const before = toonUniforms.uToonUnitsPerPx.value;
    setToonPixelScale(1.9);
    expect(toonUniforms.uToonUnitsPerPx.value).toBe(1.9);
    setToonPixelScale(0);
    expect(toonUniforms.uToonUnitsPerPx.value).toBeGreaterThan(0);
    setToonPixelScale(before);
    expect(toonUniforms.uToonUnitsPerPx.value).toBe(before);
  });
});

describe('the ghibli ground', () => {
  const ground = createGroundMaterial();
  const source = ground.material.fragmentShader;

  it('says highp at its own head, before its own constants', () => {
    expect(source.indexOf('precision highp float;')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('precision highp float;')).toBeLessThan(source.indexOf('void main()'));
  });

  it('band-limits the blade stipple, its speck and both ink specks', () => {
    // The stipple's stroke frequency and its speck's, which is twice it.
    expect(source).toContain('toonBandLimit(3.5)');
    expect(source).toContain('toonBandLimit(7.0)');
    // …and the drawn marks: the dirt path's tread speck and broken rim, and
    // the fire's ash speck.
    expect(source).toContain('toonBandLimit(2.9)');
    expect(source).toContain('toonBandLimit(1.35)');
    expect(source).toContain('toonBandLimit(4.3)');
  });

  it('shares the band-limit uniform by reference with every other material', () => {
    const uniforms = ground.material.uniforms as Record<string, { value: number }>;
    expect(uniforms['uToonUnitsPerPx']).toBe(toonUniforms.uToonUnitsPerPx);
  });
});
