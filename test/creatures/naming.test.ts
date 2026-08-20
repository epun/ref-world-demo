/**
 * Generated names: an unsigned creature still gets called something, and
 * the same drawing gets called the same thing on every device and on every
 * replay.
 */

import { describe, expect, it } from 'vitest';
import { generatedName, NAME_SPACE, resolveName } from '../../src/creatures/naming';

describe('generated names', () => {
  it('is a pure function of the id — the whole reason replay works', () => {
    for (const id of ['d-phone-1', 'abc', '', 'ẞ✓', 'x'.repeat(200)]) {
      expect(generatedName(id)).toBe(generatedName(id));
    }
  });

  it('is lowercase and nothing else (taste §5 — no uppercase anywhere)', () => {
    for (let i = 0; i < 500; i++) {
      const n = generatedName(`id-${i}`);
      expect(n).toBe(n.toLowerCase());
      expect(n).toMatch(/^[a-z]+$/);
    }
  });

  it('is short enough to sit under a creature without becoming the subject', () => {
    for (let i = 0; i < 500; i++) {
      const n = generatedName(`id-${i}`);
      expect(n.length).toBeGreaterThanOrEqual(2);
      expect(n.length).toBeLessThanOrEqual(10);
    }
  });

  it('spreads across the space rather than collapsing onto a few names', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) seen.add(generatedName(`drawer-${i}`));
    // Not a uniqueness claim — just that the hash is not degenerate.
    expect(seen.size).toBeGreaterThan(NAME_SPACE * 0.8);
  });

  it('mixes one-part and two-part names, so it does not read as a pattern', () => {
    const names: string[] = [];
    for (let i = 0; i < 300; i++) names.push(generatedName(`m-${i}`));
    const short = names.filter((n) => n.length <= 4).length;
    expect(short).toBeGreaterThan(20);
    expect(short).toBeLessThan(names.length - 20);
  });
});

describe('signed beats generated', () => {
  it('keeps the name the person actually typed', () => {
    expect(resolveName('evan', 'id-1')).toBe('evan');
    expect(resolveName('  ana  ', 'id-1')).toBe('ana');
  });

  it('generates when they skipped — null, undefined, empty or all spaces', () => {
    const fallback = generatedName('id-1');
    expect(resolveName(null, 'id-1')).toBe(fallback);
    expect(resolveName(undefined, 'id-1')).toBe(fallback);
    expect(resolveName('', 'id-1')).toBe(fallback);
    expect(resolveName('   ', 'id-1')).toBe(fallback);
  });
});
