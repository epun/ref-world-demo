/**
 * The interpretation pass (GENERATOR §1a — "drawn objects keep their shape"):
 * fill, chunkify, corner-preserving simplification, stubby-leg additions,
 * proportion banding, passthrough, salt, and null propagation. Everything
 * here is pure and deterministic — no Three.js, no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNK_FLOOR,
  SPECIES_ASPECT_MAX,
  SPECIES_ASPECT_MIN,
  SPECIES_LEG_MAX,
  SPECIES_LEG_SPLAY,
  bodyPlan,
  extractMotifs,
  identitySeedOf,
  interpretDrawing,
  strokeSeed,
  type Motifs,
} from '../../src/character/interpret';
import { analyze } from '../../src/shape/analyze';
import { resample, signedArea } from '../../src/shape/contour';
import type { ShapeAnalysis, StrokeList } from '../../src/shape/types';
import {
  bird,
  capsule,
  circleBlob,
  disc,
  empty,
  fish,
  hat,
  quadruped,
  ringOutline,
  scribble,
  snowman,
  squareOutline,
  stickFigure,
  triangleOutline,
} from '../fixtures/strokes';

const SIZE = 128;
const OPTS = { size: SIZE };

/** A round blob with two ear/antenna strokes on top. */
const eared: StrokeList = [
  disc(0.5, 0.58, 0.2),
  capsule(0.42, 0.42, 0.36, 0.2, 0.05),
  capsule(0.58, 0.42, 0.64, 0.2, 0.05),
];

function motifsOf(strokes: StrokeList): Motifs {
  const analysis = analyze(strokes, OPTS);
  expect(analysis).not.toBeNull();
  return extractMotifs(analysis!);
}

function interpret(strokes: StrokeList, salt?: number): ShapeAnalysis {
  const out = interpretDrawing(strokes, 1, OPTS, salt);
  expect(out).not.toBeNull();
  return out!.analysis;
}

/**
 * Dominant convex corners of the RESULT contour, measured by windowed
 * turning angle (> ~55° over ±3% of perimeter), clustered, and restricted
 * to the body region (the bottom 10% of the ink belongs to legs/feet, whose
 * round tips read as turns to any local detector).
 */
function dominantConvexCorners(analysis: ShapeAnalysis): number {
  const c = resample(analysis.contour, 240);
  const n = c.length;
  const w = 8;
  const orient = Math.sign(signedArea(c)) || 1;
  const h = Math.max(1, analysis.bounds.maxY - analysis.bounds.minY);
  const yCut = analysis.bounds.minY + h * 0.9;
  const strong = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const a = c[(i - w + n) % n]!;
    const b = c[i]!;
    const d = c[(i + w) % n]!;
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = d.x - b.x;
    const v2y = d.y - b.y;
    const turn = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
    strong[i] = turn * orient > 0.96 && b.y <= yCut;
  }
  // Count clusters circularly, starting from a non-strong index.
  const start = strong.indexOf(false);
  if (start < 0) return 1;
  let count = 0;
  let inRun = false;
  for (let k = 0; k <= n; k++) {
    const s = strong[(start + k) % n]!;
    if (s && !inRun) count++;
    inRun = s;
  }
  return count;
}

// ── motif extraction (measures the ORIGINAL drawing, unchanged by §1a) ───────

describe('extractMotifs', () => {
  it('reads crown and limb motifs off the bird fixture', () => {
    const motifs = motifsOf(bird);
    expect(motifs.archetype).toBe('bird');
    expect(motifs.crown.length).toBeGreaterThanOrEqual(1);
    expect(motifs.limbs.length).toBeGreaterThanOrEqual(1);
    expect(motifs.feet.length).toBe(2);
    // The wing stroke sits on the right of the drawing.
    expect(motifs.limbs.some((l) => l.side === 1)).toBe(true);
  });

  it('reads a 4-feet echo off the quadruped fixture', () => {
    const motifs = motifsOf(quadruped);
    expect(motifs.archetype).toBe('quadruped');
    expect(motifs.feet.length).toBe(4);
    // Presented left→right: angles ascend.
    const angles = motifs.feet.map((f) => f.angle);
    expect([...angles].sort((a, b) => a - b)).toEqual(angles);
  });

  it('reads two ears as crown motifs, one per side', () => {
    const motifs = motifsOf(eared);
    expect(motifs.crown.length).toBe(2);
    expect(motifs.crown[0]!.angle).toBeLessThan(0);
    expect(motifs.crown[1]!.angle).toBeGreaterThan(0);
    // A blob with ears has no feet and no limbs.
    expect(motifs.feet.length).toBe(0);
    expect(motifs.limbs.length).toBe(0);
  });

  it('reads a plain circle as a featureless full blob', () => {
    const motifs = motifsOf(circleBlob);
    expect(motifs.archetype).toBe('blob');
    expect(motifs.feet.length).toBe(0);
    expect(motifs.crown.length).toBe(0);
    expect(motifs.aspect).toBeGreaterThan(0.85);
    expect(motifs.aspect).toBeLessThan(1.15);
    expect(motifs.torsoFullness).toBeGreaterThan(0.9);
    // A resampled smooth circle turns uniformly — low lumpiness.
    expect(motifs.lumpiness).toBeLessThan(motifsOf(snowman).lumpiness);
  });
});

