/**
 * Which game a world runs (src/world/game.ts).
 *
 * The property worth pinning is the negative one, harder here than for
 * residents, hatch or style: the shipped world is the DEFAULT, and the default
 * branch builds every world's production deployment at once. A merge that put
 * the katamari's rigid bodies and pickups on meridian had to be reverted
 * (2026-09-15 user ruling), so anything that is not exactly the word
 * `katamari` — a typo in worlds.json, an absent tag on the public build, a
 * stranger appending `?game=` to a link — has to land back on `none`.
 */

import { describe, expect, it } from 'vitest';
import { WORLD_GAMES, opensOnLandscape, readWorldGame, sanitizeGame } from '../../src/world/game';
import { sanitizeGame as sanitizeGameBuild } from '../../scripts/world-build.mjs';

describe('sanitizeGame — only the exact word opts in', () => {
  it('reads the word, trimmed and case-folded', () => {
    expect(sanitizeGame('katamari')).toBe('katamari');
    expect(sanitizeGame('  katamari  ')).toBe('katamari');
    expect(sanitizeGame(' Katamari ')).toBe('katamari');
  });

  it('falls back onto the shipped world for anything else', () => {
    // the failure of a misread game is rigid bodies, sticky rules and an
    // island on a world that never asked for any of them.
    expect(sanitizeGame('none')).toBe('none');
    expect(sanitizeGame('katamar')).toBe('none');
    expect(sanitizeGame('katamaris')).toBe('none');
    expect(sanitizeGame('sticky')).toBe('none');
    expect(sanitizeGame('')).toBe('none');
    expect(sanitizeGame(null)).toBe('none');
    expect(sanitizeGame(undefined)).toBe('none');
    expect(sanitizeGame(7)).toBe('none');
    expect(sanitizeGame({})).toBe('none');
    expect(sanitizeGame(true)).toBe('none');
  });

  it('agrees with the build script about every value either can produce', () => {
    // otherwise the tag a build injects and the app's reading of it could name
    // two different games — the same discipline as residents, hatch and style.
    for (const value of [...WORLD_GAMES, 'Katamari', 'nonsense', '', ' katamari ', null]) {
      expect(sanitizeGame(value)).toBe(sanitizeGameBuild(value));
    }
  });

  it('lists exactly the two games that exist', () => {
    expect([...WORLD_GAMES]).toEqual(['none', 'katamari']);
  });
});

describe('readWorldGame — the address, then the tag, then the shipped world', () => {
  it('is the shipped world when nothing says otherwise', () => {
    // the public build injects no tag at all, and this is the line that keeps
    // it that way in the app as well as in the html.
    expect(readWorldGame('', null)).toBe('none');
    expect(readWorldGame('?world=meridian', null)).toBe('none');
    expect(readWorldGame('?room=abcd', null)).toBe('none');
  });

  it('reads the baked tag', () => {
    expect(readWorldGame('', 'katamari')).toBe('katamari');
    expect(readWorldGame('?world=valiocon', 'katamari')).toBe('katamari');
  });

  it('lets the address override the tag, both ways', () => {
    // for a rehearsal or a comparison without a deploy.
    expect(readWorldGame('?game=katamari', null)).toBe('katamari');
    expect(readWorldGame('?game=none', 'katamari')).toBe('none');
    expect(readWorldGame('?game=katamari', 'none')).toBe('katamari');
  });

  it('falls back to the tag when the address says nothing it understands', () => {
    // the same shape as readWorldStyle and readHatchMode: a query value this
    // app does not know must not silently switch off the world an operator is
    // standing in.
    expect(readWorldGame('?game=', 'katamari')).toBe('katamari');
    expect(readWorldGame('?game=sometimes', 'katamari')).toBe('katamari');
    expect(readWorldGame('?game=nonsense', null)).toBe('none');
  });

  it('takes the query however it was written, and a bare search string', () => {
    expect(readWorldGame('game=katamari', null)).toBe('katamari');
    expect(readWorldGame('?game=KATAMARI', null)).toBe('katamari');
    expect(readWorldGame('?room=abcd&game=katamari&world=valiocon', null)).toBe('katamari');
  });

  it('a typo on the address cannot start the game on a world without it', () => {
    for (const asked of ['katamar', 'katamari!', 'sticky', 'true', '1']) {
      expect(readWorldGame(`?game=${asked}`, null)).toBe('none');
    }
  });
});

describe('opensOnLandscape — a katamari world opens on its island', () => {
  it('every other world opens plain unless the address asks for the map', () => {
    expect(opensOnLandscape('none', null)).toBe(false);
    expect(opensOnLandscape('none', '')).toBe(false);
    expect(opensOnLandscape('none', '1')).toBe(true);
    expect(opensOnLandscape('none', 'on')).toBe(true);
    expect(opensOnLandscape('none', 'yes')).toBe(false);
  });

  it('the katamari world opens on the map — the island is the map', () => {
    expect(opensOnLandscape('katamari', null)).toBe(true);
    expect(opensOnLandscape('katamari', '')).toBe(true);
    expect(opensOnLandscape('katamari', '1')).toBe(true);
  });

  it('but the address can still open it plain for a comparison', () => {
    expect(opensOnLandscape('katamari', '0')).toBe(false);
    expect(opensOnLandscape('katamari', 'off')).toBe(false);
  });
});
