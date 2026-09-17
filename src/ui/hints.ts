/**
 * HOW TO PLAY, WHILE PLAYING — the contextual hints on the world view.
 *
 * > User ask, 2026-09-17, from a three-screen mock: *"For mobile I want the
 * > onboarding to be contextual within the device"* — and, with the mock in
 * > hand, *"retain our existing style for components"*.
 *
 * Three labels, one at a time, CENTRED in the screen over the live world, each
 * dismissed by DOING what it says. That is the difference between being told
 * how to play and being taught:
 *
 *   move      `move using the joystick`, and the stick wears four hairline
 *             chevrons while it is up so a person who has never seen a stick
 *             can see that it is one. Gone once the thumb has HELD it past the
 *             stick's own deadzone for `DRIVE_HELD_MS` — the first real drive
 *             intent rather than a brush against the glass — and the chevrons
 *             go with it;
 *   pickup    `roll over objects to collect`, once the creature has travelled
 *             `MOVE_UNITS`, so it arrives to somebody already rolling. Gone on
 *             their first pickup;
 *   grow      `become the biggest`, from that first pickup. Gone on the next
 *             one, or after `GROW_MS` for somebody taking their time.
 *
 * Then nothing, forever: the flag is written and this device is done being
 * taught. There is no skip control and no progress dots — the mock has
 * neither, and a step that dismisses itself on the action it teaches does not
 * need a way out.
 *
 * THE MARKS. The mock draws the label as a grey filled pill with a drop
 * shadow. That is NOT what ships: *"retain our existing style"* means this
 * project's own marks, so the label is
 *
 * - PAPER INSIDE THE PROJECT'S WAVERING HAND-DRAWN HAIRLINE — the same
 *   generator, smoothing, inset expression and 1.25 hairline as the join code,
 *   the minimap and the projection's leaderboard (`wavyBorderPoints` +
 *   `wavyBorderPath` off src/phone/minimap.ts, `mapBorderInset(mapMarkScale)`
 *   for the inset). The paper is the recorded USER OVERRIDE of §4's "no filled
 *   panels" — docs/TASTE.md §9a, 2026-09-17: three things on the world view
 *   stand on paper inside that hairline, and nothing else comes with it. No
 *   shadow, no radius, no second fill — a css box would also be a rectangle,
 *   and nothing in this world is rectilinear (TASTE §2.5), which is why the
 *   shape is a drawn path and not a border;
 * - the LINE, in the world view's own type — the same face and size as the
 *   ball readout, `.world-say` and the draw hint, because this is another line
 *   of the world's own chrome and a second face here would be a second voice.
 *   Lowercase throughout (TASTE §5); the copy is a table in
 *   src/ui/hintcopy.ts so it can be edited without touching this file;
 * - the CHEVRONS, hairline strokes on the stick's own ring and nothing else:
 *   four arrow marks, no fill, no plate under them.
 *
 * THE MOTION. Every entrance and every exit is a ζ ≥ 1 spring
 * (src/motion/spring.ts, where underdamped is unrepresentable), written per
 * frame as an opacity and a translate — in from a little below, out upwards.
 * Measured reason for not using a css transition: on the built page the
 * class-driven one never ran at all, and the row sat at opacity 0 with its
 * class applied for as long as it was up. Never a `scale: 0 → 1` (TASTE §2.1,
 * confidence 1.00), and the ambient drift floor runs under whatever is on
 * screen (TASTE §3).
 *
 * NOTHING SHOWS WHILE THE WORLD IS STILL COMING UP. The loading line owns the
 * screen until this handset's own creature is standing (src/ui/loading.ts),
 * and a label about a joystick over `finding the room` would be two voices
 * about two different things.
 *
 * SEEN ONCE PER DEVICE, under `refworld:hinted`, wrapped in try/catch like
 * every store read in this project; `?hints=1` re-shows them for testing on a
 * real phone.
 *
 * KATAMARI-ONLY and reached through a DYNAMIC import behind the flag, like the
 * ball readout and the loading line: there is no stick, no pickup and no ball
 * in a world without the game, so every word here would be a lie about it, and
 * no other deployment carries the chunk.
 *
 * The state machine is a pure function of five signals, with no DOM in it, so
 * what is actually easy to get wrong — the order, and what dismisses what — is
 * pinned in node.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { Spring } from '../motion/spring';
import { sampleDrift } from '../motion/ambient';
import {
  mapBorderInset,
  mapMarkScale,
  wavyBorderPath,
  wavyBorderPoints,
} from '../phone/minimap';
import { DEADZONE } from '../world/joystick';
import type { StorageLike } from '../phone/identity';
import { HINTS, hintFor, showsArrows } from './hintcopy';

// ── pure: seen once per device ───────────────────────────────────────────────

/**
 * The flag's key.
 *
 * Not the slideshow's `refworld:onboarded`: a phone that was taught by the
 * screens has not been taught by these, and the whole reason the hints exist
 * is that the screens did not teach anybody (2026-09-17). Namespaced like
 * every other key this project writes.
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
 * Every one of these is read through a seam that already exists — the creature
 * manager's own answers and the stick's own vector (src/main.ts) — so none of
 * it is a second event path.
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

/** `none` and `moved` show nothing; the other three are the three labels. */
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
 * How far the creature travels before the second label arrives, world units.
 * **[D]** Five is a couple of its own body lengths at the size it hatches —
 * far enough that the person is rolling rather than nudging, close enough that
 * the props it should be rolling over are still the ones around it.
 */
