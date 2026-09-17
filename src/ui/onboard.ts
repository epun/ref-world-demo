/**
 * HOW TO PLAY, BEFORE THE WORLD OPENS — the onboarding screens.
 *
 * > User ask, 2026-09-17 (mobile): *"we should have an onboarding stage to
 * > tell people how to play the game, before they load into the world. i.e.
 * > move with joystick to move character, run into objects to pick them up,
 * > grow your mass as large as you can."*
 *
 * Three occupancies of ONE surface, not three pages: the copy and its mark
 * swap over a field that never moves, the way the phone's own flow works
 * (docs/PHONE-STAGE.md §2). What arrives is a line and an icon; what stays is
 * the paper, the progress ticks, and the way out.
 *
 * THE MARKS, and there are four kinds, all of them in the mark set (TASTE §4
 * — `icon` + `ruleLine` + `border`, the world brief's #1 defining signal at
 * confidence 1.00):
 *
 * - the LINE, in the world view's own type — the same face and size as
 *   `.world-say`, `.draw-hint` and the ball readout, because this is another
 *   line of the world's own chrome and a second face here would be a second
 *   voice. Lowercase throughout (TASTE §5); the copy itself is a table in
 *   src/ui/onboardcopy.ts so it can be edited without touching this file;
 * - one ICON per screen, drawn by the same hand as every other border in this
 *   world (`wavyRingPoints` + `wavyBorderPath`, shared with the stick, the
 *   minimap and the ball readout) — a picture of the thing the line is about,
 *   which is what an icon mark is for;
 * - three TICKS, the same wavering ring at dot size, the passed ones inked.
 *   Progress, in the only mark this world has for it;
 * - the two ways on: `skip` as a HAIRLINE RULE under a word — the brief's
 *   *"reserve a single hairline rule to divide the frame"*, the same
 *   border-bottom the tray's hint and the operator line carry — and `start`
 *   as a wavering BORDER all the way round, the identical affordance the way
 *   out of the device already is (src/phone/worldlink.ts).
 *
 * No filled panel, no card, no shadow and no filled button. The one surface
 * is the FIELD itself — full-frame paper in `SURFACE.ground`, the one paper of
 * the whole mobile flow, exactly as the draw overlay's field is
 * (src/main.ts `.draw-overlay`). A screen is not a panel: it has no edge
 * inside the frame, nothing floats on it and nothing is lifted off it.
 *
 * THE MOTION. Each screen SLIDES in from the side it came from and the old
 * one slides out the other way, over `MOTION.secondaryMs` on the settle curve
 * — the css-side equivalent of the ζ≥1 spring, so no bounce by construction
 * and never a `scale: 0 → 1` (TASTE §2.1, confidence 1.00). The field itself
 * slides DOWN out of the way when the person starts, which is the seam the
 * device already leaves by. Underneath it all the ambient drift floor runs,
 * forever, like everything else on screen (TASTE §3).
 *
 * SEEN ONCE PER DEVICE. A flag in localStorage, wrapped in try/catch like
 * every other store read in this project (a private-mode handset throws on
 * write, and a person who cannot be remembered must still be able to play),
 * and `?onboard=1` on the address re-shows it — that is how this gets tested
 * on a real phone without clearing site data.
 *
 * THIS MODULE IS KATAMARI-ONLY (2026-09-15 user ruling, src/world/game.ts).
 * There is no joystick, no pickup and no ball in a world without the game, so
 * every word here would be a lie about it. `src/main.ts` reaches it through a
 * DYNAMIC import behind `game === 'katamari'` — the same discipline the ball
 * readout and the object library are loaded under, so meridian and the public
 * world never carry the chunk at all.
 *
 * The pure half — the flag, the query, the screen order — is at the top with
 * no DOM in it, so a test in node can pin the part that is actually easy to
 * get wrong.
 */

import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import { sampleDrift } from '../motion/ambient';
import { wavyBorderPath, wavyBorderPoints } from '../phone/minimap';
import { wavyRingPoints } from '../world/joystick';
import type { StorageLike } from '../phone/identity';
import {
  ONBOARD_SCREENS,
  SKIP_LABEL,
  START_LABEL,
  type OnboardIcon,
} from './onboardcopy';

// ── pure: seen once per device ───────────────────────────────────────────────