// ── §1a: fill + chunkify ─────────────────────────────────────────────────────

describe('fill and chunkify', () => {
  it('fills an unfilled ring outline into solid mass', () => {
    const body = interpret(ringOutline);
    // The DT peak of a ring is its line half-width; a filled disc's is its
    // radius. Clearing the chunk floor proves the interior became ink.
    expect(body.distance.max).toBeGreaterThanOrEqual(CHUNK_FLOOR * SIZE - 1);
  });

  it('chunkifies a stick figure into a solid blob, never a wire', () => {
    const body = interpret(stickFigure);
    expect(body.distance.max).toBeGreaterThanOrEqual(CHUNK_FLOOR * SIZE - 1);
  });

  it('chunkifies a loose scribble the same way', () => {
    const body = interpret(scribble);
    expect(body.distance.max).toBeGreaterThanOrEqual(CHUNK_FLOOR * SIZE - 1);
  });

  it('thickens thin limbs even when a fat lobe clears the floor', () => {
    // The stick figure's head alone satisfies the max-DT floor; the wire
    // guard must still fatten the hairline arms and legs. The 25th
    // percentile of DT over ink is the thin-part half-width.
    const body = interpret(stickFigure);
    const values: number[] = [];
    for (let i = 0; i < body.distance.data.length; i++) {
      const v = body.distance.data[i]!;
      if (v > 0) values.push(v);
    }
    values.sort((a, b) => a - b);
    const p25 = values[Math.floor(values.length * 0.25)]!;
    // The guard targets CHUNK_FLOOR/2 pre-warp; proportion normalization
    // then rescales the tall figure down (~0.5×). The raw drawing's limbs
    // sit near 1px here — anything ≥ ~1.6% of the mask is a limb, not a
    // wire. (The visual check lives in the browser harness.)
    expect(p25).toBeGreaterThanOrEqual(SIZE * 0.016);
  });
});

// ── §1a: corner-preserving simplification ────────────────────────────────────

describe('corner preservation', () => {
  it('a drawn triangle keeps its three shoulders', () => {
    const corners = dominantConvexCorners(interpret(triangleOutline));
    expect(corners).toBeGreaterThanOrEqual(3);
    expect(corners).toBeLessThanOrEqual(5);
  });

  it('a square-ish drawing keeps its four corners', () => {
    const corners = dominantConvexCorners(interpret(squareOutline));
    expect(corners).toBeGreaterThanOrEqual(4);
    expect(corners).toBeLessThanOrEqual(6);
  });

  it('an outline circle stays smooth — no invented corners', () => {
    expect(dominantConvexCorners(interpret(ringOutline))).toBe(0);
  });
});

// ── §1a: species additions (stubby legs) ─────────────────────────────────────

describe('stubby legs', () => {
  it('plans exactly two tiny near-vertical legs for every drawing (user ruling)', () => {
    for (const fixture of [ringOutline, hat, fish, circleBlob, eared, snowman, quadruped, bird]) {
      const plan = bodyPlan(motifsOf(fixture), strokeSeed(fixture));
      expect(plan.legs.length).toBe(2);
      for (const leg of plan.legs) {
        expect(leg.length).toBeLessThanOrEqual(SPECIES_LEG_MAX);
        expect(Math.abs(leg.angle)).toBeLessThanOrEqual(SPECIES_LEG_SPLAY + 1e-9);
      }
      // One per side.
      expect(plan.legs[0]!.x).toBeLessThan(0);
      expect(plan.legs[1]!.x).toBeGreaterThan(0);
    }
  });

  it('a legless drawing hatches with two feet on the actual body', () => {
    for (const fixture of [hat, ringOutline, fish]) {
      const echoed = extractMotifs(interpret(fixture));
      expect(echoed.feet.length).toBeGreaterThanOrEqual(2);
      expect(echoed.feet.length).toBeLessThanOrEqual(4);
    }
  });

  it('drawn legs survive, merged with the stamped stance', () => {
    // The quadruped keeps its own feet in the contour; the species legs
    // stamp beneath the grounded bottom band and merge with them, so the
    // hatched body still reads a multi-foot echo, never a legless slab.
    const echoed = extractMotifs(interpret(quadruped));
    expect(echoed.feet.length).toBeGreaterThanOrEqual(2);
    expect(echoed.feet.length).toBeLessThanOrEqual(5);
  });
});

