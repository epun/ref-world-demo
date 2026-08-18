/**
 * Expressions — the character's entire emotional range as uniform parameter
 * sets (PLAN §3.4). The eye shape is a 2D SDF evaluated in the fragment
 * shader; these scalars are its only inputs, so an expression IS a point in
 * this space and emoting is moving between points. The brief's vocabulary —
 * dots, crescents, cutout ovals, closed lines, angry wedges — all live on
 * these axes.
 *
 * THE PUPIL IS THE FACE (docs/taste/character.md: "eyes are always the
 * expressive anchor"; the reference sheet's deadpan comes from an off-centre
 * glancing pupil). So an expression carries not just a lid shape but where
 * the pupil rides inside it: `pupilX` / `pupilY` are the pupil's resting
 * centre in LID SPACE (q-space — the frame the shader evaluates the SDF in,
 * where the mark is a disc of radius MARK_R and the lids are circles cutting
 * into it), `pupilScale` its relative size, `wander` how much of the ambient
 * gaze drift survives the expression.
 *
 * That the pupil stays LEGIBLE is a hard rule, not a hope: `eyeAperture`
 * derives the vertical slot the lids actually leave open at a given x, and
 * `clampPupil` keeps the pupil centre inside it. A happy crescent or an
 * angry wedge can no longer swallow the pupil — the pupil rides the lid
 * instead. Sleepy is the one exception the geometry allows: its lid comes
 * down on `openness`, which squashes the whole mark (pupil included) rather
 * than cutting it away — eyes closing IS the expression.
 *
 * Pure module: no Three.js, no DOM. The Springs that glide between these
 * live in eyes.ts; here it's just data and math.
 */

/** Radius of the visible mark inside the unit projection frame, at size 1.
 * The shader bakes this constant into its SDF; the aperture math below is
 * the CPU twin of that same geometry. */
export const MARK_R = 0.62;

/** Pupil radius as a fraction of MARK_R, at pupilScale 1. */
export const PUPIL_FRAC = 0.44;

/** Radius of the crescent cutter circle (the lid). */
export const LID_CUT_R = 0.75;

/**
 * How far inside the open slot the pupil's centre is held, as a fraction of
 * the pupil radius. Above 0 so a lid edge never lands exactly on the pupil
 * centre (which would halve it); well below 1 so a lid may still overlap the
 * pupil's rim — that overlap is the expression.
 */
export const PUPIL_MARGIN = 0.35;

export interface Expression {
  /** Vertical extent: 0 closed line … 1 wide open. */
  openness: number;
  /** Crescent bend: -1 sad (lower crescent) … 0 round … +1 happy (upper crescent). */
  curve: number;
  /** Angry inner-brow cut: 0 none … 1 full angled notch on the inner side. */
  wedge: number;
  /** Relative mark scale. 1 = the placement-derived size. */
  size: number;
  /** Pupil resting centre, lid-space x. Negative left, positive right. */
  pupilX?: number;
  /** Pupil resting centre, lid-space y. Negative down-cast, positive raised. */
  pupilY?: number;
  /** Pupil radius multiplier. Small pupil in a wide eye reads as shock. */
  pupilScale?: number;
  /** Ambient gaze-drift amplitude multiplier. Never 0 — nothing arrests. */
  wander?: number;
}

/** An expression with every optional field resolved. */
export type ResolvedExpression = Required<Expression>;

/** Defaults for the pupil fields, so a bare four-scalar Expression stays valid. */
export const EXPRESSION_DEFAULTS = {
  pupilX: 0,
  pupilY: 0,
  pupilScale: 1,
  wander: 1,
} as const;

/** Parameter bounds, exported for tests and dev-panel sliders. */
export const EXPRESSION_BOUNDS = {
  openness: [0, 1],
  curve: [-1, 1],
  wedge: [0, 1],
  size: [0.5, 1.4],
  pupilX: [-0.5, 0.5],
  pupilY: [-0.5, 0.5],
  pupilScale: [0.5, 1.4],
  wander: [0.2, 1.5],
} as const;

/**
 * The emote set (PLAN §6.3). Values chosen to read at small scale — the
 * character renders tiny, so every expression leans on one dominant axis
 * rather than a subtle blend — and every one of them keeps the pupil in
 * shot:
 *
 * - neutral    round dot, slightly relaxed — the resting mark.
 * - happy      the lower lid lifts into a crescent and the pupil rides UP
 *              into what's left. The crescent is deliberately shy of the
 *              full ∩ so the pupil still has a slot to sit in.
 * - sad        the upper lid comes down and the pupil casts DOWN under it.
 * - sleepy     heavy lids: openness collapsed near a line, a hint of droop,
 *              the pupil sinking. The one expression allowed to close.
 * - angry      the inner-brow wedge carries it, pupil low and bored-in under
 *              the brow, slightly smaller — concentrated.
 * - surprised  wide + larger, with a SMALL pupil and the wander nearly off:
 *              a fixed stare in a big eye.
 */
