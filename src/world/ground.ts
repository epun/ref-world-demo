/**
 * The ground (PLAN §7, TASTE §2.2): the terraced land the world stands on,
 * plus the flat field beyond it, colored exactly SURFACE.ground — mid-toned
 * neutral grey targeting groundLuma 0.74.
 *
 * UNLIT (MeshBasicMaterial): the field renders exactly its token at every
 * viewing angle. A lit ground's luma drifted with the orbit elevation and
 * straddled a toon-quantize band boundary, turning the dither into huge
 * camo blotches when the user rotated (user report). Flat paper is the
 * design; the environment engine's exposure still dims it at night in the
 * post pass, and hatching keys off the normal target, not the lit color.
 *
 * TWO MESHES, ONE MATERIAL:
 *
 *   field  a 400×400 plane at 1.25-unit resolution, every vertex lifted to
 *          `surface.sampleHeight` (the Surface seam, src/world/surface.ts —
 *          nothing here derives a height of its own) and re-normalled.
 *   far    a flat ring from the field's rim out to 1400.
 *
 * WHY THE FAR FIELD IS NOT PART OF THE PLANE [D]: it exists only so that no
 * orbit or pan reveals the void past the world, and a 1400-radius plane at
 * the field's density would be ~10 million triangles for ground nobody
 * looks at. The terrain is exactly 0 past TERRAIN.farEnd (185) by
 * construction, so everything outside the field is one flat sheet and a
 * couple of hundred triangles draw it.
 *
 * WHY THE NORMALS MATTER: the terraces read only because of them. The ink
 * pass hatches faces turned away from the key and draws a contour wherever
 * the normal target creases, so a correctly-normalled mesh draws its own
 * risers — there is no separate elevation pass anywhere.
 *
 * WHY A RING RATHER THAN THE DISC THAT USED TO BE HERE [D]: the terraced
 * land runs from about -3.1 to +8, so a full disc at y=0 under the field
 * would cover every basin on the map — the lake floor included — with a
 * sheet of paper. The ring's inner edge sits at the field's rim, where the
 * terrain is already exactly 0, so the two meet at the same value with no
 * seam to hide and no coplanar fight to lose.
 *
 * A ring rather than a rectangle: if a viewport ever reaches the edge of
 * the world, the silhouette it sees is round, not rectilinear (TASTE §3).
 * Its radius far exceeds the pannable region.
 */

import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry } from 'three';
import { SURFACE } from '../taste/tokens';
import type { Surface } from './surface';

/** Outer radius of the flat far field. */
const GROUND_RADIUS = 1400;
const GROUND_SEGMENTS = 96;

/**
 * Side of the displaced field, world units: ±200 in x and z. Comfortably
 * past TERRAIN.farEnd, so the rim is flat land and not a cut through a tier.
 */
export const FIELD_SIZE = 400;
/**
 * Segments per side — 1.25 units a quad, ~205k triangles. A ceiling, not a
 * starting point [D]: the terrace risers are the finest thing on the map
 * and a few units of run each, so this puts several vertices across one,
 * and doubling it quadruples both the build and the draw for a shape the
 * ink pass would render the same.
 */
export const FIELD_SEGMENTS = 320;

export interface Ground {
  /** Both meshes, ready to add to the scene. */
  group: Group;
  /** The ONE material they share — the dev color grade recolors just this. */
  material: MeshBasicMaterial;
}

export function createGround(surface: Surface): Ground {
  const group = new Group();
  group.name = 'ground';
  // One material for both meshes: the paper is one value by construction, so
  // a color grade cannot pull the field and the horizon apart (scene.ts's
  // setBackgroundColor writes this single color).
  const material = new MeshBasicMaterial({ color: SURFACE.ground });

  const field = new PlaneGeometry(FIELD_SIZE, FIELD_SIZE, FIELD_SEGMENTS, FIELD_SEGMENTS);
  // Laid flat first, so the attribute holds world x/z and the height sample
  // reads straight off it — no local-space bookkeeping in between.
  field.rotateX(-Math.PI / 2);
  const position = field.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    position.setY(i, surface.sampleHeight(position.getX(i), position.getZ(i)));
  }
  position.needsUpdate = true;
  // After the displacement, never before: these normals ARE the terraces.
  field.computeVertexNormals();
  const fieldMesh = new Mesh(field, material);
  fieldMesh.name = 'ground-field';
  group.add(fieldMesh);

  const far = new RingGeometry(FIELD_SIZE / 2, GROUND_RADIUS, GROUND_SEGMENTS);
  far.rotateX(-Math.PI / 2);
  const farMesh = new Mesh(far, material);
  farMesh.name = 'ground-far';
  // The ring's inner edge is inscribed in the circle the square field's rim
  // circumscribes, so the two OVERLAP (the field's corners reach past it)
  // rather than leaving a gap. Both are flat and the same value out here, so
  // the overlap is invisible — a gap would not have been.
  farMesh.position.y = 0;
  group.add(farMesh);

  return { group, material };
}
