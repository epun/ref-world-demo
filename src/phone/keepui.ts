/**
 * The three ways to take your creature home, on the companion.
 *
 * One mark in the corner, and the choices hide until it is asked. Same
 * split the world tray already uses for its emotes and for the same
 * reason: the common gesture stays cheap, and a three-way choice does not
 * sit permanently over the one object the screen is for.
 *
 * The corner is 19cqw square (states.ts), which is room for one mark and
 * not for three words. So the mark toggles, and the row opens across the
 * lower part of the portrait — the part that is empty in every framing,
 * because the creature is centred with real margin around it.
 *
 * Marks: a wavering ring with a stroke inside it, and three wavering
 * outlines with lowercase words in them (TASTE §4 — icon, border, and
 * nothing filled). The same hand as the minimap's border and the world
 * link's button, so this reads as part of the same object rather than as a
 * control panel that arrived from somewhere else.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { wavyBorderPath, wavyBorderPoints } from './minimap';
import { wavyRingPoints } from '../world/joystick';
import { keepUrl, keepsakeFilename } from './keeplink';
import { deliver, exportGlb, renderKeepsake } from './keepsake';
import type { StrokeList } from '../shape/types';

/** What each choice says before it is pressed. */
export const KEEP_LABELS = {
  picture: 'picture',
  model: '3d model',
  link: 'link',
} as const;

export type KeepAction = keyof typeof KEEP_LABELS;

/** What it says after, while the word is still worth reading. */
export const KEEP_DONE: Record<KeepAction, string> = {
  picture: 'saved',
  model: 'saved',
  link: 'copied',
};

export const KEEP_FAILED = 'try again';

/**
 * How long a result stays on the button before it goes back to its label.
 *
 * Long enough to be read on a phone held at arm's length, short enough
 * that the row is not still congratulating itself when somebody comes back
 * to press another one.
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
  /** Told what happened, so the caller can put a line somewhere if it wants. */
  onResult?(action: KeepAction, ok: boolean): void;
}

export interface KeepUiHandle {
  /** The corner mark — mounts into `slots.corner`. */
  mark: HTMLElement;
  /** The row of choices — mounts over the portrait. */
  row: HTMLElement;
  open(): boolean;
  setOpen(on: boolean): void;
  destroy(): void;
}

