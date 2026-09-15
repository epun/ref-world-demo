/**
 * Loose rocks, fixed prop bodies, and the tree recoil (PLAN §7).
 *
 * WHAT THIS IS FOR. The scatter draws a stone as an instance matrix and the
 * creature layer resolves against a footprint circle: a rock has always been
 * scenery that a walker slides around. This module makes every scattered
 * `rock` a DYNAMIC rigid body instead — it tumbles when something hits it,
 * beds down on the face it lands on, and stops. Every hard prop (trunks,
 * buildings, monoliths, mountains, …) becomes a FIXED cylinder, because a
 * rolling stone that passed straight through a tree would read as a bug
 * rather than as physics.
 *
 * THE SEAM (**[D]**, and the one thing not to lose here). PLAN §7.2:
 * locomotion never writes world-space Y, and no system derives a height of
 * its own. A rock's rendered Y is read off its rigid body — which is a
 * second height source only if you stop reading one line further. The body
 * rests on the terrain COLLIDER, and that collider is a heightfield sampled
 * from `Surface.sampleHeight` and nothing else (src/physics/world.ts). So
 * the seam still owns every height in the world; the solver only decides
 * where on that surface a stone comes to rest. The one place this module
 * writes a Y directly is the resurface safety net, and it reads the seam to
 * do it.
 *
 * NO BOUNCE. Restitution is 0 on every collider created here. Envpaint's
 * rocks ran 0.05 and its trunks 0.2; a rebound is a bounce, forbidden at
 * confidence 1.00 (TASTE §2.1). What replaces it is the settle trick below
 * — rapier has no rolling friction, so a landed stone gets its damping
 * raised hard and beds down instead of rolling on forever.
 *
 * ζ = 1, ALWAYS. The tree recoil is envpaint's per-tree sway spring with its
 * damping ratio changed: theirs is ζ = 0.35, which recoils past the
 * upright and back — a bounce in a trunk. Here it goes through
 * `src/motion/spring.ts`, which clamps ζ ≥ 1 at the API boundary and
 * registers with the damping audit, so the gate sees it and underdamped
 * recoil is unrepresentable.
 *
 * DETERMINISM. Placement stays pure and seeded (the scatter's header is the
 * contract). The SIMULATION is not bit-identical across devices, and that is
 * accepted: where a stone ends up after being kicked is cosmetic, nobody
 * replays it, and nothing downstream keys off it. What is still forbidden is
 * `Math.random` — nothing here calls it. Where envpaint randomised (spawn
 * spin, variant pick) this reads the placement's own hash
 * (`instanceVariation`) or simply does not vary.
 */

