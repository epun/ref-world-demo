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

import { Mesh, Vector3 } from 'three';
import type { Group, Object3D } from 'three';
import { BehaviorAgent, MAX_SPEED, type AgentPeer, type AgentProp } from '../behavior/agent';
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
import { VARIATION_BULGE, VARIATION_SCALE_XZ } from '../world/scatter';
import { createEgg, EGG_RADIUS, type Egg } from '../egg/egg';
import { startHatch, type HatchHandle } from '../egg/hatch';
import type { EmoteName } from '../net/protocol';
import type { StrokeList } from '../shape/types';
import { MOTION } from '../taste/tokens';
import type { WorldHandles } from '../world/scene';
import type { ShadowHandle } from '../world/shadows';
import { resolveName } from './naming';

/** Shipped wander-speed multiplier (panel export, user ask): a touch
 * brisker than spec pace. The panel slider starts here. */
export const WANDER_SPEED_DEFAULT = 1.4;

/** Practical demo guard, not a design cap (see header). */
export const MAX_POPULATION = 24;

/** Egg shadow sits a touch inside the shell footprint. */
const EGG_SHADOW_FIT = 0.85;

/** Pre-hatch crack teaser share of the crack scrub. */
const CRACK_TEASER = 0.3;

/**
 * Deterministic spawn spot for the nth creature: a golden-angle spiral
 * around the origin, so any population reads as a loose organic scatter —
 * never a row, never a grid (grid governs placement of props, not beings).
 */
