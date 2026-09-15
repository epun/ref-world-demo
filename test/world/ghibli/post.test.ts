/**
 * The ink pass's ghibli dials (src/world/ghibli/post.ts).
 *
 * The port's shape is the thing worth pinning: envpaint has seven dials here
 * and `InkParams` has four, so `applyGhibliPost` must write the three that
 * map and must NOT invent the four that do not — and it must leave
 * `edgeThreshold` alone, because that number was landed by screenshot against
 * this world's own geometry and has no envpaint counterpart in the same
 * units.
 */

import { describe, expect, it } from 'vitest';
import type { InkParams } from '../../../src/world/ink';
import { GHIBLI_INK_PARAMS, GHIBLI_POST, applyGhibliPost } from '../../../src/world/ghibli/post';

function sink(): { params: Partial<InkParams>[]; setParams(next: Partial<InkParams>): void } {
  const params: Partial<InkParams>[] = [];
  return {
    params,
    setParams(next: Partial<InkParams>): void {
      params.push(next);
    },
  };
}

describe('applyGhibliPost', () => {
  it('writes the three dials the ink pass has', () => {
    const ink = sink();
    applyGhibliPost(ink);
    expect(ink.params).toHaveLength(1);
    expect(ink.params[0]).toEqual({
      lineWidth: GHIBLI_POST.lineWidth,
      wobble: GHIBLI_POST.wobble,
      hatchStrength: GHIBLI_POST.hatch,
    });
  });

  it('never touches edgeThreshold', () => {
    const ink = sink();
    applyGhibliPost(ink);
    expect('edgeThreshold' in ink.params[0]!).toBe(false);
  });

  it('hands over a copy, so a caller cannot mutate the token set', () => {
    const ink = sink();
    applyGhibliPost(ink);
    expect(ink.params[0]).not.toBe(GHIBLI_INK_PARAMS);
  });

  it('keeps the four unported dials recorded, so the port stays legible', () => {
    // They are not written anywhere — they are here to be read beside the
    // module's own table of what would have to change first.
    expect(GHIBLI_POST.break).toBeGreaterThan(0);
    expect(GHIBLI_POST.inkOpacity).toBeGreaterThan(0);
    expect(GHIBLI_POST.hatchScale).toBeGreaterThan(0);
    expect(GHIBLI_POST.pooling).toBeGreaterThan(0);
    expect(Object.keys(GHIBLI_INK_PARAMS)).toHaveLength(3);
  });

  it('is the pencil line: thinner and wobblier than the shipped ink', () => {
    // src/world/ink.ts ships lineWidth 2.1 / wobble 1.6; the pencil is a
    // lighter, looser line, which is the whole reason for the override.
    expect(GHIBLI_POST.lineWidth).toBeLessThan(2.1);
    expect(GHIBLI_POST.wobble).toBeLessThan(1.6);
  });
});
