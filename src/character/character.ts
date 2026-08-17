/**
 * Drawing → standing character (PLAN §3, P1).
 *
 * Runs the pure pipeline (analyze → inflate), wraps the result into a
 * THREE.Group scaled to world size and resting on the ground, and rides the
 * ambient drift floor exactly like the P0 test blob: position x/z and
 * rotation.y from sampleDrift, seeded deterministically from the stroke data
 * — no Math.random, so two devices drift the same character identically.
 *
 * The analysis result is kept on the Character for the modules that follow
 * (eyes anchor on headLobe, gait on archetype/features).
 */

import { Group, Mesh } from 'three';
import { inflate } from '../inflate/inflate';
import { sampleDrift } from '../motion/ambient';
import { analyze } from '../shape/analyze';
import type { ShapeAnalysis, StrokeList } from '../shape/types';
import { createCharacterMaterial, toBufferGeometry } from './mesh';

/** Target character height in world units. Characters render small —
 * "scale is the subject" (PLAN §7). */
export const CHARACTER_HEIGHT = 3.5;

/** Shadow stamp sits a touch inside the footprint, like the test blob's. */
const SHADOW_FIT = 0.85;

export interface Character {
  /** Add to the scene; position/rotation are owned by update(). */
  group: Group;
  /** Footprint radius in world units, for the flat shadow stamp. */
  radius: number;
  /** The shape analysis, kept for later modules (eyes, gait). */
  analysis: ShapeAnalysis;
  /** Apply the ambient drift floor. Call once per frame. */
  update(dt: number, nowMs: number): void;
  /** Release GPU resources. Remove the group from the scene first. */
  dispose(): void;
}

/**
 * Deterministic per-character drift seed from the stroke data itself
 * (point count + first point coordinates). Same drawing → same seed on
 * every device; different drawings decorrelate their drift channels.
 */
function driftSeed(strokes: StrokeList): number {
  let points = 0;
  for (const stroke of strokes) points += stroke.pts.length;
  const first = strokes[0]?.pts[0];
  const fx = first ? first[0] : 0;
  const fy = first ? first[1] : 0;
  return (points % 971) * 0.618 + fx * 37.42 + fy * 91.17;
}

/**
 * Build a character from a stroke list. Returns null when the drawing
 * carries no usable ink (analyze() rejects it) — the caller keeps the draw
 * screen open.
 *
 * @param worldScale multiplies the ~3.5-unit target height.
 */
export function createCharacter(strokes: StrokeList, worldScale = 1): Character | null {
  const analysis = analyze(strokes);
  if (!analysis) return null;

  const geometry = toBufferGeometry(inflate(analysis));
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) {
    // Inflation produced no triangles (degenerate contour): treat like a
    // failed analysis so the caller keeps the draw screen open.
    geometry.dispose();
    return null;
  }

  const height = Math.max(box.max.y - box.min.y, 1e-6);
  const scale = (CHARACTER_HEIGHT / height) * worldScale;

  const material = createCharacterMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.scale.setScalar(scale);
  // Rest on the ground: bounding-box min.y lands exactly at y = 0.
  mesh.position.y = -box.min.y * scale;

  const group = new Group();
  group.add(mesh);

  const radius =
    (Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2) * scale * SHADOW_FIT;

  const seed = driftSeed(strokes);
  const worldHeight = height * scale;

  return {
    group,
    radius,
    analysis,
    update(_dt: number, nowMs: number): void {
      // Ambient drift only — no idle bob, nothing that reads as bounce.
      // Nonzero motion over any 2s idle sample (stillness probe).
      const drift = sampleDrift(nowMs, seed, worldHeight);
      group.position.set(drift.x, 0, drift.y);
      group.rotation.y = drift.rot;
    },
    dispose(): void {
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
