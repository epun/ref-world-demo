/**
 * WHAT IS HAPPENING, while the world comes up on a phone.
 *
 * > User ask, 2026-09-17 (mobile): *"there should be better empty/loading
 * > states."*
 *
 * Between the tap on `view world` and the moment somebody's own creature is
 * standing there are four waits, and on a slow link they are long: the room
 * has to be found, the island has to be built (a handset rebuilds four times
 * the land the ground field used to cover — docs/PLAN.md §7), the drawing has
 * to come back off the store, and the shell has to open. Until now all four
 * looked identical from the outside: a bare green field with nothing on it.
 * A person cannot tell that from a broken page, and the one thing they can
 * do about a broken page — reload — is the worst thing to do to a page that
 * is working.
 *
 * So the wait SAYS which wait it is, in one line that changes, driven by the
 * real milestones and never by a timer pretending to be one:
 *
 *   finding the room      → nothing has answered yet
 *   building the island   → the room's feed is up (its socket said so)
 *   waiting for creature  → the first frame has composed, so the land exists
 *                           (`refworld:first-frame`, the mark the slow-network
 *                           pass put on the platform's own timeline —
 *                           src/world/scene.ts)
 *   your creature hatching→ this handset's own id is in the world
 *   …and then it leaves     — the shell has opened and the creature stands
 *
 * THE MARKS, and there are two (TASTE §4 — `icon` + `ruleLine` + `border`):
 * the LINE, in the world view's own type (the same face and size as
 * `.world-say`, the draw hint and the ball readout), and a HAIRLINE RULE
 * under it that FILLS as the milestones pass — the brief's *"reserve a single
 * hairline rule to divide the frame"*, here doing the only job a progress
 * mark can do in a vocabulary with no bars in it. No panel, no card, no
 * shadow, no spinner: a spinner is a fifth mark and it says nothing.
 *
 * THE MOTION. The fill is a ζ ≥ 1 spring (src/motion/spring.ts, where
 * underdamped is unrepresentable), so it can never overshoot the milestone it
 * has reached; the line CROSS-FADES on the settle curve rather than cutting;
 * the ambient drift floor runs under the whole thing, so a page that is
 * genuinely waiting is still never frozen (TASTE §3); and when the creature
 * stands the line SLIDES out (never a pop, never a `scale: 0 → 1`).
 *
 * AND IF THE ROOM NEVER ANSWERS. A blank screen is the failure this replaces,
 * so it must not be the failure it falls back to: after
 * `LOADING_TIMEOUT_MS` — `MOTION.primaryMs` times a derived multiple, never a
 * literal — the line says so in lowercase and a `retry` rule-link appears.
 * The wait goes on underneath: an answer arriving a moment later still moves
 * the line along, because a room that was slow is not a room that is gone.
 *
 * THIS MODULE IS KATAMARI-ONLY (2026-09-15 user ruling, src/world/game.ts) and
 * reached through a DYNAMIC import behind the flag — the same discipline the
 * ball readout is under, so meridian and the public world never carry it.
 *
 * The state machine is a pure function of four booleans at the top of this
 * file, with no DOM in it, so the thing that is actually easy to get wrong —
 * the order, and what a flapping milestone does to it — is pinned in node.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { Spring } from '../motion/spring';
import { sampleDrift } from '../motion/ambient';

// ── pure: the state machine ──────────────────────────────────────────────────

/**
 * The four real milestones, read off the page rather than timed.
 *
 * All four are questions somebody else already answers: the feed's own status
 * callback, the performance timeline, and the creature manager. Nothing here
 * estimates.
 */
export interface LoadingMilestones {
  /** The room's feed is up — its socket reported `on`. */
  reached: boolean;
  /** A frame has composed, so the ground, the water and the scatter exist. */
  built: boolean;
  /** This handset's own id holds something in the world (an egg counts). */
  present: boolean;
  /** …and it is no longer an egg: the shell has opened. */
  standing: boolean;
}

export type LoadingStage = 'room' | 'island' | 'creature' | 'hatch' | 'done';

/** In order. The index into this is the progress. */
export const LOADING_STAGES: readonly LoadingStage[] = [
  'room',
  'island',
  'creature',
  'hatch',
  'done',
] as const;

/**
 * What each wait SAYS. Lowercase, like every string in this world (TASTE §5).
 *
 * `done` says nothing — the line is leaving, and a farewell line would be a
 * fifth thing to read at the exact moment the person finally has a creature
 * to look at.
 */
