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
  createBubble,
  toGrayscaleLuma,
} from '../../src/character/bubble';
import { EMOTE_NAMES } from '../../src/net/protocol';
import { OVERLAY_LAYER } from '../../src/world/layers';

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

describe('ink exemption (taste §6 emoji carve-out)', () => {
  it('lives only on the overlay layer, never the default scene layer', () => {
    const bubble = createBubble({ seed: 1.5, anchorY: 3.5 });
    // set(), not enable(): membership in layer 0 would put the sprite back
    // into the beauty render, where the ink quantize/exposure chain would
    // wash the emoji's native color.
    expect(bubble.object.layers.mask).toBe(1 << OVERLAY_LAYER);
    expect(bubble.object.layers.mask & 1).toBe(0);
    bubble.dispose();
  });

  it('overlay layer is not the default camera layer', () => {
    expect(OVERLAY_LAYER).not.toBe(0);
  });
});

describe('screen-space legibility floor (qa audit d4)', () => {
  /** Settle the entrance well past its spring window. */
  function settle(bubble: ReturnType<typeof createBubble>): void {
    for (let t = 0; t < 3000; t += 16) bubble.update(16, t);
  }

  it('holds pure world-proportional size without a feed (headless default)', () => {
    const bubble = createBubble({ seed: 1.5, anchorY: 3.5 });
    bubble.show('happy');
    settle(bubble);
    expect(bubble.object.scale.x).toBeCloseTo(1.1, 3); // BUBBLE_SIZE
    bubble.dispose();
  });

  it('never renders under 44 screen pixels once fed world-units-per-pixel', () => {
    const bubble = createBubble({ seed: 1.5, anchorY: 3.5 });
    // 40-unit frustum over an 800px viewport at zoom 1 → 0.05 units/px.
    bubble.setWorldUnitsPerPixel(0.05);
    bubble.show('happy');
    settle(bubble);
    const px = bubble.object.scale.x / 0.05;
    expect(px).toBeGreaterThanOrEqual(44 - 1e-6);
    bubble.dispose();
  });

  it('clamps above the proportional size, never below it (zoomed in)', () => {
    const bubble = createBubble({ seed: 1.5, anchorY: 3.5 });
    // Close zoom: 0.005 units/px → the floor (0.22 units) sits far below the
    // proportional 1.1 — the world size must win untouched.
    bubble.setWorldUnitsPerPixel(0.005);
    bubble.show('happy');
    settle(bubble);
    expect(bubble.object.scale.x).toBeCloseTo(1.1, 3);
    bubble.dispose();
  });

  it('ignores a zero/invalid feed', () => {
    const bubble = createBubble({ seed: 1.5, anchorY: 3.5 });
    bubble.setWorldUnitsPerPixel(0);
    bubble.setWorldUnitsPerPixel(Number.NaN);
    bubble.show('happy');
    settle(bubble);
    expect(bubble.object.scale.x).toBeCloseTo(1.1, 3);
    bubble.dispose();
  });
});
