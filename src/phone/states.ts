/**
 * The phone's three-state machine (PLAN §6): draw → wait → alive.
 *
 * Transitions SLIDE — the outgoing screen translates out while the incoming
 * translates in, both visible mid-flight, over MOTION.secondaryMs on the
 * settle curve. There is never a cut (TASTE §2.1, confidence 1.00).
 *
 * Screens are DOM sections stacked inside a root container. The machine owns
 * the sections and the slide; each screen owns its own content and cleanup.
 * The pure pieces (state order, slide direction) are exported separately so
 * test/phone can cover them without a DOM.
 */

import { MOTION } from '../taste/tokens';

export type PhoneState = 'draw' | 'wait' | 'alive';

/** Flow order. Forward transitions slide in from the right. */
export const PHONE_STATES: readonly PhoneState[] = ['draw', 'wait', 'alive'];

export function stateIndex(state: PhoneState): number {
  return PHONE_STATES.indexOf(state);
}

/**
 * Slide direction for a transition: +1 → the incoming screen enters from the
 * right (forward through the flow), -1 → from the left, 0 → no move.
 */
export function slideDelta(from: PhoneState, to: PhoneState): -1 | 0 | 1 {
  const d = stateIndex(to) - stateIndex(from);
  if (d === 0) return 0;
  return d > 0 ? 1 : -1;
}

/** What a mounted screen hands back to the machine. */
export interface Screen {
  destroy(): void;
}

/** Mounts one screen's content into a machine-owned section. */
export type ScreenMount = (section: HTMLElement) => Screen;

export interface PhoneMachine {
  readonly state: PhoneState;
  goTo(next: PhoneState): void;
  destroy(): void;
}

const STYLE_ID = 'phone-states-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.phone-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
}
.phone-screen {
  position: absolute;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  will-change: transform;
}
`;
  document.head.appendChild(style);
}

/**
 * Create the machine and mount the initial state (no entrance slide on
 * boot — the page load is the entrance).
 */
export function createMachine(
  root: HTMLElement,
  mounts: Record<PhoneState, ScreenMount>,
  initial: PhoneState = 'draw',
): PhoneMachine {
  ensureStyle();
  root.classList.add('phone-root');

  const makeSection = (): HTMLElement => {
    const el = document.createElement('section');
    el.className = 'phone-screen';
    return el;
  };

  let state = initial;
  let section = makeSection();
  root.appendChild(section);
  let screen = mounts[initial](section);

  /** Finishes the in-flight slide immediately (idempotent). */
  let settle: (() => void) | null = null;

  const goTo = (next: PhoneState): void => {
    if (next === state) return;
    settle?.();

    const dir = slideDelta(state, next);
    const outSection = section;
    const outScreen = screen;

    const inSection = makeSection();
    inSection.style.transform = `translateX(${dir * 100}%)`;
    root.appendChild(inSection);
    const inScreen = mounts[next](inSection);

    // Commit the entrance offset before the slide starts.
    void inSection.offsetWidth;

    const slide = `transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve}`;
    inSection.style.transition = slide;
    outSection.style.transition = slide;
    inSection.style.transform = 'translateX(0)';
    outSection.style.transform = `translateX(${dir * -100}%)`;

    const finish = (): void => {
      settle = null;
      window.clearTimeout(timer);
      outScreen.destroy();
      outSection.remove();
      inSection.style.transition = '';
    };
    const timer = window.setTimeout(finish, MOTION.secondaryMs + 80);
    settle = finish;

    state = next;
    section = inSection;
    screen = inScreen;
  };

  return {
    get state(): PhoneState {
      return state;
    },
    goTo,
    destroy(): void {
      settle?.();
      screen.destroy();
      section.remove();
      root.classList.remove('phone-root');
    },
  };
}
