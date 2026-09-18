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

import { Euler, Frustum, Group, Matrix4, Mesh, Quaternion, Sphere, Vector3 } from 'three';
import type { Object3D } from 'three';
import {
  BehaviorAgent,
  MAX_SPEED,
  type AgentHold,
  type AgentPeer,
  type AgentProp,
  type AgentPropField,
  type AgentProps,
} from '../behavior/agent';
import { personalityFromChoice, type PersonalityChoice } from '../behavior/personality';
import { projectOutOfHard } from '../behavior/steering';
import { createCharacter, type Character } from '../character/character';
import type { CreatureBlueprint } from '../character/blueprint';
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
import { Spring } from '../motion/spring';
import { MOTION } from '../taste/tokens';
import {
  FOLLOW_TAU_MS,
  POSE_INTERVAL_MS,
  followFraction,
  shortestAngle,
} from '../net/worldsync';
import type { WorldHandles } from '../world/scene';
import type { ShadowHandle } from '../world/shadows';
import { ROLLING_SURFACE, type Surface } from '../world/surface';
import { isWater, mapScale } from '../world/landscape';
import { sanitizeGame, type WorldGame } from '../world/game';
import { resolveName } from './naming';
import { createClump, type Clump, type StuckItem } from './clump';
import { FLOAT_SETTLED, floatBob, floatHeight, floatTumble } from './gravity';
import {
  carryLimit,
  clearanceLift,
  footprintRise,
  passLimit,
  rollTarget,
  clumpLocalOffset,
  clumpLocalRotation,
  creatureCarryLimit,
  decideContact,
  CONTACT_PAD,
  DROP_MIN_GAP_MS,
  impactOf,
  massSpeedFactor,
  TOUCH_FIT,
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
 * How much faster a ROLLING katamari creature travels than the spec pace.
 * **[D]**
 *
 * User ask, 2026-09-16: *"Like Katamari Damacy, we should have the character
 * ROLL versus walk. Right now, the walking cycle is way too slow."* A ball
 * has no stride to outrun — the speed a walk reads as honest at is the speed
 * its legs are taking, and a rolling creature has none. Then, from a phone on
 * the deployed build: *"we need to up the speed and velocity by a lot."*
 *
 * SIX, from three. `MAX_SPEED × 6` = **7.2 u/s** — the ceiling a full push
 * reaches once the ball is rolling. The island is ~100u across, so this
 * crosses it in fourteen seconds; at 3.6 it took half a minute, which is what
 * "by a lot" was about. The ghost panel's slider (ceiling 8) is where the
 * next guess gets made.
 *
 * TUNNELLING, since this is the number the substep guard is sized against:
 * `stepCreatures` clamps dt at 250 ms and advances at most `MAX_STEP_TRAVEL`
 * (0.25 u) per substep over at most `MAX_SUBSTEPS` (16), so 4 u of travel per
 * frame. At 10.8 u/s a clamped frame is 2.7 u — 11 of the 16 substeps — and
 * (raised again by half on 2026-09-16: "increase it by 50%", after 7.2 u/s
 * was "still too slow"; the walk went up by the same half) —
 * 0.25 u is still under the smallest thing on the map to tunnel through (a
 * 0.5 u stone's footprint, a ~0.9 u creature), so no step can leap one. The
 * guard covers this ceiling with half of itself spare; `MAX_SUBSTEPS` did not
 * need raising.
 *
 * EVERY OTHER WORLD IS UNCHANGED: outside the game the multiplier is
 * `WANDER_SPEED_DEFAULT` and the walk cycle keeps the speeds it shipped with.
 */
export const KATAMARI_SPEED_MUL = 11;

/*
 * …ELEVEN since 2026-09-18 (*"The character is also moving too slow we should
 * make them more agile"*), from nine. `MAX_SPEED × 11` = **13.2 u/s**, so the
 * 528 u island is forty seconds across under a full push.
 *
 * THE SUBSTEP GUARD STILL COVERS IT, which is the only thing that bounds this
 * number: `stepCreatures` clamps dt at 250 ms and advances at most
 * `MAX_STEP_TRAVEL` (0.25 u) per substep over at most `MAX_SUBSTEPS` (16), so
 * 4 u of travel per frame. A clamped frame at this ceiling is 3.3 u — 14 of
 * the 16 substeps, with two spare — and 0.25 u is still well under the
 * smallest thing on the map to tunnel through (a 0.5 u stone's footprint), so
 * no step can leap one. Above about 14 u/s `MAX_SUBSTEPS` would have to rise
 * with it; that is the wall this constant is heading for.
 */

/**
 * [D] Ceiling on the speed a VIEWER will extrapolate the host at, u/s.
 *
 * The host's speed is derived from two poses and this page's own frame clock
 * (`followPoses`), and both of those can lie: two frames that land in the
 * same millisecond, a tab that was throttled and delivered four poses at
 * once, a roster change that moved a creature. A ceiling is what keeps every
 * one of those from flinging a creature across the field instead of leading
 * it by a few centimetres.
 *
 * `MAX_SPEED × KATAMARI_SPEED_MUL` is the fastest anything in this world can
 * actually travel, plus a fifth for the roster's own quantisation. Above it
 * the direction is kept and the speed is clamped, so a wrong number is a
 * slightly early creature rather than a teleport.
 */
export const FOLLOW_LEAD_MAX_SPEED = MAX_SPEED * KATAMARI_SPEED_MUL * 1.2;

/**
 * [D] The furthest ahead of the host's last pose a viewer will look, ms.
 *
 * One pose interval. Inside it the lead is exactly the distance the creature
 * has travelled since the frame was packed, which is what removes the 5hz
 * stutter; past it the host has gone quiet — dropped packets, a backgrounded
 * tab, an election in progress — and the honest thing is to stop guessing and
 * hold at the last thing anybody said, not to keep walking on an intent that
 * is now a second old.
 */
export const FOLLOW_LEAD_MAX_MS = POSE_INTERVAL_MS;

/**
 * And the WALK ceiling in a katamari world. **[D]**
 *
 * A creature that is carrying nothing is not a ball yet — it walks (PLAN
 * §7.6, the roll blend) — and walking at the rolling ceiling would be a
 * hatchling sprinting. `MAX_SPEED × 3.75` = **4.5 u/s** (2.5 → 3.75 on the
 * 2026-09-16 "increase it by 50%" ask, together with the roll): brisker than the
 * shipped walk (`WANDER_SPEED_DEFAULT`, 1.68 u/s) because the island is
 * bigger than the field that number was tuned on, and far enough under the
 * rolling ceiling that the ball is the thing that goes fast.
 *
 * THE WANDER SITS HERE TOO, at the walk and never at the roll: an unattended
 * creature crossing the island at 7.2 u/s reads as a world running away from
 * the person watching it, and nobody asked for faster ai.
 */
export const KATAMARI_WALK_MUL = 5;

/*
 * …FIVE since 2026-09-18, from 3.75, on the same *"too slow … more agile"*
 * ask: `MAX_SPEED × 5` = **6 u/s** for a creature carrying nothing, against
 * the shipped walk's 1.68. A hatchling is the case where the mass penalty is
 * exactly 1, so this number is felt in full the moment a phone joins — which
 * is what "agile" is about.
 */

/**
 * [D] How much of a blocked push is turned along the wall instead.
 *
 * > User report, 2026-09-16: *"my character keeps on getting stuck on
 * > objects."*
 *
 * `resolveHard` keeps the tangential component of a contact and drops the
 * inward one, which slides along anything met at an angle and does nothing
 * for a hit dead on — where the tangent is zero and the creature simply
 * stands there. 0.8 turns most of the blocked speed into travel along the
 * surface, so a flat wall, a building's face and the inside of a corner all
 * deflect instead of holding. Not 1.0: something has to be lost to running
 * into a wall, or a wall reads as a rail.
 *
 * KATAMARI ONLY (see the use site).
 */
/**
 * DOES A CREATURE EVER PICK UP ANOTHER CREATURE. **[D]**
 *
 * > User report, 2026-09-18: *"we need to fix the movement, some characters
 * > can't move at all"*, and before it *"users can't move"*.
 *
 * No. It is the cause of that report, and the mechanism is in `drive`: a
 * carried creature has no locomotion of its own, so its push is applied to
 * its CARRIER (2026-09-16, itself a fix for a phone that could do NOTHING
 * once its creature was taken). Both behaviours are defensible and neither
 * is what a person with a phone experiences: somebody whose creature was
 * rolled up finds their stick steering a stranger's ball around the island,
 * which reads exactly as *"my character can't move at all"*.
 *
 * Nobody asked for creature-eating. It arrived as a consequence of the
 * katamari rule applying to every collider in reach, including the ones with
 * people attached, and the size gap it needed (`CREATURE_CARRY_RATIO`) only
 * made it rarer, not better. A room of phones is a room of people who each
 * get to drive the thing they drew.
 *
 * ONE FLAG, so the pair are one decision and the whole path stays live and
 * tested (`stickCreature`, `effectiveDrive`, the passenger's own pose and
 * release are all still there and still exercised — a dev drop can still
 * seat one creature on another's pile). Props are untouched: they are what
 * the game is about.
 */
export const CREATURES_EAT_CREATURES = false;

export const WALL_SLIDE = 0.8;

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
 * The same, in a KATAMARI world — tighter, because it is going faster. **[D]**
 *
 * Exponential convergence covers ~90% of a turn in 2.3 τ and ~99% in 4.6 τ.
 * At 90 ms that is 207 ms and 414 ms, and at 7.2 u/s the creature covers a
 * metre and a half of ground before it is really pointing where the thumb
 * asked — which does not read as easing, it reads as SLIDING. 60 ms puts the
 * same turn at 138 ms and 276 ms, inside the ~250 ms where a hand still reads
 * cause and effect.
 *
 * Still monotone and still ζ ≥ 1 in the sense that matters: this is
 * `followFraction`, an exponential approach that cannot overshoot its target
 * however hard the stick is thrown (TASTE §2.1, confidence 1.00). Sixty is a
 * shorter constant, not a springier one.
 */
export const KATAMARI_TURN_TAU_MS = 45;

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
/**
 * [D] How many `stick` records may wait for a creature that has not arrived on
 * this page yet (`pendingSticks`).
 *
 * A pile is a few dozen things and the wait is the second or two between a
 * drawing landing and its creature standing up, so this is a ceiling on a
 * pathological case rather than a working limit: a page that is further
 * behind than this gets the world from the scene store instead.
 */
export const PENDING_STICKS_MAX = 64;

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
 * Inside `farFieldStart` (150), where the authored geography is still at
 * full height, with a margin so a spot never lands on the ramp down to the
 * flat outer disc. Wide on purpose: the point is a population that reads as
 * scattered over the whole field, not a clutch at the hatch clearing.
 */
export const SPAWN_RADIUS = 120;

/**
 * …and the radius actually drawn from: `SPAWN_RADIUS` through `mapScale`
 * (2026-09-16, the island doubled), so a room still spreads over the whole map
 * instead of over its middle quarter. 240 on the doubled island, which is the
 * same margin inside `farFieldStart`'s own 300.
 */
export function spawnRadius(): number {
  return SPAWN_RADIUS * mapScale();
}

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
    const radius = spawnRadius() * Math.sqrt(u);
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
function readProps(world: WorldHandles, into?: AgentProp[]): AgentProp[] | null {
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
  const out: AgentProp[] = into ?? [];
  out.length = 0;
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

/**
 * [D] Cell edge of the PROP index, world units.
 *
 * The scatter lays props on a 6-unit iso grid with jitter, so a cell of 8
 * holds a handful and the first ring of a nearest search almost always
 * contains the answer. Bigger wastes the ring; smaller walks more cells to
 * find anything at all.
 */
const PROP_GRID_CELL = 8;

/**
 * [D] How far a nearest-prop search will expand before it gives up on the
 * index and scans. 1024 is past the diagonal of any map this project draws
 * (the ground field's own extent is ±200), so the scan is a guard against a
 * stray placement rather than a path anything takes.
 */
const PROP_SEARCH_MAX = 1024;

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

/** The y axis. Shared, never mutated — a placement's yaw is a turn about
 * this and nothing else. */
const UP = /* @__PURE__ */ new Vector3(0, 1, 0);

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
   *
   * `settled` is false until the first frame has been APPLIED. A viewer
   * spawns the whole cast at its deterministic spawn spots and only then
   * hears where the host actually has them — so the first pose is not a
   * movement, it is finding out. See the update loop.
   *
   * `vx`/`vz` are the host's own SPEED, in world units per millisecond,
   * derived from the two most recent poses — and `ageMs` is how long ago
   * this one landed.
   *
   * Not on the wire and never will be (poses carry x/z/heading and nothing
   * else — src/net/worldsync.ts). A page that knows where the creature was
   * and where it now is knows how fast it is going, exactly the way the
   * viewer already derives the roll and the gait from its own displacement.
   *
   * What they are FOR (2026-09-17, *"some characters get stuck when trying
   * to move and glitch on mobile"*): poses land five times a second, and
   * `FOLLOW_TAU_MS` is set so a creature has substantially arrived by the
   * time the next one does. For a creature standing still that is a settle;
   * for a creature WALKING it means it covers the gap in the first ~90ms
   * and then stands there for 110 — a 5hz stutter, on the one screen whose
   * owner is watching their own creature and pushing a stick. So the viewer
   * eases toward where the host's creature is GOING rather than where it
   * last was. Katamari-gated: every other world's viewer eases exactly as
   * it shipped.
   */
  follow: {
    x: number;
    z: number;
    heading: number;
    settled: boolean;
    vx: number;
    vz: number;
    ageMs: number;
  } | null;
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
  /**
   * ONE FLAT STAMP PER SEATED ITEM, by item key — the pile's own silhouette
   * on the paper (user ask, 2026-09-17: *"we should not show the shadow of the
   * sphere … we should be showing the shadow of the objects that are attached
   * to the character and the actual silhouette of the mass of objects +
   * character"*). Empty for a creature carrying nothing, which keeps its own
   * stamp and nothing else.
   */
  pileShadows: Map<string, ShadowHandle>;
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
   * The node the drawn creature hangs in — the `rider` group `becomeAlive`
   * builds, on the ROOT and above the clump.
   *
   * Two things live on it and `growPass` writes both every frame (user ask,
   * 2026-09-17: *"we should not scale up the characters as they stick to
   * things"*): the COUNTER to the root's growth, which is exactly what
   * `localScaleOf` already does for every stuck item
   * (src/creatures/clump.ts), and the HEIGHT that puts the creature on top of
   * its own pile. It is deliberately NOT inside the clump, so the roll does
   * not turn it. Null while this is an egg, and in every world but the
   * katamari.
   */
  rider: Group | null;
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
  /**
   * WALKING OR ROLLING, in [0, 1] — the katamari's locomotion blend
   * (docs/PLAN.md §7.6).
   *
   * 0 is a creature on its legs and 1 is a ball. Written every frame by
   * `growPass` from `rollSpring`, read by the gait amplitude, by how much of
   * the travel turns into roll, and by the drive ceiling. Always 0 in a world
   * without the game, where there is no clump to carry anything.
   */
  roll: number;
  /**
   * The ζ ≥ 1 spring `roll` comes off, over `MOTION.primaryMs`. Null until
   * the creature is alive, and in every world but the katamari.
   *
   * Never on the wire: its target is `rollTarget(clump items, growth)`, and
   * every page holds the same clump off the same `stick`/`drop` events — so
   * each one derives the same blend rather than being told it.
   */
  rollSpring: Spring | null;
  /**
   * GROUND CLEARANCE — how far this creature's root is held ABOVE the ground
   * under its centre, world units (user report, 2026-09-16: *"the ball is
   * glitching through the map floor if it's big enough"*).
   *
   * A presentation offset on the one Y write there is (the frame's ground
   * pass), never a second opinion about where the ground is: the ball's
   * underside is the root, so a ball whose footprint spans a slope has to
   * ride up on its uphill side or the downhill half of it is inside the hill
   * (`clearanceLift`). Always 0 in a world without the game, and 0 for a
   * creature carrying nothing — a hatchling gets exactly the placement it
   * shipped with, and the footprint ring is not even sampled for it.
   *
   * NEVER ON THE WIRE. It is derived on every page from the Surface and the
   * synced growth, which is the same rule the walk/roll blend follows: poses
   * carry x/z/heading and Y is always local (docs/PLAN.md §7.6).
   */
  lift: number;
  /** The ζ ≥ 1 spring `lift` comes off, over `MOTION.primaryMs`, so a terrace
   * edge is a slide and not a step. Null until alive, and in every world but
   * the katamari. */
  liftSpring: Spring | null;
  /**
   * HOW FAR THIS CREATURE IS FLOATING, world units (user ask, 2026-09-17:
   * *"i want a zero gravity mode … characters should float in space"*).
   *
   * The second presentation offset on the same one Y write, beside `lift`:
   * `blend × (floatHeight(seed) + floatBob(t, seed))`
   * (src/creatures/gravity.ts). 0 while the world has its gravity, and 0 to
   * the float in every world without the game.
   *
   * NEVER ON THE WIRE, exactly like `lift` and the roll blend: what travels
   * is the one bit that says the map is weightless, as a scene event
   * (docs/PLAN.md §7.6), and every page derives its own float from it.
   */
  float: number;
  /**
   * The ζ ≥ 1 blend `float` rides, over `MOTION.primaryMs` — 0 grounded, 1
   * weightless. Lift-off is a slide up and `g` again is a slow settle back
   * down; the spring is the only thing with a target, so neither can
   * overshoot or bounce (TASTE §2.1, confidence 1.00). Null until alive, and
   * in every world but the katamari.
   */
  floatSpring: Spring | null;
  /**
   * The blend itself, 0…1 — a readout of the spring above.
   *
   * Separate from `float` on purpose: `float` carries the ambient bob, so it
   * rises and falls once the creature is up there, while THIS is monotone
   * from the moment `g` is pressed to the moment it settles. It is what a
   * test asserts the slide on and what the panel would show.
   */
  floatBlend: number;
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
   * The pure pipeline's output for these strokes, already built — the load
   * path's way of keeping `createCharacter` off the interpret-and-inflate
   * work (src/character/blueprintPool.ts).
   *
   * Absent, `createCharacter` builds it here, which is what every other
   * spawn path does and what this one does on a page with no workers. It
   * does not change what the creature IS: same strokes, same dials, same
   * function, and the blueprint is pinned against the inline build in
   * `test/character/blueprint.test.ts`.
   */
  blueprint?: CreatureBlueprint;
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
  /**
   * `scale` is the instance scale the placement was DRAWN at — the one thing
   * about a loose prop that cannot be re-derived anywhere else (2026-09-17,
   * *"objects shrink when they stick to the character"*). Optional on the
   * wire, so it is optional here.
   */
  loose(item: string, x: number, z: number, scale?: number): void;
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
  /**
   * Its FOOTPRINT RADIUS — the volume it adds to the pile (2026-09-17).
   *
   * The one number in this record that is not about drawing. Growth is
   * derived on every page and a viewer reads the radius off the scatter's
   * instance row, which by the time it applies a `stick` has been rebuilt
   * away — so it fell back to the instance SCALE and the viewer's ball grew
   * on the wrong volumes (src/session/events.ts `StickEvent.r`). Optional,
   * so an old log reads exactly as it did.
   */
  r?: number;
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
   * LET GO OF EVERYTHING — call on any change of role, beside `clearFollow`
   * (2026-09-17, the *"characters get stuck when trying to move"* report).
   *
   * A drive is a hand on a creature, and the hands belong to the PAGE that
   * is simulating: a phone alone on the link applies its own stick locally,
   * a projection applies every phone's over the wire. When that page stops
   * being the host, none of those hands are on anything any more — but
   * `slot.drive` stayed set on every creature it had been steering, which
   * is two bugs at once. `isDriven` keeps answering true, so those
   * creatures' agents stay stood down forever and they stand there; and the
   * moment the page wins an election back, every one of those stale vectors
   * takes effect at once and the whole cast sets off in directions nobody
   * asked for. `effectiveDrive` sums a pile's passengers, so one stale
   * passenger steers somebody else's ball.
   *
   * Returns how many it let go of, which is what lets a test see the
   * difference between "released" and "there was nothing to release".
   */
  clearDrives(): number;
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
  evictable(): {
    id: string;
    order: number;
    resident: boolean;
    phase: string;
  }[];
  /** Live creature ids, in a stable order — the roster a host publishes. */
  liveIds(): string[];
  /**
   * ONE CREATURE'S ROOT NODE, by the id it was spawned under, or null while
   * it is still a shell (user ask, 2026-09-17: the corner's live view).
   *
   * The whole rig hangs under it — the drawn creature in its `rider`, the
   * ball, the pile and every passenger — so this is what a second camera has
   * to be handed to draw exactly one creature and nothing else
   * (src/world/portrait.ts renders it as its own scene graph). A READ, not a
   * handle: nothing may move it, and the one pass that owns its position is
   * still the frame's ground pass.
   *
   * By the id ASKED FOR and not the pile's owner: a caller that wants the
   * ball a passenger is inside resolves that through `ballOwner` first, the
   * same way the leaderboard and the size readout do.
   */
  rootOf(id: string): Group | null;
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
  applyLoose(item: string, x: number, z: number, scale?: number): void;
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
  /**
   * How much of a BALL this creature is, 0…1 (docs/PLAN.md §7.6).
   *
   * A readout, not a control: the blend is derived from the pile on every
   * page and nothing may set it. It exists so the ghost panel can show what
   * a creature's locomotion is actually doing and so a test can assert the
   * slide rather than infer it from a waddle. 0 for an id nobody holds, and 0
   * for the whole of any world without the game.
   */
  rollBlend(id: string): number;
  /**
   * How far this creature's root is riding ABOVE the ground under its centre,
   * world units (user report, 2026-09-16: *"the ball is glitching through the
   * map floor if it's big enough"*).
   *
   * A readout of the same kind as `rollBlend`: the clearance is derived from
   * the Surface and the pile on every page and nothing may set it. It exists
   * so a test can assert that a big ball's underside clears the highest
   * ground under its footprint without re-deriving the footprint, and so the
   * ghost panel can show a number that is otherwise invisible until it is
   * wrong. 0 for an id nobody holds, 0 for a creature carrying nothing, and 0
   * for the whole of any world without the game.
   */
  groundLift(id: string): number;
  /**
   * HOW FAR THE DRAWN PILE REACHES from its centre, world units — the
   * silhouette's own radius (`Clump.reach`), which is what the ground pass
   * rests on the paper and is NOT `ballDiameter / 2` (that is the accumulated
   * volume, the game's size, and it is larger). 0 for a creature carrying
   * nothing, for an id nobody holds, and for every world without the game.
   */
  pileReach(id: string): number;
  /**
   * WHERE THE DRAWN PILE'S BOTTOM IS, world units above this creature's feet
   * (`Clump.floor`): 0 when nothing is under them — which is the usual answer
   * for a pile packed sideways — and negative when there is. What the ground
   * pass sits the creature up by, and the number the *"characters are
   * floating"* report (2026-09-17) is about. 0 for an id nobody holds and for
   * every world without the game.
   */
  pileFloor(id: string): number;
  /** …and how far the pile is holding ITSELF up, world units — what keeps a
   * ball that reaches below the creature's feet out of the ground without
   * lifting the creature (2026-09-18). */
  pileRise(id: string): number;
  /** …and its HIGHEST point in the same frame (`Clump.ceiling`) — what the
   * corner's live view frames the mass by. 0 for an empty pile. */
  pileCeiling(id: string): number;
  /** …and HOW WIDE it is, world units from the creature's axis
   * (`Clump.footprint`) — the circle the ground under it is sampled over. */
  pileFootprint(id: string): number;
  /**
   * THE CREATURE'S OWN DRAWN RADIUS, world units — `Character.radius`, the
   * footprint its shadow stamp is cut at, and the one radius in this game
   * that never grows (the rider divides the growth back out).
   *
   * Published because everything PRESENTED has to be this or the pile's own
   * reach, never `ballDiameter / 2` (user ask, 2026-09-17: *"at the beginning,
   * the character shouldn't have that big of a radius. it should scale as the
   * objects collect around the character"*). 0 before the shell opens.
   */
  drawnRadius(id: string): number;
  /** …and how many times its own size it is DRAWN at — the root's scale,
   * which is the clump's growth. 1 for a creature carrying nothing. */
  growthOf(id: string): number;
  /**
   * TURN THE MAP'S GRAVITY OFF, OR BACK ON (user ask, 2026-09-17: *"i want a
   * zero gravity mode where i can hit g on the keyboard and it turns off
   * gravity for the map. characters should float in space"*).
   *
   * `false` = weightless. The one control in this pair — every creature's
   * float is DERIVED from it (`floatOffset`), never set from outside, so a
   * page cannot be told where a creature is hanging and Y stays off the wire
   * (docs/PLAN.md §7.6).
   *
   * What sets it is the `gravity` scene event, applied through the replay
   * driver on every page exactly like a landscape switch — so a phone that
   * joins later, and a refreshed projection healing itself, come up in the
   * same gravity. Nothing else may call it.
   *
   * KATAMARI ONLY (2026-09-15 ruling, src/world/game.ts): in a world with no
   * game this is a no-op and `gravity()` stays true, so no other world can
   * have its creatures lifted off the ground by an event off a shared broker.
   */
  setGravity(on: boolean): void;
  /** Does this world have its gravity? True unless something turned it off —
   * and always true in a world without the game. */
  gravity(): boolean;
  /**
   * How far this creature is FLOATING above where it would otherwise stand,
   * world units — the zero-gravity presentation, derived on every page from
   * the flag, the slot id and this page's own clock
   * (src/creatures/gravity.ts).
   *
   * A readout of the same family as `groundLift`, and it carries the ambient
   * bob: it rises and falls slowly while a creature is up there. 0 with the
   * world's gravity on, 0 for an id nobody holds, and 0 for the whole of any
   * world without the game.
   */
  floatOffset(id: string): number;
  /**
   * …and the blend behind it, 0…1 — monotone from the press to the settle,
   * because it is a ζ ≥ 1 spring and nothing else writes it. What a test
   * asserts the slide on (the offset above bobs, so it cannot be).
   */
  floatBlend(id: string): number;
  /**
   * Top ground speed this creature would reach under a full push, u/s.
   *
   * A readout of `DRIVE_SPEED × driveMult(blend)`: the walk ceiling for a
   * creature on its legs, the rolling one for a ball, and the same number
   * either way in a world without the game. The panel shows it and the tests
   * measure against it rather than re-deriving a multiplier, which is how the
   * arithmetic stays in one place. 0 for an id nobody holds.
   */
  driveCeiling(id: string): number;
  /**
   * HOW BIG THIS CREATURE'S BALL IS, in world units across (user ask,
   * 2026-09-16: *"for the mobile ui on the world view i want to show ball
   * diameter in the top left hand side"*).
   *
   * `2 × bodyR`, and `bodyR` is `baseR × clump.growth()` rewritten by
   * `growPass` on every page — so this is the same radius the resolve pass,
   * the pickup reach and the scatter's exclusion radius already run on,
   * rather than a second measurement of the same ball.
   *
   * A PASSENGER ANSWERS WITH ITS CARRIER'S. A creature riding on a pile has
   * no ball of its own — it is part of somebody else's, exactly as it has no
   * walk of its own (`rollOf`) — so the number its phone shows is the ball it
   * is actually inside.
   *
   * 0 for an id nobody holds, 0 for a creature still in its shell (there is
   * no measured footprint until hatch), and 0 for the whole of any world
   * without the game: no pickups means no pile, so there is no ball to put a
   * size on and a readout of one would be a number about nothing.
   *
   * A readout, not a control — the units are this world's, and the seam that
   * turns them into a length a person reads is `src/ui/size.ts`.
   */
  ballDiameter(id: string): number;
  /**
   * WHOSE BALL this creature is part of — its own id, or the id of the
   * carrier at the bottom of the pile it is riding on.
   *
   * The companion question to `ballDiameter`, and it exists because that one
   * deliberately answers with the CARRIER'S size: a passenger has no ball of
   * its own, so `ballDiameter` reads the pile it is inside. Anything that
   * ranks balls has to be able to tell those two apart or it lists one ball
   * once per creature stuck to it (src/ui/leaderboard.ts — the projection's
   * top ten, 2026-09-17).
   *
   * Its own id for a creature standing on its own feet, for a shell, and for
   * the whole of any world without the game, where nothing is carried at
   * all. The empty string for an id nobody holds.
   */
  ballOwner(id: string): string;
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
  /**
   * How much of a ball this creature is, 0…1 — and a PASSENGER RIDES ITS
   * CARRIER'S (2026-09-16 ask: *"a passenger rides its carrier's blend"*).
   *
   * A creature sitting on a pile has no locomotion of its own: it is inside
   * somebody else's ball, so it rolls when that ball rolls and it does not
   * walk while it is up there. The walk up the carriers is bounded because a
   * pile cannot be inside itself, and the guard is belt and braces.
   */
  /**
   * The slot whose BALL this one is part of: itself, or the carrier at the
   * bottom of the pile it is riding on.
   *
   * Walked rather than stored, and bounded at eight hops: a pile cannot be
   * inside itself (`seat` refuses it), so the guard is belt and braces. Two
   * readouts share it — the locomotion blend below and `ballDiameter`, which
   * has to answer with the carrier's size for exactly the same reason a
   * passenger has no walk of its own.
   */
  const ballOf = (slot: Slot): Slot => {
    let at: Slot = slot;
    for (let hop = 0; hop < 8; hop++) {
      const carrier = at.carriedBy === null ? null : slots.get(at.carriedBy);
      if (!carrier) break;
      at = carrier;
    }
    return at;
  };

  const rollOf = (slot: Slot): number => ballOf(slot).roll;

  /**
   * How much of the WALK to show — the other side of the same blend.
   *
   * The gait used to be fed a flat zero in a katamari world (a waddle on top
   * of a roll is two locomotions at once). It is now scaled instead, so a
   * creature that has picked nothing up walks properly and one that has three
   * stones on it has stopped waddling by the time it is rolling.
   */
  const gaitAmp = (slot: Slot): number => (katamari ? 1 - rollOf(slot) : 1);
  const surface = options.surface ?? ROLLING_SURFACE;
  /** The seam as a plain sampler, for the pure rules that take one
   * (`clearanceLift`). Bound once: a closure per creature per frame to ask
   * the same object the same question is garbage for nothing. */
  const sampleAt = (x: number, z: number): number => surface.sampleHeight(x, z);
  const slots = new Map<string, Slot>();
  /**
   * [D] How many of a pile's items cast a stamp of their own.
   *
   * The outermost thirty-two, which is what shapes the outline: the things
   * inside them are already under it, and a stamp is one instanced matrix in
   * the pass that draws every shadow in the world (src/world/shadows.ts), so
   * the cost of the bound is a sort of the pile once a frame.
   */
  const PILE_SHADOWS_MAX = 32;
  /** Scratch for the pile-shadow pass: one array and one set, reused, so a
   * creature carrying a pile allocates nothing per frame. */
  const shadowWanted: StuckItem[] = [];
  const shadowKeep = new Set<string>();
  const shadowSeat = new Vector3();
  /**
   * STICKS THAT ARRIVED BEFORE THE CREATURE DID (2026-09-17).
   *
   * Measured in a real room (`scratch/room-scale-probe.mjs`): the projection
   * decided six pickups and the phone watching it drew NONE of them, because
   * on that page the drawing had not finished becoming a creature when the
   * events landed — and a `stick` whose carrier is not alive yet was simply
   * dropped. The pile is not re-sent: the roster carries poses, and the store
   * only helps a page that opens after the batch. So a viewer kept a ball the
   * host had grown six items ago, and every screen in the room was a
   * different size.
   *
   * So they WAIT here, by carrier id, in arrival order, and `becomeAlive`
   * drains them (`drainPendingSticks`). Bounded by `PENDING_STICKS_MAX` per
   * carrier, oldest dropped first: a pile is a few dozen things and this is a
   * gap of a second or two, so anything past that is a page that will get the
   * world from the store instead.
   */
  const pendingSticks = new Map<string, StickRecord[]>();
  let orderCounter = 0;
  let timersPaused = false;
  let aiPaused = false;
  /*
   * IS THE MAP WEIGHTLESS? (user ask, 2026-09-17: *"i want a zero gravity
   * mode where i can hit g on the keyboard and it turns off gravity for the
   * map. characters should float in space"*).
   *
   * One bit for the whole world, set by `setGravity` from the scene event and
   * from nowhere else — never derived here, because a room where one page
   * decided this for itself would be two worlds (docs/PLAN.md §7.6). Every
   * creature's float is then derived FROM it locally, which is what keeps Y
   * off the wire (`floatLift`, src/creatures/gravity.ts).
   *
   * False in every world without the game: `setGravity` refuses to set it,
   * so the float springs sit at rest at 0 forever and nothing in the frame
   * changes by a float.
   */
  let zeroGravity = false;
  /**
   * THE TOP of this world's speed range — the number the ghost panel's
   * wander/speed slider holds and `wanderSpeed()` reports.
   *
   * KATAMARI GETS ITS OWN DEFAULT (user ask, 2026-09-16: *"the walking cycle
   * is way too slow"*, then *"we need to up the speed and velocity by a
   * lot"*). It is a different default rather than a factor ON the shipped
   * one because the shipped 1.4 is a tuning of a WALK. At
   * `KATAMARI_SPEED_MUL` the ROLLING drive ceiling is `MAX_SPEED × 6` =
   * 7.2 u/s, which is the number the substep guard is checked against.
   *
   * Outside the katamari it is the only multiplier there is, exactly as it
   * shipped: the wander and the stick both read it and nothing else.
   */
  let wanderSpeedMult = katamari ? KATAMARI_SPEED_MUL : WANDER_SPEED_DEFAULT;

  /**
   * What the panel's slider is saying RELATIVE to the shipped default — 1
   * when nobody has touched it.
   *
   * The katamari has two ceilings (a walk and a roll) and one slider, so the
   * slider scales the pair rather than owning one of them. Everywhere else
   * there is one ceiling and this is 1.
   */
  const speedScale = (): number => (katamari ? wanderSpeedMult / KATAMARI_SPEED_MUL : 1);

  /**
   * The WALK ceiling multiplier — what a creature carrying nothing drives at,
   * and what every agent wanders at (`KATAMARI_WALK_MUL`).
   *
   * The wander sits here and never at the rolling ceiling: an unattended
   * creature crossing the island at 7.2 u/s is a world running away from the
   * person watching it.
   */
  const walkMult = (): number =>
    katamari ? KATAMARI_WALK_MUL * speedScale() : wanderSpeedMult;

  /**
   * The ceiling multiplier for a creature under somebody's thumb.
   *
   * On a katamari world it LERPS with the walk/roll blend: a creature on its
   * legs drives at the walk ceiling and the same creature, three stones
   * later, drives at the rolling one (docs/PLAN.md §7.6). The blend is a
   * ζ ≥ 1 spring, so the speed arrives by sliding — there is no frame where
   * the stick suddenly means something different.
   */
  const driveMult = (blend: number, growth: number = 1): number =>
    katamari
      ? (walkMult() + (wanderSpeedMult - walkMult()) * blend) * massSpeedFactor(growth)
      : wanderSpeedMult;

  /**
   * THE MASS PENALTY on a slot's own speed (user ask, 2026-09-18: *"when a
   * ball gets big it should move slower. smaller balls should move faster"*).
   *
   * `massSpeedFactor` is the law (src/creatures/sticky.ts, pure and tested);
   * this is the only place that reads a slot for it. It is exactly 1 for a
   * creature carrying nothing, so a hatchling drives and wanders at the
   * speeds it shipped with and no other world's arithmetic moves — nothing
   * outside the game ever has a pile, and `driveMult` does not even ask.
   *
   * It is not on the wire and does not need to be: every page derives it from
   * the growth, and the growth comes from the seats, which travel on the
   * `stick` event. A viewer's extrapolation is bounded by
   * `FOLLOW_LEAD_MAX_SPEED` as before — a ceiling over everything, unchanged.
   */
  const massMultOf = (slot: Slot): number =>
    katamari ? (slot.clump?.growth() ?? 1) : 1;

  /**
   * THE SOLID RADIUS — how far this creature physically reaches, world units.
   *
   * > User report, 2026-09-18: *"objects are still being drawn towards the
   * > creature instead of sticking to the creature after it rolls over it."*
   *
   * `bodyR` is `baseR × growth`: the accumulated VOLUME of everything
   * collected, which is the game's SIZE — the readout, the leaderboard, the
   * carry limit, the impact. It is NOT where the mass is. Since the pile was
   * packed (2026-09-17) and interlocked (2026-09-18) the drawn lump is
   * markedly tighter than that number — 4.6 u packed against a 7.1 u volume
   * at fifteen props — so every circle derived from `bodyR` was metres wider
   * than anything on screen: props were grabbed out of clear air and then
   * slid to their seat, and a creature bounced off walls it had not reached.
   *
   * So "how big is this ball" and "where is its surface" are two questions
   * now, the way `rapierOwns`/`deciding` are two questions (docs/PLAN.md
   * §7.6). This is the second one: the creature's own drawn radius, or the
   * pile's footprint once there is one. Outside the game there is no pile and
   * this is exactly `bodyR`, so nothing else in this file changes by it.
   *
   * WHAT STILL READS `bodyR`, on purpose: `carryLimit`/`passLimit` (what a
   * mass can pick up or shove past), `impactOf` (what it hits with),
   * `ballDiameter` and the leaderboard (its size), `positions()`'s exclusion
   * radius (the scatter keeps clear of the whole game object) and the
   * mass-speed factor. Those are all about MASS. This one is about REACH.
   */
  const solidR = (slot: Slot): number => {
    if (!katamari) return slot.bodyR;
    const drawn = Math.max(slot.baseR, slot.clump?.footprint() ?? 0);
    return drawn > 0 ? drawn : slot.bodyR;
  };

  /** How fast a driven creature turns toward the push — tighter in a
   * katamari world, because it is going more than twice as fast there. */
  const turnTauMs = (): number => (katamari ? KATAMARI_TURN_TAU_MS : DRIVE_TURN_TAU_MS);

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
  /*
   * THE PROP FIELD — read once per CHANGE, not once per frame, and asked for
   * its nearest through a spatial index rather than a full scan.
   *
   * `readProps` walked `scatter.positions()` and rebuilt an array of fresh
   * objects every frame (1,083 of them on the katamari island; the scatter's
   * own `positions()` is a filter and a map over every placement). Then every
   * agent scanned all of it, twice, for the one fact it wanted: which prop is
   * nearest. Measured at 200 creatures on the island: 0.6 ms for the read and
   * 6.1 ms for the scans, a frame, for a set that changes only when a prop is
   * taken or the density moves.
   *
   * So: the array is rebuilt in place when `collidersVersion()` moves — the
   * same signal the collider grid already keys on, and the one `hideTaken`
   * bumps — and the nearest query walks the hash. Both answers are the ones
   * the full scan gave, tie for tie (see `AgentPropField`).
   */
  const propsScratch: AgentProp[] = [];
  let propsField: AgentProp[] | null = null;
  let propsVersion = -1;
  const propGrid = new SpatialHash(PROP_GRID_CELL);
  const propField: AgentPropField = {
    get items(): readonly AgentProp[] {
      return propsField ?? propsScratch;
    },
    nearest(x: number, z: number): AgentProp | null {
      const items = propsField;
      if (!items || items.length === 0) return null;
      // Expanding rings: the first radius that contains anything contains the
      // winner, because everything outside it is farther away than the winner
      // is. Candidates arrive in insertion order, so `<=` keeps the same one
      // of a tie the linear scan kept.
      for (let radius = propGrid.cellSize; radius <= PROP_SEARCH_MAX; radius *= 2) {
        const found = propGrid.near(x, z, radius);
        if (found.length === 0) continue;
        let best: AgentProp | null = null;
        let bestD = Infinity;
        for (let k = 0; k < found.length; k++) {
          const it = items[found[k]!]!;
          const d = Math.hypot(it.x - x, it.z - z);
          if (d <= bestD) {
            bestD = d;
            best = it;
          }
        }
        return best;
      }
      // Farther than the search ever reaches (a prop off the edge of the
      // world): answer exactly as the scan would have.
      let best: AgentProp | null = null;
      let bestD = Infinity;
      for (const it of items) {
        const d = Math.hypot(it.x - x, it.z - z);
        if (d <= bestD) {
          bestD = d;
          best = it;
        }
      }
      return best;
    },
  };

  /**
   * The frame's props. Re-read only when the scatter says its set moved; with
   * no version to key on (a stub scatter in a test) it is re-read every frame,
   * exactly as it always was.
   */
  function currentProps(version: number): AgentProp[] | null {
    if (version >= 0 && version === propsVersion) return propsField;
    const next = readProps(world, propsScratch);
    propsField = next;
    propsVersion = version;
    propGrid.rebuild(next ?? propsScratch);
    return next;
  }

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
  function clearSpawnSpot(spot: { x: number; z: number }): {
    x: number;
    z: number;
  } {
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
    slot.rollSpring?.dispose();
    slot.rollSpring = null;
    slot.liftSpring?.dispose();
    slot.liftSpring = null;
    slot.lift = 0;
    slot.floatSpring?.dispose();
    slot.floatSpring = null;
    slot.float = 0;
    slot.floatBlend = 0;
    slot.clump?.dispose();
    slot.clump = null;
    slot.rider = null;
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
    clearPileShadows(slot);
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
      /*
       * WALK FIRST, ROLL WITH MASS (user ask, 2026-09-16: *"let's have them
       * start walking at first and once they hit a few objects they begin to
       * roll because they have mass"*).
       *
       * One spring per creature, from rest: a hatchling carrying nothing is
       * at 0 and walks. `growPass` retargets it at `rollTarget` every frame
       * and the blend slides over `MOTION.primaryMs` — ζ ≥ 1 by construction,
       * so a creature becoming a ball can never overshoot into more roll than
       * a roll (TASTE §2.1, confidence 1.00), and one that sheds its pile
       * walks again the same way round.
       */
      slot.rollSpring = new Spring(0, { settleMs: MOTION.primaryMs });
      /*
       * AND THE BALL'S GROUND CLEARANCE, from rest (user report, 2026-09-16:
       * *"the ball is glitching through the map floor if it's big enough"*).
       *
       * From 0, which is the shipped placement: a newborn is standing on the
       * ground under its centre exactly as it always did, and the clearance
       * only grows as the pile does. ζ ≥ 1 like every spring here, over
       * `MOTION.primaryMs`, so rolling onto a terrace lifts the ball by
       * sliding it — a step in Y is the hard cut the motion law forbids at
       * confidence 1.00 whether the ground made it or we did.
       */
      slot.liftSpring = new Spring(0, { settleMs: MOTION.primaryMs });
      /*
       * AND WHETHER THE MAP HAS ITS GRAVITY, from rest (user ask, 2026-09-17:
       * *"i want a zero gravity mode where i can hit g on the keyboard and it
       * turns off gravity for the map. characters should float in space"*).
       *
       * From 0 — the ground — and retargeted at 1 for as long as the shared
       * flag says the world is weightless, so a creature that hatches into a
       * zero-gravity room SLIDES up off the paper rather than appearing in
       * mid-air, and one that is already up there settles back down the same
       * way round. ζ ≥ 1 like every spring here (src/creatures/gravity.ts).
       */
      slot.floatSpring = new Spring(0, { settleMs: MOTION.primaryMs });
      slot.clump = createClump(slot.baseR);
      root.add(slot.clump.group);
      /*
       * AND THE CREATURE RIDES ON TOP OF THE BALL (user ask, 2026-09-17:
       * *"we should not scale up the characters as they stick to things"*).
       *
       * It used to be INSIDE the pile: the body was reparented into
       * `clump.group` — the one node that accumulates the no-slip roll — in a
       * wrapper at `(0, -baseR, 0)`, so the drawn creature was the ball and
       * turned with it (2026-09-16, *"like Katamari Damacy, we should have
       * the character ROLL versus walk"*). That made the growth the
       * creature's: the root's uniform scale IS the pile's growth, so a
       * fifteen-metre ball was a fifteen-metre creature wearing a few stones.
       *
       * Now the pile is the ball and the creature is the passenger — the
       * katamari read, a small character and a big mass. Two consequences,
       * and this node is where both live:
       *
       *   - it COUNTERS the root's scale (`growPass`, `1 / growth`), exactly
       *     the way `localScaleOf` counters it for every stuck item
       *     (src/creatures/clump.ts). The creature's world size is its drawn
       *     size, whatever the pile has become, and the stalk, topper and
       *     eyes ride that because they are children of it;
       *   - it hangs on the ROOT and not in the clump, so it is not turned by
       *     the roll. A creature tumbling with the mass it is standing on
       *     would be upside down half the time; the topper faces the heading
       *     instead, which is the root's and always was.
       *
       * Its HEIGHT is written every frame, not here: `2 · baseR · roll` in
       * root-local units, which is `2R · roll` in the world — the ball's
       * north pole once it is rolling, and exactly the ground under its feet
       * while it is still walking (`roll` is 0 there, so a creature carrying
       * nothing stands where it always stood, to the float). The ramp between
       * is the roll spring's, ζ ≥ 1: it slides up onto its pile, it never
       * steps (TASTE §2.1, confidence 1.00).
       */
      const rider = new Group();
      rider.name = 'rider';
      // Reparent, not copy: `Object3D.add` detaches from the root first.
      rider.add(character.group);
      root.add(rider);
      slot.rider = rider;
    }
    world.shadows.removeShadow(`egg-${slot.id}`);
    slot.eggShadow = null;
    slot.egg = null;
    slot.phase = 'alive';
    // …and whatever this creature was already carrying when it arrived. AFTER
    // the phase is `alive` and the clump exists, because that is exactly what
    // `seat` refuses without.
    drainPendingSticks(slot);
    // The hidden life: seed from the slot id, personality from the audience
    // answer (null → mild seeded variation).
    const seed = behaviorSeed(slot.id);
    slot.agent = new BehaviorAgent(seed, personalityFromChoice(slot.personalityChoice, seed));
    // The WALK multiplier, not the rolling one: the wander is a walk
    // wherever it happens (see `walkMult`) — times this creature's own mass
    // penalty, which is 1 until it picks something up and is refreshed every
    // frame by `growPass`.
    slot.agent.setSpeedMultiplier(walkMult() * massSpeedFactor(massMultOf(slot)));
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
   * IS THIS PAGE THE ONE DECIDING — and it is not the same question as
   * "does this page hold rapier bodies" (2026-09-16, the slow-network work).
   *
   * It used to be. Every gate below read `bodiesOf() !== null`, which was a
   * sound proxy while the bodies arrived on exactly the page that was
   * elected host and on no other (docs/PLAN.md §7.6). A HANDSET now never
   * loads rapier at all — 2.06 mb of wasm-bearing javascript that a phone on
   * a slow link cannot afford (`WorldHandles.physicsExpected`) — and a phone
   * alone in a room still wins its own election and still has to run the
   * game. So the two questions came apart:
   *
   *   `rapierOwns()`  — are there rigid bodies, i.e. does the solver own the
   *     stones and the debris? Only where a real question about rapier is
   *     being asked: dropping `rock` out of the pure resolve's collider set,
   *     because a stone the solver has rolled away is no longer where its
   *     footprint circle says.
   *
   *   `deciding()` — is this page the authority for what is stuck, loose and
   *     settled? True on a page holding bodies, and true on a page where
   *     they are never coming. `physicsExpected` is absent on a stub world,
   *     and absent means "yes, expected" — so every existing test and every
   *     projection reads exactly the condition it did before.
   */
  const rapierOwns = (): boolean => bodiesOf() !== null;
  const physicsExpected = (): boolean => world.physicsExpected?.() ?? true;
  const deciding = (): boolean => rapierOwns() || !physicsExpected();
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
   * Scratch for the rider's upright counter-rotation (`growPass`) — its own,
   * not `scratchQ`, because that one is the sticky pass's and this runs in a
   * different pass over the same frame.
   */
  const riderQ = new Quaternion();
  const riderEuler = new Euler();

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
    const scatter = (
      world as {
        scatter?: {
          hideTaken?(keys: ReadonlySet<string>): void;
          setTaken?(keys: ReadonlySet<string>): void;
        };
      }
    ).scatter;
    const hide = scatter?.hideTaken ?? scatter?.setTaken;
    if (!hide || !scatter) return;
    viewerTaken.add(key);
    // The incremental filter where the scatter offers it: a viewer applying a
    // room's worth of `stick` events would otherwise re-lay every
    // InstancedMesh in the world once per event (docs/PLAN.md §7.6).
    hide.call(scatter, new Set(viewerTaken));
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
        return {
          scale: ref.scale,
          r: ref.radius,
          rotY: ref.placement?.rotY ?? 0,
        };
      }
    }
    return null;
  }

  /** `creature:<id>` → the slot, if it is one and it exists. */
  function passengerOf(item: string): Slot | null {
    if (!item.startsWith('creature:')) return null;
    return slots.get(item.slice('creature:'.length)) ?? null;
  }

  /** Scratch for `effectiveDrive` — one per manager, never per frame. */
  const driveSum = { x: 0, z: 0 };

  /** Sum one slot's own push and every passenger's, transitively. */
  function addDrive(slot: Slot, depth: number): void {
    const push = slot.drive;
    if (push && push.mag > 0) {
      driveSum.x += push.x;
      driveSum.z += push.z;
    }
    // A pile can be a pile of piles. The depth guard is belt and braces: a
    // cycle is already impossible (a creature carrying its own carrier is
    // refused where the pile is built), and MAX_POPULATION bounds the rest.
    if (depth >= 8) return;
    for (const id of slot.passengers) {
      const rider = slots.get(id);
      if (rider) addDrive(rider, depth + 1);
    }
  }

  /**
   * WHAT THIS CREATURE IS BEING ASKED TO DO — its own stick plus every
   * passenger's (2026-09-16, the stuck report).
   *
   * > User ruling: the player's character has priority and must always answer
   * > its own phone.
   *
   * A carried creature has no locomotion of its own: its position is a seat
   * on somebody's pile. Its drive used to be thrown away with it, so the
   * moment a bigger creature picked you up your stick did nothing — the
   * report's *"my character got stuck."* Now it is applied to the CARRIER, so
   * every phone in a pile still steers the ball and a pile that four people
   * are pushing goes where the four of them agree.
   *
   * The vectors add (each already carries its own strength) and the SUM is
   * clamped to one stick's worth: four thumbs pushing the same way is not
   * four times the speed, it is a full push, and the ceiling stays the
   * ceiling. Two pushing opposite ways cancel, which is the honest answer.
   *
   * Nothing about this is on the wire. A recorded `drive` still names the
   * passenger (src/session/recorder.ts) and the resolution happens HERE, on
   * the frame it is applied — so the host and a replay of the same log reach
   * the same velocity from the same events.
   */
  function effectiveDrive(slot: Slot): { x: number; z: number; mag: number } | null {
    driveSum.x = 0;
    driveSum.z = 0;
    addDrive(slot, 0);
    const mag = Math.hypot(driveSum.x, driveSum.z);
    if (!(mag > 0)) return null;
    // Clamp the MAGNITUDE and keep the direction: scaling each component by
    // the same factor is what makes this a clamp rather than a squash.
    const k = mag > 1 ? 1 / mag : 1;
    return { x: driveSum.x * k, z: driveSum.z * k, mag: Math.min(1, mag) };
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
  /**
   * Apply the sticks that were waiting for this creature, in the order they
   * arrived, and forget them.
   *
   * They are seated with NO SLIDE: nothing arrived just now — the world
   * already looks like this, and a pile that slid in from the middle on the
   * frame a late page finished loading would be an animation about the
   * loading rather than about the game (the same reason `applyStick` off a
   * restored log seats without a `from`).
   */
  function drainPendingSticks(slot: Slot): void {
    const waiting = pendingSticks.get(slot.id);
    if (!waiting) return;
    pendingSticks.delete(slot.id);
    for (const record of waiting) seat(slot, record, { slide: false });
  }

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
      /*
       * ITS DRIVE IS KEPT, and that is the 2026-09-16 fix (the stuck
       * report). Clearing it here was half of *"my character got stuck"*:
       * the phone went on publishing an intent that the manager dropped on
       * the floor for as long as the pile held it. The push now reaches the
       * carrier instead (`effectiveDrive`), so a passenger's thumb steers the
       * ball it is riding.
       */
      world.shadows.removeShadow(`char-${rider.id}`);
      rider.characterShadow = null;
      // Its own pile's stamps go with it: what it was carrying is inside the
      // carrier's silhouette now.
      clearPileShadows(rider);
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
        // A passenger is drawn at ITS OWN growth, read live — the pile
        // counters the carrier's root scale for everything stuck to it
        // (clump.ts `localScaleOf`), and a creature is not a prop with a
        // fixed `scale`.
        worldScale: () => rider.clump?.growth() ?? 1,
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
      /*
       * THE RECORD'S RADIUS FIRST (2026-09-17, the sticking report). The
       * instance row is the host's own answer and is gone by the time a
       * viewer applies the event; `scale` was never a radius at all, it is
       * the last resort for a log that predates the field.
       */
      r: record.r ?? measured?.r ?? scale,
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
      world as {
        ink?: {
          setCracks?(
            marks: readonly {
              x: number;
              z: number;
              r: number;
              seed: number;
              y?: number;
            }[],
          ): void;
        };
      }
    ).ink;
    if (!ink?.setCracks) return;
    const marks: {
      x: number;
      z: number;
      r: number;
      seed: number;
      y: number;
    }[] = [];
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
    hint?: {
      kind: PropKind;
      variant: number;
      scale: number;
      x: number;
      z: number;
      rotY: number;
    },
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
    const q = {
      x: 0,
      y: Math.sin(state.rotY / 2),
      z: 0,
      w: Math.cos(state.rotY / 2),
    };
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
        if (!slot) return flags;
        const own = aSlot === undefined ? c2 : c1;
        const other = aSlot === undefined ? c1 : c2;
        const item = bodies.itemByCollider(other);
        if (item) return item.r <= carryLimit(slot.bodyR) ? null : flags;
        /*
         * A STUCK ITEM IS PART OF THE CARRIER'S BODY (user ruling,
         * 2026-09-16, with the third stuck report).
         *
         * Its ball only exists so the pile can sweep through what is LOOSE —
         * stones, fallen props, debris, other creatures. Against static world
         * geometry it has nothing to say: a bench hanging off a ball cannot
         * push a fixed cylinder or the heightfield (the carrier's body is
         * kinematic, so no contact there can move anything), and what those
         * contacts CAN do is fire the impact seam from a ball that is
         * scraping the ground — damage and drops charged to a creature for
         * standing still. The loose case is handled a few lines up, where
         * `itemByCollider` found something; reaching here with a stuck
         * item's collider means the other side is the ground or a planted
         * prop, so there is no pair.
         *
         * The carrier's own ball keeps every one of those contacts: that is
         * `hitRooted`, the recoil, the break ladder and the staged damage,
         * and it is the same rule it always was.
         */
        const isStuckItem = own !== slot.kinematic?.ball?.handle;
        if (isStuckItem) return null;
        /*
         * A STANDING PROP THE BALL IS BIG ENOUGH TO ROLL UP — no contact
         * either (2026-09-16 ruling: *"it shouldn't impede the character from
         * moving unless the mass isn't big enough to overtake the object"*).
         *
         * The creature's stand-in is kinematic, so a fixed cylinder was never
         * going to push it; what the contact DOES do is fire the impact seam,
         * which would flinch the prop's recoil and knock it loose — a `loose`
         * event and a round trip through the ground for something the pickup
         * pass is about to take whole. Filtering the pair out is what keeps
         * uprooting free.
         *
         * A stuck item's collider is in `colliderSlot` too, and it has
         * already been answered above: it meets what is loose and nothing
         * else.
         */
        const side = bodies.sideByCollider(other);
        if (!side?.rooted) return flags;
        // `passLimit`, matching the resolve's own `skipIf`: a prop the ball
        // pushes past is reported by the pure resolve's gather instead, so a
        // contact here would be the same impact counted twice.
        return side.r <= passLimit(slot.bodyR) ? null : flags;
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
    /*
     * THE BALL STANDS IN WHERE THE BALL IS DRAWN — ground, plus this frame's
     * clearance, plus the radius (2026-09-16, with the ground-clearance
     * report). The stand-in's centre is the drawn ball's centre, which is
     * `root.y + bodyR`; leaving the lift out of it put the collider up to a
     * whole clearance below the sphere on screen, so a ball riding over a
     * terrace edge would have been picking things up with a body partly
     * inside the heightfield while the visible one cleared it. The stuck
     * items' colliders hang off this body at offsets from its translation, so
     * they come along with it.
     *
     * Not read off `root.position.y`, deliberately: a HATCHING root is being
     * animated up out of the ground and `slot.hatch` holds that Y (the ground
     * pass stands off while it runs), and the stand-in wants the ground it is
     * rising to rather than a body sinking under the field for a second.
     */
    /*
     * …AND THE FLOAT, for the same reason the clearance is in here
     * (2026-09-17, zero gravity): the stand-in's centre is the DRAWN ball's
     * centre, and a floating ball whose collider stayed on the ground would
     * be picking things up with a body several metres under the sphere on
     * screen. 0 with the world's gravity on.
     */
    const standR = solidR(slot);
    const y =
      surface.sampleHeight(root.position.x, root.position.z) + slot.lift + slot.float + standR;
    if (!slot.kinematic) {
      const body = physics.addRigidBody(
        rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
          root.position.x,
          y,
          root.position.z,
        ),
        rapier.ColliderDesc.ball(Math.max(0.05, standR))
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
          r: standR,
          x: root.position.x,
          z: root.position.z,
          rooted: false,
        };
        slot.kinematic.sides.set(ball.handle, side);
        bodiesOf()?.registerForeign(ball.handle, side);
      }
      return;
    }
    slot.kinematic.body.setNextKinematicTranslation({
      x: root.position.x,
      y,
      z: root.position.z,
    });
    // The ball grows with the pile: a creature the size of a house that
    // still shouldered stones aside on its drawn radius would read as a
    // creature walking through the world rather than into it.
    slot.kinematic.ball?.setRadius(Math.max(0.05, standR));
    const ballHandle = slot.kinematic.ball?.handle;
    const ballSide = ballHandle === undefined ? undefined : slot.kinematic.sides.get(ballHandle);
    if (ballSide) {
      // The registration is by reference, so keeping it truthful is three
      // writes rather than a re-register.
      ballSide.r = standR;
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
  /** Reused by `syncStuckColliders` — one carrier is seated at a time. */
  const stuckWanted: StuckItem[] = [];
  const stuckKeep = new Set<string>();

  function syncStuckColliders(slot: Slot): void {
    const handle = slot.kinematic;
    const clump = slot.clump;
    if (!handle || !clump) return;
    /*
     * CARRYING NOTHING, AND HAVING CARRIED NOTHING — the common case, and it
     * used to cost four allocations a creature a frame to find out: a spread
     * of the item map, a sort, a slice and a Set. At 200 creatures that is
     * eight hundred garbage objects a frame to seat no colliders at all.
     */
    if (clump.items.size === 0 && handle.stuck.size === 0) return;
    const physics = world.physics?.() ?? null;
    if (!physics) return;
    const rapier = physics.rapier;
    const wanted = stuckWanted;
    wanted.length = 0;
    for (const item of clump.items.values()) wanted.push(item);
    wanted.sort((a, b) => {
      const da = a.offset.x ** 2 + a.offset.y ** 2 + a.offset.z ** 2;
      const db = b.offset.x ** 2 + b.offset.y ** 2 + b.offset.z ** 2;
      // Deterministic: distance, then key, so two frames agree and the set
      // does not flicker under a tie.
      return db - da || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    if (wanted.length > STUCK_COLLIDERS_MAX) wanted.length = STUCK_COLLIDERS_MAX;
    const keep = stuckKeep;
    keep.clear();
    for (const item of wanted) keep.add(item.key);
    const bodies = bodiesOf();
    for (const [key, collider] of handle.stuck) {
      if (keep.has(key)) continue;
      colliderSlot.delete(collider.handle);
      bodies?.unregisterForeign(collider.handle);
      handle.sides.delete(collider.handle);
      physics.world.removeCollider(collider, false);
      handle.stuck.delete(key);
    }
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
      /*
       * The clump's own rotation, applied to the seat: the pile rolls, so the
       * bench is somewhere different every frame.
       *
       * THE SEAT AND THE RADIUS ARE THE DRAWN ONES (2026-09-17, with the
       * packing). `clump.seats()` is already in world units — the packed
       * distance from the pile's centre — so there is no growth to multiply
       * back in, and an item is drawn at its OWN size (`localScaleOf` divides
       * the root's growth out of it, the 2026-09-16 ruling), so the ball that
       * stands in for it is `item.r` and not `item.r × growth`. The two used
       * to disagree: a stuck bench swept a circle `growth` times wider than
       * the bench anybody could see.
       */
      const seat = clump.seatOf(item.key);
      scratchVec.set(seat?.x ?? 0, seat?.y ?? 0, seat?.z ?? 0);
      scratchVec.applyQuaternion(clump.worldQ);
      // Plus the clump group's own lift off the creature's middle.
      collider.setTranslationWrtParent({
        x: scratchVec.x,
        y: scratchVec.y,
        z: scratchVec.z,
      });
      collider.setRadius(Math.max(0.05, item.r));
      const side = handle.sides.get(collider.handle);
      if (side) {
        side.r = item.r;
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
   * Where a loose body IS, as seven plain numbers.
   *
   * Read off rapier and copied, because the body it came from does not
   * survive the pickup — see `stickItem`.
   */
  interface ItemPose {
    x: number;
    y: number;
    z: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
  }

  /** Snapshot a loose body's live transform. Must be called while the body
   * is still IN the solver. */
  function poseOf(item: LooseItem): ItemPose {
    const t = item.body.translation();
    const r = item.body.rotation();
    return { x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w };
  }

  /**
   * Decide one pickup and tell the room.
   *
   * The offset and rotation come out of the item's LIVE transform — where the
   * stone actually is at the instant of contact, not where its placement was
   * — which is what makes the pile look assembled by running into things.
   *
   * THE POSE IS HANDED IN, AND THAT IS NOT A STYLE CHOICE (2026-09-16, the
   * second stuck report). The caller has to drop the body first — `take`
   * removes it from the solver and hides the placement, so the mesh the clump
   * then holds is the only copy of the thing — and a rapier body that has
   * been removed is a DEAD HANDLE: reading its translation traps the wasm
   * (`RuntimeError: unreachable`). That throw came out of `update()`, so the
   * host's whole frame loop died the first time any creature rolled over a
   * loose stone: no more poses, every phone's creature frozen where it stood,
   * which is exactly what *"my character got stuck"* looks like from a
   * handset. The snapshot is taken while the body is alive and nothing here
   * touches rapier at all.
   */
  function stickItem(carrier: Slot, item: LooseItem, root: Group, pose: ItemPose): void {
    const clump = carrier.clump;
    if (!clump) return;
    const t = pose;
    const r = { x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw };
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
      selfR: carrier.baseR,
      seats: carrier.clump?.seats() ?? [],
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
      r: item.r,
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
      selfR: carrier.baseR,
      seats: carrier.clump?.seats() ?? [],
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

  /**
   * LET EVERY CARRIED CREATURE GO, once, on the page that decides.
   *
   * `CREATURES_EAT_CREATURES` is off (see the constant), but a room that was
   * running before the flag flipped — or a log being restored — can still
   * hold a creature on somebody's pile, and the person whose creature it is
   * would find their stick steering the carrier forever. So the deciding
   * page releases them, through the SAME `unseat` + `drop` event a knocked-off
   * prop goes through, so every screen agrees and nothing about the wire is
   * special-cased.
   *
   * Cheap: a `creature:` key is the only thing it looks for, and the walk is
   * over a carrier's own passengers, which is almost always none.
   */
  function releaseCarriedCreatures(): void {
    if (CREATURES_EAT_CREATURES) return;
    for (const slot of slots.values()) {
      if (slot.passengers.size === 0) continue;
      for (const rider of [...slot.passengers.keys()]) {
        const stuck = slot.clump?.items.get(`creature:${rider}`);
        if (!stuck) continue;
        stuck.object.getWorldPosition(scratchVec);
        stuck.object.getWorldQuaternion(scratchQ);
        const x = scratchVec.x;
        const z = scratchVec.z;
        const q = { x: scratchQ.x, y: scratchQ.y, z: scratchQ.z, w: scratchQ.w };
        if (!unseat(slot, stuck.key, x, z, q)) continue;
        observer?.drop({
          id: slot.id,
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
   * A ROOTED PROP THE BALL IS BIG ENOUGH TO ROLL UP — out of the ground and
   * onto the pile, in one step.
   *
   * > User ruling, 2026-09-16: *"The user's character has priority; objects
   * > should stick to it as it moves or rolls over the object. It shouldn't
   * > impede the character from moving unless the mass isn't big enough to
   * > overtake the object."*
   *
   * NO `loose` ROUND TRIP, and that is the change. The old path for anything
   * planted was: clear `breakStrength` → `loosen` (fixed body out, dynamic
   * hull body in) → a `loose` event → wait for the pickup pass to find it in
   * `items()` next frame → a `stick` event. For a bush the ball has just
   * driven over that is two events, two frames and an impact threshold to
   * describe one thing that happened. Here the placement is taken, the mesh
   * is drawn at the pose it was standing in, and it is seated — ONE `stick`,
   * and uprooting costs nothing.
   *
   * It is also why the resolve skips these colliders (`skipIf` below): a prop
   * that ends up on the pile must not have stopped the creature on the way
   * in, or the ruling reads backwards.
   *
   * The seat is computed exactly as `stickItem` computes one, off the
   * placement's own pose instead of a live rapier transform — the prop was
   * standing still, so where it stood IS where it was at the moment of
   * contact.
   */
  function uprootOntoPile(slot: Slot, root: Group, collider: Collider): boolean {
    const clump = slot.clump;
    const key = collider.key;
    const kind = collider.kind as PropKind | undefined;
    if (!clump || key === undefined || kind === undefined) return false;
    if (clump.items.has(key)) return false;
    const parsed = parseItemKey(key);
    // Measured BEFORE anything hides the placement — the instance row is the
    // only thing that knows what scale and yaw it was drawn at.
    const measured = placementDrawn(key, kind);
    const variant = parsed?.variant ?? 0;
    const scale = measured?.scale ?? 1;
    const itemR = measured?.r ?? collider.r;
    // Its centre, not its base: the ground under it through the one seam,
    // plus its own radius (PLAN §7.2 — no height is derived anywhere else).
    const itemY = surface.sampleHeight(collider.x, collider.z) + itemR;
    clump.group.getWorldPosition(scratchVec);
    const offset = clumpLocalOffset({
      itemX: collider.x,
      itemY,
      itemZ: collider.z,
      centreX: scratchVec.x,
      centreY: scratchVec.y,
      centreZ: scratchVec.z,
      headingX: Math.sin(root.rotation.y),
      headingZ: Math.cos(root.rotation.y),
      selfR: slot.baseR,
      seats: slot.clump?.seats() ?? [],
      itemR,
      clumpWorldQ: clump.worldQ,
      growth: clump.growth(),
    });
    scratchQ.setFromAxisAngle(UP, measured?.rotY ?? 0);
    const rotation = clumpLocalRotation(scratchQ, clump.worldQ);
    const record: StickRecord = {
      id: slot.id,
      item: key,
      kind,
      variant,
      scale,
      r: itemR,
      ox: offset.x,
      oy: offset.y,
      oz: offset.z,
      qx: rotation.x,
      qy: rotation.y,
      qz: rotation.z,
      qw: rotation.w,
    };
    // The mesh goes where the prop was STANDING first, so the entrance slide
    // is the short travel from its hole to its seat rather than a flight from
    // the origin. `show` is idempotent, so the `seat` below finds this one.
    if (looseMeshes) {
      looseMeshes.show(key, kind, variant, scale);
      looseMeshes.move(key, collider.x, itemY, collider.z, scratchQ);
    }
    // `seat` hides the placement through the one owner, which on the host
    // drops the fixed cylinder too (`PropBodies.take`).
    if (!seat(slot, record, { slide: true })) return false;
    observer?.stick(record);
    return true;
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
    /**
     * NULL ON A PAGE WITH NO SOLVER (2026-09-16) — a phone host
     * (`WorldHandles.physicsExpected`). The verdict, the break ladder and the
     * staged damage are all this function's own arithmetic and need nothing;
     * what the bodies are for is the RECOIL spring and handing a loosened
     * prop to rapier, and both of those stand down. A knocked prop then lies
     * down where it stood rather than rolling — see the two `bodies?.` below.
     */
    bodies: PropBodies | null,
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
    // …where there is a spring to bend. On a page with no solver the props
    // have no bend springs, so the flinch is simply not there.
    bodies?.bump(prop.key, dirX, dirZ, Math.min(1, impact / 6));
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
      /*
       * WITH A SOLVER, `loosen` hands the prop to rapier and answers where
       * it now is. WITHOUT one (a phone host) there is nothing to hand it
       * to, so the prop is let go where it STOOD: the placement is hidden,
       * the loose mesh is drawn on the spot, and the `loose` event says the
       * same thing it always said — the decision is the event, and every
       * other page draws it identically (docs/PLAN.md §7.6). What is missing
       * is the roll away, which is the one thing a rigid body was for.
       */
      const item = bodies
        ? bodies.loosen(prop.key)
        : { x: prop.x, z: prop.z, scale: placementDrawn(prop.key, prop.kind)?.scale ?? 1 };
      if (item) {
        if (!bodies) hidePlacement(prop.key);
        showLoose(prop.key, item.x, item.z, item.scale);
        // …and the SCALE goes with it (2026-09-17). This page has the
        // instance row and the body it just made; nobody else does, and
        // there is nothing in the world for them to re-derive it from.
        observer?.loose(prop.key, item.x, item.z, item.scale);
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
          {
            key: other.key,
            kind: other.kind as PropKind,
            r: other.r,
            x: other.x,
            z: other.z,
          },
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
      {
        key: rooted.key,
        kind: rooted.kind as PropKind,
        r: rooted.r,
        x: rooted.x,
        z: rooted.z,
      },
      impactOf(speed, item.r),
      item.r,
      rooted.x - item.x,
      rooted.z - item.z,
    );
  }

  /**
   * THE LOOSE THINGS RAPIER IS CARRYING, and whoever rolls over one — what
   * was section 3 of `simulateSticky`, lifted out whole (2026-09-16) so the
   * pass can run on a page with no solver at all.
   *
   * Takes the bodies as an argument rather than reading `bodiesOf()`: the
   * caller has already established there are some, and a second read could
   * answer differently.
   */
  function pickUpLoose(bodies: PropBodies): void {
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
       * THE MASS AS IT IS DRAWN — what a person can see touching the thing.
       *
       * > User report, 2026-09-18: *"objects are still being drawn towards
       * > the creature instead of sticking to the creature after it rolls
       * > over it."*
       *
       * This was `slot.bodyR`, the accumulated VOLUME (`baseR × growth`),
       * which is the game's size and runs well ahead of the packed pile — 7.1
       * u against a packed 4.6 at fifteen props, and further apart since the
       * objects interlock. So a creature grabbed stones a couple of metres
       * outside anything on screen and they then SLID IN to their seat: the
       * pile looked like it was sucking props toward it rather than picking up
       * what it rolled over. The slide is right (a hard cut is forbidden, TASTE
       * §2.1) — the distance it had to cover was not.
       *
       * The honest reach is the silhouette: the creature's own drawn radius,
       * or the pile's footprint once there is one, whichever is wider — the
       * same pair the corner's live view frames by and the phone's camera
       * follows. `carryLimit` still reads `bodyR`, because WHAT a ball can
       * pick up is its mass (the 2026-09-17 ask) and WHERE it can reach from
       * is its silhouette; they were one number by accident.
       *
       * Nothing wedges on the way in: a carriable prop is dropped from the
       * resolve's collider set entirely (`skipIf`, the `carryLimit` branch
       * above), so the creature rolls up to it and then over it.
       */
      const reach = solidR(slot);
      const nearIdx = itemGrid.near(root.position.x, root.position.z, reach + itemGrid.cellSize);
      for (let k = 0; k < nearIdx.length; k++) {
        const item = itemList[nearIdx[k]!];
        if (!item) continue;
        const props = stickyFor(item.kind, item.variant);
        const point = itemPoints[nearIdx[k]!]!;
        const d = Math.hypot(point.x - root.position.x, point.z - root.position.z);
        /*
         * CONTACT, not proximity (user report, 2026-09-18: *"they should only
         * get added to the ball after the creature has rolled over the
         * objects. It shouldn't be sucked in like a vacuum"*).
         *
         * `item.r` is the prop's BOUNDING radius and a prop is mostly air
         * inside its own sphere, so a test against the whole of it fires
         * while the two are still visibly apart — the creature's side of that
         * sum was cut to the silhouette in 75c9e6c and this is the prop's
         * side (`TOUCH_FIT`, src/creatures/sticky.ts). `CONTACT_PAD` stays,
         * because nothing in this world is ever exactly touching: every
         * solver here holds a skin.
         */
        if (d > reach + item.r * TOUCH_FIT + CONTACT_PAD) continue;
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
        // THE POSE BEFORE THE TAKE. `take` drops the rigid body, and a
        // dropped rapier body is a dead handle whose translation traps the
        // wasm — which took the host's whole frame loop with it the first
        // time anybody rolled up a stone (see `stickItem`).
        const pose = poseOf(item);
        // `take` next: it hides the placement too, so the mesh the clump
        // then holds is the only copy of the thing.
        if (!bodies.take(item.key)) continue;
        stickItem(slot, item, root, pose);
      }
    }
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
    /*
     * THE BODIES ARE OPTIONAL HERE (2026-09-16, the slow-network work).
     *
     * This used to open with `if (!bodies) return`, which was the same proxy
     * `deciding()` replaced: no bodies meant not the host. A PHONE HOST has
     * no bodies and is the host, so the pass runs either way and the three
     * things that genuinely need rapier are the ones that stand down:
     *
     *   `ensureHooks` / `ensureSettle` / `ensureImpact` already return on a
     *     null `bodiesOf()` — they wire rapier's own callbacks and there are
     *     none to wire.
     *   the RECOIL and the LOOSEN inside `hitRooted` — a bend spring and a
     *     rigid body to hand the prop to. Without them a knocked prop lies
     *     down where it stood instead of rolling, which is the one thing a
     *     phone host visibly does not do.
     *   section 3 below, the pickups off `bodies.items()` — the loose things
     *     rapier is carrying. A page with no solver has no loose items on
     *     the ground; what it picks up comes through the CONTACTS in section
     *     4, which is the pure resolve and needs nothing.
     */
    const bodies = bodiesOf();
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
        /*
         * SIZE FIRST — the character has priority (`decideContact`, 2026-09-16).
         *
         * A planted thing inside this creature's carry limit is not an
         * obstacle at all: it comes up and goes on the pile, with no impact
         * threshold and no `loose` on the way. Only what it cannot carry
         * reaches `hitRooted`, which is where the recoil, the break ladder
         * and the staged damage all still live, unchanged.
         */
        const verdict = decideContact({
          itemR: report.collider.r,
          rooted: true,
          props,
          impact,
          carrierR: report.slot.bodyR,
        });
        const root = report.slot.characterRoot;
        if (verdict === 'stick' && root) {
          uprootOntoPile(report.slot, root, report.collider);
        } else {
          hitRooted(
            bodies,
            {
              key,
              kind,
              r: report.collider.r,
              x: report.collider.x,
              z: report.collider.z,
            },
            impact,
            report.slot.bodyR,
            -report.nx,
            -report.nz,
          );
        }
      } else if (bodies === null) {
        /*
         * AN UNROOTED PROP, ON A PAGE WITH NO SOLVER (2026-09-16).
         *
         * Where rapier is running, everything unrooted is already a dynamic
         * body and is picked up in section 3 off `bodies.items()`: the
         * footprint circle is dropped out of the resolve (`skipKind: 'rock'`)
         * precisely because the solver has moved the thing. A phone host has
         * neither, so a stone stands where it was placed, IS in the resolve's
         * collider set, and reports a contact here like anything else —
         * which is the whole route it has to being picked up.
         *
         * Same verdict function, same carry limit, same `stick` event: what
         * changes is only which pass noticed the stone. `rooted: false` is
         * the honest input, and `decideContact` answers `stick` for anything
         * inside the limit with no impact threshold to clear — a stone is
         * junk on the ground (src/creatures/sticky.ts).
         */
        const verdict = decideContact({
          itemR: report.collider.r,
          rooted: false,
          props,
          impact,
          carrierR: report.slot.bodyR,
        });
        const root = report.slot.characterRoot;
        if (verdict === 'stick' && root) uprootOntoPile(report.slot, root, report.collider);
      }
      // ── 6. and whether it knocked something off ──────────────────────────
      const stuck = report.slot.clump?.outermost();
      if (stuck && shouldDrop({ ...props, attachmentStrength: attachmentOf(stuck) }, impact)) {
        dropOutermost(report.slot, nowMs);
      }
    }
    contacts.length = 0;

    // ── 3. pickups ─────────────────────────────────────────────────────────
    // …of the LOOSE things, which only exist where rapier is carrying them.
    // A page with no solver picked its props up in section 4, above, and
    // still runs section 5 below — a creature carrying a creature is this
    // module's own rule and has never needed a rigid body.
    if (bodies !== null) pickUpLoose(bodies);

    // ── 5. creature onto creature ──────────────────────────────────────────
    /*
     * `aliveScratch` is sorted by slot id (the resolve pass needs it to be),
     * so a fixed i < j walk is deterministic: the same two creatures meeting
     * on two different pages reach the same verdict about which one is
     * carrying which. Symmetric in the sense that matters — whichever is
     * BIGGER does the carrying, whichever order they are visited in.
     */
    // Off by user ruling (`CREATURES_EAT_CREATURES`): a person's creature is
    // not another person's prop, and a carried one's stick steers its carrier.
    for (let i = 0; CREATURES_EAT_CREATURES && i < aliveScratch.length; i++) {
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
        /*
         * A CREATURE NEEDS A CLEAR SIZE GAP, not a tie
         * (`CREATURE_CARRY_RATIO`, 2026-09-16 — the stuck report).
         *
         * `carryLimit` decides a PROP and is 1.0 of the carrier's radius; a
         * creature is somebody's, with a phone in somebody's hand, so it
         * takes a third again the size before it can be taken out of their
         * control. Both cannot be true at once — `a ≥ 1.35 b` and
         * `b ≥ 1.35 a` have no solution — so there is no mutual-eligibility
         * tie here any more and nothing for two pages to disagree about.
         * Equal-sized creatures fall through to the pair separation they had
         * before the katamari, and both keep answering their own sticks.
         */
        const aTakesB = b.slot.bodyR <= creatureCarryLimit(a.slot.bodyR);
        const bTakesA = a.slot.bodyR <= creatureCarryLimit(b.slot.bodyR);
        if (aTakesB) stickCreature(a.slot, b.slot, a.root);
        else if (bTakesA) stickCreature(b.slot, a.slot, b.root);
      }
    }

  }

  /**
   * THE STAND-INS — every carrier's kinematic body and the balls for what it
   * is carrying, at the size and place it ends the frame at.
   *
   * Called AFTER `growPass` and not at the end of `simulateSticky`, which is
   * where it used to live (2026-09-16). Growth is written in `growPass`, so a
   * creature that picked something up this frame had its `bodyR` and its
   * drawn scale updated a few lines after its rapier ball was sized — and the
   * solver spent a frame holding a ball smaller than the circle the resolve
   * was using. One radius, one frame, everywhere: the resolve circle, the
   * exclusion radius, the drawn scale and the ball are all this `bodyR`, so
   * there is no gap between two sizes for a creature to wedge in.
   */
  function syncStandIns(): void {
    for (const slot of slots.values()) {
      const root = slot.characterRoot;
      if (!root || slot.phase !== 'alive' || slot.carriedBy) continue;
      syncKinematic(slot, root);
      syncStuckColliders(slot);
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
  /**
   * THE PILE RESTS ON THE PAPER — how far above the ground under its centre
   * this creature's root is held this frame.
   *
   * > User report, 2026-09-16: *"the ball is glitching through the map floor
   * > if it's big enough."*
   *
   * > And then, 2026-09-17: *"now the characters are floating. their origin
   * > should match the ground plane; they should not be floating in mid air."*
   *
   * A creature is placed on the height under its CENTRE, which is the whole
   * of the Surface seam (PLAN §7.2) and is exactly right for a 0.9 u
   * hatchling. A pile is a different shape of problem, and since the items
   * were packed onto the character (2026-09-17, *"the character should be the
   * object that the items stick to"*) it is TWO — and each half takes the
   * measurement that is ACTUALLY ITS QUESTION, which is the whole of the
   * second report above:
   *
   *   - THE SIT is the pile's own LOWEST POINT, `clump.floor()` — world units
   *     above the creature's feet, negative when there is mass below them.
   *     The root goes up by exactly what is underneath it and by nothing
   *     else, so a creature with three benches beside it and nothing under it
   *     stands on the paper. The radial `reach()` was the wrong number for
   *     this and is what put the creatures in the air: the items pack along
   *     the directions they were struck from, so a sideways pile reaches
   *     several units and has its lowest point at the creature's feet, and
   *     sitting it up by the reach held it over a gap;
   *   - THE RISE is the ground under its FOOTPRINT, `clump.footprint()` —
   *     also a horizontal question, and so a horizontal answer: on a slope, a
   *     terrace riser or a basin lip the ground under the uphill edge of the
   *     mass is above the ground under its middle, so the footprint is
   *     sampled (the centre and a ring of `CLEARANCE_POINTS`,
   *     `src/creatures/sticky.ts`) and the root rides up on the highest
   *     ground under it. `footprintRise` and not `clearanceLift`, because the
   *     pad in the latter is a fraction of a radius and this pass no longer
   *     has a radius in it.
   *
   * NEITHER READS `bodyR`. That is the accumulated volume, which is the
   * game's size (the readout, the pickup reach, the resolve circle) and is
   * bigger than the packed pile — a ring sampled at `bodyR × CLEARANCE_RING`
   * would be feeling the terrain a couple of metres outside anything a person
   * can see. What has to rest on the paper is the silhouette.
   *
   * THE SAMPLE IS THE ONLY NEW COST AND ONLY A PILE PAYS IT: an empty pile's
   * footprint is exactly 0, so a creature carrying nothing takes the early
   * return and gets the placement it shipped with, to the float.
   *
   * WHERE IT IS APPLIED: the frame's one ground pass, on top of the height it
   * already sampled. Not a second Y writer and not in the locomotion pass —
   * x/z and the resolve are untouched by it, and a viewer easing toward a
   * host pose gets the same lift on top of the same sampled ground, because
   * both pages derive it here rather than either being told.
   *
   * Both are this frame's — they are properties of the seats, which only a
   * pickup changes, so there is no growth-ordering question in either
   * (unlike `bodyR`, which `growPass` writes after this pass runs).
   */
  function groundClearance(slot: Slot, dt: number): number {
    const spring = slot.liftSpring;
    const root = slot.characterRoot;
    if (!spring || !root) return 0;
    const clump = slot.clump;
    const footprint = clump?.footprint() ?? 0;
    /*
     * THE CREATURE IS ANCHORED TO THE GROUND. A pile never lifts it.
     *
     * > User report, 2026-09-18: *"The character is still floating in Z
     * > space. We should make sure that it is anchored to the surface of the
     * > ground as the mass is rolling. It should not be floating in the
     * > air."*
     *
     * That reverses 3a745f8, which lifted the root by the pile's own lowest
     * point so a ball packed below the equator would not clip into the map.
     * The clipping rule was right and the payer was wrong: the PILE now
     * holds itself up (`Clump.rise`, src/creatures/clump.ts) — the mass rests
     * its underside on the paper, the creature stands on the paper at the
     * middle of it, and every seat keeps the relative position the packer
     * gave it, so the lump is the same lump.
     *
     * What is left here is the terrain ring, which is a different question
     * altogether — not "how big is the mass" but "does the ground under the
     * mass rise", the 2026-09-16 rule that stops a wide pile clipping through
     * a hillside. A radius was never the right measurement for it either:
     * `reach()` is how far the pile stretches in ANY direction, so a creature
     * with three benches beside it was held metres in the air over a gap
     * (2026-09-17, three reports). It is the FOOTPRINT — a horizontal
     * question taking a horizontal answer.
     */
    const target =
      footprint > 0 ? footprintRise(root.position.x, root.position.z, footprint, sampleAt) : 0;
    spring.retarget(target);
    // Clamped at 0 on the way out: a clearance can lift a creature and must
    // never be able to push one INTO the ground, whatever a solver does.
    slot.lift = Math.max(0, spring.update(dt));
    return slot.lift;
  }

  /**
   * ZERO GRAVITY — how far above everything else this creature is floating
   * this frame, and the tumble that goes with it.
   *
   * > User ask, 2026-09-17: *"i want a zero gravity mode where i can hit g on
   * > the keyboard and it turns off gravity for the map. characters should
   * > float in space."*
   *
   * THE SECOND OFFSET ON THE ONE Y WRITE, beside `groundClearance` and for
   * the same reason: the Surface seam owns where the ground is (PLAN §7.2),
   * locomotion never touches Y, and "something other than the ground moved
   * this creature up" belongs in the frame's single ground pass rather than
   * in a second writer. x/z, the resolve and the pure pickup overlap are all
   * untouched — the joystick still drives a floating creature about and it
   * still rolls things up by overlap, which is the fun.
   *
   * DERIVED, NEVER SENT. What travels is one bit on a scene event; the
   * altitude is `floatHeight(behaviorSeed(id))` so every page puts the same
   * creature at the same height, and the bob and the tumble are that page's
   * own clock (src/creatures/gravity.ts). The blend is a ζ ≥ 1 spring, so
   * lift-off slides and the settle back down slides, and because the WHOLE
   * offset is multiplied by it a grounded world is exactly 0 again — the
   * placement that shipped, to the float.
   *
   * The tumble is written HERE rather than returned because it is two more
   * numbers about the same one presentation, and the root's x and z are the
   * only rotations nothing else owns (its y is the heading).
   */
  function floatLift(slot: Slot, dt: number, nowMs: number): number {
    const spring = slot.floatSpring;
    const root = slot.characterRoot;
    if (!spring || !root) return 0;
    spring.retarget(zeroGravity ? 1 : 0);
    const blend = Math.min(1, Math.max(0, spring.update(dt)));
    if (blend <= FLOAT_SETTLED) {
      /*
       * Exactly level and exactly on the ground: a world with its gravity on
       * is the world that shipped, to the float, and a residual milliradian
       * of tilt on every creature would be a change nobody asked for. A
       * ζ ≥ 1 spring never actually arrives, so `FLOAT_SETTLED` is where
       * arriving is called arriving (src/creatures/gravity.ts) — a
       * ten-thousandth of the blend, which is 0.0008 world units of height.
       */
      slot.floatBlend = 0;
      slot.float = 0;
      root.rotation.x = 0;
      root.rotation.z = 0;
      return 0;
    }
    slot.floatBlend = blend;
    const seed = behaviorSeed(slot.id);
    const tumble = floatTumble(nowMs, seed);
    root.rotation.x = tumble.x * blend;
    root.rotation.z = tumble.z * blend;
    // The bob rides ON the height, so the ambient drift fades in and out with
    // the blend and nothing arrests at either end (TASTE §3).
    slot.float = Math.max(0, blend * (floatHeight(seed) + floatBob(nowMs, seed)));
    return slot.float;
  }

  function growPass(dt: number): void {
    /*
     * FIRST, GIVE ANY OBJECT THAT ARRIVED BEFORE ITS MODEL ITS GEOMETRY.
     *
     * > User report, 2026-09-18, of a phone showing a 67 m ball with nothing
     * > on it: *"The objects should be showing and it should be sticking to
     * > the character."*
     *
     * The prop library loads after the first frame and the person's own
     * creature, so a `stick` applied before it landed drew an empty mesh —
     * and the placement was already hidden from the scatter, so the object
     * was simply gone. `retryMissing` walks only what is waiting, which is
     * nothing at all once the library is in (src/world/loose.ts).
     */
    looseMeshes?.retryMissing?.();
    for (const slot of slots.values()) {
      const clump = slot.clump;
      const root = slot.characterRoot;
      if (!clump || !root || slot.phase !== 'alive') continue;
      clump.update(dt);
      const g = clump.growth();
      /*
       * A CARRIED creature's root scale is its CARRIER'S to write.
       *
       * The clump counters the carrier's growth on everything stuck to it
       * (`localScaleOf`, src/creatures/clump.ts) and a passenger's root IS
       * one of those objects — so this write, which also ran for a carried
       * slot, put the carrier's growth straight back onto the passenger and
       * whichever of the two passes ran last decided how big somebody else's
       * creature was drawn. That is the 2026-09-17 ask one level up: a
       * character must not grow because it stuck to something.
       *
       * `bodyR` and the blend below are still written for it — they are
       * numbers about its own pile, not about how it is drawn.
       */
      if (!slot.carriedBy) root.scale.setScalar(g);
      slot.bodyR = slot.baseR * g;
      /*
       * AND HOW FAST ITS OWN WANDER IS ALLOWED TO BE (user ask, 2026-09-18:
       * *"when a ball gets big it should move slower"*). The DRIVE ceiling
       * asks `massMultOf` on the frame it is used, but an agent holds its
       * multiplier, so the pass that already reads the growth is the one that
       * refreshes it. Every frame and not on pickup: the slider can move the
       * walk ceiling under it too, and this is one multiply on a number that
       * is already in hand.
       */
      if (katamari) slot.agent?.setSpeedMultiplier(walkMult() * massSpeedFactor(g));
      /*
       * AND WHETHER IT IS A BALL YET — here, because this is the pass that
       * runs on EVERY page (docs/PLAN.md §7.6). The blend is derived from the
       * clump's own item count and growth, both of which a viewer holds off
       * the `stick` and `drop` events, so every screen reaches the same
       * locomotion without a byte on the wire about it.
       */
      const spring = slot.rollSpring;
      if (spring) {
        spring.retarget(rollTarget(clump.items.size, g));
        slot.roll = Math.min(1, Math.max(0, spring.update(dt)));
      }
      /*
       * AND THE CREATURE ITSELF STAYS ITS DRAWN SIZE, at the CENTRE of the
       * pile (user ask, 2026-09-17: *"we should not scale up the characters
       * as they stick to things"*, then the same day: *"I think the creature
       * should be at the center, and then it should just be a giant rolling
       * mass … they should be at the center of the sphere of the objects"*).
       *
       * Three writes on the one node `becomeAlive` built for it, and all of
       * them every frame because they read the growth and the blend, which
       * are springs:
       *
       *   - the SCALE is `1 / growth`, which is `localScaleOf`'s arithmetic
       *     (src/creatures/clump.ts) applied to the creature instead of to a
       *     stone. The root's scale carries the mass — `bodyR`, the resolve
       *     circle, the pickup reach, the shadow stamp below, `positions()`
       *     and the size readout are all still that one write — and this
       *     divides it back out of the one thing that must not grow;
       *   - the HEIGHT is ZERO, and that is the end of a day's worth of
       *     revisions: `2 · baseR · roll` put the creature on the ball's north
       *     pole (*"the objects … sit under the creature"*), `baseR · roll` put
       *     it at the centre of a sphere of radius `bodyR` — and with the items
       *     PACKED onto the character instead of seated on that sphere
       *     (*"the character should be the object that the items stick to"*)
       *     there is no sphere to be at the centre of. The creature stands on
       *     the ground at its drawn size and the pile packs around its middle,
       *     which is where `clump.group` now sits (`baseR` in the world,
       *     src/creatures/clump.ts). So there is nothing to write: the rider's
       *     own origin IS the creature's feet on the paper;
       *   - and it stays UPRIGHT. A creature at the centre of the mass is a
       *     creature that any lean of the ROOT would turn with it — and the
       *     root leans in zero gravity (`floatLift`). So the rider carries the
       *     exact inverse of the root's orientation with the heading put back,
       *     leaving the creature's world rotation the pure yaw it has always
       *     had: the mass tumbles, the thing inside it does not. Skipped
       *     entirely when the root is level, which is every frame of every
       *     world that is not weightless.
       */
      const rider = slot.rider;
      if (rider) {
        /*
         * THE CREATURE IS THE BALL (restored 2026-09-18, user: *"it should
         * look and function like we did when we first started the katamari
         * project where the objects clumped to the character"*). The root's
         * scale IS the growth and the rider passes it straight through, so
         * the drawn creature grows with its pile and the items clump onto
         * its surface — one solid mass, nothing floating, no shell needed.
         * The node stays because the zero-gravity tumble is countered on it.
         */
        rider.scale.setScalar(1 / Math.max(1e-6, g));
        rider.position.y = 0;
        if (root.rotation.x !== 0 || root.rotation.z !== 0) {
          riderEuler.set(0, root.rotation.y, 0);
          riderQ.setFromEuler(riderEuler);
          rider.quaternion.copy(root.quaternion).invert().multiply(riderQ);
        } else if (rider.quaternion.w !== 1) {
          rider.quaternion.identity();
        }
      }
      /*
       * THE SHADOW IS THE MASS'S OWN SILHOUETTE, not a disc the size of the
       * ball (user ask, 2026-09-17: *"we should not show the shadow of the
       * sphere … the actual silhouette of the mass of objects + character"*,
       * with *"at the beginning, the character shouldn't have that big of a
       * radius"*).
       *
       * The creature's own stamp is its DRAWN radius and no longer `× g`:
       * the drawn creature does not grow — the rider divides the growth back
       * out — so a stamp that did grow was a mark about a sphere nothing
       * draws, and it is what made a hatchling read as a big creature the
       * moment it picked up its first stone.
       */
      if (slot.character) slot.characterShadow?.setRadius?.(slot.character.radius);
      syncPileShadows(slot, root);
    }
  }

  /**
   * …and the rest of that silhouette: one stamp per seated item, at the
   * item's own footprint radius, offset to where the item is DRAWN.
   *
   * A UNION OF STAMPS IS STILL ONE FLAT VALUE (TASTE §2.3 — hard-edged,
   * flat-filled, single value, no penumbra): the shadow pass draws every
   * stamp in one instanced mesh at one colour, so two overlapping stamps read
   * as one shape and not as a darker patch. That is the whole reason the
   * silhouette can be a union rather than a fitted outline.
   *
   * The offset is derived, not read off a matrix: the seat is in world units
   * from the pile's centre (`Clump.seats`) and the pile's roll is a world
   * quaternion, so the item's ground position is the root's plus the rotated
   * seat — which is true before the renderer has updated a single world
   * matrix, and costs one rotation per item.
   *
   * Bounded by `PILE_SHADOWS_MAX`, outermost first: the things furthest from
   * the centre are the ones that shape the outline, and the ones inside them
   * are already under it.
   */
  function syncPileShadows(slot: Slot, root: Group): void {
    const clump = slot.clump;
    const stamps = slot.pileShadows;
    if (!clump || clump.items.size === 0) {
      if (stamps.size > 0) clearPileShadows(slot);
      return;
    }
    const wanted = shadowWanted;
    wanted.length = 0;
    for (const item of clump.items.values()) wanted.push(item);
    wanted.sort((a, b) => {
      const sa = clump.seatOf(a.key);
      const sb = clump.seatOf(b.key);
      const da = sa ? sa.x * sa.x + sa.z * sa.z : 0;
      const db = sb ? sb.x * sb.x + sb.z * sb.z : 0;
      // Deterministic under a tie, so the set does not flicker frame to
      // frame the way an unstable sort would let it.
      return db - da || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    if (wanted.length > PILE_SHADOWS_MAX) wanted.length = PILE_SHADOWS_MAX;
    shadowKeep.clear();
    for (const item of wanted) shadowKeep.add(item.key);
    for (const [key, handle] of stamps) {
      if (shadowKeep.has(key)) continue;
      void handle;
      world.shadows.removeShadow(`stuck-${slot.id}-${key}`);
      stamps.delete(key);
    }
    for (const item of wanted) {
      const seat = clump.seatOf(item.key);
      if (!seat) continue;
      let handle = stamps.get(item.key);
      if (!handle) {
        handle = world.shadows.addShadow(`stuck-${slot.id}-${item.key}`, item.r);
        stamps.set(item.key, handle);
      }
      shadowSeat.set(seat.x, seat.y, seat.z).applyQuaternion(clump.worldQ);
      handle.setRadius?.(item.r);
      handle.setPosition(root.position.x + shadowSeat.x, root.position.z + shadowSeat.z);
    }
  }

  /** Take the pile's stamps off the ground — a retire, a drop of the whole
   * pile, or a creature that has itself been picked up (a passenger's mass is
   * inside somebody else's silhouette and casts nothing of its own). */
  function clearPileShadows(slot: Slot): void {
    for (const key of slot.pileShadows.keys()) {
      world.shadows.removeShadow(`stuck-${slot.id}-${key}`);
    }
    slot.pileShadows.clear();
  }

  const manager: CreatureManager = {
    spawn(id, strokes, opts): boolean {
      // The slot id is the creature's identity: it salts the within-band
      // synthesis so the same drawing submitted twice hatches two visibly
      // distinct individuals, and it matches the phone portrait (same id).
      const next = createCharacter(strokes, 1, {
        identity: id,
        markingSize: WORLD_MARKING_SIZE,
        ...(opts.blueprint ? { blueprint: opts.blueprint } : {}),
      });
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
        pileShadows: new Map(),
        bodyR: 0,
        baseR: 0,
        clump: null,
        rider: null,
        carriedBy: null,
        roll: 0,
        rollSpring: null,
        lift: 0,
        liftSpring: null,
        float: 0,
        floatSpring: null,
        floatBlend: 0,
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
      const out: {
        x: number;
        z: number;
        r: number;
        kind: 'egg' | 'character';
      }[] = [];
      for (const slot of slots.values()) {
        const p = worldPositionOf(slot);
        if (p) {
          out.push({
            x: p.x,
            z: p.z,
            /*
             * The GROWN radius when there is a pile — `bodyR` and NOT
             * `solidR`, which is the one place the pair go the other way
             * (2026-09-18). The scatter reads this for its exclusion radius,
             * so the question is "how much room does this game object need
             * kept clear", which is its mass; and the roll rate is measured
             * against the same number inside the clump, so a test that drives
             * one full turn reads it here.
             */
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
      // Environmental affordances, re-read on the same signal (see
      // `currentProps`) and handed to the agents as an indexed field. `null`
      // when there are none, which is the agents' own "no props known" case
      // and exactly what they were handed before.
      const propsArray = currentProps(
        scatterPhysics === null ? -1 : scatterPhysics.collidersVersion(),
      );
      const props: AgentProps = propsArray === null ? null : propField;

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
             *
             * The gait amplitude is its CARRIER's blend (`gaitAmp` →
             * `rollOf`): a passenger on a rolling ball is not walking either.
             */
            slot.character.setLocomotion(0, root.rotation.y, gaitAmp(slot));
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
            body.r = solidR(slot) > 0 ? solidR(slot) : slot.character.radius;
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
            slot.follow.ageMs += dt;
            /*
             * WHERE THE HOST'S CREATURE IS NOW, not where it was when the
             * frame was packed (2026-09-17, the *"glitch on mobile"* half of
             * the stuck report).
             *
             * Poses land five times a second and `FOLLOW_TAU_MS` is a little
             * under half that gap, so a WALKING creature covered the whole
             * distance in the first ninety milliseconds and then stood still
             * for a hundred and ten. Five times a second. On the one screen
             * whose owner is holding a stick and watching their own creature,
             * which is every phone in the room.
             *
             * So the target is led by the host's own speed (`followPoses`
             * derives it from two poses; nothing new is on the wire), capped
             * at one pose interval — past that the host has gone quiet and
             * guessing further is inventing motion rather than covering a
             * gap. The EASE is untouched: still the same monotone
             * exponential convergence toward it, so nothing overshoots and
             * nothing steps (TASTE §2.1, confidence 1.00). The heading is not
             * led at all — a turn is not a velocity, and extrapolating one
             * makes a creature that is circling look like it is spinning.
             *
             * Katamari-gated, so every other world's viewer eases toward
             * exactly the point it eased toward before.
             */
            const lead = katamari ? Math.min(slot.follow.ageMs, FOLLOW_LEAD_MAX_MS) : 0;
            const aimX = slot.follow.x + slot.follow.vx * lead;
            const aimZ = slot.follow.z + slot.follow.vz * lead;
            const beforeX = root.position.x;
            const beforeZ = root.position.z;
            root.position.x += (aimX - beforeX) * k;
            root.position.z += (aimZ - beforeZ) * k;
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
            slot.clump?.roll(
              root.position.x - beforeX,
              root.position.z - beforeZ,
              rollOf(slot),
            );

            // The gait reads the speed it is ACTUALLY travelling at, so a
            // followed creature walks for the same reason a simulated one
            // does — because it is moving — rather than being told to.
            const moved = Math.hypot(root.position.x - beforeX, root.position.z - beforeZ);
            slot.character.setLocomotion(
              dt > 0 ? (moved / dt) * 1000 : 0,
              root.rotation.y,
              gaitAmp(slot),
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
            const driven = effectiveDrive(slot);
            // Stamped from the loop's own clock, never `performance.now()`:
            // the window is compared against the same `nowMs` every other
            // timer here uses.
            if (driven) slot.drivenAtMs = nowMs;
            const held =
              slot.drivenAtMs !== null && nowMs - slot.drivenAtMs < DRIVE_IDLE_MS;
            const ceiling = DRIVE_SPEED * driveMult(rollOf(slot), massMultOf(slot));
            const driveVx = driven ? driven.x * ceiling : 0;
            const driveVz = driven ? driven.z * ceiling : 0;
            // What the hand is asking for, and where the creature is really
            // pointing: the held agent rides both rather than its own idea
            // of them, so the release is a drift-stop from the real speed
            // at the real facing.
            const hold: AgentHold | null = held
              ? {
                  speed: Math.hypot(driveVx, driveVz),
                  heading: root.rotation.y,
                }
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
            const bodyR = solidR(slot) > 0 ? solidR(slot) : slot.character.radius;
            const near = gatherNear(root.position.x, root.position.z, bodyR);

            // Soft bodies: pushing through a bush is slow (~55% damped), and
            // the bush reacts — a brief localized sway kicked into the
            // scatter's wind path. That sway is the soft-body read.
            /*
             * WHAT THIS CREATURE ROLLS STRAIGHT OVER (2026-09-16 ruling).
             *
             * A prop inside its own carry limit is not an obstacle: the
             * resolve skips it (`skipIf` on the step below), the soft
             * slowdown does not apply to it, and it reports a contact here so
             * the sticky pass can take it out of the ground and seat it. That
             * report is the part that would otherwise go missing — a skipped
             * collider produces no correction, so `resolveHard`'s own
             * `onContact` never fires for one.
             *
             * AND WHAT IT PUSHES PAST (`BLOCK_RATIO`, 2026-09-16: *"my
             * character keeps on getting stuck on objects … relax the actual
             * physics a little bit"*). Between the carry limit and
             * `passLimit` a planted prop is not a wall either: the resolve
             * skips it too, the ball pushes through at the soft-body speed,
             * and the prop takes the impact it always took. So both bands
             * report here, and `decideContact` decides which of them this
             * particular prop is in.
             *
             * KATAMARI ONLY, and gated on a `key` because a prop with no
             * placement key is not something the pile can address.
             */
            const limit = carryLimit(bodyR);
            const pass = passLimit(bodyR);
            /** Pushing past something too big to wear — slowed, not stopped. */
            let pushingPast = false;
            if (katamari && deciding()) {
              for (const c of near) {
                if (!c.hard || c.key === undefined || !(c.r <= pass)) continue;
                const dx = root.position.x - c.x;
                const dz = root.position.z - c.z;
                const d = Math.hypot(dx, dz);
                if (d > bodyR + c.r + CONTACT_PAD) continue;
                const nx = d > 1e-9 ? dx / d : 1;
                const nz = d > 1e-9 ? dz / d : 0;
                contacts.push({
                  slot,
                  collider: c,
                  nx,
                  nz,
                  speed: Math.hypot(vx, vz),
                });
                if (c.r > limit) pushingPast = true;
              }
            }
            /*
             * THE PRICE OF PUSHING PAST: the bush's own slowdown, on a prop
             * that is over the carry limit and under the block one. It is not
             * free (that would be a creature walking through the world rather
             * than into it) and it is not a stop. Applied once however many
             * such props are in reach — being wedged between two saplings is
             * still a creature moving.
             */
            if (pushingPast) {
              vx *= SOFT_SPEED_FACTOR;
              vz *= SOFT_SPEED_FACTOR;
            }

            const soft = deepestSoftOverlap(root.position.x, root.position.z, bodyR, near);
            /*
             * A CARRIABLE BUSH DOES NOT SLOW THE BALL DOWN either — same
             * ruling, same reason. `SOFT_SPEED_FACTOR` is a bush resisting,
             * and a bush the creature is about to wear has nothing to resist
             * with. Above its limit the slowdown is exactly as it was.
             */
            if (soft && katamari && soft.r <= limit) {
              // Reported by the roll-over gather above? No: that pass is hard
              // colliders only, and a bush is soft. So it reports here, with
              // the same outward-normal convention, and then nothing else
              // happens to the velocity.
              if (soft.key !== undefined && deciding()) {
                const dx = root.position.x - soft.x;
                const dz = root.position.z - soft.z;
                const d = Math.hypot(dx, dz);
                contacts.push({
                  slot,
                  collider: soft,
                  nx: d > 1e-9 ? dx / d : 1,
                  nz: d > 1e-9 ? dz / d : 0,
                  speed: Math.hypot(vx, vz),
                });
              }
            } else if (soft) {
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
              if (soft.key !== undefined && deciding() && intent > 0) {
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

            /*
             * A WALL DEFLECTS THE PUSH; IT DOES NOT ABSORB IT (`WALL_SLIDE`,
             * 2026-09-16: *"my character keeps on getting stuck on
             * objects"*).
             *
             * `resolveHard` drops the inward component of the velocity and
             * keeps the tangent, which slides beautifully along anything hit
             * at an angle and does nothing at all for a hit dead on: there
             * the whole velocity is inward, the tangent is zero, and the
             * creature stands against the wall until the person turns. That
             * is the inside of a corner, the flat face of a building and any
             * trunk approached square — and to the hand it is being stuck.
             *
             * So the inward part is turned along the surface instead of being
             * thrown away. The side is whichever way the push is already
             * leaning, with a fixed fallback dead on, so it is deterministic
             * (the host decides, and a replay of the same drive decides the
             * same). It cannot create penetration — the component it adds is
             * tangential, and the resolve still runs afterwards.
             *
             * KATAMARI ONLY. Every other world keeps the wall it shipped
             * with.
             */
            if (katamari && (vx !== 0 || vz !== 0)) {
              const physicsNow = rapierOwns();
              for (const c of near) {
                if (!c.hard) continue;
                // A prop this creature rolls up or pushes past is not a wall.
                if (c.key !== undefined && c.r <= pass) continue;
                // A stone rapier owns is not in the resolve's set either.
                if (physicsNow && c.kind === 'rock') continue;
                const dx = root.position.x - c.x;
                const dz = root.position.z - c.z;
                const d = Math.hypot(dx, dz);
                if (d > bodyR + c.r * (1 + HARD_PAD_FRAC) + CONTACT_PAD) continue;
                const nx = d > 1e-9 ? dx / d : 1;
                const nz = d > 1e-9 ? dz / d : 0;
                const vn = vx * nx + vz * nz;
                // Not pushing into it: nothing to deflect.
                if (vn >= 0) continue;
                let tx = -nz;
                let tz = nx;
                if (vx * tx + vz * tz < 0) {
                  tx = -tx;
                  tz = -tz;
                }
                vx += tx * -vn * WALL_SLIDE;
                vz += tz * -vn * WALL_SLIDE;
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
                shortestAngle(root.rotation.y, want) * followFraction(dt, turnTauMs());
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
            // raised tier the old constant sank it into the air. Measured
            // from the same place the ground pass left it, clearance and all
            // (`groundClearance`), so a big ball starts sinking from where it
            // was rather than dropping its own clearance on the first frame
            // of the slide. 0 for an egg and in every world without the game.
            // …plus the float, so a creature that retires in zero gravity
            // sinks from where it was HANGING rather than dropping its whole
            // altitude on the first frame of the slide (2026-09-17). 0 with
            // the gravity on, and 0 for an egg and every world without the
            // game, exactly like the clearance beside it.
            root.position.y =
              surface.sampleHeight(root.position.x, root.position.z) +
              slot.lift +
              slot.float -
              2.6 * ease;
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
        // `deciding()`, not `rapierOwns()`: what hangs off this is the
        // pickup path and the impact report, and a phone host runs both with
        // no rigid bodies at all (see `deciding`).
        const physicsOn = deciding();
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
          // `rapierOwns`, NOT `deciding`: this one is a real question about
          // the solver. A stone is only somewhere other than its footprint
          // circle says if a rigid body has rolled it there, and on a phone
          // host there is no such body — the stone stands where it was
          // placed and the resolve must keep meeting it (see `rapierOwns`).
          ...(rapierOwns() ? { skipKind: 'rock' } : {}),
          /*
           * `skipIf` — THE CHARACTER HAS PRIORITY (2026-09-16 ruling: *"it
           * shouldn't impede the character from moving unless the mass isn't
           * big enough to overtake the object"*).
           *
           * A planted prop inside THIS body's carry limit is not in its
           * collider set at all, so the ball rolls over it and the sticky
           * pass then takes it out of the ground onto the pile. Per body, so
           * the same sapling still stops a hatchling and no longer stops the
           * thing that has eaten a forest.
           *
           * Gated on the game AND on physics, like the roll-over gather it
           * pairs with: a page that cannot pick the prop up must not walk
           * through it.
           */
          ...(katamari && physicsOn
            ? {
                skipIf: (collider: Collider, index: number): boolean => {
                  if (collider.key === undefined) return false;
                  const entry = aliveScratch[index];
                  // `passLimit`, not `carryLimit`: what it can carry AND what
                  // it can push past (`BLOCK_RATIO`, 2026-09-16 — one
                  // centimetre of prop radius used to be the difference
                  // between rolling something up and being stopped dead by
                  // it). The slowdown for the push-past band is applied where
                  // the contacts are gathered, above.
                  return entry !== undefined && collider.r <= passLimit(entry.slot.bodyR);
                },
              }
            : {}),
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
          slot.clump?.roll(body.x - root.position.x, body.z - root.position.z, rollOf(slot));
          root.position.x = body.x;
          root.position.z = body.z;
          const character = slot.character;
          if (!character) continue;
          // The gait reads the RESOLVED ground speed — walk cycles blend in
          // with actual movement and drift out to the ambient floor.
          character.setLocomotion(
            Math.hypot(body.vx, body.vz),
            entry.heading,
            gaitAmp(slot),
          );
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
        /*
         * …plus the BALL'S CLEARANCE, and that is the only thing added to
         * this write (`groundClearance`, 2026-09-16 — "the ball is glitching
         * through the map floor if it's big enough"). It is 0 in every world
         * without the game and 0 for a creature carrying nothing, so a
         * hatchling and every creature in the public world stand on exactly
         * the height they always did.
         */
        /*
         * …AND THE FLOAT, which is the OTHER thing added to this write and
         * the only other one (`floatLift`, 2026-09-17 — the zero-gravity
         * ask). Same rules as the clearance: derived on every page, never
         * sent, 0 to the float while the world has its gravity and 0 in every
         * world without the game. A creature drifting in zero gravity is
         * still placed by the one pass that owns Y.
         */
        root.position.y =
          surface.sampleHeight(root.position.x, root.position.z) +
          groundClearance(slot, dt) +
          floatLift(slot, dt, nowMs);
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
      const simulating = manager.simulating();
      /*
       * NOTHING STAYS CARRIED (`releaseCarriedCreatures`, 2026-09-18 — *"some
       * characters can't move at all"*). On `deciding` and not on
       * `simulating`: a page can be the authority for a room whose game is
       * off, and a creature seated by a restored log there would be stuck on
       * somebody's pile with no pass to free it. This is the one rule that
       * has to run wherever the decisions are made.
       */
      if (deciding()) releaseCarriedCreatures();
      if (simulating) simulateSticky(nowMs);
      else contacts.length = 0;
      growPass(dt);
      // The rigid-body stand-ins last of all, so they are the size the
      // creature IS rather than the size it was before it ate (see
      // `syncStandIns`). Host only: a viewer holds no bodies to stand in.
      if (simulating) syncStandIns();
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
        const was = slot.follow;
        /*
         * HOW FAST THE HOST HAS IT GOING, off the two most recent poses.
         *
         * `was.ageMs` is the gap between them as THIS page's frame loop
         * measured it, which is the honest denominator: the wire carries no
         * timestamps and a receiver's own clock is the only one it has. A
         * first pose, or two poses in the same frame, has no gap to divide
         * by and gets zero — which is the behaviour that shipped.
         *
         * Clamped to a walk, so one late-bunched pair cannot hand the
         * extrapolation a speed nothing in this world can travel at.
         */
        let vx = 0;
        let vz = 0;
        if (was && was.ageMs > 1) {
          vx = (pose.x - was.x) / was.ageMs;
          vz = (pose.z - was.z) / was.ageMs;
          const speed = Math.hypot(vx, vz);
          const ceiling = FOLLOW_LEAD_MAX_SPEED / 1000;
          if (speed > ceiling) {
            vx = (vx / speed) * ceiling;
            vz = (vz / speed) * ceiling;
          }
        }
        slot.follow = {
          x: pose.x,
          z: pose.z,
          heading: pose.heading,
          // Carried forward, never reset: only the update loop sets this,
          // on the frame it actually places the creature.
          settled: was?.settled === true,
          vx,
          vz,
          ageMs: 0,
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
    evictable(): {
      id: string;
      order: number;
      resident: boolean;
      phase: string;
    }[] {
      const out: {
        id: string;
        order: number;
        resident: boolean;
        phase: string;
      }[] = [];
      for (const slot of slots.values()) {
        out.push({
          id: slot.id,
          order: slot.order,
          resident: slot.resident,
          phase: slot.phase,
        });
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
      /*
       * HELD EVEN WHILE IT IS ON SOMEBODY'S PILE (2026-09-16, the stuck
       * report). A carried creature has no locomotion of its own, so the push
       * is applied to its CARRIER on the frame — `effectiveDrive` sums the
       * passengers' sticks with the carrier's own. It used to be dropped
       * here, and a phone whose creature had been picked up could do nothing
       * at all with it.
       */
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

    clearDrives(): number {
      let released = 0;
      for (const slot of slots.values()) {
        if (slot.drive !== null) released++;
        slot.drive = null;
        // The WINDOW goes too, not just the vector. `isDriven` is true for
        // DRIVE_IDLE_MS past the last push, and a creature whose hand has
        // gone away should hand itself back to its own agent now rather
        // than in a second and a half.
        slot.drivenAtMs = null;
      }
      return released;
    },

    liveIds(): string[] {
      const out: string[] = [];
      for (const slot of slots.values()) {
        if (slot.phase === 'alive' && slot.characterRoot) out.push(slot.id);
      }
      return out;
    },

    rootOf(id): Group | null {
      const slot = slots.get(id);
      if (!slot || slot.phase !== 'alive') return null;
      return slot.characterRoot;
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
        out.push({
          id: slot.id,
          x: root.position.x,
          z: root.position.z,
          heading: root.rotation.y,
        });
      }
      return out;
    },

    pauseAi(paused): void {
      aiPaused = paused;
    },

    wanderSpeed(): number {
      return wanderSpeedMult;
    },

    rollBlend(id): number {
      const slot = slots.get(id);
      return slot ? rollOf(slot) : 0;
    },

    groundLift(id): number {
      const slot = slots.get(id);
      return slot ? slot.lift : 0;
    },

    pileReach(id): number {
      return slots.get(id)?.clump?.reach() ?? 0;
    },

    pileFloor(id): number {
      return slots.get(id)?.clump?.floor() ?? 0;
    },

    pileRise(id): number {
      return slots.get(id)?.clump?.rise() ?? 0;
    },

    pileCeiling(id): number {
      return slots.get(id)?.clump?.ceiling() ?? 0;
    },

    pileFootprint(id): number {
      return slots.get(id)?.clump?.footprint() ?? 0;
    },

    drawnRadius(id): number {
      return slots.get(id)?.character?.radius ?? 0;
    },

    growthOf(id): number {
      /*
       * HOW BIG THIS CREATURE IS DRAWN, as a multiple of its drawn size.
       *
       * The creature IS the ball (restored 2026-09-18), so the root's scale
       * is the growth and everything drawn under it — the body, its stalk and
       * topper, and the height the corner's live view has to frame — is that
       * many times its own size. The corner asked for a constant height and a
       * constant radius and therefore framed a grown ball as though it were a
       * hatchling (user report: *"the 3d representation is too small in the
       * top left corner"*).
       */
      return slots.get(id)?.clump?.growth() ?? 1;
    },

    setGravity(on): void {
      // THE GAME FIRST, like every other presentation in this file: a world
      // with no pickups is a world nobody asked to make weightless, and a
      // `gravity` event off the shared topic must not be able to lift
      // meridian's creatures off the ground.
      if (!katamari) return;
      zeroGravity = !on;
    },

    gravity(): boolean {
      return !zeroGravity;
    },

    floatOffset(id): number {
      const slot = slots.get(id);
      return slot ? slot.float : 0;
    },

    floatBlend(id): number {
      const slot = slots.get(id);
      return slot ? slot.floatBlend : 0;
    },

    driveCeiling(id): number {
      const slot = slots.get(id);
      return slot ? DRIVE_SPEED * driveMult(rollOf(slot), massMultOf(slot)) : 0;
    },

    ballDiameter(id): number {
      // The game first, like `simulating()` and the six presentations: a
      // world with no pile has no ball, whatever a slot's measured footprint
      // happens to be.
      if (!katamari) return 0;
      const slot = slots.get(id);
      if (!slot) return 0;
      return 2 * ballOf(slot).bodyR;
    },

    ballOwner(id): string {
      const slot = slots.get(id);
      if (!slot) return '';
      // The same walk `ballDiameter` measures with — one answer about which
      // pile a creature belongs to, not two that can disagree.
      return katamari ? ballOf(slot).id : slot.id;
    },

    setWanderSpeed(mult): void {
      wanderSpeedMult = Math.max(0, mult);
      // The slider moves the whole range: a katamari world's walk is a
      // fraction of it, every other world's only ceiling IS it.
      for (const slot of slots.values()) {
        slot.agent?.setSpeedMultiplier(walkMult() * massSpeedFactor(massMultOf(slot)));
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
      return katamari && deciding() && !aiPaused;
    },

    applyStick(record): void {
      if (!katamari) return;
      const carrier = slots.get(record.id);
      /*
       * NOT YET HERE IS NOT THE SAME AS NEVER (2026-09-17, measured in a real
       * room — see `pendingSticks`). A carrier that has not hatched on this
       * page yet is a page that is still building the creature the host has
       * already put six things on, so the record waits for it instead of
       * being dropped; `becomeAlive` drains the queue.
       */
      if (!carrier || carrier.phase !== 'alive' || !carrier.clump) {
        const waiting = pendingSticks.get(record.id) ?? [];
        /*
         * Re-seat rather than duplicate, the same rule `Clump.add` follows:
         * the same key arriving twice is a resent batch and the second one is
         * the truth. IN PLACE, though — the queue is drained in order and an
         * offset is world units over the growth the pile had when the
         * DECIDING page seated it (src/creatures/clump.ts), so the arrival
         * order is part of the message. Moving a re-sent record to the back
         * would apply it at a bigger growth than it was computed for and put
         * it a metre further out than the host has it.
         */
        const at = waiting.findIndex((held) => held.item === record.item);
        if (at >= 0) waiting[at] = record;
        else waiting.push(record);
        if (waiting.length > PENDING_STICKS_MAX) waiting.splice(0, waiting.length - PENDING_STICKS_MAX);
        pendingSticks.set(record.id, waiting);
        return;
      }
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

    applyLoose(item, x, z, scale): void {
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
      /*
       * THE HOST'S OWN BODY FIRST, then the event's, then the instance row
       * (2026-09-17). A host replaying its own log has just rebuilt the body
       * and knows better than the log; a VIEWER has neither a body nor a row
       * — the placement stopped being drawn the moment this event was
       * decided — and the event's scale is the only thing left. Falling
       * through to 1 is what drew a library model at a third of its size on
       * every screen but the one that decided.
       */
      showLoose(item, x, z, built?.scale ?? scale);
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
        out.push({
          item: state.key,
          stage: state.stage,
          removed: state.removed.size,
        });
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
        // creature is set back down on the terrain under it — on its ball's
        // clearance where it has one, which is where the next frame's ground
        // pass is going to hold it anyway.
        root.position.y = surface.sampleHeight(root.position.x, root.position.z) + slot.lift;
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