/**
 * The flag's key. Namespaced like every other key this project writes
 * (`refworld:drawer`, `refworld:submission:<room>` — src/phone/identity.ts),
 * so a handset's storage stays readable by a person looking at it.
 *
 * NOT room-scoped and not world-scoped: this is how to play a game, and
 * somebody who has been told once has been told.
 */
export const ONBOARD_KEY = 'refworld:onboarded';

/** The query that re-shows it, for testing on a device that has seen it. */
export const ONBOARD_QUERY = 'onboard';

/**
 * Read the flag. Never throws: storage that is absent, blocked, or in a
 * private window answers "not seen", and the worst that happens to somebody
 * who cannot be remembered is that they are told how to play again.
 */
export function onboarded(store: StorageLike | null): boolean {
  if (!store) return false;
  try {
    return store.getItem(ONBOARD_KEY) === '1';
  } catch {
    return false;
  }
}

/** Write the flag. Same rule: a failure is not worth a thrown frame. */
export function markOnboarded(store: StorageLike | null): void {
  if (!store) return;
  try {
    store.setItem(ONBOARD_KEY, '1');
  } catch {
    /* a handset that cannot remember is told again — that is the whole cost */
  }
}

/**
 * Does this page show the screens?
 *
 * `?onboard=1` wins outright, which is the testing path; otherwise it is the
 * flag, and the flag is only ever written when somebody reaches the end (or
 * skips, which is also a person who has seen it).
 */
export function shouldOnboard(search: string, store: StorageLike | null): boolean {
  const asked = (new URLSearchParams(search).get(ONBOARD_QUERY) ?? '').trim().toLowerCase();
  if (asked === '1' || asked === 'on') return true;
  if (asked === '0' || asked === 'off') return false;
  return !onboarded(store);
}

/** How many screens there are — the ticks read it, and so does the test. */
export const ONBOARD_COUNT = ONBOARD_SCREENS.length;

// ── the icons ────────────────────────────────────────────────────────────────

/** The icon's user-space box. Fixed, so the wavering is computed once. */
const ICON_BOX = 100;
/** The icon's box on screen, css px. */
const ICON_PX = 52;
/** Stroke weight on screen, css px — a hairline, like every other border. */
const ICON_STROKE_PX = 1.4;

/** A ring in the icon's box, as path data. `seed` is that ring's own hand. */
function ring(cx: number, cy: number, r: number, seed: number): string {
  return wavyBorderPath(wavyRingPoints(cx, cy, r, seed));
}

/**
 * The rings one icon is made of. **[D]**
 *
 * Every mark in this set is a RING, because every mark in this world is:
 * the stick is a ring with a knob in it, the ball readout is a ring, the
 * minimap is a wavering loop. Three rings arranged three ways say "the
 * stick", "a thing joining your ball" and "small becomes big" without a
 * second vocabulary having to be invented for a screen nobody sees twice.
 */
export function iconRings(kind: OnboardIcon): { cx: number; cy: number; r: number; seed: number }[] {
  switch (kind) {
    case 'stick':
      // The well, and the knob pushed off centre — the stick, mid-shove.
      return [
        { cx: 46, cy: 52, r: 34, seed: 31 },
        { cx: 66, cy: 62, r: 12, seed: 74 },
      ];
    case 'pickup':
      // Your ball, and the stone it is about to take on.
      return [
        { cx: 40, cy: 60, r: 28, seed: 18.5 },
        { cx: 78, cy: 34, r: 11, seed: 62.1 },
      ];
    case 'grow':
      // Small, then big. The same ring twice, which is what growing is.
      return [
        { cx: 22, cy: 66, r: 12, seed: 47.3 },
        { cx: 62, cy: 52, r: 30, seed: 58.2 },
      ];
  }
}

