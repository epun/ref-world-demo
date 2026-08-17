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
import { BehaviorAgent, type AgentPeer, type AgentProp } from '../behavior/agent';
import { personalityFromChoice, type PersonalityChoice } from '../behavior/personality';
import { createCharacter, type Character } from '../character/character';
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
  /** Positions of all live entities, for camera interest + exclusions. */
  positions(): { x: number; z: number; r: number }[];
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

  return {
    spawn(id, strokes, opts): boolean {
      const next = createCharacter(strokes);
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
      const out: { x: number; z: number; r: number }[] = [];
      for (const slot of slots.values()) {
        const p = worldPositionOf(slot);
        if (p) out.push({ x: p.x, z: p.z, r: slot.character?.radius ?? slot.egg?.radius ?? 1 });
      }
      return out;
    },

    count: () => slots.size,

    update(dt, nowMs): void {
      // Environmental affordances, sampled once per frame for every agent.
      const props = readProps(world);

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
            );
            root.position.x += (out.vx * dt) / 1000;
            root.position.z += (out.vz * dt) / 1000;
            root.rotation.y = out.heading;
            // The gait reads the agent's actual ground speed — walk cycles
            // blend in with movement and drift out to the ambient floor.
            slot.character.setLocomotion(Math.hypot(out.vx, out.vz), out.heading);
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
}