export const LOADING_LINES: Record<LoadingStage, string> = {
  room: 'finding the room',
  island: 'building the island',
  creature: 'waiting for your creature',
  hatch: 'your creature is hatching',
  done: '',
};

/**
 * Which wait this is.
 *
 * Read from the DEEPEST milestone that has passed rather than the shallowest
 * that has not: a socket that drops after the island is built has not
 * un-built the island, and a line that walked backwards would be the page
 * telling somebody their creature had un-hatched.
 */
export function loadingStage(m: LoadingMilestones): LoadingStage {
  if (m.standing) return 'done';
  if (m.present) return 'hatch';
  if (m.built) return 'creature';
  if (m.reached) return 'island';
  return 'room';
}

/** How full the rule is at this stage, in [0, 1]. */
export function loadingProgress(stage: LoadingStage): number {
  const at = LOADING_STAGES.indexOf(stage);
  const last = LOADING_STAGES.length - 1;
  return at <= 0 ? 0 : at / last;
}

/**
 * How long a room may take to answer before the page admits it. **[D]**
 *
 * `MOTION.primaryMs` times eight. The token is the world's own sense of how
 * long a thing takes (1823ms, TASTE §2.1) and this is the smallest multiple
 * of it that is longer than every wait a working page actually has: the
 * slow-network pass measured a handset's island rebuild at 1944ms and the
 * object library's hold at 90 frames, so a threshold under ~10s would call a
 * working phone broken. Never a literal millisecond count — durations come
 * from motion tokens (CLAUDE.md).
 */
export const TIMEOUT_MULTIPLE = 8;
export const LOADING_TIMEOUT_MS = MOTION.primaryMs * TIMEOUT_MULTIPLE;

/** What it says when nothing has answered for that long. */
export const TIMEOUT_LINE = 'the room is not answering';
/** …and the way out of it. */
export const RETRY_LABEL = 'retry';

/**
 * How long a phone waits for its OWN CREATURE before it is told to draw
 * again. **[D]**
 *
 * `MOTION.primaryMs` times sixteen — twice the room's threshold, about half a
 * minute, and never a literal (CLAUDE.md).
 *
 * > User report, 2026-09-17: *"on mobile there is a bug where a character
 * > can't move when I use the joystick"* — and, the same day, *"i'm also not
 * > seeing the onboarding flow"*.
 *
 * Both of those are one state seen twice. A handset whose drawing belongs to
 * an older GENERATION of the world (the projection has been reset since it
 * drew) has no creature in the world that is running now: the stick steers
 * nothing, because there is nothing of theirs to steer, and the first hint
 * never appears, because it waits for a creature that can be moved. The page
 * used to say `waiting for your creature` forever and leave a dead stick
 * under it.
 *
 * This module cannot ask WHY — the epoch and the generation are the world
 * page's own business (docs/SESSION.md, src/phone/identity.ts) — but it can
 * see that the creature never came, which is the only part a person needs:
 * after this long, say so and offer the pad. A creature that arrives a moment
 * later still clears the line, because the milestone is read per frame.
 */
export const CREATURE_TIMEOUT_MULTIPLE = 16;
export const CREATURE_TIMEOUT_MS = MOTION.primaryMs * CREATURE_TIMEOUT_MULTIPLE;

/** What it says when the creature never arrived. */
export const MISSING_LINE = 'your creature is not in this world';
/** …and the way out of THAT, which is a new drawing rather than a reload. */
export const DRAW_AGAIN_LABEL = 'draw again';

/**
 * Has this page waited too long to be believed?
 *
 * Two waits can time out, and they are the only two that can be waited on
 * forever without anybody's help:
 *
 * - `room` — nothing has answered at all. A retry is honest there;
 * - `creature` — the room and the island are up and this handset's own
 *   creature is not in the world. The way out is the pad, not a reload: a
 *   reload rebuilds the same page and waits for the same absent creature.
 *
 * Every other stage is a page with a creature already standing or hatching,
 * and a way out there would throw away a built island for the sake of a slow
 * store.
 */
export function timedOut(stage: LoadingStage, elapsedMs: number): boolean {
  if (stage === 'room') return elapsedMs >= LOADING_TIMEOUT_MS;
  if (stage === 'creature') return elapsedMs >= CREATURE_TIMEOUT_MS;
  return false;
}

/** Which way out a timed-out stage offers. */
export function timeoutLine(stage: LoadingStage): string {
  return stage === 'creature' ? MISSING_LINE : TIMEOUT_LINE;
}
export function timeoutLabel(stage: LoadingStage): string {
  return stage === 'creature' ? DRAW_AGAIN_LABEL : RETRY_LABEL;
}

