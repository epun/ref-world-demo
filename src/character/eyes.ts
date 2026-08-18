/**
 * The eye (PLAN §3.4) — the character's entire emotional range.
 *
 * The eye is PAINT ON THE BODY, not geometry. Like the marking
 * (./marking.ts), an onBeforeCompile hook chained onto the character
 * material composites the eye SDF into diffuseColor, in a front projection
 * derived from the UNDEFORMED object-space position. No cap mesh floats
 * proud of the surface, so a free-orbit camera never catches a detached
 * light ellipse edge-on: seen from the side or behind, the mark simply
 * fades with the surface normal (the same rim fade the marking uses) and
 * the silhouette stays one solid near-black mass from every angle — the
 * CDG-adjacent knockout read. And because the projection reads the rest
 * position, the mark rides every squash/lean/twist/gait exactly where the
 * vertex shader puts the surface — no CPU anchor tracking at all.
 *
 * The SDF itself is unchanged from the cap era: a base lens squashed
 * vertically by `openness`, bent into an upper/lower crescent by
 * subtracting an offset circle (`curve`), notched by a centered half-plane
 * cut (`wedge` — symmetric anger), with a single solid dark pupil that
 * squashes with the lid and wanders on a slow seeded glance. Fill is
 * CHARACTER.eye inside (pupil in CHARACTER.body), with a ~1.5px fwidth
 * smoothstep edge so the mark stays soft-organic rather than aliased-hard.
 *
 * Expressions GLIDE: each SDF parameter rides its own ζ≥1 Spring (settleMs
 * = MOTION.tertiaryMs), so setExpression never snaps — it retargets, and the
 * springs settle without ever crossing (TASTE §2.1). An idle blink dips
 * openness toward 0 and back over ~2× tertiaryMs on a deterministic schedule
 * derived from the shape itself (plus the identity salt, when the character
 * carries one) — no Math.random, so every device blinks the same character
 * at the same moments.
 *
 * THE PUPIL MOVES, ALWAYS. Its centre is the sum of three layers, all in
 * lid space (the q-space the SDF is evaluated in — see expressions.ts):
 *
 *   1. the EXPRESSION's resting pupil (`pupilX`/`pupilY`) — happy rides up
 *      into the lifted lower lid, sad casts down under the upper one;
 *   2. the EMOTE's gaze script (`setGaze`, driven by emotes.ts keypoints) —
 *      the deliberate movement that reads as the emotion;
 *   3. the AMBIENT gaze drift — the slow seeded wander that never stops,
 *      scaled per expression but never to zero (TASTE §2.1, the floor).
 *
 * Layers 1 and 2 ride one pair of ζ≥1 Springs, so a gaze change glides and
 * is interruptible mid-flight; layer 3 is a smoothstepped drift added on
 * top. The sum is then run through `clampPupil`, which keeps the pupil
 * inside the slot the lids leave open — so no expression can swallow the
 * character's whole face. Sleepy is the exception the geometry allows: it
 * closes on `openness`, which squashes the pupil with the lid rather than
 * cutting it away.
 */

import { Color, Vector2 } from 'three';
import type { IUniform, MeshPhysicalMaterial } from 'three';
import { Spring } from '../motion/spring';
import type { ShapeAnalysis } from '../shape/types';
import { CHARACTER, MOTION } from '../taste/tokens';
import {
  clampPupil,
  EXPRESSIONS,
  MARK_R,
  normalizeExpression,
  PUPIL_FRAC,
  resolveExpression,
  type Expression,
  type ExpressionName,
  type ResolvedExpression,
} from './expressions';
import { computeEyePlacement } from './placement';

/** Frame headroom over the mark (kept from the cap era so the mark's
 * physical size law is unchanged), so `size` up to ~1.4 never clips. */
const CAP_HEADROOM = 1.5;

/** Openness the blink dips toward — not exactly 0, so the line stays a mark. */
const BLINK_CLOSED = 0.04;

/** Blink cadence bounds, ms. Deterministically jittered per blink from the seed. */
const BLINK_MIN_MS = 4000;
const BLINK_SPAN_MS = 3000;

