/**
 * The marking (GENERATOR §1, recognition channel 2): the ORIGINAL drawing
 * painted onto the species body, so the literal mark travels with the
 * creature even though the silhouette is synthesized.
 *
 * The body is the one near-black on screen, so the mark cannot darken it —
 * it reads as a KNOCKOUT instead: the strokes render in CHARACTER.eye (the
 * light role) at low opacity, a quiet lighter tattoo. Black-and-white
 * compliant; the accent stays retired.
 *
 * Mechanics: the stroke list is stamped front-centered onto a transparent
 * CanvasTexture (the egg's composited-stamp approach, single stamp — the
 * body is small). The inflated mesh has no UVs, so the shader derives
 * box-projected UVs from the UNDEFORMED object-space position over the
 * geometry's bounding box (front projection along +z) — the mark therefore
 * rides every squash/lean/twist exactly like the surface it sits on. The
 * composite happens in the fragment stage on diffuseColor, fading out near
 * the rim (normal.z → 0), so the head-on silhouette stays one solid mass at
 * distance and the marking is a close-up reward.
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

/** The stamp's largest texture-space extent (fraction of the projection). */
const STAMP_FIT = 0.5;
/** Stamp center in texture uv space — front, on the BELLY. The face belongs
 * to the eyes; a light patch over the head lobe would swallow them. */
const STAMP_CX = 0.5;
const STAMP_CY = 0.38;

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
 * Apply the drawing as a front-projected marking on the character material.
 *
 * @param material the character's material, with the deformation hook
 *                 already installed (this chains after it).
 * @param strokes  the ORIGINAL drawing, not the synthesized body.
 * @param box      the geometry bounding box (object space) the front
 *                 projection spans.
 * @returns null in DOM-less environments (pure test runs) — no marking.
 */
export function applyMarking(
  material: MeshPhysicalMaterial,
  strokes: StrokeList,
  box: { min: { x: number; y: number }; max: { x: number; y: number } },
): MarkingHandle | null {
  if (typeof document === 'undefined') return null;

  const sizeX = Math.max(box.max.x - box.min.x, 1e-6);
  const sizeY = Math.max(box.max.y - box.min.y, 1e-6);

  // ── stamp: the drawing, light ink on transparent ──────────────────────────
  const stamp = document.createElement('canvas');
  stamp.width = STAMP_SIZE;
  stamp.height = STAMP_SIZE;
  const stampCtx = stamp.getContext('2d');
  if (stampCtx) paintStrokes(stampCtx, strokes, STAMP_SIZE);

  // ── composite: front-centered, aspect-compensated ─────────────────────────
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
    const over = Math.max(fw, fh) / 0.85;
    if (over > 1) {
      fw /= over;
      fh /= over;
    }
    // uv v runs bottom→top (flipY upload); canvas rows run top→bottom.
    ctx.drawImage(
      stamp,
      (STAMP_CX - fw / 2) * TEX_SIZE,
      (1 - STAMP_CY - fh / 2) * TEX_SIZE,
      fw * TEX_SIZE,
      fh * TEX_SIZE,
    );
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
        '#include <begin_vertex>\n\tvMarkUv = (position.xy - uMarkMin) / uMarkSize;\n\tvMarkNz = normal.z;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${MARK_GLSL_DECL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
	{
		vec2 markUv = clamp(vMarkUv, 0.0, 1.0);
		float markIn = float(all(equal(markUv, vMarkUv)));
		float markFront = smoothstep(0.05, 0.5, vMarkNz);
		float markA = texture2D(uMarkMap, markUv).a * uMarkOpacity * markIn * markFront;
		diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, markA);
	}`,
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}/character-marking-v1`;

  return {
    texture,
    dispose(): void {
      texture.dispose();
    },
  };
}