const STYLE_ID = 'phone-keep-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.keep-mark {
  width: 100%;
  height: 100%;
  display: block;
  border: 0;
  padding: 0;
  background: none;
  color: ${WORLD.ink};
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.keep-mark[data-open='true'] { opacity: 1; }
.keep-mark svg { display: block; width: 100%; height: 100%; overflow: visible; }
.keep-mark path {
  fill: none;
  stroke: ${WORLD.ink};
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

/* The row sits over the empty lower band of the portrait. It is not a
   panel: nothing behind the words, and the three outlines are the only
   marks in it. */
.keep-row {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 8%;
  display: flex;
  justify-content: center;
  gap: 3%;
  pointer-events: none;
  opacity: 0;
  /* Slides up into place — entrances slide, never scale, never fade
     alone. The transform is what carries it; the opacity only keeps it
     from being visible before it has somewhere to be. */
  transform: translateY(8%);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.keep-row[data-open='true'] {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.keep-choice {
  position: relative;
  border: 0;
  background: none;
  padding: 2.6% 4%;
  color: ${WORLD.ink};
  font-family: "helvetica neue", helvetica, arial, sans-serif;
  font-weight: 400;
  font-size: clamp(10px, 3.6cqw, 13px);
  letter-spacing: 0.01em;
  white-space: nowrap;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  /* No transition on opacity while it is being pressed — the press
     treatment is the border, not a fade. */
}
.keep-choice svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.keep-choice svg path {
  fill: none;
  stroke: ${WORLD.ink};
  stroke-width: 1.1;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.keep-choice[disabled] { opacity: 0.45; cursor: default; }
.keep-choice span { position: relative; }
`;
  document.head.appendChild(style);
}

/** Seeds, so the same button wavers the same way on every render. */
const MARK_SEED = 12;
const CHOICE_SEEDS: Record<KeepAction, number> = { picture: 41, model: 58, link: 93 };

function svg(width: number, height: number): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.setAttribute('preserveAspectRatio', 'none');
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function path(d: string): SVGPathElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', d);
  return el;
}

/**
 * Mount the corner mark and the row it opens.
 *
 * The caller places both — the mark in the corner slot, the row over the
 * portrait — because this module has no business knowing the stage's
 * layout and the stage has no business knowing what saving is.
 */
export function mountKeepUi(options: KeepUiOptions): KeepUiHandle {
  ensureStyle();

  // ── the corner mark ──────────────────────────────────────────────────────
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'keep-mark';
  mark.dataset['open'] = 'false';
  mark.setAttribute('aria-label', 'keep your creature');
  const markSvg = svg(100, 100);
  // A ring, and a stroke going down into it — the hand-drawn ancestor of
  // every save glyph, without the engineered tray under it.
  markSvg.appendChild(path(wavyBorderPath(wavyRingPoints(50, 50, 40, MARK_SEED, 24))));
  markSvg.appendChild(path('M50 30 L50 62 M38 51 L50 63 L62 51'));
  mark.appendChild(markSvg);

  // ── the row ──────────────────────────────────────────────────────────────
  const row = document.createElement('div');
  row.className = 'keep-row';
  row.dataset['open'] = 'false';
  // Hidden from the reading order until it is open, so a screen reader is
  // not offered three buttons that are not on screen.
  row.setAttribute('aria-hidden', 'true');

  let open = false;
  const timers = new Map<KeepAction, number>();
  /** Actions in flight, so a second tap cannot start a second render. */
  const busy = new Set<KeepAction>();

  const buttons = new Map<KeepAction, { el: HTMLButtonElement; label: HTMLElement }>();

  const setOpen = (on: boolean): void => {
    if (on === open) return;
    open = on;
    row.dataset['open'] = on ? 'true' : 'false';
    row.setAttribute('aria-hidden', on ? 'false' : 'true');
    mark.dataset['open'] = on ? 'true' : 'false';
  };

  const say = (action: KeepAction, text: string): void => {
    const entry = buttons.get(action);
    if (!entry) return;
    entry.label.textContent = text;
    window.clearTimeout(timers.get(action));
    timers.set(
      action,
      window.setTimeout(() => {
        entry.label.textContent = KEEP_LABELS[action];
      }, KEEP_FEEDBACK_MS),
    );
  };

  /**
   * The link, shared or copied.
   *
   * Share first for the same reason the files do: on a handset the share
   * sheet is how a link reaches the place somebody keeps things, and the
   * clipboard is a fallback that a person has to know to paste. A world is
   * required — a link into a world that does not persist would be a
   * promise this cannot keep.
   */
  const keepLink = async (): Promise<boolean> => {
    if (!options.world) return false;
    const url = keepUrl(location.origin, { world: options.world, id: options.identity });
    const nav = navigator as Navigator & {
      share?: (data: { url?: string; title?: string }) => Promise<void>;
    };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ url, title: options.name() ?? 'my creature' });
        return true;
      } catch (err) {
        // Cancelled is not failed — see keepsake.ts deliver().
        if (err instanceof Error && err.name === 'AbortError') return true;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  };

  const run = async (action: KeepAction): Promise<void> => {
    if (busy.has(action)) return;
    busy.add(action);
    const entry = buttons.get(action);
    if (entry) entry.el.disabled = true;
    try {
      let ok = false;
      if (action === 'link') {
        ok = await keepLink();
      } else if (action === 'picture') {
        const blob = await renderKeepsake(options.strokes, options.identity);
        ok = blob
          ? (await deliver(blob, keepsakeFilename(options.name(), options.identity, 'png'))) !==
            'failed'
          : false;
      } else {
        const blob = await exportGlb(options.strokes, options.identity);
        ok = blob
          ? (await deliver(blob, keepsakeFilename(options.name(), options.identity, 'glb'))) !==
            'failed'
          : false;
      }
      say(action, ok ? KEEP_DONE[action] : KEEP_FAILED);
      options.onResult?.(action, ok);
    } finally {
      busy.delete(action);
      if (entry) entry.el.disabled = false;
    }
  };

  const actions: KeepAction[] = options.world
    ? ['picture', 'model', 'link']
    : // No shared world, so no link that would still resolve tomorrow. The
      // file exports do not need one and stay.
      ['picture', 'model'];

  for (const action of actions) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'keep-choice';
    const border = svg(100, 40);
    border.appendChild(path(wavyBorderPath(wavyBorderPoints(100, 40, 3, CHOICE_SEEDS[action], 8))));
    const label = document.createElement('span');
    label.textContent = KEEP_LABELS[action];
    el.append(border, label);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      void run(action);
    });
    row.appendChild(el);
    buttons.set(action, { el, label });
  }

  const toggle = (event: Event): void => {
    event.stopPropagation();
    setOpen(!open);
  };
  mark.addEventListener('click', toggle);

  // A tap anywhere else closes it. Captured, so it is heard before the
  // portrait's own drag handler claims the pointer.
  const dismiss = (event: Event): void => {
    if (!open) return;
    if (event.target instanceof Node && (row.contains(event.target) || mark.contains(event.target)))
      return;
    setOpen(false);
  };
  window.addEventListener('pointerdown', dismiss, true);

  return {
    mark,
    row,
    open: () => open,
    setOpen,
    destroy(): void {
      for (const t of timers.values()) window.clearTimeout(t);
      mark.removeEventListener('click', toggle);
      window.removeEventListener('pointerdown', dismiss, true);
      mark.remove();
      row.remove();
    },
  };
}