import {
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import type { PhysicsWorld } from '../physics/world';
import { Spring } from '../motion/spring';
import { MOTION, WORLD } from '../taste/tokens';
import { colliderFor, ROCK_SQUASH_Y, ROCK_WIDEN_XZ, type InstanceRef, type Scatter } from './scatter';
import { instanceVariation } from './scatter';
import { PROP_KINDS, type PropKind } from './props';
import type { Surface } from './surface';
import { windAt, type WindField } from './wind';

type RapierRigidBody = import('@dimforge/rapier3d-compat').RigidBody;

// ── the numbers (envpaint's, minus the bounce) ───────────────────────────────

/** A rock in flight: enough drag to thud rather than skate. */
export const ROCK_LINEAR_DAMPING = 0.4;
export const ROCK_ANGULAR_DAMPING = 2.5;
/** …and once it has landed and slowed, rolling resistance by brute force. */
export const SETTLE_LINEAR_DAMPING = 4;
export const SETTLE_ANGULAR_DAMPING = 9;
/** Below this speed a landed rock beds down (envpaint's `SETTLE_SPEED`). */
export const SETTLE_SPEED = 2.5;
export const ROCK_FRICTION = 1.4;
export const ROCK_DENSITY = 2.5;
export const PROP_FRICTION = 0.9;
/**
 * Convex-hull budget per rock collider. An inflated rock variant carries a
 * few thousand vertices and rapier's hull builder is superlinear in the
 * point count; 256 strided points keep every facet a stone can bed down on
 * while staying inside the init budget. The visual shape is untouched — this
 * is the collider only. **[D]**
 */
export const HULL_MAX_POINTS = 256;
/** A body deeper than this under the surface at its own x/z is re-seated. */
export const RESURFACE_DEPTH = 1.5;
/** Rocks smaller than this skitter in a strong gust (envpaint). */
export const SKITTER_MAX_RADIUS = 0.35;
/** …and only past this gust value. */
export const SKITTER_GUST = 0.8;
/** Impulse per unit mass per unit wind. */
export const SKITTER_IMPULSE = 0.02;

/** Largest lean the recoil may reach, radians (envpaint's `MAX_LEAN`). */
export const BEND_MAX = 0.45;
/** Recoil settle. From the tokens, never a literal. */
export const BEND_SETTLE_MS = MOTION.secondaryMs;
/**
 * How long the kick is HELD before the target returns to zero.
 *
 * A ζ=1 spring cannot cross its target, so a recoil has to be two
 * approaches rather than one oscillation: the trunk drifts toward the
 * struck lean for this long, then drifts back to upright. The bend peaks at
 * the release and never changes sign — a recoil with no rebound in it
 * (TASTE §2.1). Half a tertiary beat.
 */
export const BEND_HOLD_MS = MOTION.tertiaryMs / 2;
/** Below this the spring is retired and the row zeroed. */
const BEND_EPS = 1e-3;

/** Capacity of the dev drop-rock mesh (src/dev, `physics` folder). */
export const SPAWN_CAPACITY = 64;
/** Instance scale of a dropped rock. */
const SPAWN_SCALE = 0.8;

/** A dynamic rock: its body, where it was placed, and how big it reads. */
export interface LooseItem {
  key: string;
  kind: PropKind;
  variant: number;
  /** Placement x (the identity anchor — the live position is on the body). */
  x: number;
  z: number;
  /** Footprint radius at instance scale. */
  r: number;
  body: RapierRigidBody;
  colliderHandle: number;
  awake: boolean;
}

export interface PropBodies {
  /** True once the bodies for the current scatter exist. */
  readonly ready: boolean;
  /**
   * Reconcile bodies with the scatter as it now stands — call after every
   * `scatter.rebuild()` (scene.ts watches `scatter.rebuildVersion()`).
   *
   * New placements get bodies, vanished ones lose theirs, and a rock that
   * has MOVED keeps its transform: identity is the placement key, never the
   * live position, so a stone shoved twenty units downhill survives a
   * rebuild where it stands.
   */
  sync(): void;
  /** One frame: step, write transforms, resurface, settle, recoil, upload. */
  update(dtMs: number, nowMs: number): void;
  /** Live loose rocks (the katamari layer reads key, live translation, r). */
  items(): readonly LooseItem[];
  itemByCollider(handle: number): LooseItem | undefined;
  /** Pick a placement up: drop its body and tell the scatter to stop drawing
   * it. True when it existed. */
  take(key: string): boolean;
  /**
   * Kick a prop's recoil spring — the creature layer's handle, and what a
   * rock impact calls internally. `dirX`/`dirZ` are the direction the lean
   * goes (normalised here), `strength` the lean in radians before the
   * `BEND_MAX` cap.
   */
  bump(key: string, dirX: number, dirZ: number, strength: number): void;
  dispose(): void;
  // ── the dev surface (src/dev/index.ts `physics` folder) ─────────────────
  /** How many bodies exist, and how many are awake right now. */
  counts(): { bodies: number; awake: number; springs: number };
  /** Drop one dynamic rock at a point. Returns its key, or null when the
   * spawn mesh is full. Dev only; the mesh is built on first use, so a demo
   * build that never calls it never pays for it. */
  spawnRock(x: number, y: number, z: number): string | null;
  /** Wake every body (what the ground moving under them does). */
  wakeAll(): void;
}

export interface PropBodiesOptions {
  physics: PhysicsWorld;
  scatter: Scatter;
  surface: Surface;
  /**
   * The wind field. Read LIVE through `scatter.windField()` when the scatter
   * offers it — this is the declared seam and the fallback for a stub.
   */
  wind: WindField;
}

/** Fixed-body record for a hard prop. */
interface FixedProp {
  key: string;
  body: RapierRigidBody;
  colliderHandle: number;
}

/** A live recoil: one ζ=1 spring per world axis, plus the hold countdown. */
interface Recoil {
  x: Spring;
  z: Spring;
  holdMs: number;
}

/**
 * Stride an attribute's positions into at most `HULL_MAX_POINTS` points,
 * scaled to the instance. Pure.
 */
export function hullPoints(
  geometry: BufferGeometry,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  max: number = HULL_MAX_POINTS,
): Float32Array {
  const position = geometry.getAttribute('position');
  if (!position || position.count === 0) return new Float32Array(0);
  const stride = Math.max(1, Math.ceil(position.count / max));
  const n = Math.ceil(position.count / stride);
  const out = new Float32Array(n * 3);
  let w = 0;
  for (let i = 0; i < position.count; i += stride) {
    out[w++] = position.getX(i) * scaleX;
    out[w++] = position.getY(i) * scaleY;
    out[w++] = position.getZ(i) * scaleZ;
  }
  return out.subarray(0, w);
}

export function createPropBodies(opts: PropBodiesOptions): PropBodies {
  const { physics, scatter, surface } = opts;
  const rapier = physics.rapier;

  const matrix = new Matrix4();
  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();

  /** Loose rocks by placement key. */
  const rocks = new Map<string, LooseItem>();
  /** …and where each is drawn, so a transform can be written back. */
  const rockRefs = new Map<string, InstanceRef>();
  /** Per-rock simulation state the body itself does not carry. */
  const rockState = new Map<string, { landed: boolean; damped: boolean; scl: Vector3 }>();
  /** Fixed hard props by placement key. */
  const fixed = new Map<string, FixedProp>();
  /** Every collider handle → the key that owns it (rocks and props alike). */
  const byCollider = new Map<number, string>();
  /** Swaying props by key, for the recoil rows. */
  const swayRefs = new Map<string, InstanceRef>();
  /** Live recoil springs — only struck trees are iterated. */
  const recoils = new Map<string, Recoil>();
  /** Placements a creature has carried off. */
  const takenKeys = new Set<string>();

  const itemList: LooseItem[] = [];
  let itemsDirty = true;
  let ready = false;

  // Meshes whose instanceMatrix / aBend need one upload at the end of a frame.
  const dirtyMatrix = new Set<InstancedMesh>();
  const dirtyBend = new Set<InstancedMesh>();

  // ── the dev spawn mesh, built on first use ────────────────────────────────
  let spawnMesh: InstancedMesh | null = null;
  let spawnMaterial: MeshStandardMaterial | null = null;
  let spawnCount = 0;
  let spawnSerial = 0;

  const removeBody = (body: RapierRigidBody, handle: number): void => {
    byCollider.delete(handle);
    physics.remove(body);
  };

  /** The collider handle of a body's one collider. */
  const handleOf = (body: RapierRigidBody): number => body.collider(0).handle;

  /** One `needsUpdate` per touched mesh, never one per instance. */
  const flushMatrices = (): void => {
    for (const mesh of dirtyMatrix) mesh.instanceMatrix.needsUpdate = true;
    dirtyMatrix.clear();
  };

  /** Read an instance's drawn transform out of its mesh. */
  const readInstance = (ref: InstanceRef): void => {
    ref.mesh.getMatrixAt(ref.index, matrix);
    matrix.decompose(pos, quat, scl);
  };

  const rockCollider = (
    geometry: BufferGeometry | null,
    sx: number,
    sy: number,
    sz: number,
    fallbackRadius: number,
  ): import('@dimforge/rapier3d-compat').ColliderDesc => {
    // The hull of the rock's own facets, so it beds down on a face instead
    // of rolling forever the way a ball would. A ball is the fallback.
    const hull = geometry ? hullPoints(geometry, sx, sy, sz) : null;
    const desc =
      (hull && hull.length >= 12 ? rapier.ColliderDesc.convexHull(hull) : null) ??
      rapier.ColliderDesc.ball(Math.max(0.05, fallbackRadius));
    return desc
      .setRestitution(0)
      .setFriction(ROCK_FRICTION)
      .setDensity(ROCK_DENSITY)
      // Tree impacts are reported through these.
      .setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
  };

  const createRock = (ref: InstanceRef): void => {
    const p = ref.placement;
    readInstance(ref);
    const desc = rapier.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setLinearDamping(ROCK_LINEAR_DAMPING)
      .setAngularDamping(ROCK_ANGULAR_DAMPING)
      .setCanSleep(true)
      // Asleep until disturbed: a field of four hundred stones costs nothing
      // until a creature walks into one.
      .setSleeping(true);
    const geometry = scatter.geometryFor('rock', p.variant);
    const body = physics.addRigidBody(
      desc,
      rockCollider(geometry, scl.x, scl.y, scl.z, ref.radius),
    );
    const handle = handleOf(body);
    byCollider.set(handle, ref.key);
    rocks.set(ref.key, {
      key: ref.key,
      kind: 'rock',
      variant: p.variant,
      x: p.x,
      z: p.z,
      r: ref.radius,
      body,
      colliderHandle: handle,
      awake: false,
    });
    // Already seated on the ground by the placement, so it counts as landed
    // and is damped hard from the start — a stone the world opens with must
    // not creep.
    rockState.set(ref.key, { landed: true, damped: false, scl: scl.clone() });
    itemsDirty = true;
  };

  /**
   * Half-height of a hard prop's cylinder.
   *
   * The rule: the variant's own visual footprint radius at instance scale
   * (`InstanceRef.radius`), floored by the footprint the creature layer
   * blocks at. That makes the body as tall as the prop is wide — a couple of
   * units for a trunk, a dozen for a mountain — which is the cheapest shape
   * that a rolling stone provably cannot hop, without modelling a canopy
   * that nothing on the ground can reach anyway. **[D]**
   */
  const propHalfHeight = (ref: InstanceRef, footprintR: number): number =>
    Math.max(ref.radius, footprintR, 0.25);

  const createFixed = (ref: InstanceRef, footprintR: number): void => {
    readInstance(ref);
    const half = propHalfHeight(ref, footprintR);
    const body = physics.addRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y + half, pos.z),
      rapier.ColliderDesc.cylinder(half, footprintR)
        .setFriction(PROP_FRICTION)
        // Envpaint's trunks used 0.2. A trunk that bounces a stone back is a
        // bounce (TASTE §2.1).
        .setRestitution(0),
    );
    const handle = handleOf(body);
    byCollider.set(handle, ref.key);
    fixed.set(ref.key, { key: ref.key, body, colliderHandle: handle });
  };

  /** The hard footprint radius of a placement, or null when it has none. */
  const hardFootprint = (ref: InstanceRef): number | null => {
    const p = ref.placement;
    if (p.kind === 'rock') return null;
    // Recover the per-kind dials from the ref: `scale` is placement × kind
    // multiplier, and `radius` is the variant radius at that scale.
    const kindMult = p.scale > 0 ? ref.scale / p.scale : 1;
    const baseRadius = ref.scale > 0 ? ref.radius / ref.scale : ref.radius;
    const c = colliderFor(p, baseRadius, kindMult);
    if (!c || !c.hard || c.r <= 0) return null;
    return c.r;
  };

  const sync = (): void => {
    const seenRocks = new Set<string>();
    const seenFixed = new Set<string>();
    /**
     * Rocks that already had a body before this rebuild. Their bodies are
     * KEPT — identity is the placement key, so a stone shoved downhill is
     * still that stone — but `rebuild()` has just reset every instance
     * matrix to the placement pose, and `update()` will not put a SLEEPING
     * rock's transform back (it skips anything asleep whose `awake` flag is
     * already false). A rock that rolled away and then bedded down would be
     * drawn back at its original spot with its collider still where it
     * rolled: an invisible stone for a creature to walk into. So every
     * survivor is written back once, here.
     */
    const survivors: InstanceRef[] = [];
    rockRefs.clear();
    swayRefs.clear();

    for (const kind of PROP_KINDS) {
      for (const ref of scatter.instanceRefs(kind)) {
        if (kind === 'rock') {
          rockRefs.set(ref.key, ref);
          seenRocks.add(ref.key);
          if (rocks.has(ref.key)) survivors.push(ref);
          else createRock(ref);
          continue;
        }
        // Swaying kinds carry the recoil row whether or not they are hard.
        if (ref.mesh.geometry.getAttribute('aBend')) swayRefs.set(ref.key, ref);
        const footprintR = hardFootprint(ref);
        if (footprintR === null) continue;
        seenFixed.add(ref.key);
        const existing = fixed.get(ref.key);
        if (existing) {
          // Survivor: the ground may have moved under it, so re-seat it.
          readInstance(ref);
          const half = propHalfHeight(ref, footprintR);
          existing.body.setTranslation({ x: pos.x, y: pos.y + half, z: pos.z }, false);
        } else {
          createFixed(ref, footprintR);
        }
      }
    }

    // Survivors: re-read the scale the rebuild drew them at (a per-kind
    // scale dial may have moved under them) and put the body's own
    // transform back into the fresh row.
    for (const ref of survivors) {
      const item = rocks.get(ref.key);
      const state = rockState.get(ref.key);
      if (!item || !state) continue;
      readInstance(ref);
      state.scl.copy(scl);
      item.r = ref.radius;
      writeRock(item);
    }

    for (const [key, item] of rocks) {
      // Spawned rocks are not placements — they survive every rebuild.
      if (seenRocks.has(key) || key.startsWith('spawn')) continue;
      removeBody(item.body, item.colliderHandle);
      rocks.delete(key);
      rockState.delete(key);
      itemsDirty = true;
    }
    for (const [key, prop] of fixed) {
      if (seenFixed.has(key)) continue;
      removeBody(prop.body, prop.colliderHandle);
      fixed.delete(key);
    }
    // A recoil whose tree is gone has nothing to write into.
    for (const [key, recoil] of recoils) {
      if (swayRefs.has(key)) continue;
      recoil.x.dispose();
      recoil.z.dispose();
      recoils.delete(key);
    }
    // Upload whatever the survivor pass wrote. `sync` is called immediately
    // before `update` in the loop, which would flush it anyway — but a
    // reconcile has to leave the meshes correct on its own, not depend on
    // being followed by a frame.
    flushMatrices();
    ready = true;
  };

  const bump = (key: string, dirX: number, dirZ: number, strength: number): void => {
    const ref = swayRefs.get(key);
    if (!ref) return;
    const len = Math.hypot(dirX, dirZ);
    if (!(len > 0)) return;
    const mag = Math.min(BEND_MAX, Math.abs(strength));
    if (!(mag > 0)) return;
    let recoil = recoils.get(key);
    if (!recoil) {
      recoil = {
        x: new Spring(0, { settleMs: BEND_SETTLE_MS }),
        z: new Spring(0, { settleMs: BEND_SETTLE_MS }),
        holdMs: 0,
      };
      recoils.set(key, recoil);
    }
    // Retarget mid-flight: position and velocity carry over, so a second hit
    // while the trunk is still recovering is continuous (src/motion/spring.ts).
    recoil.x.retarget((dirX / len) * mag);
    recoil.z.retarget((dirZ / len) * mag);
    recoil.holdMs = BEND_HOLD_MS;
  };

  /** A contact between a rock and a swaying prop kicks the prop. */
  const handleContact = (a: number, b: number): void => {
    const keyA = byCollider.get(a);
    const keyB = byCollider.get(b);
    if (keyA === undefined || keyB === undefined) return;
    const rockA = rocks.get(keyA);
    const rockB = rocks.get(keyB);
    const rock = rockA ?? rockB;
    const propKey = rockA ? keyB : keyA;
    if (!rock || (rockA && rockB)) return;
    if (!swayRefs.has(propKey)) return;
    const v = rock.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    if (!(speed > 0)) return;
    // 6 u/s is about as fast as a shoved stone travels on this terrain, so
    // that is full strength; anything slower reads as a nudge.
    bump(propKey, v.x, v.z, Math.min(1, speed / 6));
  };

  const writeRock = (item: LooseItem): void => {
    const ref = rockRefs.get(item.key);
    const state = rockState.get(item.key);
    if (!ref || !state) return;
    const t = item.body.translation();
    const r = item.body.rotation();
    pos.set(t.x, t.y, t.z);
    quat.set(r.x, r.y, r.z, r.w);
    ref.mesh.setMatrixAt(ref.index, matrix.compose(pos, quat, state.scl));
    dirtyMatrix.add(ref.mesh);
  };

  /** Envpaint's safety net: a body that ended up under the ground (a solver
   * escape, or terrain sculpted up from under it) is put back on the
   * surface, at rest. The Y comes from the seam. */
  const resurface = (item: LooseItem): void => {
    const t = item.body.translation();
    const y = surface.sampleHeight(t.x, t.z) + item.r;
    item.body.setTranslation({ x: t.x, y, z: t.z }, true);
    item.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    item.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    item.awake = true;
    writeRock(item);
  };

  const update = (dtMs: number, nowMs: number): void => {
    const events = physics.step(dtMs);
    for (const event of events) {
      if (!event.started) continue;
      handleContact(event.a, event.b);
    }

    const field = scatter.windField ? scatter.windField() : opts.wind;
    const tSeconds = nowMs / 1000;

    for (const item of rocks.values()) {
      const sleeping = item.body.isSleeping();
      if (sleeping && !item.awake) continue;
      item.awake = !sleeping;
      const state = rockState.get(item.key);
      if (!state) continue;

      const t = item.body.translation();
      if (t.y < surface.sampleHeight(t.x, t.z) - RESURFACE_DEPTH) {
        resurface(item);
        continue;
      }
      writeRock(item);

      const v = item.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);

      // Small rocks skitter in a strong gust — cheap, charming, and the same
      // field the shader is bending the grass with.
      if (item.r < SKITTER_MAX_RADIUS && field.gust > SKITTER_GUST) {
        const w = windAt(t.x, t.z, tSeconds, field);
        const m = item.body.mass() * SKITTER_IMPULSE;
        item.body.applyImpulse({ x: w.x * m, y: 0, z: w.z * m }, false);
      }

      if (!state.landed) {
        if (t.y - surface.sampleHeight(t.x, t.z) < item.r + 0.35) state.landed = true;
      } else if (!state.damped && speed < SETTLE_SPEED) {
        // Rolling resistance by brute force: rapier has none of its own, so
        // a stone that has slowed gets damped hard and beds down where it
        // is instead of rolling on forever.
        state.damped = true;
        item.body.setLinearDamping(SETTLE_LINEAR_DAMPING);
        item.body.setAngularDamping(SETTLE_ANGULAR_DAMPING);
      }
    }

    // The recoil springs. Only struck props are in this map.
    for (const [key, recoil] of recoils) {
      if (recoil.holdMs > 0) {
        recoil.holdMs -= dtMs;
        if (recoil.holdMs <= 0) {
          // Release: the target returns to upright and the trunk drifts back.
          recoil.x.retarget(0);
          recoil.z.retarget(0);
        }
      }
      const bx = recoil.x.update(dtMs);
      const bz = recoil.z.update(dtMs);
      const ref = swayRefs.get(key);
      if (ref) {
        const attr = ref.mesh.geometry.getAttribute('aBend') as
          | InstancedBufferAttribute
          | undefined;
        if (attr) {
          attr.setXY(ref.index, bx, bz);
          dirtyBend.add(ref.mesh);
        }
      }
      if (recoil.holdMs <= 0 && Math.abs(bx) < BEND_EPS && Math.abs(bz) < BEND_EPS) {
        recoil.x.dispose();
        recoil.z.dispose();
        recoils.delete(key);
      }
    }

    flushMatrices();
    for (const mesh of dirtyBend) {
      const attr = mesh.geometry.getAttribute('aBend');
      if (attr) attr.needsUpdate = true;
    }
    dirtyBend.clear();
  };

  sync();

  return {
    get ready(): boolean {
      return ready;
    },
    sync,
    update,
    items(): readonly LooseItem[] {
      if (itemsDirty) {
        itemList.length = 0;
        for (const item of rocks.values()) itemList.push(item);
        itemsDirty = false;
      }
      return itemList;
    },
    itemByCollider(handle: number): LooseItem | undefined {
      const key = byCollider.get(handle);
      return key === undefined ? undefined : rocks.get(key);
    },
    take(key: string): boolean {
      const item = rocks.get(key);
      const prop = fixed.get(key);
      // A swaying prop with no hard footprint (a bush) has no body at all
      // and is still takeable — it is a placement the scatter draws.
      if (!item && !prop && !swayRefs.has(key)) return false;
      if (item) {
        removeBody(item.body, item.colliderHandle);
        rocks.delete(key);
        rockState.delete(key);
        rockRefs.delete(key);
        itemsDirty = true;
      }
      if (prop) {
        removeBody(prop.body, prop.colliderHandle);
        fixed.delete(key);
      }
      takenKeys.add(key);
      // The scatter stops drawing it AND stops reporting it as a collider or
      // a position — one filter, no second path.
      scatter.setTaken(new Set(takenKeys));
      return true;
    },
    bump,
    counts(): { bodies: number; awake: number; springs: number } {
      let awake = 0;
      for (const item of rocks.values()) if (!item.body.isSleeping()) awake++;
      return { bodies: rocks.size + fixed.size, awake, springs: recoils.size };
    },
    spawnRock(x: number, y: number, z: number): string | null {
      if (spawnCount >= SPAWN_CAPACITY) return null;
      const geometry = scatter.geometryFor('rock', 0);
      if (!geometry) return null;
      if (!spawnMesh) {
        // Mid-tone stone, like the scatter's own rocks: eggs are the
        // palette's light role and must stay the only light lumps on the
        // field. Built on first use so a build that never drops a rock never
        // pays for the mesh.
        spawnMaterial = new MeshStandardMaterial({
          color: WORLD.neutral,
          roughness: 1,
          metalness: 0,
        });
        spawnMesh = new InstancedMesh(geometry, spawnMaterial, SPAWN_CAPACITY);
        spawnMesh.name = `rock-dropped (0)`;
        spawnMesh.frustumCulled = false;
        spawnMesh.count = 0;
        scatter.group.add(spawnMesh);
      }
      const index = spawnCount++;
      spawnMesh.count = spawnCount;
      const key = `spawn:${spawnSerial++}`;
      const sx = SPAWN_SCALE * ROCK_WIDEN_XZ;
      const sy = SPAWN_SCALE * ROCK_SQUASH_Y;
      // A dropped stone needs a spin, and envpaint rolled one at random.
      // Here it comes from the placement hash family instead — same look,
      // no unseeded randomness anywhere in this repo.
      const v = instanceVariation(x, z);
      quat.setFromAxisAngle(
        new Vector3(v[0] - 0.5, v[1] - 0.5, v[2] - 0.5).normalize(),
        v[3] * Math.PI * 2,
      );
      const body = physics.addRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setLinearDamping(ROCK_LINEAR_DAMPING)
          .setAngularDamping(ROCK_ANGULAR_DAMPING)
          .setCanSleep(true),
        rockCollider(geometry, sx, sy, sx, SPAWN_SCALE),
      );
      const handle = handleOf(body);
      byCollider.set(handle, key);
      const item: LooseItem = {
        key,
        kind: 'rock',
        variant: 0,
        x,
        z,
        r: SPAWN_SCALE * ROCK_WIDEN_XZ,
        body,
        colliderHandle: handle,
        awake: true,
      };
      rocks.set(key, item);
      rockState.set(key, { landed: false, damped: false, scl: new Vector3(sx, sy, sx) });
      rockRefs.set(key, {
        key,
        placement: { kind: 'rock', variant: 0, x, z, scale: SPAWN_SCALE, rotY: 0 },
        mesh: spawnMesh,
        index,
        scale: SPAWN_SCALE,
        radius: item.r,
      });
      itemsDirty = true;
      writeRock(item);
      spawnMesh.instanceMatrix.needsUpdate = true;
      return key;
    },
    wakeAll(): void {
      physics.world.forEachRigidBody((body) => body.wakeUp());
      for (const item of rocks.values()) item.awake = true;
    },
    dispose(): void {
      for (const item of rocks.values()) removeBody(item.body, item.colliderHandle);
      for (const prop of fixed.values()) removeBody(prop.body, prop.colliderHandle);
      rocks.clear();
      fixed.clear();
      rockState.clear();
      rockRefs.clear();
      swayRefs.clear();
      byCollider.clear();
      for (const recoil of recoils.values()) {
        recoil.x.dispose();
        recoil.z.dispose();
      }
      recoils.clear();
      if (spawnMesh) {
        spawnMesh.removeFromParent();
        spawnMesh.dispose();
        spawnMesh = null;
      }
      spawnMaterial?.dispose();
      spawnMaterial = null;
      spawnCount = 0;
      itemsDirty = true;
      ready = false;
    },
  };
}
