/**
 * The onboarding screens (src/ui/onboard.ts, src/ui/onboardcopy.ts).
 *
 * > User ask, 2026-09-17 (mobile): *"we should have an onboarding stage to
 * > tell people how to play the game, before they load into the world. i.e.
 * > move with joystick to move character, run into objects to pick them up,
 * > grow your mass as large as you can."*
 *
 * Five things are pinned here, in the order they can go wrong:
 *
 * 1. THE COPY — three lines, in the order the game is learned, all lowercase
 *    (TASTE §5, confidence 1.00), each with one of the marks that already
 *    exist in this world.
 * 2. ONCE PER DEVICE — the flag, the try/catch around a store that throws,
 *    and the `?onboard=1` that re-shows it for testing.
 * 3. THE SCREENS THEMSELVES — three in order, forward and back, with taps
 *    and swipes, and a skip that ends it from anywhere.
 * 4. THE MARK SET — `icon` + `ruleLine` + `border` and nothing else
 *    (TASTE §4): the sheet is read back and checked for the things a screen
 *    is most likely to grow — a card, a shadow, a rounded filled button.
 * 5. THE GATE — none of it is reached on a world without the game, and it is
 *    reached by a dynamic import so no other world fetches the chunk.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ONBOARD_COUNT,
  ONBOARD_KEY,
  SWIPE_PX,
  iconRings,
  installOnboarding,
  markOnboarded,
  onboarded,
  shouldOnboard,
} from '../../src/ui/onboard';
import {
  ONBOARD_SCREENS,
  SKIP_LABEL,
  START_LABEL,
  type OnboardIcon,
} from '../../src/ui/onboardcopy';
import { find, findAll, stubDom, stubStore, type StubEl } from './stubdom';

describe('the copy — three lines, in the order the game is learned', () => {
  it('says how to move, what moving is for, and what the game is', () => {
    expect(ONBOARD_SCREENS.map((s) => s.line)).toEqual([
      'move with the joystick to roll your creature',
      'run into things to pick them up',
      'grow as big as you can',
    ]);
    expect(ONBOARD_COUNT).toBe(3);
  });

  it('is lowercase, everywhere, including the two affordances (TASTE §5)', () => {
    for (const line of [...ONBOARD_SCREENS.map((s) => s.line), SKIP_LABEL, START_LABEL]) {
      expect(line).toBe(line.toLowerCase());
      expect(line).not.toMatch(/[A-Z]/);
    }
  });

  it('is one line each — read standing up, on a phone', () => {
    for (const { line } of ONBOARD_SCREENS) {
      expect(line).not.toContain('\n');
      expect(line.length).toBeLessThan(56);
    }
  });

  it('asks only for marks this world already draws', () => {
    const kinds: OnboardIcon[] = ['stick', 'pickup', 'grow'];
    expect(ONBOARD_SCREENS.map((s) => s.icon)).toEqual(kinds);
    for (const kind of kinds) {
      const rings = iconRings(kind);
      // Every mark is a ring, because every mark in this world is one.
      expect(rings.length).toBeGreaterThan(0);
      for (const r of rings) expect(r.r).toBeGreaterThan(0);
    }
  });

  it('draws the growing pair small-then-big, which is what growing is', () => {
    const [small, big] = iconRings('grow');
    expect(big!.r).toBeGreaterThan(small!.r * 2);
  });
});

describe('seen once per device', () => {
  it('shows on a handset that has never seen it', () => {
    expect(shouldOnboard('', stubStore())).toBe(true);
  });

  it('does not show once the flag is written', () => {
    const store = stubStore();
    markOnboarded(store);
    expect(store.data[ONBOARD_KEY]).toBe('1');
    expect(onboarded(store)).toBe(true);
    expect(shouldOnboard('', store)).toBe(false);
  });

  it('re-shows for ?onboard=1, whatever the flag says', () => {
    const store = stubStore({ [ONBOARD_KEY]: '1' });
    expect(shouldOnboard('?onboard=1', store)).toBe(true);
    expect(shouldOnboard('?view=world&onboard=1', store)).toBe(true);
    // …and can be turned off on a device that has not seen it.
    expect(shouldOnboard('?onboard=0', stubStore())).toBe(false);
  });

  it('survives a store that throws, and shows rather than hiding', () => {
    const angry = {
      getItem: (): string | null => {
        throw new Error('private window');
      },
      setItem: (): void => {
        throw new Error('private window');
      },
    };
    expect(() => onboarded(angry)).not.toThrow();
    expect(onboarded(angry)).toBe(false);
    expect(() => markOnboarded(angry)).not.toThrow();
    expect(shouldOnboard('', angry)).toBe(true);
    // No store at all is the same answer, for the same reason.
    expect(shouldOnboard('', null)).toBe(true);
  });
});

// ── the screens, against a recording DOM ─────────────────────────────────────

function mountScreens(store = stubStore()): {
  dom: ReturnType<typeof stubDom>;
  handle: ReturnType<typeof installOnboarding>;
  reasons: string[];
} {
  const dom = stubDom();
  const reasons: string[] = [];
  const handle = installOnboarding({
    mount: dom.mount as unknown as HTMLElement,
    onDone: (reason) => reasons.push(reason),
    store,
  });
  return { dom, handle, reasons };
}

/** What is on the surface right now. */
function onScreen(handle: { el: unknown }): string {
  const screens = findAll(handle.el as StubEl, 'onboard-screen');
  const live = screens.filter((s) => !s.classes.has('out'));
  return find(live[live.length - 1]!, 'onboard-line')?.textContent ?? '';
}

