/**
 * The eyes (PLAN §3.4) — the character's entire emotional range.
 *
 * Two small circular caps float just proud of the front surface at the head
 * lobe (placement math in ./placement.ts, which replicates the inflater's
 * mask→local transform exactly). The eye shape itself is a 2D SDF evaluated
 * in the fragment shader: a base lens squashed vertically by `openness`,
 * bent into an upper/lower crescent by subtracting an offset circle
 * (`curve`), and notched on the inner side by an angled half-plane cut
 * (`wedge`). Fill is CHARACTER.eye where the SDF is inside, discard outside
 * — the knockout reading the brief mandates, with a ~1.5px fwidth smoothstep
 * edge so the mark stays soft-organic rather than aliased-hard.
 *
 * Expressions GLIDE: each SDF parameter rides its own ζ≥1 Spring (settleMs
 * = MOTION.tertiaryMs), so setExpression never snaps — it retargets, and the
 * springs settle without ever crossing (TASTE §2.1). An idle blink dips
 * openness toward 0 and back over ~2× tertiaryMs on a deterministic schedule
 * derived from the shape itself — no Math.random, so every device blinks the
 * same character at the same moments.
 */

import { CircleGeometry, Color, Group, Mesh, ShaderMaterial } from 'three';
import type { IUniform } from 'three';
import { Spring } from '../motion/spring';
import type { ShapeAnalysis } from '../shape/types';
import { CHARACTER, MOTION } from '../taste/tokens';
import {
  EXPRESSIONS,
  resolveExpression,
  type Expression,
  type ExpressionName,
} from './expressions';
import { computeEyePlacement } from './placement';

/** Radius of the visible mark inside the cap's unit uv disc, at size 1. */
const MARK_R = 0.62;

/** Cap geometry headroom over the mark, so `size` up to ~1.4 never clips. */
const CAP_HEADROOM = 1.5;

/** Openness the blink dips toward — not exactly 0, so the line stays a mark. */
const BLINK_CLOSED = 0.04;

/** Blink cadence bounds, ms. Deterministically jittered per blink from the seed. */
const BLINK_MIN_MS = 4000;
const BLINK_SPAN_MS = 3000;

/** Expressions this closed or below don't blink — the lid is already down. */
const BLINK_SKIP_BELOW = 0.2;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpenness;
uniform float uCurve;
uniform float uWedge;
uniform float uSize;
uniform float uSide;
varying vec2 vUv;

