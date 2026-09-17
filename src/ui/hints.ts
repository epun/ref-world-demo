/**
 * HOW TO PLAY, WHILE PLAYING — the contextual hints on the world view.
 *
 * > User ask, 2026-09-17, with three screenshots of the live slides: *"For
 * > mobile I want the onboarding to be contextual within the device."*
 *
 * The three lessons that were three grey screens in front of the game are now
 * three marks IN it. Each one is anchored to the thing it is about and is
 * dismissed by DOING that thing, which is the difference between being told
 * how to play and being taught:
 *
 *   move    above the joystick, the moment the stick can actually move the
 *           creature — and gone once the thumb has HELD it past the deadzone
 *           for `DRIVE_HELD_MS`, which is the first real drive intent rather
 *           than a brush against the glass;
 *   pickup  under the ball readout, once the creature has travelled
 *           `MOVE_UNITS` — so it arrives to somebody who is already rolling —
 *           and gone on their first pickup;
 *   grow    beside the readout, from that first pickup, so the number it is
 *           about is the number beside it. Gone on the next pickup, or after
 *           `GROW_MS` if that is somebody taking their time.
 *
 * Then nothing, forever: the flag is written and this device is done being
 * taught. A `skip` rule-link ends the tour from any of the three.
 *
 * THE MARKS, and there are three kinds, all of them in the mark set (TASTE §4
 * — `icon` + `ruleLine` + `border`, the world brief's #1 defining signal at
 * confidence 1.00):
 *
 * - the LINE, in the world view's own type — the same face and size as the
 *   ball readout, `.world-say` and the draw hint, because this is another
 *   line of the world's own chrome and a second face here would be a second
 *   voice. Ink on the meadow, lowercase throughout (TASTE §5); the copy is a
 *   table in src/ui/hintcopy.ts so it can be edited without touching layout;
 * - one ICON per hint, drawn by the same hand as every other border in this
 *   world (`wavyRingPoints` + `wavyBorderPath`, shared with the stick, the
 *   minimap and the readout's ring);
 * - a HAIRLINE RULE under the line — the brief's *"reserve a single hairline
 *   rule to divide the frame"*, the same border-bottom the readout, the
 *   tray's hint and the operator line already carry.
 *
 * No filled panel, no card, no background, no shadow: a hint is a line of
 * type on the world, not a tooltip on a surface.
 *
 * THE MOTION. Every entrance and every exit SLIDES on the settle curve over
 * `MOTION.secondaryMs` — the css-side equivalent of the ζ≥1 spring, so no
 * bounce by construction — and never a `scale: 0 → 1` (TASTE §2.1,
 * confidence 1.00). The ambient drift floor runs under each hint the whole
 * time it is up, like everything else on screen (TASTE §3).
 *
 * NOTHING SHOWS WHILE THE WORLD IS STILL COMING UP. The loading line owns the
 * screen until this handset's own creature is standing (src/ui/loading.ts),
 * and a hint about a joystick over `finding the room` would be two voices
 * about two different things.
 *
 * SEEN ONCE PER DEVICE, under a NEW key: everybody who saw the old slideshow
 * sees these hints once, which is the point of replacing it. Wrapped in
 * try/catch like every store read in this project, and `?hints=1` re-shows
 * them for testing on a real phone.
 *
 * KATAMARI-ONLY and reached through a DYNAMIC import behind the flag, like
 * the ball readout and the loading line: there is no stick, no pickup and no
 * ball in a world without the game, so every word here would be a lie about
 * it, and no other deployment carries the chunk.
 *
 * The state machine is a pure function of five signals at the top of this
 * file, with no DOM in it, so what is actually easy to get wrong — the order,
 * and what dismisses what — is pinned in node.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { Spring } from '../motion/spring';
import { sampleDrift } from '../motion/ambient';
import { wavyBorderPath } from '../phone/minimap';
import { wavyRingPoints, DEADZONE } from '../world/joystick';
import type { StorageLike } from '../phone/identity';
import { HINTS, SKIP_LABEL, hintFor, type HintIcon } from './hintcopy';

// ── pure: seen once per device ───────────────────────────────────────────────

/**
 * The flag's key.
 *
 * NEW, and deliberately not the slideshow's `refworld:onboarded`: a phone
 * that was taught by the screens has not been taught by these, and the whole
 * reason the hints exist is that the screens did not teach anybody
 * (2026-09-17). Namespaced like every other key this project writes.
 */
export const HINTS_KEY = 'refworld:hinted';

