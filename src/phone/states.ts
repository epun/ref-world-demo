/**
 * The phone STAGE (docs/PHONE-STAGE.md §2) — one surface, updated.
 *
 * User ruling, 2026-08-18: the companion must not swipe between screens.
 * There is one stage and it never moves; what changes is which elements
 * occupy it. The previous machine translated whole sections by ±100% —
 * that reads as swiping, and it is gone.
 *
 * The stage owns four persistent slots. A slot is always in the DOM; empty
 * is a state of a slot, never a removal (removing one relayouts the stage,
 * and a relayout is a cut — TASTE §2.1, confidence 1.00):
 *
 *   .stage-brow     top          status / countdown / creature name
 *   .stage-core     centre       the ONE object: pad → egg → wheel
 *   .stage-tools    bottom       undo·clear·done → hatch → (empty)
 *   .stage-corner   bottom-right minimap (alive only)
 *
 * A state change is a SWAP, never a translate of the stage:
 *   1. satellites out   opacity 1→0, translateY 0→+8px, t.tertiary
 *   2. core cross-fade   in place, t.secondary, while --core-side travels
 *   3. satellites in    opacity 0→1, translateY +8px→0, t.secondary
 * staggered by STAGGER_MS in reading order. The moves OVERLAP by
 * construction — there is no frame in which both the outgoing and the
 * incoming satellite sit at opacity 0, which is the cut this whole model
 * exists to prevent.
 *
 * The pure pieces (flow order, core measures, the swap timeline) are
 * exported separately so test/phone can cover them without a DOM.
 */

import { sampleDrift } from '../motion/ambient';
import { MOTION, SURFACE } from '../taste/tokens';

export type PhoneState = 'draw' | 'wait' | 'alive';

/** Flow order. Forward is draw → wait → alive; nothing about it is spatial. */
export const PHONE_STATES: readonly PhoneState[] = ['draw', 'wait', 'alive'];

export function stateIndex(state: PhoneState): number {
  return PHONE_STATES.indexOf(state);
}

// ── Slots ───────────────────────────────────────────────────────────────────

