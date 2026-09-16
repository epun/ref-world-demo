/**
 * Creature lifecycle manager — many phones, one world (GENERATOR.md).
 *
 * Each incoming drawing (from the MQTT feed or the local overlay) runs the
 * same lifecycle the single-creature flow proved out: validate by building
 * the character offstage → egg slides in painted → wobble/crack on a timer →
 * hatch → character. This module owns N of those lifecycles keyed by drawing
 * id, with deterministic spawn placement and a practical population guard.
 *
 * [D] The roam-free ruling (PLAN §7.1) means no design cap, but a live demo
 * needs a perf guard: beyond MAX_POPULATION the oldest creature retires.
 * Retirement is never a hard cut (forbidden at confidence 1.00) — the
 * creature sinks and fades out over t.primary, then disposes.
 */

import { Frustum, Group, Matrix4, Mesh, Quaternion, Sphere, Vector3 } from 'three';
import type { Object3D } from 'three';
import {
  BehaviorAgent,
  MAX_SPEED,
  type AgentHold,
  type AgentPeer,
  type AgentProp,
} from '../behavior/agent';
import { personalityFromChoice, type PersonalityChoice } from '../behavior/personality';
import { projectOutOfHard } from '../behavior/steering';
import { createCharacter, type Character } from '../character/character';
import {
  buildColliderGrid,
  type Collider,
  type ColliderGrid,
} from '../physics/colliders';
import {
  deepestSoftOverlap,
  SOFT_SPEED_FACTOR,
  stepCreatures,
  type CreatureBody,
} from '../physics/resolve';
import { SpatialHash } from '../physics/spatial';
import { NOTICE_RADIUS } from '../behavior/states';
import { VARIATION_BULGE, VARIATION_SCALE_XZ } from '../world/scatter';
import { createEgg, EGG_RADIUS, type Egg } from '../egg/egg';
import { startHatch, type HatchHandle } from '../egg/hatch';
import type { EmoteName } from '../net/protocol';
import type { StrokeList } from '../shape/types';
import { MOTION } from '../taste/tokens';
import { FOLLOW_TAU_MS, followFraction, shortestAngle } from '../net/worldsync';
import type { WorldHandles } from '../world/scene';
import type { ShadowHandle } from '../world/shadows';
import { ROLLING_SURFACE, type Surface } from '../world/surface';
import { isWater } from '../world/landscape';
import { sanitizeGame, type WorldGame } from '../world/game';
import { resolveName } from './naming';
import { createClump, type Clump, type StuckItem } from './clump';
import {
  carryLimit,
  clumpLocalOffset,
  clumpLocalRotation,
  decideContact,
  CONTACT_PAD,
  DROP_MIN_GAP_MS,
  impactOf,
  shouldDrop,
  stageFor,
  STICKY,
  stickyFor,
  STUCK_COLLIDERS_MAX,
} from './sticky';
import type { LooseMeshes } from '../world/loose';
import type { Chunk, ChunkKind } from '../world/chunks';
import type { Debris } from '../world/debris';
import { advance, createWreck, fragmentSpread, type WreckState } from '../world/wreck';
import type { ImpactSide, LooseItem, PropBodies } from '../world/rocks';
import { placementKey } from '../world/scatter';
import type { PropKind } from '../world/props';

/** Shipped wander-speed multiplier (panel export, user ask): a touch
 * brisker than spec pace. The panel slider starts here. */
export const WANDER_SPEED_DEFAULT = 1.4;

/**
 * Top speed under a person's thumb, before the wander multiplier.
 *
 * The creature's own maximum, not a driving speed of its own: a steered
 * creature should be the fastest version of itself and not a different
 * thing that happens to wear its shape. It is scaled by the stick's
 * strength, so most of the range is slower than this.
 */
export const DRIVE_SPEED = MAX_SPEED;

/**
 * How much faster a KATAMARI creature travels than a walking one. **[D]**
 *
 * User ask, 2026-09-16: *"Like Katamari Damacy, we should have the character
 * ROLL versus walk. Right now, the walking cycle is way too slow."* A ball
 * has no stride to outrun — the speed a walk reads as honest at is the speed
 * its legs are taking, and a rolling creature has none. So the katamari world
 * raises the ceiling: `MAX_SPEED × 3` = 3.6 u/s, for the stick and for the
 * wander alike, with `DRIVE_TURN_TAU_MS` untouched (a faster ball that also
 * turned faster would be a cursor).
 *
 * THREE, not more. Rolling already reads faster than walking at the same
 * ground speed — the surface turns under the eye — so the multiplier is the
 * starting point rather than the answer, and the ghost panel's wander/speed
 * slider multiplies on top of it for tuning.
 *
 * TUNNELLING, since this is the number the substep guard was sized against:
 * `stepCreatures` clamps dt at 250ms and covers `MAX_STEP_TRAVEL` (0.25u) per
 * substep over at most `MAX_SUBSTEPS` (16), so 4u of travel per frame. At
 * 3.6 u/s a clamped frame is 0.9u — 4 substeps of the 16 — so the guard still
 * covers the katamari top speed four times over.
 *
 * EVERY OTHER WORLD IS UNCHANGED: outside the game the multiplier is 1 and
 * the walk cycle keeps the speeds it shipped with.
 */
export const KATAMARI_SPEED_MUL = 3;

/**
 * Turn responsiveness under the stick, as an exponential time constant.
 *
 * Short enough that the creature answers the thumb, long enough that a
 * flick across the well is a turn rather than a snap. Shorter than the
 * pose follow constant because this one is answering a hand in the room,
 * not a network.
 */
export const DRIVE_TURN_TAU_MS = 90;

/**
 * How long the stick keeps the creature after the last push. **[D]**
 *
 * The wander ai and a person's thumb were both steering at once, so a
 * creature under the stick kept trying to leave for somewhere the agent had
 * picked (user ask, 2026-09-09: *"the automated character walk fights the
 * user control … we don't enable the auto wander for the character unless
 * it's been idle for 2 seconds"*). While this window is open the agent is
 * held: it chooses nothing and steers nowhere, and the hand is the only
 * thing moving the creature.
 *
 * The ask was two seconds; the value is `MOTION.primaryMs` (1823ms), the
 * nearest beat on the token scale — durations come from tokens, never
 * literals, and a hand-picked 2000 here would be a second clock running
 * beside the world's own. The difference is under a fifth of a second and
 * the window's edge is not a moment anybody watches: it is the point at
 * which a creature nobody is touching starts living again.
 */
export const DRIVE_IDLE_MS = MOTION.primaryMs;

/**
 * Practical demo guard, not a design cap (see header).
 *
 * 96 → 256 (2026-09-15, user ask: *"support 100-200 players at one time"*).
 * The guard is a frame-rate guarantee, and what made it affordable to lift
 * is the crowd-engine work that landed with it: the per-frame neighbour
 * gather and the pair separation both went from all-pairs to a spatial
 * hash (src/physics/spatial.ts), off-screen creatures update their
 * presentation on a stride (`OFFSCREEN_STRIDE`), and the shadow stamps
 * draw as one instanced mesh (src/world/shadows.ts).
 */
export const MAX_POPULATION = 256;

/**
 * How far an agent looks for company, world units. **[D]**
 *
 * The behaviour model only ever asks two things of its peers: who is the
 * nearest, and is anyone within NOTICE_RADIUS (src/behavior/states.ts).
 * Twice that radius is far enough that a creature an agent has decided to
 * approach stays resolvable while it walks over, and near enough that a
 * field of two hundred hands each agent a handful of peers instead of the
 * whole cast. A creature with nobody inside it reads as alone, which at
 * that distance it is.
 */
export const PEER_RADIUS = NOTICE_RADIUS * 2;

/**
 * Every Nth frame, an OFF-SCREEN creature refreshes its presentation. **[D]**
 *
 * The port of the reference crowd engine's amortised update: it advances
 * physics for a quarter of its crowd per frame and rewrites matrices for
 * far characters one frame in four. Here the SIMULATION still runs every
 * frame for every creature — the host's positions are the truth every
 * phone follows, and a creature nobody is looking at is still walking
 * somewhere — but the part only a viewer can see (gait and emote springs,
 * eye state, the name bubble, the shadow stamp on the terrain) is refreshed
 * one frame in four while it is outside the camera's frustum, with the
 * skipped frames' dt handed over in one piece. The springs are critically
 * damped and substep internally, so a bigger dt is the same curve, not a
 * different one; and there is no visible step, because nothing was visible.
 * The tour camera frames a small piece of a huge map (PLAN §7.1), so at
 * two hundred creatures this is most of them, most of the time.
 */
export const OFFSCREEN_STRIDE = 4;

/** Cap on the dt handed over after a run of skipped frames, ms — a tab
 * that was hidden for a minute does not owe the springs a minute. */
const OFFSCREEN_DT_CAP = 250;

/**
 * Marking texture edge for a WORLD creature, texels. **[D]** A creature is
 * 1-3% of the frame here (PLAN §7, "scale is the subject"), so 256² is
 * already more texels than it ever covers; the phone portrait keeps the
 * 512 default. At the cap this is a quarter of the texture memory.
 */
const WORLD_MARKING_SIZE = 256;

/** The eviction decision, as little of a slot as it actually needs. */
export interface Evictable {
  order: number;
  resident: boolean;
  phase: string;
}

/**
 * Who leaves when the world is full — a SUBMISSION before a resident.
 *
 * Pulled out of the spawn path and made pure because the interesting cases
 * (an all-resident world, a world already mid-retirement) need a hundred
 * creatures each to reach through `spawn`, and building a hundred real
 * creatures to assert one comparison is a test that cannot be run often.
 *
 * The rule it replaces was plain oldest-first, and "oldest" and "resident"
 * are the same set in practice: a world's own cast loads before anybody
 * arrives, so it holds every one of the lowest arrival numbers. A busy
 * public world therefore retired the field a person had come to look at,
 * one resident per arrival, until only the newcomers were left.
 *
 * Residents are a PREFERENCE, not an exemption — if every slot is a
 * resident the oldest one still goes. The cap is a frame-rate guarantee,
 * and a guarantee with a carve-out is a leak.
 *
 * Already-retiring slots are skipped: they are on their way out and
 * retiring one twice restarts its slide.
 */
export function chooseEviction<T extends Evictable>(candidates: Iterable<T>): T | null {
  let oldestGuest: T | null = null;
  let oldestAny: T | null = null;
  for (const s of candidates) {
    if (s.phase === 'retiring') continue;
    if (!oldestAny || s.order < oldestAny.order) oldestAny = s;
    if (s.resident) continue;
    if (!oldestGuest || s.order < oldestGuest.order) oldestGuest = s;
  }
  return oldestGuest ?? oldestAny;
}

/** Egg shadow sits a touch inside the shell footprint. */
const EGG_SHADOW_FIT = 0.85;

/** Pre-hatch crack teaser share of the crack scrub. */
/**
 * Auto-hatch on the egg's own timer.
 *
 * OFF for the demo (user, 2026-08-20: *"I only want the eggs to hatch when I
 * switch to the 3D world and I press H … let's disable the timer for now for
 * demo purposes, but let's keep the code"*). The timer code below is intact
 * and still drives the crack/wobble teaser — only the firing is gated, so
 * turning this back on restores the old behaviour exactly.
 */
const AUTO_HATCH = false;

/**
 * Gap between eggs when hatchAll() fires. They should not all break at the
 * same instant — a room of eggs opening in one frame reads as a switch being
 * thrown, and the moment is worth more spread out. One t.tertiary apart, so
 * the beat comes from the token scale rather than a picked number.
 */
const HATCH_STAGGER_MS = MOTION.tertiaryMs;

const CRACK_TEASER = 0.3;

/**
 * How far from the origin a creature may spawn, world units. **[D]**
 *
 * Inside `TERRAIN.farStart` (150), where the authored geography is still at
 * full height, with a margin so a spot never lands on the ramp down to the
 * flat outer disc. Wide on purpose: the point is a population that reads as
 * scattered over the whole field, not a clutch at the hatch clearing.
 */
export const SPAWN_RADIUS = 120;

/** How many candidate spots one id tries before settling for the last. */
const SPAWN_ATTEMPTS = 8;

/** A spot this close to a shoreline is refused — an egg on the bank, never
 * in the shallows. Egg footprint plus the clearance a rock gets. */
const SPAWN_WATER_PAD = EGG_RADIUS + 0.25 + 1;

/** fnv-1a over a string, then one round of mixing — a seed, not a hash
 * anyone reads. Same string → same number on every device. */
function hashId(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Deterministic spawn spot for a creature, anywhere on the map.
 *
 * User ask, 2026-09-15: *"we should spawn randomly on the map not in one
 * place"*. It used to be a golden-angle spiral out from the origin, so a
 * room of two hundred was a disc of eggs around the hatch clearing and
 * everybody's creature woke up in the same crowd.
 *
 * RANDOM TO THE EYE, DETERMINISTIC IN FACT. Every phone's world view builds
 * its own copy of the eggs from the same drawing ids (src/net/worldsync.ts:
 * poses only place creatures that are alive, an egg stands where it was
 * built), so a spot has to come from the id and nothing else — no
 * `Math.random`, no clock, no arrival order. The id is hashed to a point
 * drawn uniformly over the spawn disc (√ on the radius, so the density is
 * even rather than bunched at the centre), and a candidate that lands in
 * water is skipped for the next hash in the sequence. The same id always
 * walks the same sequence, so every device settles on the same bank.
 *
 * Never a row, never a grid (grid governs placement of props, not beings).
 * Props and standing residents are cleared afterwards by `clearSpawnSpot`.
 */
export function spawnSpot(id: string): { x: number; z: number } {
  let spot = { x: 0, z: 0 };
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const u = hashId(id, attempt * 2 + 1) / 0x100000000;
    const v = hashId(id, attempt * 2 + 2) / 0x100000000;
    const radius = SPAWN_RADIUS * Math.sqrt(u);
    const angle = v * Math.PI * 2;
    spot = { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
    if (!isWater(spot.x, spot.z, SPAWN_WATER_PAD)) return spot;
  }
  return spot;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Deterministic behavior seed from the slot id (fnv-1a). Same id → same
 * hidden life on every device; no Math.random in the behavior path. */
function behaviorSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Environmental affordances: WorldHandles may grow a `scatter` handle with
 * prop positions (another workstream). Feature-detect it loosely — accept a
 * `positions()` method or an `items`/`placements` array of {x, z, kind?} —
 * and return null when absent, which the agents treat as "no props known".
 */
function readProps(world: WorldHandles): AgentProp[] | null {
  const scatter = (world as WorldHandles & { scatter?: unknown }).scatter;
  if (typeof scatter !== 'object' || scatter === null) return null;
  const rec = scatter as unknown as Record<string, unknown>;
  let source: unknown = null;
  if (typeof rec['positions'] === 'function') {
    try {
      source = (rec['positions'] as () => unknown)();
    } catch {
      return null;
    }
  } else {
    source = rec['items'] ?? rec['placements'];
  }
  if (!Array.isArray(source)) return null;
  const out: AgentProp[] = [];
  for (const item of source as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const p = item as Record<string, unknown>;
    if (typeof p['x'] === 'number' && typeof p['z'] === 'number') {
      out.push({
        x: p['x'],
        z: p['z'],
        kind: typeof p['kind'] === 'string' ? p['kind'] : 'prop',
      });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Physics affordances on the scatter handle — feature-detected like
 * readProps, so the manager keeps working against a world whose scatter
 * predates the collider api (or a test stub without one).
 */
interface ScatterPhysics {
  colliders(): Collider[];
  collidersVersion(): number;
  nudge?(x: number, z: number, strength: number): void;
}

function readScatterPhysics(world: WorldHandles): ScatterPhysics | null {
  const scatter = (world as WorldHandles & { scatter?: unknown }).scatter;
  if (typeof scatter !== 'object' || scatter === null) return null;
  const rec = scatter as unknown as Record<string, unknown>;
  if (typeof rec['colliders'] !== 'function') return null;
  if (typeof rec['collidersVersion'] !== 'function') return null;
  return scatter as unknown as ScatterPhysics;
}

/** How far past the body circle to gather colliders each frame: covers one
 * frame of travel at peak speed plus the deepest push-out a prop can cause. */
const COLLIDER_QUERY_PAD = 1.5;

/** Fractional inflation of hard prop colliders during creature resolve: the
 * scatter's per-instance shape variation widens a prop's visual silhouette
 * beyond its published footprint circle by up to scale-jitter + bulge
 * (see src/world/scatter.ts); resolving against the padded circle keeps the
 * contact at the VISUAL surface. */
const HARD_PAD_FRAC = VARIATION_SCALE_XZ + VARIATION_BULGE;

/** Spawn spots keep this clearance from hard surfaces and existing
 * residents: the egg's own footprint plus a small skin, so an egg never
 * lands overlapping a rock, a building, or another egg. */
const SPAWN_CLEARANCE = EGG_RADIUS + 0.25;

/**
 * True collision radius of a character, measured from the generated mesh
 * itself: the widest x/z reach of every mesh in the group (geometry
 * bounding box × node scale + node offset). Bodies vary per drawing — a
 * wide fish needs a wide circle, a narrow triangle a slim one — and the
 * character's published `radius` is the SHADOW stamp (deliberately tucked
 * inside the silhouette), so colliding on it let wide bodies visually clip.
 * The character rotates freely about y, so the circle covers the widest
 * silhouette at any facing. Falls back to the shadow radius when the group
 * carries no measurable mesh (defensive — never expected).
 */
export function measureBodyRadius(character: Character): number {
  let r = 0;
  character.group.traverse((obj) => {
    if (!(obj instanceof Mesh)) return;
    const geometry = obj.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb || bb.isEmpty()) return;
    const ex =
      Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)) * Math.abs(obj.scale.x) +
      Math.abs(obj.position.x);
    const ez =
      Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z)) * Math.abs(obj.scale.z) +
      Math.abs(obj.position.z);
    r = Math.max(r, ex, ez);
  });
  return r > 0.05 ? r : character.radius;
}

/** Speed floor (units/s) under which brushing a bush stops kicking sway. */
const NUDGE_MIN_SPEED = 0.15;

/** No rotation. Shared, and never mutated — an item set down with nothing
 * to say about its attitude gets this rather than four literals. */
const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 } as const;

type Phase = 'egg' | 'hatching' | 'alive' | 'retiring';

/**
 * Type-only, exactly as `src/world/rocks.ts` does it: the wasm module is a
 * dynamic import on the host's path alone, and a static type import compiles
 * to nothing — so a viewer's bundle never pulls it in.
 */
