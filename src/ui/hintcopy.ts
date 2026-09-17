/**
 * WHAT THE GAME TELLS YOU WHILE YOU PLAY IT — the copy, and only the copy.
 *
 * > User ask, 2026-09-17, from a three-screen mock: *"For mobile I want the
 * > onboarding to be contextual within the device"*, and with the mock,
 * > *"retain our existing style for components"*.
 *
 * Three labels, in the order the game is learned, each one CENTRED in the
 * screen over the live world and each dismissed by DOING what it says. The
 * wording is the mock's, to the letter — it is shorter than the copy that
 * preceded it and it stays shorter: this is read once, standing up, by
 * somebody whose thumb is already on the glass.
 *
 * They live in THIS module, on their own, so the wording can be argued with
 * and edited without anybody opening the layout (src/ui/hints.ts) — which is
 * the file where a mis-step costs a taste rule rather than a word.
 *
 * Every line is lowercase. The taste has no uppercase anywhere, at confidence
 * 1.00 (TASTE §5), and copy is the one place it gets typed by hand.
 *
 * `arrows` is the one mark a step may ask for beyond its own label: four
 * hairline chevrons around the joystick's ring, so a person who has never
 * seen a stick can see that it is one. It is a request for a mark the layout
 * owns, not a picture described here.
 *
 * Pure: no DOM, no three, no tokens. Importable from a test in node.
 */

/** The lesson this hint teaches — and the order they are learned in. */
export type HintStage = 'move' | 'pickup' | 'grow';

export interface Hint {
  stage: HintStage;
  /** One short line of lowercase copy, centred on screen. */
  line: string;
  /**
   * Does the joystick wear its four directional chevrons while this step is
   * up? Only the first one does, and they go when it is done.
   */
  arrows?: true;
}

/** The three labels, in the order the game is learned. */
export const HINTS: readonly Hint[] = [
  { stage: 'move', line: 'move using the joystick', arrows: true },
  { stage: 'pickup', line: 'roll over objects to collect' },
  { stage: 'grow', line: 'become the biggest' },
] as const;

/** The one hint by its stage, or null for a stage that shows nothing. */
export function hintFor(stage: string): Hint | null {
  return HINTS.find((h) => h.stage === stage) ?? null;
}

/** Does this stage put the chevrons on the stick? */
export function showsArrows(stage: string): boolean {
  return hintFor(stage)?.arrows === true;
}
