/**
 * Debris — the pieces a broken prop leaves behind (PLAN §7.6).
 *
 * > User brief, 2026-09-15: *"large props break into major chunks that
 * > become independent debris… debris is lightweight, has LIFETIMES (small
 * > 5–10 s, medium 10–20 s, important persistent), never grows without
 * > bound."*
 *
 * WHAT A PIECE OF DEBRIS IS. One chunk geometry (src/world/chunks.ts — torn
 * fragments of the prop's own silhouette, never boxes), drawn through
 * `src/world/loose.ts` like every other thing that stopped being scenery,
 * and on the HOST a dynamic rapier body under it. That is the whole object:
 * there is no debris renderer, no debris material and no second draw path,
 * because a fragment lying in the field is exactly the same kind of thing as
 * a fallen tree and the room has to agree about both.
 *
 * WHY IT IS DRAWN THROUGH `LooseMeshes` AND NOT ITS OWN GROUP. A piece of
 * debris is collectable — a creature can roll over a fallen chunk of
 * building and wear it — and a pickup hangs the item's EXISTING mesh on the
 * pile (src/creatures/manager.ts `stickItem`). One mesh per fragment,
 * whoever ends up holding it, or a picked-up chunk would be drawn twice.
 *
 * HOST AND VIEWER.
 *
 *   The host builds a body per fragment and hands it to `PropBodies.adopt`,
 *   which puts it in `items()` — so the katamari pickup pass sees it, the
 *   settle report fires for it, and the resurface safety net catches it.
 *
 *   A viewer has no rapier world at all (docs/PLAN.md §7.6). Its fragments
 *   are meshes that sit where the event said, and move only when a `settle`
 *   tells them where a piece came to rest. Which is the brief's own split:
 *   *"the server syncs only destruction states and major transforms;
 *   secondary debris is local."*
 *
 * THE TWO BOUNDS, and they are different bounds.
 *
 *   A LIFETIME keeps the field tidy: `debrisLifetimeMs` per tier
 *   (src/creatures/sticky.ts), off the motion tokens. An expiring piece
 *   SINKS into the ground over `MOTION.primaryMs` and is then disposed —
 *   never removed on a frame, because a piece of the world blinking out is
 *   the hard cut the motion law forbids at confidence 1.00 (TASTE §2.1).
 *
 *   A CAP keeps the page alive: `DEBRIS_CAP[tier]` (src/world/device.ts),
 *   oldest first. Breaking a building is the one thing in this design that
 *   can multiply the object count without anybody asking, and a phone
 *   watching the room must not be the thing that decides how much of the
 *   room there is.
 *
 * DETERMINISM. No `Math.random` anywhere: a fragment's outward direction
 * comes from its own chunk offset and a fold of the parent's placement key
 * (`fragmentSpread`, src/world/wreck.ts), so a collapse throws its pieces
 * the same way twice running.
 */

import { Vector3 } from 'three';
import { MOTION } from '../taste/tokens';
import { STICKY, debrisLifetimeMs } from '../creatures/sticky';
import type { PhysicsWorld } from '../physics/world';
import type { Chunk, ChunkKind } from './chunks';
import { DEBRIS_CAP, type DeviceTier } from './device';
import { CHUNK_SEPARATOR, type LooseMeshes, type LooseRotation } from './loose';
import type { PropKind } from './props';
import {
  hullPoints,
  ROCK_ANGULAR_DAMPING,
  ROCK_LINEAR_DAMPING,
  ROCK_FRICTION,
  type LooseItem,
  type PropBodies,
} from './rocks';
import type { Surface } from './surface';
import { fragmentSpread } from './wreck';

type RapierRigidBody = import('@dimforge/rapier3d-compat').RigidBody;

/**
 * [D] Density of a fragment, against a stone's `ROCK_DENSITY` of 2.5.
 *
 * *"Debris is lightweight"* is a line in the brief, so it is a number here:
 * a piece at 1.0 is shoved further by the same hit than the rock it broke
 * off would be, which is what makes a collapse read as debris rather than
 * as a pile of smaller boulders.
 */
