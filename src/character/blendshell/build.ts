/**
 * Blend-shell character assembly (BLENDSHELL step 6) — the construction
 * behind createCharacter({ construction: 'blendshell' }).
 *
 * Pipeline: analyze the drawing → extract its motifs (the same first stage
 * interpretDrawing runs) → specFromMotifs → shell + ink outline + reactive
 * IK stepping + verlet secondary. Eyes mount on the head part's front
 * surface (solved from the part table's CPU SDF at the head's +z); the
 * marking box-projects onto the shell's BACK (−z, the face opposite the
 * eye); the bubble anchors above the shell top.
 *
 * Emote composition note: in this mode the v1 vertex-deform is NOT injected
 * (the snap shader owns the vertex stage, and the IK owns the legs). The
 * emote squash/lean/twist/reach choreography instead applies as Group
 * transforms about the base — scale for squash/reach with the volume bulge,
 * rotations for lean/twist — the simpler composition the plan explicitly
 * allows. Every deformed frame is still one whole-shape transform of a solid
 * silhouette, so the corpus-still rule holds by construction.
 */

import { Group, Quaternion, Vector3 } from 'three';
import { sampleDrift } from '../../motion/ambient';
import { Spring } from '../../motion/spring';
import type { EmoteName } from '../../net/protocol';
import { analyze } from '../../shape/analyze';
import type { StrokeList } from '../../shape/types';
import { MOTION } from '../../taste/tokens';
import { createBubble } from '../bubble';
import { CHARACTER_HEIGHT, type Character } from '../character';
import { MIN_SQUASH } from '../deform';
import { runEmote, type EmoteRun } from '../emotes';
import { applyEyes } from '../eyes';
import type { Expression, ExpressionName } from '../expressions';
import { extractMotifs, strokeSeed } from '../interpret';
import { applyMarking } from '../marking';
import { createOutline } from './outline';
import { createSecondary } from './secondary';
import { specBounds, specFromMotifs, specHeight, type V3 } from './spec';
import { createShell } from './shell';
import { createStepper } from './step';

/** Shadow stamp sits a touch inside the footprint (mirrors character.ts). */
const SHADOW_FIT = 0.85;

/** Same recipe as character.ts's driftSeed — kept local to avoid a cycle. */
function driftSeed(strokes: StrokeList): number {
  let points = 0;
  for (const stroke of strokes) points += stroke.pts.length;
  const first = strokes[0]?.pts[0];
  const fx = first ? first[0] : 0;
  const fy = first ? first[1] : 0;
  return (points % 971) * 0.618 + fx * 37.42 + fy * 91.17;
}

/**
 * Build a blend-shell character. Same contract as createCharacter: null when
 * the drawing carries no usable ink.
 */
