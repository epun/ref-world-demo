/**
 * Drawing → standing character (PLAN §3, P1 + the interpretation pass).
 *
 * Runs the pure pipeline (interpret → inflate): the drawing is analyzed,
 * its motifs reproportion its own silhouette (GENERATOR §1a — the drawing's
 * shape, filled and chunkified), and THAT silhouette is inflated. The stored
 * analysis is of the processed body, so eyes and deformation land on the
 * actual mesh. The body itself is the recognition: one solid near-black mass
 * with a single eye, nothing printed on it. The verbatim path remains at
 * fidelity 0.
 *
 * The group rides the ambient drift floor exactly like the P0 test blob:
 * position x/z and rotation.y from sampleDrift, seeded deterministically
 * from the ORIGINAL stroke data — no Math.random, so two devices drift the
 * same character identically.
 */

import { Group, Mesh } from 'three';
import { inflate } from '../inflate/inflate';
import { sampleDrift } from '../motion/ambient';
import { Spring } from '../motion/spring';
import type { EmoteName } from '../net/protocol';
import type { ShapeAnalysis, StrokeList } from '../shape/types';
import { MOTION } from '../taste/tokens';
import { createBubble } from './bubble';
import { applyDeform, NEUTRAL_GAIT, type GaitState } from './deform';
import { createBlendshellCharacter } from './blendshell/build';
import { runEmote, type EmoteRun } from './emotes';
import { createGait } from './gait';
import { applyEyes } from './eyes';
import type { Expression, ExpressionName } from './expressions';
import { identitySeedOf, interpretDrawing } from './interpret';
import { createCharacterMaterial, deformFrameOf, toBufferGeometry } from './mesh';

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
  /**
   * Feed the agent's current ground speed (world units/s) and heading
   * (radians). Drives the gait layer: the walk cycle blends in with speed
   * and completes its last half-step when speed returns to zero.
   */
  setLocomotion(speed: number, heading: number): void;
  /**
   * Feed the current world-units-per-screen-pixel (frustum height / viewport
   * height / zoom) so the speech bubble can hold its screen-space legibility
   * floor (QA audit D4). Optional: headless callers and older constructions
   * may not implement it, and without the feed the bubble stays purely
   * world-proportional.
   */
  setWorldUnitsPerPixel?(v: number): void;
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

export interface CharacterOptions {
  /**
   * Interpretation fidelity (GENERATOR §1): 1 (default) = species body
   * synthesized from the drawing's motifs; 0 = verbatim inflation of the
   * drawing (the dial's dev-tunable floor).
   */
  fidelity?: number;
  /**
   * Body construction (docs/BLENDSHELL.md step 6): 'inflate' (default,
   * shipping) inflates the synthesized silhouette; 'blendshell' builds the
   * SDF blend-shell body with IK stepping — behind this flag until visual
   * review flips the default.
   *
   * Dev override (smokes/dev tools only — main.ts stays untouched): setting
   * `globalThis.__refworldConstruction = 'blendshell'` flips the DEFAULT for
   * callers that don't pass this option. An explicit option always wins.
   */
  construction?: 'inflate' | 'blendshell';
  /**
   * Stable identity id (the drawing's publish id / slot id). Salts the
   * within-band synthesis jitter, eye shape/size, and the drift/bubble seed
   * so no two submissions look the same — even from the SAME drawing. Motif counts and angles stay drawing-driven. The phone and
   * the world pass the same id for the same submission, so both render the
   * identical creature. Absent → seeded purely from the strokes (compat).
   */
  identity?: string;
}

/**
 * Build a character from a stroke list. Returns null when the drawing
 * carries no usable ink (analyze() rejects it) — the caller keeps the draw
 * screen open.
 *
 * @param worldScale multiplies the ~3.5-unit target height.
 */
