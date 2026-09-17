/**
 * The empty state of the phone's world view (src/ui/empty.ts).
 *
 * > User ask, 2026-09-17 (mobile): *"there should be better empty/loading
 * > states."*
 *
 * A handset can reach `?view=world` with no drawing of its own, and
 * everything that makes the view playable is keyed to that missing drawing
 * (src/main.ts `myDrawerId`). What is pinned here is that it SAYS so, in one
 * lowercase line with a way to fix it, in the mark set — and that no world
 * without the game ever reaches it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_LINE, EMPTY_LINK_LABEL, installEmptyState } from '../../src/ui/empty';
import { find, stubDom, type StubEl } from './stubdom';

describe('one line, and the way to fix it', () => {
  it('says what is missing rather than what went wrong, in lowercase', () => {
    expect(EMPTY_LINE).toBe('draw your creature first');
    for (const s of [EMPTY_LINE, EMPTY_LINK_LABEL]) {
      expect(s).toBe(s.toLowerCase());
      expect(s).not.toMatch(/[A-Z]/);
    }
  });

  it('mounts the line and a link back to the pad, carrying the world', () => {
    const dom = stubDom();
    const handle = installEmptyState({
      mount: dom.mount as unknown as HTMLElement,
      href: '/draw/?room=xkcd&world=valiocon',
    });
    expect(handle.line()).toBe(EMPTY_LINE);
    // The world travels in the url and nowhere else: a link that dropped it
    // would land somebody on a pad that publishes and stores nothing.
    expect(handle.href()).toContain('world=valiocon');
    expect(handle.href()).toContain('room=xkcd');
    expect(find(handle.el as unknown as StubEl, 'world-empty-link')!.textContent).toBe(
      EMPTY_LINK_LABEL,
    );
    handle.dispose();
    dom.restore();
  });

  it('arrives rather than appearing, and then keeps drifting (TASTE §2.1, §3)', () => {
    const dom = stubDom();
    const handle = installEmptyState({
      mount: dom.mount as unknown as HTMLElement,
      href: '/draw/?room=xkcd',
    });
    const el = handle.el as unknown as StubEl;
    expect(el.classes.has('in')).toBe(false);
    dom.step(16);
    expect(el.classes.has('in')).toBe(true);
    const drift = find(el, 'world-empty-drift')!;
    for (let f = 1; f <= 10; f++) dom.step(f * 40);
    const at = drift.style['transform'];
    expect(at).toMatch(/^translate\(/);
    for (let f = 11; f <= 40; f++) dom.step(f * 40);
    expect(drift.style['transform']).not.toBe(at);
    handle.dispose();
    dom.restore();
  });

  it('takes itself off the page on dispose', () => {
    const dom = stubDom();
    const handle = installEmptyState({
      mount: dom.mount as unknown as HTMLElement,
      href: '/draw/',
    });
    expect(dom.mount.children.length).toBe(1);
    handle.dispose();
    expect(dom.mount.children.length).toBe(0);
    dom.restore();
  });

  it('is marks only — a line and a rule-link (TASTE §4)', () => {
    const dom = stubDom();
    const handle = installEmptyState({
      mount: dom.mount as unknown as HTMLElement,
      href: '/draw/',
    });
    const sheet = dom.head.children[0]!.textContent;
    expect(sheet).toContain('border-bottom: 1px solid');
    expect(sheet).not.toMatch(/\bbackground\b/);
    expect(sheet).not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/border-radius/);
    expect(sheet).not.toMatch(/gradient/);
    expect(sheet).not.toMatch(/\b(?:linear|ease-in-out)\b/);
    expect(sheet).not.toMatch(/scale\(0/);
    handle.dispose();
    dom.restore();
  });
});

describe('the prompt is absent on a world without the game', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

  it('is the other half of the one gate, for a handset with no drawing', () => {
    const site =
      /if \(worldGame === 'katamari' && handheld\) \{[\s\S]*?\} else \{[\s\S]{0,700}?installEmptyState\(/;
    expect(main).toMatch(site);
    expect([...main.matchAll(/installEmptyState\(/g)].length).toBe(1);
  });

  it('is reached by a DYNAMIC import, so no other world fetches the chunk', () => {
    expect(main).toMatch(/void import\('\.\/ui\/empty'\)/);
    expect(main).not.toMatch(/^import .*'\.\/ui\/empty'/m);
  });

  it('points at the pad the rest of the flow points at', () => {
    expect(main).toMatch(/href: `\/draw\/\?room=\$\{room\}\$\{worldParam\}`/);
  });
});