/** Expressions this closed or below don't blink — the lid is already down. */
const BLINK_SKIP_BELOW = 0.2;

/** Ambient gaze-drift amplitude, lid space. Mostly sideways, a touch of
 * vertical — the deadpan glance of the reference sheet. */
const WANDER_X = MARK_R * 0.34;
const WANDER_Y = MARK_R * 0.17;

/** The floor under an expression's `wander`. Nothing on screen ever fully
 * arrests (TASTE §2.1) — least of all the character's only feature. */
const MIN_WANDER = 0.22;

const EYE_VERT_DECL = /* glsl */ `
varying vec2 vEyePos;
varying float vEyeNz;
`;

const EYE_FRAG_DECL = /* glsl */ `
uniform vec3 uEyeColor;
uniform vec3 uEyePupil;
uniform vec2 uEyeGaze;
uniform vec2 uEyeCenter;
uniform float uEyeRadius;
uniform float uEyeAspect;
uniform float uEyeOpenness;
uniform float uEyeCurve;
uniform float uEyeWedge;
uniform float uEyeSize;
uniform float uEyePupilR;
varying vec2 vEyePos;
varying float vEyeNz;
`;

/**
 * Fragment composite — the cap shader's SDF ported into the box-projected
 * frame. uSide is baked to 0 (the centered wedge), and 0.78086 is
 * inversesqrt(1 + 0.8²) — the wedge slope's normalization, precomputed.
 */
const EYE_FRAG_BLOCK = /* glsl */ `
{
	vec2 pEye = (vEyePos - uEyeCenter) / (uEyeRadius * vec2(uEyeAspect, 1.0));
	pEye /= max(uEyeSize, 0.05);
	float eyeOpen = max(uEyeOpenness, 0.03);
	vec2 qEye = vec2(pEye.x, pEye.y / eyeOpen);
	float dEye = length(qEye) - ${MARK_R};

	// Crescent: subtract a circle sliding in from above (sad) or below
	// (happy). At curve = 0 the cutter is exactly tangent — no cut.
	float eyeCutA = abs(uEyeCurve);
	float eyeSgn = uEyeCurve >= 0.0 ? 1.0 : -1.0;
	vec2 eyeCutC = vec2(0.0, -eyeSgn * (${MARK_R} + 0.75 - eyeCutA));
	dEye = max(dEye, -(length(qEye - eyeCutC) - 0.75));

	// Angry wedge: a horizontal half-plane descending with the wedge value.
	// At wedge = 0 the line clears the disc entirely.
	float eyeCh = ${MARK_R} * (1.6 - 1.9 * uEyeWedge);
	dEye = max(dEye, (pEye.y / eyeOpen - eyeCh) * 0.78086);

	// Soft knockout edge, ~1.5px, faded by facing so nothing shows edge-on
	// or from behind — the silhouette stays one solid mass from any angle.
	float eyeAa = fwidth(dEye) * 1.5 + 1e-4;
	float eyeMask = (1.0 - smoothstep(-eyeAa, eyeAa, dEye)) * smoothstep(0.05, 0.5, vEyeNz);

	// The pupil (avatar spec: one solid dark pupil, no highlight): a dark
	// disc that squashes with the lid and glances with uEyeGaze, clipped by
	// the mark's own SDF. uEyeGaze is in LID SPACE (qEye) — the same frame
	// the lids cut in — so the CPU can guarantee the lids never swallow it
	// (expressions.clampPupil), and a blink squashes the pupil with the lid
	// instead of flinging it out of the mark.
	float eyeDp = length(qEye - uEyeGaze) - uEyePupilR;
	float eyePupil = 1.0 - smoothstep(-eyeAa, eyeAa, max(eyeDp, dEye));
	diffuseColor.rgb = mix(diffuseColor.rgb, mix(uEyeColor, uEyePupil, eyePupil), eyeMask);
}
`;

/** Override frame for constructions whose eye anchor lives outside the
 * inflate-local placement (the blendshell path computes its own). */
