/**
 * World entry point.
 *
 * Starts the P0 world and places one test object so the frame is verifiable
 * against the taste: an organic blob — an icosphere with deterministic vertex
 * noise, smooth-shaded, nothing rectilinear — in the character body value
 * with the clearcoat gloss both briefs pair with muted saturation. It carries
 * a flat stamped contact shadow and rides the ambient drift floor: no bob, no
 * bounce, and never a full stop.
 */

import { IcosahedronGeometry, Mesh, MeshPhysicalMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleDrift } from './motion/ambient';
import { CHARACTER } from './taste/tokens';
import { start } from './world/scene';

const BLOB_RADIUS = 1.8;
const BLOB_NOISE = 0.09;
const BLOB_SEED = 7.31;

/** Smooth deterministic scalar field — a few low-frequency lobes, so the
 * displaced sphere reads as a hand-formed potato, never a primitive. */
function organicNoise(x: number, y: number, z: number): number {
  return (
    Math.sin(x * 1.7 + y * 1.1 + 0.9) * 0.5 +
    Math.sin(y * 1.9 + z * 1.3 + 2.1) * 0.3 +
    Math.sin(z * 1.5 + x * 2.1 + 4.2) * 0.2
  );
}

function createBlobGeometry(): BufferGeometry {
  // mergeVertices welds the icosahedron's duplicated verts so
  // computeVertexNormals yields smooth shading — no facets, no hard edges.
  const geometry = mergeVertices(new IcosahedronGeometry(BLOB_RADIUS, 4));
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const scale = 1 + BLOB_NOISE * organicNoise(x, y, z);
    position.setXYZ(i, x * scale, y * scale, z * scale);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function main(): void {
  const canvas = document.getElementById('world');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('missing #world canvas');
  }

  const world = start(canvas);

  // The one near-black object on screen (TASTE §1), with the quiet gloss.
  const geometry = createBlobGeometry();
  const blob = new Mesh(
    geometry,
    new MeshPhysicalMaterial({
      color: CHARACTER.body,
      roughness: 0.35,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.15,
    }),
  );
  const restY = -(geometry.boundingBox?.min.y ?? -BLOB_RADIUS);
  blob.position.set(0, restY, 0);
  world.scene.add(blob);

  const shadow = world.shadows.addShadow('test-blob', BLOB_RADIUS * 0.85);

  world.cameraRig.frameAt(blob.position);

  // Ambient drift only — no idle bob, no loops that read as bounce. The
  // stillness probe wants nonzero motion over any 2s idle sample; this is it.
  world.onFrame((_dt, nowMs) => {
    const drift = sampleDrift(nowMs, BLOB_SEED, BLOB_RADIUS * 2);
    blob.position.set(drift.x, restY, drift.y);
    blob.rotation.y = drift.rot;
    shadow.setPosition(blob.position.x, blob.position.z);
  });
}

main();
