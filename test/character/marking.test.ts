/**
 * The back marking (GENERATOR §1, recognition channel 2).
 *
 * The module needs a DOM (it stamps a canvas), so these tests run against a
 * minimal recording canvas stub — enough to prove the two things that are
 * easy to get backwards and invisible in a screenshot diff:
 *
 *   1. the shader composites on the REAR face (−normal.z) and mirrors u, so
 *      the drawing reads the right way round from behind;
 *   2. the stamp placement is seeded from the identity, never Math.random —
 *      same id → identical placement, different id → different placement.
 */

import { MeshPhysicalMaterial } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMarking } from '../../src/character/marking';
import type { StrokeList } from '../../src/shape/types';

/** A deliberately asymmetric drawing — an "F", whose mirror is obvious. */
const F_STROKES: StrokeList = [
  { pts: [[0.3, 0.2, 1], [0.3, 0.8, 1]], w: 0.06 },
  { pts: [[0.3, 0.2, 1], [0.7, 0.2, 1]], w: 0.06 },
  { pts: [[0.3, 0.5, 1], [0.6, 0.5, 1]], w: 0.06 },
];

const BOX = { min: { x: -1, y: 0 }, max: { x: 1, y: 3 } };

interface DrawCall {
  translate: [number, number];
  rotate: number;
  rect: [number, number, number, number];
}

let drawCalls: DrawCall[] = [];

function makeCtxStub(): CanvasRenderingContext2D {
  let pendingTranslate: [number, number] = [0, 0];
  let pendingRotate = 0;
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void {},
    fill(): void {},
    arc(): void {},
    save(): void {},
    restore(): void {},
    translate(x: number, y: number): void {
      pendingTranslate = [x, y];
    },
    rotate(a: number): void {
      pendingRotate = a;
    },
    drawImage(_img: unknown, x: number, y: number, w: number, h: number): void {
      drawCalls.push({
        translate: pendingTranslate,
        rotate: pendingRotate,
        rect: [x, y, w, h],
      });
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  drawCalls = [];
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => makeCtxStub() }),
  };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

/** Compile the material's hook against a stub shader carrying the includes
 * the module patches, and return the two stages. */
function compile(material: MeshPhysicalMaterial): { vert: string; frag: string } {
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main() {\n#include <color_fragment>\n#include <alphamap_fragment>\n}',
  };
  material.onBeforeCompile(shader as never, undefined as never);
  return { vert: shader.vertexShader, frag: shader.fragmentShader };
}

describe('applyMarking', () => {
  it('returns null without a DOM — the pure/headless paths carry no marking', () => {
    delete (globalThis as { document?: unknown }).document;
    const material = new MeshPhysicalMaterial();
    expect(applyMarking(material, F_STROKES, BOX)).toBeNull();
    material.dispose();
  });

  it('composites on the REAR face, not the front', () => {
    const material = new MeshPhysicalMaterial();
    const handle = applyMarking(material, F_STROKES, BOX);
    expect(handle).not.toBeNull();
    const { frag } = compile(material);
    // The eye owns +normal.z; the marking must fade in on the opposite side.
    expect(frag).toContain('smoothstep(0.05, 0.5, -vMarkNz)');
    expect(frag).not.toContain('smoothstep(0.05, 0.5, vMarkNz)');
    handle!.dispose();
    material.dispose();
  });

  it('mirrors u, so the drawing is not reversed when seen from behind', () => {
    const material = new MeshPhysicalMaterial();
    const handle = applyMarking(material, F_STROKES, BOX);
    const { vert } = compile(material);
    expect(vert).toContain('vMarkUv.x = 1.0 - vMarkUv.x;');
    handle!.dispose();
    material.dispose();
  });

  it('is a knockout, never a darkening — the light role at low opacity', () => {
    const material = new MeshPhysicalMaterial();
    const handle = applyMarking(material, F_STROKES, BOX);
    const { frag } = compile(material);
    // Mixed toward uMarkColor (CHARACTER.eye, the light role) — never toward
    // the body value, and never multiplied into diffuseColor.
    expect(frag).toContain('diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, markA);');
    handle!.dispose();
    material.dispose();
  });

  it('fades out at the rim, so the silhouette stays one mass at distance', () => {
    const material = new MeshPhysicalMaterial();
    const handle = applyMarking(material, F_STROKES, BOX);
    const { frag } = compile(material);
    // smoothstep's lower edge is above 0: a fragment whose normal is edge-on
    // (nz → 0) gets zero mark.
    expect(frag).toMatch(/smoothstep\(0\.05, 0\.5, -vMarkNz\)/);
    handle!.dispose();
    material.dispose();
  });

  it('chains onto the existing onBeforeCompile instead of replacing it', () => {
    const material = new MeshPhysicalMaterial();
    let ran = 0;
    material.onBeforeCompile = () => {
      ran += 1;
    };
    const handle = applyMarking(material, F_STROKES, BOX);
    compile(material);
    expect(ran).toBe(1);
    handle!.dispose();
    material.dispose();
  });

  it('bumps the program cache key', () => {
    const material = new MeshPhysicalMaterial();
    const before = material.customProgramCacheKey();
    const handle = applyMarking(material, F_STROKES, BOX);
    expect(material.customProgramCacheKey()).not.toBe(before);
    expect(material.customProgramCacheKey()).toContain('character-marking-back-v1');
    handle!.dispose();
    material.dispose();
  });

  it('places the stamp deterministically from the identity seed', () => {
    const place = (seed?: number): DrawCall => {
      drawCalls = [];
      const material = new MeshPhysicalMaterial();
      const handle = applyMarking(material, F_STROKES, BOX, seed);
      handle!.dispose();
      material.dispose();
      const call = drawCalls[0];
      expect(call).toBeDefined();
      return call!;
    };
    // Same id twice → identical placement (no Math.random anywhere).
    expect(place(1234)).toEqual(place(1234));
    // Different ids → different placement: two hatchlings of one drawing
    // wear the mark differently.
    const a = place(1234);
    const b = place(9876);
    expect(a).not.toEqual(b);
    // Unsalted → the exact centered placement, no tilt.
    const plain = place(undefined);
    expect(plain.rotate).toBe(0);
    expect(plain.translate[0]).toBeCloseTo(0.5 * 512, 6);
  });

  it('keeps the jitter small — it stays a centered mark on the back', () => {
    for (const seed of [1, 77, 1234, 40000, 8191]) {
      drawCalls = [];
      const material = new MeshPhysicalMaterial();
      const handle = applyMarking(material, F_STROKES, BOX, seed);
      handle!.dispose();
      material.dispose();
      const call = drawCalls[0]!;
      // ±0.03 uv horizontally, ±0.025 vertically, ±0.08 rad tilt.
      expect(Math.abs(call.translate[0] / 512 - 0.5)).toBeLessThanOrEqual(0.03 + 1e-9);
      expect(Math.abs(1 - call.translate[1] / 512 - 0.55)).toBeLessThanOrEqual(0.025 + 1e-9);
      expect(Math.abs(call.rotate)).toBeLessThanOrEqual(0.08 + 1e-9);
    }
  });
});
