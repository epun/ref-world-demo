/**
 * Speech bubble — pure tests over the node-safe exports of bubble.ts: the
 * emote→emoji map, the seeded outline waver, and the luma grayscale pass.
 * No canvas, no renderer — importing the module in node must not throw
 * (canvas creation is lazy inside createBubble, which is never called here).
 */

import { describe, expect, it } from 'vitest';
import {
  BUBBLE_EMOJI,
  bubbleOutlinePoints,
  toGrayscaleLuma,
} from '../../src/character/bubble';
import { EMOTE_NAMES } from '../../src/net/protocol';

describe('bubble emoji map', () => {
  it('covers all protocol emotes exactly', () => {
    expect(Object.keys(BUBBLE_EMOJI).sort()).toEqual([...EMOTE_NAMES].sort());
  });

  it('maps every emote to a non-empty glyph', () => {
    for (const name of EMOTE_NAMES) {
      expect(BUBBLE_EMOJI[name].length).toBeGreaterThan(0);
    }
  });
});

describe('outline waver', () => {
  it('is deterministic: same seed, same points', () => {
    expect(bubbleOutlinePoints(12.34)).toEqual(bubbleOutlinePoints(12.34));
  });

  it('decorrelates: different seeds waver differently', () => {
    const a = bubbleOutlinePoints(1);
    const b = bubbleOutlinePoints(2);
    expect(a).not.toEqual(b);
  });

  it('forms a closed organic loop inside the unit square', () => {
    const pts = bubbleOutlinePoints(7.7);
    expect(pts.length).toBeGreaterThanOrEqual(8);
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
    }
  });

  it('actually wavers — never a perfect ellipse', () => {
    // Radial distance from the ellipse would be constant 1 after normalizing
    // by the base radii; the waver must spread it.
    const pts = bubbleOutlinePoints(3.21);
    const radii = pts.map((p, i) => {
      const a = (i / pts.length) * Math.PI * 2;
      const dx = p.x - 0.5 - Math.cos(a) * 0.42;
      const dy = p.y - 0.42 - Math.sin(a) * 0.33;
      return Math.hypot(dx, dy);
    });
    expect(Math.max(...radii)).toBeGreaterThan(0.005);
  });
});

describe('grayscale luma pass', () => {
  it('converts a saturated pixel to its luma', () => {
    // Pure red, full alpha.
    const out = toGrayscaleLuma(new Uint8ClampedArray([255, 0, 0, 255]));
    const luma = Math.round(0.2126 * 255);
    expect([...out]).toEqual([luma, luma, luma, 255]);
  });

  it('equalizes channels for every pixel and keeps alpha', () => {
    const input = new Uint8ClampedArray([10, 200, 60, 128, 0, 0, 255, 7]);
    const out = toGrayscaleLuma(input);
    expect(out.length).toBe(input.length);
    for (let i = 0; i + 3 < out.length; i += 4) {
      expect(out[i]).toBe(out[i + 1]);
      expect(out[i + 1]).toBe(out[i + 2]);
      expect(out[i + 3]).toBe(input[i + 3]);
    }
  });

  it('leaves achromatic pixels achromatic (identity on grays)', () => {
    const out = toGrayscaleLuma(new Uint8ClampedArray([80, 80, 80, 255]));
    expect([...out]).toEqual([80, 80, 80, 255]);
  });

  it('does not mutate its input', () => {
    const input = new Uint8ClampedArray([255, 0, 0, 255]);
    toGrayscaleLuma(input);
    expect([...input]).toEqual([255, 0, 0, 255]);
  });
});
