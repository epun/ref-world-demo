/**
 * Runtime taste gates (TASTE §7) — synthetic-buffer tests.
 *
 * Every buffer here is built by hand so each gate's pass/fail edge is exact
 * and deterministic; no canvas, no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  achromaticGate,
  auditDampingGate,
  densityGate,
  stillnessGate,
  valueHistogramGate,
} from '../../src/taste/gates';

/** build an rgba buffer from a list of opaque rgb pixels. */
function rgba(pixels: [number, number, number][]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

function fill(count: number, rgb: [number, number, number]): [number, number, number][] {
  return Array.from({ length: count }, () => rgb);
}

describe('achromaticGate', () => {
  it('passes a plain grey buffer — quieter than the taste is never a violation', () => {
    const result = achromaticGate(rgba(fill(64, [128, 128, 128])));
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('mean saturation');
  });

  it('fails a fully saturated red buffer on both saturation and accent ration', () => {
    const result = achromaticGate(rgba(fill(64, [255, 0, 0])));
    expect(result.pass).toBe(false);
  });

  it('tolerates a rationed accent below 2% coverage', () => {
    // 1 accent pixel out of 100 — one small marker, as the taste allows
    const result = achromaticGate(
      rgba([...fill(99, [182, 182, 175]), [251, 84, 41]]),
    );
    expect(result.pass).toBe(true);
  });

  it('fails an empty buffer', () => {
    expect(achromaticGate(new Uint8ClampedArray(0)).pass).toBe(false);
  });
});

describe('valueHistogramGate', () => {
  // luma 0.74 as a grey value: 0.74 * 255 ≈ 189
  const ground: [number, number, number] = [189, 189, 189];
  const nearBlack: [number, number, number] = [10, 10, 10];
  const light: [number, number, number] = [230, 230, 230];

  it('passes 80% ground-luma grey with 5% near-black — small figure, huge field', () => {
    const result = valueHistogramGate(
      rgba([...fill(80, ground), ...fill(5, nearBlack), ...fill(15, light)]),
    );
    expect(result.pass).toBe(true);
  });

  it('fails when 40% of the frame is near-black', () => {
    const result = valueHistogramGate(
      rgba([...fill(60, ground), ...fill(40, nearBlack)]),
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('near-black');
  });

  it('fails when the histogram mode is nowhere near the ground luma', () => {
    // a frame dominated by highlights — mode ≈ 0.9, far from 0.74
    const result = valueHistogramGate(rgba(fill(100, light)));
    expect(result.pass).toBe(false);
  });
});

describe('densityGate', () => {
  it('passes when mean coverage sits near the measured 0.39', () => {
    const result = densityGate([0.3, 0.4, 0.45, 0.38]);
    expect(result.pass).toBe(true);
  });

  it('fails a packed scene', () => {
    const result = densityGate([0.8, 0.85, 0.9]);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('packed');
  });

  it('fails an over-sparse scene', () => {
    expect(densityGate([0.05, 0.1]).pass).toBe(false);
  });

  it('fails with no samples', () => {
    expect(densityGate([]).pass).toBe(false);
  });
});

describe('stillnessGate', () => {
  it('fails when any element has exactly zero variance — nothing fully arrests', () => {
    const frozen = [
      { x: 3, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 4 },
    ];
    const result = stillnessGate([frozen]);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('arrested');
  });

  it('passes elements that drift, however slightly', () => {
    const drifting = [
      { x: 3, y: 4 },
      { x: 3.0003, y: 3.9998 },
      { x: 2.9998, y: 4.0002 },
    ];
    expect(stillnessGate([drifting]).pass).toBe(true);
  });

  it('fails a mixed set where one element froze', () => {
    const drifting = [
      { x: 0, y: 0 },
      { x: 0.001, y: -0.001 },
    ];
    const frozen = [
      { x: 9, y: 9 },
      { x: 9, y: 9 },
    ];
    expect(stillnessGate([drifting, frozen]).pass).toBe(false);
  });

  it('fails with no elements sampled', () => {
    expect(stillnessGate([]).pass).toBe(false);
  });
});

describe('auditDampingGate', () => {
  it('passes on an empty spring registry', () => {
    const result = auditDampingGate();
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
