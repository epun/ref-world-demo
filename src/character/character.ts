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

import { Group, Mesh, Quaternion, Vector3 } from 'three';
import { inflate } from '../inflate/inflate';
import { sampleDrift } from '../motion/ambient';
import { Spring } from '../motion/spring';
import type { EmoteName } from '../net/protocol';
import { analyze } from '../shape/analyze';
import type { ShapeAnalysis, StrokeList } from '../shape/types';
import { MOTION } from '../taste/tokens';
import { applyDeform, deformPoint, heightFrac, type DeformState } from './deform';
import { runEmote, type EmoteRun } from './emotes';
import { createEyes } from './eyes';
import type { Expression, ExpressionName } from './expressions';
import { createCharacterMaterial, deformFrameOf, toBufferGeometry } from './mesh';
import { computeEyePlacement } from './placement';

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
  /** Glide the eyes to an expression (springs retarget, never snap). */
  setExpression(e: ExpressionName | Expression): void;
  /**
   * Play an emote: whole-body deformation + matching eye expression. A new
   * emote interrupts cleanly — the body springs retarget mid-flight, nothing
   * snaps. After the last keypoint everything drifts back to neutral and
   * settles into the ambient floor.
   */
  emote(name: EmoteName): void;
  /** Apply the ambient drift floor and advance the eyes. Call once per frame. */
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
  // Whole-body deformation (PLAN §3.5): squash/lean/twist/reach uniforms
  // injected into the vertex shader, bending the mesh about its base.
  const frame = deformFrameOf(geometry);
  const deform = applyDeform(material, frame);

  const mesh = new Mesh(geometry, material);
  mesh.scale.setScalar(scale);
  // Rest on the ground: bounding-box min.y lands exactly at y = 0.
  mesh.position.y = -box.min.y * scale;
  const yOff = mesh.position.y;

  const group = new Group();
  group.add(mesh);

  // Eyes: computed in inflate-local space, scaled up to match the mesh, and
  // lifted by the same ground offset so they sit on the scaled body surface.
  const eyes = createEyes(analysis, scale);
  eyes.group.position.y = yOff;
  group.add(eyes.group);

  // The eye pair rides the deformed body: its rest anchor (the pair midpoint,
  // in the mesh's object space) is pushed through deformPoint each frame with
  // the CURRENT uniform values, and the group is rotated by the deformation's
  // pure rotations at the anchor height — so the caps track the head exactly
  // where the vertex shader puts it.
  const placement = computeEyePlacement(analysis);
  const anchor = {
    x: (placement.left.x + placement.right.x) / 2,
    y: (placement.left.y + placement.right.y) / 2,
    z: (placement.left.z + placement.right.z) / 2,
  };
  const anchorH = heightFrac(anchor.y, frame);
  const X_AXIS = new Vector3(1, 0, 0);
  const Y_AXIS = new Vector3(0, 1, 0);
  const Z_AXIS = new Vector3(0, 0, 1);
  const qx = new Quaternion();
  const qy = new Quaternion();
  const qz = new Quaternion();
  const eyeRot = new Quaternion();
  const anchorRest = new Vector3();

  // One ζ≥1 spring per deform channel. Squash is the attack channel (the
  // quick dip in happy/angry) and settles a step faster; the rest drift at
  // the secondary settle. Emotes retarget these; nothing else touches them.
  const springs = {
    squash: new Spring(1, { settleMs: MOTION.tertiaryMs }),
    leanX: new Spring(0, { settleMs: MOTION.secondaryMs }),
    leanZ: new Spring(0, { settleMs: MOTION.secondaryMs }),
    twist: new Spring(0, { settleMs: MOTION.secondaryMs }),
    reach: new Spring(0, { settleMs: MOTION.secondaryMs }),
  };
  let emoteRun: EmoteRun | null = null;

  /** Push spring state to the GPU and carry the eye caps along with it. */
  function applyBodyState(state: DeformState): void {
    deform.set(state);

    // Rigid head frame anchored at the pair midpoint: rotation = the
    // deformation's twist∘leanX∘leanZ at the anchor's height (same order as
    // deformPoint), position solved so the anchor lands exactly on its
    // deformed image. Approximate for the individual caps — and fine (the
    // eyes track the deformed head; PLAN §3.4 keeps them proud of the body).
    qy.setFromAxisAngle(Y_AXIS, state.twist * anchorH);
    qx.setFromAxisAngle(X_AXIS, state.leanX * anchorH);
    qz.setFromAxisAngle(Z_AXIS, state.leanZ * anchorH);
    eyeRot.copy(qz).multiply(qx).multiply(qy);
    eyes.group.quaternion.copy(eyeRot);

    const d = deformPoint(anchor, state, frame);
    anchorRest.set(anchor.x, anchor.y, anchor.z).multiplyScalar(scale).applyQuaternion(eyeRot);
    eyes.group.position.set(
      d.x * scale - anchorRest.x,
      yOff + d.y * scale - anchorRest.y,
      d.z * scale - anchorRest.z,
    );
  }

  const radius =
    (Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2) * scale * SHADOW_FIT;

  const seed = driftSeed(strokes);
  const worldHeight = height * scale;

  return {
    group,
    radius,
    analysis,
    setExpression(e: ExpressionName | Expression): void {
      eyes.setExpression(e);
    },
    emote(name: EmoteName): void {
      // Replacing the run IS the interruption: the new script retargets the
      // same springs mid-flight, so position and velocity carry over.
      emoteRun = runEmote(springs, name, {
        onExpression: (e) => eyes.setExpression(e),
      });
    },
    update(dt: number, nowMs: number): void {
      // Ambient drift only — no idle bob, nothing that reads as bounce.
      // Nonzero motion over any 2s idle sample (stillness probe).
      const drift = sampleDrift(nowMs, seed, worldHeight);
      group.position.set(drift.x, 0, drift.y);
      group.rotation.y = drift.rot;

      // Emote scheduler → spring retargets → uniforms + eye carry. The
      // springs advance every frame regardless, so a finished emote keeps
      // drifting home and then rests at neutral under the ambient floor.
      if (emoteRun?.update(dt)) emoteRun = null;
      applyBodyState({
        squash: springs.squash.update(dt),
        leanX: springs.leanX.update(dt),
        leanZ: springs.leanZ.update(dt),
        twist: springs.twist.update(dt),
        reach: springs.reach.update(dt),
      });

      eyes.update(dt);
    },
    dispose(): void {
      group.remove(eyes.group);
      eyes.dispose();
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      springs.squash.dispose();
      springs.leanX.dispose();
      springs.leanZ.dispose();
      springs.twist.dispose();
      springs.reach.dispose();
    },
  };
}
