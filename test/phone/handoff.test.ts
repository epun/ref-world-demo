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

describe('the way back to the world, as a control', () => {
  const src = () => read('src/phone/worldlink.ts');
  const css = () => read('src/phone/device.ts');

  it('says what it does, in lowercase', () => {
    // "the world" read as a caption. It is the only way out of the device,
    // so it says what pressing it does (user ruling, 2026-08-25) — and it
    // says it in lowercase, because no type in this world is uppercase
    // (TASTE §5), which is why it is not "View World".
    const assigned = /label\.textContent = '([^']*)'/.exec(src())?.[1];
    expect(assigned).toBe('view world');
    expect(assigned).toBe(assigned!.toLowerCase());
    // and the old caption is gone from the code, comments aside
    expect(src()).not.toMatch(/textContent = 'the world'/);
  });

  it('is a border all the way round, and nothing else', () => {
    // What makes it a button rather than a caption is the closed border
    // and the room inside it. Not a fill and not a shadow: the mark set is
    // icon + ruleLine + border and admits neither (TASTE §4).
    const rule = /\.world-link \{[\s\S]*?\n\}/.exec(css())?.[0] ?? '';
    expect(rule).toBeTruthy();
    expect(rule).not.toMatch(/box-shadow/);
    expect(rule).not.toMatch(/background/);
    // The old single rule is gone.
    expect(rule).not.toMatch(/border-top/);
    // A finger's worth of target.
    expect(rule).toMatch(/min-height: 44px/);
  });

  it('draws that border with the same hand as the minimap', () => {
    // One generator, one smoothing — see wavyBorderPath. A hand-rolled
    // rounded rectangle here would be a second hand on the same screen.
    expect(src()).toMatch(/wavyBorderPath\(wavyBorderPoints\(/);
    expect(src()).toMatch(/from '\.\/minimap'/);
  });

  it('comes BACK after the panel closes', () => {
    // The regression this exists for. The panel keeps its frame alive
    // between opens, so this document is not reloaded — and the faded-out,
    // already-going state survived with it. Reproduced on the old code:
    // round 1 opacity 1, rounds 2 and 3 opacity 0 with going="true", so
    // the only way out of the device was invisible and dead.
    const framed = /if \(framed\(\)\) \{[\s\S]*?\n    \}/.exec(src())?.[0] ?? '';
    expect(framed).toBeTruthy();
    expect(framed).toMatch(/delete el\.dataset\['going'\]/);
    expect(framed).toMatch(/classList\.remove\('out'\)/);
    expect(framed).toMatch(/classList\.add\('in'\)/);
    // ...after the panel has finished leaving, so the fade is still seen.
    expect(framed).toMatch(/MOTION\.secondaryMs/);
  });
});
