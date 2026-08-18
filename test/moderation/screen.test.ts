/**
 * The measured claim, as a test.
 *
 * These are the numbers reported for the screen: every offensive fixture
 * is caught (refused or held), and NOT ONE innocent fixture is refused or
 * held. The innocent assertion is the load-bearing one — a public
 * installation that eats a child's drawing of a cat is worse than one that
 * lets a rude doodle through, because the operator layer can remove the
 * doodle and cannot un-eat the cat.
 */

import { describe, expect, it } from 'vitest';
import { screenDrawing } from '../../src/moderation/screen';
import { detectFourFold } from '../../src/moderation/fourfold';
import { detectPhallus } from '../../src/moderation/phallus';
import { screenMask } from '../../src/moderation/mask';
import { FALLBACK_DRAWINGS } from '../../src/dev/fixtures';
import {
  CROSS_SET,
  INNOCENT_SET,
  PHALLUS_SET,
  phallusDoodle,
  rotate,
} from '../fixtures/moderation';
import { empty, dot } from '../fixtures/strokes';

describe('screen — offensive set', () => {
  it('refuses every phallus fixture', () => {
    const missed = PHALLUS_SET.filter((f) => screenDrawing(f.strokes).verdict !== 'refuse');
    expect(missed.map((m) => m.name)).toEqual([]);
  });

  it('holds every four-fold bent cross for a person, and never refuses one', () => {
    for (const { name, strokes } of CROSS_SET) {
      const result = screenDrawing(strokes);
      expect(`${name}: ${result.verdict}`).toBe(`${name}: hold`);
    }
  });

  it('names what fired', () => {
    const result = screenDrawing(PHALLUS_SET[0]!.strokes);
    expect(result.allow).toBe(false);
    expect(result.reason).toContain('phallus');
    expect(result.confidence).toBeGreaterThan(0.6);
  });
});

describe('screen — where recall runs out', () => {
  /**
   * A grid over the doodle's proportions and four rotations, restricted to
   * the region a person actually draws it in: lobes at least as wide as the
   * shaft, shaft at least three times its own width. The number is the
   * honest recall claim, and the floor keeps a future retune from quietly
   * trading it away.
   */
  it('catches most of the recognisable proportion range', () => {
    let hit = 0;
    let total = 0;
    for (const shaftLen of [0.22, 0.28, 0.34, 0.4, 0.46, 0.52]) {
      for (const shaftW of [0.06, 0.09, 0.12]) {
        for (const ballR of [0.06, 0.085, 0.11]) {
          if (ballR < shaftW * 0.9 || shaftLen < shaftW * 3) continue;
          for (const angle of [0, Math.PI / 5, Math.PI, Math.PI * 1.4]) {
            const cy = Math.min(0.9, 0.45 + shaftLen / 2);
            const strokes = rotate(phallusDoodle({ shaftLen, shaftW, ballR, cy }), angle);
            total++;
            if (screenDrawing(strokes).verdict === 'refuse') hit++;
          }
        }
      }
    }
    // Measured 101/124 (81%) at the shipped thresholds. The misses are
    // short shafts carrying lobes as big as the shaft is long, where the
    // cusp between the lobes all but closes.
    expect(hit / total).toBeGreaterThanOrEqual(0.78);
  });
});

describe('screen — innocent set', () => {
  it('allows all of it: zero refusals, zero holds', () => {
    const flagged = INNOCENT_SET.filter((f) => screenDrawing(f.strokes).verdict !== 'allow').map(
      (f) => f.name,
    );
    expect(flagged).toEqual([]);
  });

  it('allows the dev fallback drawings the panel spawns', () => {
    for (const strokes of FALLBACK_DRAWINGS) {
      expect(screenDrawing(strokes).verdict).toBe('allow');
    }
  });

  it('reports lower confidence for a near miss than for a plain shape', () => {
    const nearMiss = screenDrawing(
      // A tree keeps a shaft and a bulge; only the twin-lobe cusp is absent.
      INNOCENT_SET.find((f) => f.name === 'two-lobe tree')!.strokes,
    );
    const plain = screenDrawing(INNOCENT_SET.find((f) => f.name === 'house')!.strokes);
    expect(nearMiss.confidence).toBeLessThan(plain.confidence);
  });
});

describe('screen — determinism and degenerate ink', () => {
  it('gives the identical verdict on repeated runs', () => {
    const strokes = PHALLUS_SET[3]!.strokes;
    const a = screenDrawing(strokes);
    const b = screenDrawing(strokes);
    expect(a.verdict).toBe(b.verdict);
    expect(a.confidence).toBe(b.confidence);
    expect(a.reason).toBe(b.reason);
  });

  it('is rotation-stable: the same doodle at 12 angles is always refused', () => {
    const base = phallusDoodle({});
    for (let k = 0; k < 12; k++) {
      const angle = (k / 12) * Math.PI * 2;
      expect(screenDrawing(rotate(base, angle)).verdict).toBe('refuse');
    }
  });

  it('allows ink it cannot measure rather than guessing', () => {
    expect(screenDrawing(empty).verdict).toBe('allow');
    expect(screenDrawing(dot).verdict).toBe('allow');
  });

  it('screens the same at another raster size', () => {
    expect(screenDrawing(PHALLUS_SET[0]!.strokes, { size: 224 }).verdict).toBe('refuse');
    expect(screenDrawing(INNOCENT_SET[0]!.strokes, { size: 224 }).verdict).toBe('allow');
  });
});

describe('detectors report their own criteria', () => {
  it('says which criterion failed', () => {
    const result = detectPhallus(screenMask(INNOCENT_SET.find((f) => f.name === 'house')!.strokes));
    expect(result.hit).toBe(false);
    expect(result.reason).toContain('failed');
    expect(result.passed).toBeLessThan(result.total);
  });

  it('never claims certainty for the four-fold hold', () => {
    const result = detectFourFold(screenMask(CROSS_SET[0]!.strokes));
    expect(result.hit).toBe(true);
    expect(result.score).toBeLessThanOrEqual(0.5);
  });
});