/** The query that re-shows them, for testing on a device that has seen them. */
export const HINTS_QUERY = 'hints';

/** Read the flag. Never throws — a private window is simply taught again. */
export function hinted(store: StorageLike | null): boolean {
  if (!store) return false;
  try {
    return store.getItem(HINTS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Write it. Same rule: a failure is not worth a thrown frame. */
export function markHinted(store: StorageLike | null): void {
  if (!store) return;
  try {
    store.setItem(HINTS_KEY, '1');
  } catch {
    /* a handset that cannot remember is taught again — that is the whole cost */
  }
}

/**
 * Does this page teach?
 *
 * `?hints=1` wins outright, which is the testing path; `?onboard=1` is kept as
 * an alias because that is the link this feature was tested with all day and a
 * dead query parameter is a debugging trap. Otherwise it is the flag.
 */
export function shouldHint(search: string, store: StorageLike | null): boolean {
  const params = new URLSearchParams(search);
  for (const key of [HINTS_QUERY, 'onboard']) {
    const asked = (params.get(key) ?? '').trim().toLowerCase();
    if (asked === '1' || asked === 'on') return true;
    if (asked === '0' || asked === 'off') return false;
  }
  return !hinted(store);
}

// ── pure: the machine ────────────────────────────────────────────────────────

/**
 * What the page can see about this person's own creature, per frame.
 *
 * Every one of these is read through a seam that already exists — the
 * creature manager's own answers and the stick's own vector (src/main.ts) —
 * so none of it is a second event path.
 */
export interface HintSignals {
  /**
   * Can the stick actually move this creature? Its creature is standing (out
   * of the shell, in the world) and the stick is mounted.
   */
  ready: boolean;
  /** Is the loading line still up? Nothing is taught over it. */
  loading: boolean;
  /** How far the thumb is pushed right now, 0…1 — the stick's own magnitude. */
  drive: number;
  /** World units this creature has travelled since the hints started looking. */
  travelled: number;
  /** How many pickups this creature's own ball has taken. */
  picked: number;
}

/** `none` and `moved` show nothing; the other three are the three lessons. */
export type HintPhase = 'none' | 'move' | 'moved' | 'pickup' | 'grow' | 'done';

export interface HintState {
  phase: HintPhase;
  /** How long the thumb has been past the deadzone, ms. */
  heldMs: number;
  /** How long the current hint has been on screen, ms. */
  shownMs: number;
  /** The pickup count when the current hint went up. */
  pickedAt: number;
}

export const HINT_START: HintState = { phase: 'none', heldMs: 0, shownMs: 0, pickedAt: 0 };

/**
 * How long the stick has to be HELD past its deadzone before the first hint
 * is done. **[D]**
 *
 * One `MOTION.secondaryMs`. A tap on the glass or a thumb landing while the
 * phone is picked up is not somebody driving, and a hint that vanished on
 * contact would be a hint nobody read; nearly a second of continuous push is
 * unambiguously a person steering. The deadzone itself is the stick's own
 * (`DEADZONE`, src/world/joystick.ts) rather than a second number about the
 * same thumb.
 */
export const DRIVE_HELD_MS = MOTION.secondaryMs;

/**
 * How far the creature travels before the second hint arrives, world units.
 * **[D]** Five is a couple of its own body lengths at the size it hatches —
 * far enough that the person is rolling rather than nudging, close enough
 * that the props it should be running into are still the ones around it.
 */
export const MOVE_UNITS = 5;

/**
 * How long the last hint stays if nothing else happens. **[D]** Three
 * `MOTION.primaryMs`: long enough to read twice, and it is the only one of the
 * three with no action of its own to be dismissed by — "grow as big as you
 * can" is the whole rest of the game.
 */
export const GROW_MS = MOTION.primaryMs * 3;

/**
 * How much the ball has to GROW for it to count as a pickup, world units.
 * **[D]**
 *
 * `ballDiameter` is not zero the moment a creature hatches — it is the
 * creature's own measured footprint — so "has it picked something up" is a
 * question about a CHANGE, and a hundredth of a unit is under a millimetre of
 * the smallest prop in the library while being far above the jitter of a
 * measured body.
 */
export const PICKUP_STEP_U = 0.01;

/**
 * One frame of the tour.
 *
 * Monotonic through the phases and total: it never goes back, so a creature
 * that is retired or a stick that is unmounted cannot re-teach somebody, and
 * every phase is left by DOING the thing it asks for (the last one also by
 * waiting, because staring at a number is not an action).
 */
export function stepHints(state: HintState, signals: HintSignals, dtMs: number): HintState {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const held = signals.drive > DEADZONE ? state.heldMs + dt : 0;
  const shown = state.shownMs + dt;

  switch (state.phase) {
    case 'none':
      // Nothing until the stick can do something and the world has stopped
      // saying what it is loading.
      if (!signals.ready || signals.loading) return { ...state, heldMs: held, shownMs: 0 };
      return { phase: 'move', heldMs: held, shownMs: 0, pickedAt: signals.picked };
    case 'move':
      if (held >= DRIVE_HELD_MS) {
        return { phase: 'moved', heldMs: held, shownMs: 0, pickedAt: signals.picked };
      }
      return { ...state, heldMs: held, shownMs: shown };
    case 'moved':
      // A gap with nothing on screen: the person is driving, and the next
      // lesson is about what to drive INTO.
      if (signals.travelled >= MOVE_UNITS) {
        return { phase: 'pickup', heldMs: held, shownMs: 0, pickedAt: signals.picked };
      }
      return { ...state, heldMs: held, shownMs: shown };
    case 'pickup':
      if (signals.picked > state.pickedAt) {
        return { phase: 'grow', heldMs: held, shownMs: 0, pickedAt: signals.picked };
      }
      return { ...state, heldMs: held, shownMs: shown };
    case 'grow':
      if (signals.picked > state.pickedAt || shown >= GROW_MS) {
        return { phase: 'done', heldMs: held, shownMs: 0, pickedAt: signals.picked };
      }
      return { ...state, heldMs: held, shownMs: shown };
    case 'done':
      return { ...state, heldMs: held, shownMs: shown };
  }
}

/** Is the tour over? The one place that decides when the flag is written. */
export function hintsFinished(state: HintState): boolean {
  return state.phase === 'done';
}

// ── the marks ────────────────────────────────────────────────────────────────

/** The icon's user-space box. Fixed, so the wavering is computed once. */
const ICON_BOX = 100;
/** The icon's box on screen, css px — small, beside a line of type. */
const ICON_PX = 26;
/** Stroke weight on screen, css px — a hairline, like every other border. */
const ICON_STROKE_PX = 1.25;

/**
 * The rings one icon is made of. **[D]**
 *
 * Every mark in this set is a RING, because every mark in this world is: the
 * stick is a ring with a knob in it, the readout is a ring, the minimap is a
 * wavering loop. Three rings arranged three ways say "the stick", "a thing
 * joining your ball" and "small becomes big" without a second vocabulary
 * having to be invented for three lines of type.
 */
export function iconRings(kind: HintIcon): { cx: number; cy: number; r: number; seed: number }[] {
  switch (kind) {
    case 'stick':
      return [
        { cx: 46, cy: 52, r: 34, seed: 31 },
        { cx: 66, cy: 62, r: 12, seed: 74 },
      ];
    case 'pickup':
      return [
        { cx: 40, cy: 60, r: 28, seed: 18.5 },
        { cx: 78, cy: 34, r: 11, seed: 62.1 },
      ];
    case 'grow':
      return [
        { cx: 22, cy: 66, r: 12, seed: 47.3 },
        { cx: 62, cy: 52, r: 30, seed: 58.2 },
      ];
  }
}

function iconEl(kind: HintIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'world-hint-icon');
  svg.setAttribute('viewBox', `0 0 ${ICON_BOX} ${ICON_BOX}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const r of iconRings(kind)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'world-hint-mark');
    path.setAttribute('d', wavyBorderPath(wavyRingPoints(r.cx, r.cy, r.r, r.seed)));
    path.setAttribute('stroke-width', ((ICON_STROKE_PX * ICON_BOX) / ICON_PX).toFixed(3));
    svg.appendChild(path);
  }
  return svg;
}

// ── the layer ────────────────────────────────────────────────────────────────

/** Stable seed for the hint layer's drift channel. */
const HINT_SEED = 86.3;
/** Nominal scale the drift amplitude is a fraction of, px. */
const DRIFT_SCALE = 150;
/** Draw cadence — a line of type, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;
/** How far a hint travels as it arrives or leaves, css px. **[D]** */
const SLIDE_PX = 8;
/** Presence under which a leaving hint is off the page for good. **[D]** */
const GONE = 0.01;

const STYLE_ID = 'world-hints-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/*
 * Two anchors, both of them things already on screen. Neither is a surface:
 * no field, no scrim, no card — the meadow shows through between the marks
 * (TASTE §4).
 */
.world-hint {
  position: fixed;
  z-index: 31;
  color: ${WORLD.ink};
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  pointer-events: none;
}
/*
 * Above the joystick and CLEAR OF THE TRAY, centred over the thing it is
 * about however wide the phone is. The offset is the tray's own height plus
 * air — the device thumbnail and the minimap are as tall as the stick, and a
 * line of type across them would be type on top of two other marks.
 */
.world-hint.at-stick {
  left: 0;
  right: 0;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 40vw);
  display: grid;
  justify-items: center;
}
/* The rule underlines the SENTENCE, not the screen: the row hugs its own
   content, so the hairline is the width of the words above it. */
.world-hint.at-stick .world-hint-drift { justify-self: center; }
.world-hint.at-stick .world-hint-row {
  width: max-content;
  max-width: 74vw;
}
/* Under the ball readout at the top left — clear of the stick and clear of
   the minimap, on the side of the screen the number lives on. */
.world-hint.at-readout {
  left: calc(env(safe-area-inset-left, 0px) + 4vw);
  top: calc(env(safe-area-inset-top, 0px) + 4vw + 42px);
  max-width: 62vw;
}
/* The drift layer: its own element, because the slide owns a transform and
   two of them cannot share one (TASTE §3). */
.world-hint-drift { display: block; }
/*
 * The row itself carries the rule mark and nothing else about its motion:
 * the SLIDE is written per frame from a ζ ≥ 1 spring below (opacity and a
 * translate, in from below and out upwards), rather than from a css
 * transition. Measured reason, 2026-09-17: on the built page the class-driven
 * transition never ran — the row sat at opacity 0 with its class applied,
 * forever — and a hint nobody can see is worse than no hint. The spring is
 * also what the rest of this project animates with (src/motion/spring.ts,
 * where underdamped is unrepresentable), so this is one mechanism instead of
 * two.
 */
.world-hint-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 0.45em;
  border-bottom: 1px solid ${WORLD.ink};
  opacity: 0;
}
.world-hint-icon {
  display: block;
  width: ${ICON_PX}px;
  height: ${ICON_PX}px;
  flex: none;
  overflow: visible;
}
.world-hint-mark {
  fill: none;
  stroke: ${WORLD.ink};
  stroke-linejoin: round;
}
.world-hint-line { display: block; }
/* The way past the whole tour: a word under a rule, and the one thing on
   this layer a thumb can reach. */
.world-hint-skip {
  align-self: center;
  flex: none;
  margin-left: 6px;
  color: ${WORLD.ink};
  text-decoration: none;
  opacity: 0.6;
  pointer-events: auto;
}
`;
  document.head.appendChild(style);
}

export interface HintsOptions {
  /** Where a `readout`-anchored hint hangs — normally `document.body`. */
  mount: HTMLElement;
  /**
   * Where a `stick`-anchored hint hangs. The tray, so the hint sits over the
   * joystick it is about; without one it falls back to `mount` and the css
   * puts it above the tray anyway.
   */
  stickMount?: HTMLElement | null;
  /** The five signals, read per frame (see `HintSignals`). */
  signals(): HintSignals;
  /** Injectable for the tests; the real one is `localStorage`. */
  store?: StorageLike | null;
}

export interface HintsHandle {
  /** Which lesson is on screen — '' when none is. */
  showing(): string;
  /** What it says right now — '' when nothing is up. */
  line(): string;
  phase(): HintPhase;
  /** End the tour, as the skip link does. */
  skip(): void;
  dispose(): void;
}

/**
 * Mount the tour. Knows five booleans and three lines — it never touches the
 * scene, the manager, the camera or the net.
 */
export function installWorldHints(opts: HintsOptions): HintsHandle {
  ensureStyle();

  const store = opts.store === undefined ? defaultStore() : opts.store;
  let state = HINT_START;
  /**
   * A hint on screen, with its own entrance. One ζ ≥ 1 spring on a 0…1
   * PRESENCE: the opacity is that number and the slide is what is left of
   * `SLIDE_PX` — so an entrance and an exit are the same motion in opposite
   * directions and neither can overshoot (TASTE §2.1, confidence 1.00).
   */
  interface Live {
    phase: HintPhase;
    el: HTMLElement;
    row: HTMLElement;
    drift: HTMLElement;
    presence: Spring;
    /** Which way it travels: down (+1) on the way in, up (-1) on the way out. */
    leaving: boolean;
  }
  let shown: Live | null = null;
  /** Hints that are on their way out, still being drawn. */
  const leaving: Live[] = [];
  let last = 0;
  let skipped = false;

  /** Write one hint's presence onto its row. */
  const place = (live: Live): void => {
    const v = Math.max(0, Math.min(1, live.presence.value));
    live.row.style.opacity = v.toFixed(3);
    const off = (1 - v) * SLIDE_PX * (live.leaving ? -1 : 1);
    live.row.style.transform = `translateY(${off.toFixed(2)}px)`;
  };

  const build = (phase: HintPhase): void => {
    const hint = hintFor(phase);
    if (!hint) return;
    const el = document.createElement('div');
    el.className = `world-hint at-${hint.anchor}`;
    el.setAttribute('role', 'status');

    const drift = document.createElement('div');
    drift.className = 'world-hint-drift';
    const row = document.createElement('div');
    row.className = 'world-hint-row';
    const line = document.createElement('span');
    line.className = 'world-hint-line';
    line.textContent = hint.line;

    const skip = document.createElement('a');
    skip.className = 'world-hint-skip';
    skip.href = '#';
    skip.textContent = SKIP_LABEL;
    skip.addEventListener('click', (event) => {
      event.preventDefault();
      end();
    });

    row.append(iconEl(hint.icon), line, skip);
    drift.appendChild(row);
    el.appendChild(drift);
    (hint.anchor === 'stick' ? opts.stickMount ?? opts.mount : opts.mount).appendChild(el);
    const live: Live = {
      phase,
      el,
      row,
      drift,
      presence: new Spring(0, { settleMs: MOTION.secondaryMs }),
      leaving: false,
    };
    // It arrives by sliding UP into place from a little below, never by
    // appearing and never by scaling.
    live.presence.retarget(1);
    place(live);
    shown = live;
  };

  const retire = (): void => {
    if (!shown) return;
    const going = shown;
    shown = null;
    going.leaving = true;
    going.presence.retarget(0);
    leaving.push(going);
  };

  const end = (): void => {
    if (skipped) return;
    skipped = true;
    state = { ...state, phase: 'done' };
    retire();
    markHinted(store);
  };

  const paint = (now: number): void => {
    const dt = last === 0 ? DRAW_INTERVAL_MS : Math.max(0, now - last);
    last = now;

    if (!skipped) {
      const before = state.phase;
      state = stepHints(state, opts.signals(), dt);
      if (state.phase !== before) {
        retire();
        build(state.phase);
        // The tour is over the moment the last hint is retired: a device that
        // has been taught is not taught again (and a reload mid-tour picks it
        // up from wherever it got to, which is the honest place).
        if (hintsFinished(state)) markHinted(store);
      }
    }

    // The drift floor, under whatever is on screen, forever (TASTE §3).
    const d = sampleDrift(now, HINT_SEED, DRIFT_SCALE);
    if (shown) {
      shown.presence.update(dt);
      place(shown);
      shown.drift.style.transform = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;
    }
    // …and the ones on their way out, until they are gone. Off the page only
    // once the slide is over: not before, or a hint would vanish mid-move.
    for (let i = leaving.length - 1; i >= 0; i--) {
      const going = leaving[i]!;
      going.presence.update(dt);
      place(going);
      going.drift.style.transform = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;
      if (going.presence.value <= GONE) {
        going.presence.dispose();
        going.el.remove();
        leaving.splice(i, 1);
      }
    }
  };

  // ── ~30fps loop: own rAF, skipping frames — the readout's arrangement ─────
  let raf = 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    paint(now);
  };
  const start = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    if (raf === 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else {
      // A tab that was away must not hand the machine that whole absence as
      // one step — a hint would be dismissed by a thumb that was never there.
      last = 0;
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  return {
    showing: () => (shown ? shown.phase : ''),
    line: () => (shown ? hintFor(shown.phase)?.line ?? '' : ''),
    phase: () => state.phase,
    skip: end,
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      shown?.presence.dispose();
      shown?.el.remove();
      shown = null;
      for (const going of leaving.splice(0)) {
        going.presence.dispose();
        going.el.remove();
      }
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
    ls.setItem(HINTS_KEY + ':probe', '1');
    return ls;
  } catch {
    return null;
  }
}

/** The same probe, for a caller deciding whether to mount at all. */
export function deviceStore(): StorageLike | null {
  return defaultStore();
}

/** How many lessons there are — the test reads it, and so does nothing else. */
export const HINT_COUNT = HINTS.length;
