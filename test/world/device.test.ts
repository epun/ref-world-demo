/**
 * `deviceTier` — the one read of what kind of screen this is.
 *
 * Most of the katamari's audience is watching from a phone, each running its
 * own copy of the world page, so "how much can this page afford" is a
 * question several layers ask and it needs exactly one answer.
 */

import { describe, expect, it } from 'vitest';
import { DEBRIS_CAP, deviceTier } from '../../src/world/device';

describe('deviceTier', () => {
  it('reads a coarse pointer as a phone', () => {
    expect(deviceTier((q) => q === '(pointer: coarse)')).toBe('phone');
  });

  it('reads anything else as a projection', () => {
    expect(deviceTier(() => false)).toBe('projection');
  });

  it('asks the coarse-pointer query and nothing else', () => {
    const asked: string[] = [];
    deviceTier((q) => {
      asked.push(q);
      return false;
    });
    expect(asked).toEqual(['(pointer: coarse)']);
  });

  it('falls back to projection with no matchMedia at all', () => {
    // Node has none. The default matcher must not throw — a world that
    // refused to start off-DOM would take every test in the suite with it.
    expect(deviceTier()).toBe('projection');
  });
});

describe('DEBRIS_CAP', () => {
  it('gives a phone a smaller ceiling than a projection, and both are real', () => {
    expect(DEBRIS_CAP.phone).toBeGreaterThan(0);
    expect(DEBRIS_CAP.projection).toBeGreaterThan(DEBRIS_CAP.phone);
    expect(Number.isInteger(DEBRIS_CAP.phone)).toBe(true);
    expect(Number.isInteger(DEBRIS_CAP.projection)).toBe(true);
  });
});
