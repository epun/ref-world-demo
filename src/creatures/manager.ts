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

import { Vector3 } from 'three';
import type { Group, Object3D } from 'three';
import { BehaviorAgent, MAX_SPEED, type AgentPeer, type AgentProp } from '../behavior/agent';
import { personalityFromChoice, type PersonalityChoice } from '../behavior/personality';
import { createCharacter, type Character } from '../character/character';
import {
  buildColliderGrid,
  type Collider,
  type ColliderGrid,
} from '../physics/colliders';
import {
  CREATURE_BODY_FIT,
  deepestSoftOverlap,
  resolveHard,
  separationOffsets,
  SOFT_SPEED_FACTOR,
  type KinematicBody,
  type SeparationOffsets,
} from '../physics/resolve';
import { createEgg, type Egg } from '../egg/egg';
import { startHatch, type HatchHandle } from '../egg/hatch';
import type { StrokeList } from '../shape/types';
import { MOTION } from '../taste/tokens';
import type { WorldHandles } from '../world/scene';
import type { ShadowHandle } from '../world/shadows';

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
  /** Audience answer, held until hatch mints the behavior agent. */
  personalityChoice: PersonalityChoice;
  /** Autonomous behavior — created on hatch, null before. */
  agent: BehaviorAgent | null;
  /** Last pose the agent reported, for expression edge-detection. */
  pose: 'sit' | 'sleep' | null;
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

export interface CreatureManager {
  /** Validate + spawn (replacing any existing slot with the same id).
   * Returns false when the ink is unusable. */
  spawn(id: string, strokes: StrokeList, opts: SpawnOptions): boolean;
  /** Force a specific egg (or with no id, every ready egg) to hatch now. */
  hatch(id?: string): void;
  hatchAll(): void;
  /** Most recently hatched character, for emote keys / camera framing. */
  latestCharacter(): Character | null;
  /** Named, hit-testable live creatures for the hover-name overlay. Only
   * creatures whose drawer entered a name appear. */
  hoverTargets(): { name: string; object: Group }[];
  /** Positions of all live entities, for camera interest + exclusions +
   * the world minimap. `kind` is additive: egg until the hatch burst hands
   * the slot a character root, character after. */
  positions(): { x: number; z: number; r: number; kind: 'egg' | 'character' }[];
  count(): number;
  update(dt: number, nowMs: number): void;
  clear(id: string): void;
  clearAll(): void;
  pauseTimers(paused: boolean): void;
  /** Freeze autonomous behavior (demo panel). Separate from pauseTimers:
   * eggs keep hatching; characters hold still (ambient floor stays alive). */
  pauseAi(paused: boolean): void;
  /** Wander speed multiplier (demo panel tuning). 1 = spec speed. */
  setWanderSpeed(mult: number): void;
}

