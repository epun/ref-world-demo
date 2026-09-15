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

/**
 * [D] How far a body has to have travelled from its last reported pose
 * before coming to rest is worth telling the room about, world units.
 *
 * Half a unit is under a small stone's own diameter — below it a body that
 * woke, twitched and slept again has not moved anywhere anybody can see,
 * and reporting it would put a packet on a free public broker for nothing.
 */
export const SETTLE_REPORT_MIN_MOVE = 0.5;

/** At most one settle report per item per beat. From the tokens, never a
 * literal: a body that keeps waking and sleeping under a crowd's feet is
 * one event a beat, not one a frame. */
export const SETTLE_REPORT_MIN_GAP_MS = MOTION.secondaryMs;

/** A dynamic rock: its body, where it was placed, and how big it reads. */
export interface LooseItem {
  key: string;
  kind: PropKind;
  variant: number;
  /** Uniform instance scale it is drawn at — what `src/world/loose.ts`
   * needs to build a mesh for it on a page that never had it instanced. */
  scale: number;
  /**
   * Who draws it.
   *
   * `false` — the scatter still has an instance row for this placement and
   * `writeRock` pushes the body's transform into it. That is every scattered
   * stone and every dev-dropped one, and it is the cheap path.
   *
   * `true` — the scatter has been told to stop drawing it (`setTaken`), so
   * `src/world/loose.ts` draws it as a mesh of its own. That is anything
   * `loosen` knocked out of the ground and anything `restore` put back after
   * a carrier shed it. Deliberately the SAME path a viewer with no physics at
   * all uses, so the host and the room cannot end up looking at
   * differently-placed fallen trees.
   */
  meshDrawn: boolean;
  /** Placement x (the identity anchor — the live position is on the body). */
  x: number;
  z: number;
  /** Footprint radius at instance scale. */
  r: number;
  body: RapierRigidBody;
  colliderHandle: number;
  awake: boolean;
}

/**
 * One side of a contact, named.
 *
 * The seam's whole job is to say WHAT hit WHAT: rapier reports two collider
 * handles, and the only module that can turn a handle into a thing is this
 * one (it owns the map). `kind` is a `PropKind` for a prop or a loose item,
 * `'chunk'` for a fragment of a broken one (whose key is
 * `<placementKey>#<index>`) and `'creature'` for a collider the creature
 * layer registered — its kinematic ball, or one of the balls hanging off it
 * for a stuck item, which is how a stuck bench swinging into a sign gets to
 * count as the CARRIER hitting the sign.
 *
 * `rooted` is the field the routing actually turns on, and it is here rather
 * than looked up from `STICKY[kind]` because the same kind is both: a
 * standing tree is rooted and the tree lying next to it is not.
 */