export const MOVE_UNITS = 5;

/**
 * How long the last label stays if nothing else happens. **[D]** Three
 * `MOTION.primaryMs`: long enough to read twice, and it is the only one of the
 * three with no action of its own to be dismissed by — "become the biggest" is
 * the whole rest of the game.
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
      // lesson is about what to drive OVER.
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

// ── pure: the label's frame ──────────────────────────────────────────────────

/** This label's own hand — not the map's seed, not the leaderboard's. */
const LABEL_SEED = 63.4;

/**
 * The hairline's inset for a box this size.
 *
 * `mapBorderInset(mapMarkScale(min))` — the identical expression the join
 * code, the minimap and the leaderboard's `frameInset` use, so all four
 * hairlines sit the same distance inside their own edges. Written out here
 * rather than imported from src/ui/leaderboard.ts because that module is the
 * projection's and must not be pulled into the handset's chunk; a test pins
 * the two answers equal at every size that matters.
 */
export function labelInset(w: number, h: number): number {
  return mapBorderInset(mapMarkScale(Math.min(w, h)));
}

/**
 * The label's frame, as svg path data: the project's own wavering loop at this
 * size. Deterministic per size and seed, so the same box is the same hand on
 * every device.
 */
export function labelFramePath(w: number, h: number, seed = LABEL_SEED): string {
  if (!(w > 2) || !(h > 2)) return '';
  return wavyBorderPath(wavyBorderPoints(Math.round(w), Math.round(h), labelInset(w, h), seed));
}

// ── pure: the chevrons on the stick ──────────────────────────────────────────

/** The chevron ring's user-space box, so the arrows are computed once. */
export const ARROW_BOX = 100;

/**
 * Where the four chevrons point, and how big they are in that box. **[D]**
 *
 * `out` is how far the chevron's tip sits from the centre and `size` is the
 * half-width of its two strokes. Four marks at the compass points, just
 * outside the stick's own ring (the ring is drawn at radius 44 of the same
 * 100-box, src/world/joystick.ts), so they read as "this thing goes these four
 * ways" without touching the ring itself.
 */
export const ARROW_OUT = 47;
export const ARROW_SIZE = 6.5;

/** The four chevrons as svg path data, one string each. Pure. */
export function arrowPaths(): string[] {
  const c = ARROW_BOX / 2;
  const r = (v: number): string => v.toFixed(2);
  /** One chevron, pointing along (dx, dy): a tip and two strokes back. */
  const chevron = (dx: number, dy: number): string => {
    const tipX = c + dx * ARROW_OUT;
    const tipY = c + dy * ARROW_OUT;
    // Back along the direction, and out to each side of it.
    const backX = tipX - dx * ARROW_SIZE;
    const backY = tipY - dy * ARROW_SIZE;
    const sx = -dy * ARROW_SIZE;
    const sy = dx * ARROW_SIZE;
    return (
      `M ${r(backX + sx)} ${r(backY + sy)} L ${r(tipX)} ${r(tipY)} ` +
      `L ${r(backX - sx)} ${r(backY - sy)}`
    );
  };
  return [chevron(0, -1), chevron(1, 0), chevron(0, 1), chevron(-1, 0)];
}

// ── the layer ────────────────────────────────────────────────────────────────

