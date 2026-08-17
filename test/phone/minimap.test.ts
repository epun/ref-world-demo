/**
 * Minimap pure geometry: roster→canvas mapping, cluster dot sizing, heading
 * unwrap, and the deterministic wavering border.
 */

import { describe, expect, it } from 'vitest';
import {
  BORDER_WAVER,
  MAP_INSET,
  nearestAngleTarget,
  peerDotRadius,
  wavyBorderPoints,
  worldToMap,
  type MapFrame,
} from '../../src/phone/minimap';

const frame: MapFrame = { w: 280, h: 200, inset: 14 };

describe('worldToMap', () => {
  it('maps the world origin to the frame center', () => {
    const at = worldToMap(0, 0, 48, frame);
    expect(at.px).toBeCloseTo(frame.w / 2);
    expect(at.py).toBeCloseTo(frame.h / 2);
  });

  it('fits the world square inside the smaller usable dimension', () => {
    const extent = 48;
    const usable = Math.min(frame.w, frame.h) - frame.inset * 2;
    const corner = worldToMap(extent, extent, extent, frame);
    expect(corner.px - frame.w / 2).toBeCloseTo(usable / 2);
    expect(corner.py - frame.h / 2).toBeCloseTo(usable / 2);
    // Inside the inset on the governing axis.
    expect(corner.py).toBeLessThanOrEqual(frame.h - frame.inset);
  });

  it('scales uniformly — no stretch between axes', () => {
    const a = worldToMap(10, 0, 48, frame);
    const b = worldToMap(0, 10, 48, frame);
    expect(a.px - frame.w / 2).toBeCloseTo(b.py - frame.h / 2);
  });

  it('survives a degenerate extent', () => {
    const at = worldToMap(0, 0, 0, frame);
    expect(Number.isFinite(at.px)).toBe(true);
    expect(Number.isFinite(at.py)).toBe(true);
  });
});

describe('peerDotRadius', () => {
  it('grows with cluster size, gently, from a small base', () => {
    expect(peerDotRadius(1)).toBeCloseTo(2.2);
    expect(peerDotRadius(2)).toBeGreaterThan(peerDotRadius(1));
    expect(peerDotRadius(9)).toBeGreaterThan(peerDotRadius(4));
    // sub-linear growth
    expect(peerDotRadius(9) - peerDotRadius(4)).toBeLessThan(
      peerDotRadius(4) - peerDotRadius(1),
    );
  });

  it('caps so a busy room cannot flood the field', () => {
    expect(peerDotRadius(10_000)).toBeLessThanOrEqual(8);
    expect(peerDotRadius(0)).toBeCloseTo(peerDotRadius(1));
  });
});

describe('nearestAngleTarget', () => {
  it('leaves near targets alone', () => {
    expect(nearestAngleTarget(0.2, 0.5)).toBeCloseTo(0.5);
  });

  it('unwraps across the ±π seam so the spring turns the short way', () => {
    const tau = Math.PI * 2;
    expect(nearestAngleTarget(0.1, tau - 0.1)).toBeCloseTo(-0.1);
    expect(nearestAngleTarget(-0.1, -(tau - 0.1))).toBeCloseTo(0.1);
    // Result is always within π of the current value.
    for (const [current, target] of [
      [3, -3],
      [-3, 3],
      [10, 0],
      [0, 100],
    ] as const) {
      const t = nearestAngleTarget(current, target);
      expect(Math.abs(t - current)).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe('wavyBorderPoints', () => {
  it('is deterministic per seed', () => {
    const a = wavyBorderPoints(280, 200, MAP_INSET, 4.2);
    const b = wavyBorderPoints(280, 200, MAP_INSET, 4.2);
    expect(a).toEqual(b);
  });

  it('changes with the seed — a different hand wavers differently', () => {
    const a = wavyBorderPoints(280, 200, MAP_INSET, 4.2);
    const b = wavyBorderPoints(280, 200, MAP_INSET, 9.9);
    expect(a).not.toEqual(b);
  });

  it('emits four edges of points, all inside the canvas', () => {
    const perEdge = 12;
    const points = wavyBorderPoints(280, 200, MAP_INSET, 4.2, perEdge);
    expect(points.length).toBe(perEdge * 4);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(MAP_INSET - BORDER_WAVER);
      expect(p.x).toBeLessThanOrEqual(280 - MAP_INSET + BORDER_WAVER);
      expect(p.y).toBeGreaterThanOrEqual(MAP_INSET - BORDER_WAVER);
      expect(p.y).toBeLessThanOrEqual(200 - MAP_INSET + BORDER_WAVER);
    }
  });

  it('actually wavers — not a ruled rectangle', () => {
    const points = wavyBorderPoints(280, 200, MAP_INSET, 4.2);
    const topEdge = points.slice(0, 12);
    const ys = new Set(topEdge.map((p) => p.y.toFixed(4)));
    expect(ys.size).toBeGreaterThan(1);
  });
});
