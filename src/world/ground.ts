/**
 * The ground (PLAN §7, TASTE §2.2): a flat plane at y=0, colored exactly
 * SURFACE.ground — mid-toned neutral grey targeting groundLuma 0.74.
 *
 * UNLIT (MeshBasicMaterial): the field renders exactly its token at every
 * viewing angle. A lit ground's luma drifted with the orbit elevation and
 * straddled a toon-quantize band boundary, turning the dither into huge
 * camo blotches when the user rotated (user report). Flat paper is the
 * design; the environment engine's exposure still dims it at night in the
 * post pass, and hatching keys off the normal target, not the lit color.
 *
 * A disc rather than a rectangle: if a viewport ever reaches the edge of
 * the world, the silhouette it sees is round, not rectilinear (TASTE §3).
 * Radius far exceeds the pannable region so no orbit or pan reveals the
 * void beyond the plane.
 */

import { CircleGeometry, Mesh, MeshBasicMaterial } from 'three';
import { SURFACE } from '../taste/tokens';

const GROUND_RADIUS = 1400;
const GROUND_SEGMENTS = 96;

export function createGround(): Mesh {
  const geometry = new CircleGeometry(GROUND_RADIUS, GROUND_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({ color: SURFACE.ground });
  const ground = new Mesh(geometry, material);
  ground.position.y = 0;
  return ground;
}
