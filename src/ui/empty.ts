/**
 * NOTHING OF YOURS IS IN HERE — the empty state of the phone's world view.
 *
 * > User ask, 2026-09-17 (mobile): *"there should be better empty/loading
 * > states."*
 *
 * A handset can reach `?view=world` with no drawing of its own: a shared
 * link opened twice, a person who tapped through before drawing, a device
 * whose storage was cleared. Everything that makes this view worth looking
 * at is keyed to that missing drawing — the stick, the follow camera, the
 * minimap's self mark and the ball readout are all behind `myDrawerId`
 * (src/main.ts) — so what was left was a spectator view with a dead stick's
 * worth of nothing: a world that could not be played, and no word about why.
 *
 * One line, and the way to fix it. The line says what is missing rather than
 * what went wrong, because nothing went wrong.
 *
 * THE MARKS, and there are two (TASTE §4): the LINE in the world view's own
 * type, and a `draw` rule-link under it — a hairline rule under a word, the
 * same affordance the skip link and the operator line carry. No panel, no
 * card, no shadow, no filled button. It SLIDES in on the settle curve and the
 * ambient drift floor runs under it (TASTE §2.1, §3).
 *
 * KATAMARI-ONLY and dynamically imported behind the flag, like the loading
 * line and the ball readout: on a world with no game the view without a
 * drawing is a perfectly good landscape to watch, and nobody asked for a line
 * over it.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { sampleDrift } from '../motion/ambient';

/** What it says. Lowercase, like every string in this world (TASTE §5). */
export const EMPTY_LINE = 'draw your creature first';
/** …and the way on. */
export const EMPTY_LINK_LABEL = 'draw';

/** Stable seed for this line's drift channel. */
const EMPTY_SEED = 24.6;
/** Nominal scale the drift amplitude is a fraction of, px. */
const DRIFT_SCALE = 160;
/** Draw cadence — one line, forever. */
const DRAW_INTERVAL_MS = 1000 / 30;

const STYLE_ID = 'world-empty-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.world-empty {
  position: fixed;
  left: 50%;
  top: 44%;
  z-index: 6;
  transform: translate(-50%, -50%);
  display: grid;
  justify-items: center;
  gap: 1.1em;
  color: var(--rw-ink, ${WORLD.ink});
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  text-align: center;
}
/* The drift layer: its own element, because the slide owns a transform and
   two cannot share one (TASTE §3). */
.world-empty-drift {
  display: grid;
  justify-items: center;
  gap: 1.1em;
  opacity: 0;
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.world-empty.in .world-empty-drift { opacity: 1; }
.world-empty-link {
  color: var(--rw-ink, ${WORLD.ink});
  text-decoration: none;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--rw-ink, ${WORLD.ink});
}
`;
  document.head.appendChild(style);
}

export interface EmptyOptions {
  mount: HTMLElement;
  /** Where the drawing pad is, for this room and world. */
  href: string;
}

export interface EmptyHandle {
  el: HTMLElement;
  line(): string;
  /** Where the link goes — the pad, carrying the world. */
  href(): string;
  dispose(): void;
}

/** Mount the prompt. Knows one line and one address. */
export function installEmptyState(opts: EmptyOptions): EmptyHandle {
  ensureStyle();

  const el = document.createElement('div');
  el.className = 'world-empty';
  el.setAttribute('role', 'status');

  const drift = document.createElement('div');
  drift.className = 'world-empty-drift';
  const line = document.createElement('div');
  line.className = 'world-empty-line';
  line.textContent = EMPTY_LINE;
  const link = document.createElement('a');
  link.className = 'world-empty-link';
  link.href = opts.href;
  link.textContent = EMPTY_LINK_LABEL;

  drift.append(line, link);
  el.appendChild(drift);
  opts.mount.appendChild(el);

  // It arrives rather than appearing — one frame later, so the transition
  // has a state to come from (TASTE §2.1).
  requestAnimationFrame(() => el.classList.add('in'));

  let raf = 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    const d = sampleDrift(now, EMPTY_SEED, DRIFT_SCALE);
    drift.style.transform = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;
  };
  raf = requestAnimationFrame(frame);

  return {
    el,
    line: () => line.textContent ?? '',
    href: () => link.href,
    dispose(): void {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      el.remove();
    },
  };
}
