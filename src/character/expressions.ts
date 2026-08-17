/**
 * Expressions — the character's entire emotional range as uniform parameter
 * sets (PLAN §3.4). The eye shape is a 2D SDF evaluated in the fragment
 * shader; these four scalars are its only inputs, so an expression IS a
 * point in this space and emoting is moving between points. The brief's
 * vocabulary — dots, crescents, cutout ovals, closed lines, angry wedges —
 * all live on these axes.
 *
 * Pure module: no Three.js, no DOM. The Springs that glide between these
 * live in eyes.ts; here it's just data and math.
 */

export interface Expression {
  /** Vertical extent: 0 closed line … 1 wide open. */
  openness: number;
  /** Crescent bend: -1 sad (lower crescent) … 0 round … +1 happy (upper crescent). */
  curve: number;
  /** Angry inner-brow cut: 0 none … 1 full angled notch on the inner side. */
  wedge: number;
  /** Relative mark scale. 1 = the placement-derived size. */
  size: number;
}

/** Parameter bounds, exported for tests and dev-panel sliders. */
export const EXPRESSION_BOUNDS = {
  openness: [0, 1],
  curve: [-1, 1],
  wedge: [0, 1],
  size: [0.5, 1.4],
} as const;

/**
 * The emote set (PLAN §6.3). Values chosen to read at small scale — the
 * character renders tiny, so every expression leans on one dominant axis
 * rather than a subtle blend:
 *
 * - neutral    round dot, slightly relaxed — the resting mark.
 * - happy      full upper crescent, a touch wider — the ∩∩ smile-eyes.
 * - sad        lower crescent, slightly smaller — everything droops.
 * - sleepy     heavy lids: openness collapsed near a line, a hint of droop.
 * - angry      the inner-brow wedge carries it, with a slight downward bend.
 * - surprised  wide + larger — the only expression that grows the mark.
 */
export const EXPRESSIONS = {
  neutral: { openness: 0.72, curve: 0, wedge: 0, size: 1 },
  happy: { openness: 0.85, curve: 0.9, wedge: 0, size: 1.05 },
  sad: { openness: 0.7, curve: -0.85, wedge: 0, size: 0.92 },
  sleepy: { openness: 0.14, curve: -0.2, wedge: 0, size: 1 },
  angry: { openness: 0.62, curve: -0.3, wedge: 0.9, size: 0.95 },
  surprised: { openness: 1, curve: 0, wedge: 0, size: 1.3 },
} as const satisfies Record<string, Expression>;

export type ExpressionName = keyof typeof EXPRESSIONS;

export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS) as ExpressionName[];

/** Linear blend between two expressions. t = 0 → a, t = 1 → b. */
export function lerpExpression(a: Expression, b: Expression, t: number): Expression {
  return {
    openness: a.openness + (b.openness - a.openness) * t,
    curve: a.curve + (b.curve - a.curve) * t,
    wedge: a.wedge + (b.wedge - a.wedge) * t,
    size: a.size + (b.size - a.size) * t,
  };
}

/** Resolve a name-or-literal into an Expression. */
export function resolveExpression(e: ExpressionName | Expression): Expression {
  return typeof e === 'string' ? EXPRESSIONS[e] : e;
}
