/**
 * Generated names: an unsigned creature still gets called something, and
 * the same drawing gets called the same thing on every device and on every
 * replay.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('a signed name is lowercased', () => {
  // No type in this world is uppercase (TASTE §5, confidence 1.00). The
  // static gate reads string literals in the source, so it cannot see a
  // name somebody types into a phone — the first real drawing on the
  // public world came in signed `Bob` and went straight past it.
  it('however it was typed', () => {
    expect(resolveName('Bob', 'id-1')).toBe('bob');
    expect(resolveName('EVAN', 'id-1')).toBe('evan');
    expect(resolveName('  Ana  ', 'id-1')).toBe('ana');
    expect(resolveName('McTavish', 'id-1')).toBe('mctavish');
  });

  it('and a generated one is lowercase already', () => {
    // The word lists are lowercase, but a fallback that ever gained a
    // capital would slip past the same blind spot.
    for (const id of ['a', 'rec-000', 'zzz', 'dsly2pqawg']) {
      const name = resolveName(null, id);
      expect(name).toBe(name.toLowerCase());
    }
  });

  it('everywhere a name is shown, not just on the handset', () => {
    // It was lowercased at render on the companion and nowhere else, so the
    // same creature read `bob` on a phone and `Bob` in moderation. The
    // moderation page cannot import from src/, so it mirrors this.
    const page = readFileSync(join(process.cwd(), 'public/moderate/index.html'), 'utf8');
    expect(page).toMatch(/d\.name\.toLowerCase\(\)/);
  });
});
