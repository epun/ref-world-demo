/**
 * The three ways to take your creature home, on the companion.
 *
 * A FLOPPY DISK in the top-right corner of the screen, outside the device
 * (user ask, 2026-09-09: *"we should also move the download button on
 * mobile view when the device is shown to the top right corner outside of
 * the device. It should look like a floppy disk icon and it should show a
 * popover menu. The title should say 'save as' and then the menu items
 * should be 'photo, 3d model, or link'."*).
 *
 * Outside the device is the whole point of the move. The corner slot it
 * used to live in is INSIDE the screen well, over the one object the
 * screen is for — a save control standing on the creature. On the paper
 * beside the case it is what it actually is: something the person does
 * with the device, not something the device is showing them. So it is
 * fixed to the SCREEN (top 3vw + the notch, right 4vw — the tray's own
 * gutters, src/world/tray.ts), and it is mounted on the page rather than
 * in the stage, because the stage carries the ambient drift transform and
 * a `position: fixed` child of a transformed box is not fixed to the
 * viewport at all.
 *
 * Marks: a wavered diskette — cut-cornered body, shutter and its window,
 * label strip — and a wavered hairline border round the popover with a
 * rule under the title and between the rows. Icon, ruleLine, border, and
 * nothing else (TASTE §4). The popover's ground is `SURFACE.ground`, which
 * is the paper the whole flow is painted on and not a fill, and it is the
 * BORDER PATH'S OWN FILL so that it cannot reach past the line that bounds
 * it: no shadow, no tint, no card, and no straight edge outside the wobble.
 * Same hand as the minimap's border, the world link's button and the
 * stick's rings, so this reads as part of the same object.
 *
 * ── the tap has to reach the phone ──────────────────────────────────────
 *
 * User report, 2026-09-09: *"currently if I press those buttons on mobile
 * they don't do anything for saving."* Measured cause: every action did
 * its async work FIRST — build the character, render 1024², `toBlob`,
 * export a glb — and only then called `navigator.share`, the download
 * anchor, or the clipboard. All three are gated on the tap's TRANSIENT
 * USER ACTIVATION, which is spent by the first await that takes real time.
 * So the share threw `NotAllowedError`, the fallback download was refused
 * for the same reason, and nothing at all happened on screen.
 *
 * The fix is that the files are BUILT BEFORE THE TAP. The popover starts
 * both renders when it opens (and once at mount, on an idle callback), and
 * the row handler hands the finished blob to the browser with no await in
 * front of it. A tap that arrives before a render has finished says
 * `preparing` and delivers on the NEXT tap — late is not a thing this can
 * be, because a delivery that arrives after the activation expires is a
 * delivery that does not happen.
 */

import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import { BORDER_WAVER, wavyBorderPath, wavyBorderPoints, type BorderPoint } from './minimap';
import { hash01 } from './seed';
import { keepUrl, keepsakeFilename } from './keeplink';
import { deliver, exportGlb, renderKeepsake } from './keepsake';
import type { StrokeList } from '../shape/types';

/** What each choice says before it is pressed. */
export const KEEP_LABELS = {
  // The action key stays `picture` — it is what the code, the filename
  // helper and every caller already call it. Only the word on screen
  // changed (user ask: the items are "photo, 3d model, or link").
  picture: 'photo',
  model: '3d model',
  link: 'link',
} as const;

export type KeepAction = keyof typeof KEEP_LABELS;

/** The two that produce a file. The link produces a url. */
export type KeepFileAction = 'picture' | 'model';

/** The popover's title. Lowercase, like everything else here. */
export const KEEP_TITLE = 'save as';

/** What it says after, while the word is still worth reading. */
export const KEEP_DONE: Record<KeepAction, string> = {
  picture: 'saved',
  model: 'saved',
  link: 'copied',
};

export const KEEP_FAILED = 'try again';

/**
 * What a row says when it is tapped before its file exists.
 *
 * It is NOT a promise to deliver when the render lands: by then the tap's
 * user activation is gone and the share sheet would be refused. It is the
 * row saying "ask me again in a moment", and the render it kicks off means
 * the second ask works.
 */
export const KEEP_PREPARING = 'preparing';

/**
 * How long a result stays on the row before the popover closes.
 *
 * Long enough to be read on a phone held at arm's length, short enough
 * that the menu is not still congratulating itself when somebody comes
 * back to press another one.
 */
