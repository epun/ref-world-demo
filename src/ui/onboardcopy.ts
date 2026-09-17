/**
 * WHAT THE GAME TELLS YOU BEFORE YOU PLAY IT — the copy, and only the copy.
 *
 * > User ask, 2026-09-17 (mobile): *"we should have an onboarding stage to
 * > tell people how to play the game, before they load into the world. i.e.
 * > move with joystick to move character, run into objects to pick them up,
 * > grow your mass as large as you can."*
 *
 * Three lines, in the order the game is learned: how to move, what moving is
 * for, and what the whole thing is about. They live in THIS module, on their
 * own, so the wording can be argued with and edited without anybody opening
 * the layout (src/ui/onboard.ts) — which is the file where a mis-step costs a
 * taste rule rather than a word.
 *
 * Every line is lowercase. The taste has no uppercase anywhere, at confidence
 * 1.00 (TASTE §5), and copy is the one place it gets typed by hand rather
 * than generated.
 *
 * `icon` names a MARK, it does not describe a picture: the layout owns the
 * hand that draws it (the same wavering ring generator the stick, the minimap
 * and the ball readout are drawn with), so a new screen here can only ask for
 * one of the marks that already exist.
 *
 * Pure: no DOM, no three, no tokens. Importable from a test in node.
 */

/** The marks a screen may carry — one small line-drawn icon each (TASTE §4). */
export type OnboardIcon =
  /** The stick: a ring with its knob pushed off centre. */
  | 'stick'
  /** A ball with a stone about to join it. */
  | 'pickup'
  /** A small ring and the big one it becomes. */
  | 'grow';

export interface OnboardScreen {
  /** One line of lowercase copy. */
  line: string;
  icon: OnboardIcon;
}

/**
 * The three screens, in order.
 *
 * One line each on purpose: this is read standing up, on a phone, by
 * somebody who wants to play — a paragraph would be skipped, and the skip
 * link is there for the person who wants to skip anyway.
 */
export const ONBOARD_SCREENS: readonly OnboardScreen[] = [
  { line: 'move with the joystick to roll your creature', icon: 'stick' },
  { line: 'run into things to pick them up', icon: 'pickup' },
  { line: 'grow as big as you can', icon: 'grow' },
] as const;

/** The way past it, for somebody who already knows. */
export const SKIP_LABEL = 'skip';

/** The way in, on the last screen. */
export const START_LABEL = 'start';