export interface EyeFrame {
  /** Mark center in the geometry's object space. */
  cx: number;
  cy: number;
  /** Visible mark radius at expression size 1, object-space units. */
  r: number;
}

/** A read of the eye's live uniforms — for tests and the taste gates. */
export interface EyeState {
  openness: number;
  curve: number;
  wedge: number;
  size: number;
  /** Pupil centre, lid space (post-clamp — what the shader actually draws). */
  gazeX: number;
  gazeY: number;
  /** Pupil radius, lid space. */
  pupilR: number;
}

export interface Eyes {
  /** Glide to an expression — springs retarget, never snap. */
  setExpression(e: ExpressionName | Expression): void;
  /**
   * Retarget the EMOTE gaze layer: a lid-space offset added to the current
   * expression's resting pupil. Rides a ζ≥1 spring, so a glance glides in
   * and can be interrupted mid-flight. (0, 0) is "no deliberate glance" —
   * the expression's own pupil plus the ambient drift.
   */
  setGaze(x: number, y: number): void;
  /** Advance springs and the blink schedule. dt in ms. */
  update(dt: number): void;
  /** The live uniform values, for tests and the taste gates. */
  state(): EyeState;
  /** Vertical follow for constructions whose head lifts in-shader (the
   * blendshell bob). The inflate path never needs it — its projection
   * already rides the deform. */
  setLift(y: number): void;
  /** Unregister the springs. The shader hooks die with the material. */
  dispose(): void;
}

/** Cheap deterministic hash → [0, 1). Same recipe as motion/ambient. */
function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Paint the eye into the body material. Chain AFTER applyDeform and
 * applyMarking — this wraps the material's existing onBeforeCompile.
 *
 * @param material     the character's material (the hook chains onto it).
 * @param analysis     the shape analysis (headLobe anchors the mark).
 * @param identitySeed optional identity salt (character.ts): mixes into the
 *                     eye's shape seed (circle/oval choice), size (±10%),
 *                     and the gaze/blink schedule, so two hatchlings of one
 *                     drawing never share a face. Absent → shape-only seeds.
 * @param frame        optional anchor override (blendshell spec space);
 *                     absent, the mark centers on computeEyePlacement's
 *                     pair midpoint in inflate-local space.
 */
