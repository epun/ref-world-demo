/**
 * The bridge between the pure inflation pipeline and Three.js — the ONLY
 * place InflatedMesh output meets a renderer type. src/inflate/ stays free of
 * Three.js so the phone and the world get byte-identical geometry (PLAN §6.3);
 * this module wraps those typed arrays without editorializing.
 */

import { BufferAttribute, BufferGeometry, MeshPhysicalMaterial } from 'three';
import type { InflatedMesh } from '../inflate/types';
import { CHARACTER } from '../taste/tokens';
import type { DeformFrame } from './deform';

/**
 * Wrap inflate() output into a BufferGeometry. The typed arrays are adopted
 * directly — positions, normals, and index come straight from the module.
 * Normals are NOT recomputed: the inflater already emits smooth area-weighted
 * normals, and re-deriving them here could only diverge from what the phone
 * renders.
 *
 * THE INDEX IS NARROWED WHERE IT FITS (2026-09-17).
 *
 * `src/inflate/` emits `Uint32Array` indices and keeps emitting them: the
 * pure module's output is byte-identical on every device by contract
 * (PLAN §6.3) and its `MAX_VERTS` is 262,144, which genuinely needs 32 bits.
 * But a real creature's body is ~46k vertices and its topper ~34k, and at
 * gridStep 6 the index is the single biggest buffer either of them carries —
 * 934 kB of the body's 1.87 MB. Two bytes a triangle corner is enough for
 * anything under 65,536 vertices, so THIS side of the bridge, where the
 * numbers stop being the pipeline's answer and start being a GPU upload,
 * hands the renderer the narrow copy.
 *
 * It is not a look change and it is not a determinism change: the indices
 * are the same integers, so the same triangles are drawn in the same order.
 * It is 0.88 MB per creature off the JS heap and the same again off the
 * GPU — 176 MB at a hundred of them, measured (see the budget test).
 */
export function toBufferGeometry(mesh: InflatedMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  const verts = mesh.positions.length / 3;
  geometry.setIndex(
    new BufferAttribute(verts <= 0x10000 ? new Uint16Array(mesh.indices) : mesh.indices, 1),
  );
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Measure the vertical frame the body deformation bends around (deform.ts):
 * geometry bottom and height, in object space. Lives here because this is
 * the one module that already owns the inflate→BufferGeometry bridge.
 */
export function deformFrameOf(geometry: BufferGeometry): DeformFrame {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  return {
    baseY: box.min.y,
    height: Math.max(box.max.y - box.min.y, 1e-6),
  };
}

/**
 * The character surface (PLAN §3.3): the one near-black on screen, with the
 * quiet clearcoat gloss both briefs pair with muted saturation. Same recipe
 * as the P0 test blob — 38/100 material realism, not a chrome ball.
 *
 * With a `color` (the creature colourway, ./palette.ts) the recipe softens:
 * the creature brief pairs *"warm color ↔ gloss finish + reflective
 * surface"* [M] but forbids *"complex shading or material rendering that
 * would compete with the flat, graphic read"* [M], so a coloured body gets
 * a broader, duller gloss than the near-black one — enough to catch the key
 * light, not enough to shade the fill. Passing nothing keeps the original
 * near-black recipe exactly, for the callers that never asked for a hue.
 */
export function createCharacterMaterial(color?: string): MeshPhysicalMaterial {
  if (color === undefined) {
    return new MeshPhysicalMaterial({
      color: CHARACTER.body,
      roughness: 0.35,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.15,
    });
  }
  return new MeshPhysicalMaterial({
    color,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.3,
  });
}