/** Stable seed for the hint layer's drift channel. */
const HINT_SEED = 86.3;
/** Nominal scale the drift amplitude is a fraction of, px. */
const DRIFT_SCALE = 150;
/** Draw cadence — a line of type, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;
/** How far a label travels as it arrives or leaves, css px. **[D]** */
const SLIDE_PX = 8;
/** Presence under which a leaving mark is off the page for good. **[D]** */
const GONE = 0.01;
/** The paper's padding, css px. **[D]** Air enough that the hairline is a
 * frame around the words rather than an outline of them. */
const LABEL_PAD_PX = 14;
/** Stroke weight on screen, css px — the project's one hairline. */
const HAIRLINE_PX = 1.25;

const STYLE_ID = 'world-hints-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/*
 * THE LABEL, centred in the screen on both axes — the mock's placement, and
 * the one place on a phone that is neither the readout's corner, the tray nor
 * the minimap's. The centring transform lives HERE because the layers below
 * own transforms of their own: drift on one, the spring's slide on the next.
 */
.world-hint {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 31;
  max-width: 78vw;
  color: var(--rw-ink, ${WORLD.ink});
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  text-align: center;
  pointer-events: none;
}
/* The drift layer. Nothing fully arrests (TASTE §3). */
.world-hint-drift { display: block; }
/*
 * The box: paper inside the wavering hairline (docs/TASTE.md §9a — the
 * recorded paper-card ruling the join code, the minimap and the leaderboard
 * already stand in). The fill is the svg path below, never a css background,
 * because the shape is a drawn loop and a css box would be a rectangle.
 */
.world-hint-row {
  position: relative;
  display: block;
  box-sizing: border-box;
  padding: ${LABEL_PAD_PX}px ${LABEL_PAD_PX + 4}px;
  opacity: 0;
}
.world-hint-frame {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}
.world-hint-paper {
  fill: var(--rw-light, ${WORLD.light});
  stroke: var(--rw-ink, ${WORLD.ink});
  stroke-width: ${HAIRLINE_PX};
  stroke-linejoin: round;
}
/* The words, over their own paper. */
.world-hint-line {
  position: relative;
  display: block;
  white-space: nowrap;
}
/*
 * THE CHEVRONS, on the stick's own box: four hairline arrow marks just outside
 * its ring, and nothing else — no plate, no fill, no ring of their own (the
 * stick already draws one).
 */