// ── §1a: proportion band ─────────────────────────────────────────────────────

describe('proportion band', () => {
  it('pulls extreme aspects back into the widened band', () => {
    // A very wide scrawl and a very tall one. Legless drawings gain stubby
    // legs, which extend the measured bounds a touch past the body band.
    const wide = interpret([capsule(0.1, 0.5, 0.9, 0.5, 0.2)]);
    const wa =
      (wide.bounds.maxY - wide.bounds.minY) / Math.max(1, wide.bounds.maxX - wide.bounds.minX);
    expect(wa).toBeGreaterThanOrEqual(SPECIES_ASPECT_MIN * 0.9);

    const tall = interpret([capsule(0.5, 0.1, 0.5, 0.9, 0.2)]);
    const ta =
      (tall.bounds.maxY - tall.bounds.minY) / Math.max(1, tall.bounds.maxX - tall.bounds.minX);
    expect(ta).toBeLessThanOrEqual(SPECIES_ASPECT_MAX * 1.25);
  });

  it('keeps a wide hat wide and a wide fish wide — identity survives', () => {
    for (const fixture of [hat, fish]) {
      const body = interpret(fixture);
      const w = body.bounds.maxX - body.bounds.minX;
      const h = body.bounds.maxY - body.bounds.minY;
      expect(w).toBeGreaterThan(h * 0.95);
    }
  });
});

// ── the pass ─────────────────────────────────────────────────────────────────

describe('interpretDrawing', () => {
  it('returns null for unusable ink', () => {
    expect(interpretDrawing(empty, 1, OPTS)).toBeNull();
    expect(interpretDrawing([{ pts: [[0.5, 0.5, 1]], w: 0.002 }], 1, OPTS)).toBeNull();
  });

  it('passes the original strokes through at fidelity 0', () => {
    const out = interpretDrawing(snowman, 0, OPTS);
    expect(out).not.toBeNull();
    expect(out!.strokes).toBe(snowman);
    // And the analysis is of the original drawing.
    expect(out!.analysis.archetype).toBe('biped');
  });

  it('processes at fidelity 1: original strokes kept, analysis is the body', () => {
    const out = interpretDrawing(snowman, 1, OPTS);
    expect(out).not.toBeNull();
    // §1a mask path: the strokes stay the ORIGINAL (egg + marking use them);
    // only the analysis carries the processed body.
    expect(out!.strokes).toBe(snowman);
    const source = analyze(snowman, OPTS)!;
    expect(JSON.stringify(out!.analysis.contour)).not.toBe(
      JSON.stringify(source.contour),
    );
  });

  it('is deterministic end to end', () => {
    const a = interpretDrawing(quadruped, 1, OPTS);
    const b = interpretDrawing(quadruped, 1, OPTS);
    expect(a!.analysis.contour).toEqual(b!.analysis.contour);
    expect(a!.analysis.mask.data).toEqual(b!.analysis.mask.data);
  });

  it('echoes the drawing: a 2-footed drawing yields a ~2-footed creature', () => {
    const echoed = extractMotifs(interpret(snowman));
    expect(echoed.feet.length).toBeGreaterThanOrEqual(2);
    expect(echoed.feet.length).toBeLessThanOrEqual(3);
  });

  it('keeps drawn ears: an eared drawing yields crown appendages', () => {
    const echoed = extractMotifs(interpret(eared));
    expect(echoed.crown.length).toBeGreaterThanOrEqual(1);
    // A legless blob now stands on two stubby legs (§1a).
    expect(echoed.feet.length).toBe(2);
  });

  it('thresholds intermediate fidelity (blend is future work)', () => {
    const low = interpretDrawing(snowman, 0.25, OPTS);
    const high = interpretDrawing(snowman, 0.75, OPTS);
    expect(low!.strokes).toBe(snowman);
    expect(JSON.stringify(high!.analysis.contour)).not.toBe(
      JSON.stringify(low!.analysis.contour),
    );
  });
});

