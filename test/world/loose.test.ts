/**
 * `createLooseMeshes` — drawing the things that are no longer scenery.
 *
 * The scatter cannot draw a prop it has been told to stop drawing, so
 * something has to draw the tree lying in the field, and it has to be the
 * SAME layer on a projection and on a phone that runs no physics at all.
 *
 * Headless: a real `Scene` and real `BufferGeometry`, no renderer. What is
 * being pinned is the scene graph and the buffers, which is all this module
 * touches.
 */

import { BufferAttribute, BufferGeometry, InstancedBufferAttribute, Mesh, Scene } from 'three';
import { MeshStandardMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createLooseMeshes } from '../../src/world/loose';
import type { PropKind } from '../../src/world/props';
import type { Scatter } from '../../src/world/scatter';

/** A source geometry shaped like the scatter's: positions, a per-vertex
 * `aWindHeight`, and INSTANCED attributes a plain mesh must not inherit. */
function sourceGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aWindHeight', new BufferAttribute(new Float32Array([0, 0, 1]), 1));
  geometry.setAttribute('aVariation', new InstancedBufferAttribute(new Float32Array(4), 4));
  geometry.setAttribute('aBend', new InstancedBufferAttribute(new Float32Array(2), 2));
  return geometry;
}

function stubScatter(): { scatter: Scatter; material: MeshStandardMaterial; source: BufferGeometry } {
  const material = new MeshStandardMaterial();
  const source = sourceGeometry();
  const scatter = {
    geometryFor: (_kind: PropKind, variant: number) => (variant === 0 ? source : null),
    materialFor: () => material,
  } as unknown as Scatter;
  return { scatter, material, source };
}

describe('createLooseMeshes', () => {
  it('adds one mesh to the scene per item, and takes it away again', () => {
    const scene = new Scene();
    const { scatter } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    expect(scene.children.length).toBe(0);
    loose.show('tree:0:1.00:2.00', 'tree', 0, 1.4);
    expect(scene.children.length).toBe(1);
    loose.show('tree:0:3.00:4.00', 'tree', 0, 1);
    expect(scene.children.length).toBe(2);
    loose.remove('tree:0:1.00:2.00');
    expect(scene.children.length).toBe(1);
    expect(loose.get('tree:0:1.00:2.00')).toBeUndefined();
    loose.dispose();
  });

  it('is idempotent per item — a replayed log cannot leak two of the same thing', () => {
    const scene = new Scene();
    const { scatter } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    const first = loose.show('rock:0:0.00:0.00', 'rock', 0, 1);
    const second = loose.show('rock:0:0.00:0.00', 'rock', 0, 9);
    expect(second).toBe(first);
    expect(scene.children.length).toBe(1);
    loose.dispose();
  });

  it('shares the scatter material — a fallen tree is the same green', () => {
    const scene = new Scene();
    const { scatter, material } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    const mesh = loose.show('tree:0:1.00:2.00', 'tree', 0, 1) as Mesh;
    expect(mesh.material).toBe(material);
    loose.dispose();
  });

  it('clones the geometry and lays PLAIN buffers over the instanced names', () => {
    const scene = new Scene();
    const { scatter, source } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    const mesh = loose.show('tree:0:1.00:2.00', 'tree', 0, 1) as Mesh;
    const geometry = mesh.geometry;
    expect(geometry).not.toBe(source);
    const variation = geometry.getAttribute('aVariation');
    const bend = geometry.getAttribute('aBend');
    // Not instanced — a plain `Mesh` drawn with an instanced attribute reads
    // garbage or refuses to compile depending on the driver.
    expect(variation instanceof InstancedBufferAttribute).toBe(false);
    expect(bend instanceof InstancedBufferAttribute).toBe(false);
    // One value per vertex, not one per instance.
    expect(variation.count).toBe(3);
    expect(bend.count).toBe(3);
    // Neutral, not zero: zero would shrink every fallen prop at the instant
    // it fell, because the shader reads each component as `value - 0.5`.
    expect(variation.getX(0)).toBeCloseTo(0.5, 6);
    // The recoil channel is zero, and that is correct rather than merely
    // safe: a thing lying on the ground has no spring in it to kick.
    expect(bend.getX(0)).toBe(0);
    // And the per-vertex wind height rode along with the clone untouched.
    expect(geometry.getAttribute('aWindHeight').getX(2)).toBe(1);
    loose.dispose();
  });

  it('shares ONE geometry clone between two items of the same shape', () => {
    const scene = new Scene();
    const { scatter } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    const a = loose.show('tree:0:1.00:2.00', 'tree', 0, 1) as Mesh;
    const b = loose.show('tree:0:5.00:6.00', 'tree', 0, 2) as Mesh;
    expect(b.geometry).toBe(a.geometry);
    loose.dispose();
  });

  it('applies the instance scale, and moves an item where it is told', () => {
    const scene = new Scene();
    const { scatter } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    const mesh = loose.show('tree:0:1.00:2.00', 'tree', 0, 1.4) as Mesh;
    expect(mesh.scale.x).toBeCloseTo(1.4, 6);
    loose.move('tree:0:1.00:2.00', 3, 4, 5, { x: 0, y: 0.7071, z: 0, w: 0.7071 });
    expect(mesh.position.toArray()).toEqual([3, 4, 5]);
    expect(mesh.quaternion.y).toBeCloseTo(0.7071, 4);
    loose.dispose();
  });

  it('ignores a move or a remove for an item it has never shown', () => {
    const scene = new Scene();
    const { scatter } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    expect(() => loose.move('nope', 1, 2, 3, { x: 0, y: 0, z: 0, w: 1 })).not.toThrow();
    expect(() => loose.remove('nope')).not.toThrow();
    expect(scene.children.length).toBe(0);
    loose.dispose();
  });

  it('still shows something for a variant the scatter has no geometry for', () => {
    // A key off the wire naming a variant this build does not have: better a
    // mesh with no geometry than a thrown exception in the apply path, which
    // would take the rest of the batch with it.
    const scene = new Scene();
    const { scatter } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    expect(() => loose.show('tree:7:1.00:2.00', 'tree', 7, 1)).not.toThrow();
    expect(scene.children.length).toBe(1);
    loose.dispose();
  });

  it('empties the scene on dispose', () => {
    const scene = new Scene();
    const { scatter } = stubScatter();
    const loose = createLooseMeshes(scatter, scene);
    loose.show('tree:0:1.00:2.00', 'tree', 0, 1);
    loose.show('tree:0:3.00:4.00', 'tree', 0, 1);
    loose.dispose();
    expect(scene.children.length).toBe(0);
    expect(loose.get('tree:0:1.00:2.00')).toBeUndefined();
  });
});
