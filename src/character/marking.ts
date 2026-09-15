/**
 * The marking (GENERATOR §1, recognition channel 2): the ORIGINAL drawing
 * painted onto the species body — on its BACK. The literal mark travels with
 * the creature, but it is the reward for watching it walk away from you, not
 * something it wears on its face.
 *
 * *(Reinstated 2026-08-18, user: "actually let's add the drawing back but
 * let's put it on the creature's back". The 2026-08-18 removal stands as the
 * record of why the FRONT marking went — see GENERATOR §1.)*
 *
 * The body is the one near-black on screen, so the mark cannot darken it —
 * it reads as a KNOCKOUT instead: the strokes render in CHARACTER.eye (the
 * light role) at low opacity, a quiet lighter tattoo. Black-and-white
 * compliant; the accent stays retired.
 *
 * AXIS CONVENTION. The creature travels along its own local +z: the behavior
 * agent emits `vx = sin(heading), vz = cos(heading)` and the manager sets
 * `root.rotation.y = heading`, which carries local (0,0,1) to exactly that
 * velocity. The eye (./eyes.ts) fades in on `+normal.z`, so the eye is on the
 * leading face. **The back is therefore −z** — the surface you see as the
 * creature walks away — and this module fades in on `−normal.z`.
 *
 * Mechanics: the stroke list is stamped onto a transparent CanvasTexture (the
 * egg's composited-stamp approach, single stamp — the body is small). The
 * inflated mesh has no UVs, so the shader derives box-projected UVs from the
 * UNDEFORMED object-space position over the geometry's bounding box (rear
 * projection along −z) — the mark therefore rides every squash/lean/twist
 * exactly like the surface it sits on. The horizontal coordinate is MIRRORED
 * (`1 − u`): a rear projection seen from behind puts object +x on the
 * viewer's left, so an unmirrored stamp would read reversed. The composite
 * happens in the fragment stage on diffuseColor, fading out near the rim
 * (normal.z → 0), so the head-on silhouette stays one solid mass at distance
 * and the marking is a close-up reward.
 *
 * applyMarking chains onto the material's EXISTING onBeforeCompile (the body
 * deformation installs one first) — call it after applyDeform.
 */

import { CanvasTexture, Color, SRGBColorSpace, Vector2 } from 'three';
import type { MeshPhysicalMaterial } from 'three';
import type { Stroke, StrokeList } from '../shape/types';
import { CHARACTER } from '../taste/tokens';

/** Mark opacity — subtle; the silhouette must still win at distance. */
const MARK_OPACITY = 0.3;

const TEX_SIZE = 512;
const STAMP_SIZE = 512;

/** The stamp's largest texture-space extent (fraction of the projection).
 * Larger than the front era's 0.5 — the eye lives on the OTHER face now, so
 * the back has nothing to avoid. Picked by rendering a sweep (0.50 / 0.58 /
 * 0.62 / 0.64 / 0.72) against two asymmetric test drawings, an "F" and a
 * right-pointing arrow, and reading the rear silhouette:
 *
 *   fit   mark coverage (F / arrow)   solid-mass at distance (F / arrow)
 *   0.50      4.6% / 10.9%                    88.3% / 79.6%
 *   0.62      7.1% / 15.8%                    86.2% / 74.9%
 *   0.72      9.9% / 20.5%                    83.3% / 70.5%
 *
 * 0.72 was too much: on the ink-heavy arrow the mark reached the rim and cut
 * the rear silhouette in half. 0.62 is the largest value that still leaves a
 * clear band of body between the mark and the outline on both drawings while
 * being meaningfully bigger than the front era's stamp. */
const STAMP_FIT = 0.62;
/** Stamp center in texture uv space — centered horizontally, and a little
 * above the box's mid-height. The bounding box includes the legs, which are
 * tiny and read as silhouette, not as surface; centering on the box itself
 * (0.5) drops the stamp's lower edge into them. 0.55 sits it on the torso's
 * broad rear panel, which is where the projection actually has area. Swept
 * 0.48 / 0.55 / 0.62 at fit 0.62: coverage barely moves (within 1.3 points),
 * but 0.55 gave the lowest rim-band intrusion on the ink-heavy test drawing
 * (2.7% vs 3.8% at 0.48 and 3.6% at 0.62). */
const STAMP_CX = 0.5;
const STAMP_CY = 0.55;

/** Identity jitter spans: stamp center offset (uv) and tilt (radians, ≈±4.6°)
 * — enough that two hatchlings of one drawing wear the mark differently,
 * small enough that it stays a centered tattoo on the back. */
const STAMP_JITTER_X = 0.03;
const STAMP_JITTER_Y = 0.025;
const STAMP_JITTER_ROT = 0.08;

/** Cheap deterministic hash → [0, 1). Same recipe as motion/ambient. */
function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

const MARK_GLSL_DECL = /* glsl */ `
uniform sampler2D uMarkMap;
uniform vec3 uMarkColor;
uniform float uMarkOpacity;
varying vec2 vMarkUv;
varying float vMarkNz;
`;

const MARK_VERT_DECL = /* glsl */ `
uniform vec2 uMarkMin;
uniform vec2 uMarkSize;
varying vec2 vMarkUv;
varying float vMarkNz;
`;

export interface MarkingHandle {
  texture: CanvasTexture;
  /** Release the texture. The material's shader hooks die with the material. */
  dispose(): void;
}

/**
 * Paint the stroke list in the light role on a transparent stamp. Borrowed
 * from src/draw/render.ts's stroke walk, minus the opaque ground — the
 * marking needs alpha, not a canvas fill.
 */
function paintStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: StrokeList,
  sizePx: number,
): void {
  ctx.strokeStyle = CHARACTER.eye;
  ctx.fillStyle = CHARACTER.eye;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) paintStroke(ctx, stroke, sizePx);
}

function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, sizePx: number): void {
  const wBase = stroke.w * sizePx;
  const first = stroke.pts[0];
  if (first === undefined) return;
  if (stroke.pts.length === 1) {
    const [x, y, ws] = first;
    ctx.beginPath();
    ctx.arc(x * sizePx, y * sizePx, (wBase * ws) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let prev = first;
  for (let i = 1; i < stroke.pts.length; i++) {
    const pt = stroke.pts[i];
    if (pt === undefined) break;
    ctx.beginPath();
    ctx.lineWidth = wBase * ((prev[2] + pt[2]) / 2);
    ctx.moveTo(prev[0] * sizePx, prev[1] * sizePx);
    ctx.lineTo(pt[0] * sizePx, pt[1] * sizePx);
    ctx.stroke();
    prev = pt;
  }
}

/**
 * Apply the drawing as a rear-projected marking on the character material.
 *
 * @param material the character's material, with the deformation hook
 *                 already installed (this chains after it).
 * @param strokes  the ORIGINAL drawing, not the synthesized body.
 * @param box      the geometry bounding box (object space) the rear
 *                 projection spans.
 * @param identitySeed optional identity salt (character.ts): jitters the
 *                 stamp's center and tilt slightly, so two hatchlings of
 *                 one drawing wear the mark differently. Absent → the exact
 *                 back-center placement.
 * @returns null in DOM-less environments (pure test runs) — no marking.
 */
export function applyMarking(
  material: MeshPhysicalMaterial,
  strokes: StrokeList,
  box: { min: { x: number; y: number }; max: { x: number; y: number } },
  identitySeed?: number,
): MarkingHandle | null {
  if (typeof document === 'undefined') return null;

  // Identity placement jitter — deterministic per id, zero when unsalted.
  const idMix = identitySeed === undefined ? null : (identitySeed % 8192) * 0.4271;
  const stampCx =
    STAMP_CX + (idMix === null ? 0 : (hash(idMix + 3.1) - 0.5) * 2 * STAMP_JITTER_X);
  const stampCy =
    STAMP_CY + (idMix === null ? 0 : (hash(idMix + 7.7) - 0.5) * 2 * STAMP_JITTER_Y);
  const stampRot =
    idMix === null ? 0 : (hash(idMix + 1.3) - 0.5) * 2 * STAMP_JITTER_ROT;

  const sizeX = Math.max(box.max.x - box.min.x, 1e-6);
  const sizeY = Math.max(box.max.y - box.min.y, 1e-6);

  // ── stamp: the drawing, light ink on transparent ──────────────────────────
  const stamp = document.createElement('canvas');
  stamp.width = STAMP_SIZE;
  stamp.height = STAMP_SIZE;
  const stampCtx = stamp.getContext('2d');
  if (stampCtx) paintStrokes(stampCtx, strokes, STAMP_SIZE);

  // ── composite: back-centered, aspect-compensated ──────────────────────────
  // The projection maps the (non-square) bounding box onto the square
  // texture, so the stamp is pre-scaled by the inverse aspect to land
  // isotropic on the body.
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx && stampCtx) {
    let fw = STAMP_FIT;
    let fh = STAMP_FIT * (sizeX / sizeY);
    const over = Math.max(fw, fh) / 0.92;
    if (over > 1) {
      fw /= over;
      fh /= over;
    }
    // uv v runs bottom→top (flipY upload); canvas rows run top→bottom.
    // The shader mirrors u, so texture-space +x is the viewer's right when
    // looking at the BACK — the canvas is painted unmirrored and stays
    // readable there. Drawn about the (identity-jittered) center so the tilt
    // pivots there; unsalted this is the exact back-center stamp.
    ctx.save();
    ctx.translate(stampCx * TEX_SIZE, (1 - stampCy) * TEX_SIZE);
    ctx.rotate(stampRot);
    ctx.drawImage(
      stamp,
      (-fw / 2) * TEX_SIZE,
      (-fh / 2) * TEX_SIZE,
      fw * TEX_SIZE,
      fh * TEX_SIZE,
    );
    ctx.restore();
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const uniforms = {
    uMarkMap: { value: texture },
    uMarkColor: { value: new Color(CHARACTER.eye) },
    uMarkOpacity: { value: MARK_OPACITY },
    uMarkMin: { value: new Vector2(box.min.x, box.min.y) },
    uMarkSize: { value: new Vector2(sizeX, sizeY) },
  };

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${MARK_VERT_DECL}`)
      .replace(
        '#include <begin_vertex>',
        // MIRRORED u: seen from behind, object +x is on the viewer's LEFT,
        // so an unmirrored rear projection would show the drawing reversed.
        '#include <begin_vertex>\n\tvMarkUv = (position.xy - uMarkMin) / uMarkSize;\n\tvMarkUv.x = 1.0 - vMarkUv.x;\n\tvMarkNz = normal.z;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${MARK_GLSL_DECL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
	{
		vec2 markUv = clamp(vMarkUv, 0.0, 1.0);
		float markIn = float(all(equal(markUv, vMarkUv)));
		// Rear-facing only: the eye owns +z, the drawing owns -z. Fades to
		// nothing at the rim, so the head-on silhouette is one solid mass.
		float markBack = smoothstep(0.05, 0.5, -vMarkNz);
		float markA = texture2D(uMarkMap, markUv).a * uMarkOpacity * markIn * markBack;
		diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, markA);
	}`,
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}/character-marking-back-v1`;

  return {
    texture,
    dispose(): void {
      texture.dispose();
    },
  };
}