// ── identity salt (no two characters look the same) ──────────────────────────

describe('identity salt', () => {
  const seedA = identitySeedOf('feed-aaaa111');
  const seedB = identitySeedOf('feed-bbbb222');

  it('identitySeedOf is a stable fnv-1a: deterministic, id-sensitive', () => {
    expect(identitySeedOf('local-0')).toBe(identitySeedOf('local-0'));
    expect(identitySeedOf('local-0')).not.toBe(identitySeedOf('local-1'));
    expect(Number.isInteger(identitySeedOf('x'))).toBe(true);
  });

  it('two identities, same strokes → different bodies', () => {
    for (const fixture of [snowman, quadruped, eared]) {
      const a = interpret(fixture, seedA);
      const b = interpret(fixture, seedB);
      expect(JSON.stringify(a.contour)).not.toBe(JSON.stringify(b.contour));
    }
  });

  it('drawing-driven counts are identical across identities — only jitter moves', () => {
    for (const fixture of [snowman, quadruped, eared, circleBlob]) {
      const motifs = motifsOf(fixture);
      const seed = strokeSeed(fixture);
      const a = bodyPlan(motifs, (seed ^ seedA) >>> 0, seedA);
      const b = bodyPlan(motifs, (seed ^ seedB) >>> 0, seedB);
      expect(a.legs.length).toBe(b.legs.length);
      // The stance jitters, but a left leg never flips right.
      expect(a.legs.map((l) => Math.sign(l.x))).toEqual(b.legs.map((l) => Math.sign(l.x)));
    }
  });

  it('discrete identity axes vary the read-at-a-glance classes', () => {
    const motifs = motifsOf(snowman);
    const seed = strokeSeed(snowman);
    const heads = new Set<number>();
    const tapers = new Set<number>();
    const droops = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const salt = identitySeedOf(`id-${i}`);
      const p = bodyPlan(motifs, (seed ^ salt) >>> 0, salt);
      heads.add(p.headScale);
      tapers.add(p.taper);
      droops.add(p.droop);
    }
    expect(heads.size).toBeGreaterThanOrEqual(2);
    expect(tapers.size).toBeGreaterThanOrEqual(2);
    expect(droops.size).toBeGreaterThanOrEqual(2);
    // Unsalted: every axis rests at its neutral middle.
    const plain = bodyPlan(motifs, seed);
    expect(plain.taper).toBe(0);
    expect(plain.droop).toBe(0);
    expect(plain.headScale).toBe(1);
    expect(plain.fullness).toBe(1);
    expect(plain.aspectJitter).toBe(1);
  });

  it('no salt → byte-identical to the unsalted pipeline (compat)', () => {
    const motifs = motifsOf(snowman);
    const seed = strokeSeed(snowman);
    // The optional params change nothing when absent…
    expect(bodyPlan(motifs, seed)).toEqual(bodyPlan(motifs, seed, undefined));
    // …and interpretDrawing without a salt IS the plain stroke-seed pipeline.
    const a = interpretDrawing(snowman, 1, OPTS);
    const b = interpretDrawing(snowman, 1, OPTS, undefined);
    expect(a!.analysis.contour).toEqual(b!.analysis.contour);
  });

  it('same identity + strokes → identical body (phone/world parity)', () => {
    const a = interpretDrawing(quadruped, 1, OPTS, seedA);
    const b = interpretDrawing(quadruped, 1, OPTS, seedA);
    expect(a!.analysis.contour).toEqual(b!.analysis.contour);
    expect(a!.analysis.mask.data).toEqual(b!.analysis.mask.data);
  });

  it('salted plans stay inside the species bands', () => {
    for (const fixture of [circleBlob, eared, hat, fish]) {
      const motifs = motifsOf(fixture);
      for (const id of ['a', 'bb', 'ccc', 'dddd', 'feed-1234567']) {
        const salt = identitySeedOf(id);
        const p = bodyPlan(motifs, (strokeSeed(fixture) ^ salt) >>> 0, salt);
        expect(p.legs.length).toBe(2);
        for (const leg of p.legs) {
          expect(leg.length).toBeLessThanOrEqual(SPECIES_LEG_MAX + 1e-9);
          expect(Math.abs(leg.angle)).toBeLessThanOrEqual(SPECIES_LEG_SPLAY + 1e-9);
        }
      }
    }
  });
});