export function createCreatureManager(world: WorldHandles): CreatureManager {
  const slots = new Map<string, Slot>();
  let orderCounter = 0;
  let timersPaused = false;
  let aiPaused = false;
  let wanderSpeedMult = 1;

  // ── physics scratch (allocation-free per frame) ───────────────────────────
  // The prop spatial hash rebuilds only when the scatter's collider version
  // moves (density/exclusion changes) — per frame it is queries only, so the
  // cost is O(creatures × nearby), never O(creatures × all props).
  let colliderGrid: ColliderGrid | null = null;
  let colliderGridVersion = -1;
  const nearScratch: Collider[] = [];
  const eggColliderPool: Collider[] = [];
  let eggColliderCount = 0;
  const resolveBody: KinematicBody = { x: 0, z: 0, vx: 0, vz: 0 };
  const sepScratch: SeparationOffsets = { ax: 0, az: 0, bx: 0, bz: 0 };
  const aliveScratch: { slot: Slot; root: Group; r: number }[] = [];

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
  }

  function beginHatch(slot: Slot): void {
    if (!slot.egg || slot.hatch || !slot.pending) return;
    const next = slot.pending;
    slot.phase = 'hatching';
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
      if (existing) disposeSlot(existing);

      // Population guard: retire the oldest live slot beyond the cap.
      if (slots.size >= MAX_POPULATION) {
        let oldest: Slot | null = null;
        for (const s of slots.values()) {
          if (s.phase === 'retiring') continue;
          if (!oldest || s.order < oldest.order) oldest = s;
        }
        if (oldest) beginRetire(oldest, performance.now());
      }

      const spot = spawnSpot(orderCounter % 64);
      const egg = createEgg(strokes, { x: spot.x, z: spot.z });
      const nowMs = performance.now();
      const slot: Slot = {
        id,
        name: opts.name ?? null,
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
        personalityChoice: opts.personality ?? null,
        agent: null,
        pose: null,
        retireStartMs: 0,
        order: orderCounter++,
      };
      slot.eggShadow?.setPosition(spot.x, spot.z);
      world.scene.add(egg.group);
      world.cameraRig.frameAt(new Vector3(spot.x, 0, spot.z));
      slots.set(id, slot);
      return true;
    },

    hatch(id): void {
      if (id === undefined) {
        this.hatchAll();
        return;
      }
      const slot = slots.get(id);
      if (slot && slot.phase === 'egg') beginHatch(slot);
    },

    hatchAll(): void {
      for (const slot of slots.values()) {
        if (slot.phase === 'egg') beginHatch(slot);
      }
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

      // Prop colliders: re-index only when the scatter's version moves.
      const scatterPhysics = readScatterPhysics(world);
      if (scatterPhysics) {
        const version = scatterPhysics.collidersVersion();
        if (version !== colliderGridVersion || !colliderGrid) {
          colliderGrid = buildColliderGrid(scatterPhysics.colliders());
          colliderGridVersion = version;
        }
      } else {
        colliderGrid = null;
        colliderGridVersion = -1;
      }

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
            if (p >= 1) beginHatch(slot);
          }
        }

        slot.hatch?.update(dt, nowMs);

        if (slot.character) {
          slot.character.update(dt, nowMs);

          // Autonomous behavior: the agent owns the root's x/z and heading.
          // Never world-space Y — locomotion stays on the Surface seam.
          const root = slot.characterRoot;
          if (root && slot.agent && slot.phase === 'alive' && !aiPaused) {
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
            const bodyR = slot.character.radius * CREATURE_BODY_FIT;
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

            root.position.x += (vx * dt) / 1000;
            root.position.z += (vz * dt) / 1000;

            // Hard bodies (trunks, rocks, buildings, stumps, eggs): push out
            // along the penetration normal + slide the remaining velocity
            // along the tangent — positional correction only, never a bounce.
            resolveBody.x = root.position.x;
            resolveBody.z = root.position.z;
            resolveBody.vx = vx;
            resolveBody.vz = vz;
            resolveHard(resolveBody, bodyR, near);
            root.position.x = resolveBody.x;
            root.position.z = resolveBody.z;
            vx = resolveBody.vx;
            vz = resolveBody.vz;

            root.rotation.y = out.heading;
            // The gait reads the RESOLVED ground speed — walk cycles blend
            // in with actual movement and drift out to the ambient floor.
            slot.character.setLocomotion(Math.hypot(vx, vz), out.heading);
            aliveScratch.push({ slot, root, r: bodyR });
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

      // Creature-vs-creature: soft mutual separation (half-strength push,
      // overlap hard-capped at ~40%) so creatures brush past each other
      // rather than stack. Positional only — velocities untouched, so the
      // gait never sees a phantom shove.
      for (let i = 0; i < aliveScratch.length; i++) {
        for (let j = i + 1; j < aliveScratch.length; j++) {
          const a = aliveScratch[i]!;
          const b = aliveScratch[j]!;
          const off = separationOffsets(
            a.root.position.x,
            a.root.position.z,
            a.r,
            b.root.position.x,
            b.root.position.z,
            b.r,
            dt,
            sepScratch,
          );
          if (!off) continue;
          a.root.position.x += off.ax;
          a.root.position.z += off.az;
          b.root.position.x += off.bx;
          b.root.position.z += off.bz;
        }
      }
      // Backstop: a separation push must not land anyone inside a hard
      // body — re-resolve (positional only) and re-seat the shadows.
      for (const a of aliveScratch) {
        resolveBody.x = a.root.position.x;
        resolveBody.z = a.root.position.z;
        resolveBody.vx = 0;
        resolveBody.vz = 0;
        resolveHard(resolveBody, a.r, gatherNear(resolveBody.x, resolveBody.z, a.r));
        a.root.position.x = resolveBody.x;
        a.root.position.z = resolveBody.z;
        const character = a.slot.character;
        if (character && a.slot.characterShadow) {
          a.slot.characterShadow.setPosition(
            a.root.position.x + character.group.position.x,
            a.root.position.z + character.group.position.z,
          );
        }
      }
    },

    clear(id): void {
      const slot = slots.get(id);
      if (slot) disposeSlot(slot);
    },

    clearAll(): void {
      for (const slot of [...slots.values()]) disposeSlot(slot);
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
  };
  // Tiny always-on probe (same family as __refworldEnv / __refworldColliders,
  // deliberately not dev-gated): the physics smoke samples live creature
  // positions against the collider set through it.
  (globalThis as { __refworldCreatures?: CreatureManager }).__refworldCreatures = manager;
  return manager;
}