/** One icon as an svg element. */
function iconEl(kind: OnboardIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'onboard-icon');
  svg.setAttribute('viewBox', `0 0 ${ICON_BOX} ${ICON_BOX}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const r of iconRings(kind)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'onboard-mark');
    path.setAttribute('d', ring(r.cx, r.cy, r.r, r.seed));
    path.setAttribute('stroke-width', ((ICON_STROKE_PX * ICON_BOX) / ICON_PX).toFixed(3));
    svg.appendChild(path);
  }
  return svg;
}

// ── the field ────────────────────────────────────────────────────────────────

/**
 * Progress tick geometry.
 *
 * Drawn LARGE in user space and shown small, because the hand that draws
 * every border in this world wavers by a fixed 1.4 units (`RING_WAVER`,
 * src/world/joystick.ts): at a radius of four that is a third of the ring and
 * the tick reads as an ink splat, at a radius of fifteen it is a tenth and it
 * reads as the same ring as everything else. The waver is the world's, not
 * this mark's, so the mark is what moves.
 */
const TICK_BOX = 40;
const TICK_R = 15;
/** …shown at this size on screen, css px. */
const TICK_PX = 11;
/** Stroke weight on screen, css px — a hairline, like every other border. */
const TICK_STROKE_PX = 1.1;
/** Stable seed for the field's drift channel. */
const FIELD_SEED = 12.7;
/** Nominal scale the drift amplitude is a fraction of, px. */
const DRIFT_SCALE = 180;
/** Draw cadence — a line and a tick, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;
/**
 * How far a thumb has to travel for a swipe rather than a tap, css px. **[D]**
 * Below it the gesture is a tap, and both mean "on" — a person flicking
 * through and a person tapping through get the same three screens.
 */
export const SWIPE_PX = 28;
/** Room for the waver to move without clipping at the border's edge. */
const BORDER_INSET = 2.5;
/** The start affordance's own hand. */
const START_SEED = 41.7;

const STYLE_ID = 'world-onboard-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/*
 * THE FIELD. Full-frame paper, the one paper of the whole mobile flow
 * (SURFACE.ground — the value phone.html and /draw/ both paint), and the
 * same treatment the draw overlay's field already has. It is a screen, not
 * a panel: no edge inside the frame, nothing floating on it, nothing lifted
 * off it.
 *
 * It leaves by sliding DOWN, on the settle curve, which is the seam the
 * device itself leaves by (src/phone/device.ts .leaving).
 */
.world-onboard {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: ${SURFACE.ground};
  color: ${WORLD.ink};
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  display: grid;
  grid-template-rows: 1fr auto auto;
  align-items: center;
  justify-items: center;
  padding: calc(env(safe-area-inset-top, 0px) + 8vh) 8vw
    calc(env(safe-area-inset-bottom, 0px) + 6vh);
  box-sizing: border-box;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transform: translateY(0);
  transition: transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.world-onboard.out { transform: translateY(103%); }
/* The drift layer. Nothing fully arrests (TASTE §3), and the transform here
   is written per frame — which is why it is its own element: the slides
   below own transforms of their own and two cannot share one. */
.onboard-drift {
  display: grid;
  justify-items: center;
  gap: 6vh;
  width: 100%;
}
/* One surface, three occupancies: the arriving screen is laid over the
   leaving one so neither reflows the other. */
.onboard-stage {
  position: relative;
  display: grid;
  justify-items: center;
  width: 100%;
}
.onboard-screen {
  grid-area: 1 / 1;
  display: grid;
  justify-items: center;
  gap: 4vh;
  width: 100%;
  opacity: 0;
  transform: translateX(14%);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.onboard-screen.in { opacity: 1; transform: translateX(0); }
.onboard-screen.out { opacity: 0; transform: translateX(-14%); }
/* A screen that came from the other direction leaves and arrives the other
   way round, so going back is the same motion reversed rather than a
   second, unrelated one. */
.onboard-screen.back { transform: translateX(-14%); }
.onboard-screen.back.out { transform: translateX(14%); }
.onboard-icon {
  display: block;
  width: ${ICON_PX}px;
  height: ${ICON_PX}px;
  overflow: visible;
}
.onboard-mark {
  fill: none;
  stroke: ${WORLD.ink};
  stroke-linejoin: round;
}
.onboard-line {
  margin: 0;
  max-width: 24em;
  text-align: center;
}
/* Progress: three of the same wavering ring, the passed ones inked. */
.onboard-ticks {
  display: flex;
  gap: 10px;
  align-items: center;
}
.onboard-tick {
  display: block;
  width: ${TICK_PX}px;
  height: ${TICK_PX}px;
  overflow: visible;
}
.onboard-tick path {
  fill: none;
  stroke: ${WORLD.ink};
  stroke-width: ${((TICK_STROKE_PX * TICK_BOX) / TICK_PX).toFixed(2)};
  transition: fill ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.onboard-tick[data-at='true'] path { fill: ${WORLD.ink}; }
/*
 * The two ways on, stacked and centred under the thumb rather than side by
 * side: starting is the thing being offered and skipping is the thing being
 * allowed, and a row of two put neither of them in the middle of the screen.
 *
 * Both rows are in the layout on every screen, so nothing shifts under a
 * thumb when the last screen's border arrives.
 */
.onboard-skip {
  color: ${WORLD.ink};
  text-decoration: none;
  margin-top: 3vh;
  padding-bottom: 0.35em;
  border-bottom: 1px solid ${WORLD.ink};
  opacity: 0.7;
  transition: opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.onboard-start {
  position: relative;
  color: ${WORLD.ink};
  text-decoration: none;
  padding: 0.8em 1.9em;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
  pointer-events: none;
}
.onboard-start.in { opacity: 1; transform: translateY(0); pointer-events: auto; }
.onboard-start-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
`;
  document.head.appendChild(style);
}