type RapierRigidBody = import('@dimforge/rapier3d-compat').RigidBody;
type RapierCollider = import('@dimforge/rapier3d-compat').Collider;

/**
 * A creature's stand-in inside the rigid-body world, on the HOST only.
 *
 * Kinematic and position-based: the creature's movement is decided by its
 * agent and the pure substepped resolve (`stepCreatures`), exactly as before
 * — rapier is not allowed an opinion about where a creature goes. What the
 * body buys is CONTACT: a stuck bench swinging into a tree, a pile
 * shouldering a stone downhill, and the contact events that tell a carrier it
 * has been hit hard enough to shed something.
 */
interface KinematicHandle {
  body: RapierRigidBody;
  /** Its own ball collider, resized as the pile grows. */
  ball: RapierCollider | null;
  /**
   * Ball colliders standing in for the nearest `STUCK_COLLIDERS_MAX` stuck
   * items, by item key. Re-seated every frame at the item's current world
   * offset, so a swinging bench actually sweeps.
   */
  stuck: Map<string, RapierCollider>;
  /**
   * The same colliders, NAMED for the impact seam (src/world/rocks.ts
   * `registerForeign`), by collider handle.
   *
   * Held by reference and rewritten in place every frame: the ball grows
   * with the pile and a stuck bench is somewhere different each frame, and
   * the seam reads these at the moment of a contact rather than at the
   * moment of registration.
   */
  sides: Map<number, ImpactSide>;
}



interface Slot {
  id: string;
  name: string | null;
  /**
   * Where the HOST says this creature is (src/net/worldsync.ts).
   *
   * Set only on a viewer. The creature eases toward it rather than being
   * placed on it: pose frames arrive five times a second and snapping to
   * each one is a step, which is the hard cut the motion law forbids
   * outright. Null on the host, and on a viewer that has not heard about
   * this creature yet — in which case it simply stands where it spawned
   * rather than guessing.
   */
  /**
   * Where the host says this creature is (src/net/worldsync.ts).
   *
   * `settled` is false until the first frame has been APPLIED. A viewer
   * spawns the whole cast at its deterministic spawn spots and only then
   * hears where the host actually has them — so the first pose is not a
   * movement, it is finding out. See the update loop.
   */
  follow: { x: number; z: number; heading: number; settled: boolean } | null;
  /** When a staggered hatchAll() has scheduled this egg. null = not queued. */
  forcedHatchAtMs: number | null;
  phase: Phase;
  spot: { x: number; z: number };
  egg: Egg | null;
  eggShadow: ShadowHandle | null;
  bornMs: number;
  hatchAtMs: number;
  pending: Character | null;
  hatch: HatchHandle | null;
  character: Character | null;
  characterRoot: Group | null;
  characterShadow: ShadowHandle | null;
  /** Collision radius measured from the hatched character's real mesh
   * footprint (measureBodyRadius); 0 until hatch.
   *
   * GROWS with the pile (src/creatures/sticky.ts `growth`): this is
   * `baseR × clump.growth()`, rewritten every frame, and it is read by the
   * resolve pass, the pickup reach and `positions()` — which is where the
   * scatter's exclusion radius comes from, so a creature the size of a
   * building clears props out of its way as it goes. */
  bodyR: number;
  /** The measured radius BEFORE any pile. The growth curve's denominator,
   * and what the creature goes back to if its pile is taken off it. */
  baseR: number;
  /**
   * The pile (src/creatures/clump.ts). Created at `becomeAlive`, on the
   * ROOT — never on the character's own group, which the deform shader
   * rewrites every frame. Null while this is still an egg.
   */
  clump: Clump | null;
  /**
   * The id of the creature CARRYING this one, or null.
   *
   * A carried creature is out of the physics pass, its agent is paused, its
   * shadow is gone and its follow is cleared — its world position is
   * whatever its carrier's pile puts it at. Its phone still owns it, though:
   * emotes play, `poses()` reports its WORLD position so the minimap follows
   * the pile, and a drive on it is ignored rather than refused.
   */
  carriedBy: string | null;
  /** Ids of the creatures riding on THIS one. Set down free if it leaves. */
  passengers: Set<string>;
  /** When this carrier last shed something, on the loop's clock. Null until
   * it has. The `DROP_MIN_GAP_MS` gate, so a pile does not unravel in one
   * frame against a tree. */
  lastDropMs: number | null;
  /** The kinematic rapier body standing in for this creature, host only. */
  kinematic: KinematicHandle | null;
  /** Audience answer, held until hatch mints the behavior agent. */
  personalityChoice: PersonalityChoice;
  /** Autonomous behavior — created on hatch, null before. */
  agent: BehaviorAgent | null;
  /** Last pose the agent reported, for expression edge-detection. */
  pose: 'sit' | 'sleep' | null;
  /** Manual move (dev panel gizmo): while held the agent is bypassed and the
   * root's dragged x/z is the truth — physics reads it as a still body so
   * neighbors part around it, but never writes it back. */
  manualHold: boolean;
  /** retire animation state */
  retireStartMs: number;
  order: number;
  /** Part of the world rather than a submission — see SpawnOptions. */
  resident: boolean;
  /**
   * Somebody is steering this one right now (src/world/joystick.ts).
   *
   * A direction on the ground and a strength, not a destination and not a
   * velocity — the creature's own speed still applies, so a driven
   * creature moves like itself rather than like a cursor.
   */
  drive: { x: number; z: number; mag: number } | null;
  /**
   * When a non-zero drive was last seen on this creature, on the update
   * loop's clock. Stamped per frame while the stick is down; null until
   * somebody has steered it at all.
   *
   * The agent is HELD until DRIVE_IDLE_MS past this, which is what keeps
   * the wander ai from taking the creature back the instant a thumb pauses
   * — including the pause between two pushes of the same gesture.
   */
  drivenAtMs: number | null;
  /**
   * Presentation bookkeeping for the off-screen stride (OFFSCREEN_STRIDE):
   * how many frames this creature has been outside the frustum, and the dt
   * its presentation has not yet been told about.
   */
  offscreenFrames: number;
  pendingDt: number;
  /** Set each frame: is the presentation being refreshed this frame? */
  present: boolean;
}

export interface SpawnOptions {
  name?: string | null;
  /** Audience personality answer ("what does your little creature want
   * most?"). Biases behavior transition probabilities only — never shown in
   * UI (docs/GENERATOR.md §behavior). Absent/null → neutral defaults. */
  personality?: 'friends' | 'snacks' | 'sleep' | 'adventure' | 'chaos' | null;
  /** ms until auto-hatch. */
  hatchMs: number;
  /**
   * Already grown — no egg, no shell, no hatch.
   *
   * For a population that exists before the viewer does: a public world's
   * residents were drawn days ago and are simply standing there. Without
   * this every visitor watched the entire world hatch on arrival, which is
   * both a lie about when it happened and, at sixty-eight creatures, most
   * of the page's load cost.
   */
  grown?: boolean;
  /**
   * A RESIDENT: never retired to make room for somebody else.
   *
   * The population guard retires the oldest live slot past the cap, and the
   * oldest slots are always the world's own residents — they load first, so
   * they hold the lowest arrival numbers. A busy public world therefore ate
   * its own cast: the recovered creatures went first, one per arrival, and
   * the field a person had come to see emptied out behind them (user ask,
   * 2026-08-27: *"fix the population cap so the seeded ones don't get
   * retired"*).
   *
   * Set only by the seed loader. NOT by `grown` — the store's first pull is
   * grown too (everything it holds predates the page), and those ARE
   * submissions and must stay evictable.
   *
   * The guard still holds: if a world is somehow all residents it retires
   * the oldest one anyway rather than growing without limit. The cap is a
   * frame-rate guarantee and there is no exemption from arithmetic.
   */
  resident?: boolean;
}

/**
 * A passive witness to the creature lifecycle. Structural on purpose: the
 * session recorder implements it (src/session/wire.ts) so this module needs
 * no import and stays a leaf of the world. Every call sits on a discrete
 * seam — an egg placed, a shell opened, a slot leaving, an emote played —
 * so NOTHING here runs per frame.
 */
export interface CreatureObserver {
  /** An egg was placed. The spot is deterministic from the spawn order; it
   * is recorded as a cross-check, never as a replay input. */
  egg(id: string, x: number, z: number): void;
  /** A shell opened, by its own timer or because someone forced it. */
  hatch(id: string, cause: 'timer' | 'forced'): void;
  retire(id: string, cause: 'population' | 'operator' | 'replaced' | 'cleared'): void;
  emote(id: string, emote: EmoteName, source: 'phone' | 'key' | 'panel'): void;
  /**
   * THE KATAMARI FOUR (src/creatures/sticky.ts, docs/SESSION.md §6).
   *
   * Only the page that SIMULATES ever calls these. They are the only
   * creature decisions in the whole project that cannot be re-derived from
   * (strokes, id) — they depend on where a stone had rolled to, off a rapier
   * simulation that runs on exactly one page — so the one page that knows
   * has to say, and every other page applies what it says and decides
   * nothing (`applyStick` and friends below).
   */
  stick(record: StickRecord): void;
  drop(record: DropRecord): void;
  loose(item: string, x: number, z: number): void;
  settle(record: SettleRecord): void;
  /**
   * THE TWO DESTRUCTION STATES (src/world/wreck.ts, docs/SESSION.md §6).
   *
   * Same rule as the four above, and the same reason: what a building looks
   * like is a running total of impacts on a rapier world that exists on one
   * page, so the page that keeps the total says, and every other page
   * presents (`applyCrack`, `applyShatter`).
   */
  crack(record: CrackRecord): void;
  shatter(record: ShatterRecord): void;
}

/** What the observer is handed for a pickup. Structurally the `stick` event
 * minus the two fields the recorder stamps (`k` and `t`) — spelled out here
 * rather than imported, because this module must not depend on the session
 * layer to describe its own decisions. */
export interface StickRecord {
  /** The carrier. */
  id: string;
  /** A placement key, a `spawn:n`, or `creature:<id>`. */
  item: string;
  /** Mesh hints, for a page that never had the placement drawn. Absent for a
   * creature passenger, which already has a mesh of its own. */
  kind?: string;
  variant?: number;
  scale?: number;
  /** Its seat in the clump's local frame, and its attitude there. */
  ox: number;
  oy: number;
  oz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface DropRecord {
  id: string;
  item: string;
  x: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface SettleRecord {
  item: string;
  x: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** A staged prop reached `stage` (1 cracks, 2 a section gone, 3 rubble). */
export interface CrackRecord {
  item: string;
  stage: number;
}

/** A large prop came apart into every one of its chunks at once. The pose
 * and the mesh hints travel because the placement is hidden the moment this
 * is decided, and a page that never had it drawn has nothing else to build
 * the chunk set from. */
export interface ShatterRecord {
  item: string;
  x: number;
  z: number;
  rotY: number;
  scale: number;
  kind: string;
  variant: number;
}

export interface CreatureManagerOptions {
  /** Session recorder (or any witness). Optional. */
  observer?: CreatureObserver;
  /**
   * Let eggs hatch on their own timer. Defaults to AUTO_HATCH — off, for
   * the demo (see the constant). The timer code is untouched and still runs
   * the crack/wobble teaser; this only gates the firing, so passing true
   * restores the old behaviour exactly, which is what the tests do.
   */
  autoHatch?: boolean;
  /**
   * The ground under the population (PLAN §7.2). Defaults to the world's
   * terrain; a caller that wants a plane — the tests, anything without a
   * landscape — passes FLAT_SURFACE.
   *
   * Read through the seam and NEVER off `world`: a height has exactly one
   * source, and the manager asking the scene for one would be a second.
   */
  surface?: Surface;
  /**
   * Where a knocked-over prop gets drawn (src/world/loose.ts).
   *
   * Needed on EVERY page, host or viewer: the scatter stops drawing a
   * placement the moment it comes out of the ground, and this is the only
   * thing that then draws it. Optional because a headless caller (the tests)
   * has no scene to draw into — a manager without it still decides
   * everything correctly, it simply shows no fallen trees.
   */
  loose?: LooseMeshes;
  /**
   * The debris layer (src/world/debris.ts) — where the fragments of a
   * broken prop go.
   *
   * On EVERY page, like `loose`: the host builds bodies for its fragments
   * and a viewer draws them where the event said, through the one layer.
   * Optional because a headless caller (the tests) has nothing to draw into
   * — a manager without it still decides everything correctly and shows no
   * rubble.
   */
  debris?: Debris;
  /**
   * The chunk set, as a getter (src/world/chunks.ts).
   *
   * A getter because `buildChunkGeometries()` re-runs the prop pipeline and
   * most pages never break anything: the caller builds it the first time
   * something comes apart. Returning null is the answer a page with no
   * chunk set gives, and it means the staged presentation is skipped rather
   * than faked.
   */
  chunks?: () => Map<ChunkKind, Chunk[][]> | null;
  /**
   * The GAME this world runs (src/world/game.ts). Defaults to `'none'`.
   *
   * `'katamari'` is what turns this manager's second half on: the sticky
   * simulation, the clumps a pile is seated in, the kinematic bodies a
   * carrier stands in the rigid-body world as, the growth curve, and the six
   * `apply*` presentations. In every other world — meridian, the public one,
   * and every headless test that says nothing — none of them exist: no clump
   * is created, no kinematic body is added, `simulating()` is false forever
   * and the `apply*` methods return without touching the scene.
   *
   * Not read off the world handle, and that is deliberate: the tests build
   * managers against stub worlds, and an option keeps the seam one value
   * rather than a duck-typed method. `src/main.ts` passes `world.game()`.
   */
  game?: WorldGame;
}

export interface CreatureManager {
  /** Validate + spawn (replacing any existing slot with the same id).
   * Returns false when the ink is unusable. */
  spawn(id: string, strokes: StrokeList, opts: SpawnOptions): boolean;
  /** Force a specific egg (or with no id, every ready egg) to hatch now. */
  hatch(id?: string): void;
  hatchAll(): void;
  /**
   * Play an emote on ONE creature, by the id it was spawned under — the
   * phone's drawer id (src/net/emoteUplink.ts). Returns false when that id
   * holds no hatched character yet (still an egg, or never arrived), so the
   * caller can tell "not mine" from "played".
   */
  emote(id: string, emote: EmoteName, source?: 'phone' | 'key' | 'panel'): boolean;
  /** Most recently hatched character, for emote keys / camera framing. */
  latestCharacter(): Character | null;
  /** Id of the most recently hatched character — the emote keys and the
   * panel's emote row address a creature by id so the session log knows
   * which one played (src/session/). */
  latestId(): string | null;
  /** Named, hit-testable live creatures for the hover-name overlay. Only
   * creatures whose drawer entered a name appear. */
  hoverTargets(): { name: string; object: Group }[];
  /** Positions of all live entities, for camera interest + exclusions +
   * the world minimap. `kind` is additive: egg until the hatch burst hands
   * the slot a character root, character after. */
  positions(): { x: number; z: number; r: number; kind: 'egg' | 'character' }[];
  /**
   * Where ONE creature is standing right now, by the id it was spawned
   * under — the handset's drawer id.
   *
   * `positions()` is anonymous on purpose (the world view has no "self"),
   * so a page that needs to find its own creature has nothing to match on.
   * The handset camera does: it follows the creature belonging to the phone
   * it is running on (src/world/follow.ts).
   *
   * Live from the root transform, egg or character — an egg is where the
   * creature IS for its first minute, and a camera that waited for the
   * hatch would open on an empty field. Null when nothing holds that id.
   */
  positionOf(id: string): Vector3 | null;
  count(): number;
  /** Is a slot with this id still live? The moderation gate uses it to
   * drop rows for creatures the population guard has already retired
   * (src/moderation/gate.ts). */
  has(id: string): boolean;
  update(dt: number, nowMs: number): void;
  clear(id: string): void;
  clearAll(): void;
  pauseTimers(paused: boolean): void;
  /** Freeze autonomous behavior (demo panel). Separate from pauseTimers:
   * eggs keep hatching; characters hold still (ambient floor stays alive). */
  pauseAi(paused: boolean): void;
  /**
   * Take the world's positions from somewhere else.
   *
   * For a viewer of a shared world: the host simulates and sends poses, and
   * these are what the creatures ease toward. Ids this world has never
   * heard of are ignored — a drawing whose strokes have not arrived yet has
   * nothing to move. Returns how many were matched, which is what tells the
   * caller whether it is actually in sync or just receiving.
   */
  followPoses(poses: readonly { id: string; x: number; z: number; heading: number }[]): number;
  /** Drop every held host pose — call on any change of role. */
  clearFollow(): void;
  /**
   * Steer one creature, or let go with `null`. Returns false when that id
   * holds no living creature. See src/world/joystick.ts.
   */
  drive(id: string, vec: { x: number; z: number; mag: number } | null): boolean;
  /** Ids currently being steered. */
  driven(): string[];
  /**
   * Is the stick still holding this creature — thumb down, or down within
   * the last DRIVE_IDLE_MS? While this is true its agent is stood down and
   * nothing wanders it away from where it was left.
   */
  isDriven(id: string, nowMs: number): boolean;
  /** Live slots as the population guard sees them (see chooseEviction). */
  evictable(): { id: string; order: number; resident: boolean; phase: string }[];
  /** Live creature ids, in a stable order — the roster a host publishes. */
  liveIds(): string[];
  /**
   * Ids still standing as eggs — nothing opened, nothing opening.
   *
   * The host puts these on its roster so a viewer can tell an egg that is
   * WAITING from one whose shell it missed the news about
   * (`eggsOpenedByHost` in src/net/worldsync.ts). A slot already breaking
   * open is not here: it is on its way to alive and there is nothing left
   * for anyone to decide about it.
   *
   * A plain read of the map, in spawn order, allocating one array — cheap
   * enough to call on every roster tick.
   */
  eggIds(): string[];
  /** Every live creature's place, for a host to publish. */
  poses(): { id: string; x: number; z: number; heading: number }[];
  /** Wander speed multiplier (demo panel tuning). 1 = spec speed. */
  setWanderSpeed(mult: number): void;
  /**
   * The multiplier in force right now — what the panel's slider should open
   * on. Not always `WANDER_SPEED_DEFAULT`: a katamari world starts at
   * `KATAMARI_SPEED_MUL`, and a slider that opened on the shipped walk value
   * there would be showing a number the world is not running.
   */
  wanderSpeed(): number;
  /**
   * Manual move (dev panel gizmo). beginManualMove marks the creature whose
   * root is `root` as held: behavior is bypassed, the gait settles, and the
   * dragged root position is authoritative (neighbors still part around it).
   * endManualMove releases the hold, re-grounds the root (gizmo drags can
   * leave the y axis), and hands the new spot back to the agent. Returns
   * false when the object is not a live creature root.
   */
  beginManualMove(root: Object3D): boolean;
  endManualMove(root: Object3D): void;
  /**
   * Is this page the one deciding? True only when the rigid-body world is
   * loaded (which happens on host election alone — docs/PLAN.md §7.6) AND
   * the agents are running. Both halves matter: a page that hosted a second
   * ago still has its bodies.
   */
  simulating(): boolean;
  /**
   * PRESENTATION ONLY — the viewer's half of the katamari rules, and the
   * host's own apply path too, so there is exactly one of them.
   *
   * These decide nothing, run no physics and record nothing. They take the
   * offsets and rotations the host already worked out and put the world into
   * that state: hide the placement, seat the item on the pile at the GIVEN
   * offset, grow the carrier. A `stick` for an unknown carrier, or a `drop`
   * for an item nobody is carrying, is ignored rather than guessed at.
   *
   * ALL SIX NO-OP IN A WORLD WITHOUT THE GAME (src/world/game.ts, 2026-09-15
   * user ruling). Ignored for the same reason an unknown carrier is: a world
   * with no pickups has no pile to seat anything on and no loose layer to draw
   * a fallen prop in, so an event of one of these kinds off the wire or out of
   * a restored log describes a world this page is not running. `src/main.ts`
   * also leaves the six off its replay driver there, so in practice nothing
   * even reaches them — this is the second lock, not the first.
   */
  applyStick(record: StickRecord): void;
  applyDrop(record: DropRecord): void;
  applyLoose(item: string, x: number, z: number): void;
  applySettle(record: SettleRecord): void;
  /**
   * PRESENTATION ONLY, again — the two destruction states.
   *
   * `applyCrack` brings a prop up to a stage: 1 puts cracks on it (the ink
   * pass draws them), 2 hides the placement and draws the prop as its chunk
   * set minus the section that has gone, 3 lets the rest go as rubble.
   * Bringing a prop straight to 3 passes through the same code, because a
   * restored log carries only the last crack per item.
   *
   * `applyShatter` is the whole-prop version: hide the placement, and every
   * chunk at once.
   *
   * On the HOST these also build the bodies, because the host is a page too
   * — there is one presentation path and it asks whether it has physics
   * rather than there being two.
   */
  applyCrack(item: string, stage: number): void;
  applyShatter(record: ShatterRecord): void;
  /** Live wreck states, for the ghost panel and the tests. */
  wrecks(): { item: string; stage: number; removed: number }[];
}

export function createCreatureManager(
  world: WorldHandles,
  options: CreatureManagerOptions = {},
): CreatureManager {
  const observer = options.observer;
  const autoHatch = options.autoHatch ?? AUTO_HATCH;
  /**
   * Does this manager play the katamari? (src/world/game.ts, 2026-09-15 user
   * ruling.) Off unless a caller says the exact word, like every other
   * per-world switch in this project — the shipped world is the default, and
   * a game that switched itself on by mistake is a world nobody asked for.
   */
  const katamari = sanitizeGame(options.game) === 'katamari';
  /**
   * The gait is OFF in a katamari world.
   *
   * A rolling ball has no walk cycle: the body is inside the pile's rolling
   * group and the whole creature turns with its travel, so a leg shear and a
   * waddle on top of that is two locomotions at once. Feeding the gait zero
   * (rather than deleting it) keeps the amplitude spring at rest and leaves
   * the ambient drift floor — which is `character.update`'s, not the gait's —
   * running underneath, as TASTE §3 requires.
   */
  const locoSpeed = (speed: number): number => (katamari ? 0 : speed);
  const surface = options.surface ?? ROLLING_SURFACE;
  const slots = new Map<string, Slot>();
  let orderCounter = 0;
  let timersPaused = false;
  let aiPaused = false;
  /**
   * The speed multiplier every creature here runs at — the agents' wander and
   * the drive ceiling both read it, and the ghost panel's wander/speed slider
   * writes it.
   *
   * KATAMARI GETS ITS OWN DEFAULT, and that is the whole of the speed change
   * (user ask, 2026-09-16: *"the walking cycle is way too slow"*). It is a
   * different default rather than a factor ON the shipped one because the
   * shipped 1.4 is a tuning of a WALK — multiplying the two would put the
   * stick at 5.04 u/s, past the 3 the ruling asked for. At
   * `KATAMARI_SPEED_MUL` the drive ceiling is `MAX_SPEED × 3` = 3.6 u/s
   * exactly, which is the number the substep guard was checked against.
   */
  let wanderSpeedMult = katamari ? KATAMARI_SPEED_MUL : WANDER_SPEED_DEFAULT;

  // ── physics scratch (allocation-free per frame) ───────────────────────────
  // The prop spatial hash rebuilds only when the scatter's collider version
  // moves (density/exclusion changes) — per frame it is queries only, so the
  // cost is O(creatures × nearby), never O(creatures × all props).
  let colliderGrid: ColliderGrid | null = null;
  let colliderGridVersion = -1;
  const nearScratch: Collider[] = [];
  const eggColliderPool: Collider[] = [];
  let eggColliderCount = 0;
  const bodyPool: CreatureBody[] = [];
  const stepBodies: CreatureBody[] = [];
  // Peer lookup (src/physics/spatial.ts): every alive root indexed once a
  // frame, queried once per agent. Points are reused, never reallocated.
  const peerGrid = new SpatialHash(PEER_RADIUS);
  const peerSlots: Slot[] = [];
  const peerPoints: { x: number; z: number }[] = [];
  const peersScratch: AgentPeer[] = [];
  // Frustum test for the off-screen stride. Scratch only.
  const frustum = new Frustum();
  const frustumMatrix = new Matrix4();
  const boundsSphere = new Sphere();
  const aliveScratch: {
    slot: Slot;
    root: Group;
    body: CreatureBody;
    heading: number;
    /** Gizmo-held: the body is an obstacle but the root is never written. */
    held?: boolean;
  }[] = [];

  /** Lazily (re)index the scatter's prop colliders — shared by the per-frame
   * update AND spawn placement, so an egg placed before the first frame
   * still sees the world. */
  function ensureColliderGrid(): ColliderGrid | null {
    const scatterPhysics = readScatterPhysics(world);
    if (!scatterPhysics) {
      colliderGrid = null;
      colliderGridVersion = -1;
      return null;
    }
    const version = scatterPhysics.collidersVersion();
    if (version !== colliderGridVersion || !colliderGrid) {
      colliderGrid = buildColliderGrid(scatterPhysics.colliders());
      colliderGridVersion = version;
    }
    return colliderGrid;
  }

  /**
   * Deterministic spawn spot, projected clear of the world: the golden-angle
   * spiral reaches past the scatter's origin clearing (radius ~20 vs the
   * ~11u planted-free field), so raw spots CAN land inside a rock or under a
   * building — and an egg placed there sits visibly clipped for its whole
   * incubation. Push out of hard props (with the same visual pad the live
   * resolve uses) and out of every resident egg/creature, re-projecting
   * against props after each resident push so the final spot is clear of
   * both.
   */
  function clearSpawnSpot(spot: { x: number; z: number }): { x: number; z: number } {
    const grid = ensureColliderGrid();
    let p = projectOutOfHard(spot, grid, SPAWN_CLEARANCE);
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const s of slots.values()) {
        if (s.phase === 'retiring') continue;
        const root: Object3D | null = s.characterRoot ?? s.egg?.group ?? null;
        if (!root) continue;
        const residentR = s.characterRoot ? s.bodyR : (s.egg?.radius ?? 0);
        const min = residentR + SPAWN_CLEARANCE;
        const dx = p.x - root.position.x;
        const dz = p.z - root.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= min) continue;
        const nx = d > 1e-9 ? dx / d : 1;
        const nz = d > 1e-9 ? dz / d : 0;
        p = { x: root.position.x + nx * min, z: root.position.z + nz * min };
        moved = true;
      }
      if (!moved) break;
      p = projectOutOfHard(p, grid, SPAWN_CLEARANCE);
    }
    return p;
  }