export function spawnSpot(index: number): { x: number; z: number } {
  const angle = index * 2.39996322972865332; // golden angle, radians
  const radius = 3.2 + 2.1 * Math.sqrt(index);
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
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

type Phase = 'egg' | 'hatching' | 'alive' | 'retiring';

interface Slot {
  id: string;
  name: string | null;
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
   * footprint (measureBodyRadius); 0 until hatch. */
  bodyR: number;
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
}

export interface SpawnOptions {
  name?: string | null;
  /** Audience personality answer ("what does your little creature want
   * most?"). Biases behavior transition probabilities only — never shown in
   * UI (docs/GENERATOR.md §behavior). Absent/null → neutral defaults. */
  personality?: 'friends' | 'snacks' | 'sleep' | 'adventure' | 'chaos' | null;
  /** ms until auto-hatch. */
  hatchMs: number;
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
}

export interface CreatureManagerOptions {
  /** Session recorder (or any witness). Optional. */
  observer?: CreatureObserver;
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
  /** Wander speed multiplier (demo panel tuning). 1 = spec speed. */
  setWanderSpeed(mult: number): void;
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
}

export function createCreatureManager(
  world: WorldHandles,
  options: CreatureManagerOptions = {},
): CreatureManager {
  const observer = options.observer;
  const slots = new Map<string, Slot>();
  let orderCounter = 0;
  let timersPaused = false;
  let aiPaused = false;
  let wanderSpeedMult = WANDER_SPEED_DEFAULT;

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
    return new Vector3(root.position.x, 0, root.position.z);
  }

  function disposeSlot(slot: Slot): void {
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

  function beginHatch(slot: Slot, cause: 'timer' | 'forced'): void {
    if (!slot.egg || slot.hatch || !slot.pending) return;
    const next = slot.pending;
    slot.phase = 'hatching';
    observer?.hatch(slot.id, cause);
    slot.hatch = startHatch(world.scene, slot.egg, next, {
      onBurst: (root) => {
        slot.character = next;
        slot.pending = null;
        slot.characterRoot = root;
        // Named so the ghost-panel scene outliner lists each creature
        // legibly (user ask). Lowercase, name over id when the drawer
        // signed one.
        root.name = slot.name ? `creature ${slot.name}` : `creature ${slot.id}`;
        slot.characterShadow = world.shadows.addShadow(`char-${slot.id}`, next.radius);
        // Collision circle from the REAL mesh footprint (wide fish ≠ narrow
        // triangle) — never the tucked-in shadow radius.
        slot.bodyR = measureBodyRadius(next);
        world.shadows.removeShadow(`egg-${slot.id}`);
        slot.eggShadow = null;
        slot.egg = null; // the hatch owns the egg's disposal from here
        slot.phase = 'alive';
        // Hatch mints the hidden life: seed from the slot id, personality
        // from the audience answer (null → mild seeded variation).
        const seed = behaviorSeed(slot.id);
        slot.agent = new BehaviorAgent(
          seed,
          personalityFromChoice(slot.personalityChoice, seed),
        );
        slot.agent.setSpeedMultiplier(wanderSpeedMult);
        world.cameraRig.frameAt(root.position);
      },
      onDone: () => {
        slot.hatch = null;
      },
    });
  }

  const manager: CreatureManager = {
    spawn(id, strokes, opts): boolean {
      // The slot id is the creature's identity: it salts the within-band
      // synthesis so the same drawing submitted twice hatches two visibly
      // distinct individuals, and it matches the phone portrait (same id).
      const next = createCharacter(strokes, 1, { identity: id });
      if (!next) return false;

      const existing = slots.get(id);
      if (existing) {
        // One drawer, one slot: their new drawing replaces the old creature.
        observer?.retire(id, 'replaced');
        disposeSlot(existing);
      }

      // Population guard: retire the oldest live slot beyond the cap.
      if (slots.size >= MAX_POPULATION) {
        let oldest: Slot | null = null;
        for (const s of slots.values()) {
          if (s.phase === 'retiring') continue;
          if (!oldest || s.order < oldest.order) oldest = s;
        }
        if (oldest) beginRetire(oldest, performance.now());
      }

      // Projected clear of props and residents — an egg never incubates
      // half-inside a rock (the raw spiral can reach planted ground).
      const spot = clearSpawnSpot(spawnSpot(orderCounter % 64));
      const egg = createEgg(strokes, { x: spot.x, z: spot.z });
      const nowMs = performance.now();
      const slot: Slot = {
        id,
        // Unsigned drawings still get a name (user ruling, 2026-08-18) —
        // derived from the identity id, so it is the same on every device
        // and reproduces exactly on replay (src/creatures/naming.ts).
        name: resolveName(opts.name, id),
        phase: 'egg',
        spot,
        egg,
        eggShadow: world.shadows.addShadow(`egg-${id}`, egg.radius * EGG_SHADOW_FIT),
        bornMs: nowMs,
        hatchAtMs: nowMs + opts.hatchMs,
        pending: next,
        hatch: null,
        character: null,
        characterRoot: null,
        characterShadow: null,
        bodyR: 0,
        personalityChoice: opts.personality ?? null,
        agent: null,
        pose: null,
        manualHold: false,
        retireStartMs: 0,
        order: orderCounter++,
      };
      slot.eggShadow?.setPosition(spot.x, spot.z);
      world.scene.add(egg.group);
      world.cameraRig.frameAt(new Vector3(spot.x, 0, spot.z));
      slots.set(id, slot);
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
      for (const slot of slots.values()) {
        if (slot.phase === 'egg') beginHatch(slot, 'forced');
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
            r: slot.character?.radius ?? slot.egg?.radius ?? 1,
            kind: slot.characterRoot ? 'character' : 'egg',
          });
        }
      }
      return out;
    },

    count: () => slots.size,

    update(dt, nowMs): void {
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

      for (const slot of [...slots.values()]) {
        if (slot.egg) {
          slot.egg.update(dt, nowMs);
          slot.eggShadow?.setPosition(slot.egg.group.position.x, slot.egg.group.position.z);
          if (!slot.hatch && slot.phase === 'egg' && !timersPaused) {
            const total = slot.hatchAtMs - slot.bornMs;
            const p = total <= 0 ? 1 : Math.min(1, (nowMs - slot.bornMs) / total);
            slot.egg.setHatchProgress(p);
            slot.egg.crack(CRACK_TEASER * smoothstep(0.62, 1, p));
            if (p >= 1) beginHatch(slot, 'timer');
          }
        }

        slot.hatch?.update(dt, nowMs);

        if (slot.character) {
          if (worldUnitsPerPx > 0) slot.character.setWorldUnitsPerPixel?.(worldUnitsPerPx);
          slot.character.update(dt, nowMs);

          // Autonomous behavior: the agent owns the root's x/z and heading.
          // Never world-space Y — locomotion stays on the Surface seam.
          const root = slot.characterRoot;
          if (root && slot.phase === 'alive' && slot.manualHold) {
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
          } else if (root && slot.agent && slot.phase === 'alive' && !aiPaused) {
            const peers: AgentPeer[] = [];
            for (const other of slots.values()) {
              if (other === slot || other.phase !== 'alive' || !other.characterRoot) {
                continue;
              }
              peers.push({
                x: other.characterRoot.position.x,
                z: other.characterRoot.position.z,
                id: other.id,
              });
            }
            const out = slot.agent.update(
              dt,
              nowMs,
              { x: root.position.x, z: root.position.z },
              peers,
              props,
              colliderGrid,
            );
            let vx = out.vx;
            let vz = out.vz;
            const bodyR = slot.bodyR > 0 ? slot.bodyR : slot.character.radius;
            const near = gatherNear(root.position.x, root.position.z, bodyR);

            // Soft bodies: pushing through a bush is slow (~55% damped), and
            // the bush reacts — a brief localized sway kicked into the
            // scatter's wind path. That sway is the soft-body read.
            const soft = deepestSoftOverlap(root.position.x, root.position.z, bodyR, near);
            if (soft) {
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
            aliveScratch.push({ slot, root, body, heading: out.heading });

            root.rotation.y = out.heading;
            if (out.emote) slot.character.emote(out.emote);
            if (out.pose !== slot.pose) {
              // Posture → expression through the character's public surface:
              // sleep closes the eyes; leaving it drifts them back open.
              if (out.pose === 'sleep') slot.character.setExpression('sleepy');
              else if (slot.pose === 'sleep') slot.character.setExpression('neutral');
              slot.pose = out.pose;
            }
          } else {
            // No agent driving (paused ai, retiring): the root holds still,
            // so the gait must see speed 0 and complete its last half-step.
            slot.character.setLocomotion(0, root?.rotation.y ?? 0);
          }

          if (slot.characterRoot && slot.characterShadow) {
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
            root.position.y = -2.6 * ease;
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
        stepCreatures(stepBodies, dt, gatherNear, { hardPadFrac: HARD_PAD_FRAC });
        for (const entry of aliveScratch) {
          const { slot, root, body } = entry;
          if (entry.held) {
            // The gizmo owns this root; the resolved body position is
            // discarded (neighbors carried their half of any separation).
            slot.characterShadow?.setPosition(
              root.position.x + (slot.character?.group.position.x ?? 0),
              root.position.z + (slot.character?.group.position.z ?? 0),
            );
            continue;
          }
          root.position.x = body.x;
          root.position.z = body.z;
          const character = slot.character;
          if (!character) continue;
          // The gait reads the RESOLVED ground speed — walk cycles blend in
          // with actual movement and drift out to the ambient floor.
          character.setLocomotion(Math.hypot(body.vx, body.vz), entry.heading);
          slot.characterShadow?.setPosition(
            body.x + character.group.position.x,
            body.z + character.group.position.z,
          );
        }
      }
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

    pauseAi(paused): void {
      aiPaused = paused;
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

    endManualMove(root): void {
      for (const slot of slots.values()) {
        if (slot.characterRoot !== root || !slot.manualHold) continue;
        slot.manualHold = false;
        // Re-ground: locomotion never uses world-space Y (Surface seam), so
        // any vertical the gizmo introduced is dropped on release.
        root.position.y = 0;
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
