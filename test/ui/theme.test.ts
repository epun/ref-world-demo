/**
 * The chrome palette (src/ui/theme.ts).
 *
 * > User ask, 2026-09-17: *"can we style the device on mobile in the new
 * > style of the world so it's not just black and white."*
 *
 * Four things are pinned here, in the order they can go wrong:
 *
 * 1. `ink` IS THE SHIPPED CHROME. Every role resolves to the token the
 *    surface used before this module existed — so the public world's phone,
 *    and meridian's, paint what they always painted. This is the assertion
 *    that has to fail if somebody "improves" the default.
 * 2. `ghibli` IS ONLY `GHIBLI`. Every role comes out of that block and
 *    nowhere else: no world token, no character token, and no accent
 *    borrowed from the creature.
 * 3. THE INSTALL, against a recording DOM (this project keeps no jsdom): one
 *    sheet, six declarations, idempotent, and a second call re-points the
 *    same element rather than stacking a second one.
 * 4. THE CALL SITES. Every surface that paints from a role says
 *    `var(--rw-…, <token>)` — the FALLBACK is the shipped token, so a module
 *    is correct with no theme installed at all — and none of them has grown
 *    a fill, a card or a shadow while being recoloured (TASTE §4).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GHIBLI_THEME,
  INK_THEME,
  THEME_VARS,
  type UiTheme,
  installUiTheme,
  themeCss,
  themeFor,
  uiTheme,
} from '../../src/ui/theme';
import { CHARACTER, GHIBLI, SURFACE, WORLD } from '../../src/taste/tokens';
import { stubDom } from './stubdom';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const ROLES: (keyof UiTheme)[] = ['paper', 'ink', 'muted', 'light', 'pad', 'accent'];

/** Rec. 709 luma of a `#rrggbb`, 0..1. */
function luma(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return (0.2126 * ((v >> 16) & 0xff) + 0.7152 * ((v >> 8) & 0xff) + 0.0722 * (v & 0xff)) / 255;
}

describe('themeFor — the shipped look is untouched', () => {
  it('resolves every role to the token the surface already used', () => {
    expect(themeFor('ink')).toBe(INK_THEME);
    expect(INK_THEME).toEqual({
      paper: SURFACE.ground,
      ink: WORLD.ink,
      muted: WORLD.neutral,
      light: WORLD.light,
      pad: SURFACE.canvas,
      accent: WORLD.ink,
    });
  });

  it('gives the shipped chrome NO accent — that one belongs to the character', () => {
    // tokens.ts: at most one CHARACTER.accent element on screen at a time,
    // and it is the hatch flash or your own marker. A progress tick is
    // neither, so on the shipped look the accent is simply ink.
    expect(INK_THEME.accent).toBe(INK_THEME.ink);
    for (const role of ROLES) expect(INK_THEME[role]).not.toBe(CHARACTER.accent);
  });
});

describe('themeFor — the cel world', () => {
  it('resolves every role to a GHIBLI token and nothing else', () => {
    expect(themeFor('ghibli')).toBe(GHIBLI_THEME);
    const allowed = new Set<string>(
      (Object.values(GHIBLI) as unknown[]).filter((v) => typeof v === 'string') as string[],
    );
    for (const role of ROLES) expect(allowed.has(GHIBLI_THEME[role])).toBe(true);
    expect(GHIBLI_THEME).toEqual({
      paper: GHIBLI.paper,
      ink: GHIBLI.ink,
      muted: GHIBLI.rockCool,
      light: GHIBLI.foam,
      pad: GHIBLI.paper,
      accent: GHIBLI.waterTeal,
    });
  });

  it('moves every single role off the shipped value', () => {
    // a role that resolved to the same value on both styles would be a
    // surface that stayed grey on a green world — which is the whole report.
    for (const role of ROLES) expect(GHIBLI_THEME[role]).not.toBe(INK_THEME[role]);
  });

  it('keeps the pad and the page the SAME sheet, unlike the shipped look', () => {
    // the ask: "keep the pad the same paper as the rest of the theme". On
    // `ink` the pad is a step lighter than the page (the figure/ground the
    // draw screen has always had) and that is left alone.
    expect(GHIBLI_THEME.pad).toBe(GHIBLI_THEME.paper);
    expect(INK_THEME.pad).not.toBe(INK_THEME.paper);
  });

  it('leaves the environment floor alone — nothing here is near-black', () => {
    // TASTE §1: the environment never goes below WORLD.ink, and near-black is
    // the character's. A chrome value is environment.
    for (const role of ROLES) {
      expect(luma(GHIBLI_THEME[role])).toBeGreaterThan(luma(CHARACTER.body));
    }
    // and the paper is a paper: lighter than the meadow it lies on.
    expect(luma(GHIBLI_THEME.paper)).toBeGreaterThan(luma(GHIBLI.meadow));
    // …while the ink on it is darker than the ink the shipped look uses, so
    // type has at least the range it always had.
    expect(luma(GHIBLI_THEME.ink)).toBeLessThan(luma(INK_THEME.ink));
  });
});

describe('themeCss', () => {
  it('declares all six roles on :root, under the --rw- names', () => {
    const css = themeCss(GHIBLI_THEME);
    expect(css.startsWith(':root {')).toBe(true);
    for (const role of ROLES) {
      expect(THEME_VARS[role]).toBe(`--rw-${role}`);
      expect(css).toContain(`${THEME_VARS[role]}: ${GHIBLI_THEME[role]};`);
    }
    expect(Object.keys(THEME_VARS)).toHaveLength(ROLES.length);
  });

  it('writes no uppercase (TASTE §5) and no mark beyond a value', () => {
    const css = themeCss(GHIBLI_THEME);
    expect(css).not.toMatch(/[A-Z]/);
    expect(css).not.toContain('shadow');
    expect(css).not.toContain('radius');
  });
});