/**
 * The mark that means the land exists — written once by the first composed
 * frame (src/world/scene.ts, the slow-network pass). Read rather than
 * re-derived: the page that builds the world is the page that says when.
 */
export const FIRST_FRAME_MARK = 'refworld:first-frame';

/** Is that mark on the timeline yet? False on a platform without one. */
export function terrainBuilt(): boolean {
  try {
    return performance.getEntriesByName?.(FIRST_FRAME_MARK).length > 0;
  } catch {
    return false;
  }
}

// ── the line ─────────────────────────────────────────────────────────────────

/** The rule's length on screen, css px. A measure, not a bar. */
const RULE_PX = 116;
/** Stable seed for this line's drift channel. */
const LOADING_SEED = 73.1;
/** Nominal scale the drift amplitude is a fraction of, px. */
const DRIFT_SCALE = 160;
/** Draw cadence — a line and a rule, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;

const STYLE_ID = 'world-loading-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/*
 * Centred over the world, and NOT a surface over it: no field, no scrim, no
 * card. The world is already coming up behind this and the person should see
 * it arrive (TASTE §4).
 */
.world-loading {
  position: fixed;
  left: 50%;
  top: 44%;
  z-index: 6;
  transform: translate(-50%, -50%);
  display: grid;
  justify-items: center;
  gap: 0.9em;
  color: var(--rw-ink, ${WORLD.ink});
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  text-align: center;
  pointer-events: none;
}
/* The drift layer, on its own element because the slide below owns a
   transform and two cannot share one (TASTE §3). */