  /** Gather everything hard/soft near a circle into nearScratch: spatial-hash
   * props plus the (few) static egg colliders. */
  function gatherNear(x: number, z: number, r: number): readonly Collider[] {
    nearScratch.length = 0;
    if (colliderGrid) {
      for (const c of colliderGrid.queryCircle(x, z, r + COLLIDER_QUERY_PAD)) {
        nearScratch.push(c);
      }
    }
    for (let i = 0; i < eggColliderCount; i++) {
      const c = eggColliderPool[i]!;
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = r + COLLIDER_QUERY_PAD + c.r;
      if (dx * dx + dz * dz < rr * rr) nearScratch.push(c);
    }
    return nearScratch;
  }

  function worldPositionOf(slot: Slot): Vector3 | null {
    const root: Object3D | null = slot.characterRoot ?? slot.egg?.group ?? null;
    if (!root) return null;
    // Carried: `root.position` is a seat on a pile, not a place on the map.
    if (slot.carriedBy) {
      const at = root.getWorldPosition(new Vector3());
      return new Vector3(at.x, 0, at.z);
    }
    return new Vector3(root.position.x, 0, root.position.z);
  }

  function disposeSlot(slot: Slot): void {
    /*
     * WHAT IT WAS CARRYING IS NOT ITS TO TAKE.
     *
     * Every passenger is set down free where it actually is and every prop is
     * left lying there, each with a `drop` recorded — so a person whose
     * creature was riding on the one that just retired gets their creature
     * back, standing in the field, rather than watching it vanish with
     * somebody else's. And if this one was itself being carried, it comes off
     * its carrier's pile first, or the carrier would go on growing from a
     * volume that no longer exists.
     */
    releaseAll(slot);
    if (slot.carriedBy) {
      const carrier = slots.get(slot.carriedBy);
      if (carrier && slot.characterRoot) {
        slot.characterRoot.getWorldPosition(scratchVec);
        unseat(carrier, `creature:${slot.id}`, scratchVec.x, scratchVec.z, IDENTITY_Q);
      }
      slot.carriedBy = null;
    }
    removeKinematic(slot);
    slot.clump?.dispose();
    slot.clump = null;
    slot.agent?.dispose();
    slot.agent = null;
    if (slot.hatch) slot.hatch.dispose();
    if (slot.egg) {
      world.scene.remove(slot.egg.group);
      slot.egg.dispose();
    }
    world.shadows.removeShadow(`egg-${slot.id}`);
    if (slot.characterRoot) world.scene.remove(slot.characterRoot);
    slot.character?.dispose();
    slot.pending?.dispose();
    world.shadows.removeShadow(`char-${slot.id}`);
    slots.delete(slot.id);
  }

  /** Sink-and-fade retirement — a slide out, never a cut. */
  function beginRetire(slot: Slot, nowMs: number): void {
    if (slot.phase === 'retiring') return;
    slot.phase = 'retiring';
    slot.retireStartMs = nowMs;
    observer?.retire(slot.id, 'population');
  }

  /**
   * The moment a slot stops being an egg and becomes a living creature.
   *
   * Split out of the hatch so it can happen WITHOUT one. A creature that
   * hatched last month is not hatching now, and a visitor opening a link
   * should not have to watch sixty-eight shells break to see a world that
   * has been standing for weeks (user ruling, 2026-08-25: *"we shouldn't
   * have to hatch on every user's load"*). The hatch animation is the
   * arrival; this is the life, and only arrivals need both.
   */
  function becomeAlive(slot: Slot, root: Group, character: Character): void {
    slot.character = character;
    slot.pending = null;
    slot.characterRoot = root;
    // Named so the ghost-panel scene outliner lists each creature legibly
    // (user ask). Lowercase, name over id when the drawer signed one.
    root.name = slot.name ? `creature ${slot.name}` : `creature ${slot.id}`;
    slot.characterShadow = world.shadows.addShadow(`char-${slot.id}`, character.radius);
    // Collision circle from the REAL mesh footprint (wide fish ≠ narrow
    // triangle) — never the tucked-in shadow radius.
    slot.bodyR = measureBodyRadius(character);
    slot.baseR = slot.bodyR;
    /*
     * The pile, from this moment on (src/creatures/clump.ts).
     *
     * On the ROOT and never on `character.group`: the body's local transform
     * is rewritten every frame by the gait and its mesh is deformed in a
     * vertex shader, so anything hung underneath would be squashed and
     * bobbed along with it. The clump is created empty on every page —
     * a viewer needs it too, because a viewer is the page the pile has to be
     * DRAWN on.
     *
     * …in the KATAMARI world and nowhere else (src/world/game.ts). A world
     * with no pickups has no pile, so there is no clump on the root, no growth
     * curve reading off it, and `bodyR` stays the measured footprint for the
     * life of the creature. Guarded HERE, at the creation point, rather than
     * only in the frame: a clump that exists is a clump something can seat an
     * item into.
     */
    if (katamari) {
      slot.clump = createClump(slot.baseR);
      root.add(slot.clump.group);
      /*
       * AND THE CREATURE ITSELF GOES IN THE BALL (user ask, 2026-09-16:
       * *"like Katamari Damacy, we should have the character ROLL versus
       * walk"*).
       *
       * The pile already rolled; the body slid along beside it, which read as
       * a creature pushing a ball rather than a creature that IS one. So the
       * body — and the stalk and topper and eyes parented to it — moves
       * inside `clump.group`, the one thing in the rig that accumulates the
       * no-slip roll. Eyes and topper turn with the ball, which is the whole
       * look.
       *
       * THE BALL'S CENTRE IS THE ROLL CENTRE. `clump.group` sits at
       * `(0, baseR, 0)` on the root — the middle of the creature — and the
       * body mesh rests with its base at its own group's origin, so a wrapper
       * at `(0, -baseR, 0)` inside the clump puts the body's centre on the
       * rotation centre and its base back on the ground. Net local offset
       * zero: the creature stands exactly where it stood, it just turns about
       * its middle now.
       *
       * The HEADING stays on the root, untouched. The clump already expresses
       * its world roll under whatever the root is doing
       * (`inverse(root.quaternion) × worldQ`), so the two compose without
       * either knowing about the other.
       */
      const ball = new Group();
      ball.name = 'ball';
      ball.position.set(0, -slot.baseR, 0);
      // Reparent, not copy: `Object3D.add` detaches from the root first.
      ball.add(character.group);
      slot.clump.group.add(ball);
    }
    world.shadows.removeShadow(`egg-${slot.id}`);
    slot.eggShadow = null;
    slot.egg = null;
    slot.phase = 'alive';
    // The hidden life: seed from the slot id, personality from the audience
    // answer (null → mild seeded variation).
    const seed = behaviorSeed(slot.id);
    slot.agent = new BehaviorAgent(seed, personalityFromChoice(slot.personalityChoice, seed));
    slot.agent.setSpeedMultiplier(wanderSpeedMult);
  }

  function beginHatch(slot: Slot, cause: 'timer' | 'forced'): void {
    if (!slot.egg || slot.hatch || !slot.pending) return;
    const next = slot.pending;
    slot.phase = 'hatching';
    observer?.hatch(slot.id, cause);
    // The hatch owns the root's height until it lets go: the rise from
    // under the ground is a y animation, and the per-frame ground pass
    // below stands off while it runs (see the pass). Handing it the same
    // Surface is what keeps the two agreeing at the handover — the rise
    // ends exactly on the ground the pass will then hold it to.
    slot.hatch = startHatch(
      world.scene,
      slot.egg,
      next,
      {
        onBurst: (root) => {
          becomeAlive(slot, root, next);
          // the egg's disposal belongs to the hatch from here.
          // The camera stays where it is (user ask, 2026-09-15: *"we
          // shouldn't have the camera follow the spawn, it should be in one
          // place"*). It used to slide to every shell that broke; at two
          // hundred hatches that is a camera that never rests. The tour and
          // the operator's `h` moment (src/world/tour.ts) still frame what
          // they choose to.
        },
        onDone: () => {
          slot.hatch = null;
        },
      },
      { surface },
    );
  }

  /**
   * Put a creature straight into the world, grown, with no egg at all.
   *
   * Not a shortcut through the hatch — there is no hatch. No egg mesh is
   * built, no shell animation runs, no `hatch` event is recorded, and the
   * camera does not swing to it. It is simply already here, which is the
   * truth about a creature somebody drew last month.
   */
  function placeGrown(slot: Slot): boolean {
    const character = slot.pending;
    if (!character) return false;
    if (slot.egg) {
      world.scene.remove(slot.egg.group);
      slot.egg.dispose();
      slot.egg = null;
    }
    // The SAME two-level rig the hatch builds (src/egg/hatch.ts §onBurst):
    // an empty wrapper owns the WORLD position, and `character.group` hangs
    // inside it owning only the creature's own local offset — the lean and
    // bob that `character.update()` rewrites every single frame.
    //
    // These two must never be the same object. Collapsing them (as this
    // did) hands the animation the world transform: the spawn position is
    // erased on the next tick, sixty-eight creatures land on the origin in
    // one heap, and the physics pass then spends every frame fighting the
    // animation for the same three floats — which is what the spazzing was.
    // The double-counted shadow (`root.position + character.group.position`
    // in the step loop) is the same mistake seen from the other side.
    const root = new Group();
    // Standing ON the ground from its first frame — sampled, never assumed
    // (PLAN §7.2). The per-frame ground pass keeps it there as it walks.
    root.position.set(
      slot.spot.x,
      surface.sampleHeight(slot.spot.x, slot.spot.z),
      slot.spot.z,
    );
    root.add(character.group);
    world.scene.add(root);
    becomeAlive(slot, root, character);
    return true;
  }

  // ── the sticky world (src/creatures/sticky.ts, docs/PLAN.md §7.6) ─────────
  /*
   * WHO DECIDES, AND WHO DRAWS.
   *
   * Everything below splits in two along one line. `simulateSticky` runs on
   * the page that holds the rigid-body world and nowhere else: it is the only
   * thing that ever calls `decideContact` or `shouldDrop`, and every decision
   * it makes leaves through the observer as a `stick`, `drop`, `loose` or
   * `settle` scene event. `applyStick` and its three siblings are the other
   * half — presentation from an event, on a page that ran no physics and
   * decided nothing.
   *
   * The host does NOT go round through its own events (main.ts's
   * `applyingScene` guard swallows them on the way out): it applies its own
   * decision as it makes it, through the same `seat`/`unseat` helpers the
   * apply path uses, so there is exactly one way an item gets onto a pile.
   */

