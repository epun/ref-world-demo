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
 *   2a. the rate it measures is PER FRAGMENT, off the screen-space derivative,
 *      with the frame's scalar only as the floor under it — the 2026-09-17
 *      SECOND report (*"when I rotate the view too much on mobile"*) was the
 *      half a per-frame scalar cannot express: the ground's depth axis
 *      foreshortens by 1/sin(tilt), so a low orbit samples it several times
 *      more coarsely than the frame's screen-plane number says;
 *   2b. the water's marks ride it too. They did not before that report, and
 *      the sea was the worse half of the picture;
 *   3. the shader declares `precision highp float` itself. An iOS GPU runs a
 *      mediump float at 16 bits, where a world coordinate of 2232 (±372 units
 *      × 6, which the shadow tint does) has a spacing of two and every
 *      `fract` below it returns the same number over whole stretches of the
 *      map.
 *
 * A regex here, not a compiler: same reasoning as
 * test/world/ghibli/shaders.test.ts, which this sits beside.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CameraRig } from '../../../src/world/camera';
import { createGroundMaterial } from '../../../src/world/ghibli/ground';
import { createSeaSurfaceMaterial } from '../../../src/world/ghibli/water';
import {
  TOON_LIGHTING_GLSL,
  setToonPixelScale,
  toonUniforms,
} from '../../../src/world/toon';

