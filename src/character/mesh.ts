/**
 * The bridge between the pure inflation pipeline and Three.js — the ONLY
 * place InflatedMesh output meets a renderer type. src/inflate/ stays free of
 * Three.js so the phone and the world get byte-identical geometry (PLAN §6.3);
 * this module wraps those typed arrays without editorializing.
 */

import { BufferAttribute, BufferGeometry, MeshPhysicalMaterial } from 'three';
import type { InflatedMesh } from '../inflate/types';
import { CHARACTER } from '../taste/tokens';

/**
 * Wrap inflate() output into a BufferGeometry. The typed arrays are adopted
 * directly — positions, normals, and index come straight from the module.
 * Normals are NOT recomputed: the inflater already emits smooth area-weighted
 * normals, and re-deriving them here could only diverge from what the phone
 * renders.
 */
export function toBufferGeometry(mesh: InflatedMesh): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * The character surface (PLAN §3.3): the one near-black on screen, with the
 * quiet clearcoat gloss both briefs pair with muted saturation. Same recipe
 * as the P0 test blob — 38/100 material realism, not a chrome ball.
 */
export function createCharacterMaterial(): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: CHARACTER.body,
    roughness: 0.35,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.15,
  });
}
