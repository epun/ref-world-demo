/**
 * createCharacter: the analyze → inflate → Three.js bridge. Uses the shared
 * stroke fixtures; everything is deterministic, so exact-ish assertions are
 * safe.
 */

import { Box3, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_HEIGHT,
  createCharacter,
  type Character,
} from '../../src/character/character';
import { MOTION } from '../../src/taste/tokens';
import { circleBlob, snowman } from '../fixtures/strokes';

describe('createCharacter', () => {
  it('returns null when analyze rejects the drawing', () => {
    expect(createCharacter([])).toBeNull();
    // A stray dot: under the degenerate-ink threshold.
    expect(createCharacter([{ pts: [[0.5, 0.5, 1]], w: 0.002 }])).toBeNull();
  });

  it('builds a grounded character at ~3.5 world units', () => {
    const character = createCharacter(snowman);
    expect(character).not.toBeNull();
    if (!character) return;

    const box = new Box3().setFromObject(character.group);
    const height = box.max.y - box.min.y;
    expect(height).toBeCloseTo(CHARACTER_HEIGHT, 3);
    // Resting on the ground: bbox min.y at y = 0.
    expect(box.min.y).toBeCloseTo(0, 3);

    // Footprint: positive, and inside the world-space x/z extent.
    const footprint = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
    expect(character.radius).toBeGreaterThan(0);
    expect(character.radius).toBeLessThanOrEqual(footprint + 1e-6);

    // The analysis rides along for later modules (eyes, gait). Archetype
    // tuning at production resolution belongs to the shape tests; here we
    // only assert the analysis is present and coherent.
    expect(['blob', 'biped', 'quadruped', 'bird']).toContain(character.analysis.archetype);
    expect(character.analysis.contour.length).toBeGreaterThan(0);

    character.dispose();
  });

  it('scales by worldScale', () => {
    const character = createCharacter(circleBlob, 2);
    expect(character).not.toBeNull();
    if (!character) return;
    const box = new Box3().setFromObject(character.group);
    expect(box.max.y - box.min.y).toBeCloseTo(CHARACTER_HEIGHT * 2, 3);
    character.dispose();
  });

  it('applies deterministic ambient drift in update()', () => {
    const a = createCharacter(snowman);
    const b = createCharacter(snowman);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) return;

    a.update(16, 1234);
    b.update(16, 1234);
    // Same strokes → same seed → identical drift on every device.
    expect(a.group.position.x).toBe(b.group.position.x);
    expect(a.group.position.z).toBe(b.group.position.z);
    expect(a.group.rotation.y).toBe(b.group.rotation.y);

    // Nonzero motion over an idle sample (stillness probe), bounded by the
    // ambient amplitude — a drift floor, not a wander.
    a.update(16, 3234);
    const moved = Math.hypot(
      a.group.position.x - b.group.position.x,
      a.group.position.z - b.group.position.z,
    );
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(CHARACTER_HEIGHT * MOTION.ambientAmplitude * 4);
  });

  it('identity salt: two ids differ, same id matches, no id stays compat', () => {
    const positionsOf = (c: Character): number[] => {
      const mesh = c.group.children.find((o): o is Mesh => o instanceof Mesh);
      expect(mesh).toBeDefined();
      return Array.from(mesh!.geometry.getAttribute('position')!.array as Float32Array);
    };
    const a = createCharacter(snowman, 1, { identity: 'feed-aaaa111' })!;
    const b = createCharacter(snowman, 1, { identity: 'feed-bbbb222' })!;
    const a2 = createCharacter(snowman, 1, { identity: 'feed-aaaa111' })!;
    const plain = createCharacter(snowman)!;
    const plainEmptyOpts = createCharacter(snowman, 1, {})!;
    try {
      // Same drawing, two publish ids → two distinct bodies.
      expect(positionsOf(a)).not.toEqual(positionsOf(b));
      // Same id (phone portrait vs world creature) → the identical mesh.
      expect(positionsOf(a)).toEqual(positionsOf(a2));
      // No identity → byte-identical to the pre-salt pipeline; the salted
      // build really is a different individual from the unsalted one.
      expect(positionsOf(plain)).toEqual(positionsOf(plainEmptyOpts));
      expect(positionsOf(a)).not.toEqual(positionsOf(plain));
    } finally {
      for (const c of [a, b, a2, plain, plainEmptyOpts]) c.dispose();
    }
  });
});
