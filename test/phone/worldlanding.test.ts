/**
 * ON A KATAMARI WORLD THE WORLD IS WHERE A HANDSET LANDS
 * (src/phone/main.ts, src/phone/worldlink.ts, scripts/world-build.mjs).
 *
 * > User report, 2026-09-17: *"the mobile experience is really bad."* And the
 * > one before it: *"on mobile I'm not seeing the loading screen — we should
 * > give the user a tutorial on how to control their character using the
 * > joystick and the goal to roll over things and grow your mass."*
 *
 * The cause was a path, not a component: a handset opening the world link is
 * redirected to `/draw/`, the pad sends it to `/phone.html` when the drawing
 * is submitted, and nothing there went on to `?view=world` — so the stick,
 * the ball readout, the minimap, the hints and the loading line were all
 * mounted on a page the person never reached.
 *
 * What is pinned here:
 *
 * 1. THE GAME TAG on phone.html — injected for a katamari world, absent for
 *    every other one (byte-identical html), and spelled exactly as
 *    index.html's is, so the two can never name different games.
 * 2. THE ONE EXIT. `leaveForWorld` navigates to the world view after the
 *    device's own slide, and inside the world's panel it closes the panel
 *    instead of navigating.
 * 3. THE WIRING, read out of src/phone/main.ts: the four conditions, and that
 *    nothing stands between the pad and the world — the teaching is in the
 *    world view now (src/ui/hints.ts, 2026-09-17: *"For mobile I want the
 *    onboarding to be contextual within the device."*).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyGameToPhoneHtml,
  applyWorldToHtml,
} from '../../scripts/world-build.mjs';
import { readWorldGame } from '../../src/world/game';
import { leaveForWorld, worldHref } from '../../src/phone/worldlink';
import { MOTION } from '../../src/taste/tokens';

const ROOT = process.cwd();
const PHONE_HTML = readFileSync(join(ROOT, 'phone.html'), 'utf8');

const KATAMARI = { name: 'valiocon', host: 'valiocon.example', game: 'katamari' };
const PLAIN = { name: 'meridian', host: 'meridian.example', game: 'none' };

describe('the game tag on the companion’s page', () => {
  it('is not in the repo’s phone.html — a build injects it or nothing does', () => {
    expect(PHONE_HTML).not.toContain('refworld:game');
  });

  it('is injected for the world that asked for a game, and read back', () => {
    const out = applyGameToPhoneHtml(PHONE_HTML, KATAMARI);
    expect(out).toContain('<meta name="refworld:game" content="katamari" />');
    // …and the app's own read of it agrees, through the one function both
    // pages use.
    const content = /<meta name="refworld:game" content="([^"]*)"/.exec(out)?.[1] ?? null;
    expect(readWorldGame('', content)).toBe('katamari');
  });

  it('leaves every other deployment’s page byte-identical', () => {
    expect(applyGameToPhoneHtml(PHONE_HTML, PLAIN)).toBe(PHONE_HTML);
    expect(applyGameToPhoneHtml(PHONE_HTML, { name: 'x', host: 'x' })).toBe(PHONE_HTML);
    // The public deployment resolves to no world at all.
    expect(applyGameToPhoneHtml(PHONE_HTML, null)).toBe(PHONE_HTML);
  });

  it('spells the tag exactly as index.html’s, so the two cannot disagree', () => {
    const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const onIndex = /<meta name="refworld:game"[^>]*\/>/.exec(
      applyWorldToHtml(index, { ...KATAMARI, residents: 'shipped', hatch: 'timer', style: 'ink' }),
    )?.[0];
    const onPhone = /<meta name="refworld:game"[^>]*\/>/.exec(
      applyGameToPhoneHtml(PHONE_HTML, KATAMARI),
    )?.[0];
    expect(onPhone).toBe(onIndex);
  });

  it('is the only thing it writes — no card, no world, no title of its own', () => {
    const out = applyGameToPhoneHtml(PHONE_HTML, KATAMARI);
    expect(out).not.toContain('refworld:world');
    expect(out).not.toContain('og:title');
    // The title itself is untouched: the world travels in the url here.
    expect(out).toContain('<title>ref — companion</title>');
    // One tag and one comment: everything else is the page that shipped.
    const added = out.split('\n').length - PHONE_HTML.split('\n').length;
    expect(added).toBe(2);
  });
});

// ── the one exit ─────────────────────────────────────────────────────────────

/** Enough `window` for the two paths, with the timers under the test's hand. */
function stubWindow(options: { framed: boolean }): {
  posted: unknown[];
  restore(): void;
} {
  const globals = globalThis as Record<string, unknown>;
  const before = globals.window;
  const posted: unknown[] = [];
  const self: Record<string, unknown> = {};
  Object.assign(self, {
    parent: options.framed ? { postMessage: (m: unknown) => posted.push(m) } : self,
    postMessage: (m: unknown) => posted.push(m),
    setTimeout: (fn: () => void, ms?: number): unknown => setTimeout(fn, ms),
    location: { origin: 'https://example.test', href: '' },
  });
  globals.window = self;
  return {
    posted,
    restore: (): void => {
      globals.window = before;
    },
  };
}