export const SLOT_NAMES = ['brow', 'core', 'tools', 'corner'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/**
 * The satellites, in reading order — the stagger order of both moves
 * (PHONE-STAGE §3). The core is not a satellite: it is the fixed point.
 */
export const SATELLITE_SLOTS: readonly SlotName[] = ['brow', 'tools', 'corner'];

/**
 * Core geometry (PHONE-STAGE §2) [D]. The core is a centred square whose
 * SIDE is the only thing that changes between states — it is never animated
 * by scale, so the canvas inside it stays sharp at every frame.
 *
 * These strings are binding: the draw page (public/draw/) sets the same
 * values, so the core is in the same place at the same size on both sides
 * of the page navigation.
 */
export const CORE_SIDE: Record<PhoneState, string> = {
  draw: 'min(76vmin, 480px)',
  wait: 'min(60vmin, 380px)',
  alive: 'min(80vmin, 460px)',
};

/**
 * Stagger between satellites, derived from the token scale rather than
 * picked (PHONE-STAGE §3): t.tertiary / 4 = 114ms.
 */
export const STAGGER_MS = MOTION.tertiaryMs / 4;

/** How far a satellite travels on the way in or out. Entrances SLIDE. */
export const SATELLITE_TRAVEL_PX = 8;

// ── The swap timeline (pure) ────────────────────────────────────────────────

export interface SwapStep {
  slot: SlotName;
  role: 'out' | 'in';
  delayMs: number;
  durationMs: number;
}

/**
 * The schedule of one swap. Satellites leave on t.tertiary staggered from
 * zero; they arrive on t.secondary staggered from STAGGER_MS; the core
 * cross-fades over t.secondary from zero.
 *
 * The invariant this encodes (and test/phone asserts): for every satellite
 * slot the incoming move BEGINS before the outgoing move ENDS, so the slot
 * is never empty on any frame.
 */
export function swapTimeline(): SwapStep[] {
  const steps: SwapStep[] = [
    { slot: 'core', role: 'out', delayMs: 0, durationMs: MOTION.secondaryMs },
    { slot: 'core', role: 'in', delayMs: 0, durationMs: MOTION.secondaryMs },
  ];
  SATELLITE_SLOTS.forEach((slot, index) => {
    steps.push({
      slot,
      role: 'out',
      delayMs: index * STAGGER_MS,
      durationMs: MOTION.tertiaryMs,
    });
    steps.push({
      slot,
      role: 'in',
      delayMs: (index + 1) * STAGGER_MS,
      durationMs: MOTION.secondaryMs,
    });
  });
  return steps;
}

/** When the last move of a swap has finished. */
export function swapDurationMs(): number {
  return swapTimeline().reduce((end, s) => Math.max(end, s.delayMs + s.durationMs), 0);
}

// ── Screens ─────────────────────────────────────────────────────────────────

/** The four layers a screen mounts its parts into — one per slot. */
export type StageSlots = Record<SlotName, HTMLElement>;

/** What a mounted screen hands back to the stage. */
export interface Screen {
  destroy(): void;
}

/** Mounts one screen's parts into the slots it needs. */
export type ScreenMount = (slots: StageSlots) => Screen;

/**
 * How the very first mount arrives.
 *
 * - `settled` — the person was already looking at this state (a restore).
 *   No entrance at all: replaying one reads as a glitch (PHONE-STAGE §4).
 * - `seam` — arriving across the /draw/ → /phone.html navigation. The core
 *   is ALREADY at this state's measure; its content fades up and the
 *   satellites run their in-move. The stage itself never animates.
 */
export type Entrance = 'settled' | 'seam';

export interface MachineOptions {
  entrance?: Entrance;
}

export interface PhoneMachine {
  readonly state: PhoneState;
  goTo(next: PhoneState): void;
  destroy(): void;
}

const STYLE_ID = 'phone-stage-style';

/**
 * [D] Ambient floor reference length. MOTION.ambientAmplitude (0.3%) is a
 * fraction of an element's scale; the stage's scale is the viewport, and
 * 0.3% of a viewport is a visible wander of the one object the eye is
 * holding. The floor is referenced to this length instead — the drift is
 * real and never arrests (TASTE §2.1), while the core's centre stays put
 * to well under the 1px the swap probe allows.
 */
const AMBIENT_REFERENCE_PX = 96;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.stage {
  /* One paper for the whole mobile flow (PHONE-STAGE §2). */
  --stage-paper: ${SURFACE.ground};
  /* Reserved bands. Their height never changes, so the core's centre is
     the exact middle of the padded box in every state — no relayout. */
  --stage-band: clamp(56px, 11vmin, 92px);
  --core-side: ${CORE_SIDE.draw};

  position: fixed;
  inset: 0;
  overflow: hidden;
  box-sizing: border-box;
  background: var(--stage-paper);
  display: grid;
  grid-template-rows: var(--stage-band) 1fr var(--stage-band);
  justify-items: center;
  align-items: center;
  /* NO padding here. The core has to land in the same place on both sides
     of the /draw/ seam, and the draw page centres it on the VIEWPORT. Pad
     the stage instead and the core's centre shifts by (top - bottom) / 2 —
     which is 0 in a headless viewport and 6.5px on a notched handset, so it
     passes every desktop probe and jumps on the actual device. The insets
     live on the slots, exactly as the draw page puts them. */
}
.stage-slot {
  position: relative;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
.stage-brow {
  grid-row: 1;
  width: 100%;
  height: 100%;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0
    env(safe-area-inset-left, 0px);
}
.stage-tools {
  grid-row: 3;
  width: 100%;
  height: 100%;
  padding: 0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px)
    env(safe-area-inset-left, 0px);
}
.stage-core {
  /* Centred on the viewport, out of the grid flow — see the note above. */
  position: absolute;
  inset: 0;
  margin: auto;
  width: var(--core-side);
  height: var(--core-side);
  transition:
    width ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    height ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.stage-corner {
  position: absolute;
  right: calc(env(safe-area-inset-right, 0px) + 4vmin);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 4vmin);
  width: clamp(88px, 24vmin, 160px);
  height: clamp(88px, 24vmin, 160px);
}
/* Layers stack inside a slot so the outgoing and incoming contents overlap
   without ever relayouting the slot. */
.stage-layer {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  will-change: opacity, transform;
}
.stage-layer > * { pointer-events: auto; }
.stage-layer[data-role='out'] { pointer-events: none; }
.stage-layer[data-role='out'] > * { pointer-events: none; }
`;
  document.head.appendChild(style);
}

function makeLayer(slot: SlotName): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'stage-layer';
  layer.dataset['slot'] = slot;
  return layer;
}

interface MountedLayers {
  slots: StageSlots;
  screen: Screen;
}

/** Web Animations is the transport: it exposes getAnimations() to the probe
 * and gives exact delays without a chain of timers. Environments without it
 * (tests, very old engines) get the settled end state, never a cut. */
function canAnimate(el: HTMLElement): boolean {
  return typeof el.animate === 'function';
}

function satelliteKeyframes(role: 'out' | 'in'): Keyframe[] {
  const away: Keyframe = {
    opacity: '0',
    transform: `translateY(${SATELLITE_TRAVEL_PX}px)`,
  };
  const home: Keyframe = { opacity: '1', transform: 'translateY(0px)' };
  return role === 'out' ? [home, away] : [away, home];
}

function coreKeyframes(role: 'out' | 'in'): Keyframe[] {
  // The core never translates and never scales — only its content
  // cross-fades while the box itself travels to the new measure.
  return role === 'out' ? [{ opacity: '1' }, { opacity: '0' }] : [{ opacity: '0' }, { opacity: '1' }];
}

/**
 * Create the stage and mount the initial state.
 */
export function createMachine(
  root: HTMLElement,
  mounts: Record<PhoneState, ScreenMount>,
  initial: PhoneState = 'draw',
  options: MachineOptions = {},
): PhoneMachine {
  ensureStyle();

  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.dataset['state'] = initial;
  // Set before insertion: no previous computed value, so the initial
  // measure can never animate in from somewhere else.
  stage.style.setProperty('--core-side', CORE_SIDE[initial]);

  const slotEls = {} as Record<SlotName, HTMLElement>;
  for (const name of SLOT_NAMES) {
    const el = document.createElement('div');
    el.className = `stage-slot stage-${name}`;
    el.dataset['slot'] = name;
    slotEls[name] = el;
    stage.appendChild(el);
  }
  root.appendChild(stage);

  const mountInto = (state: PhoneState, role: 'out' | 'in'): MountedLayers => {
    const slots = {} as StageSlots;
    for (const name of SLOT_NAMES) {
      const layer = makeLayer(name);
      layer.dataset['role'] = role;
      slotEls[name].appendChild(layer);
      slots[name] = layer;
    }
    return { slots, screen: mounts[state](slots) };
  };

  const releaseLayers = (mounted: MountedLayers): void => {
    mounted.screen.destroy();
    for (const name of SLOT_NAMES) {
      for (const anim of mounted.slots[name].getAnimations?.() ?? []) anim.cancel();
      mounted.slots[name].remove();
    }
  };

  const clearLayerAnimations = (mounted: MountedLayers): void => {
    for (const name of SLOT_NAMES) {
      const layer = mounted.slots[name];
      for (const anim of layer.getAnimations?.() ?? []) anim.cancel();
      layer.style.opacity = '';
      layer.style.transform = '';
      layer.dataset['role'] = 'settled';
      layer.removeAttribute('aria-hidden');
    }
  };

  let state = initial;
  let current = mountInto(initial, 'in');
  /** Cleanup handle for the seam entrance, so a swap can pre-empt it. */
  let entranceTimer = 0;

  // ── The initial entrance ──────────────────────────────────────────────────
  const entrance: Entrance = options.entrance ?? 'settled';
  if (entrance === 'seam') {
    // The seam (PHONE-STAGE §4): the core is already at this measure — its
    // content fades UP into it, and the satellites run their in-move from
    // the pre-entrance offset. Nothing about the stage itself animates.
    for (const name of SLOT_NAMES) {
      const layer = current.slots[name];
      if (!canAnimate(layer)) continue;
      const isCore = name === 'core';
      const index = isCore ? 0 : SATELLITE_SLOTS.indexOf(name);
      layer.animate(isCore ? coreKeyframes('in') : satelliteKeyframes('in'), {
        duration: MOTION.secondaryMs,
        delay: isCore ? 0 : (index + 1) * STAGGER_MS,
        easing: MOTION.settleCurve,
        fill: 'both',
      });
    }
    entranceTimer = window.setTimeout(() => {
      entranceTimer = 0;
      clearLayerAnimations(current);
    }, swapDurationMs());
  } else {
    // A restore: mount the settled state, no entrance at all.
    for (const name of SLOT_NAMES) current.slots[name].dataset['role'] = 'settled';
  }

  // ── The ambient floor ─────────────────────────────────────────────────────
  // It runs under the stage at all times, including mid-swap and including
  // once everything has settled: nothing on this screen ever fully arrests
  // (TASTE §2.1, "abrupt stop" forbidden at confidence 1.00).
  let raf = 0;
  const drive = (now: number): void => {
    raf = requestAnimationFrame(drive);
    const drift = sampleDrift(now, 11.3, AMBIENT_REFERENCE_PX);
    stage.style.transform = `translate3d(${drift.x.toFixed(3)}px, ${drift.y.toFixed(3)}px, 0)`;
  };
  const startFloor = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(drive);
  };
  const stopFloor = (): void => {
    if (raf === 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = (): void => {
    if (document.hidden) stopFloor();
    else startFloor();
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) startFloor();

  // ── Swap ──────────────────────────────────────────────────────────────────
  /** Finishes the in-flight swap immediately (idempotent). */
  let settle: (() => void) | null = null;

  const goTo = (next: PhoneState): void => {
    if (next === state) return;
    settle?.();
    if (entranceTimer !== 0) {
      window.clearTimeout(entranceTimer);
      entranceTimer = 0;
      clearLayerAnimations(current);
    }

    const outgoing = current;
    const incoming = mountInto(next, 'in');

    for (const name of SLOT_NAMES) {
      const layer = outgoing.slots[name];
      layer.dataset['role'] = 'out';
      layer.setAttribute('aria-hidden', 'true');
    }

    // The core travels to the incoming measure over t.secondary. The box is
    // really that size on every frame — no scale, ever.
    stage.style.setProperty('--core-side', CORE_SIDE[next]);
    stage.dataset['state'] = next;

    for (const step of swapTimeline()) {
      const layer = step.role === 'out' ? outgoing.slots[step.slot] : incoming.slots[step.slot];
      if (!canAnimate(layer)) continue;
      const frames =
        step.slot === 'core' ? coreKeyframes(step.role) : satelliteKeyframes(step.role);
      layer.animate(frames, {
        duration: step.durationMs,
        delay: step.delayMs,
        easing: MOTION.settleCurve,
        fill: 'both',
      });
    }

    const finish = (): void => {
      window.clearTimeout(timer);
      settle = null;
      releaseLayers(outgoing);
      clearLayerAnimations(incoming);
    };
    const timer = window.setTimeout(finish, swapDurationMs());
    settle = finish;

    state = next;
    current = incoming;
  };

  return {
    get state(): PhoneState {
      return state;
    },
    goTo,
    destroy(): void {
      settle?.();
      if (entranceTimer !== 0) window.clearTimeout(entranceTimer);
      stopFloor();
      document.removeEventListener('visibilitychange', onVisibility);
      current.screen.destroy();
      stage.remove();
    },
  };
}
