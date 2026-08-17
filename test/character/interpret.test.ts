/**
 * The interpretation pass (GENERATOR §1): motif extraction, species
 * synthesis, banding, echo, passthrough, and null propagation. Everything
 * here is pure and deterministic — no Three.js, no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  SPECIES_ASPECT_MAX,
  SPECIES_ASPECT_MIN,
  SPECIES_LEG_MAX,
  SPECIES_LEG_SPLAY,
  extractMotifs,
  identitySeedOf,
  interpretDrawing,
  speciesParams,
  strokeSeed,
  synthesizeSpecies,
  type Motifs,
} from '../../src/character/interpret';
import { analyze } from '../../src/shape/analyze';
import type { StrokeList } from '../../src/shape/types';
import { bird, capsule, circleBlob, disc, empty, quadruped, snowman } from '../fixtures/strokes';

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

describe('synthesizeSpecies', () => {
  it('is deterministic: same motifs + seed → identical stroke list', () => {
    const motifs = motifsOf(snowman);
    const seed = strokeSeed(snowman);
    expect(synthesizeSpecies(motifs, seed)).toEqual(synthesizeSpecies(motifs, seed));
  });

  it('different seeds produce different individuals', () => {
    const motifs = motifsOf(snowman);
    expect(synthesizeSpecies(motifs, 1)).not.toEqual(synthesizeSpecies(motifs, 2));
  });

  it('clamps torso aspect into the species band, for any drawing', () => {
    // A very wide scrawl and a very tall one both land inside the band.
    const wide = motifsOf([capsule(0.1, 0.5, 0.9, 0.5, 0.2)]);
    const tall = motifsOf([capsule(0.5, 0.1, 0.5, 0.9, 0.2)]);
    for (const motifs of [wide, tall, motifsOf(snowman), motifsOf(circleBlob)]) {
      const { torso } = speciesParams(motifs, 7);
      const aspect = torso.height / torso.width;
      expect(aspect).toBeGreaterThanOrEqual(SPECIES_ASPECT_MIN - 1e-9);
      expect(aspect).toBeLessThanOrEqual(SPECIES_ASPECT_MAX + 1e-9);
    }
  });

  it('keeps legs tiny and near-vertical', () => {
    for (const fixture of [snowman, quadruped, bird]) {
      const params = speciesParams(motifsOf(fixture), strokeSeed(fixture));
      expect(params.legs.length).toBeGreaterThanOrEqual(2);
      for (const leg of params.legs) {
        expect(leg.length).toBeLessThanOrEqual(SPECIES_LEG_MAX * params.torso.height);
        expect(Math.abs(leg.angle)).toBeLessThanOrEqual(SPECIES_LEG_SPLAY + 1e-9);
      }
    }
  });

  it('gives a legless blob drawing no legs at all', () => {
    expect(speciesParams(motifsOf(circleBlob), 3).legs.length).toBe(0);
    expect(speciesParams(motifsOf(eared), 3).legs.length).toBe(0);
  });

  it('gives a quadruped drawing 4 legs and a biped 2', () => {
    expect(speciesParams(motifsOf(quadruped), 3).legs.length).toBe(4);
    expect(speciesParams(motifsOf(snowman), 3).legs.length).toBe(2);
  });

  it('echoes crown motifs as crown strokes at matching angles', () => {
    const motifs = motifsOf(eared);
    const params = speciesParams(motifs, strokeSeed(eared));
    expect(params.crown.length).toBe(2);
    expect(params.crown[0]!.angle).toBeLessThan(0);
    expect(params.crown[1]!.angle).toBeGreaterThan(0);
    // The stroke list carries them: more strokes than the earless variant.
    const earless = speciesParams(motifsOf(circleBlob), strokeSeed(eared));
    expect(earless.crown.length).toBe(0);
  });
});

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

  it('synthesizes at fidelity 1: the strokes are NOT the drawing', () => {
    const out = interpretDrawing(snowman, 1, OPTS);
    expect(out).not.toBeNull();
    expect(out!.strokes).not.toEqual(snowman);
    // The returned analysis is of the SYNTHESIZED silhouette.
    const direct = analyze(out!.strokes, OPTS);
    expect(direct).not.toBeNull();
    expect(out!.analysis.bounds).toEqual(direct!.bounds);
    expect(out!.analysis.archetype).toBe(direct!.archetype);
  });

  it('is deterministic end to end', () => {
    const a = interpretDrawing(quadruped, 1, OPTS);
    const b = interpretDrawing(quadruped, 1, OPTS);
    expect(a!.strokes).toEqual(b!.strokes);
  });

  it('echoes motifs: a 2-footed drawing yields a ~2-footed creature', () => {
    const out = interpretDrawing(snowman, 1, OPTS);
    const echoed = extractMotifs(out!.analysis);
    expect(echoed.feet.length).toBeGreaterThanOrEqual(2);
    expect(echoed.feet.length).toBeLessThanOrEqual(3);
  });

  it('echoes motifs: an eared drawing yields a creature with crown appendages', () => {
    const out = interpretDrawing(eared, 1, OPTS);
    expect(out!.strokes).not.toEqual(eared);
    const echoed = extractMotifs(out!.analysis);
    expect(echoed.crown.length).toBeGreaterThanOrEqual(1);
    // Still a legless blob — it glides.
    expect(echoed.feet.length).toBe(0);
  });

  it('thresholds intermediate fidelity (blend is future work)', () => {
    const low = interpretDrawing(snowman, 0.25, OPTS);
    const high = interpretDrawing(snowman, 0.75, OPTS);
    expect(low!.strokes).toBe(snowman);
    expect(high!.strokes).not.toEqual(snowman);
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

  it('two identities, same strokes → different stroke lists', () => {
    for (const fixture of [snowman, quadruped, eared]) {
      const a = interpretDrawing(fixture, 1, OPTS, seedA)!;
      const b = interpretDrawing(fixture, 1, OPTS, seedB)!;
      expect(a.strokes).not.toEqual(b.strokes);
    }
  });

  it('motif-driven counts are identical across identities — only jitter moves', () => {
    for (const fixture of [snowman, quadruped, eared, circleBlob]) {
      const motifs = motifsOf(fixture);
      const seed = strokeSeed(fixture);
      const a = speciesParams(motifs, (seed ^ seedA) >>> 0, seedA);
      const b = speciesParams(motifs, (seed ^ seedB) >>> 0, seedB);
      // Counts and the angular signature's SIDES stay the drawing's (the
      // droop/perk class spreads angles but never flips a left ear right).
      expect(a.legs.length).toBe(b.legs.length);
      expect(a.crown.length).toBe(b.crown.length);
      expect(a.arms.length).toBe(b.arms.length);
      expect(a.crown.map((c) => Math.sign(c.angle))).toEqual(
        b.crown.map((c) => Math.sign(c.angle)),
      );
    }
  });

  it('discrete identity axes vary the read-at-a-glance classes', () => {
    const motifs = motifsOf(snowman);
    const seed = strokeSeed(snowman);
    const headRs = new Set<string>();
    const tapers = new Set<number>();
    const droops = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const salt = identitySeedOf(`id-${i}`);
      const p = speciesParams(motifs, (seed ^ salt) >>> 0, salt);
      // Normalize head radius by torso width to isolate the class multiplier
      // from the continuous torso jitter.
      headRs.add((p.head.r / p.torso.width).toFixed(3));
      tapers.add(p.taper);
      droops.add(p.droop);
    }
    expect(headRs.size).toBeGreaterThanOrEqual(2);
    expect(tapers.size).toBeGreaterThanOrEqual(2);
    expect(droops.size).toBeGreaterThanOrEqual(2);
    // Unsalted: every discrete axis rests at its neutral middle.
    const plain = speciesParams(motifs, seed);
    expect(plain.taper).toBe(0);
    expect(plain.droop).toBe(0);
  });

  it('no salt → byte-identical to the unsalted pipeline (compat)', () => {
    const motifs = motifsOf(snowman);
    const seed = strokeSeed(snowman);
    // The optional params change nothing when absent…
    expect(speciesParams(motifs, seed)).toEqual(speciesParams(motifs, seed, undefined));
    expect(synthesizeSpecies(motifs, seed)).toEqual(synthesizeSpecies(motifs, seed, undefined));
    // …and interpretDrawing without a salt IS the plain stroke-seed pipeline.
    const out = interpretDrawing(snowman, 1, OPTS);
    expect(out!.strokes).toEqual(synthesizeSpecies(motifs, seed));
  });

  it('same identity + strokes → identical synthesis (phone/world parity)', () => {
    const a = interpretDrawing(quadruped, 1, OPTS, seedA);
    const b = interpretDrawing(quadruped, 1, OPTS, seedA);
    expect(a!.strokes).toEqual(b!.strokes);
  });

  it('salted bodies stay inside the species bands', () => {
    for (const fixture of [snowman, quadruped, bird, eared]) {
      const motifs = motifsOf(fixture);
      for (const id of ['a', 'bb', 'ccc', 'dddd', 'feed-1234567']) {
        const salt = identitySeedOf(id);
        const p = speciesParams(motifs, (strokeSeed(fixture) ^ salt) >>> 0, salt);
        const aspect = p.torso.height / p.torso.width;
        expect(aspect).toBeGreaterThanOrEqual(SPECIES_ASPECT_MIN - 1e-9);
        expect(aspect).toBeLessThanOrEqual(SPECIES_ASPECT_MAX + 1e-9);
        for (const leg of p.legs) {
          expect(leg.length).toBeLessThanOrEqual(SPECIES_LEG_MAX * p.torso.height + 1e-9);
          expect(Math.abs(leg.angle)).toBeLessThanOrEqual(SPECIES_LEG_SPLAY + 1e-9);
        }
      }
    }
  });
});
