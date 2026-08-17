/**
 * The ground (PLAN §7, TASTE §2.2): a flat plane at y=0, colored exactly
 * SURFACE.ground — mid-toned neutral grey targeting groundLuma 0.74.
 *
 * MeshStandardMaterial rather than Basic so the hard key light exists in the
 * frame, but roughness 1 / metalness 0 keeps the field reading as one
 * near-flat value. No grid helper, no texture — open ground is the design.
 *
 * A disc rather than a rectangle: if a viewport ever reaches the edge of the
 * world, the silhouette it sees is round, not rectilinear (TASTE §3).
 */

import { CircleGeometry, Mesh, MeshStandardMaterial } from 'three';
import { SURFACE } from '../taste/tokens';

const GROUND_RADIUS = 400;
const GROUND_SEGMENTS = 96;

export function createGround(): Mesh {
  const geometry = new CircleGeometry(GROUND_RADIUS, GROUND_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshStandardMaterial({
    color: SURFACE.ground,
    roughness: 1,
    metalness: 0,
  });
  const ground = new Mesh(geometry, material);
  ground.position.y = 0;
  return ground;
}