describe('leaveForWorld — one seam, whoever asked', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('goes to the world view, keeping the room and the world', () => {
    expect(worldHref('xkcd', 'valiocon')).toBe('/?room=xkcd&world=valiocon&view=world');
  });

  it('slides the case out first and navigates on the motion token', () => {
    vi.useFakeTimers();
    const win = stubWindow({ framed: false });
    const classes = new Set<string>();
    const device = { classList: { add: (n: string) => void classes.add(n) } };
    const seen: string[] = [];
    const where = leaveForWorld({
      room: 'xkcd',
      world: 'valiocon',
      device: device as unknown as HTMLElement,
      navigate: (to) => seen.push(to),
    });
    expect(where).toBe('page');
    // The case is already leaving, and nothing has navigated yet: a
    // navigation now would cut the slide (TASTE §2.1).
    expect(classes.has('leaving')).toBe(true);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(MOTION.secondaryMs - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(['/?room=xkcd&world=valiocon&view=world']);
    win.restore();
  });

  it('closes the panel instead, when it IS the panel', () => {
    vi.useFakeTimers();
    const win = stubWindow({ framed: true });
    const seen: string[] = [];
    let restored = 0;
    const where = leaveForWorld({
      room: 'xkcd',
      world: 'valiocon',
      navigate: (to) => seen.push(to),
      restore: () => restored++,
    });
    expect(where).toBe('panel');
    // Nothing navigates: the world behind the frame is still standing.
    expect(seen).toEqual([]);
    expect(win.posted.length).toBe(1);
    // …and the caller's control is put back once the panel has gone.
    expect(restored).toBe(0);
    vi.advanceTimersByTime(MOTION.secondaryMs);
    expect(restored).toBe(1);
    win.restore();
  });
});

// ── the wiring ───────────────────────────────────────────────────────────────

describe('the phone only moves somebody who should be moved', () => {
  const main = readFileSync(join(ROOT, 'src/phone/main.ts'), 'utf8');

  it('reads the game the same way the world page does', () => {
    expect(main).toMatch(/readWorldGame\(\s*location\.search,/);
    expect(main).toMatch(/meta\[name="refworld:game"\]/);
  });

  it('goes on only for the katamari, a public world, and not inside the panel', () => {
    expect(main).toMatch(
      /if \(worldGame !== 'katamari' \|\| publicWorld\.length === 0 \|\| framed\(\)\) return;/,
    );
  });

  it('goes on for a FRESH submission — the handoff and the pad on this page', () => {
    // A reload cannot replay the handoff (the stash is one-shot) and a
    // restore from storage never sets it, so a returning handset keeps the
    // case it asked for.
    expect(main).toMatch(/if \(handedOff\) onToTheWorld\(\);/);
    expect(main).toMatch(/machine\.goTo\('wait'\);[\s\S]{0,300}?onToTheWorld\(\);/);
  });

  it('puts NOTHING between the pad and the world any more', () => {
    // 2026-09-17, second ask: *"For mobile I want the onboarding to be
    // contextual within the device."* The three grey screens are gone from
    // this seam — the teaching happens in the world view, anchored to the
    // stick and the readout (src/ui/hints.ts) — so this is one navigation
    // with nothing to read first.
    expect(main).not.toMatch(/installOnboarding|ui\/onboard/);
    expect(main).toMatch(/const onToTheWorld = \(\): void => \{[\s\S]{0,200}?intoTheWorld\(\);\s*\n\s*\};/);
  });

  it('leaves through the one exit, and only once', () => {
    expect(main).toMatch(/leaveForWorld\(\{ room, world: publicWorld, device: deviceEl \}\)/);
    expect(main).toMatch(/if \(goingToWorld\) return;/);
  });
});