.world-loading-drift {
  display: grid;
  justify-items: center;
  gap: 0.9em;
  opacity: 1;
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
/* Out of the way when the creature stands: up and gone, on the settle
   curve. Never a pop, in either direction. */
.world-loading.out .world-loading-drift {
  opacity: 0;
  transform: translateY(-10px);
}
.world-loading-line { white-space: pre-wrap; }
/*
 * The hairline rule, and the part of it that has been earned. The track is
 * the same mark at a lower weight — one rule, read twice, rather than a
 * second kind of thing.
 */
.world-loading-rule {
  position: relative;
  width: ${RULE_PX}px;
  height: 1px;
  border-top: 1px solid var(--rw-muted, ${WORLD.neutral});
}
.world-loading-fill {
  position: absolute;
  left: 0;
  top: -1px;
  height: 0;
  width: 0;
  /* The earned part of the rule is the theme's one accent — ink on the ink style,
     so the shipped rule is unchanged (src/ui/theme.ts). */
  border-top: 1px solid var(--rw-accent, ${WORLD.ink});
}
/* The way out of a room that never answered. A rule under a word, and the
   one thing on this line a thumb can reach. */
.world-loading-retry {
  color: var(--rw-ink, ${WORLD.ink});
  text-decoration: none;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--rw-ink, ${WORLD.ink});
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
  pointer-events: none;
}
.world-loading-retry.in {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
`;
  document.head.appendChild(style);
}

export interface LoadingOptions {
  mount: HTMLElement;
  /**
   * The milestones, read PER FRAME rather than pushed: three of the four are
   * already state somebody else owns (the timeline, the creature manager), and
   * a pushed copy of them would be a second answer that could disagree.
   */
  milestones(): LoadingMilestones;
  /** What `retry` does in the first wait. Defaults to reloading this page. */
  retry?: () => void;
  /**
   * Where the drawing pad is, for a handset whose creature never arrived. The
   * link is a plain `href`, so it is a navigation the person makes and not one
   * the page makes for them — a phone that is simply slow must not be sent
   * away from a creature that is still coming.
   */
  padHref?: string;
  /** Injectable clock, for the timeout in a test. */
  now?: () => number;
}

export interface LoadingHandle {
  el: HTMLElement;
  /** What it says right now — '' once it has left. */
  line(): string;
  stage(): LoadingStage;
  /** How full the rule is, eased. */
  progress(): number;
  /** Is the retry link offered? */
  offeringRetry(): boolean;
  /** Has it slid out? */
  gone(): boolean;
  dispose(): void;
}

/**
 * Mount the loading line. Knows four booleans and nothing else — it never
 * touches the scene, the manager, the camera or the net.
 */
export function installWorldLoading(opts: LoadingOptions): LoadingHandle {
  ensureStyle();

  const el = document.createElement('div');
  el.className = 'world-loading';
  // Spoken, because it changes while nobody is touching anything.
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const drift = document.createElement('div');
  drift.className = 'world-loading-drift';
  const line = document.createElement('div');
  line.className = 'world-loading-line';
  const rule = document.createElement('div');
  rule.className = 'world-loading-rule';
  const fill = document.createElement('div');
  fill.className = 'world-loading-fill';
  rule.appendChild(fill);
  const retry = document.createElement('a');
  retry.className = 'world-loading-retry';
  // Through the attribute, always: the click handler reads it back to tell a
  // real destination from this module's own reload, and a property write that
  // did not reflect would make those two disagree.
  retry.setAttribute('href', '#');
  retry.textContent = RETRY_LABEL;

  drift.append(line, rule, retry);
  el.appendChild(drift);
  opts.mount.appendChild(el);

  const clock = opts.now ?? ((): number => Date.now());
  const startedAt = clock();
  const reload = opts.retry ?? ((): void => window.location.reload());
  const onRetry = (event: Event): void => {
    // The pad link is a real href and is left alone; only the reload is this
    // module's to perform.
    if (retry.getAttribute('href') !== '#') return;
    event.preventDefault();
    reload();
  };
  retry.addEventListener('click', onRetry);

  /*
   * The fill's own motion. One ζ ≥ 1 spring over `MOTION.primaryMs`, on the
   * PROGRESS rather than on a width in pixels, so the same number could drive
   * a rule of any length. It can never overshoot the milestone it has
   * reached, which matters here more than anywhere: a progress mark that
   * went past a stage and came back would be the page lying twice.
   */
  const eased = new Spring(0, { settleMs: MOTION.primaryMs });
  /** The deepest stage seen. Latched: a wait never walks backwards. */
  let deepest = 0;
  let text = '';
  let offering = false;
  let gone = false;
  let last = 0;

  const paint = (now: number): void => {
    const dt = last === 0 ? DRAW_INTERVAL_MS : Math.max(0, now - last);
    last = now;

    const stage = loadingStage(opts.milestones());
    const at = LOADING_STAGES.indexOf(stage);
    if (at > deepest) deepest = at;
    const held = LOADING_STAGES[deepest]!;

    // The drift floor, under everything, forever (TASTE §3) — including a
    // page that has been saying `finding the room` for half a minute.
    const d = sampleDrift(now, LOADING_SEED, DRIFT_SCALE);
    drift.style.transform = gone
      ? `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px) translateY(-10px)`
      : `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;

    if (held === 'done') {
      if (!gone) {
        gone = true;
        text = '';
        el.classList.add('out');
        // The rule finishes filling as it leaves rather than freezing
        // part-drawn: an exit that contradicts itself reads as a bug.
        eased.retarget(1);
        // Off the page once the slide is over — not before, or the line
        // would vanish mid-move, and not never, or a page that is being
        // played would keep a frame loop for a line nobody can see.
        window.setTimeout(() => {
          stop();
          el.remove();
        }, MOTION.secondaryMs);
      }
      eased.update(dt);
      fill.style.width = `${(Math.min(1, eased.value) * RULE_PX).toFixed(2)}px`;
      return;
    }

    const timeout = timedOut(held, clock() - startedAt);
    const next = timeout ? timeoutLine(held) : LOADING_LINES[held];
    if (next !== text) {
      text = next;
      line.textContent = next;
    }
    if (timeout !== offering || (timeout && retry.textContent !== timeoutLabel(held))) {
      offering = timeout;
      retry.classList.toggle('in', timeout);
      // The label and where it goes are the stage's, not this module's mood:
      // a room that never answered gets a retry, a creature that never came
      // gets the pad.
      retry.textContent = timeoutLabel(held);
      const pad = held === 'creature' ? opts.padHref ?? '' : '';
      retry.setAttribute('href', pad === '' ? '#' : pad);
    }

    eased.retarget(loadingProgress(held));
    eased.update(dt);
    fill.style.width = `${(eased.value * RULE_PX).toFixed(2)}px`;
  };

  // ── ~30fps loop: own rAF, skipping frames — the ball readout's arrangement ─
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
      // A tab that was away must not hand the spring that whole absence as
      // one step — the fill would jump, and a jump is a cut (TASTE §2.1).
      last = 0;
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();
  // Paint once now, so the first line is on screen in this frame rather than
  // a thirtieth of a second into the wait it is describing.
  paint(0);

  return {
    el,
    line: () => text,
    stage: () => LOADING_STAGES[deepest]!,
    progress: () => eased.value,
    offeringRetry: () => offering,
    gone: () => gone,
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      retry.removeEventListener('click', onRetry);
      eased.dispose();
      el.remove();
    },
  };
}
