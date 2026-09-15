/**
 * The creature brief's rig (docs/taste/creature.md): a stalk from the crown
 * ending in a topper that IS the drawing, on a body painted in the drawing's
 * own colourway. Everything here is deterministic — same strokes, same rig.
 */

import { Box3, Group, Mesh, MeshPhysicalMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createCharacter } from '../../src/character/character';
import { PALETTE_NAMES } from '../../src/character/palette';
import { snowman } from '../fixtures/strokes';

function topperGroup(object: Group): Group {
  const found = object.getObjectByName('topper');
  expect(found).toBeInstanceOf(Group);
  return found as Group;
}

function bodyMesh(group: Group): Mesh {
  const mesh = group.children.find((o): o is Mesh => o instanceof Mesh);
  expect(mesh).toBeDefined();
  return mesh!;
}

function bodyBox(group: Group): Box3 {
  group.updateMatrixWorld(true);
  const mesh = bodyMesh(group);
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
}

describe('creature topper', () => {
  it('gives every creature a stalk and a topper', () => {
    const character = createCharacter(snowman);
    expect(character).not.toBeNull();
    if (!character) return;
    try {
      const topper = topperGroup(character.group);
      const meshes = topper.children.filter((o): o is Mesh => o instanceof Mesh);
      // Two: the stalk tube and the drawing on its end.
      expect(meshes).toHaveLength(2);
      for (const mesh of meshes) {
        expect(mesh.geometry.getAttribute('position')!.count).toBeGreaterThan(0);
      }
      // The body is still the group's first Mesh child — the whole world
      // finds it that way.
      expect(character.group.children[0]).toBe(bodyMesh(character.group));
    } finally {
      character.dispose();
    }
  });

  it('sprouts from the crown, above the body', () => {
    const character = createCharacter(snowman);
    expect(character).not.toBeNull();
    if (!character) return;
    try {
      character.group.updateMatrixWorld(true);
      const body = bodyBox(character.group);
      const rig = new Box3().setFromObject(topperGroup(character.group));
      // The whole rig lives in the top of the creature: nothing of it hangs
      // into the body's lower 60%.
      expect(rig.min.y).toBeGreaterThanOrEqual(0.6 * body.max.y);
      // And it reaches above the body — the stalk is a stalk, not a hat.
      expect(rig.max.y).toBeGreaterThan(body.max.y);
    } finally {
      character.dispose();
    }
  });

  it('is deterministic: same strokes, same rig', () => {
    const a = createCharacter(snowman)!;
    const b = createCharacter(snowman)!;
    try {
      const positions = (c: typeof a): number[][] =>
        topperGroup(c.group)
          .children.filter((o): o is Mesh => o instanceof Mesh)
          .map((m) => Array.from(m.geometry.getAttribute('position')!.array as Float32Array));
      expect(positions(a)).toEqual(positions(b));
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('paints the body in its colourway', () => {
    const character = createCharacter(snowman);
    expect(character).not.toBeNull();
    if (!character) return;
    try {
      expect(PALETTE_NAMES).toContain(character.palette.name);
      const material = bodyMesh(character.group).material as MeshPhysicalMaterial;
      expect(material.color.getHexString()).toBe(character.palette.body.replace('#', ''));
    } finally {
      character.dispose();
    }
  });
});
