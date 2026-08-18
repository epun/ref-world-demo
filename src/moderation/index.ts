/**
 * src/moderation/ — what may become a creature.
 *
 * The installation is public: anyone with a phone draws, and the drawing
 * walks around a projected world in front of strangers. The user's ask is
 * "no explicit drawings or objects of violence". This module is the part of
 * that ask a machine can actually keep, and it is deliberately small.
 *
 * ── what is screened automatically ──────────────────────────────────────
 *
 * `phallus`  — refuses. An elongated shaft with two similar round lobes at
 *   one end, mirror-symmetric about the shaft axis, with the far end not
 *   twin-lobed. This is the single most common mark at public draw
 *   installations and it is stereotyped enough to measure. On the fixture
 *   set it catches 11/11 across proportions, rotations and outline drawing,
 *   with 0 false positives on 56 innocent drawings.
 *
 * `four-fold chiral` — HOLDS, never refuses. Quarter-turn self-similarity
 *   plus chirality plus a thin line figure. That is the swastika's
 *   structure, but it is also the structure of a bar-drawn pinwheel or a
 *   four-armed logo, and nothing at mask level separates them. So the
 *   drawing waits for a person instead of being thrown away.
 *
 * ── what is NOT screened, and why not ───────────────────────────────────
 *
 * Weapons (knives, guns), blood, hanging figures, hate text, slurs written
 * as letters, genitalia drawn in any other arrangement, and "violence" in
 * general are OUT OF SCOPE for automatic screening here. There is no model
 * available in this build, and a stroke/mask-level classifier cannot
 * recognise them: a knife is a triangle on a rectangle, which is also a
 * rocket, a tree, a boat and a pencil. Shipping a detector for them would
 * mean either refusing innocent drawings constantly or refusing nothing
 * while implying coverage. Neither is honest, so neither ships.
 *
 * Those cases are handled by the OPERATOR layer, which is the layer that
 * actually makes the installation safe to run in public:
 *
 *   - hold new arrivals for approval (every drawing waits for a person)
 *   - remove any creature on screen in one tap
 *   - block a drawer, which also removes what they already made
 *
 * See ./gate.ts, the moderation section of the ghost panel
 * (src/dev/index.ts), and docs/MODERATION.md.
 *
 * ── discipline ──────────────────────────────────────────────────────────
 *
 * Everything under src/moderation/ is pure: data in, data out. No DOM, no
 * Three.js, no Math.random, no Date. The same drawing screens identically
 * on every device, which is what lets the verdict be part of the same
 * deterministic pipeline as the shape itself (PLAN §6.3).
 */

export {
  screenMask,
  largestComponentShare,
  inkFrame,
  rotationSelfSimilarity,
  mirrorSelfSimilarity,
  bestMirrorSymmetry,
  SCREEN_SIZE,
  type InkFrame,
} from './mask';
export {
  detectPhallus,
  phallusFeatures,
  PHALLUS_ID,
  type DetectorScore,
  type PhallusFeatures,
} from './phallus';
export {
  detectFourFold,
  fourFoldFeatures,
  FOURFOLD_ID,
  type FourFoldFeatures,
} from './fourfold';
export {
  screenDrawing,
  type ScreenOptions,
  type ScreenResult,
  type Verdict,
} from './screen';
export {
  createIngestGate,
  type Disposition,
  type GateDrawing,
  type GateEntry,
  type GateOptions,
  type IngestGate,
} from './gate';