export function applyEyes(
  material: MeshPhysicalMaterial,
  analysis: ShapeAnalysis,
  identitySeed?: number,
  frame?: EyeFrame,
): Eyes {
  const placement = computeEyePlacement(analysis);

  // Identity mix: a small bounded offset folded into the seed hashes below.
  // 0 when unsalted, so the unsalted eye is exactly the pre-salt eye.
  const idMix = identitySeed === undefined ? 0 : (identitySeed % 4096) * 0.7717;

  // One eye, always (user ruling): a single cyclops mark centered on the
  // head lobe. Shape varies per character between circular and oval, seeded
  // from the shape itself (and the identity salt, when present).
  const shapeSeed = hash(
    analysis.headLobe.x * 1.317 +
      analysis.headLobe.y * 0.577 +
      analysis.distance.max * 0.211 +
      idMix,
  );
  // Half circular (aspect 1), half oval — ovals span 1.2..1.45 wide.
  const aspect = shapeSeed < 0.5 ? 1 : 1.2 + (shapeSeed - 0.5) * 0.5;
  // Identity size jitter, ±10% — unsalted characters keep the exact 1.5×.
  const sizeJitter =
    identitySeed === undefined ? 1 : 0.9 + hash(idMix * 3.37 + 11.13) * 0.2;
  // The single mark carries the whole face: 1.5× the pair radius, capped by
  // the head's local thickness. Object-space units — the mesh's own scale
  // carries it to world size.
  const markR =
    frame?.r ?? Math.min(placement.radius * 1.5 * sizeJitter, placement.separation * 1.35);
  const cx = frame?.cx ?? (placement.left.x + placement.right.x) / 2;
  const cy = frame?.cy ?? (placement.left.y + placement.right.y) / 2;

  const uniforms: Record<string, IUniform> = {
    uEyeColor: { value: new Color(CHARACTER.eye) },
    uEyePupil: { value: new Color(CHARACTER.body) },
    uEyeGaze: { value: new Vector2(0, 0) },
    uEyeCenter: { value: new Vector2(cx, cy) },
    // The unit-frame radius: the visible mark spans MARK_R of it (the cap
    // era's headroom kept, so the physical mark size law is unchanged).
    uEyeRadius: { value: (markR / MARK_R) * CAP_HEADROOM },
    uEyeAspect: { value: aspect },
    uEyeOpenness: { value: EXPRESSIONS.neutral.openness },
    uEyeCurve: { value: EXPRESSIONS.neutral.curve },
    uEyeWedge: { value: EXPRESSIONS.neutral.wedge },
    uEyeSize: { value: EXPRESSIONS.neutral.size },
    uEyePupilR: { value: MARK_R * PUPIL_FRAC * EXPRESSIONS.neutral.pupilScale },
  };

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${EYE_VERT_DECL}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvEyePos = position.xy;\n\tvEyeNz = normal.z;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${EYE_FRAG_DECL}`)
      // After <color_fragment> (and therefore after the marking's chained
      // composite, whatever the wrap order) — the eye paints over the mark.
      .replace('#include <alphamap_fragment>', `${EYE_FRAG_BLOCK}\n#include <alphamap_fragment>`);
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}/character-eye-v3`;

  // One spring per SDF parameter — expressions glide, never snap.
  const settle = { settleMs: MOTION.tertiaryMs };
  const springs = {
    openness: new Spring(EXPRESSIONS.neutral.openness, settle),
    curve: new Spring(EXPRESSIONS.neutral.curve, settle),
    wedge: new Spring(EXPRESSIONS.neutral.wedge, settle),
    size: new Spring(EXPRESSIONS.neutral.size, settle),
    // The pupil: radius, and the deliberate gaze (expression rest + emote
    // glance). Same tertiary settle as the lids — the eye morph token.
    pupil: new Spring(EXPRESSIONS.neutral.pupilScale, settle),
    gazeX: new Spring(EXPRESSIONS.neutral.pupilX, settle),
    gazeY: new Spring(EXPRESSIONS.neutral.pupilY, settle),
  };

  let current: ResolvedExpression = normalizeExpression(EXPRESSIONS.neutral);
  // The emote gaze layer, retargeted by setGaze and released to 0 when the
  // emote ends. Kept apart from the expression's own resting pupil so the
  // two compose instead of overwriting each other.
  let emoteGazeX = 0;
  let emoteGazeY = 0;

  // Deterministic blink/gaze schedule, seeded from the shape itself plus the
  // identity salt — two hatchlings of one drawing blink and glance apart.
  const seed =
    analysis.headLobe.x * 0.731 +
    analysis.headLobe.y * 0.269 +
    analysis.distance.max * 0.113 +
    idMix * 0.317;
  let timeMs = 0;
  let blinkCount = 0;
  let blinking = false;
  let blinkT = 0;
  let nextBlinkAt = BLINK_MIN_MS + hash(seed * 7.13) * BLINK_SPAN_MS;

  /** Re-aim the gaze springs at expression rest + the emote's glance. */
  const retargetGaze = (): void => {
    springs.gazeX.retarget(current.pupilX + emoteGazeX);
    springs.gazeY.retarget(current.pupilY + emoteGazeY);
  };

  return {
    setExpression(e: ExpressionName | Expression): void {
      current = normalizeExpression(resolveExpression(e));
      // Openness is owned by the blink while its down-leg runs; it re-aims
      // at the new expression when the blink releases.
      if (!blinking) springs.openness.retarget(current.openness);
      springs.curve.retarget(current.curve);
      springs.wedge.retarget(current.wedge);
      springs.size.retarget(current.size);
      springs.pupil.retarget(current.pupilScale);
      retargetGaze();
    },

    setGaze(x: number, y: number): void {
      emoteGazeX = x;
      emoteGazeY = y;
      retargetGaze();
    },

    update(dt: number): void {
      timeMs += dt;

      // Glancing pupil (docs/reference/character-designs.md): the pupil
      // drifts off-center on a slow seeded wander — mostly sideways, a
      // touch of vertical — so the mark reads deadpan-alive, never locked
      // centered. Smoothstepped between held glances; same seed family as
      // the blink so every device agrees.
      const gt = timeMs / 4400;
      const g0 = Math.floor(gt);
      const gf = gt - g0;
      const ge = gf * gf * (3 - 2 * gf);
      const gxa = (hash(g0 * 3.7 + seed) - 0.5) * 2;
      const gxb = (hash((g0 + 1) * 3.7 + seed) - 0.5) * 2;
      const gya = (hash(g0 * 9.1 + seed + 5) - 0.5) * 2;
      const gyb = (hash((g0 + 1) * 9.1 + seed + 5) - 0.5) * 2;
      // Scaled by the expression's own wander, floored well above zero: an
      // eye that fully arrests is a hard stop (TASTE §2.1). Even the fixed
      // stare of `surprised` keeps drifting, just barely.
      const wander = Math.max(current.wander, MIN_WANDER);
      const driftX = (gxa + (gxb - gxa) * ge) * WANDER_X * wander;
      const driftY = (gya + (gyb - gya) * ge) * WANDER_Y * wander;

      // Blink: down over one tertiary settle, then retarget up — each leg is
      // a clean ζ≥1 spring settle, so there is no rebound anywhere.
      if (!blinking && timeMs >= nextBlinkAt) {
        blinking = true;
        blinkT = 0;
        if (current.openness > BLINK_SKIP_BELOW) {
          springs.openness.retarget(BLINK_CLOSED);
        }
      }
      if (blinking) {
        blinkT += dt;
        if (blinkT >= MOTION.tertiaryMs) {
          blinking = false;
          springs.openness.retarget(current.openness);
          blinkCount++;
          nextBlinkAt =
            timeMs + BLINK_MIN_MS + hash(seed * 7.13 + blinkCount * 3.7) * BLINK_SPAN_MS;
        }
      }

      const openness = springs.openness.update(dt);
      const curve = springs.curve.update(dt);
      const wedge = springs.wedge.update(dt);
      uniforms['uEyeOpenness']!.value = openness;
      uniforms['uEyeCurve']!.value = curve;
      uniforms['uEyeWedge']!.value = wedge;
      uniforms['uEyeSize']!.value = springs.size.update(dt);

      // The pupil, last: expression rest + emote glance (one spring pair)
      // plus the ambient drift, then held inside the slot the LIVE lids
      // leave open. Clamping against the springs' current curve/wedge — not
      // their targets — means the pupil rides a moving lid continuously
      // instead of being cut away mid-glide.
      const pupilR = MARK_R * PUPIL_FRAC * springs.pupil.update(dt);
      uniforms['uEyePupilR']!.value = pupilR;
      const aimed = clampPupil(
        curve,
        wedge,
        pupilR,
        springs.gazeX.update(dt) + driftX,
        springs.gazeY.update(dt) + driftY,
      );
      (uniforms['uEyeGaze']!.value as Vector2).set(aimed.x, aimed.y);
    },

    state(): EyeState {
      const gaze = uniforms['uEyeGaze']!.value as Vector2;
      return {
        openness: uniforms['uEyeOpenness']!.value as number,
        curve: uniforms['uEyeCurve']!.value as number,
        wedge: uniforms['uEyeWedge']!.value as number,
        size: uniforms['uEyeSize']!.value as number,
        gazeX: gaze.x,
        gazeY: gaze.y,
        pupilR: uniforms['uEyePupilR']!.value as number,
      };
    },

    setLift(y: number): void {
      (uniforms['uEyeCenter']!.value as Vector2).set(cx, cy + y);
    },

    dispose(): void {
      springs.openness.dispose();
      springs.curve.dispose();
      springs.wedge.dispose();
      springs.size.dispose();
      springs.pupil.dispose();
      springs.gazeX.dispose();
      springs.gazeY.dispose();
    },
  };
}