export const KEEP_FEEDBACK_MS = MOTION.primaryMs;

export interface KeepUiOptions {
  /** The drawing, for the exports that rebuild it. */
  strokes: StrokeList;
  /** The id the world spawned it under — also the id the link carries. */
  identity: string;
  /** The creature's name, for the filename. */
  name(): string | null;
  /** The world this creature lives in, or null when there is no shared one. */
  world: string | null;
  /**
   * Where the mark and its popover are appended.
   *
   * The PAGE, not the stage (see the header): both are fixed to the screen
   * and the stage is a transformed box. Defaults to `document.body`.
   */
  mount?: HTMLElement;
  /**
   * How a file gets built ahead of the tap. Defaults to the real
   * renderers; the tests hand in their own, because the renders need a gpu
   * and the part worth pinning is what the TAP does with the result.
   */
  build?(action: KeepFileAction): Promise<Blob | null>;
  /** Told what happened, so the caller can put a line somewhere if it wants. */
  onResult?(action: KeepAction, ok: boolean): void;
}

export interface KeepUiHandle {
  /** The floppy mark — top-right of the screen, outside the device. */
  mark: HTMLElement;
  /** The popover it opens, anchored under it and right-aligned to it. */
  menu: HTMLElement;
  open(): boolean;
  setOpen(on: boolean): void;
  destroy(): void;
}

const STYLE_ID = 'phone-keep-style';

/**
 * The mark's size and its gutters.
 *
 * Thumb-sized and clamped, so it is reachable on the smallest handset and
 * does not become a poster on the largest. The gutters mirror the world
 * tray's (`TRAY_PAD_VW` 4 / `TRAY_GAP_VW` 3) — the same handset, the same
 * margins, whichever view it is looking at.
 */
const MARK_SIZE = 'clamp(40px, 11vw, 56px)';
const GUTTER_TOP = 'calc(env(safe-area-inset-top, 0px) + 3vw)';
const GUTTER_RIGHT = '4vw';
/** How far under the mark the popover hangs. */
const MENU_TOP = `calc(${GUTTER_TOP} + ${MARK_SIZE} + 2vw)`;

/** How far the popover travels on the way in. Entrances SLIDE. */
const MENU_TRAVEL_PX = 8;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/*
 * The mark: fixed to the SCREEN's top-right corner, on the paper beside
 * the case rather than on the screen inside it.
 */