/** Comments blanked, newlines kept — the trick scripts/gates/static.ts and
 * test/world/ghibli/shaders.test.ts both use, for the same reason: the module
 * headers below DISCUSS every term the scans forbid or require. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

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

  it('measures the rate PER FRAGMENT, from the screen-space derivative', () => {
    // The 2026-09-17 second report. A per-frame scalar cannot express an
    // anisotropic, tilt-dependent, per-fragment sampling rate; the derivative
    // can, and it is the fix. Both axes, by LENGTH (the world distance a pixel
    // step covers) and not fwidth's per-component sum, which mixes the two
    // screen axes and so swings with the azimuth at a fixed zoom.
    expect(TOON_LIGHTING_GLSL).toContain('float toonUnitsPerPxAt(vec2 p)');
    expect(TOON_LIGHTING_GLSL).toContain('max(length(dFdx(p)), length(dFdy(p)))');
    // …and the frame's scalar stays as the FLOOR under it, so nothing is ever
    // band-limited LESS than it was before the measure existed.
    expect(TOON_LIGHTING_GLSL).toContain('max(gToonUnitsPerPx, uToonUnitsPerPx)');
  });

  it('keeps the ramp it was tuned with — 2.5 px a cycle to 1.5', () => {
    // Documented in CLAUDE.md and derived in the shader's own header. The
    // per-fragment measure is CALIBRATED to this ramp rather than the other
    // way round, which is what keeps the default view unchanged.
    expect(TOON_LIGHTING_GLSL).toContain('smoothstep(1.5, 2.5, pxPerCycle)');
  });

  it('calibrates the measure against the camera rig own iso tilt', () => {
    // The measure is a RATIO to what the default framing reads: on flat
    // ground the worst screen axis is the depth axis, coarser by 1/sin(tilt),
    // so multiplying by sin(iso) makes a default-framed flat ground read back
    // exactly `uToonUnitsPerPx`. The number therefore belongs to the camera,
    // and this is the pin that the two have not drifted apart.
    const isoElevation = new CameraRig(1.6).elevation;
    const calibration = Math.sin(isoElevation);
    expect(calibration).toBeCloseTo(0.57735, 5);
    expect(TOON_LIGHTING_GLSL).toContain(`const float TOON_PX_CAL = ${calibration.toFixed(6)};`);
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

  it('carries the tilt as a ratio, so the default view writes what it always did', () => {
    const before = toonUniforms.uToonUnitsPerPx.value;
    const iso = new CameraRig(1.6).elevation;
    // The iso tilt is a ratio of exactly 1 — the same number with the tilt as
    // without it, which is why no existing caller or test had to change.
    setToonPixelScale(0.05, iso);
    expect(toonUniforms.uToonUnitsPerPx.value).toBeCloseTo(0.05, 12);
    // The rig's lowest orbit (ELEVATION_MIN 0.3 rad, src/world/camera.ts) is
    // 1.95x as coarse on the ground, at an unchanged zoom.
    setToonPixelScale(0.05, 0.3);
    expect(toonUniforms.uToonUnitsPerPx.value / 0.05).toBeCloseTo(
      Math.sin(iso) / Math.sin(0.3),
      6,
    );
    expect(toonUniforms.uToonUnitsPerPx.value / 0.05).toBeGreaterThan(1.9);
    // A degenerate tilt is clamped rather than divided by zero.
    setToonPixelScale(0.05, 0);
    expect(Number.isFinite(toonUniforms.uToonUnitsPerPx.value)).toBe(true);
    setToonPixelScale(before);
    expect(toonUniforms.uToonUnitsPerPx.value).toBe(before);
  });
});

describe('the ghibli water', () => {
  const source = createSeaSurfaceMaterial().fragmentShader;
  const module = code(
    readFileSync(join(process.cwd(), 'src', 'world', 'ghibli', 'water.ts'), 'utf8'),
  );

  it('measures the fragment once, on the raw varying, at the top of main', () => {
    // Derivatives are undefined in non-uniform control flow, and `p` is
    // advected by the wind a few lines down — so it is the VARYING that is
    // measured, once, before anything branches.
    expect(module).toContain('toonMeasurePixel(vToonWorldPos.xz);');
    expect(module.match(/toonMeasurePixel\(/g)).toHaveLength(1);
    const main = source.indexOf('void main()');
    const measure = source.indexOf('toonMeasurePixel(vToonWorldPos.xz);');
    expect(measure).toBeGreaterThan(main);
    // Nothing that samples the surface comes before it.
    expect(source.slice(main, measure)).not.toContain('toonFbm(');
  });

  it('band-limits every fbm term it draws with', () => {
    // A STATEMENT-level scan, so the next mark added to this shader cannot
    // arrive without one: every statement that calls `toonFbm` has to call
    // `toonBandLimit` as well.
    const naked = module
      .split(';')
      .filter((s) => s.includes('toonFbm(') && !s.includes('toonBandLimit('));
    expect(naked).toEqual([]);
    // …and there are marks here to band-limit in the first place.
    expect(module.match(/toonFbm\(/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  it('limits each mark at its OWN base frequency', () => {
    // The pen and its crawling twin; the painterly swell (1/SWELL_SCALE); the
    // lanes' wander; the dash, at the rate it crosses the lanes (3.7 per lane
    // over LINE_SPACING) rather than the slower rate it walks along one; the
    // sparkle lattice (1/SPARKLE_CELL); the foam pen, the finest term on the
    // surface; and the streaks, across the flow.
    for (const cycles of [0.55, 0.8, 1 / 15, 0.18, 3.7 / 7, 1 / 1.3, 1.9, 1.6]) {
      expect(source, `band limit at ${cycles} cycles a unit`).toContain(
        `toonBandLimit(${Number.isInteger(cycles) ? `${cycles}.0` : cycles})`,
      );
    }
  });

  it('fades a mark to its MEAN, not to zero', () => {
    // A 2-octave fbm x1.3333 averages 0.5 and a 3-octave one 0.58332 — so a
    // faded term leaves the edge it wobbles where it was and the rim it erodes
    // the width it had. Fading to zero would move the sea's colour bands and
    // shrink the foam as the camera pulled out.
    expect(source).toContain('0.4999875');
    expect(source).toContain('0.58331875');
    // The lanes' wander is x7 world units rather than x1.3333: 0.375 * 7.
    expect(source).toContain('2.625');
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

  it('measures the fragment once, at the top of main, before any mark', () => {
    const main = source.indexOf('void main()');
    const measure = source.indexOf('toonMeasurePixel(vToonWorldPos.xz);');
    expect(measure).toBeGreaterThan(main);
    // No mark and no texture read between the two: the terrace marks and the
    // stipple all read the measured rate.
    expect(source.slice(main, measure)).not.toContain('ggGroundNoise(');
    expect(source.slice(main, measure)).not.toContain('toonBandLimit(');
  });
});

describe('the stock toon injection', () => {
  it('measures the fragment OUTSIDE the style branch', () => {
    // `applyToon` replaces `#include <opaque_fragment>` on a stock material —
    // the props, the creatures, the eggs, the marks. `uToonOn` is uniform, so
    // the branch is legal control flow for a derivative today, but the measure
    // is put in front of it anyway: whatever the stock chain around it grows
    // into, a derivative must not end up inside a branch on a texture read.
    const source = readFileSync(
      join(process.cwd(), 'src', 'world', 'toon.ts'),
      'utf8',
    );
    const injection = source.slice(source.indexOf('const TOON_OPAQUE_GLSL'));
    const measure = injection.indexOf('toonMeasurePixel(vToonWorldPos.xz);');
    const branch = injection.indexOf('if (uToonOn > 0.5)');
    expect(measure).toBeGreaterThan(0);
    expect(measure).toBeLessThan(branch);
  });
});