export const DEBRIS_DENSITY = 1;

/**
 * [D] Speed a fragment leaves a break at, per unit of impact — and its cap.
 *
 * The cap is the load-bearing half. Impact is unbounded in principle (a very
 * large pile at speed), and a monolith whose pieces left at forty units a
 * second would fling them off the map; 7 u/s is a piece crossing a couple of
 * prop widths before it beds down, which is a big readable reaction that
 * stays in the frame.
 */
export const FRAGMENT_SPEED_PER_IMPACT = 0.45;
export const FRAGMENT_SPEED_MAX = 7;

/**
 * [D] Downward speed added to a collapsing section, u/s.
 *
 * A collapse falls; a shatter bursts. Gravity would get a fragment there on
 * its own, but a section of building that starts by drifting outward and
 * only then remembers to fall reads as weightless.
 */
export const COLLAPSE_DOWN_SPEED = 2.5;

/** [D] Jitter on the outward direction, as a fraction of it. Enough that
 * four fragments do not leave along four exact spokes, small enough that
 * every piece still goes away from the middle. */
const SPREAD_MIX = 0.35;

/** How long a piece takes to sink out of the world, and how far it goes —
 * far enough that nothing of it is above the ground when it is disposed.
 * The duration is a token, never a literal (CLAUDE.md). */
const SINK_MS = MOTION.primaryMs;
const SINK_DEPTH_FACTOR = 2.5;

/** One live piece of debris. */
export interface DebrisItem {
  /** `<placementKey>#<chunkIndex>` — the id the wire uses for it too. */
  key: string;
  parentKey: string;
  kind: PropKind;
  variant: number;
  chunkIndex: number;
  scale: number;
  /** Bounding radius at instance scale. */
  r: number;
  /**
   * When it was spawned, and how long it may live (`Infinity` persists).
   *
   * `bornMs` is -1 for a piece spawned before this layer has seen a frame —
   * the first `update` stamps it. Without that a fragment spawned at
   * construction time would read as having been born at the epoch and
   * expire on the frame it appeared, which is the one thing a sink exists to
   * prevent.
   */
  bornMs: number;
  lifetimeMs: number;
  /** Its rapier body on the host; null on a viewer, which has no world. */
  body: RapierRigidBody | null;
  /** Non-null once it has started sinking out: when it started, and the
   * height it started from. */
  sink: { startedMs: number; fromY: number } | null;
}

export interface DebrisOptions {
  /**
   * The rigid-body world and the body registry, as GETTERS.
   *
   * Because physics arrives late and only on some pages: `enablePhysics` is
   * called on host election (docs/PLAN.md §7.6) and never on a viewer, while
   * this layer has to exist on every page from the first frame — a phone
   * that hears a `shatter` has to draw the chunks whether or not it will
   * ever simulate one. So it asks each time rather than being handed a world
   * it might not have yet.
   */
  physics: () => PhysicsWorld | null;
  bodies: () => PropBodies | null;
  /** Where fragments are drawn (and where a pickup finds the mesh again). */
  loose: LooseMeshes;
  /** The ground, through the one seam that owns a height (PLAN §7.2). */
  surface: Surface;
  /** The chunk set, as a getter — built by the caller on first demand, for
   * the same reason `physics` is a getter: most pages never break anything
   * and `buildChunkGeometries()` re-runs the prop pipeline. */
  chunks: () => Map<ChunkKind, Chunk[][]>;
  /** How much this screen can afford (src/world/device.ts). */
  tier: DeviceTier;
}

export interface DebrisParent {
  /** Placement key of the prop that broke. */
  key: string;
  kind: PropKind;
  variant: number;
  scale: number;
  x: number;
  z: number;
  rotY: number;
}

