/**
 * The blend-shell ink outline (BLENDSHELL step 3).
 *
 * A second draw of the SAME merged geometry, snapped to the SDF OFFSET
 * surface (iso = outline width) with faces flipped (side: BackSide) in
 * WORLD.ink — the resource's concave-joint-safe outline. Because the offset
 * surface is computed from the same smooth-min field, the line follows every
 * blended joint without the inverted-hull pinching that normal-extrusion
 * outlines show in concave creases.
 *
 * A slight iso wobble (seeded smooth spatial noise, evaluated along the
 * gradient in the shared snap) keeps the line reading drawn rather than
 * machined — same treatment family as the world ink pass.
 */

import { BackSide, Color, Mesh, MeshBasicMaterial } from 'three';
import type { BufferGeometry, WebGLProgramParametersWithUniforms } from 'three';
import { WORLD } from '../../taste/tokens';
import { SDF_SNAP_GLSL, type PartTableUniforms } from './shell';

/** Ink line width as a fraction of character height (spec units). */
export const OUTLINE_WIDTH = 0.045;

/** Wobble amplitude as a fraction of the outline width. */
const WOBBLE = 0.3;

export interface OutlineHandles {
  mesh: Mesh;
  material: MeshBasicMaterial;
  dispose(): void;
}

/**
 * Build the ink hull. Shares the body's merged geometry and part table — the
 * per-frame updateParts on the shell feeds this material too, since the
 * uniform value objects are the same.
 *
 * @param geometry the shell's merged geometry (shared, not disposed here)
 * @param table    the shell's part-table uniforms (shared)
 * @param height   character height in spec units (scales the line width)
 * @param seed     per-character wobble phase
 */
export function createOutline(
  geometry: BufferGeometry,
  table: PartTableUniforms,
  height: number,
  seed: number,
): OutlineHandles {
  const width = OUTLINE_WIDTH * height;
  const own = {
    uSnapIso: { value: width },
    uWobbleAmp: { value: width * WOBBLE },
    uWobbleSeed: { value: (seed % 997) * 0.618 },
  };

  const material = new MeshBasicMaterial({
    color: new Color(WORLD.ink),
    side: BackSide,
  });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, table, own);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SDF_SNAP_GLSL}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
	transformed = bsSnap(transformed);`,
      );
  };
  material.customProgramCacheKey = () => 'blendshell-outline-v1';

  const mesh = new Mesh(geometry, material);
  // Draw before the body so the body always wins the depth contest cleanly.
  mesh.renderOrder = -1;

  return {
    mesh,
    material,
    dispose(): void {
      material.dispose();
    },
  };
}