  const looseMeshes = options.loose ?? null;
  const bodiesOf = (): PropBodies | null => world.bodies?.() ?? null;
  /**
   * The frame time this module was last given.
   *
   * The impact seam fires from inside `PropBodies.update` — rapier's own
   * contact events, drained a step after this module's frame callback has
   * run — so a rule that reaches it has no `nowMs` of its own. The drop rate
   * cap needs one (`DROP_MIN_GAP_MS`), and the honest answer is "the frame
   * we are in", which is this.
   */
  let lastNowMs = 0;
  const scratchVec = new Vector3();
  const scratchQ = new Quaternion();

  /**
   * Placements THIS page has hidden, on a page with no `PropBodies`.
   *
   * `scatter.setTaken` takes the whole set, so it has exactly one owner. On
   * the host that owner is `src/world/rocks.ts`, which is holding the bodies
   * anyway; on a viewer there is no rocks layer at all and this is it.
   */
  const viewerTaken = new Set<string>();

  /** Stop the scatter drawing a placement, through whichever owner exists. */
  function hidePlacement(key: string): void {
    const bodies = bodiesOf();
    if (bodies) {
      bodies.take(key);
      return;
    }
    const scatter = (world as { scatter?: { setTaken?(keys: ReadonlySet<string>): void } })
      .scatter;
    if (!scatter?.setTaken) return;
    viewerTaken.add(key);
    scatter.setTaken(new Set(viewerTaken));
  }

  /**
   * The kind and variant a placement key spells out.
   *
   * `placementKey` is `kind:variant:x:z` (src/world/scatter.ts), which is why
   * a `loose` event needs no mesh hints of its own — the key already says
   * what the thing is. A `spawn:n` rock or a `creature:<id>` parses to null,
   * and both are meant to.
   */
  function parseItemKey(
    key: string,
  ): { kind: PropKind; variant: number; x: number; z: number } | null {
    const parts = key.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as PropKind;
    if (!Object.prototype.hasOwnProperty.call(STICKY, kind)) return null;
    const variant = Number(parts[1]);
    if (!Number.isInteger(variant) || variant < 0) return null;
    // The place, when the key carries one. A full placement key is
    // `kind:variant:x:z` and the two coordinates are the only description of
    // WHERE a prop stood that survives the scatter forgetting about it —
    // which is exactly the moment the destruction layer needs it.
    const x = Number(parts[2]);
    const z = Number(parts[3]);
    const placed = Number.isFinite(x) && Number.isFinite(z);
    return { kind, variant, x: placed ? x : 0, z: placed ? z : 0 };
  }

  /**
   * The drawn scale and footprint of a STANDING placement, off the scatter's
   * own instance row.
   *
   * Exact rather than assumed: a viewer hiding a tree has to draw the fallen
   * one at the size the standing one was, and the row is where that number
   * already lives. Null once the placement is gone, which is why a `stick`
   * event carries the scale as well — by the time a phone applies one the
   * row it came from has been rebuilt away.
   */
  function placementDrawn(
    key: string,
    kind: PropKind,
  ): { scale: number; r: number; rotY: number } | null {
    const scatter = (
      world as {
        scatter?: {
          instanceRefs?(k: PropKind): {
            key: string;
            scale: number;
            radius: number;
            placement?: { rotY?: number };
          }[];
        };
      }
    ).scatter;
    const refs = scatter?.instanceRefs?.(kind);
    if (!refs) return null;
    for (const ref of refs) {
      // The yaw as well, for the destruction layer: a chunk's offset is in
      // the prop's own object space, so seating it needs the turn the
      // placement was drawn at (src/world/chunks.ts).
      if (ref.key === key) {
        return { scale: ref.scale, r: ref.radius, rotY: ref.placement?.rotY ?? 0 };
      }
    }
    return null;
  }

  /** `creature:<id>` → the slot, if it is one and it exists. */
  function passengerOf(item: string): Slot | null {
    if (!item.startsWith('creature:')) return null;
    return slots.get(item.slice('creature:'.length)) ?? null;
  }

  /**
   * Where an item slides IN from, in clump-local space: wherever it actually
   * is at this instant.
   *
   * Entrances slide and never pop (TASTE §2.1, confidence 1.00) — there is no
   * `scale: 0 → 1` path in this project and a stone appearing at full size on
   * a pile is exactly the hard cut the motion law forbids. The item was
   * struck a little outside its seat, so this is a short travel over
   * `MOTION.secondaryMs`. On a viewer applying a restored log the object has
   * no world transform yet, so the seat itself is used and nothing moves —
   * which is right, because nothing arrived.
   */
  function enterFrom(
    carrier: Slot,
    object: Object3D,
    offset: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } {
    const group = carrier.clump?.group;
    if (!group || !object.parent) return offset;
    object.getWorldPosition(scratchVec);
    group.worldToLocal(scratchVec);
    if (!Number.isFinite(scratchVec.x + scratchVec.y + scratchVec.z)) return offset;
    return { x: scratchVec.x, y: scratchVec.y, z: scratchVec.z };
  }

  /**
   * Put one item onto a carrier's pile, at the offset and rotation GIVEN.
   *
   * Never computed here: on the host they came out of `clumpLocalOffset` a
   * few lines before the observer call, and on a viewer they came off the
   * wire. Three floats and four floats, and every screen seats the thing
   * identically from them — which is the whole reason that geometry is pure.
   *
   * `group.add` and not `Object3D.attach`: attach preserves a world transform
   * this overwrites anyway, and the continuity attach would have bought is
   * what the entrance slide is for.
   */
  function seat(carrier: Slot, record: StickRecord, opts: { slide?: boolean } = {}): boolean {
    const clump = carrier.clump;
    if (!clump || carrier.phase !== 'alive') return false;
    if (clump.items.has(record.item)) return false;
    const rotation = { x: record.qx, y: record.qy, z: record.qz, w: record.qw };
    const offset = { x: record.ox, y: record.oy, z: record.oz };

    const rider = passengerOf(record.item);
    if (rider) {
      if (!rider.characterRoot || rider.phase !== 'alive' || rider.carriedBy) return false;
      if (rider === carrier) return false;
      /*
       * A CARRIED CREATURE. Its phone still owns it — emotes play, and
       * `poses()` reports where it has been carried TO, so the person
       * watching their minimap follows the pile rather than losing their
       * creature, which is the whole joke. What it loses is its own
       * locomotion: out of the physics pass, agent stood down, shadow gone
       * (the pile casts one), and whatever host pose it was following
       * dropped — a viewer easing a passenger toward the host's old answer
       * would drag it out of the pile it is sitting in.
       */
      rider.carriedBy = carrier.id;
      carrier.passengers.add(rider.id);
      rider.follow = null;
      rider.drive = null;
      world.shadows.removeShadow(`char-${rider.id}`);
      rider.characterShadow = null;
      removeKinematic(rider);
      clump.add({
        key: record.item,
        object: rider.characterRoot,
        r: rider.bodyR,
        offset,
        rotation,
        from: enterFrom(carrier, rider.characterRoot, offset),
        // Transitive: a passenger goes on collecting, and its carrier has to
        // keep growing as it does.
        nested: () => rider.clump?.volumes() ?? [],
      });
      return true;
    }

    // A prop. It stops being scenery and becomes a mesh of its own.
    const parsed = parseItemKey(record.item);
    const kind = (record.kind as PropKind | undefined) ?? parsed?.kind;
    if (!kind || !Object.prototype.hasOwnProperty.call(STICKY, kind)) return false;
    const measured = placementDrawn(record.item, kind);
    const variant = record.variant ?? parsed?.variant ?? 0;
    const scale = record.scale ?? measured?.scale ?? 1;
    hidePlacement(record.item);
    if (!looseMeshes) return false;
    const object = looseMeshes.show(record.item, kind, variant, scale);
    /*
     * WHERE IT SLIDES IN FROM, and why a prop is the one case that has to ask.
     *
     * A creature passenger is standing somewhere real on every page, so its
     * slide is always a short travel from where it was. A prop's mesh is
     * created HERE — and on the host `stickItem` has already moved it to the
     * stone's live transform, so sliding from it is the stone being scooped
     * up. On a viewer applying a `stick` there is no live transform to slide
     * from: the mesh is brand new at the origin, and sliding from there would
     * fly a tree across the map. So the viewer seats it and nothing moves,
     * which is right — nothing arrived, the world simply is like this.
     */
    clump.add({
      key: record.item,
      object,
      r: measured?.r ?? scale,
      kind,
      variant,
      scale,
      offset,
      rotation,
      ...(opts.slide === true ? { from: enterFrom(carrier, object, offset) } : {}),
    });
    return true;
  }

  /**
   * Take one item off a carrier and put it back in the world at (x, z).
   *
   * The height is the seam's, never world-space Y (PLAN §7.2). A passenger
   * walks away free — agent back, shadow back, into the physics pass again.
   * A prop becomes a loose mesh lying where it fell, and on the host a
   * dynamic body under it.
   */
  function unseat(
    carrier: Slot,
    item: string,
    x: number,
    z: number,
    q: { x: number; y: number; z: number; w: number },
  ): boolean {
    const stuck = carrier.clump?.remove(item);
    if (!stuck) return false;
    const y = surface.sampleHeight(x, z);

    const rider = passengerOf(item);
    if (rider && rider.characterRoot === stuck.object) {
      carrier.passengers.delete(rider.id);
      rider.carriedBy = null;
      // `scene.attach` and not `add`: it is standing somewhere in the world
      // already and it stays exactly there, rather than jumping by the
      // pile's whole transform — which would be the hard cut the motion law
      // forbids at confidence 1.00.
      world.scene.attach(rider.characterRoot);
      rider.characterRoot.position.set(x, y, z);
      // Its own pile is its own; the carrier's scale and the pile's tilt are
      // not its to keep. The heading survives, because a creature set down
      // is facing whichever way it was.
      rider.characterRoot.scale.setScalar(rider.clump?.growth() ?? 1);
      rider.characterRoot.rotation.set(0, rider.characterRoot.rotation.y, 0);
      if (rider.character) {
        rider.characterShadow = world.shadows.addShadow(
          `char-${rider.id}`,
          rider.character.radius,
        );
      }
      rider.spot = { x, z };
      return true;
    }

    world.scene.attach(stuck.object);
    // Out of the carrier's scale and back to its own drawn one.
    stuck.object.scale.setScalar(stuck.scale ?? 1);
    looseMeshes?.move(item, x, y, z, q);
    const bodies = bodiesOf();
    if (bodies && stuck.kind) {
      bodies.restore(
        {
          key: item,
          kind: stuck.kind,
          variant: stuck.variant ?? 0,
          scale: stuck.scale ?? 1,
          r: stuck.r,
        },
        x,
        z,
        q,
      );
    }
    return true;
  }

  /** Start drawing a prop that has left the ground, at the ground height
   * under it. Shared by `loosen` on the host and `applyLoose` everywhere. */
  function showLoose(item: string, x: number, z: number, scaleHint?: number): void {
    if (!looseMeshes) return;
    const parsed = parseItemKey(item);
    if (!parsed) return;
    const measured = placementDrawn(item, parsed.kind);
    looseMeshes.show(item, parsed.kind, parsed.variant, scaleHint ?? measured?.scale ?? 1);
    looseMeshes.move(item, x, surface.sampleHeight(x, z), z, IDENTITY_Q);
  }

  // ── destruction (src/world/wreck.ts, src/world/debris.ts) ────────────────
  /*
   * WHO DECIDES, AND WHO PRESENTS — the same line the katamari rules draw.
   *
   * The host accumulates damage and calls `decideContact`; what leaves is a
   * `crack` or a `shatter`, both of them STATES. Every page — the host
   * included, through the same functions — turns a state into a picture: the
   * ink pass draws cracks on a prop that is still standing, the chunk set is
   * drawn where the prop stood once a section has gone, and the pieces that
   * have been let go are debris.
   *
   * WHY THE PRESENTATION IS HERE and not in the debris layer. It needs the
   * scatter (to hide a placement), the loose meshes (to draw a ruin), the
   * surface seam (for the one height in the world) and the observer (to say
   * what it decided) — which is this module's whole set of collaborators. The
   * debris layer below it owns exactly one thing: a piece of a prop with a
   * lifetime and maybe a body.
   */

  const debris = options.debris ?? null;
  const chunkSource = options.chunks ?? ((): null => null);
  /**
   * Cumulative impact per placement, HOST ONLY.
   *
   * The brief's *"initially resist, can become loose after repeated
   * impact"*: a building wears down rather than answering each hit on its
   * own. It is not in the log and it is not on the wire — what a viewer
   * needs is the stage, and the stage is the event.
   *
   * Bounded by the number of staged props anybody has ever hit, which is
   * bounded by the placements on the map.
   */
  const damage = new Map<string, number>();
  /** What has broken, on EVERY page. Keyed by placement key. */
  const wrecks = new Map<string, WreckState>();

  /** The chunk set for one (kind, variant), or null when this page has none
   * (no chunk map, an unbreakable kind, a variant past the end). */
  function chunksFor(kind: PropKind, variant: number): Chunk[] | null {
    const set = chunkSource()?.get(kind as ChunkKind);
    return set?.[variant] ?? null;
  }

  /**
   * The ink pass's crack list, rebuilt from the wrecks that are still
   * standing.
   *
   * Rebuilt rather than appended to because it is a state and the pass takes
   * the whole of it (`InkPass.setCracks`) — and because a wreck stops being
   * a cracked prop the moment it collapses, which no append could express.
   * Only stages 1 and 2 are in it: stage 3 is rubble, and there is nothing
   * left to draw a crack on.
   */
  function refreshCracks(): void {
    const ink = (
      world as { ink?: { setCracks?(marks: readonly { x: number; z: number; r: number; seed: number; y?: number }[]): void } }
    ).ink;
    if (!ink?.setCracks) return;
    const marks: { x: number; z: number; r: number; seed: number; y: number }[] = [];
    for (const state of wrecks.values()) {
      if (state.stage < 1 || state.stage >= 3) continue;
      const measured = placementDrawn(state.key, state.kind);
      // A prop the scatter has stopped drawing has no row to measure, so the
      // radius falls back to the scale it was recorded at. CRACK_RADIUS is
      // the disc the marks are drawn inside: a touch wider than the
      // footprint, so the cracks run onto the form rather than stopping
      // short of its silhouette. **[D]**
      const r = (measured?.r ?? state.scale) * 1.6;
      const spread = fragmentSpread(state.key, 0);
      marks.push({
        x: state.x,
        z: state.z,
        r,
        // An angle out of the same deterministic fold the fragments use, so
        // two cracked buildings are not cracked identically and the same one
        // is cracked the same way on every screen.
        seed: Math.atan2(spread.z, spread.x),
        // The seam owns every height in the world (PLAN §7.2).
        y: surface.sampleHeight(state.x, state.z),
      });
    }
    ink.setCracks(marks);
  }

  /** The record for a broken placement, made on first sight. `hint` is a
   * `shatter` event's own pose, for a page whose scatter row is already
   * gone. */
  function ensureWreck(
    item: string,
    hint?: { kind: PropKind; variant: number; scale: number; x: number; z: number; rotY: number },
  ): WreckState | null {
    const existing = wrecks.get(item);
    if (existing) return existing;
    const parsed = parseItemKey(item);
    const kind = hint?.kind ?? parsed?.kind;
    if (!kind) return null;
    const variant = hint?.variant ?? parsed?.variant ?? 0;
    const measured = placementDrawn(item, kind);
    const state = createWreck({
      key: item,
      kind,
      variant,
      scale: hint?.scale ?? measured?.scale ?? 1,
      x: hint?.x ?? parsed?.x ?? 0,
      z: hint?.z ?? parsed?.z ?? 0,
      rotY: hint?.rotY ?? measured?.rotY ?? 0,
    });
    wrecks.set(item, state);
    return state;
  }

  /** A wreck as the debris layer wants a parent described. */
  function parentOf(state: WreckState): {
    key: string;
    kind: PropKind;
    variant: number;
    scale: number;
    x: number;
    z: number;
    rotY: number;
  } {
    return {
      key: state.key,
      kind: state.kind,
      variant: state.variant,
      scale: state.scale,
      x: state.x,
      z: state.z,
      rotY: state.rotY,
    };
  }

  /**
   * Draw the part of a broken prop that is STILL THERE.
   *
   * One mesh per surviving chunk, seated where that chunk sits inside the
   * prop: the offset is in the prop's object space at scale 1, so it scales
   * by the instance and turns by the placement's yaw, and the height under
   * it comes off the seam. Static — a ruin does not move, and on the host
   * these are deliberately NOT bodies: the placement's own collider went
   * with `take`, so a creature can drive into the ruin and bring the rest of
   * it down, which is the point of a staged collapse.
   */
  function showRuin(state: WreckState, standing: readonly number[]): void {
    if (!looseMeshes) return;
    const chunks = chunksFor(state.kind, state.variant);
    if (!chunks) return;
    const cos = Math.cos(state.rotY);
    const sin = Math.sin(state.rotY);
    const baseY = surface.sampleHeight(state.x, state.z);
    const q = { x: 0, y: Math.sin(state.rotY / 2), z: 0, w: Math.cos(state.rotY / 2) };
    for (const index of standing) {
      const chunk = chunks[index];
      if (!chunk) continue;
      const key = `${state.key}#${index}`;
      looseMeshes.show(key, state.kind, state.variant, state.scale);
      const ox = chunk.offset.x * state.scale;
      const oz = chunk.offset.z * state.scale;
      looseMeshes.move(
        key,
        state.x + ox * cos + oz * sin,
        baseY + chunk.offset.y * state.scale,
        state.z - ox * sin + oz * cos,
        q,
      );
    }
  }