void main() {
  // Cap-local coordinates: unit disc, +y up, scaled by the expression size.
  vec2 p = (vUv * 2.0 - 1.0) / max(uSize, 0.05);
  // Mirror per eye so the inner side (toward the other eye) is always +x.
  float xi = p.x * -uSide;

  // Base lens: a circle squashed vertically by openness, down to a line.
  float open = max(uOpenness, 0.03);
  vec2 q = vec2(p.x, p.y / open);
  float d = length(q) - ${MARK_R};

  // Crescent: subtract a circle sliding in from above (sad) or below
  // (happy). At curve = 0 the cutter is exactly tangent — no cut.
  float rc = 0.75;
  float ac = abs(uCurve);
  float sgn = uCurve >= 0.0 ? 1.0 : -1.0;
  vec2 cc = vec2(0.0, -sgn * (${MARK_R} + rc - ac));
  d = max(d, -(length(vec2(p.x, p.y / open) - cc) - rc));

  // Angry wedge: an angled half-plane descending toward the inner side.
  // At wedge = 0 the line clears the disc entirely.
  float slope = 0.8;
  float ch = ${MARK_R} * (1.6 - 1.9 * uWedge);
  float dw = (p.y / open + slope * xi - ch) * inversesqrt(1.0 + slope * slope);
  // Cut where dw > 0 (above the descending line). The previous -dw sign
  // inverted the half-plane: at wedge = 0 it discarded the entire mark, so
  // eyes never rendered at all.
  d = max(d, dw);

  // Soft knockout edge, ~1.5px in screen space.
  float aa = fwidth(d) * 1.5 + 1e-4;
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface Eyes {
  /** Add to the character group. Position/scale are set at creation. */
  group: Group;
  /** Glide to an expression — springs retarget, never snap. */
  setExpression(e: ExpressionName | Expression): void;
  /** Advance springs and the blink schedule. dt in ms. */
  update(dt: number): void;
  /** Release GPU resources and unregister the springs. */
  dispose(): void;
}

/** Cheap deterministic hash → [0, 1). Same recipe as motion/ambient. */
function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Build the eye pair for an analyzed shape.
 *
 * @param analysis   the shape analysis (headLobe anchors the pair)
 * @param meshScale  the character mesh's world scale — placement is computed
 *                   in inflate-local space and multiplied up by this, so the
 *                   caps land exactly on the scaled body surface.
 */
export function createEyes(analysis: ShapeAnalysis, meshScale: number): Eyes {
  const placement = computeEyePlacement(analysis);

  // One eye, always (user ruling): a single cyclops mark centered on the
  // head lobe — the CDG-Play-adjacent single-cutout read. Shape varies per
  // character between circular and oval, seeded from the shape itself.
  const shapeSeed = hash(
    analysis.headLobe.x * 1.317 + analysis.headLobe.y * 0.577 + analysis.distance.max * 0.211,
  );
  // Half circular (aspect 1), half oval — ovals span 1.2..1.45 wide.
  const aspect = shapeSeed < 0.5 ? 1 : 1.2 + (shapeSeed - 0.5) * 0.5;
  // The single mark sits larger than one of the old pair — it carries the
  // whole face. 1.5× the pair radius, capped by the head's local thickness.
  const radius = Math.min(placement.radius * 1.5, placement.separation * 1.35) * meshScale;

  // The visible mark at size 1 spans MARK_R of the cap's uv disc, so the cap
  // itself is larger; everything outside the SDF discards.
  const capRadius = (radius / MARK_R) * CAP_HEADROOM;
  const geometry = new CircleGeometry(capRadius * aspect, 32);
  geometry.scale(1, 1 / aspect, 1); // widen uv-space: mark stretches horizontally

  const shared: Record<string, IUniform> = {
    uColor: { value: new Color(CHARACTER.eye) },
    uOpenness: { value: EXPRESSIONS.neutral.openness },
    uCurve: { value: EXPRESSIONS.neutral.curve },
    uWedge: { value: EXPRESSIONS.neutral.wedge },
    uSize: { value: EXPRESSIONS.neutral.size },
  };

  const group = new Group();
  const materials: ShaderMaterial[] = [];
  const material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    // uSide 0: the wedge cut centers rather than mirroring — symmetric anger.
    uniforms: { ...shared, uSide: { value: 0 } },
    transparent: true,
    depthWrite: false,
  });
  materials.push(material);
  const cap = new Mesh(geometry, material);
  // Centered between the old pair positions: the head-lobe axis.
  const cx = (placement.left.x + placement.right.x) / 2;
  const cy = (placement.left.y + placement.right.y) / 2;
  const cz = Math.max(placement.left.z, placement.right.z);
  cap.position.set(cx * meshScale, cy * meshScale, cz * meshScale);
  group.add(cap);

  // One spring per SDF parameter — expressions glide, never snap.
  const settle = { settleMs: MOTION.tertiaryMs };
  const springs = {
    openness: new Spring(EXPRESSIONS.neutral.openness, settle),
    curve: new Spring(EXPRESSIONS.neutral.curve, settle),
    wedge: new Spring(EXPRESSIONS.neutral.wedge, settle),
    size: new Spring(EXPRESSIONS.neutral.size, settle),
  };

  let current: Expression = EXPRESSIONS.neutral;

  // Deterministic blink schedule, seeded from the shape itself.
  const seed =
    analysis.headLobe.x * 0.731 + analysis.headLobe.y * 0.269 + analysis.distance.max * 0.113;
  let timeMs = 0;
  let blinkCount = 0;
  let blinking = false;
  let blinkT = 0;
  let nextBlinkAt = BLINK_MIN_MS + hash(seed * 7.13) * BLINK_SPAN_MS;

  return {
    group,

    setExpression(e: ExpressionName | Expression): void {
      current = resolveExpression(e);
      // Openness is owned by the blink while its down-leg runs; it re-aims
      // at the new expression when the blink releases.
      if (!blinking) springs.openness.retarget(current.openness);
      springs.curve.retarget(current.curve);
      springs.wedge.retarget(current.wedge);
      springs.size.retarget(current.size);
    },

    update(dt: number): void {
      timeMs += dt;

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

      shared['uOpenness']!.value = springs.openness.update(dt);
      shared['uCurve']!.value = springs.curve.update(dt);
      shared['uWedge']!.value = springs.wedge.update(dt);
      shared['uSize']!.value = springs.size.update(dt);
    },

    dispose(): void {
      geometry.dispose();
      for (const material of materials) material.dispose();
      springs.openness.dispose();
      springs.curve.dispose();
      springs.wedge.dispose();
      springs.size.dispose();
    },
  };
}