export interface ImpactSide {
  /** Placement key, chunk key, or — for a creature — its slot id. */
  key: string;
  kind: PropKind | 'creature' | 'chunk';
  /** Footprint radius as drawn, world units. */
  r: number;
  x: number;
  z: number;
  /** Still in the ground. False for every loose item, chunk and creature. */
  rooted: boolean;
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
  /**
   * Knock a ROOTED prop out of the ground (src/creatures/sticky.ts decides
   * when). Its fixed cylinder goes, the scatter stops drawing it
   * (`setTaken`, the one filter), and a dynamic body built from its own
   * geometry hull takes its place — so from this moment it is in `items()`
   * and can be shoved, carried and dropped like a stone.
   *
   * Returns the item, or null when that key is not a standing fixed prop
   * (already loose, already taken, never existed).
   *
   * It is NOT drawn by this module afterwards: a loosened tree has no
   * instance row left, so `src/world/loose.ts` draws it — the same path a
   * viewer with no physics at all uses, which is how the host and the room
   * end up looking at the same fallen tree.
   */
  loosen(key: string): LooseItem | null;
  /**
   * Put a DROPPED item back into the world as a free body at (x, z) with
   * rotation `q`, the mirror of `take`.
   *
   * The seed rather than a key, because by the time a carrier sheds
   * something the placement it came from may have been rebuilt away — the
   * clump is the only thing that still knows what the item was.
   */
  restore(
    seed: { key: string; kind: PropKind; variant: number; scale: number; r: number },
    x: number,
    z: number,
    q: { x: number; y: number; z: number; w: number },
  ): LooseItem | null;
  /**
   * Called when a body that had been moving comes to rest.
   *
   * The seam the `settle` scene event hangs on, and the reason it is here
   * rather than in the creature layer: this module is the only thing that
   * knows a rapier body went to sleep. Rate-limited per item
   * (SETTLE_REPORT_MIN_GAP_MS) and only for a body that actually moved
   * (SETTLE_REPORT_MIN_MOVE), so a field of four hundred sleeping stones
   * reports nothing at all.
   */
  onSettle(cb: (item: LooseItem) => void): void;
  /**
   * Called for every STARTED contact in which at least one side is a loose
   * item, a chunk, or a collider the creature layer registered — the seam
   * the destruction rules hang on (docs/PLAN.md §7.6).
   *
   * WHY IT HAD TO EXIST. Until this, a prop came out of the ground only off
   * the pure resolve's own hard contacts — which is a creature walking into
   * a trunk, and nothing else. Everything the brief asks for beyond that is
   * one thing hitting another thing: *"attached objects stay dangerous (a
   * stuck bench swinging into a sign knocks it loose)"*, and a falling chunk
   * landing on a bush. Those contacts exist in rapier and nowhere else, and
   * `update()` was already draining the event queue to kick tree recoils.
   *
   * `speed` is the RELATIVE speed of the two bodies. A creature's stand-in
   * is kinematic and reports a `linvel` of zero, so what this reports is the
   * item's own speed — which is the right number either way: what matters is
   * how fast the gap between them was closing.
   */
  onImpact(cb: (a: ImpactSide, b: ImpactSide, speed: number) => void): void;
  /** Called when `take` removes an item — what the debris layer listens to,
   * so a fragment a creature has just picked up stops being debris. */
  onTake(cb: (key: string) => void): void;
  /**
   * Name a collider this module did not create, so `onImpact` can report it.
   *
   * The creature layer's kinematic balls live on bodies it owns
   * (src/creatures/manager.ts), and it is the only thing that knows which
   * slot one belongs to. The side object is held BY REFERENCE and read at
   * fire time, so a caller that keeps its `r`/`x`/`z` up to date as the pile
   * grows and rolls gets a truthful report without re-registering.
   */
  registerForeign(handle: number, side: ImpactSide): void;
  unregisterForeign(handle: number): void;
  /**
   * Take ownership of a body somebody else built — how a piece of debris
   * becomes collectable (src/world/debris.ts).
   *
   * An adopted item is in `items()`, so the katamari pickup pass sees it; it
   * gets the settle report and the resurface safety net like any stone; and
   * it SURVIVES a scatter rebuild, because it never was a placement and its
   * absence from `instanceRefs` means nothing. It is drawn by
   * `src/world/loose.ts` (`meshDrawn`), never by an instance row.
   */
  adopt(item: LooseItem): void;
  /** Let an adopted item go WITHOUT hiding a placement — the expiry path.
   * `take` is the pickup path and hides the placement it came from; a chunk
   * has no placement, so the two cannot be the same call. */
  release(key: string): boolean;
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
  /**
   * EVERY non-rock placement by key, rock or not, hard or not.
   *
   * `swayRefs` is the recoil channel and `fixed` is the collider; neither
   * of them is "what shape is this and how big is it drawn", which is what
   * `loosen` needs to build a hull and what the creature layer needs to
   * describe the item to the rest of the room.
   */
  const propRefs = new Map<string, InstanceRef>();
  /** Live recoil springs — only struck trees are iterated. */
  const recoils = new Map<string, Recoil>();
  /** Placements a creature has carried off. */
  const takenKeys = new Set<string>();
  /** Per item: where its rest was last reported, and when. */
  const settleState = new Map<string, { x: number; z: number; atMs: number }>();
  const settleListeners: ((item: LooseItem) => void)[] = [];
  /** The impact seam's listeners and the foreign colliders it can name. */
  const impactListeners: ((a: ImpactSide, b: ImpactSide, speed: number) => void)[] = [];
  const takeListeners: ((key: string) => void)[] = [];
  const foreign = new Map<number, ImpactSide>();
  /**
   * Items somebody else built and handed over (`adopt`).
   *
   * Kept apart from `rocks` for exactly one reason: `sync` deletes a body
   * whose placement has vanished from the scatter, and an adopted item never
   * was a placement — its absence from `instanceRefs` is not news.
   */
  const adopted = new Set<string>();

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
      scale: ref.scale,
      meshDrawn: false,
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
    propRefs.clear();