export interface Debris {
  /**
   * One fragment, at a world pose given by the caller.
   *
   * Returns null when there is no such chunk (an unbreakable kind, a variant
   * the chunk set does not cover, an index past its end) — which a caller
   * treats as "nothing to draw" rather than as an error, exactly as a
   * missing geometry is treated everywhere else in this layer.
   */
  spawnChunk(
    parent: DebrisParent,
    chunkIndex: number,
    x: number,
    y: number,
    z: number,
    q: LooseRotation,
    velocity?: { x: number; y: number; z: number },
  ): DebrisItem | null;
  /**
   * Several fragments at once, each seated where its chunk sits in the prop
   * and thrown outward from the prop's middle — a break, rather than a set
   * of objects appearing.
   *
   * `impact` scales the speed and `down` adds the fall of a collapse. On a
   * viewer (no bodies) the velocity is computed and discarded, which is
   * cheaper than branching and keeps the two paths in step.
   */
  spawnFragments(
    parent: DebrisParent,
    chunkIndices: readonly number[],
    opts?: { impact?: number; down?: boolean },
  ): DebrisItem[];
  /** Is this item one of ours? (The manager asks before treating a `settle`
   * for a `#` id as debris.) */
  has(key: string): boolean;
  /** One frame: write transforms, run the sinks, expire what is due. */
  update(dtMs: number, nowMs: number): void;
  /** Live pieces, sinking ones included. */
  count(): number;
  dispose(): void;
}