describe('installUiTheme', () => {
  it('publishes the ghibli values, and only on that style', () => {
    const dom = stubDom();
    try {
      installUiTheme('ghibli');
      const sheet = document.getElementById('rw-theme') as unknown as { textContent: string };
      expect(sheet.textContent).toContain(`--rw-paper: ${GHIBLI.paper};`);
      expect(sheet.textContent).toContain(`--rw-ink: ${GHIBLI.ink};`);
      expect(sheet.textContent).toContain(`--rw-accent: ${GHIBLI.waterTeal};`);
      expect(sheet.textContent).not.toContain(SURFACE.ground);
      expect(sheet.textContent).not.toContain(WORLD.ink);
      expect(uiTheme()).toBe(GHIBLI_THEME);

      // the same page, told it is on the shipped look: the SAME element is
      // re-pointed (one sheet, never two) and every ghibli value is gone.
      installUiTheme('ink');
      expect(dom.head.children.filter((el) => el.tag === 'style')).toHaveLength(1);
      expect(sheet.textContent).toContain(`--rw-paper: ${SURFACE.ground};`);
      expect(sheet.textContent).not.toContain(GHIBLI.paper);
      expect(sheet.textContent).not.toContain(GHIBLI.ink);
      expect(uiTheme()).toBe(INK_THEME);
    } finally {
      dom.restore();
    }
  });
});

describe('the call sites', () => {
  /** every surface that paints a role, and the roles it names. */
  const SURFACES: Record<string, string[]> = {
    'src/phone/main.ts': ['--rw-ink', '--rw-muted'],
    'src/phone/device.ts': ['--rw-paper', '--rw-ink'],
    'src/phone/keepui.ts': ['--rw-paper', '--rw-ink', '--rw-muted', '--rw-light'],
    'src/draw/ui.ts': ['--rw-pad', '--rw-ink'],
    'src/world/tray.ts': ['--rw-paper', '--rw-ink'],
    'src/world/joystick.ts': ['--rw-ink', '--rw-light'],
    'src/world/companionpanel.ts': ['--rw-paper'],
    'src/ui/size.ts': ['--rw-ink'],
    'src/ui/loading.ts': ['--rw-ink', '--rw-muted', '--rw-accent'],
    // The hints' label stands on the same paper as the leaderboard's board
    // (docs/TASTE.md §9a): `light` is the fill, `ink` the hairline and the
    // type — and the muted skip went with the slideshow it belonged to.
    'src/ui/hints.ts': ['--rw-ink', '--rw-light'],
    'src/ui/empty.ts': ['--rw-ink'],
    'src/ui/leaderboard.ts': ['--rw-ink', '--rw-light'],
  };

  it('names the role it means, on every surface', () => {
    for (const [file, roles] of Object.entries(SURFACES)) {
      const source = read(file);
      for (const role of roles) expect(source).toContain(`var(${role},`);
    }
  });

  it('always carries the shipped token as the FALLBACK', () => {
    // a `var(--rw-x)` with no fallback would paint nothing in a unit test, in
    // public/draw/ (plain html, which cannot import from src/), or on any page
    // that has not installed a theme. Every one of them must name a token.
    let checked = 0;
    for (const file of Object.keys(SURFACES)) {
      for (const line of read(file).split('\n')) {
        // declarations only — a doc comment may name a role in prose.
        const body = line.trimStart();
        if (body.startsWith('*') || body.startsWith('//') || body.startsWith('/*')) continue;
        for (const use of line.matchAll(/var\(--rw-[a-z]+([^)]*)\)/g)) {
          expect(use[1]).toMatch(/^, \$\{(SURFACE|WORLD|CHARACTER)\.[a-zA-Z]+\}$/);
          checked++;
        }
      }
    }
    // and the scan actually found them, rather than passing on an empty set.
    expect(checked).toBeGreaterThan(40);
    // …and the surfaces INSIDE the device's bezel are deliberately not among
    // them: the well is the shell artwork's own value on every style, so a
    // key face and the stage paper name the token directly (src/draw/ui.ts
    // and src/phone/device.ts carry the reason).
    expect(read('src/phone/states.ts')).toContain('--stage-paper: ${SURFACE.ground};');
    expect(read('src/draw/ui.ts')).toContain(
      'hosts ? SURFACE.ground : uiTheme().pad',
    );
  });

  it('recoloured the marks without adding one (TASTE §4)', () => {
    // the mark set is icon + ruleLine + border. A role is a value, so a
    // surface may not have picked up a card or a shadow on the way through.
    for (const file of Object.keys(SURFACES)) {
      const source = read(file);
      expect(source).not.toContain('box-shadow');
      expect(source).not.toContain('drop-shadow');
    }
  });

  it('never tints the drawing itself', () => {
    // the pad's SURROUND is themed; the stroke is not. The mark stays
    // CHARACTER.body in the one renderer that draws it, and the creature's
    // colourway is read off the drawing's motifs rather than its pixels.
    const render = read('src/draw/render.ts');
    expect(render).toContain('ctx.strokeStyle = CHARACTER.body;');
    expect(render).toContain('ctx.fillStyle = CHARACTER.body;');
    expect(render).not.toContain('uiTheme');
    expect(read('src/character/palette.ts')).not.toContain('uiTheme');
    // and the egg's paint-on stamp still lays the token ground it always did.
    expect(read('src/egg/egg.ts')).toContain(
      'renderStrokesPartial(stampCtx, strokes, STAMP_SIZE, t)',
    );
  });
});