export const EXPRESSIONS = {
  neutral: {
    openness: 0.72,
    curve: 0,
    wedge: 0,
    size: 1,
    pupilX: 0,
    pupilY: 0,
    pupilScale: 1,
    wander: 1,
  },
  happy: {
    openness: 0.85,
    curve: 0.58,
    wedge: 0,
    size: 1.05,
    pupilX: 0,
    pupilY: 0.2,
    pupilScale: 1,
    wander: 0.75,
  },
  sad: {
    openness: 0.7,
    curve: -0.62,
    wedge: 0,
    size: 0.92,
    pupilX: 0,
    pupilY: -0.26,
    pupilScale: 1,
    wander: 0.7,
  },
  sleepy: {
    openness: 0.14,
    curve: -0.2,
    wedge: 0,
    size: 1,
    pupilX: 0,
    pupilY: -0.16,
    pupilScale: 1,
    wander: 1.1,
  },
  angry: {
    openness: 0.58,
    curve: -0.3,
    wedge: 0.82,
    size: 0.95,
    pupilX: 0,
    pupilY: -0.1,
    pupilScale: 0.9,
    wander: 0.45,
  },
  surprised: {
    openness: 1,
    curve: 0,
    wedge: 0,
    size: 1.3,
    pupilX: 0,
    pupilY: 0.02,
    pupilScale: 0.74,
    wander: 0.3,
  },
} as const satisfies Record<string, ResolvedExpression>;

export type ExpressionName = keyof typeof EXPRESSIONS;

export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS) as ExpressionName[];

/** Fill in the optional pupil fields. */
export function normalizeExpression(e: Expression): ResolvedExpression {
  return {
    openness: e.openness,
    curve: e.curve,
    wedge: e.wedge,
    size: e.size,
    pupilX: e.pupilX ?? EXPRESSION_DEFAULTS.pupilX,
    pupilY: e.pupilY ?? EXPRESSION_DEFAULTS.pupilY,
    pupilScale: e.pupilScale ?? EXPRESSION_DEFAULTS.pupilScale,
    wander: e.wander ?? EXPRESSION_DEFAULTS.wander,
  };
}

/** Linear blend between two expressions. t = 0 → a, t = 1 → b. */
export function lerpExpression(a: Expression, b: Expression, t: number): ResolvedExpression {
  const ra = normalizeExpression(a);
  const rb = normalizeExpression(b);
  const mix = (x: number, y: number): number => x + (y - x) * t;
  return {
    openness: mix(ra.openness, rb.openness),
    curve: mix(ra.curve, rb.curve),
    wedge: mix(ra.wedge, rb.wedge),
    size: mix(ra.size, rb.size),
    pupilX: mix(ra.pupilX, rb.pupilX),
    pupilY: mix(ra.pupilY, rb.pupilY),
    pupilScale: mix(ra.pupilScale, rb.pupilScale),
    wander: mix(ra.wander, rb.wander),
  };
}

/** Resolve a name-or-literal into an Expression. */
export function resolveExpression(e: ExpressionName | Expression): Expression {
  return typeof e === 'string' ? EXPRESSIONS[e] : e;
}

/** The open vertical slot the lids leave, in lid space, at a given x. */
export interface Aperture {
  /** Lowest visible y (the lower lid, or the mark's own rim). */
  lo: number;
  /** Highest visible y (the upper lid / brow wedge, or the rim). */
  hi: number;
}

/**
 * The CPU twin of the shader's lid geometry: given the crescent `curve` and
 * the brow `wedge`, the vertical slot still visible at lid-space x.
 *
 * - the mark itself is a disc of radius MARK_R, so the rim alone allows
 *   |y| ≤ sqrt(MARK_R² − x²);
 * - `curve` > 0 slides a LID_CUT_R circle up from below (happy) — its top
 *   edge at this x is the new floor;
 * - `curve` < 0 slides the same circle down from above (sad) — its bottom
 *   edge is the new ceiling;
 * - `wedge` drops a horizontal brow line, the same one the shader cuts with.
 *
 * At curve = 0 and wedge = 0 the cutters clear the disc entirely and the
 * slot is the whole mark.
 */
export function eyeAperture(curve: number, wedge: number, x = 0): Aperture {
  const rim = Math.sqrt(Math.max(MARK_R * MARK_R - x * x, 0));
  let lo = -rim;
  let hi = rim;
  const amount = Math.abs(curve);
  const cut = Math.sqrt(Math.max(LID_CUT_R * LID_CUT_R - x * x, 0));
  if (curve > 0) {
    lo = Math.max(lo, -(MARK_R + LID_CUT_R - amount) + cut);
  } else if (curve < 0) {
    hi = Math.min(hi, MARK_R + LID_CUT_R - amount - cut);
  }
  // The shader's brow: everything above this line is cut away.
  hi = Math.min(hi, MARK_R * (1.6 - 1.9 * wedge));
  return { lo, hi };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Keep the pupil in shot. Clamps a desired lid-space gaze so the pupil's
 * centre stays inside the open slot (with PUPIL_MARGIN of its radius to
 * spare) and inside the mark's own rim. When the slot is narrower than the
 * margins allow, the pupil is centred in whatever slot there is — clipped
 * top and bottom, but never gone.
 *
 * Continuous in every argument: the clamp bends the pupil's path along a
 * moving lid, it never jumps it (TASTE §2.1 — no hard cuts).
 */
export function clampPupil(
  curve: number,
  wedge: number,
  pupilR: number,
  x: number,
  y: number,
): { x: number; y: number } {
  // Horizontal: the rim may clip the pupil's outer edge (that reads as a
  // hard glance), but never more than half of it.
  const xLimit = Math.max(MARK_R - pupilR * 0.5, 0);
  const cx = clamp(x, -xLimit, xLimit);
  const { lo, hi } = eyeAperture(curve, wedge, cx);
  const margin = pupilR * PUPIL_MARGIN;
  const low = lo + margin;
  const high = hi - margin;
  const cy = low > high ? (lo + hi) / 2 : clamp(y, low, high);
  return { x: cx, y: cy };
}