  /**
   * Bring a prop up to `stage` — the presentation half, on every page.
   *
   * Written as "up to", not "one more": a `crack` carries an absolute stage,
   * `compactScene` keeps only the last one per item, and a page that hears
   * 3 having missed 1 and 2 has to land where a page that heard all three
   * did (src/world/wreck.ts `advance`).
   */
  function applyCrackLocal(item: string, stage: number): void {
    const clamped = (stage < 1 ? 1 : stage > 3 ? 3 : Math.floor(stage)) as 1 | 2 | 3;
    const state = ensureWreck(item);
    if (!state) return;
    const chunks = chunksFor(state.kind, state.variant);
    if (!chunks) {
      // No chunk set on this page: the stage is still recorded (so the ink
      // can crack it and a later event is not a surprise), and there is
      // simply nothing to take apart.
      if (clamped > state.stage) state.stage = clamped;
      refreshCracks();
      return;
    }
    const before = state.stage;
    const change = advance(state, clamped, chunks);
    // Stage 2 is where the prop stops being scenery: the placement is hidden
    // and what is drawn from here is the chunk set.
    if (state.stage >= 2 && before < 2) hidePlacement(item);
    if (state.stage >= 2) showRuin(state, change.standing);
    if (change.freed.length > 0 && debris) {
      // The pieces that have gone: thrown outward, and downward when the
      // whole thing is coming down.
      debris.spawnFragments(parentOf(state), change.freed, {
        impact: damage.get(item) ?? 0,
        down: state.stage >= 3,
      });
    }
    refreshCracks();
  }

  /** The whole-prop version: every chunk at once (the `break` outcome). */
  function applyShatterLocal(record: ShatterRecord, impact: number): void {
    const kind = record.kind as PropKind;
    if (!Object.prototype.hasOwnProperty.call(STICKY, kind)) return;
    const state = ensureWreck(record.item, {
      kind,
      variant: record.variant,
      scale: record.scale,
      x: record.x,
      z: record.z,
      rotY: record.rotY,
    });
    if (!state) return;
    hidePlacement(record.item);
    const chunks = chunksFor(state.kind, state.variant);
    if (!chunks) {
      state.stage = 3;
      refreshCracks();
      return;
    }
    const change = advance(state, 3, chunks);
    if (debris) debris.spawnFragments(parentOf(state), change.freed, { impact });
    refreshCracks();
  }

  // ── the carrier's kinematic stand-in (host only) ──────────────────────────

  /** Collider handle → the slot whose impacts it counts as. Creature balls
   * and the stuck-item balls hanging off them alike, so a bench swinging into
   * a tree is the CARRIER being hit. */
  const colliderSlot = new Map<number, string>();

  function removeKinematic(slot: Slot): void {
    const handle = slot.kinematic;
    if (!handle) return;
    const bodies = bodiesOf();
    if (handle.ball) colliderSlot.delete(handle.ball.handle);
    for (const collider of handle.stuck.values()) colliderSlot.delete(collider.handle);
    for (const registered of handle.sides.keys()) bodies?.unregisterForeign(registered);
    handle.sides.clear();
    handle.stuck.clear();
    slot.kinematic = null;
    const physics = world.physics?.() ?? null;
    physics?.remove(handle.body);
  }

  /**
   * Install the ONE contact-pair filter (`PhysicsWorld.setHooks`).
   *
   * A creature meeting an item small enough to carry returns `null` — no
   * contact at all, because the pickup is a decision this layer makes a few
   * lines later and a solver impulse arriving first would knock the thing
   * away before it could be taken. Everything else gets ordinary impulses:
   * a stone too big to carry is shoved, which is the stone rolling away, and
   * that is the rapier layer doing its job for free.
   */
  let hooksInstalled = false;
  function ensureHooks(): void {
    if (hooksInstalled) return;
    const physics = world.physics?.() ?? null;
    const bodies = bodiesOf();
    if (!physics || !bodies) return;
    hooksInstalled = true;
    const flags = physics.rapier.SolverFlags.COMPUTE_IMPULSE;
    physics.setHooks({
      // `PhysicsHooks` declares both halves, and only one of them is ours:
      // an intersection pair is a sensor question and nothing here is a
      // sensor, so it answers yes and gets out of the way.
      filterIntersectionPair: (): boolean => true,
      filterContactPair: (c1: number, c2: number): number | null => {
        const aSlot = colliderSlot.get(c1);
        const bSlot = colliderSlot.get(c2);
        // Creature-vs-creature and item-vs-item are not this filter's
        // business: the pure resolve separates creature pairs, and two
        // stones colliding is what rapier is for.
        if ((aSlot === undefined) === (bSlot === undefined)) return flags;
        const slot = slots.get((aSlot ?? bSlot)!);
        const item = bodies.itemByCollider(aSlot === undefined ? c1 : c2);
        if (!slot || !item) return flags;
        return item.r <= carryLimit(slot.bodyR) ? null : flags;
      },
    });
  }

