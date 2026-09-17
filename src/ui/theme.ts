/**
 * The FLAT-SURFACE palette of a page's chrome, per world style.
 *
 * > User ask (2026-09-17): *"can we style the device on mobile in the new
 * > style of the world so it's not just black and white."*
 *
 * Everything the handset shows outside the 3D viewport — the draw pad and its
 * surround, the device case's keys, the creature panel, the keepsake popover,
 * and on the world view the stick, the tray, the readouts, the loading and
 * onboarding screens — was painted straight from `SURFACE.ground` and
 * `WORLD.ink`. That is the taste (TASTE §1, §4) and it stays the taste on
 * every world but one: on `valiocon` the world behind that chrome renders in
 * the ghibli cel look (TASTE §9), and grey paper with grey ink in front of a
 * green meadow read as a different application sitting on top of the world.
 *
 * So the six values those surfaces use are named here once and resolved from
 * the style, exactly as `mapPalette` (src/ui/minimap.ts) already resolves the
 * map's two. `ink` returns the shipped values, so every other deployment — the
 * public one first — paints byte-identical chrome. `ghibli` returns `GHIBLI`
 * tokens and nothing else: the style's own violet-blue contour, a derived
 * paper in the meadow's hue (`GHIBLI.paper`), foam for a knockout, the sea's
 * teal for the one accent, and the built props' cool grey for secondary type.
 *
 * ── WHY CSS CUSTOM PROPERTIES
 *
 * These surfaces are ~15 modules, each of which interpolates tokens into its
 * own `<style>` element ONCE, on first mount, and several of them mount before
 * a style is known (the device case is in phone.html's markup so the first
 * frame is never bare — docs/PHONE-STAGE §4.1). Threading a style argument
 * through all of them would put the same branch in fifteen places and still
 * leave the ones that mount early painting the wrong paper.
 *
 * A custom property inverts that: each module writes `var(--rw-ink, <token>)`
 * — the FALLBACK is the shipped token, so a module is correct with no theme
 * installed at all (a unit test, or /draw/, which is plain html in public/ and
 * cannot import from src/) — and one call at boot re-points the six variables
 * on `:root`. The mark set does not change; only the values do (TASTE §4).
 *
 * THE MARK SET IS NOT NEGOTIATED HERE. There is no fill token for a panel, no
 * shadow token and no radius. A framed box that carries a paper fill — the
 * keepsake popover, the join code, the minimap, the leaderboard — is under the
 * override docs/TASTE.md §9a ALREADY records (one generator, one inset, one
 * 1.25 hairline); this recolours those fills and adds nothing to them.
 *
 * Pure but for `install`: `themeFor` and `themeCss` take no DOM.
 */

import { GHIBLI, SURFACE, WORLD } from '../taste/tokens';
import type { WorldStyle } from '../world/style';

export interface UiTheme {
  /** The sheet every flat surface is: page grounds, key faces, panel fills. */
  paper: string;
  /** Linework and type — every hairline, border, rule and glyph. */
  ink: string;
  /** Secondary type only. Never a mark. */
  muted: string;
  /** A knockout inside a mark — the stick's knob, the keepsake's paper cut. */
  light: string;
  /**
   * THE DRAWING SURFACE, and nothing else.
   *
   * Its own role because on `ink` it is not the page's paper: the pad's
   * interior is `SURFACE.canvas`, one step LIGHTER than the page behind it,
   * which is the figure/ground separation the draw screen is built on
   * (src/draw/ui.ts, src/phone/screens/draw.ts). On `ghibli` it is the
   * theme's own paper — the pad reads as the same sheet as the surround
   * rather than a white window cut in a green one — and the stroke is
   * untouched: the mark stays `CHARACTER.body`, and the creature's colourway
   * is read from the drawing's MOTIFS and not its pixels
   * (src/character/palette.ts), so nothing here can move a hue.
   */
  pad: string;
  /**
   * The one value that is not ink: progress ticks, the loading rule's fill,
   * the onboarding icons. On `ink` it IS ink — the shipped chrome has no
   * accent, because `CHARACTER.accent` is the character's and appears at most
   * once on screen (tokens.ts). On `ghibli` it is the sea.
   */
  accent: string;
}

/** The shipped chrome, value for value. */
export const INK_THEME: UiTheme = {
  paper: SURFACE.ground,
  ink: WORLD.ink,
  muted: WORLD.neutral,
  light: WORLD.light,
  pad: SURFACE.canvas,
  accent: WORLD.ink,
};

/**
 * The cel world's chrome. Every value is a `GHIBLI` token.
 *
 * Measured against `GHIBLI.paper`: ink 11.6:1, muted 4.3:1, accent 5.9:1 —
 * so secondary type and the accent both stay legible type rather than
 * becoming decoration, and the ink is the same range on paper it always had.
 */
export const GHIBLI_THEME: UiTheme = {
  paper: GHIBLI.paper,
  ink: GHIBLI.ink,
  muted: GHIBLI.rockCool,
  light: GHIBLI.foam,
  pad: GHIBLI.paper,
  accent: GHIBLI.waterTeal,
};

export function themeFor(style: WorldStyle): UiTheme {
  return style === 'ghibli' ? GHIBLI_THEME : INK_THEME;
}

/**
 * The variable name each role is published under. `rw` for this repo, so a
 * vendored stylesheet cannot collide with one of them.
 */
export const THEME_VARS: Readonly<Record<keyof UiTheme, string>> = {
  paper: '--rw-paper',
  ink: '--rw-ink',
  muted: '--rw-muted',
  light: '--rw-light',
  pad: '--rw-pad',
  accent: '--rw-accent',
};

/** The six declarations, in a fixed order so a test can compare text. */
export function themeCss(theme: UiTheme): string {
  const keys = Object.keys(THEME_VARS) as (keyof UiTheme)[];
  return `:root {\n${keys.map((k) => `  ${THEME_VARS[k]}: ${theme[k]};`).join('\n')}\n}\n`;
}

const STYLE_ID = 'rw-theme';

/** The style this page installed, for the canvas and three.js surfaces that
 * cannot read a custom property (the join code's raster, the creature
 * panel's clear colour). Set by `installUiTheme`, `ink` until it runs. */
let current: UiTheme = INK_THEME;

/** The installed theme. Canvas and WebGL callers only — anything drawing in
 * CSS should say `var(--rw-…, <token>)` and stay declarative. */
export function uiTheme(): UiTheme {
  return current;
}

/**
 * Publish this page's chrome palette. Idempotent, and safe to call before
 * anything has mounted — which is where it belongs: the sooner the variables
 * exist, the less of the first frame is painted in the other style's paper.
 */
export function installUiTheme(style: WorldStyle, doc: Document = document): UiTheme {
  const theme = themeFor(style);
  current = theme;
  let el = doc.getElementById(STYLE_ID);
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ID;
    // Order in the head does not matter: these are six custom properties on
    // `:root` and nothing else declares them, so they cannot be overridden by
    // — or override — a rule in any module's own sheet. What matters is WHEN
    // this runs, which is the caller's job: before the first mount.
    doc.head.appendChild(el);
  }
  el.textContent = themeCss(theme);
  return theme;
}