.keep-mark {
  position: fixed;
  top: ${GUTTER_TOP};
  right: ${GUTTER_RIGHT};
  z-index: 40;
  width: ${MARK_SIZE};
  height: ${MARK_SIZE};
  display: block;
  border: 0;
  padding: 0;
  background: none;
  color: ${WORLD.ink};
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  /* It arrives with the rest of the screen: slides down into the corner,
     never appears. The satellites' own travel and duration. */
  opacity: 0;
  transform: translateY(-${MENU_TRAVEL_PX}px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.keep-mark[data-in='true'] { opacity: 0.85; transform: translateY(0); }
.keep-mark[data-open='true'] { opacity: 1; }
.keep-mark svg { display: block; width: 100%; height: 100%; overflow: visible; }
.keep-mark path {
  fill: none;
  stroke: ${WORLD.ink};
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
/* The label window, the one paper-light shape on the icon — the same
   value the device shell's own body is filled with. */
.keep-mark path[data-fill='paper'] { fill: ${WORLD.light}; }

/*
 * The popover. Paper inside a wavering hairline, right-aligned under the
 * mark. NOT a panel: the ground is the paper this whole flow is painted on,
 * and there is no shadow and no tint anywhere in it (TASTE §4).
 *
 * THE ELEMENT PAINTS NO BACKGROUND. The paper is the wavered path's own
 * fill — one shape, filled and stroked in the same pass — because a
 * rectangular element background behind a wobbly outline shows its four
 * straight edges outside the wobble, which is exactly what it looked like
 * on a handset (user report, 2026-09-09: *"the fill … should not have any
 * parts that extend beyond the border … so that we just have fill within
 * the border"*). Matte, one flat value, nothing outside the outline.
 */
.keep-menu {
  position: fixed;
  top: ${MENU_TOP};
  right: ${GUTTER_RIGHT};
  z-index: 40;
  width: min(52vw, 216px);
  box-sizing: border-box;
  padding: 3vw 4vw;
  /* No background here — see the note above. The paper is the path's fill. */
  background: transparent;
  color: ${WORLD.ink};
  font-family: "helvetica neue", helvetica, arial, sans-serif;
  font-weight: 400;
  opacity: 0;
  pointer-events: none;
  /* Slides down out of the mark — the transform is what carries it; the
     opacity only keeps it from being visible before it has somewhere to
     be (the same entrance the stage's satellites run). */
  transform: translateY(-${MENU_TRAVEL_PX}px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.keep-menu[data-open='true'] {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.keep-menu-border {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.keep-menu-border path {
  /* Fill AND stroke, on one path: the paper can then not reach past the
     line that bounds it, at any size, on any handset. */
  fill: ${SURFACE.ground};
  stroke: ${WORLD.ink};
  stroke-width: 1.25;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.keep-title {
  position: relative;
  padding-bottom: 2vw;
  border-bottom: 1px solid ${WORLD.ink};
  color: ${WORLD.neutral};
  font-size: clamp(10px, 3.1vw, 13px);
  letter-spacing: 0.02em;
}
.keep-row {
  position: relative;
  display: block;
  width: 100%;
  border: 0;
  border-top: 1px solid ${WORLD.ink};
  padding: 3vw 0;
  background: none;
  color: ${WORLD.ink};
  font: inherit;
  font-size: clamp(12px, 3.8vw, 15px);
  letter-spacing: 0.01em;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
/* The first row hangs off the title's rule, so no doubled hairline. */
.keep-row:first-of-type { border-top: 0; }
.keep-row[disabled] { opacity: 0.45; cursor: default; }
/* The url, when neither the clipboard nor the share sheet will take it:
   it is revealed here so it can be copied by hand rather than lost. */
.keep-row span {
  display: block;
  overflow-wrap: anywhere;
  -webkit-user-select: text;
  user-select: text;
}
`;
  document.head.appendChild(style);
}

/** Seeds, so the same mark wavers the same way on every render. */
const BODY_SEED = 12;
const LABEL_SEED = 63;
const SHUTTER_SEED = 27;
const SLOT_SEED = 45;
const MENU_SEED = 84;

/** The shutter's window is ten units wide; the full waver would close it. */
const SLOT_WAVER = 0.5;

function svg(width: number, height: number, stretch: boolean): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (stretch) el.setAttribute('preserveAspectRatio', 'none');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function path(d: string): SVGPathElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', d);
  return el;
}

/**
 * A wavering closed loop through any corners at all.
 *
 * `wavyBorderPoints` only ever draws its rectangle at the origin, and a
 * diskette is a rectangle with a corner cut off plus three smaller ones
 * inside it. Same generator, same seeded hash, same midpoint smoothing on
 * the way out — sampled along an arbitrary polygon instead of four fixed
 * edges, so the cut corner is part of the loop rather than a second path
 * laid over it.
 *
 * The corners are skipped by `CORNER_MARGIN` exactly as the rectangle's
 * are: the gap is what rounds them off when the loop is smoothed, which is
 * where the drawn-by-hand corner comes from.
 */
function wavyLoop(
  corners: readonly (readonly [number, number])[],
  seed: number,
  perEdge: number,
  waver: number = BORDER_WAVER,
): BorderPoint[] {
  const points: BorderPoint[] = [];
  let k = 0;
  for (let i = 0; i < corners.length; i++) {
    const [x0, y0] = corners[i]!;
    const [x1, y1] = corners[(i + 1) % corners.length]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    // The edge normal, so the waver is a wobble of the LINE rather than a
    // wander of its endpoints — the same offset direction the rectangle
    // generator uses on each of its four sides.
    const nx = -dy / len;
    const ny = dx / len;
    for (let j = 0; j < perEdge; j++) {
      const t = CORNER_MARGIN + (j / Math.max(1, perEdge - 1)) * (1 - 2 * CORNER_MARGIN);
      const off = (hash01(k * 12.9898 + seed * 78.233) - 0.5) * 2 * waver;
      points.push({ x: x0 + dx * t + nx * off, y: y0 + dy * t + ny * off });
      k++;
    }
  }
  return points;
}

/** Fraction of each edge left clear at the corners — mirrors the rectangle
 * generator's own, so the two hands match. */
const CORNER_MARGIN = 0.07;

/** The four corners of a box, for `wavyLoop`. */
function boxCorners(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): readonly (readonly [number, number])[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * The floppy, as strokes.
 *
 * Everybody's save glyph, drawn by this project's hand instead of taken
 * from an icon set. Four marks, and each one is a thing a diskette
 * actually has (user ask, 2026-09-09: *"the icon for the floppy save
 * should look more like a floppy disk"* — the first pass was a square with
 * two rectangles in it, which is a diskette only if you already know):
 *
 *   body      square with the TOP-RIGHT CORNER CUT OFF. The one asymmetry
 *             on the object, and the whole reason you can tell at a glance
 *             which way up it goes — it is what a person recognises before
 *             they have read any of the rest;
 *   shutter   the metal slide across the top…
 *   slot      …with its window in it, offset to one side as the real one is;
 *   label     the paper strip on the lower half — the one paper-light
 *             shape on the mark, in the same value the device shell's own
 *             body is filled with.
 *
 * Nothing rectilinear survives the waver and the smoothing (TASTE §2.5);
 * it is a drawn diskette, not an engineered one. The slot wavers less than
 * everything else for the plain reason that it is ten units wide and a
 * full-amplitude wobble would close it.
 */
function floppy(): SVGSVGElement {
  const el = svg(100, 100, false);
  const body = path(
    wavyBorderPath(
      wavyLoop(
        [
          [12, 14],
          [70, 14],
          [88, 32],
          [88, 86],
          [12, 86],
        ],
        BODY_SEED,
        5,
      ),
    ),
  );
  const shutter = path(wavyBorderPath(wavyLoop(boxCorners(30, 20, 68, 43), SHUTTER_SEED, 4)));
  const slot = path(wavyBorderPath(wavyLoop(boxCorners(55, 25, 64, 38), SLOT_SEED, 3, SLOT_WAVER)));
  const label = path(wavyBorderPath(wavyLoop(boxCorners(24, 54, 76, 80), LABEL_SEED, 5)));
  label.setAttribute('data-fill', 'paper');
  el.append(body, shutter, slot, label);
  return el;
}

/** The file each action delivers. */
const KEEP_EXT: Record<KeepFileAction, string> = { picture: 'png', model: 'glb' };

/**
 * Mount the mark and the popover it opens.
 *
 * Both go on the page (see `KeepUiOptions.mount`) — this module knows
 * where the corner of the screen is, which it can, because the corner of
 * the screen is not the stage's business and the stage is not this
 * control's.
 */
export function mountKeepUi(options: KeepUiOptions): KeepUiHandle {
  ensureStyle();
  const host = options.mount ?? document.body;

  // ── the mark ─────────────────────────────────────────────────────────────
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'keep-mark';
  mark.dataset['open'] = 'false';
  mark.dataset['in'] = 'false';
  mark.setAttribute('aria-label', 'save');
  mark.setAttribute('aria-haspopup', 'menu');
  mark.setAttribute('aria-expanded', 'false');
  mark.appendChild(floppy());

  // ── the popover ──────────────────────────────────────────────────────────
  const menu = document.createElement('div');
  menu.className = 'keep-menu';
  menu.dataset['open'] = 'false';
  menu.setAttribute('role', 'menu');
  // Hidden from the reading order until it is open, so a screen reader is
  // not offered three items that are not on screen.
  menu.setAttribute('aria-hidden', 'true');
  const border = svg(100, 100, true);
  border.setAttribute('class', 'keep-menu-border');
  border.appendChild(path(wavyBorderPath(wavyBorderPoints(100, 100, 2, MENU_SEED, 10))));
  const title = document.createElement('div');
  title.className = 'keep-title';
  title.textContent = KEEP_TITLE;
  menu.append(border, title);

  let open = false;
  const timers = new Map<KeepAction, number>();
  /** Actions with a delivery already in flight, so two taps are one save. */
  const busy = new Set<KeepAction>();
  const rows = new Map<KeepAction, { el: HTMLButtonElement; label: HTMLElement }>();
  /** Set when the url has been put on screen to be copied by hand: the
   * label must not be restored out from under somebody reading it. */
  let revealed = false;

  const restoreLabels = (): void => {
    revealed = false;
    for (const [action, row] of rows) {
      window.clearTimeout(timers.get(action));
      timers.delete(action);
      row.label.textContent = KEEP_LABELS[action];
    }
  };

  // ── the files, built BEFORE the tap ──────────────────────────────────────
  /**
   * The renderers, or whatever the caller handed in. Nothing here is on the
   * render path: each export builds its own renderer, takes one frame and
   * disposes it (keepsake.ts), so preparing can never disturb the portrait.
   */
  const build = (action: KeepFileAction): Promise<Blob | null> =>
    options.build
      ? options.build(action)
      : action === 'picture'
        ? renderKeepsake(options.strokes, options.identity)
        : exportGlb(options.strokes, options.identity);

  const ready = new Map<KeepFileAction, Blob>();
  const building = new Set<KeepFileAction>();
  /**
   * Start whatever is not built yet. Idempotent, and never re-run for a
   * file it already holds: the strokes and the identity are fixed for this
   * handle's whole life, so a blob built once is correct forever.
   */
  const prepare = (): void => {
    for (const action of ['picture', 'model'] as KeepFileAction[]) {
      if (!rows.has(action) || ready.has(action) || building.has(action)) continue;
      building.add(action);
      void build(action)
        .then((blob) => {
          if (blob) ready.set(action, blob);
        })
        .catch(() => undefined)
        .finally(() => building.delete(action));
    }
  };

  const setOpen = (on: boolean): void => {
    if (on === open) return;
    open = on;
    menu.dataset['open'] = on ? 'true' : 'false';
    menu.setAttribute('aria-hidden', on ? 'false' : 'true');
    mark.dataset['open'] = on ? 'true' : 'false';
    mark.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) prepare();
    else restoreLabels();
  };

  /**
   * Say something in the row, then hand it back.
   *
   * `close` is what a finished action does: the result is read where the
   * finger already is, and then the popover leaves rather than sitting
   * open over the creature.
   */
  const say = (action: KeepAction, text: string, close: boolean): void => {
    const row = rows.get(action);
    if (!row) return;
    row.label.textContent = text;
    window.clearTimeout(timers.get(action));
    timers.set(
      action,
      window.setTimeout(() => {
        timers.delete(action);
        if (revealed) return;
        row.label.textContent = KEEP_LABELS[action];
        if (close) setOpen(false);
      }, KEEP_FEEDBACK_MS),
    );
  };

  const settle = (action: KeepAction, ok: boolean): void => {
    busy.delete(action);
    say(action, ok ? KEEP_DONE[action] : KEEP_FAILED, true);
    options.onResult?.(action, ok);
  };

  /**
   * A file row.
   *
   * SYNCHRONOUS to the browser call, and that is the whole design of it:
   * `deliver` runs its share/download decision in this same task, on a
   * blob that already exists, so the tap's user activation is still alive
   * when the share sheet is asked for. Anything awaited here — including
   * awaiting the render — spends it, and the save silently does nothing.
   */
  const tapFile = (action: KeepFileAction, event: Event): void => {
    event.stopPropagation();
    if (busy.has(action)) return;
    const blob = ready.get(action);
    if (!blob) {
      prepare();
      say(action, KEEP_PREPARING, false);
      return;
    }
    busy.add(action);
    const filename = keepsakeFilename(options.name(), options.identity, KEEP_EXT[action]);
    void deliver(blob, filename).then(
      (result) => settle(action, result !== 'failed'),
      () => settle(action, false),
    );
  };

  /**
   * The link row.
   *
   * The clipboard first, and IN THE TAP. It used to try the share sheet
   * first — right on a handset, where the sheet is how a link reaches the
   * place somebody keeps things — but both of them are activation-gated
   * and only one of them can be first. The clipboard is the one that works
   * everywhere and needs no sheet, and the share sheet is still reached if
   * it refuses.
   *
   * A world is required: a link into a world that does not persist would
   * be a promise this cannot keep, so that row is not built at all.
   */
  const tapLink = (event: Event): void => {
    event.stopPropagation();
    if (busy.has('link') || !options.world) return;
    busy.add('link');
    const url = keepUrl(location.origin, { world: options.world, id: options.identity });
    const nav = navigator as Navigator & {
      share?: (data: { url?: string; title?: string }) => Promise<void>;
    };

    /** The sheet, then — if there is no sheet either — the url itself. */
    const shareOrReveal = (): void => {
      if (typeof nav.share === 'function') {
        nav.share({ url, title: options.name() ?? 'my creature' }).then(
          () => settle('link', true),
          (err: unknown) => {
            // Cancelled is not failed: the person pressed cancel and knows
            // what happened (keepsake.ts deliver()).
            if (err instanceof Error && err.name === 'AbortError') settle('link', true);
            else reveal();
          },
        );
        return;
      }
      reveal();
    };

    /** Neither route is available. Put the url on screen rather than
     * report a failure the person can do nothing about. */
    const reveal = (): void => {
      busy.delete('link');
      const row = rows.get('link');
      if (!row) return;
      window.clearTimeout(timers.get('link'));
      timers.delete('link');
      revealed = true;
      row.label.textContent = url;
      options.onResult?.('link', false);
    };

    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard && typeof clipboard.writeText === 'function') {
      let written: Promise<void> | null = null;
      try {
        written = clipboard.writeText(url);
      } catch {
        written = null;
      }
      if (written) {
        written.then(() => settle('link', true), shareOrReveal);
        return;
      }
    }
    shareOrReveal();
  };

  // ── the rows ─────────────────────────────────────────────────────────────
  const actions: KeepAction[] = options.world
    ? ['picture', 'model', 'link']
    : // No shared world, so no link that would still resolve tomorrow. The
      // file exports need none and stay.
      ['picture', 'model'];

  for (const action of actions) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'keep-row';
    el.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.textContent = KEEP_LABELS[action];
    el.appendChild(label);
    el.addEventListener('click', (event: Event) => {
      if (action === 'link') tapLink(event);
      else tapFile(action, event);
    });
    menu.appendChild(el);
    rows.set(action, { el, label });
  }

  // ── opening, and everything that closes it ───────────────────────────────
  const toggle = (event: Event): void => {
    event.stopPropagation();
    setOpen(!open);
  };
  mark.addEventListener('click', toggle);
  // The tap that opens it must not also reach the world underneath — on
  // this screen that is the drag that turns the creature.
  const swallow = (event: Event): void => event.stopPropagation();
  mark.addEventListener('pointerdown', swallow);
  menu.addEventListener('pointerdown', swallow);

  /**
   * A tap anywhere else closes it, and is spent doing so.
   *
   * Captured, so it is heard before the well's own drag handler claims the
   * pointer — and stopped there, because the tap that dismisses a popover
   * should not also turn the creature behind it.
   */
  const dismiss = (event: Event): void => {
    if (!open) return;
    if (event.target instanceof Node && (menu.contains(event.target) || mark.contains(event.target)))
      return;
    setOpen(false);
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener('pointerdown', dismiss, true);

  const onKey = (event: KeyboardEvent): void => {
    if (!open || event.key !== 'Escape') return;
    setOpen(false);
  };
  window.addEventListener('keydown', onKey);

  host.append(mark, menu);

  /*
   * The entrance. Two frames, not one: an element appended this frame has
   * no rendered state to transition FROM, so a flag set immediately is
   * simply its initial style and nothing animates — it would appear, which
   * is the cut this taste forbids outright.
   */
  let enterRaf = 0;
  if (typeof requestAnimationFrame === 'function') {
    enterRaf = requestAnimationFrame(() => {
      enterRaf = requestAnimationFrame(() => {
        enterRaf = 0;
        mark.dataset['in'] = 'true';
      });
    });
  } else {
    mark.dataset['in'] = 'true';
  }

  /*
   * The first prepare, off the boot.
   *
   * At mount the handset has just built a creature, taken a gl context and
   * compiled two post passes; a 1024² render on top of that is the one
   * thing on this screen with no deadline at all. So it waits for a thread
   * that is actually free — and the popover starts it again on open, which
   * is the path that matters.
   */
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  let idleTimer = 0;
  if (typeof idle === 'function') idle.call(window, prepare);
  else idleTimer = window.setTimeout(prepare, MOTION.primaryMs);

  return {
    mark,
    menu,
    open: () => open,
    setOpen,
    destroy(): void {
      for (const t of timers.values()) window.clearTimeout(t);
      window.clearTimeout(idleTimer);
      if (enterRaf !== 0 && typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(enterRaf);
      mark.removeEventListener('click', toggle);
      mark.removeEventListener('pointerdown', swallow);
      menu.removeEventListener('pointerdown', swallow);
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey);
      mark.remove();
      menu.remove();
    },
  };
}
