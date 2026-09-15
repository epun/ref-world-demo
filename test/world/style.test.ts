/**
 * Which look a world renders in (src/world/style.ts).
 *
 * The property worth pinning is the negative one, the same as residents and
 * hatch: the shipped `ink` look is the taste, so anything that is not exactly
 * the word `ghibli` has to land back on it. A typo in worlds.json, or a
 * stranger appending `?style=` to a link, must not be able to repaint a
 * client's world into a palette the taste does not describe.
 */

import { describe, expect, it } from 'vitest';
import { WORLD_STYLES, readWorldStyle, sanitizeStyle } from '../../src/world/style';
import { sanitizeStyle as sanitizeStyleBuild } from '../../scripts/world-build.mjs';

describe('sanitizeStyle — only the exact word opts in', () => {
  it('reads the word, trimmed and case-folded', () => {
    expect(sanitizeStyle('ghibli')).toBe('ghibli');
    expect(sanitizeStyle('  ghibli  ')).toBe('ghibli');
    expect(sanitizeStyle(' Ghibli ')).toBe('ghibli');
  });

  it('falls back onto the shipped look for anything else', () => {
    // the failure of a misread style is a frame in a palette nobody chose.
    expect(sanitizeStyle('ink')).toBe('ink');
    expect(sanitizeStyle('ghibl')).toBe('ink');
    expect(sanitizeStyle('toon')).toBe('ink');
    expect(sanitizeStyle('')).toBe('ink');
    expect(sanitizeStyle(null)).toBe('ink');
    expect(sanitizeStyle(undefined)).toBe('ink');
    expect(sanitizeStyle(7)).toBe('ink');
    expect(sanitizeStyle({})).toBe('ink');
  });

  it('agrees with the build script about every value either can produce', () => {
    // otherwise the tag a build injects and the app's reading of it could name
    // two different looks — the same discipline as residents and hatch.
    for (const value of [...WORLD_STYLES, 'Ghibli', 'nonsense', '', ' ghibli ']) {
      expect(sanitizeStyle(value)).toBe(sanitizeStyleBuild(value));
    }
  });

  it('lists exactly the two looks that exist', () => {
    expect([...WORLD_STYLES]).toEqual(['ink', 'ghibli']);
  });
});

describe('readWorldStyle — the address, then the tag, then the taste', () => {
  it('is the shipped look when nothing says otherwise', () => {
    expect(readWorldStyle('', null)).toBe('ink');
    expect(readWorldStyle('?world=valiocon', null)).toBe('ink');
  });

  it('reads the baked tag', () => {
    expect(readWorldStyle('', 'ghibli')).toBe('ghibli');
    expect(readWorldStyle('?world=valiocon', 'ghibli')).toBe('ghibli');
  });

  it('lets the address override the tag, both ways', () => {
    // for a rehearsal or a comparison without a deploy.
    expect(readWorldStyle('?style=ghibli', null)).toBe('ghibli');
    expect(readWorldStyle('?style=ink', 'ghibli')).toBe('ink');
    expect(readWorldStyle('?style=ghibli', 'ink')).toBe('ghibli');
  });

  it('falls back to the tag when the address says nothing it understands', () => {
    // the same shape as readHatchMode: a query value this app does not know
    // must not silently reset the world an operator is standing in.
    expect(readWorldStyle('?style=', 'ghibli')).toBe('ghibli');
    expect(readWorldStyle('?style=sometimes', 'ghibli')).toBe('ghibli');
    expect(readWorldStyle('?style=nonsense', null)).toBe('ink');
  });

  it('takes the query however it was written, and a bare search string', () => {
    expect(readWorldStyle('style=ghibli', null)).toBe('ghibli');
    expect(readWorldStyle('?style=GHIBLI', null)).toBe('ghibli');
    expect(readWorldStyle('?room=abcd&style=ghibli&world=valiocon', null)).toBe('ghibli');
  });
});
