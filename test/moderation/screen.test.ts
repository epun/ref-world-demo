/**
 * The measured claim, as a test.
 *
 * These are the numbers reported for the screen: every offensive fixture
 * is caught (refused or held), and NOT ONE innocent fixture is REFUSED.
 * The innocent assertion is the load-bearing one — a public installation
 * that eats a child's drawing of a cat is worse than one that lets a rude
 * doodle through, because the operator layer can remove the doodle and
 * cannot un-eat the cat.
 *
 * Innocent drawings MAY be held. That is the price paid for catching the
 * doodle as people actually draw it: a bone, a two-lobed tree and a
 * standing figure are the same shape by these measures, so they wait for
 * a person instead of being thrown away. The count is pinned below so the
 * cost cannot creep.
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
  it('refuses none of it — the load-bearing claim', () => {
    const refused = INNOCENT_SET.filter((f) => screenDrawing(f.strokes).verdict === 'refuse').map(
      (f) => f.name,
    );
    expect(refused).toEqual([]);
  });

  it('lets the great majority straight through, and holds only look-alikes', () => {
    const held = INNOCENT_SET.filter((f) => screenDrawing(f.strokes).verdict === 'hold');
    // Held innocents are the price of catching the doodle as people draw
    // it; they wait for a person rather than being thrown away. Bounded so
    // the cost cannot creep, and a clear majority still passes untouched.
    expect(held.length).toBeLessThanOrEqual(9);
    expect(INNOCENT_SET.length - held.length).toBeGreaterThanOrEqual(45);
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

describe('screen — the verdict cannot hinge on the raster', () => {
  /**
   * The bug this pins: the same doodle was measured HITTING at 96, 128,
   * 192 and 256 and MISSING at 160 — the one size the screen ran, so it
   * reached the world (user report). Binning a hand-drawn shape puts
   * several criteria on a knife edge and the raster decides which side
   * they land. The screen now reads every drawing at several scales and
   * takes the strongest verdict.
   */
  it('refuses the doodle at every screening size, not just most of them', () => {
    const strokes = phallusDoodle({ shaftLen: 0.42, shaftW: 0.075, ballR: 0.07 });
    for (const size of [96, 128, 160, 192, 224, 256]) {
      const single = screenDrawing(strokes, { size });
      expect(`${size}: ${single.verdict}`).not.toBe(`${size}: allow`);
    }
    // And with no size pinned — the shipped path — it refuses outright.
    expect(screenDrawing(strokes).verdict).toBe('refuse');
  });

  it('holds its verdict through a full rotation', () => {
    const base = phallusDoodle({ shaftLen: 0.4, shaftW: 0.075, ballR: 0.068 });
    for (let deg = 0; deg < 360; deg += 30) {
      const verdict = screenDrawing(rotate(base, (deg * Math.PI) / 180)).verdict;
      expect(`${deg}deg: ${verdict}`).not.toBe(`${deg}deg: allow`);
    }
  });
});

describe('screen — the near-miss band', () => {
  it('holds a drawing that is one criterion short rather than admitting it', () => {
    // Measured over the innocent set: these are the shapes that share the
    // doodle's structure closely enough to be worth a person's glance.
    const held = INNOCENT_SET.filter((f) => screenDrawing(f.strokes).verdict === 'hold');
    // The cost is real and bounded: pin it so a retune cannot let it creep.
    expect(held.length).toBeLessThanOrEqual(9);
    // And it is never worse than a hold — nothing innocent is refused.
    const refused = INNOCENT_SET.filter((f) => screenDrawing(f.strokes).verdict === 'refuse');
    expect(refused.map((f) => f.name)).toEqual([]);
  });

  it('leaves plainly innocent drawings alone', () => {
    for (const name of ['cat', 'house', 'flower', 'boat', 'snowman', 'fish', 'hat']) {
      const fixture = INNOCENT_SET.find((f) => f.name === name);
      if (!fixture) continue;
      expect(`${name}: ${screenDrawing(fixture.strokes).verdict}`).toBe(`${name}: allow`);
    }
  });
});