export interface OnboardOptions {
  mount: HTMLElement;
  /**
   * The person is through — by starting, or by skipping. Called ONCE, as the
   * field begins to leave rather than after it has: the world behind is
   * already standing and the loading line under it has to be visible through
   * the slide, not after it.
   */
  onDone(reason: 'start' | 'skip'): void;
  /** Injectable for the tests; the real one is `localStorage`. */
  store?: StorageLike | null;
}

export interface OnboardHandle {
  el: HTMLElement;
  /** Which screen is on the surface, 0-based. */
  index(): number;
  /** What it says right now. */
  line(): string;
  /** Advance as a tap does. */
  next(): void;
  /** Go back as a swipe the other way does. */
  back(): void;
  /** Take the skip link. */
  skip(): void;
  /** Has the field been let go of yet? */
  finished(): boolean;
  dispose(): void;
}

/**
 * Mount the screens. Knows the copy, the marks and the flag — and nothing
 * about the world, the creature or the net.
 */
export function installOnboarding(opts: OnboardOptions): OnboardHandle {
  ensureStyle();

  const el = document.createElement('div');
  el.className = 'world-onboard';
  // A thing that is talking to you, and findable as one.
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'how to play');

  const drift = document.createElement('div');
  drift.className = 'onboard-drift';
  const stage = document.createElement('div');
  stage.className = 'onboard-stage';

  const ticks = document.createElement('div');
  ticks.className = 'onboard-ticks';
  const tickPath = wavyBorderPath(wavyRingPoints(TICK_BOX / 2, TICK_BOX / 2, TICK_R, 96.4));
  const tickEls: SVGSVGElement[] = [];
  for (let i = 0; i < ONBOARD_COUNT; i++) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'onboard-tick');
    svg.setAttribute('viewBox', `0 0 ${TICK_BOX} ${TICK_BOX}`);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', tickPath);
    svg.appendChild(path);
    ticks.appendChild(svg);
    tickEls.push(svg);
  }

  const skip = document.createElement('a');
  skip.className = 'onboard-skip';
  skip.href = '#';
  skip.textContent = SKIP_LABEL;
  const start = document.createElement('a');
  start.className = 'onboard-start';
  start.href = '#';
  const startFrame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  startFrame.setAttribute('class', 'onboard-start-frame');
  startFrame.setAttribute('aria-hidden', 'true');
  const startOutline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  startOutline.setAttribute('fill', 'none');
  startOutline.setAttribute('stroke', 'currentColor');
  startOutline.setAttribute('stroke-width', '1');
  startOutline.setAttribute('stroke-linejoin', 'round');
  startFrame.appendChild(startOutline);
  const startLabel = document.createElement('span');
  startLabel.textContent = START_LABEL;
  start.append(startFrame, startLabel);
  drift.append(stage, ticks);
  // The start affordance above the skip link, both centred: three rows, the
  // content taking the space the two words do not.
  el.append(drift, start, skip);
  opts.mount.appendChild(el);

  // ── the screens ───────────────────────────────────────────────────────────

  let at = 0;
  let finished = false;
  /** The screen on the surface, and the one still leaving it. */
  let current: HTMLElement | null = null;
  const leaving = new Set<HTMLElement>();

  const screenEl = (index: number, back: boolean): HTMLElement => {
    const screen = ONBOARD_SCREENS[index]!;
    const wrap = document.createElement('div');
    wrap.className = back ? 'onboard-screen back' : 'onboard-screen';
    const line = document.createElement('p');
    line.className = 'onboard-line';
    line.textContent = screen.line;
    wrap.append(iconEl(screen.icon), line);
    return wrap;
  };

  const paintTicks = (): void => {
    tickEls.forEach((tick, i) => {
      tick.dataset['at'] = i <= at ? 'true' : 'false';
    });
  };

  /** Redraw the start border at its real size. Idempotent. */
  let drawnAt = '';
  const drawStart = (): void => {
    const w = Math.round(start.offsetWidth);
    const h = Math.round(start.offsetHeight);
    if (w < 2 || h < 2) return;
    const key = `${w}x${h}`;
    if (key === drawnAt) return;
    drawnAt = key;
    startFrame.setAttribute('viewBox', `0 0 ${w} ${h}`);
    startOutline.setAttribute(
      'd',
      wavyBorderPath(wavyBorderPoints(w, h, BORDER_INSET, START_SEED)),
    );
  };

  const show = (index: number, back: boolean): void => {
    at = index;
    const wrap = screenEl(index, back);
    stage.appendChild(wrap);
    const old = current;
    current = wrap;
    // Two frames rather than one: the element has to be in the document with
    // its off-side transform APPLIED before the class that moves it lands,
    // or the browser has nothing to interpolate from and the screen appears
    // instead of arriving (which would be a cut — TASTE §2.1).
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('in')));
    if (old) {
      old.classList.remove('in');
      old.classList.add('out');
      leaving.add(old);
      window.setTimeout(() => {
        leaving.delete(old);
        old.remove();
      }, MOTION.secondaryMs);
    }
    paintTicks();
    // The last screen is the one with a way in.
    start.classList.toggle('in', index === ONBOARD_COUNT - 1);
    if (index === ONBOARD_COUNT - 1) requestAnimationFrame(drawStart);
  };

  const done = (reason: 'start' | 'skip'): void => {
    if (finished) return;
    finished = true;
    // Written the moment the person is through, whichever way they went: a
    // skip is somebody saying they have seen it.
    markOnboarded(opts.store === undefined ? defaultStore() : opts.store);
    el.classList.add('out');
    opts.onDone(reason);
    // Off the page once the slide is over — not before, or the field would
    // vanish mid-move, and not never, or a fixed surface would keep eating
    // the taps meant for the stick underneath it.
    window.setTimeout(() => el.remove(), MOTION.secondaryMs);
  };

  const next = (): void => {
    if (finished) return;
    if (at >= ONBOARD_COUNT - 1) {
      done('start');
      return;
    }
    show(at + 1, false);
  };

  const back = (): void => {
    if (finished || at === 0) return;
    show(at - 1, true);
  };

  show(0, false);

  // ── the gestures ──────────────────────────────────────────────────────────

  let downX: number | null = null;
  const onDown = (event: PointerEvent): void => {
    downX = event.clientX;
  };
  const onUp = (event: PointerEvent): void => {
    if (downX === null) return;
    const dx = event.clientX - downX;
    downX = null;
    if (dx <= -SWIPE_PX) next();
    else if (dx >= SWIPE_PX) back();
    else next();
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerup', onUp);

  const onSkip = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    done('skip');
  };
  const onStart = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    done('start');
  };
  skip.addEventListener('click', onSkip);
  start.addEventListener('click', onStart);
  // The field's own tap handler would see these too, and a skip that also
  // advanced a screen on its way out would be two answers to one thumb.
  skip.addEventListener('pointerup', (event) => event.stopPropagation());
  start.addEventListener('pointerup', (event) => event.stopPropagation());

  // ── the drift floor ───────────────────────────────────────────────────────

  let raf = 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    const d = sampleDrift(now, FIELD_SEED, DRIFT_SCALE);
    drift.style.transform = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;
  };
  raf = requestAnimationFrame(frame);

  return {
    el,
    index: () => at,
    line: () => ONBOARD_SCREENS[at]?.line ?? '',
    next,
    back,
    skip: () => done('skip'),
    finished: () => finished,
    dispose(): void {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      skip.removeEventListener('click', onSkip);
      start.removeEventListener('click', onStart);
      el.remove();
    },
  };
}

/**
 * The real store, probed the way `src/phone/identity.ts` probes it: safari in
 * a private window throws on WRITE, not on access, so the probe is a write.
 */
function defaultStore(): StorageLike | null {
  try {
    const ls = globalThis.localStorage;
    ls.setItem(ONBOARD_KEY + ':probe', '1');
    return ls;
  } catch {
    return null;
  }
}

/** The same probe, for a caller deciding whether to mount at all. */
export function deviceStore(): StorageLike | null {
  return defaultStore();
}
