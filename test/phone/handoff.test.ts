/**
 * The world travels in the url, and every hop has to carry it.
 *
 * A handset's world is not stored anywhere — it is a query param, handed
 * from the scanned code to the pad, from the pad to the companion, and
 * from the companion back to either. Any hop that rebuilds the url by hand
 * and forgets `?world` silently drops the person out of the public world:
 * `mountWorldLink` then has nowhere to point, mounts nothing, and the
 * toggle between the world and the device is simply absent — for
 * everybody who arrived by scanning the code, which is everybody.
 *
 * That is exactly what happened (user report, 2026-08-25): of the five
 * navigations between the three pages, three built their own url and
 * three dropped the world.
 *
 * The fix is one builder per page, so these check that there IS only one
 * and that it carries the world. Pinned as source facts because both live
 * in navigation code with no seam to call — the loop itself is walked in a
 * real browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worldHref } from '../../src/phone/worldlink';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the pad hands off to the companion', () => {
  const src = () => read('public/draw/index.html');

  it('builds that url in exactly one place', () => {
    // Three routes reach the companion: a handset that already drew, a
    // recovery hand-back, and the send that just happened.
    const built = src().match(/'\/phone\.html/g) ?? [];
    expect(built).toHaveLength(1);
    expect(src()).toMatch(/function companionUrl\(/);
  });

  it('and that one place carries the world', () => {
    const fn = /function companionUrl\([\s\S]*?\n    \}/.exec(src())?.[0] ?? '';
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/world=' \+ encodeURIComponent\(WORLD\)/);
    // ...along with the room and the epoch it already carried.
    expect(fn).toMatch(/room=' \+ room/);
    expect(fn).toMatch(/&w=/);
  });

  it('leaves no hand-rolled companion url behind', () => {
    // The two that dropped the world were built inline at the call site.
    expect(src()).not.toMatch(/location\.(href|replace)\s*=?\s*\(?'\/phone\.html/);
  });
});

describe('the companion hands back to the pad', () => {
  const src = () => read('src/phone/main.ts');

  it('builds that url in exactly one place', () => {
    // Two routes go back: "draw again", and a record too old for this world.
    const built = src().match(/`\/draw\/\?room=/g) ?? [];
    expect(built).toHaveLength(1);
    expect(src()).toMatch(/const padUrl = /);
  });

  it('and that one place carries the world', () => {
    const fn = /const padUrl = [\s\S]*?;\n/.exec(src())?.[0] ?? '';
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/world=\$\{encodeURIComponent\(publicWorld\)\}/);
    expect(fn).toMatch(/room=\$\{room\}/);
  });
});

describe('the companion hands off to the world', () => {
  it('carries the room, the world, and the view that stops a bounce', () => {
    const href = worldHref('zkyz', 'public');
    const params = new URLSearchParams(href.slice(href.indexOf('?')));
    expect(params.get('room')).toBe('zkyz');
    expect(params.get('world')).toBe('public');
    // Without `view=world` the world page sends a handset straight back to
    // the pad, which is the same round trip this whole file is about.
    expect(params.get('view')).toBe('world');
  });

  it('leads nowhere when there is no public world to lead to', () => {
    // An installation handset's world is a projection in the same room.
    const href = worldHref('zkyz', '');
    expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('world')).toBeNull();
  });
});

describe('the world hands off to the pad', () => {
  it('carries the world when it has one', () => {
    // src/main.ts sends a handset that is not asking for the world view to
    // the pad; `worldParam` is empty for an installation room.
    const src = read('src/main.ts');
    expect(src).toMatch(/location\.replace\(`\/draw\/\?room=\$\{room\}\$\{worldParam\}`\)/);
    expect(src).toMatch(/worldParam = isPublic \? `&world=\$\{encodeURIComponent\(publicWorld\)\}` : ''/);
  });
});
