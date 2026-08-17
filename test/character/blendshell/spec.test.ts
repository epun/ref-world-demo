/**
 * Blend-shell spec — pure tests over specFromMotifs and the CPU SDF twin.
 * Motifs are constructed directly (the interface is plain data), so every
 * assertion is deterministic and renderer-free.
 */

import { describe, expect, it } from 'vitest';
import type { Motifs } from '../../../src/character/interpret';
import {
  CROWN_BLEND_CAP,
  MAX_PARTS,
  sdfGradient,
  sdfSpec,
  specBounds,
  specFromMotifs,
  specHeight,
  type CharacterSpec,
} from '../../../src/character/blendshell/spec';

function motifsOf(over: Partial<Motifs> = {}): Motifs {
  return {
    archetype: 'biped',
    aspect: 1.2,
    torsoFullness: 0.7,
    headSize: 0.6,
    feet: [
      { angle: -0.1, reach: 0.9 },
      { angle: 0.12, reach: 0.9 },
    ],
    limbs: [],
    crown: [
      { angle: -0.3, reach: 0.12 },
      { angle: 0.3, reach: 0.1 },
    ],
    lumpiness: 0.4,
    ...over,
  };
}

function legParts(spec: CharacterSpec): { l: number; r: number } {
  let l = 0;
  let r = 0;
  for (const p of spec.parts) {
    if (p.group === 'leg-l') l++;
    if (p.group === 'leg-r') r++;
  }
  return { l, r };
}

describe('specFromMotifs', () => {
  it('is deterministic per (motifs, seed) and varies with the seed', () => {
    const motifs = motifsOf();
    const a = specFromMotifs(motifs, 1234);
    const b = specFromMotifs(motifs, 1234);
    expect(b).toEqual(a);
    const c = specFromMotifs(motifs, 99);
    expect(c).not.toEqual(a);
  });

  it('keeps the part count inside the shader budget for every archetype', () => {
    const seeds = [1, 777, 123456, 0xdeadbeef];
    const variants: Partial<Motifs>[] = [
      { archetype: 'biped' },
      { archetype: 'bird' },
      { archetype: 'quadruped' },
      { archetype: 'blob', feet: [] },
      { archetype: 'biped', crown: [] },
      {
        archetype: 'quadruped',
        crown: [
          { angle: -0.5, reach: 0.2 },
          { angle: 0, reach: 0.15 },
          { angle: 0.5, reach: 0.18 },
        ],
      },
    ];
    for (const seed of seeds) {
      for (const over of variants) {
        const spec = specFromMotifs(motifsOf(over), seed);
        expect(spec.parts.length).toBeGreaterThanOrEqual(4);
        expect(spec.parts.length).toBeLessThanOrEqual(MAX_PARTS);
      }
    }
  });

  it('always gives bipeds and birds exactly two two-part legs', () => {
    for (const archetype of ['biped', 'bird'] as const) {
      // Even contradictory feet evidence (none, one, three) yields two legs —
      // the avatar spec's "always exactly two, always short".
      for (const feet of [
        [],
        [{ angle: 0.05, reach: 0.8 }],
        [
          { angle: -0.15, reach: 0.9 },
          { angle: 0, reach: 0.7 },
          { angle: 0.15, reach: 0.9 },
        ],
      ]) {
        const spec = specFromMotifs(motifsOf({ archetype, feet }), 42);
        const { l, r } = legParts(spec);
        expect(l).toBe(2);
        expect(r).toBe(2);
      }
    }
  });

  it('gives quadrupeds four legs and blobs none', () => {
    const quad = specFromMotifs(motifsOf({ archetype: 'quadruped' }), 42);
    const { l, r } = legParts(quad);
    expect(l + r).toBe(8);
    const blob = specFromMotifs(motifsOf({ archetype: 'blob', feet: [] }), 42);
    const blobLegs = legParts(blob);
    expect(blobLegs.l + blobLegs.r).toBe(0);
  });

  it('caps the crown blend radius (the antenna rule)', () => {
    const spec = specFromMotifs(
      motifsOf({
        crown: [
          { angle: -0.6, reach: 0.05 },
          { angle: 0, reach: 0.3 },
          { angle: 0.6, reach: 0.15 },
        ],
      }),
      7,
    );
    const crown = spec.parts.filter((p) => p.group === 'crown');
    expect(crown.length).toBeGreaterThan(0);
    for (const p of crown) {
      expect(p.blend).toBeLessThanOrEqual(CROWN_BLEND_CAP + 1e-12);
    }
    // The body itself blends softer than the cap — the cap is a real cap.
    const torso = spec.parts.find((p) => p.group === 'torso')!;
    expect(torso.blend).toBeGreaterThan(CROWN_BLEND_CAP);
  });

  it('stands on the ground: feet bottoms at y ≈ 0, head merged high', () => {
    const spec = specFromMotifs(motifsOf(), 42);
    const lower = spec.parts.filter((p) => p.group.startsWith('leg-'));
    // Each leg chain's foot end (last part's b) rests its sphere on y = 0.
    for (let i = 1; i < lower.length; i += 2) {
      const foot = lower[i]!;
      expect(foot.b![1] - (foot.r2 ?? foot.r)).toBeCloseTo(0, 5);
    }
    const head = spec.parts.find((p) => p.group === 'head')!;
    const torso = spec.parts.find((p) => p.group === 'torso')!;
    expect(head.a[1]).toBeGreaterThan(torso.b![1]);
  });
});

describe('sdf twin', () => {
  const spec = specFromMotifs(motifsOf(), 42);

  it('is negative inside the torso and positive far outside', () => {
    const torso = spec.parts.find((p) => p.group === 'torso')!;
    const center: [number, number, number] = [
      torso.a[0],
      (torso.a[1] + torso.b![1]) / 2,
      torso.a[2],
    ];
    expect(sdfSpec(center, spec.parts)).toBeLessThan(0);
    expect(sdfSpec([5, 5, 5], spec.parts)).toBeGreaterThan(3);
  });

  it('smooth-min union is never farther than the nearest part alone', () => {
    // Blending only ADDS material: d_union ≤ min(d_i) everywhere.
    const pts: [number, number, number][] = [
      [0.1, 0.4, 0.2],
      [-0.2, 0.7, 0],
      [0, 0.05, 0.1],
      [0.3, 0.9, -0.1],
    ];
    for (const p of pts) {
      let nearest = Infinity;
      for (const part of spec.parts) {
        const d = sdfSpec(p, [part]);
        nearest = Math.min(nearest, d);
      }
      expect(sdfSpec(p, spec.parts)).toBeLessThanOrEqual(nearest + 1e-9);
    }
  });

  it('gradient points outward from the interior', () => {
    const head = spec.parts.find((p) => p.group === 'head')!;
    const g = sdfGradient([head.a[0], head.a[1] + head.r * 0.5, head.a[2]], spec.parts);
    expect(g[1]).toBeGreaterThan(0); // above the head center, up is out
  });

  it('bounds contain the zero surface and yield a sane height', () => {
    const { min, max } = specBounds(spec);
    expect(min[1]).toBeLessThanOrEqual(0.01);
    expect(max[1]).toBeGreaterThan(0.5);
    const h = specHeight(spec);
    expect(h).toBeGreaterThan(0.4);
    expect(h).toBeLessThan(1.6);
    // A point on the bounds shell is outside the surface.
    expect(sdfSpec([max[0], max[1], max[2]], spec.parts)).toBeGreaterThan(0);
  });
});
