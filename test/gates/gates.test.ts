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
  grainGate,
  markSetGate,
  stillnessGate,
  valueHistogramGate,
} from '../../src/taste/gates';
import { GRAIN, SURFACE } from '../../src/taste/tokens';

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
  // The gate measures against the CONFIGURED paper (SURFACE.ground), which
  // the panel's color picker may move off the measured groundLuma — so the
  // fixtures derive from the token rather than hardcoding a grey.
  const paper = parseInt(SURFACE.ground.slice(1, 3), 16);
  const ground: [number, number, number] = [paper, paper, paper];
  const nearBlack: [number, number, number] = [10, 10, 10];
  /** A value far enough from the paper to miss the ±0.08 window. */
  const offPaper = paper > 128 ? paper - 60 : paper + 60;
  const light: [number, number, number] = [offPaper, offPaper, offPaper];

  it('passes 80% paper-value grey with 5% near-black — small figure, huge field', () => {
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

  it('fails when the histogram mode is nowhere near the paper value', () => {
    // a frame dominated by a value well outside the paper's ±0.08 window
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

describe('grainGate', () => {
  it('passes the token amplitude', () => {
    const result = grainGate(GRAIN.amplitude);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('uniform by construction');
  });

  it('fails at zero — the steady grain is a defining signal', () => {
    const result = grainGate(0);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('defining signal');
  });

  it('fails above the polished ceiling', () => {
    const result = grainGate(0.2);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('louder than polished');
  });

  it('fails a non-finite reading', () => {
    expect(grainGate(Number.NaN).pass).toBe(false);
  });
});

describe('markSetGate', () => {
  it('passes clean icon/rule/border elements', () => {
    const result = markSetGate([
      { name: 'draw control', filled: false, shadowed: false },
      { name: 'join line', filled: false, shadowed: false },
    ]);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('icon');
  });

  it('fails a filled panel', () => {
    const result = markSetGate([{ name: 'hud card', filled: true, shadowed: false }]);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('filled panel');
  });

  it('fails a shadowed element', () => {
    expect(markSetGate([{ name: 'popup', filled: false, shadowed: true }]).pass).toBe(false);
  });

  it('reports a ruled exemption without failing', () => {
    const result = markSetGate([
      { name: 'minimap', filled: true, shadowed: false, exemptReason: 'torn-paper ruling' },
    ]);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('torn-paper ruling');
  });

  it('fails with no elements sampled', () => {
    expect(markSetGate([]).pass).toBe(false);
  });
});