  /** Create or refresh a creature's kinematic body and its ball. */
  function syncKinematic(slot: Slot, root: Group): void {
    // The KATAMARI world only (src/world/game.ts). A creature stands in the
    // rigid-body world so the props it rolls into can be knocked over and
    // picked up; with no game there are no rigid bodies to stand in, and the
    // guard is here at the creation point rather than only where the frame
    // calls it.
    if (!katamari) return;
    const physics = world.physics?.() ?? null;
    if (!physics) return;
    const rapier = physics.rapier;
    const y = surface.sampleHeight(root.position.x, root.position.z) + slot.bodyR;
    if (!slot.kinematic) {
      const body = physics.addRigidBody(
        rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
          root.position.x,
          y,
          root.position.z,
        ),
        rapier.ColliderDesc.ball(Math.max(0.05, slot.bodyR))
          .setActiveHooks(rapier.ActiveHooks.FILTER_CONTACT_PAIRS)
          .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS)
          .setRestitution(0),
      );
      const ball = body.collider(0);
      slot.kinematic = { body, ball, stuck: new Map(), sides: new Map() };
      if (ball) {
        colliderSlot.set(ball.handle, slot.id);
        // Named for the impact seam: a contact on this collider is THIS
        // creature hitting something, whatever it is holding.
        const side: ImpactSide = {
          key: slot.id,
          kind: 'creature',
          r: slot.bodyR,
          x: root.position.x,
          z: root.position.z,
          rooted: false,
        };
        slot.kinematic.sides.set(ball.handle, side);
        bodiesOf()?.registerForeign(ball.handle, side);
      }
      return;
    }
    slot.kinematic.body.setNextKinematicTranslation({ x: root.position.x, y, z: root.position.z });
    // The ball grows with the pile: a creature the size of a house that
    // still shouldered stones aside on its drawn radius would read as a
    // creature walking through the world rather than into it.
    slot.kinematic.ball?.setRadius(Math.max(0.05, slot.bodyR));
    const ballHandle = slot.kinematic.ball?.handle;
    const ballSide = ballHandle === undefined ? undefined : slot.kinematic.sides.get(ballHandle);
    if (ballSide) {
      // The registration is by reference, so keeping it truthful is three
      // writes rather than a re-register.
      ballSide.r = slot.bodyR;
      ballSide.x = root.position.x;
      ballSide.z = root.position.z;
    }
  }

  /**
   * Re-seat the carrier's stuck-item colliders at their CURRENT world
   * offsets, keeping the nearest `STUCK_COLLIDERS_MAX`.
   *
   * This is where the brief's instability comes from: a bench stuck to a
   * rolling pile sweeps a real circle through the world and hits real trees,
   * and the contact is attributed to the carrier so the impact counts
   * against what it is holding. A cap because a pile of eighty stones does
   * not need eighty colliders — the outermost are the ones that hit things,
   * and `outermost` order is exactly what a distance sort gives.
   */
  function syncStuckColliders(slot: Slot): void {
    const handle = slot.kinematic;
    const clump = slot.clump;
    const physics = world.physics?.() ?? null;
    if (!handle || !clump || !physics) return;
    const rapier = physics.rapier;
    const wanted = [...clump.items.values()]
      .sort((a, b) => {
        const da = a.offset.x ** 2 + a.offset.y ** 2 + a.offset.z ** 2;
        const db = b.offset.x ** 2 + b.offset.y ** 2 + b.offset.z ** 2;
        // Deterministic: distance, then key, so two frames agree and the set
        // does not flicker under a tie.
        return db - da || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      })
      .slice(0, STUCK_COLLIDERS_MAX);
    const keep = new Set(wanted.map((item) => item.key));
    const bodies = bodiesOf();
    for (const [key, collider] of handle.stuck) {
      if (keep.has(key)) continue;
      colliderSlot.delete(collider.handle);
      bodies?.unregisterForeign(collider.handle);
      handle.sides.delete(collider.handle);
      physics.world.removeCollider(collider, false);
      handle.stuck.delete(key);
    }
    const g = clump.growth();
    for (const item of wanted) {
      let collider = handle.stuck.get(item.key);
      if (!collider) {
        collider = physics.world.createCollider(
          rapier.ColliderDesc.ball(Math.max(0.05, item.r)).setRestitution(0),
          handle.body,
        );
        handle.stuck.set(item.key, collider);
        colliderSlot.set(collider.handle, slot.id);
        // A stuck item's ball is named as the CARRIER too: a bench swinging
        // into a sign is the creature hitting the sign, and the impact is
        // measured against the pile that swung it.
        const side: ImpactSide = {
          key: slot.id,
          kind: 'creature',
          r: item.r,
          x: 0,
          z: 0,
          rooted: false,
        };
        handle.sides.set(collider.handle, side);
        bodies?.registerForeign(collider.handle, side);
      }
      // The clump's own rotation, applied to the stored local offset: the
      // pile rolls, so the bench is somewhere different every frame.
      scratchVec.set(item.offset.x, item.offset.y, item.offset.z).multiplyScalar(g);
      scratchVec.applyQuaternion(clump.worldQ);
      // Plus the clump group's own lift off the creature's middle.
      collider.setTranslationWrtParent({
        x: scratchVec.x,
        y: scratchVec.y,
        z: scratchVec.z,
      });
      collider.setRadius(Math.max(0.05, item.r * g));
      const side = handle.sides.get(collider.handle);
      if (side) {
        side.r = item.r * g;
        // The collider's offset is relative to the carrier's body, so the
        // world place is that body's translation plus it.
        const at = handle.body.translation();
        side.x = at.x + scratchVec.x;
        side.z = at.z + scratchVec.z;
      }
    }
  }

  // ── decisions (host only) ────────────────────────────────────────────────

  /** Every loose body, re-indexed each frame — they move, so there is nothing
   * to keep. One pass over a handful of items. */
  const itemGrid = new SpatialHash(PEER_RADIUS);
  const itemList: LooseItem[] = [];
  const itemPoints: { x: number; z: number }[] = [];

  /**
   * Decide one pickup and tell the room.
   *
   * The offset and rotation come out of the item's LIVE transform — where the
   * stone actually is at the instant of contact, not where its placement was
   * — which is what makes the pile look assembled by running into things.
   */
  function stickItem(carrier: Slot, item: LooseItem, root: Group): void {
    const clump = carrier.clump;
    if (!clump) return;
    const t = item.body.translation();
    const r = item.body.rotation();
    clump.group.getWorldPosition(scratchVec);
    const offset = clumpLocalOffset({
      itemX: t.x,
      itemY: t.y,
      itemZ: t.z,
      centreX: scratchVec.x,
      centreY: scratchVec.y,
      centreZ: scratchVec.z,
      headingX: Math.sin(root.rotation.y),
      headingZ: Math.cos(root.rotation.y),
      R: clump.R(),
      itemR: item.r,
      clumpWorldQ: clump.worldQ,
      growth: clump.growth(),
    });
    const rotation = clumpLocalRotation(r, clump.worldQ);
    const record: StickRecord = {
      id: carrier.id,
      item: item.key,
      kind: item.kind,
      variant: item.variant,
      scale: item.scale,
      ox: offset.x,
      oy: offset.y,
      oz: offset.z,
      qx: rotation.x,
      qy: rotation.y,
      qz: rotation.z,
      qw: rotation.w,
    };
    // The mesh goes where the stone ACTUALLY is first, so the entrance slide
    // below is the short travel from the hit point to the seat rather than a
    // flight from the origin. `show` is idempotent, so `seat` finds this one.
    if (looseMeshes && item.kind) {
      looseMeshes.show(item.key, item.kind, item.variant, item.scale);
      looseMeshes.move(item.key, t.x, t.y, t.z, r);
    }
    if (!seat(carrier, record, { slide: true })) return;
    observer?.stick(record);
  }

  /** Stick creature B to creature A. Same seam, same event. */
  function stickCreature(carrier: Slot, rider: Slot, root: Group): void {
    const clump = carrier.clump;
    if (!clump || !rider.characterRoot) return;
    clump.group.getWorldPosition(scratchVec);
    const at = rider.characterRoot.position;
    const offset = clumpLocalOffset({
      itemX: at.x,
      itemY: at.y + rider.bodyR,
      itemZ: at.z,
      centreX: scratchVec.x,
      centreY: scratchVec.y,
      centreZ: scratchVec.z,
      headingX: Math.sin(root.rotation.y),
      headingZ: Math.cos(root.rotation.y),
      R: clump.R(),
      itemR: rider.bodyR,
      clumpWorldQ: clump.worldQ,
      growth: clump.growth(),
    });
    rider.characterRoot.getWorldQuaternion(scratchQ);
    const rotation = clumpLocalRotation(scratchQ, clump.worldQ);
    const record: StickRecord = {
      id: carrier.id,
      item: `creature:${rider.id}`,
      ox: offset.x,
      oy: offset.y,
      oz: offset.z,
      qx: rotation.x,
      qy: rotation.y,
      qz: rotation.z,
      qw: rotation.w,
    };
    if (!seat(carrier, record)) return;
    observer?.stick(record);
  }

  /** Shed the outermost thing on a carrier's pile, and tell the room. */
  function dropOutermost(carrier: Slot, nowMs: number): void {
    const clump = carrier.clump;
    if (!clump) return;
    if (carrier.lastDropMs !== null && nowMs - carrier.lastDropMs < DROP_MIN_GAP_MS) return;
    const stuck = clump.outermost();
    if (!stuck) return;
    stuck.object.getWorldPosition(scratchVec);
    stuck.object.getWorldQuaternion(scratchQ);
    const x = scratchVec.x;
    const z = scratchVec.z;
    const q = { x: scratchQ.x, y: scratchQ.y, z: scratchQ.z, w: scratchQ.w };
    if (!unseat(carrier, stuck.key, x, z, q)) return;
    carrier.lastDropMs = nowMs;
    observer?.drop({
      id: carrier.id,
      item: stuck.key,
      x,
      z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
    });
  }

  /** Set every passenger down free, and record a drop for each. What a
   * carrier leaving the world owes the people whose creatures were on it. */
  function releaseAll(carrier: Slot): void {
    const clump = carrier.clump;
    if (!clump) return;
    for (const stuck of [...clump.items.values()]) {
      stuck.object.getWorldPosition(scratchVec);
      stuck.object.getWorldQuaternion(scratchQ);
      const x = scratchVec.x;
      const z = scratchVec.z;
      const q = { x: scratchQ.x, y: scratchQ.y, z: scratchQ.z, w: scratchQ.w };
      if (!unseat(carrier, stuck.key, x, z, q)) continue;
      observer?.drop({
        id: carrier.id,
        item: stuck.key,
        x,
        z,
        qx: q.x,
        qy: q.y,
        qz: q.z,
        qw: q.w,
      });
    }
  }

  /** `bodies.onSettle` → the room, once. Wired on the first host frame,
   * because the bodies do not exist before then. */
  let settleWired = false;
  function ensureSettle(): void {
    if (settleWired) return;
    const bodies = bodiesOf();
    if (!bodies) return;
    settleWired = true;
    bodies.onSettle((item) => {
      const t = item.body.translation();
      const r = item.body.rotation();
      if (item.meshDrawn) looseMeshes?.move(item.key, t.x, t.y, t.z, r);
      observer?.settle({
        item: item.key,
        x: t.x,
        z: t.z,
        qx: r.x,
        qy: r.y,
        qz: r.z,
        qw: r.w,
      });
    });
  }

  /**
   * What holds an item on. A prop's own `attachmentStrength`; a creature
   * passenger holds on like a medium prop does — [D], and it has to be
   * *something*: a creature has no `PropKind` and so no row of its own.
   */
  function attachmentOf(stuck: StuckItem): number {
    return stuck.kind
      ? stickyFor(stuck.kind, stuck.variant ?? 0).attachmentStrength
      : STICKY.tree.attachmentStrength;
  }

  /**
   * Each alive body's speed as it ENTERED this frame's resolve, by the same
   * index `onContact` reports. Reused; see the note where it is filled.
   */
  const preSpeed: number[] = [];

  /** One contact this frame, kept for the sticky pass. Reused. */
  interface ContactReport {
    slot: Slot;
    collider: Collider;
    nx: number;
    nz: number;
    speed: number;
  }
  const contacts: ContactReport[] = [];

  /**
   * ONE ROOTED PROP, HIT — the whole rule, in one place (host only).
   *
   * Two callers reach it and that is the point. The pure resolve's own hard
   * contacts are a creature walking into a trunk; the impact seam
   * (src/world/rocks.ts `onImpact`) is everything else the brief asks for —
   * *"a stuck bench swinging into a sign knocks it loose"*, a rolling stone
   * hitting a tree, a falling chunk landing on a bush. Two entry points, one
   * verdict, or the world would answer the same question differently
   * depending on which collider reported it.
   *
   * `carrierR` is what the impact was measured against: a creature's body
   * radius when a creature hit it, and the ITEM's own radius when a loose
   * thing did — the currency is `speed x radius` either way
   * (src/creatures/sticky.ts `impactOf`).
   *
   * `dirX`/`dirZ` is the direction the prop leans, which is away from
   * whatever hit it.
   */
  function hitRooted(
    bodies: PropBodies,
    prop: { key: string; kind: PropKind; r: number; x: number; z: number },
    impact: number,
    carrierR: number,
    dirX: number,
    dirZ: number,
  ): void {
    // The VARIANT's rules, not merely the kind's: on a katamari world one
    // library model of a kind is planted and the next is not
    // (`stickyFor`, src/creatures/sticky.ts). The variant comes out of the
    // placement key, which is the only description of this prop that
    // survives the scatter forgetting about it.
    const props = stickyFor(prop.kind, parseItemKey(prop.key)?.variant ?? 0);
    if (!props) return;
    // ALWAYS the recoil, whatever the verdict: running into a tree bends it
    // even when it holds, and that flinch is the read that the world is
    // being pushed around. `/6` puts a walking creature at a gentle lean and
    // a loaded pile at the `BEND_MAX` cap. **[D]**
    bodies.bump(prop.key, dirX, dirZ, Math.min(1, impact / 6));
    const outcome = decideContact({
      itemR: prop.r,
      rooted: true,
      props,
      impact,
      carrierR,
    });
    if (outcome === 'break') {
      shatterProp(prop.key, prop.kind, impact);
      return;
    }
    if (outcome === 'loose') {
      const item = bodies.loosen(prop.key);
      if (item) {
        showLoose(prop.key, item.x, item.z, item.scale);
        observer?.loose(prop.key, item.x, item.z);
      }
      return;
    }
    // It held. A STAGED kind wears down anyway — that is the difference
    // between a building and a monolith, and the reason `breakStrength`
    // stays `Infinity` for one of them.
    if (props.stages) accumulate(prop.key, impact);
  }

  /**
   * Add to a staged prop's damage and, if that crossed a threshold, say so.
   *
   * The accumulation is the brief's *"repeated impact"*; the event is the
   * only part of it that leaves this page.
   */
  function accumulate(key: string, impact: number): void {
    if (!(impact > 0)) return;
    const parsed = parseItemKey(key);
    if (!parsed) return;
    const props = stickyFor(parsed.kind, parsed.variant);
    if (!props?.stages) return;
    const total = (damage.get(key) ?? 0) + impact;
    damage.set(key, total);
    const stage = stageFor(props, total);
    const current = wrecks.get(key)?.stage ?? 0;
    if (stage <= current) return;
    applyCrackLocal(key, stage);
    observer?.crack({ item: key, stage });
  }

  /** A large prop past its `shatterStrength`: it comes apart, and the room
   * is told what it was and where it stood. */
  function shatterProp(key: string, kind: PropKind, impact: number): void {
    if (wrecks.has(key)) return;
    const parsed = parseItemKey(key);
    // Measured BEFORE it is hidden: `applyShatterLocal` drops the
    // placement's collider and stops the scatter drawing it, and the row is
    // the only thing that knows what scale and yaw it stood at.
    const measured = placementDrawn(key, kind);
    if (!parsed) return;
    const record: ShatterRecord = {
      item: key,
      x: parsed.x,
      z: parsed.z,
      rotY: measured?.rotY ?? 0,
      scale: measured?.scale ?? 1,
      kind,
      variant: parsed.variant,
    };
    applyShatterLocal(record, impact);
    observer?.shatter(record);
  }

  /**
   * The impact seam, wired once on the first simulating frame
   * (src/world/rocks.ts `onImpact`).
   *
   * THREE ROUTES, and each of them is a line in the brief:
   *
   *   a creature's own collider — its ball, or one of the balls standing in
   *   for what it is CARRYING — meeting a rooted prop. That is the stuck
   *   bench knocking a sign loose, and it is the gap the katamari work left:
   *   drops and looses fired off the pure resolve's hard contacts, which a
   *   bench hanging off a pile never produces.
   *
   *   a loose item or a chunk meeting a rooted prop, measured against the
   *   ITEM's radius. That is the chain reaction — a stone shoved into a
   *   tree, a falling section landing on a bush.
   *
   *   a loose item meeting a carrier. A pile sheds from being HIT, not only
   *   from hitting, which is the other half of *"attached objects stay
   *   dangerous"*.
   */
  let impactWired = false;
  function ensureImpact(): void {
    if (impactWired) return;
    const bodies = bodiesOf();
    if (!bodies) return;
    impactWired = true;
    bodies.onImpact((a, b, speed) => {
      // A page that lost the election a moment ago still holds its bodies
      // (see `simulating`), and a page that is not deciding must not decide.
      if (!manager.simulating()) return;
      const live = bodiesOf();
      if (!live || !(speed > 0)) return;
      routeImpact(live, a, b, speed);
    });
  }

  function routeImpact(
    bodies: PropBodies,
    a: ImpactSide,
    b: ImpactSide,
    speed: number,
  ): void {
    const creature = a.kind === 'creature' ? a : b.kind === 'creature' ? b : null;
    if (creature) {
      const other = creature === a ? b : a;
      const slot = slots.get(creature.key);
      if (!slot || slot.phase !== 'alive') return;
      if (other.rooted) {
        const impact = impactOf(speed, slot.bodyR);
        // Away from the creature: the prop leans off the thing that hit it.
        hitRooted(
          bodies,
          { key: other.key, kind: other.kind as PropKind, r: other.r, x: other.x, z: other.z },
          impact,
          slot.bodyR,
          other.x - creature.x,
          other.z - creature.z,
        );
        return;
      }
      // Hit BY a loose thing: measured against the thing that arrived, not
      // against the pile it landed on.
      const stuck = slot.clump?.outermost();
      if (!stuck) return;
      const impact = impactOf(speed, other.r);
      if (shouldDrop({ ...STICKY.tree, attachmentStrength: attachmentOf(stuck) }, impact)) {
        dropOutermost(slot, lastNowMs);
      }
      return;
    }
    // Neither side is a creature. Exactly one rooted side is a thing hitting
    // a standing prop; two loose ones are just two stones, which rapier has
    // already dealt with.
    if (a.rooted === b.rooted) return;
    const rooted = a.rooted ? a : b;
    const item = a.rooted ? b : a;
    hitRooted(
      bodies,
      { key: rooted.key, kind: rooted.kind as PropKind, r: rooted.r, x: rooted.x, z: rooted.z },
      impactOf(speed, item.r),
      item.r,
      rooted.x - item.x,
      rooted.z - item.z,
    );
  }

  /**
   * THE HOST'S FRAME (docs/PLAN.md §7.6) — after `stepCreatures`, before the
   * ground pass.
   *
   * Four decisions, in this order, and the order is the game: what the
   * creature ran INTO is settled first (a tree either comes out of the ground
   * or stops you), then what it can pick up, then whether it picked up another
   * creature, then whether the impact knocked something off. Deciding pickups
   * before impacts would let a creature eat the tree that just stopped it.
   */
  function simulateSticky(nowMs: number): void {
    const bodies = bodiesOf();
    if (!bodies) return;
    ensureHooks();
    ensureSettle();
    ensureImpact();

    // ── 4. what we ran into ────────────────────────────────────────────────
    for (const report of contacts) {
      const key = report.collider.key;
      const kind = report.collider.kind as PropKind | undefined;
      if (!key || !kind || !Object.prototype.hasOwnProperty.call(STICKY, kind)) continue;
      const props = stickyFor(kind, parseItemKey(key)?.variant ?? 0);
      const impact = impactOf(report.speed, report.slot.bodyR);
      // The verdict, the recoil and the staged damage are `hitRooted`'s —
      // one rule, whether the contact came from the pure resolve (here) or
      // from rapier's own events (the impact seam above).
      if (props.rooted) {
        hitRooted(
          bodies,
          { key, kind, r: report.collider.r, x: report.collider.x, z: report.collider.z },
          impact,
          report.slot.bodyR,
          -report.nx,
          -report.nz,
        );
      }
      // ── 6. and whether it knocked something off ──────────────────────────
      const stuck = report.slot.clump?.outermost();
      if (stuck && shouldDrop({ ...props, attachmentStrength: attachmentOf(stuck) }, impact)) {
        dropOutermost(report.slot, nowMs);
      }
    }
    contacts.length = 0;

    // ── 3. pickups ─────────────────────────────────────────────────────────
    itemList.length = 0;
    itemPoints.length = 0;
    for (const item of bodies.items()) {
      const t = item.body.translation();
      // The host draws its loose props through the same layer a viewer does,
      // so the two cannot disagree about where a fallen tree is lying.
      if (item.meshDrawn) looseMeshes?.move(item.key, t.x, t.y, t.z, item.body.rotation());
      itemList.push(item);
      itemPoints.push({ x: t.x, z: t.z });
    }
    itemGrid.rebuild(itemPoints);

    for (const entry of aliveScratch) {
      const { slot, root } = entry;
      if (slot.carriedBy) continue;
      /*
       * THE ROLLING BALL'S OWN RADIUS, growth and all: `growPass` writes
       * `bodyR = baseR × clump.growth()` every frame and `clump.R()` is that
       * same product, so the circle that picks things up is exactly the
       * circle that is turning on the ground. A reach measured off `baseR`
       * would leave a grown pile brushing past stones it visibly rolled over.
       */
      const reach = slot.bodyR;
      const nearIdx = itemGrid.near(root.position.x, root.position.z, reach + itemGrid.cellSize);
      for (let k = 0; k < nearIdx.length; k++) {
        const item = itemList[nearIdx[k]!];
        if (!item) continue;
        const props = stickyFor(item.kind, item.variant);
        const point = itemPoints[nearIdx[k]!]!;
        const d = Math.hypot(point.x - root.position.x, point.z - root.position.z);
        // `CONTACT_PAD`, because nothing in this world is ever exactly
        // touching: every solver here holds a skin.
        if (d > reach + item.r + CONTACT_PAD) continue;
        // Units: world units per second, raw off the body — see the note on
        // `preSpeed` in the resolve block.
        const speed = Math.hypot(entry.body.vx, entry.body.vz);
        const outcome = decideContact({
          itemR: item.r,
          rooted: false,
          props,
          impact: impactOf(speed, slot.bodyR),
          carrierR: slot.bodyR,
        });
        if (outcome !== 'stick') continue;
        // `take` first: it drops the body and hides the placement, so the
        // mesh the clump then holds is the only copy of the thing.
        if (!bodies.take(item.key)) continue;
        stickItem(slot, item, root);
      }
    }

    // ── 5. creature onto creature ──────────────────────────────────────────
    /*
     * `aliveScratch` is sorted by slot id (the resolve pass needs it to be),
     * so a fixed i < j walk is deterministic: the same two creatures meeting
     * on two different pages reach the same verdict about which one is
     * carrying which. Symmetric in the sense that matters — whichever is
     * BIGGER does the carrying, whichever order they are visited in.
     */
    for (let i = 0; i < aliveScratch.length; i++) {
      const a = aliveScratch[i]!;
      for (let j = i + 1; j < aliveScratch.length; j++) {
        const b = aliveScratch[j]!;
        if (a.slot.carriedBy || b.slot.carriedBy) continue;
        // A creature already carrying the other's carrier is not a case: a
        // pile cannot be inside itself.
        if (a.slot.passengers.has(b.slot.id) || b.slot.passengers.has(a.slot.id)) continue;
        const dx = a.root.position.x - b.root.position.x;
        const dz = a.root.position.z - b.root.position.z;
        if (Math.hypot(dx, dz) > a.slot.bodyR + b.slot.bodyR + CONTACT_PAD) continue;
        const aTakesB = b.slot.bodyR <= carryLimit(a.slot.bodyR);
        const bTakesA = a.slot.bodyR <= carryLimit(b.slot.bodyR);
        if (aTakesB && bTakesA) {
          /*
           * BOTH ELIGIBLE, which since `PICKUP_RATIO` became 1 means their
           * radii are equal — each is exactly at the other's limit.
           *
           * Somebody has to carry, and it cannot be "whichever was visited
           * first": `aliveScratch` is sorted by id, so the earlier slot would
           * always win, and a page that had retired one of them would sort
           * the pair differently and build the other pile. The BIGGER ID
           * carries. It is arbitrary, and that is the point — it is a
           * property of the two creatures and of nothing else, so every page
           * reaches it.
           */
          const [carrier, rider] = a.slot.id > b.slot.id ? [a, b] : [b, a];
          stickCreature(carrier.slot, rider.slot, carrier.root);
        } else if (aTakesB) stickCreature(a.slot, b.slot, a.root);
        else if (bTakesA) stickCreature(b.slot, a.slot, b.root);
      }
    }

    // The carrier's stand-in and its stuck colliders, once everything is
    // where it is going to be this frame.
    for (const entry of aliveScratch) {
      if (entry.slot.carriedBy) continue;
      syncKinematic(entry.slot, entry.root);
      syncStuckColliders(entry.slot);
    }
  }

  /**
   * THE PILE'S PRESENTATION — on every page, host or viewer.
   *
   * The growth is applied to the ROOT's uniform scale, which is why the
   * clump had to hang there: one write grows the creature and everything
   * stuck to it together. `bodyR` follows, and with it the resolve radius,
   * the pickup reach and `positions()` — which is where the scatter's
   * exclusion radius comes from, so a big enough creature clears props out
   * of its own way.
   *
   * SPEED IS DELIBERATELY UNCHANGED. This is a katamari: bigger is not
   * slower. A creature that bogged down as it grew would make the last
   * twenty seconds calmer than the first ten, which is the opposite of what
   * the brief asks for.
   */
  function growPass(dt: number): void {
    for (const slot of slots.values()) {
      const clump = slot.clump;
      const root = slot.characterRoot;
      if (!clump || !root || slot.phase !== 'alive') continue;
      clump.update(dt);
      const g = clump.growth();
      root.scale.setScalar(g);
      slot.bodyR = slot.baseR * g;
      if (slot.character) slot.characterShadow?.setRadius?.(slot.character.radius * g);
    }
  }

  const manager: CreatureManager = {
    spawn(id, strokes, opts): boolean {
      // The slot id is the creature's identity: it salts the within-band
      // synthesis so the same drawing submitted twice hatches two visibly
      // distinct individuals, and it matches the phone portrait (same id).
      const next = createCharacter(strokes, 1, { identity: id, markingSize: WORLD_MARKING_SIZE });
      if (!next) return false;

      const existing = slots.get(id);
      if (existing) {
        // One drawer, one slot: their new drawing replaces the old creature.
        observer?.retire(id, 'replaced');
        disposeSlot(existing);
      }

      /*
       * Population guard: retire the oldest live slot beyond the cap —
       * PREFERRING A SUBMISSION over a resident.
       *
       * "Oldest" and "resident" used to be the same set. The world's own
       * cast loads before anybody arrives, so it holds every one of the
       * lowest arrival numbers, and an unqualified oldest-first rule
       * retired them in order the moment a busy world reached the cap: the
       * field a person came to look at emptied out one creature per
       * arrival, and the only thing left was whoever had just walked in.
       *
       * Two passes, not a sort — this runs on the spawn path with a full
       * pipeline behind it, and the cap is MAX_POPULATION.
       *
       * Residents are the fallback, not an exemption. If a world is
       * somehow ALL residents the oldest of them still goes: the cap is a
       * frame-rate guarantee, and a guarantee with a carve-out is a leak.
       */
      if (slots.size >= MAX_POPULATION) {
        const going = chooseEviction(slots.values());
        if (going) beginRetire(going, performance.now());
      }

      // Its own spot on the map, from its id (see `spawnSpot`), then
      // projected clear of props and residents — an egg never incubates
      // half-inside a rock.
      const spot = clearSpawnSpot(spawnSpot(id));
      /*
       * A creature that is ALREADY HERE never had an egg here.
       *
       * This used to build one for it anyway and throw it away on the next
       * line — and an egg is not cheap: `createEgg` paints a CanvasTexture
       * from the stroke list, builds the ellipsoid, and takes a shadow
       * stamp. Thirty of those on the load path, painted and disposed
       * microseconds later, for a shell nobody ever saw.
       *
       * Nothing else has to change: the slot already carries `egg` and
       * `eggShadow` as nullable, because becoming alive clears them both.
       */
      const grown = opts.grown === true;
      // The egg does not know about terrain (src/egg/egg.ts): the ground
      // under its spot is sampled here and handed in beside x and z.
      const egg = grown
        ? null
        : createEgg(strokes, {
            x: spot.x,
            z: spot.z,
            baseY: surface.sampleHeight(spot.x, spot.z),
          });
      const nowMs = performance.now();
      const slot: Slot = {
        id,
        // Unsigned drawings still get a name (user ruling, 2026-08-18) —
        // derived from the identity id, so it is the same on every device
        // and reproduces exactly on replay (src/creatures/naming.ts).
        name: resolveName(opts.name, id),
        forcedHatchAtMs: null,
        phase: 'egg',
        spot,
        egg,
        eggShadow: egg ? world.shadows.addShadow(`egg-${id}`, egg.radius * EGG_SHADOW_FIT) : null,
        bornMs: nowMs,
        hatchAtMs: nowMs + opts.hatchMs,
        pending: next,
        hatch: null,
        character: null,
        characterRoot: null,
        characterShadow: null,
        bodyR: 0,
        baseR: 0,
        clump: null,
        carriedBy: null,
        passengers: new Set<string>(),
        lastDropMs: null,
        kinematic: null,
        personalityChoice: opts.personality ?? null,
        follow: null,
        agent: null,
        pose: null,
        manualHold: false,
        retireStartMs: 0,
        order: orderCounter++,
        resident: opts.resident === true,
        drive: null,
        drivenAtMs: null,
        offscreenFrames: 0,
        pendingDt: 0,
        present: true,
      };
      slots.set(id, slot);

      // Already here, so: no egg mesh, no shell animation, no `hatch` in the
      // log, and the camera does not swing to it. Nothing arrived.
      if (grown) {
        if (!placeGrown(slot)) {
          slots.delete(id);
          return false;
        }
        return true;
      }

      if (!egg) return false; // unreachable: only a grown spawn has no egg
      slot.eggShadow?.setPosition(spot.x, spot.z);
      // Named so the ghost-panel outliner lists eggs, not only hatched
      // creatures (user ask, 2026-08-21: *"i want to retain them to see if
      // ref load the character meshes"*). The outliner registers named
      // meshes and groups; an unnamed egg group meant a world full of eggs
      // read as an empty scene there, which is exactly backwards for using
      // the list to check that geometry actually built. Lowercase, and the
      // same name the creature will carry when it hatches, so one drawer
      // reads as one thing across both phases.
      egg.group.name = `egg ${slot.name}`;
      world.scene.add(egg.group);
      // No reframe on arrival — see `onBurst` above for why. An egg lands
      // where its id puts it, and the camera is somebody else's to move.
      observer?.egg(id, spot.x, spot.z);
      return true;
    },

    hatch(id): void {
      if (id === undefined) {
        this.hatchAll();
        return;
      }
      const slot = slots.get(id);
      if (slot && slot.phase === 'egg') beginHatch(slot, 'forced');
    },

    hatchAll(): void {
      // Queued, not fired: each egg gets its own moment, HATCH_STAGGER_MS
      // apart in spawn order. The update loop opens them as their turn
      // arrives, so this stays frame-driven — no timers to leak, and the
      // session recorder sees the same `forced` hatches it always did.
      const nowMs = performance.now();
      let index = 0;
      for (const slot of slots.values()) {
        if (slot.phase !== 'egg' || slot.forcedHatchAtMs !== null) continue;
        slot.forcedHatchAtMs = nowMs + index * HATCH_STAGGER_MS;
        index++;
      }
    },

    emote(id, emote, source = 'phone'): boolean {
      const slot = slots.get(id);
      if (!slot || slot.phase !== 'alive' || !slot.character) return false;
      slot.character.emote(emote);
      observer?.emote(id, emote, source);
      return true;
    },

    hoverTargets() {
      const out: { name: string; object: Group }[] = [];
      for (const slot of slots.values()) {
        if (slot.phase === 'alive' && slot.name && slot.characterRoot) {
          out.push({ name: slot.name, object: slot.characterRoot });
        }
      }
      return out;
    },

    latestCharacter(): Character | null {
      let best: Slot | null = null;
      for (const slot of slots.values()) {
        if (slot.character && slot.phase === 'alive') {
          if (!best || slot.order > best.order) best = slot;
        }
      }
      return best?.character ?? null;
    },

    latestId(): string | null {
      let best: Slot | null = null;
      for (const slot of slots.values()) {
        if (slot.character && slot.phase === 'alive') {
          if (!best || slot.order > best.order) best = slot;
        }
      }
      return best?.id ?? null;
    },

    positions() {
      const out: { x: number; z: number; r: number; kind: 'egg' | 'character' }[] = [];
      for (const slot of slots.values()) {
        const p = worldPositionOf(slot);
        if (p) {
          out.push({
            x: p.x,
            z: p.z,
            // The GROWN radius when there is a pile: this is what the scatter
            // reads for its exclusion radius, so a creature that has eaten
            // half a forest clears the rest of it out of its own way.
            r: slot.bodyR > 0 ? slot.bodyR : (slot.character?.radius ?? slot.egg?.radius ?? 1),
            kind: slot.characterRoot ? 'character' : 'egg',
          });
        }
      }
      return out;
    },

    positionOf(id) {
      const slot = slots.get(id);
      return slot ? worldPositionOf(slot) : null;
    },

    count: () => slots.size,

    update(dt, nowMs): void {
      lastNowMs = nowMs;
      // Environmental affordances, sampled once per frame for every agent.
      const props = readProps(world);

      // World-units-per-screen-pixel for the bubbles' legibility floor (QA
      // audit D4): ortho frustum height / viewport height / zoom. Feature-
      // detected so headless tests (stub worlds, no window) skip the feed.
      let worldUnitsPerPx = 0;
      const camera = world.cameraRig?.camera;
      if (
        camera &&
        typeof window !== 'undefined' &&
        typeof camera.top === 'number' &&
        typeof camera.bottom === 'number' &&
        typeof camera.zoom === 'number'
      ) {
        worldUnitsPerPx =
          (camera.top - camera.bottom) /
          (Math.max(1, window.innerHeight) * Math.max(0.01, camera.zoom));
      }

      // Prop colliders: re-index only when the scatter's version moves.
      const scatterPhysics = readScatterPhysics(world);
      ensureColliderGrid();

      // Eggs are static hard colliders — creatures walk around them. Pool
      // objects are reused frame to frame (no churn).
      eggColliderCount = 0;
      for (const s of slots.values()) {
        if (!s.egg || s.phase === 'retiring') continue;
        let c = eggColliderPool[eggColliderCount];
        if (!c) {
          c = { x: 0, z: 0, r: 0, hard: true };
          eggColliderPool[eggColliderCount] = c;
        }
        c.x = s.egg.group.position.x;
        c.z = s.egg.group.position.z;
        c.r = s.egg.radius;
        eggColliderCount++;
      }
      aliveScratch.length = 0;

      // The camera's frustum, when there is a real camera to read one off
      // (a stub world in a test has none — then everything is on screen
      // and the stride never engages). Last frame's view matrix is fine:
      // the camera drifts, it never cuts.
      let culling = false;
      if (
        camera &&
        camera.projectionMatrix &&
        camera.matrixWorldInverse &&
        Array.isArray(camera.projectionMatrix.elements)
      ) {
        frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(frustumMatrix);
        culling = true;
      }

      // Index every alive root once, so each agent's peer query is a walk
      // over the few cells around it rather than the whole cast.
      peerSlots.length = 0;
      for (const s of slots.values()) {
        if (s.phase !== 'alive' || !s.characterRoot) continue;
        const i = peerSlots.length;
        let pt = peerPoints[i];
        if (!pt) {
          pt = { x: 0, z: 0 };
          peerPoints[i] = pt;
        }
        pt.x = s.characterRoot.position.x;
        pt.z = s.characterRoot.position.z;
        peerSlots.push(s);
      }
      peerPoints.length = peerSlots.length;
      peerGrid.rebuild(peerPoints);

      for (const slot of [...slots.values()]) {
        /*
         * Is this one being LOOKED AT this frame? On screen: refreshed
         * every frame, as ever. Off screen: one frame in OFFSCREEN_STRIDE,
         * and the skipped dt rides along (see the constant). Retiring and
         * hatching creatures are exempt — their animations are timed
         * against the clock and the tour is on its way to a hatch anyway.
         */
        slot.pendingDt += dt;
        let present = true;
        if (culling && !slot.hatch && slot.phase !== 'retiring') {
          const root: Object3D | null = slot.characterRoot ?? slot.egg?.group ?? null;
          if (root) {
            const reach = slot.character ? slot.character.radius * 3 + 1 : EGG_RADIUS * 3 + 1;
            boundsSphere.center.copy(root.position);
            boundsSphere.radius = reach;
            if (frustum.intersectsSphere(boundsSphere)) {
              slot.offscreenFrames = 0;
            } else {
              present = slot.offscreenFrames % OFFSCREEN_STRIDE === 0;
              slot.offscreenFrames++;
            }
          }
        }
        slot.present = present;
        const presentDt = Math.min(slot.pendingDt, OFFSCREEN_DT_CAP);
        if (present) slot.pendingDt = 0;

        if (slot.egg) {
          if (present) {
            slot.egg.update(presentDt, nowMs);
            slot.eggShadow?.setPosition(slot.egg.group.position.x, slot.egg.group.position.z);
          }
          if (!slot.hatch && slot.phase === 'egg' && !timersPaused) {
            const total = slot.hatchAtMs - slot.bornMs;
            const p = total <= 0 ? 1 : Math.min(1, (nowMs - slot.bornMs) / total);
            slot.egg.setHatchProgress(p);
            slot.egg.crack(CRACK_TEASER * smoothstep(0.62, 1, p));
            // A queued hatchAll() opens this one when its turn comes.
            if (slot.forcedHatchAtMs !== null && nowMs >= slot.forcedHatchAtMs) {
              slot.forcedHatchAtMs = null;
              beginHatch(slot, 'forced');
            } else if (autoHatch && p >= 1) {
              beginHatch(slot, 'timer');
            }
          }
        }

        slot.hatch?.update(dt, nowMs);

        if (slot.character) {
          if (present) {
            if (worldUnitsPerPx > 0) slot.character.setWorldUnitsPerPixel?.(worldUnitsPerPx);
            slot.character.update(presentDt, nowMs);
          }

          // Autonomous behavior: the agent owns the root's x/z and heading.
          // Never world-space Y — locomotion stays on the Surface seam.
          const root = slot.characterRoot;
          if (root && slot.phase === 'alive' && slot.carriedBy) {
            /*
             * BEING CARRIED. Out of the physics pass entirely — its position
             * is the pile's, and a second solver underneath would fight the
             * clump for the same three floats, which is exactly the mistake
             * the two-level rig exists to prevent. The agent is stood down
             * the same way a driven one is; the gait sees speed 0 and drifts
             * out to the ambient floor rather than freezing.
             */
            slot.character.setLocomotion(0, root.rotation.y);
          } else if (root && slot.phase === 'alive' && slot.manualHold) {
            // Gizmo-held (dev panel): the dragged root position is the
            // truth. The body still enters the physics pass, motionless, so
            // neighbors part around it — but nothing writes it back. The
            // gait sees speed 0 and settles to the ambient floor.
            let body = bodyPool[aliveScratch.length];
            if (!body) {
              body = { x: 0, z: 0, vx: 0, vz: 0, r: 0 };
              bodyPool[aliveScratch.length] = body;
            }
            body.x = root.position.x;
            body.z = root.position.z;
            body.vx = 0;
            body.vz = 0;
            body.r = slot.bodyR > 0 ? slot.bodyR : slot.character.radius;
            aliveScratch.push({
              slot,
              root,
              body,
              heading: root.rotation.y,
              held: true,
            });
            slot.character.setLocomotion(0, root.rotation.y);
          } else if (root && slot.phase === 'alive' && aiPaused && slot.follow) {
            /*
             * A VIEWER of somebody else's world (src/net/worldsync.ts).
             *
             * The host simulates; this creature's only job is to be where
             * the host says it is. It EASES there rather than being placed:
             * frames arrive five times a second, and setting the position
             * on each one is a step — visible, and the hard cut the motion
             * law forbids at confidence 1.00.
             *
             * Exponential convergence, so it is monotone and cannot
             * overshoot however late or bunched the frames are. It also
             * never quite arrives, which is the ambient drift floor that
             * has to run under everything anyway.
             */
            /*
             * THE FIRST FRAME IS A PLACEMENT, NOT A JOURNEY.
             *
             * A viewer builds the cast locally and stands each creature on
             * its deterministic spawn spot, because that is all it knows.
             * The host has been simulating for minutes and has them spread
             * across the field. Easing into the first pose therefore flew
             * the ENTIRE population from the spawn spiral to wherever they
             * really were, all at once, every time somebody opened the link
             * (user report, 2026-08-27: *"characters fly across the map"*).
             *
             * That flight was never motion — nothing moved, we just did not
             * know yet. So the first frame writes the position, and the
             * motion law is not in play: the rule forbids cutting between
             * two states of a thing, and this is the creature's first
             * truthful frame. Every frame after it eases, which is where
             * the rule does apply and does hold.
             *
             * Same on a role change: `clearFollow` drops `settled` so a
             * page that has just stopped hosting re-places rather than
             * flying its cast to the new host's answer.
             */
            const k = slot.follow.settled ? followFraction(dt, FOLLOW_TAU_MS) : 1;
            slot.follow.settled = true;
            const beforeX = root.position.x;
            const beforeZ = root.position.z;
            root.position.x += (slot.follow.x - beforeX) * k;
            root.position.z += (slot.follow.z - beforeZ) * k;
            root.rotation.y += shortestAngle(root.rotation.y, slot.follow.heading) * k;

            /*
             * AND THE BALL ROLLS HERE TOO, off the eased displacement.
             *
             * A roll phase is NOT on the wire (src/net/worldsync.ts: poses
             * carry x/z/heading and nothing else). It does not need to be —
             * roll is arc length over radius, so a page that knows how far
             * the creature moved knows how far it turned, and every page
             * derives the same answer from the same travel. Off the EASED
             * displacement rather than the host's, for the same reason the
             * gait reads it: what the viewer sees moving is what should be
             * seen turning.
             */
            slot.clump?.roll(root.position.x - beforeX, root.position.z - beforeZ);

            // The gait reads the speed it is ACTUALLY travelling at, so a
            // followed creature walks for the same reason a simulated one
            // does — because it is moving — rather than being told to.
            const moved = Math.hypot(root.position.x - beforeX, root.position.z - beforeZ);
            slot.character.setLocomotion(
              locoSpeed(dt > 0 ? (moved / dt) * 1000 : 0),
              root.rotation.y,
            );
            if (present) {
              slot.characterShadow?.setPosition(
                root.position.x + slot.character.group.position.x,
                root.position.z + slot.character.group.position.z,
              );
            }
            // Deliberately NOT entered into the physics pass: the host has
            // already resolved every overlap, and a second solver running
            // on top of the answer would fight it.
          } else if (root && slot.agent && slot.phase === 'alive' && !aiPaused) {
            // Company within PEER_RADIUS, in roster order (the grid
            // answers ascending, and it was filled in slot order).
            const peers = peersScratch;
            peers.length = 0;
            const nearIdx = peerGrid.near(root.position.x, root.position.z, PEER_RADIUS);
            for (let k = 0; k < nearIdx.length; k++) {
              const other = peerSlots[nearIdx[k]!]!;
              if (other === slot) continue;
              const pt = peerPoints[nearIdx[k]!]!;
              peers.push({ x: pt.x, z: pt.z, id: other.id });
            }
            /*
             * A PERSON IS STEERING THIS ONE (src/world/joystick.ts).
             *
             * Their intent replaces the agent's chosen velocity and nothing
             * else: soft bodies still slow it through a bush, the
             * substepped resolve still stops it at a trunk, the gait still
             * reads the speed it is actually travelling at. A driven
             * creature moves like itself, not like a cursor — which is why
             * this is a velocity substitution and not a position write.
             *
             * And the agent STANDS DOWN while somebody is steering, for
             * DRIVE_IDLE_MS past the last push (user ask, 2026-09-09: *"the
             * automated character walk fights the user control"*). It used
             * to keep running underneath — advancing its state, picking
             * wander targets, turning toward them — so the instant a thumb
             * paused between two pushes the creature set off for somewhere
             * nobody had asked it to go, and the person spent the whole
             * gesture arguing with it.
             *
             * The hold is about INTENT only. Physics is untouched: the body
             * below still enters the substepped resolve, is still pushed
             * out of trunks, and neighbours still part around it. Its
             * timers are paused rather than fast-forwarded and its stale
             * target is dropped, so when the window closes it resumes from
             * where it is actually standing (src/behavior/agent.ts,
             * `AgentHold`).
             */
            const driven = slot.drive && slot.drive.mag > 0 ? slot.drive : null;
            // Stamped from the loop's own clock, never `performance.now()`:
            // the window is compared against the same `nowMs` every other
            // timer here uses.
            if (driven) slot.drivenAtMs = nowMs;
            const held =
              slot.drivenAtMs !== null && nowMs - slot.drivenAtMs < DRIVE_IDLE_MS;
            const driveVx = driven ? driven.x * DRIVE_SPEED * wanderSpeedMult : 0;
            const driveVz = driven ? driven.z * DRIVE_SPEED * wanderSpeedMult : 0;
            // What the hand is asking for, and where the creature is really
            // pointing: the held agent rides both rather than its own idea
            // of them, so the release is a drift-stop from the real speed
            // at the real facing.
            const hold: AgentHold | null = held
              ? { speed: Math.hypot(driveVx, driveVz), heading: root.rotation.y }
              : null;
            const out = slot.agent.update(
              dt,
              nowMs,
              { x: root.position.x, z: root.position.z },
              peers,
              props,
              colliderGrid,
              hold,
            );
            let vx = driven ? driveVx : out.vx;
            let vz = driven ? driveVz : out.vz;
            const bodyR = slot.bodyR > 0 ? slot.bodyR : slot.character.radius;
            const near = gatherNear(root.position.x, root.position.z, bodyR);

            // Soft bodies: pushing through a bush is slow (~55% damped), and
            // the bush reacts — a brief localized sway kicked into the
            // scatter's wind path. That sway is the soft-body read.
            const soft = deepestSoftOverlap(root.position.x, root.position.z, bodyR, near);
            if (soft) {
              /*
               * A SOFT PROP REPORTS A CONTACT TOO, and it has to, because the
               * bush is the only soft kind in the world and it is the one
               * `STICKY` gives the deliberately tiny `breakStrength` of 0.6 —
               * "a walk into it". But `resolveHard` skips soft colliders by
               * construction and `onContact` hangs off it, so a bush could
               * never be knocked out of the ground at all: the rule was
               * written and the code could not reach it.
               *
               * The normal is OUTWARD, the same convention `resolveHard`
               * uses: from the prop toward the creature, so the sticky pass
               * negates it to shove the bush the way it was pushed.
               *
               * The speed reported is the UNDAMPED one, before
               * `SOFT_SPEED_FACTOR` is applied below. What the bush is worth
               * is the effort the creature walked in with — the damping is
               * the bush resisting, and charging it for its own resistance
               * would make a bush harder to flatten the better it worked.
               */
              const intent = Math.hypot(vx, vz);
              if (soft.key !== undefined && bodiesOf() !== null && intent > 0) {
                const dx = root.position.x - soft.x;
                const dz = root.position.z - soft.z;
                const d = Math.hypot(dx, dz);
                const nx = d > 1e-9 ? dx / d : 1;
                const nz = d > 1e-9 ? dz / d : 0;
                contacts.push({ slot, collider: soft, nx, nz, speed: intent });
              }
              vx *= SOFT_SPEED_FACTOR;
              vz *= SOFT_SPEED_FACTOR;
              const speed = Math.hypot(vx, vz);
              if (speed > NUDGE_MIN_SPEED && scatterPhysics?.nudge) {
                scatterPhysics.nudge(
                  root.position.x,
                  root.position.z,
                  Math.min(1, speed / (MAX_SPEED * SOFT_SPEED_FACTOR)),
                );
              }
            }

            // Movement itself is deferred to the substepped resolve phase
            // below — integrating here and resolving later is exactly the
            // gap that let a big clamped dt tunnel through a trunk.
            let body = bodyPool[aliveScratch.length];
            if (!body) {
              body = { x: 0, z: 0, vx: 0, vz: 0, r: 0 };
              bodyPool[aliveScratch.length] = body;
            }
            body.x = root.position.x;
            body.z = root.position.z;
            body.vx = vx;
            body.vz = vz;
            body.r = bodyR;
            /*
             * Turning is EASED even when it is asked for directly.
             *
             * A thumb can reverse the stick between one frame and the next,
             * and writing that heading straight onto the root spins the
             * creature 180° in 16ms — a hard cut in orientation, which the
             * motion law forbids at confidence 1.00 whether a person asked
             * for it or not. So the intent is a target and the creature
             * turns toward it. Exponential, so it is monotone and cannot
             * overshoot however hard the stick is thrown.
             */
            let heading = out.heading;
            if (driven) {
              const want = Math.atan2(vx, vz);
              heading =
                root.rotation.y +
                shortestAngle(root.rotation.y, want) * followFraction(dt, DRIVE_TURN_TAU_MS);
            }

            aliveScratch.push({ slot, root, body, heading });

            root.rotation.y = heading;
            if (out.emote) slot.character.emote(out.emote);
            if (driven && slot.pose === 'sleep') {
              // Being walked wakes you. Leaving a driven creature asleep
              // meant closed eyes on a creature crossing the field, which
              // reads as a bug in the expression rather than a pose.
              slot.character.setExpression('neutral');
              slot.pose = null;
            } else if (!held && out.pose !== slot.pose) {
              // Posture → expression through the character's public surface:
              // sleep closes the eyes; leaving it drifts them back open.
              //
              // Gated on the whole HOLD, not just on a live thumb: the
              // agent's posture is frozen under a hand, and re-applying it
              // the instant the stick rested would shut the eyes of a
              // creature still coasting across the field. It gets its
              // posture back when it gets its life back.
              if (out.pose === 'sleep') slot.character.setExpression('sleepy');
              else if (slot.pose === 'sleep') slot.character.setExpression('neutral');
              slot.pose = out.pose;
            }
          } else {
            // No agent driving (paused ai, retiring): the root holds still,
            // so the gait must see speed 0 and complete its last half-step.
            slot.character.setLocomotion(0, root?.rotation.y ?? 0);
          }

          if (present && slot.characterRoot && slot.characterShadow) {
            slot.characterShadow.setPosition(
              slot.characterRoot.position.x + slot.character.group.position.x,
              slot.characterRoot.position.z + slot.character.group.position.z,
            );
          }
        }

        if (slot.phase === 'retiring') {
          const t = Math.min(1, (nowMs - slot.retireStartMs) / MOTION.primaryMs);
          const root: Object3D | null = slot.characterRoot ?? slot.egg?.group ?? null;
          if (root) {
            const ease = 1 - Math.pow(1 - t, 3); // drift-out, no rebound
            // Under the ground it is standing on, not under y=0 — on a
            // raised tier the old constant sank it into the air.
            root.position.y =
              surface.sampleHeight(root.position.x, root.position.z) - 2.6 * ease;
          }
          if (t >= 1) disposeSlot(slot);
        }
      }

      // ── movement: substepped integrate + hard resolve + hard separation ──
      // One pass over every agent-driven body: positions advance in substeps
      // small enough that nothing can tunnel a collider, every substep pushes
      // bodies out of hard props (padded to the props' visual silhouettes)
      // and separates every creature pair to exact contact — symmetric,
      // iterated, with a tangential slide for head-on meetings. Deterministic
      // iteration order: sorted by slot id, so resolution never flickers
      // frame to frame. All corrections positional — no impulses, no bounce.
      if (aliveScratch.length > 0) {
        aliveScratch.sort((a, b) =>
          a.slot.id < b.slot.id ? -1 : a.slot.id > b.slot.id ? 1 : 0,
        );
        stepBodies.length = 0;
        for (const entry of aliveScratch) stepBodies.push(entry.body);
        /*
         * TWO NEW OPTIONS, and both of them exist because rapier now owns
         * part of this world (src/physics/resolve.ts `HardOptions`).
         *
         * `skipKind: 'rock'` — every scattered stone is a DYNAMIC body once
         * physics is loaded, and the creature's kinematic circle meets it
         * through the solver. Its old footprint circle is still in
         * `scatter.colliders()` (one spatial index for everything, by
         * design), so without this a creature would be pushed out of a stone
         * the solver has already rolled somewhere else.
         *
         * `onContact` — WHICH prop we just ran into, which the sticky pass
         * needs to flinch a tree's recoil spring and to ask whether the tree
         * came out of the ground. Recovering that from positions afterwards
         * would be re-deriving a contact the sweep already had in hand. The
         * strongest per collider survives, because a corner pocket sweeps
         * more than once.
         */
        const physicsOn = bodiesOf() !== null;
        /*
         * HOW FAST IT WAS GOING WHEN IT HIT THE THING — captured BEFORE the
         * step, and that is the whole point.
         *
         * `resolveHard` drops the inward component of the velocity as part of
         * the correction and reports the contact AFTER doing so, so a
         * creature walking straight into a trunk has almost no velocity left
         * by the time the listener is called. Reading `body.vx` there scored
         * every head-on collision — the only kind that matters here — as
         * nearly nothing, so nothing was ever hard enough to knock a prop
         * over. What a contact is worth is the speed the creature carried
         * into it.
         *
         * UNITS: `stepCreatures` integrates `x += vx * subDt / 1000` with
         * `subDt` in MILLISECONDS, so `vx` is world units per SECOND — the
         * same scale as `MAX_SPEED` (1.2), which is how the soft-body nudge
         * below reads it. `impactOf` takes it raw.
         */
        if (physicsOn) {
          preSpeed.length = 0;
          for (const entry of aliveScratch) {
            preSpeed.push(Math.hypot(entry.body.vx, entry.body.vz));
          }
        }
        stepCreatures(stepBodies, dt, gatherNear, {
          hardPadFrac: HARD_PAD_FRAC,
          ...(physicsOn ? { skipKind: 'rock' } : {}),
          ...(physicsOn
            ? {
                onContact: (index, collider, nx, nz): void => {
                  const entry = aliveScratch[index];
                  if (!entry || entry.held) return;
                  const speed = preSpeed[index] ?? 0;
                  for (const seen of contacts) {
                    if (seen.slot !== entry.slot || seen.collider !== collider) continue;
                    if (speed > seen.speed) {
                      seen.speed = speed;
                      seen.nx = nx;
                      seen.nz = nz;
                    }
                    return;
                  }
                  contacts.push({ slot: entry.slot, collider, nx, nz, speed });
                },
              }
            : {}),
        });
        for (const entry of aliveScratch) {
          const { slot, root, body } = entry;
          if (entry.held) {
            // The gizmo owns this root; the resolved body position is
            // discarded (neighbors carried their half of any separation).
            if (slot.present) slot.characterShadow?.setPosition(
              root.position.x + (slot.character?.group.position.x ?? 0),
              root.position.z + (slot.character?.group.position.z ?? 0),
            );
            continue;
          }
          /*
           * THE PILE ROLLS, off the displacement the resolve actually
           * produced — not the velocity the agent asked for. A creature
           * pinned against a trunk has a velocity and no displacement, and a
           * pile that kept turning while its carrier stood still would read
           * as wheels spinning on ice.
           */
          slot.clump?.roll(body.x - root.position.x, body.z - root.position.z);
          root.position.x = body.x;
          root.position.z = body.z;
          const character = slot.character;
          if (!character) continue;
          // The gait reads the RESOLVED ground speed — walk cycles blend in
          // with actual movement and drift out to the ambient floor.
          character.setLocomotion(locoSpeed(Math.hypot(body.vx, body.vz)), entry.heading);
          if (slot.present) {
            slot.characterShadow?.setPosition(
              body.x + character.group.position.x,
              body.z + character.group.position.z,
            );
          }
        }
      }

      /*
       * ── the ground: every living root ends the frame ON the terrain ──
       *
       * Locomotion never touched world-space Y and still doesn't (PLAN
       * §7.2): the agent and the resolve pass wrote x/z, and the height is
       * SAMPLED from it here, once, after every one of them — the follow
       * path, the substepped resolve, the gizmo — has had its say. A few
       * noise lookups per creature per frame.
       *
       * Two roots are deliberately left alone:
       *
       *  - a HATCHING one, whose rise out of the ground is the hatch's y
       *    animation to run (it samples the same Surface, so the height it
       *    rises to is the height taken over here — no step at the
       *    handover);
       *  - a GIZMO-HELD one, where the drag is the truth on all three axes
       *    until it is released and `endManualMove` sets it back down.
       *
       * A retiring root is not here either: its sink is written above,
       * measured from this same sampled ground.
       */
      for (const slot of slots.values()) {
        const root = slot.characterRoot;
        if (!root || slot.phase !== 'alive') continue;
        if (slot.manualHold || slot.hatch) continue;
        // A CARRIED creature is not standing on the ground — it is sitting
        // on a pile, and its root's position is the clump's local offset, not
        // a world one. Sampling the terrain into it would drag it out of the
        // pile by whatever the ground happens to be under the origin.
        if (slot.carriedBy) continue;
        root.position.y = surface.sampleHeight(root.position.x, root.position.z);
      }

      /*
       * The pile. DECISIONS FIRST, then size — so a creature that picked
       * something up this frame is already bigger this frame. The other way
       * round it grew one frame late, which is a frame of a stone sitting on
       * a creature that has not noticed.
       *
       * `simulateSticky` runs on the page that simulates and nowhere else
       * (docs/PLAN.md §7.6); `growPass` runs on every page, because the pile
       * has to be DRAWN on all of them. A page that is not simulating drops
       * the frame's contact reports on the floor rather than keeping a list
       * nothing will ever read.
       */
      if (manager.simulating()) simulateSticky(nowMs);
      else contacts.length = 0;
      growPass(dt);
    },

    has(id): boolean {
      return slots.has(id);
    },

    clear(id): void {
      const slot = slots.get(id);
      if (!slot) return;
      // The only way a single creature leaves on purpose: an operator's
      // remove/block through the gate, or a replay driving the same removal.
      observer?.retire(id, 'operator');
      disposeSlot(slot);
    },

    clearAll(): void {
      for (const slot of [...slots.values()]) {
        observer?.retire(slot.id, 'cleared');
        disposeSlot(slot);
      }
    },

    pauseTimers(paused): void {
      timersPaused = paused;
    },

    followPoses(poses): number {
      let matched = 0;
      for (const pose of poses) {
        const slot = slots.get(pose.id);
        if (!slot || slot.phase !== 'alive') continue;
        slot.follow = {
          x: pose.x,
          z: pose.z,
          heading: pose.heading,
          // Carried forward, never reset: only the update loop sets this,
          // on the frame it actually places the creature.
          settled: slot.follow?.settled === true,
        };
        matched++;
      }
      return matched;
    },

    /**
     * Forget the host's opinion entirely.
     *
     * Called on every role change. `followPoses([])` used to be the way to
     * say this and it never said anything — it iterates the poses it is
     * given, so an empty list matched nothing and left every slot's follow
     * standing. Harmless while hosting (the branch that reads it needs
     * `aiPaused`), and NOT harmless on the way back down: a page that
     * hosted, lost the election, and started following again would ease
     * from its own simulated positions to the new host's, which is the
     * fly-across-the-map glitch by another route.
     */
    /**
     * The live slots as the population guard sees them.
     *
     * A readout, not a control: it exists so a test can prove that
     * `SpawnOptions.resident` actually reaches the slot, rather than
     * proving `chooseEviction` is correct about a field nothing sets.
     */
    evictable(): { id: string; order: number; resident: boolean; phase: string }[] {
      const out: { id: string; order: number; resident: boolean; phase: string }[] = [];
      for (const slot of slots.values()) {
        out.push({ id: slot.id, order: slot.order, resident: slot.resident, phase: slot.phase });
      }
      return out;
    },

    /**
     * Somebody is steering one creature — or has let go (`null`).
     *
     * A direction on the GROUND plus a strength, already mapped out of
     * screen space by the caller (src/world/joystick.ts), because the
     * caller is the one that knows where the camera is pointing.
     *
     * Returns false when that id holds no living creature, so a stick
     * whose creature has not hatched yet, or has been retired under it,
     * can say so rather than steering nothing in silence.
     *
     * Only the page that is SIMULATING acts on this. On a viewer the
     * creature is placed by the host's poses and a local drive would be
     * overwritten within a frame or two — which is why the intent is
     * published rather than applied (src/net/worldsync.ts). Both routes in
     * — this page's own stick and a handset's drive over the wire — land
     * here, so the hold below is stamped once, wherever the hand is.
     *
     * A rest frame (`null`, or `mag: 0`) neither starts nor extends the
     * hold: it is somebody letting go, and the window measured from it
     * would never close.
     */
    drive(id: string, vec: { x: number; z: number; mag: number } | null): boolean {
      const slot = slots.get(id);
      if (!slot || slot.phase !== 'alive') return false;
      // IGNORED, not refused, while it is stuck to somebody else. The stick
      // still works and the creature still answers to its phone the moment
      // it is set down — a `false` here would have the handset's joystick
      // report the creature gone, which it is not: it is on a pile.
      if (slot.carriedBy) return true;
      slot.drive = vec && vec.mag > 0 ? { x: vec.x, z: vec.z, mag: vec.mag } : null;
      return true;
    },

    /** Every creature currently under somebody's thumb. */
    driven(): string[] {
      const out: string[] = [];
      for (const slot of slots.values()) if (slot.drive) out.push(slot.id);
      return out;
    },

    /**
     * Is the stick still holding this one?
     *
     * True with a thumb down, and true for DRIVE_IDLE_MS after the last
     * push — which is the whole window in which the agent is stood down.
     * `driven()` answers the narrower question (is a stick down RIGHT NOW);
     * this one answers the question the creature's behaviour turns on.
     *
     * A live drive counts whatever the clock says, so a drive that arrived
     * between two frames reads as held before the loop has stamped it.
     */
    isDriven(id: string, nowMs: number): boolean {
      const slot = slots.get(id);
      if (!slot) return false;
      if (slot.drive) return true;
      return slot.drivenAtMs !== null && nowMs - slot.drivenAtMs < DRIVE_IDLE_MS;
    },

    clearFollow(): void {
      for (const slot of slots.values()) slot.follow = null;
    },

    liveIds(): string[] {
      const out: string[] = [];
      for (const slot of slots.values()) {
        if (slot.phase === 'alive' && slot.characterRoot) out.push(slot.id);
      }
      return out;
    },

    eggIds(): string[] {
      const out: string[] = [];
      for (const slot of slots.values()) {
        if (slot.phase === 'egg' && !slot.hatch) out.push(slot.id);
      }
      return out;
    },

    poses() {
      const out: { id: string; x: number; z: number; heading: number }[] = [];
      for (const slot of slots.values()) {
        const root = slot.characterRoot;
        if (slot.phase !== 'alive' || !root) continue;
        /*
         * A CARRIED creature's `root.position` is a clump-local offset, not a
         * place in the world. Its phone still owns it and is still drawing a
         * minimap, so what goes out is where it has actually been carried TO
         * — otherwise the person watching sees their creature parked a few
         * units from the origin while the pile it is stuck in rolls across
         * the field, which is the whole joke and would read as a bug.
         */
        if (slot.carriedBy) {
          root.getWorldPosition(scratchVec);
          out.push({
            id: slot.id,
            x: scratchVec.x,
            z: scratchVec.z,
            heading: root.rotation.y,
          });
          continue;
        }
        out.push({ id: slot.id, x: root.position.x, z: root.position.z, heading: root.rotation.y });
      }
      return out;
    },

    pauseAi(paused): void {
      aiPaused = paused;
    },

    wanderSpeed(): number {
      return wanderSpeedMult;
    },

    setWanderSpeed(mult): void {
      wanderSpeedMult = Math.max(0, mult);
      for (const slot of slots.values()) {
        slot.agent?.setSpeedMultiplier(wanderSpeedMult);
      }
    },

    beginManualMove(root): boolean {
      for (const slot of slots.values()) {
        if (slot.characterRoot === root && slot.phase === 'alive') {
          slot.manualHold = true;
          return true;
        }
      }
      return false;
    },

    simulating(): boolean {
      // THREE halves now. The game first (src/world/game.ts): a world without
      // the katamari decides nothing about sticking, loosening or settling
      // because there is nothing in it to stick — and it never loads rapier
      // either, so this is belt and braces on purpose.
      //
      // Then the bodies, which exist only on a page that was elected host
      // (docs/PLAN.md §7.6), and a page that lost the election a second ago
      // still has them — `aiPaused` is what that page set on the way down.
      return katamari && bodiesOf() !== null && !aiPaused;
    },

    applyStick(record): void {
      if (!katamari) return;
      const carrier = slots.get(record.id);
      if (!carrier) return;
      seat(carrier, record);
    },

    applyDrop(record): void {
      if (!katamari) return;
      const carrier = slots.get(record.id);
      if (!carrier) return;
      unseat(carrier, record.item, record.x, record.z, {
        x: record.qx,
        y: record.qy,
        z: record.qz,
        w: record.qw,
      });
    },

    applyLoose(item, x, z): void {
      /*
       * ON A HOST, THE BODY TOO — and this was a gap, not a choice.
       *
       * `applyLoose` runs on the host in exactly one situation: a restore or
       * a replay of its own log (docs/SESSION.md §4a), where every `loose`
       * in the session is applied at once. It used to only `take` the
       * placement, which hides it and drops its fixed collider — leaving a
       * tree lying in the field with nothing under it: a creature rolled
       * through it, nothing could be picked up off it, and the prop had
       * quietly left the simulation while staying in the picture.
       *
       * `loosen` is the same call the live decision makes, so a restored
       * world is a simulating world. It returns null when the placement is
       * not a standing prop any more (already taken, already loose, never
       * existed), and the plain hide is then the right fallback — there is
       * nothing to build a body from.
       */
      if (!katamari) return;
      const bodies = bodiesOf();
      const built = bodies ? bodies.loosen(item) : null;
      if (!built) hidePlacement(item);
      showLoose(item, x, z, built?.scale);
    },

    applyCrack(item, stage): void {
      if (!katamari) return;
      applyCrackLocal(item, stage);
    },

    applyShatter(record): void {
      // No impact: a page applying somebody else's shatter was not there for
      // the hit, and the fragments are secondary debris either way (the
      // pieces that matter arrive as `settle`). So they are laid out where
      // their chunks sat rather than thrown at a speed nobody recorded.
      if (!katamari) return;
      applyShatterLocal(record, 0);
    },

    wrecks(): { item: string; stage: number; removed: number }[] {
      const out: { item: string; stage: number; removed: number }[] = [];
      for (const state of wrecks.values()) {
        out.push({ item: state.key, stage: state.stage, removed: state.removed.size });
      }
      return out;
    },

    applySettle(record): void {
      if (!katamari) return;
      // Where the thing ACTUALLY came to rest, which is the one position in
      // the whole format (docs/SESSION.md §2): a viewer runs no physics, so
      // without this it would have a tree lying wherever the host last said
      // and no way to find out where it stopped. The height is the seam's.
      looseMeshes?.move(
        record.item,
        record.x,
        surface.sampleHeight(record.x, record.z),
        record.z,
        { x: record.qx, y: record.qy, z: record.qz, w: record.qw },
      );
    },

    endManualMove(root): void {
      for (const slot of slots.values()) {
        if (slot.characterRoot !== root || !slot.manualHold) continue;
        slot.manualHold = false;
        // Re-ground: locomotion never uses world-space Y (Surface seam), so
        // any vertical the gizmo introduced is dropped on release and the
        // creature is set back down on the terrain under it.
        root.position.y = surface.sampleHeight(root.position.x, root.position.z);
        slot.spot = { x: root.position.x, z: root.position.z };
      }
    },
  };
  // Tiny always-on probe (same family as __refworldEnv / __refworldColliders,
  // deliberately not dev-gated): the physics smoke samples live creature
  // positions against the collider set through it.
  (globalThis as { __refworldCreatures?: CreatureManager }).__refworldCreatures = manager;
  return manager;
}