export function createDebris(opts: DebrisOptions): Debris {
  const items = new Map<string, DebrisItem>();
  const cap = DEBRIS_CAP[opts.tier];
  const scratch = new Vector3();
  /** Wired on the first host spawn — the registry does not exist before it,
   * and on a viewer it never does. */
  let takeWired = false;

  const chunkAt = (kind: PropKind, variant: number, index: number): Chunk | null => {
    const set = opts.chunks().get(kind as ChunkKind);
    return set?.[variant]?.[index] ?? null;
  };

  /**
   * Stop tracking a fragment a creature has picked up.
   *
   * It is not gone — the clump owns its mesh now and `PropBodies` has
   * dropped its body — but it is no longer debris, and a lifetime that
   * expired while it was riding a pile would sink a stuck chunk into the
   * ground with the creature still carrying it.
   */
  const wireTake = (bodies: PropBodies): void => {
    if (takeWired) return;
    takeWired = true;
    bodies.onTake((key) => {
      items.delete(key);
    });
  };

  /** Begin the sink, or dispose outright if it is already sinking. */
  const expire = (item: DebrisItem, nowMs: number): void => {
    if (item.sink) {
      destroy(item);
      return;
    }
    // The body goes first: a piece on its way out of the world must not go
    // on shoving things, and a solver holding it up would fight the sink.
    if (item.body) opts.bodies()?.release(item.key);
    item.body = null;
    const object = opts.loose.get(item.key);
    item.sink = { startedMs: nowMs, fromY: object?.position.y ?? 0 };
  };

  const destroy = (item: DebrisItem): void => {
    if (item.body) opts.bodies()?.release(item.key);
    opts.loose.remove(item.key);
    items.delete(item.key);
  };

  /**
   * Hold the cap before adding one more, oldest first.
   *
   * TWO WAYS OUT, and the order matters. A piece already sinking is half
   * underground and can simply go — nobody can see the difference. Only when
   * there is no such piece does the oldest STANDING one get pushed out, and
   * it goes the gentle way, by starting its sink (`expire`).
   *
   * Under a real flood — a mountain coming down on a phone — the sink is
   * slower than the spawns, and a piece that has only just started sinking
   * will be disposed on the next spawn. That is the cap winning over the
   * slide, deliberately: the alternative is a page whose object count is
   * decided by how much of the world somebody knocked over. On a screen with
   * twenty-four fragments on it, one of them going early is invisible; a
   * phone dropping to four frames a second is not.
   *
   * The loop provably terminates: every pass either disposes something or
   * starts a sink on something that the next pass can dispose.
   */
  const makeRoom = (nowMs: number): void => {
    let guard = cap + 2;
    while (items.size >= cap && guard-- > 0) {
      let sinking: DebrisItem | null = null;
      let standing: DebrisItem | null = null;
      for (const item of items.values()) {
        // A piece with no birth yet is this frame's and is nobody's oldest.
        if (item.bornMs < 0) continue;
        if (item.sink) {
          if (!sinking || item.sink.startedMs < sinking.sink!.startedMs) sinking = item;
        } else if (!standing || item.bornMs < standing.bornMs) {
          standing = item;
        }
      }
      if (sinking) {
        destroy(sinking);
        continue;
      }
      if (standing) {
        expire(standing, nowMs);
        continue;
      }
      // Everything is this frame's: the cap cannot be held against a single
      // burst bigger than itself, and dropping the fragments that arrived
      // first would be dropping the ones somebody is looking at.
      break;
    }
  };

  /** The last frame time this layer was given. A spawn before the first
   * frame is stamped by that frame (see `DebrisItem.bornMs`). */
  let lastNowMs = -1;

  const spawnChunk = (
    parent: DebrisParent,
    chunkIndex: number,
    x: number,
    y: number,
    z: number,
    q: LooseRotation,
    velocity?: { x: number; y: number; z: number },
  ): DebrisItem | null => {
    const chunk = chunkAt(parent.kind, parent.variant, chunkIndex);
    if (!chunk) return null;
    const key = `${parent.key}${CHUNK_SEPARATOR}${chunkIndex}`;
    const existing = items.get(key);
    if (existing) return existing;
    const nowMs = lastNowMs;
    makeRoom(Math.max(0, nowMs));
    const r = Math.max(0.05, chunk.radius * parent.scale);

    // The mesh, on every page. `show` is idempotent, so a fragment that was
    // already being drawn as part of a standing ruin keeps the one mesh it
    // has and simply starts moving.
    opts.loose.show(key, parent.kind, parent.variant, parent.scale);
    opts.loose.move(key, x, y, z, q);

    const item: DebrisItem = {
      key,
      parentKey: parent.key,
      kind: parent.kind,
      variant: parent.variant,
      chunkIndex,
      scale: parent.scale,
      r,
      bornMs: nowMs,
      lifetimeMs: debrisLifetimeMs(STICKY[parent.kind]),
      body: null,
      sink: null,
    };

    const physics = opts.physics();
    const bodies = opts.bodies();
    if (physics && bodies) {
      wireTake(bodies);
      const rapier = physics.rapier;
      // The hull of the fragment actually on screen, like a stone's — so a
      // piece of wall beds down on a face instead of rolling like a ball.
      // Restitution 0, here as everywhere: a bounce is forbidden at
      // confidence 1.00, however small (TASTE §2.1).
      const points = hullPoints(chunk.geometry, parent.scale, parent.scale, parent.scale);
      const desc =
        (points.length >= 12 ? rapier.ColliderDesc.convexHull(points) : null) ??
        rapier.ColliderDesc.ball(r);
      const body = physics.addRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setRotation(q)
          .setLinearDamping(ROCK_LINEAR_DAMPING)
          .setAngularDamping(ROCK_ANGULAR_DAMPING)
          .setCanSleep(true),
        desc
          .setRestitution(0)
          .setFriction(ROCK_FRICTION)
          .setDensity(DEBRIS_DENSITY)
          // So a falling chunk landing on a bush reaches the impact seam
          // (src/world/rocks.ts `onImpact`) — a chain reaction is only a
          // chain if the second link is reported.
          .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS),
      );
      if (velocity) body.setLinvel(velocity, true);
      item.body = body;
      const looseItem: LooseItem = {
        key,
        kind: parent.kind,
        variant: parent.variant,
        scale: parent.scale,
        // Drawn by src/world/loose.ts, not by an instance row: a fragment
        // never was a placement and has no row to write into.
        meshDrawn: true,
        x,
        z,
        r,
        body,
        colliderHandle: body.collider(0).handle,
        awake: true,
      };
      bodies.adopt(looseItem);
    }

    items.set(key, item);
    return item;
  };

  return {
    spawnChunk(parent, chunkIndex, x, y, z, q, velocity): DebrisItem | null {
      return spawnChunk(parent, chunkIndex, x, y, z, q, velocity);
    },

    spawnFragments(parent, chunkIndices, options = {}): DebrisItem[] {
      const impact = options.impact ?? 0;
      const speed = Math.min(FRAGMENT_SPEED_MAX, Math.abs(impact) * FRAGMENT_SPEED_PER_IMPACT);
      const out: DebrisItem[] = [];
      const cos = Math.cos(parent.rotY);
      const sin = Math.sin(parent.rotY);
      const baseY = opts.surface.sampleHeight(parent.x, parent.z);
      for (const index of chunkIndices) {
        const chunk = chunkAt(parent.kind, parent.variant, index);
        if (!chunk) continue;
        // The chunk's own seat in the prop, out of object space: scaled by
        // the instance, turned by the placement's yaw, and lifted off the
        // ground the seam reports under the prop — never a height of our own.
        const ox = chunk.offset.x * parent.scale;
        const oz = chunk.offset.z * parent.scale;
        const x = parent.x + ox * cos + oz * sin;
        const z = parent.z - ox * sin + oz * cos;
        const y = baseY + chunk.offset.y * parent.scale;
        // Outward from the middle, with a seeded jitter so the pieces are
        // not four spokes. A chunk sitting exactly on the axis has no
        // outward direction of its own and takes the jitter whole.
        const spread = fragmentSpread(parent.key, index);
        scratch.set(x - parent.x, 0, z - parent.z);
        if (scratch.lengthSq() < 1e-8) scratch.set(spread.x, 0, spread.z);
        else {
          scratch.normalize();
          scratch.x += spread.x * SPREAD_MIX;
          scratch.z += spread.z * SPREAD_MIX;
          scratch.normalize();
        }
        const velocity = {
          x: scratch.x * speed,
          y: options.down === true ? -COLLAPSE_DOWN_SPEED : 0,
          z: scratch.z * speed,
        };
        const item = spawnChunk(
          parent,
          index,
          x,
          y,
          z,
          // A fragment keeps the placement's own yaw: it was part of that
          // prop a moment ago and has not turned yet.
          { x: 0, y: Math.sin(parent.rotY / 2), z: 0, w: Math.cos(parent.rotY / 2) },
          velocity,
        );
        if (item) out.push(item);
      }
      return out;
    },

    has(key): boolean {
      return items.has(key);
    },

    update(_dtMs, nowMs): void {
      lastNowMs = nowMs;
      for (const item of [...items.values()]) {
        if (item.bornMs < 0) item.bornMs = nowMs;
        if (item.sink) {
          const object = opts.loose.get(item.key);
          const progress = Math.min(1, (nowMs - item.sink.startedMs) / SINK_MS);
          if (object) {
            // Smoothstepped, so the descent eases in and eases out rather
            // than starting and stopping dead — no cuts, no abrupt stops
            // (TASTE §2.1). It never reverses, so there is no rebound in it.
            const eased = progress * progress * (3 - 2 * progress);
            object.position.y = item.sink.fromY - eased * item.r * SINK_DEPTH_FACTOR;
          }
          if (progress >= 1) destroy(item);
          continue;
        }
        if (item.body) {
          const t = item.body.translation();
          const r = item.body.rotation();
          opts.loose.move(item.key, t.x, t.y, t.z, r);
        }
        if (Number.isFinite(item.lifetimeMs) && nowMs - item.bornMs >= item.lifetimeMs) {
          expire(item, nowMs);
        }
      }
    },

    count(): number {
      return items.size;
    },

    dispose(): void {
      for (const item of [...items.values()]) destroy(item);
      items.clear();
    },
  };
}