export function createCharacter(
  strokes: StrokeList,
  worldScale = 1,
  options: CharacterOptions = {},
): Character | null {
  // Construction flag resolution: explicit option > dev override > 'inflate'.
  const override = (globalThis as { __refworldConstruction?: unknown }).__refworldConstruction;
  const construction =
    options.construction ?? (override === 'blendshell' ? 'blendshell' : 'inflate');
  if (construction === 'blendshell') {
    return createBlendshellCharacter(strokes, worldScale);
  }

  // Identity salt: hash the stable id when the caller supplies one; without
  // it every seed below falls back to the stroke data alone (compat).
  const identitySeed =
    options.identity === undefined ? undefined : identitySeedOf(options.identity);

  const interpreted = interpretDrawing(strokes, options.fidelity ?? 1, {}, identitySeed);
  if (!interpreted) return null;
  // The synthesized body's analysis: eyes, deformation, and gait all read
  // the silhouette that actually exists.
  const analysis = interpreted.analysis;

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
  // The eye: painted INTO the same material (no cap geometry to catch the
  // free-orbit camera edge-on). Chained after deform; because its
  // projection reads the undeformed position, it rides every squash / lean /
  // twist / gait exactly where the vertex shader puts the surface.
  const eyes = applyEyes(material, analysis, identitySeed);

  const mesh = new Mesh(geometry, material);
  mesh.scale.setScalar(scale);
  // Rest on the ground: bounding-box min.y lands exactly at y = 0.
  mesh.position.y = -box.min.y * scale;

  const group = new Group();
  group.add(mesh);

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

  // Gait layer (./gait.ts): phase/amplitude from the agent's reported speed,
  // composed ADDITIVELY with the emote springs — the two never fight over a
  // channel. archetype picks the stride character (waddle vs undulation).
  const gait = createGait(analysis.archetype);
  let gaitState: GaitState = NEUTRAL_GAIT;
  let locoSpeed = 0;
  let locoHeading = 0;

  const radius =
    (Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2) * scale * SHADOW_FIT;

  // The drift/bubble seed carries the identity salt too, so two hatchlings
  // of one drawing decorrelate their ambient drift and bubble outlines. The
  // mix is a small bounded offset — no salt (0) keeps the exact old seed.
  const seed =
    driftSeed(strokes) +
    (identitySeed === undefined ? 0 : (identitySeed % 977) * 0.6180339887);
  const worldHeight = height * scale;

  // Speech bubble (./bubble.ts): the legible emote signal at world scale.
  // Anchored above the bounding-box top; seeded with the drift seed so the
  // hand-drawn outline is deterministic per character. Billboards on its own.
  // Joins the group only while showing (it detaches itself once hidden), so
  // an idle character's bounds stay exactly the body's.
  const bubble = createBubble({ seed, anchorY: worldHeight });

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
        onGaze: (x, y) => eyes.setGaze(x, y),
      });
      // The bubble is the legible signal; its own springs retarget cleanly
      // when one emote interrupts another. It removes itself once hidden.
      if (bubble.object.parent !== group) group.add(bubble.object);
      bubble.show(name);
    },
    setLocomotion(speed: number, heading: number): void {
      locoSpeed = speed;
      locoHeading = heading;
    },
    setWorldUnitsPerPixel(v: number): void {
      bubble.setWorldUnitsPerPixel(v);
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

      // Gait: phase/amplitude follow the reported speed; the uniforms are a
      // separate additive layer, so emote and walk compose instead of fight.
      gaitState = gait.update(dt, locoSpeed, locoHeading);
      deform.setGait(gaitState);

      // The eye needs no carry: it is paint in the body material, and its
      // projection rides the vertex-stage deformation by construction.
      deform.set({
        squash: springs.squash.update(dt),
        leanX: springs.leanX.update(dt),
        leanZ: springs.leanZ.update(dt),
        twist: springs.twist.update(dt),
        reach: springs.reach.update(dt),
      });

      eyes.update(dt);
      bubble.update(dt, nowMs);
    },
    dispose(): void {
      group.remove(bubble.object);
      bubble.dispose();
      eyes.dispose();
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      springs.squash.dispose();
      springs.leanX.dispose();
      springs.leanZ.dispose();
      springs.twist.dispose();
      springs.reach.dispose();
      gait.dispose();
    },
  };
}
