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
 *   .stage-tools    the case      undo·clear·done → hatch → (all idle)
 *   .stage-corner   bottom-right minimap (alive only)
 *
 * The stage now sits inside the device's screen well (docs/DEVICE.md §3)
 * and the tools slot sits on the device's three fixed keys — the ONLY
 * change the device makes to this file. Roles, layering, the swap
 * choreography and the seam are untouched: the device is a frame around
 * them, and if any behaviour changed the wrapper would be wrong.
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
import { mountDevice, type DeviceChrome } from './device';

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
 * Core geometry (PHONE-STAGE §2, restated against the well by DEVICE §3)
 * [D]. The core is a centred square whose SIDE is the only thing that
 * changes between states — it is never animated by scale, so the canvas
 * inside it stays sharp at every frame.
 *
 * The measures are now shares of the SCREEN WELL's WIDTH rather than of the
 * viewport: the stage lives inside the device now, and a viewport measure
 * inside a letterboxed box would drift with the paper margin instead of
 * with the screen. The well is taller than it is wide (DEVICE §3) and the
 * core is square, so width is what bounds it. The RATIOS between the three
 * states are what carry the choreography and they are preserved exactly —
 * 76 : 60 : 80 vmin is 95% : 75% : 100%, the same relative distances the
 * swap has always travelled.
 *
 * `cqw` (the well is the query container — see .stage below) is used rather
 * than a bare `%` so the height side of the square resolves against the
 * same axis as the width and the box can never come out non-square.
 *
 * These strings are binding: the draw page (public/draw/) places against
 * the same DEVICE §3 geometry, so the core is in the same place at the
 * same size on both sides of the page navigation.
 */
export const CORE_SIDE: Record<PhoneState, string> = {
  draw: '95cqw',
  wait: '75cqw',
  alive: '100cqw',
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
  /*
   * One paper for the whole mobile flow (PHONE-STAGE §2) — but the stage
   * does not PAINT it any more: the artwork does.
   *
   * The well in shell.svg is filled with this exact value already, and the
   * page behind the device is too, so painting it again changes no pixel.
   * What it did change was the bezel: DEVICE §3's usable inner area is a
   * RECTANGLE (x 15..85, y 38..124) and the drawn bezel opening has bowed,
   * rounded corners, so the rectangle's four corners fell outside it and
   * an opaque stage cut the bezel's ink at every corner — the frame read
   * as broken. Transparent, the stage can cover nothing: the bezel closes,
   * the glass highlight (DEVICE §1e) shows where no content sits over it,
   * and the paper is still one value from the first frame of /draw/ to the
   * last frame here. The token stays defined for anything that needs to
   * paint the paper itself.
   */
  --stage-paper: ${SURFACE.ground};
  /* Reserved bands. Their height never changes, so the core's centre is
     the exact middle of the box in every state — no relayout. Measured
     against the well now (DEVICE §3), not the viewport: 14% of the well's
     width is the 38px band a 259px core leaves in a 335px-tall well at
     390px wide, which is exactly the air the taller well was cut for. */
  --stage-band: 14cqw;
  --core-side: ${CORE_SIDE.draw};

  /* Absolute inside the device's screen well, which is itself fixed — so
     the stage is the same immovable surface it always was, just smaller
     than the page. It is the query container the core measures against. */
  position: absolute;
  inset: 0;
  container-type: size;
  overflow: hidden;
  box-sizing: border-box;
  background: transparent;
  display: grid;
  grid-template-rows: var(--stage-band) 1fr var(--stage-band);
  justify-items: center;
  align-items: center;
  /* NO padding here. The core has to land in the same place on both sides
     of the /draw/ seam, and both sides place it against the same DEVICE §3
     well. The safe-area insets that used to live on the slots are gone
     with the viewport: the device is sized to contain and centred, so the
     paper margin around it already clears every notch and home bar. */
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
}
/*
 * The tools slot is no longer in the stage's grid: it mounts onto the
 * device's key row (DEVICE §2), because a physical device's controls are
 * on the case, not on the screen. It is still a persistent slot, still a
 * satellite, still animated by the same swap steps — only its address
 * changed. The row line has no height of its own; the keys hang off it.
 */
.stage-tools {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 0;
}
.stage-core {
  /* Centred in the well, out of the grid flow — see the note above. */
  position: absolute;
  inset: 0;
  margin: auto;
  width: var(--core-side);
  height: var(--core-side);
  transition:
    width ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    height ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
/*
 * The corner, measured against the well (DEVICE §3). 19cqw is not a picked
 * number: in the alive state the core is as wide as the well, so the map
 * has only the wheel's free corner to sit in. The emote nearest the
 * bottom-right diagonal has its right edge at
 * (side/2 + 0.4345·(side/2 − 26) + 26), and the map's left edge has to
 * clear it. 19% of the well's width plus the 1% inset does, from a 224px
 * well up. Measured, not asserted — the device probe checks the real rects.
 */
.stage-corner {
  position: absolute;
  right: 1cqw;
  bottom: 1cqw;
  width: 19cqw;
  height: 19cqw;
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
 * Create the device, the stage inside its screen well, and mount the
 * initial state.
 */
export function createMachine(
  root: HTMLElement,
  mounts: Record<PhoneState, ScreenMount>,
  initial: PhoneState = 'draw',
  options: MachineOptions = {},
): PhoneMachine {
  ensureStyle();

  // The frame (docs/DEVICE.md). It owns no state and no timing — it hands
  // back the two places the stage plugs into and is never touched again.
  const device: DeviceChrome = mountDevice(root);

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
    // Three slots are screen; the tools slot is the case's key row
    // (DEVICE §2). Both are inside the device box, so nothing about the
    // slot set, the layering or the swap changes.
    if (name === 'tools') device.keys.appendChild(el);
    else stage.appendChild(el);
  }
  device.well.appendChild(stage);

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
      device.destroy();
    },
  };
}