.world-hint-arrows {
  position: absolute;
  inset: -13%;
  display: block;
  overflow: visible;
  pointer-events: none;
  opacity: 0;
}
.world-hint-arrow {
  fill: none;
  stroke: var(--rw-ink, ${WORLD.ink});
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
`;
  document.head.appendChild(style);
}

export interface HintsOptions {
  /** Where the centred label hangs — normally `document.body`. */
  mount: HTMLElement;
  /**
   * The joystick's own element, so the chevrons can sit on its ring while the
   * first label is up. Without one the label still shows and the chevrons
   * simply do not (a page with no stick has nothing to point at).
   */
  stickEl?: HTMLElement | null;
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
  /** Are the stick's chevrons on screen? */
  arrows(): boolean;
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
   * A mark on screen, with its own entrance. One ζ ≥ 1 spring on a 0…1
   * PRESENCE: the opacity is that number and the slide is what is left of
   * `SLIDE_PX` — so an entrance and an exit are the same motion in opposite
   * directions and neither can overshoot (TASTE §2.1, confidence 1.00).
   */
  interface Live {
    phase: HintPhase;
    el: HTMLElement;
    /** The element the presence is written onto. */
    row: HTMLElement;
    /** The drift layer, or null for the chevrons (they drift with the stick). */
    drift: HTMLElement | null;
    presence: Spring;
    leaving: boolean;
    /** Redraw the frame at its real size, if it has one. */
    resize?: () => void;
  }
  let shown: Live | null = null;
  let arrows: Live | null = null;
  const leaving: Live[] = [];

  let last = 0;

  /** Write one mark's presence onto its row. */
  const place = (live: Live): void => {
    const v = Math.max(0, Math.min(1, live.presence.value));
    live.row.style.opacity = v.toFixed(3);
    if (live.drift === null) return; // the chevrons do not slide; they fade
    const off = (1 - v) * SLIDE_PX * (live.leaving ? -1 : 1);
    live.row.style.transform = `translateY(${off.toFixed(2)}px)`;
  };

  /** Build the centred label for a phase that has one. */
  const build = (phase: HintPhase): void => {
    const hint = hintFor(phase);
    if (!hint) return;

    const el = document.createElement('div');
    el.className = 'world-hint';
    el.setAttribute('role', 'status');

    const drift = document.createElement('div');
    drift.className = 'world-hint-drift';
    const row = document.createElement('div');
    row.className = 'world-hint-row';

    const frame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    frame.setAttribute('class', 'world-hint-frame');
    frame.setAttribute('aria-hidden', 'true');
    const paper = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    paper.setAttribute('class', 'world-hint-paper');
    frame.appendChild(paper);

    const line = document.createElement('span');
    line.className = 'world-hint-line';
    line.textContent = hint.line;

    row.append(frame, line);
    drift.appendChild(row);
    el.appendChild(drift);
    opts.mount.appendChild(el);

    /** Redraw the wavering frame at the box's real size. Idempotent. */
    let drawnAt = '';
    const resize = (): void => {
      const w = Math.round(row.offsetWidth);
      const h = Math.round(row.offsetHeight);
      if (w < 3 || h < 3) return;
      const key = `${w}x${h}`;
      if (key === drawnAt) return;
      drawnAt = key;
      frame.setAttribute('viewBox', `0 0 ${w} ${h}`);
      paper.setAttribute('d', labelFramePath(w, h));
    };
    resize();

    const live: Live = {
      phase,
      el,
      row,
      drift,
      presence: new Spring(0, { settleMs: MOTION.secondaryMs }),
      leaving: false,
      resize,
    };
    live.presence.retarget(1);
    place(live);
    shown = live;
  };

  /** Put the four chevrons on the stick, or take them off again. */
  const setArrows = (on: boolean): void => {
    if (on) {
      if (arrows || !opts.stickEl) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'world-hint-arrows');
      svg.setAttribute('viewBox', `0 0 ${ARROW_BOX} ${ARROW_BOX}`);
      svg.setAttribute('aria-hidden', 'true');
      for (const d of arrowPaths()) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'world-hint-arrow');
        path.setAttribute('d', d);
        svg.appendChild(path);
      }
      opts.stickEl.appendChild(svg);
      const live: Live = {
        phase: 'move',
        el: svg as unknown as HTMLElement,
        row: svg as unknown as HTMLElement,
        drift: null,
        presence: new Spring(0, { settleMs: MOTION.secondaryMs }),
        leaving: false,
      };
      live.presence.retarget(1);
      place(live);
      arrows = live;
      return;
    }
    if (!arrows) return;
    const going = arrows;
    arrows = null;
    going.leaving = true;
    going.presence.retarget(0);
    leaving.push(going);
  };

  const retire = (): void => {
    if (!shown) return;
    const going = shown;
    shown = null;
    going.leaving = true;
    going.presence.retarget(0);
    leaving.push(going);
  };

  const paint = (now: number): void => {
    const dt = last === 0 ? DRAW_INTERVAL_MS : Math.max(0, now - last);
    last = now;

    const before = state.phase;
    state = stepHints(state, opts.signals(), dt);
    if (state.phase !== before) {
      retire();
      build(state.phase);
      setArrows(showsArrows(state.phase));
      // The tour is over the moment the last label is retired: a device that
      // has been taught is not taught again (and a reload mid-tour picks it up
      // from wherever it got to, which is the honest place).
      if (hintsFinished(state)) markHinted(store);
    }

    // The drift floor, under whatever is on screen, forever (TASTE §3).
    const d = sampleDrift(now, HINT_SEED, DRIFT_SCALE);
    const driftTo = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;
    if (shown) {
      shown.presence.update(dt);
      place(shown);
      shown.resize?.();
      if (shown.drift) shown.drift.style.transform = driftTo;
    }
    if (arrows) {
      arrows.presence.update(dt);
      place(arrows);
    }
    // …and the ones on their way out, until they are gone. Off the page only
    // once the slide is over: not before, or a mark would vanish mid-move.
    for (let i = leaving.length - 1; i >= 0; i--) {
      const going = leaving[i]!;
      going.presence.update(dt);
      place(going);
      if (going.drift) going.drift.style.transform = driftTo;
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
      // one step — a label would be dismissed by a thumb that was never there.
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
    arrows: () => arrows !== null,
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      shown?.presence.dispose();
      shown?.el.remove();
      shown = null;
      arrows?.presence.dispose();
      arrows?.el.remove();
      arrows = null;
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