export function createBlendshellCharacter(
  strokes: StrokeList,
  worldScale = 1,
): Character | null {
  const analysis = analyze(strokes);
  if (!analysis) return null;

  const motifs = extractMotifs(analysis);
  const seed = strokeSeed(strokes);
  const spec = specFromMotifs(motifs, seed);

  const height = specHeight(spec);
  const bounds = specBounds(spec);
  const scale = (CHARACTER_HEIGHT / height) * worldScale;
  const worldHeight = height * scale;

  const shell = createShell(spec);
  const outline = createOutline(shell.geometry, shell.table, height, seed);
  // Recognition channel 2: the original drawing as a light knockout on the
  // BACK, box-projected over the shell's rest bounding box (chains onto the
  // snap hook).
  const box = shell.geometry.boundingBox!;
  const marking = applyMarking(shell.material, strokes, box);

  // group (drift) → body (emote transforms about the base) → unit (spec→world scale)
  const unit = new Group();
  unit.scale.setScalar(scale);
  unit.position.y = -Math.min(bounds.min[1], 0) * scale;
  unit.add(outline.mesh, shell.mesh);

  const body = new Group();
  body.add(unit);
  const group = new Group();
  group.add(body);

  // The eye paints into the shell material (no cap geometry — see eyes.ts):
  // anchored at the head part's center in spec space, sized to ~half the
  // head radius (avatar spec: the eye is large and carries the face). The
  // fragment's facing fade keeps it front-only on the snapped surface.
  const head = spec.parts.find((p) => p.group === 'head');
  const eyeAnchor: V3 = head
    ? [head.a[0], head.a[1] + head.r * 0.1, head.a[2]]
    : [0, height * 0.7, 0];
  const eyeR = head ? head.r : height * 0.2;
  const eyes = applyEyes(shell.material, analysis, undefined, {
    cx: eyeAnchor[0],
    cy: eyeAnchor[1],
    r: eyeR * 0.5,
  });

  // Locomotion: reactive IK stepping owns the legs (gait v1 does not run in
  // this mode); verlet ropes own the crown/tail chains.
  const stepper = createStepper(spec, seed);
  const secondary = createSecondary(spec);
  let locoSpeed = 0;

  // Emote channels — the same ζ≥1 springs and scripts as the inflate path.
  const springs = {
    squash: new Spring(1, { settleMs: MOTION.tertiaryMs }),
    leanX: new Spring(0, { settleMs: MOTION.secondaryMs }),
    leanZ: new Spring(0, { settleMs: MOTION.secondaryMs }),
    twist: new Spring(0, { settleMs: MOTION.secondaryMs }),
    reach: new Spring(0, { settleMs: MOTION.secondaryMs }),
  };
  let emoteRun: EmoteRun | null = null;

  const X_AXIS = new Vector3(1, 0, 0);
  const Y_AXIS = new Vector3(0, 1, 0);
  const Z_AXIS = new Vector3(0, 0, 1);
  const qx = new Quaternion();
  const qy = new Quaternion();
  const qz = new Quaternion();

  const radius =
    (Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) / 2) *
    scale *
    SHADOW_FIT;

  const drift = driftSeed(strokes);
  const bubble = createBubble({ seed: drift, anchorY: worldHeight });

  return {
    group,
    radius,
    analysis,
    setExpression(e: ExpressionName | Expression): void {
      eyes.setExpression(e);
    },
    emote(name: EmoteName): void {
      emoteRun = runEmote(springs, name, {
        onExpression: (e) => eyes.setExpression(e),
        onGaze: (x, y) => eyes.setGaze(x, y),
      });
      if (bubble.object.parent !== group) group.add(bubble.object);
      bubble.show(name);
    },
    setLocomotion(speed: number, _heading: number): void {
      locoSpeed = speed;
    },
    update(dt: number, nowMs: number): void {
      const d = sampleDrift(nowMs, drift, worldHeight);
      group.position.set(d.x, 0, d.y);
      group.rotation.y = d.rot;

      if (emoteRun?.update(dt)) emoteRun = null;

      // Stepping + ropes mutate the spec's part table; one push feeds both
      // the body shader and the ink hull (shared uniform arrays).
      const specSpeed = locoSpeed / scale;
      const pose = stepper.update(dt, specSpeed);
      secondary.update(dt, pose.lift, specSpeed);
      shell.updateParts(spec.parts);

      // Emote channels as whole-body group transforms about the base.
      const squash = Math.max(springs.squash.update(dt), MIN_SQUASH);
      const leanX = springs.leanX.update(dt);
      const leanZ = springs.leanZ.update(dt);
      const twist = springs.twist.update(dt);
      const reach = springs.reach.update(dt);
      const bulge = 1 / Math.sqrt(squash);
      body.scale.set(bulge, squash * (1 + reach * 0.5), bulge);
      qy.setFromAxisAngle(Y_AXIS, twist);
      qx.setFromAxisAngle(X_AXIS, leanX + pose.lean);
      qz.setFromAxisAngle(Z_AXIS, leanZ);
      body.quaternion.copy(qz).multiply(qx).multiply(qy);

      // The eye rides the body bob (the head part lifts in the shader).
      eyes.setLift(pose.lift);
      eyes.update(dt);
      bubble.update(dt, nowMs);
    },
    dispose(): void {
      group.remove(bubble.object);
      bubble.dispose();
      eyes.dispose();
      unit.remove(shell.mesh, outline.mesh);
      outline.dispose();
      shell.dispose();
      marking?.dispose();
      springs.squash.dispose();
      springs.leanX.dispose();
      springs.leanZ.dispose();
      springs.twist.dispose();
      springs.reach.dispose();
    },
  };
}