describe('three screens, in order, forwards and back', () => {
  it('opens on the first one and slides it in rather than popping it', () => {
    const { dom, handle } = mountScreens();
    expect(handle.index()).toBe(0);
    expect(onScreen(handle)).toBe(ONBOARD_SCREENS[0]!.line);
    const screen = findAll(handle.el as unknown as StubEl, 'onboard-screen')[0]!;
    // Off to the side until two frames have passed — the transition needs a
    // state to come FROM, or the screen appears instead of arriving.
    expect(screen.classes.has('in')).toBe(false);
    dom.step(16);
    dom.step(32);
    expect(screen.classes.has('in')).toBe(true);
    handle.dispose();
    dom.restore();
  });

  it('advances on a tap and on a swipe, and goes back on the other swipe', () => {
    const { dom, handle } = mountScreens();
    const field = handle.el as unknown as StubEl;

    // A tap: down and up in the same place.
    field.fire('pointerdown', { clientX: 200 });
    field.fire('pointerup', { clientX: 200 });
    expect(handle.index()).toBe(1);
    expect(onScreen(handle)).toBe(ONBOARD_SCREENS[1]!.line);

    // A swipe left is the same "on".
    field.fire('pointerdown', { clientX: 300 });
    field.fire('pointerup', { clientX: 300 - SWIPE_PX - 10 });
    expect(handle.index()).toBe(2);

    // …and a swipe right is back.
    field.fire('pointerdown', { clientX: 100 });
    field.fire('pointerup', { clientX: 100 + SWIPE_PX + 10 });
    expect(handle.index()).toBe(1);
    expect(onScreen(handle)).toBe(ONBOARD_SCREENS[1]!.line);
    handle.dispose();
    dom.restore();
  });

  it('cannot go back past the first screen', () => {
    const { dom, handle } = mountScreens();
    handle.back();
    expect(handle.index()).toBe(0);
    handle.dispose();
    dom.restore();
  });

  it('marks progress on three ticks, one per screen', () => {
    const { dom, handle } = mountScreens();
    const ticks = findAll(handle.el as unknown as StubEl, 'onboard-tick');
    expect(ticks.length).toBe(ONBOARD_COUNT);
    expect(ticks.map((t) => t.dataset['at'])).toEqual(['true', 'false', 'false']);
    handle.next();
    expect(ticks.map((t) => t.dataset['at'])).toEqual(['true', 'true', 'false']);
    handle.next();
    expect(ticks.map((t) => t.dataset['at'])).toEqual(['true', 'true', 'true']);
    handle.dispose();
    dom.restore();
  });

  it('offers the way in only on the last screen', () => {
    const { dom, handle } = mountScreens();
    const start = find(handle.el as unknown as StubEl, 'onboard-start')!;
    expect(start.classes.has('in')).toBe(false);
    handle.next();
    expect(start.classes.has('in')).toBe(false);
    handle.next();
    expect(start.classes.has('in')).toBe(true);
    handle.dispose();
    dom.restore();
  });

  it('starts from the last screen, once, and slides the field away', () => {
    const { dom, handle, reasons } = mountScreens();
    handle.next();
    handle.next();
    const start = find(handle.el as unknown as StubEl, 'onboard-start')!;
    start.fire('click');
    expect(reasons).toEqual(['start']);
    expect(handle.finished()).toBe(true);
    // It LEAVES rather than vanishing: the class the sheet transitions.
    expect((handle.el as unknown as StubEl).classes.has('out')).toBe(true);
    // A second thumb cannot start twice.
    start.fire('click');
    expect(reasons).toEqual(['start']);
    handle.dispose();
    dom.restore();
  });

  it('skips from the first screen with one tap, and remembers that it did', () => {
    const store = stubStore();
    const { dom, handle, reasons } = mountScreens(store);
    const skip = find(handle.el as unknown as StubEl, 'onboard-skip')!;
    skip.fire('click');
    expect(reasons).toEqual(['skip']);
    expect(handle.index()).toBe(0);
    // A skip is somebody saying they have seen it, so the flag is written —
    // and the next load goes straight to the world.
    expect(store.data[ONBOARD_KEY]).toBe('1');
    expect(shouldOnboard('', store)).toBe(false);
    handle.dispose();
    dom.restore();
  });

  it('does not also advance a screen on the way out of a skip', () => {
    const { dom, handle } = mountScreens();
    const skip = find(handle.el as unknown as StubEl, 'onboard-skip')!;
    // The field is listening for pointerup too; the link stops it, or one
    // thumb would get two answers.
    skip.fire('pointerup', { clientX: 10 });
    expect(handle.index()).toBe(0);
    handle.dispose();
    dom.restore();
  });

  it('keeps drifting while somebody reads it (TASTE §3)', () => {
    const { dom, handle } = mountScreens();
    const drift = find(handle.el as unknown as StubEl, 'onboard-drift')!;
    for (let f = 1; f <= 10; f++) dom.step(f * 40);
    const at = drift.style['transform'];
    expect(at).toMatch(/^translate\(/);
    for (let f = 11; f <= 40; f++) dom.step(f * 40);
    expect(drift.style['transform']).not.toBe(at);
    handle.dispose();
    dom.restore();
  });

  it('takes itself off the page on dispose, and stops asking for frames', () => {
    const { dom, handle } = mountScreens();
    expect(dom.mount.children.length).toBe(1);
    handle.dispose();
    expect(dom.mount.children.length).toBe(0);
    dom.restore();
  });

  it('mounts one sheet however many times it is installed', () => {
    const { dom, handle } = mountScreens();
    const second = installOnboarding({
      mount: dom.mount as unknown as HTMLElement,
      onDone: () => {},
      store: stubStore(),
    });
    expect(dom.head.children.length).toBe(1);
    handle.dispose();
    second.dispose();
    dom.restore();
  });

  it('is marks only — no card, no shadow, no filled button (TASTE §4)', () => {
    const { dom, handle } = mountScreens();
    const sheet = dom.head.children[0]!.textContent;
    // The ruleLine and border marks are there…
    expect(sheet).toContain('border-bottom: 1px solid');
    // …and the marks that are not in this taste's vocabulary are not.
    expect(sheet).not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/\bfilter\s*:\s*drop-shadow/);
    expect(sheet).not.toMatch(/border-radius/);
    expect(sheet).not.toMatch(/gradient/);
    // The one surface is the field itself, painted in the flow's own paper —
    // one background declaration in the whole sheet, and no second one under
    // a word, a tick or a screen.
    expect([...sheet.matchAll(/background:/g)].length).toBe(1);
    // Motion is on the settle curve, never linear and never ease-in-out, and
    // nothing scales up from nothing.
    expect(sheet).not.toMatch(/\b(?:linear|ease-in-out)\b/);
    expect(sheet).not.toMatch(/scale\(0/);
    // And the label a screen reader reads is lowercase, like every string.
    const label = (handle.el as unknown as StubEl).attrs['aria-label']!;
    expect(label).toBe(label.toLowerCase());
    handle.dispose();
    dom.restore();
  });
});

describe('the screens are absent on a world without the game', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

  it('is mounted only behind the katamari flag, the handset and a creature', () => {
    const site =
      /if \(worldGame === 'katamari' && handheld\) \{[\s\S]{0,600}?if \(myDrawerId\.length > 0\) \{[\s\S]{0,900}?installOnboarding\(/;
    expect(main).toMatch(site);
    expect([...main.matchAll(/installOnboarding\(/g)].length).toBe(1);
  });

  it('is reached by a DYNAMIC import, so no other world fetches the chunk', () => {
    expect(main).toMatch(/void import\('\.\/ui\/onboard'\)/);
    expect(main).not.toMatch(/^import .*'\.\/ui\/onboard'/m);
    expect(main).not.toMatch(/^import .*'\.\/ui\/onboardcopy'/m);
  });

  it('asks the flag before it mounts anything', () => {
    expect(main).toMatch(/if \(!m\.shouldOnboard\(location\.search, m\.deviceStore\(\)\)\) return;/);
  });
});