    for (const kind of PROP_KINDS) {
      for (const ref of scatter.instanceRefs(kind)) {
        if (kind === 'rock') {
          rockRefs.set(ref.key, ref);
          seenRocks.add(ref.key);
          if (rocks.has(ref.key)) survivors.push(ref);
          else createRock(ref);
          continue;
        }
        propRefs.set(ref.key, ref);
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
      // Neither is a LOOSENED prop or a dropped item: the scatter has been
      // told to stop drawing those (`takenKeys`), so they are absent from
      // `instanceRefs` on purpose and a rebuild must not read that absence
      // as "this placement is gone" and delete the body under a tree that
      // is lying in the field.
      if (
        seenRocks.has(key) ||
        key.startsWith('spawn') ||
        takenKeys.has(key) ||
        adopted.has(key)
      ) {
        continue;
      }
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

  /**
   * What the collider with this handle IS, or null when nothing here knows.
   *
   * Three answers in order of who owns the handle: a collider the creature
   * layer registered, a loose body of ours, or a standing placement. A
   * handle belonging to the terrain heightfield — or to a placement whose
   * ref went stale in a rebuild — is nobody's and reports nothing, which is
   * the right outcome: a rule that fired on "something unknown" would fire
   * on the ground.
   */
  const sideOf = (handle: number): ImpactSide | null => {
    const registered = foreign.get(handle);
    if (registered) return registered;
    const key = byCollider.get(handle);
    if (key === undefined) return null;
    const item = rocks.get(key);
    if (item) {
      const t = item.body.translation();
      return {
        key,
        // A chunk's key carries the `#index` suffix its parent's does not —
        // that IS the distinction, and it is the same one the item ids on
        // the wire make (src/session/scene.ts `ITEM_ID`).
        kind: key.includes('#') ? 'chunk' : item.kind,
        r: item.r,
        x: t.x,
        z: t.z,
        rooted: false,
      };
    }
    const ref = propRefs.get(key);
    if (!ref) return null;
    return {
      key,
      kind: ref.placement.kind as PropKind,
      r: ref.radius,
      x: ref.placement.x,
      z: ref.placement.z,
      rooted: true,
    };
  };

  /** A loose body's own velocity; zero for anything that is not one (a
   * standing prop, and a creature's kinematic stand-in, which reports zero
   * anyway). */
  const velocityOf = (handle: number): { x: number; y: number; z: number } => {
    const key = byCollider.get(handle);
    const item = key === undefined ? undefined : rocks.get(key);
    if (!item) return { x: 0, y: 0, z: 0 };
    return item.body.linvel();
  };

  /**
   * Report one contact to the impact seam.
   *
   * The gate is "at least one side is something that MOVED" — a loose item,
   * a chunk, or a creature's collider. Two standing props cannot hit each
   * other, and the terrain is not a side at all.
   */
  const reportImpact = (a: number, b: number): void => {
    if (impactListeners.length === 0) return;
    const sideA = sideOf(a);
    const sideB = sideOf(b);
    if (!sideA || !sideB) return;
    if (sideA.rooted && sideB.rooted) return;
    const va = velocityOf(a);
    const vb = velocityOf(b);
    const speed = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);
    for (const cb of impactListeners) cb(sideA, sideB, speed);
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

  /**
   * A free body built from a placement's own geometry, at (x, y, z).
   *
   * The rock path, reused: the hull of the shape actually on screen so the
   * thing beds down on a face, restitution 0, contact events on. Shared by
   * `loosen` (a prop coming out of the ground) and `restore` (an item a
   * carrier shed), which differ only in what they take away first.
   */
  const createFreeBody = (
    kind: PropKind,
    variant: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    radius: number,
    x: number,
    y: number,
    z: number,
    rotation: { x: number; y: number; z: number; w: number },
  ): RapierRigidBody => {
    const geometry = scatter.geometryFor(kind, variant);
    return physics.addRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(rotation)
        .setLinearDamping(ROCK_LINEAR_DAMPING)
        .setAngularDamping(ROCK_ANGULAR_DAMPING)
        .setCanSleep(true),
      rockCollider(geometry, scaleX, scaleY, scaleZ, radius),
    );
  };

  const loosen = (key: string): LooseItem | null => {
    if (rocks.has(key) || takenKeys.has(key)) return null;
    const ref = propRefs.get(key);
    if (!ref) return null;
    const prop = fixed.get(key);
    readInstance(ref);
    const spawnX = pos.x;
    const spawnZ = pos.z;
    // Lifted by its own footprint before the hull goes in: the instance sits
    // with its ORIGIN on the ground (that is how the scatter seats it), and a
    // hull whose points run from 0 upward, dropped in at ground level, starts
    // the frame intersecting the terrain collider. Half its own reach is the
    // cheapest lift that is provably clear, and the height itself comes off
    // the seam (PLAN §7.2) — never a constant.
    const lift = Math.max(ref.radius, 0.25);
    const spawnY = surface.sampleHeight(spawnX, spawnZ) + lift;
    if (prop) {
      removeBody(prop.body, prop.colliderHandle);
      fixed.delete(key);
    }
    const body = createFreeBody(
      ref.placement.kind as PropKind,
      ref.placement.variant,
      scl.x,
      scl.y,
      scl.z,
      ref.radius,
      spawnX,
      spawnY,
      spawnZ,
      { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
    );
    const handle = handleOf(body);
    byCollider.set(handle, key);
    const item: LooseItem = {
      key,
      kind: ref.placement.kind as PropKind,
      variant: ref.placement.variant,
      scale: ref.scale,
      meshDrawn: true,
      x: ref.placement.x,
      z: ref.placement.z,
      r: ref.radius,
      body,
      colliderHandle: handle,
      awake: true,
    };
    rocks.set(key, item);
    // No instance row: `src/world/loose.ts` draws it from here, on this page
    // and on every other one. `landed` is false so the settle damping only
    // kicks in once it has come down.
    rockState.set(key, { landed: false, damped: false, scl: scl.clone() });
    itemsDirty = true;
    // The scatter stops drawing the standing version — the SAME filter a
    // pickup uses, so there is one way for a prop to stop being scenery.
    takenKeys.add(key);
    scatter.setTaken(new Set(takenKeys));
    // `setTaken` rebuilds, which invalidates every ref this module holds.
    // The loop calls `sync` on the next version bump; until then the refs
    // for the survivors are stale, and this key is not among them.
    return item;
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
      // The same queue, read once more: the recoil above is presentation and
      // the seam below is where the destruction rules get their contacts
      // (docs/PLAN.md §7.6). Both off one drain — a second `step` would be a
      // second simulation.
      reportImpact(event.a, event.b);
    }

    const field = scatter.windField ? scatter.windField() : opts.wind;
    const tSeconds = nowMs / 1000;

    for (const item of rocks.values()) {
      const sleeping = item.body.isSleeping();
      if (sleeping && !item.awake) continue;
      // The moment a body that had been moving stops: this frame it is
      // asleep and last frame it was not. The one seam a `settle` event can
      // hang on (see PropBodies.onSettle) — the alternative is a per-frame
      // position sample, which the session format forbids outright.
      if (sleeping && item.awake && settleListeners.length > 0) {
        const t = item.body.translation();
        const last = settleState.get(item.key);
        const moved = last ? Math.hypot(t.x - last.x, t.z - last.z) : Infinity;
        const aged = !last || nowMs - last.atMs >= SETTLE_REPORT_MIN_GAP_MS;
        if (moved >= SETTLE_REPORT_MIN_MOVE && aged) {
          settleState.set(item.key, { x: t.x, z: t.z, atMs: nowMs });
          for (const cb of settleListeners) cb(item);
        }
      }
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
      /*
       * AN ADOPTED ITEM HAS NO PLACEMENT. A chunk of a broken building is
       * not in the scatter and never was, so there is nothing for `setTaken`
       * to hide — and putting a chunk key into the taken set would rebuild
       * the whole scatter on every fragment somebody picks up, for no
       * change in what is drawn.
       */
      if (item && adopted.has(key)) {
        removeBody(item.body, item.colliderHandle);
        rocks.delete(key);
        rockState.delete(key);
        adopted.delete(key);
        itemsDirty = true;
        for (const cb of takeListeners) cb(key);
        return true;
      }
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
      for (const cb of takeListeners) cb(key);
      return true;
    },
    bump,
    loosen,
    restore(seed, x, z, q): LooseItem | null {
      if (rocks.has(seed.key)) return null;
      const lift = Math.max(seed.r, 0.25);
      // The seam owns the height a dropped thing appears at, as it owns
      // every other height in the world (PLAN §7.2).
      const y = surface.sampleHeight(x, z) + lift;
      const widen = seed.kind === 'rock' ? ROCK_WIDEN_XZ : 1;
      const squash = seed.kind === 'rock' ? ROCK_SQUASH_Y : 1;
      const body = createFreeBody(
        seed.kind,
        seed.variant,
        seed.scale * widen,
        seed.scale * squash,
        seed.scale * widen,
        seed.r,
        x,
        y,
        z,
        q,
      );
      const handle = handleOf(body);
      byCollider.set(handle, seed.key);
      const item: LooseItem = {
        key: seed.key,
        kind: seed.kind,
        variant: seed.variant,
        scale: seed.scale,
        meshDrawn: true,
        x,
        z,
        r: seed.r,
        body,
        colliderHandle: handle,
        awake: true,
      };
      rocks.set(seed.key, item);
      rockState.set(seed.key, {
        landed: false,
        damped: false,
        scl: new Vector3(seed.scale * widen, seed.scale * squash, seed.scale * widen),
      });
      itemsDirty = true;
      // It stays HIDDEN from the scatter: it is drawn by src/world/loose.ts
      // from here, which is the one path that works on a page with no
      // physics in it at all.
      takenKeys.add(seed.key);
      scatter.setTaken(new Set(takenKeys));
      return item;
    },
    onSettle(cb): void {
      settleListeners.push(cb);
    },
    onImpact(cb): void {
      impactListeners.push(cb);
    },
    onTake(cb): void {
      takeListeners.push(cb);
    },
    registerForeign(handle, side): void {
      foreign.set(handle, side);
    },
    unregisterForeign(handle): void {
      foreign.delete(handle);
    },
    adopt(item): void {
      if (rocks.has(item.key)) return;
      rocks.set(item.key, item);
      byCollider.set(item.colliderHandle, item.key);
      // `landed: false`, like anything that arrives in the air: the settle
      // damping waits until the piece has come down, so a fragment thrown
      // out of a collapse travels rather than being braked mid-flight.
      rockState.set(item.key, {
        landed: false,
        damped: false,
        scl: new Vector3(item.scale, item.scale, item.scale),
      });
      adopted.add(item.key);
      itemsDirty = true;
    },
    release(key): boolean {
      const item = rocks.get(key);
      if (!item) return false;
      removeBody(item.body, item.colliderHandle);
      rocks.delete(key);
      rockState.delete(key);
      settleState.delete(key);
      adopted.delete(key);
      itemsDirty = true;
      return true;
    },
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
        scale: SPAWN_SCALE,
        meshDrawn: false,
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
      propRefs.clear();
      settleState.clear();
      settleListeners.length = 0;
      impactListeners.length = 0;
      takeListeners.length = 0;
      foreign.clear();
      adopted.clear();
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
