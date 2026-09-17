/**
 * WHAT THE GAME TELLS YOU WHILE YOU PLAY IT — the copy, and only the copy.
 *
 * > User ask, 2026-09-17, with three screenshots of the live slides: *"For
 * > mobile I want the onboarding to be contextual within the device."*
 *
 * The three lessons are the ones asked for on 2026-09-17 in the morning —
 * *"move with joystick to move character, run into objects to pick them up,
 * grow your mass as large as you can"* — but they are no longer three grey
 * screens in front of the game. Each one is a hint IN the world view,
 * anchored to the thing it is about, and dismissed by DOING it.
 *
 * They live in THIS module, on their own, so the wording can be argued with
 * and edited without anybody opening the layout (src/ui/hints.ts) — which is
 * the file where a mis-step costs a taste rule rather than a word.
 *
 * Every line is lowercase. The taste has no uppercase anywhere, at confidence
 * 1.00 (TASTE §5), and copy is the one place it gets typed by hand.
 *
 * `icon` names a MARK and `anchor` names a PLACE; neither describes a picture
 * or a coordinate. The layout owns the hand that draws the mark (the same
 * wavering ring generator the stick, the minimap and the ball readout are
 * drawn with) and owns where each anchor is, so a new hint here can only ask
 * for marks and places that already exist.
 *
 * Pure: no DOM, no three, no tokens. Importable from a test in node.
 */

/** The lesson this hint teaches — and the order they are learned in. */
export type HintStage = 'move' | 'pickup' | 'grow';

/** The marks a hint may carry — one small line-drawn icon each (TASTE §4). */
export type HintIcon =
  /** The stick: a ring with its knob pushed off centre. */
  | 'stick'
  /** A ball with a stone about to join it. */
  | 'pickup'
  /** A small ring and the big one it becomes. */
  | 'grow';

/**
 * Where a hint stands. Two places, and both are things already on screen:
 *
 * - `stick` — just above the joystick in the tray, because the sentence is
 *   about the thing directly under it;
 * - `readout` — under the ball-diameter readout at the top left, clear of the
 *   stick and clear of the minimap, so the number the last lesson is about is
 *   the thing it is written beside.
 */
export type HintAnchor = 'stick' | 'readout';

export interface Hint {
  stage: HintStage;
  /** One line of lowercase copy. */
  line: string;
  icon: HintIcon;
  anchor: HintAnchor;
}

/** The three lessons, in the order the game is learned. */
export const HINTS: readonly Hint[] = [
  {
    stage: 'move',
    line: 'move with the joystick to roll your creature',
    icon: 'stick',
    anchor: 'stick',
  },
  {
    stage: 'pickup',
    line: 'run into things to pick them up',
    icon: 'pickup',
    anchor: 'readout',
  },
  {
    stage: 'grow',
    line: 'grow as big as you can',
    icon: 'grow',
    anchor: 'readout',
  },
] as const;

/** The one hint by its stage, or null for a stage that shows nothing. */
export function hintFor(stage: string): Hint | null {
  return HINTS.find((h) => h.stage === stage) ?? null;
}

/** The way past the whole tour, for somebody who already knows. */
export const SKIP_LABEL = 'skip';
