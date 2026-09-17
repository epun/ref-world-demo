/**
 * The rigid-body world (rapier) behind one wrapper. No Three.js, no DOM —
 * importable and steppable from node, which is what `test/physics/world.test.ts`
 * relies on (the compat build inlines its wasm as base64 and runs headless).
 *
 * WHY A WRAPPER. Three things have to be true of the simulation and none of
 * them is rapier's default:
 *
 *  1. **The ground is the Surface seam and nothing else.** PLAN §7.2 says
 *     locomotion never touches world-space Y and no system derives a height
 *     of its own. A physics engine is the most tempting place to break that
 *     — it would love to own the terrain — so the terrain collider here is a
 *     heightfield *sampled from* `Surface.sampleHeight`. **[D]** A rock's
 *     rendered Y comes from its body, and its body rests on a collider built
 *     FROM the seam, so the seam still owns every height in the world; swap
 *     in `SphereSurface` and the collider follows with no caller changing.
 *     Nothing in `src/world/rocks.ts` writes a Y of its own except the
 *     resurface safety net, which reads the seam to do it.
 *  2. **A fixed step.** Rapier integrates whatever timestep it is handed;
 *     the world's frame clock is elastic (`DT_CLAMP_MS`, tab returns). A
 *     variable step changes how far a stone rolls per frame, so the
 *     accumulator below runs 1/60 steps and drops the backlog past
 *     `MAX_SUBSTEPS` rather than fast-forwarding — a catch-up lurch is a
 *     cut, and there are none of those (TASTE §2.1).
 *  3. **No bounce.** Restitution is 0 on the terrain here and on every prop
 *     collider in `src/world/rocks.ts`. Envpaint's field used 0.02–0.2;
 *     that is a bounce, forbidden at confidence 1.00, so it is 0 here.
 *
 * COLUMN-MAJOR HEIGHTS. `buildHeightfieldHeights` is envpaint's, kept
 * verbatim: rapier stores the field as an nalgebra `DMatrix`, which is
 * COLUMN-major, mapping matrix rows to local Z and columns to local X, so
 * the element for (row i = z, column j = x) lives at
 * `heights[j * (nrows + 1) + i]`. That is not documented anywhere we can
 * cite — envpaint pinned it empirically and so do we
 * (`test/physics/world.test.ts`: raise the +X half, drop a ball each side).
 */

import { MOTION } from '../taste/tokens';
import { isPhoneTier } from '../world/device';
import { mapScale } from '../world/landscape';
import type { Surface } from '../world/surface';

type Rapier = typeof import('@dimforge/rapier3d-compat');
type RapierWorld = import('@dimforge/rapier3d-compat').World;
type RapierRigidBody = import('@dimforge/rapier3d-compat').RigidBody;
type RapierRigidBodyDesc = import('@dimforge/rapier3d-compat').RigidBodyDesc;
type RapierColliderDesc = import('@dimforge/rapier3d-compat').ColliderDesc;
type RapierCollider = import('@dimforge/rapier3d-compat').Collider;
type RapierHooks = import('@dimforge/rapier3d-compat').PhysicsHooks;

/** Fixed simulation step, seconds. */
export const FIXED_STEP_S = 1 / 60;
/** Never run more than this many fixed steps per frame (no death spiral). */
export const MAX_SUBSTEPS = 3;
/**
 * Cells per side of the terrain heightfield collider (257 x 257 samples).
 *
 * Over `FIELD_SIZE` (400 u) that is 1.56 u a cell, and the choice is set by
 * the terraces: the authored land steps in risers a few units of run wide
 * (src/world/landscape.ts), and a cell coarser than the riser turns a step
 * into a ramp — stones would roll off a terrace instead of stopping on it.
 * Envpaint ran 128 over a much smaller world. **[D]**
 */
export const HEIGHTFIELD_SEGMENTS = 256;

/**
 * …and the count the collider is actually built at: the one above through
 * `mapScale` (2026-09-16), ROUNDED because `MAP_SCALE` is not an integer
 * (1.3 since 2026-09-17) and a segment count has to be, so the CELL stays
 * 1.56 world units and the reason the number was picked survives a bigger
 * map. 512 at scale 2 (263k samples a rebuild against 66k, which is why
 * `TERRAIN_REBUILD_MIN_MS` exists); 282 at 1.1, a cell of 1.5603 and 80k
 * samples.
 *
 * Physics only ever runs on the simulating page of a katamari world
 * (`WorldHandles.enablePhysics`), which is the only world with an island — so
 * in practice this is the island's number and the constant above is what the
 * tests and a plain-mode world read.
 */
export function heightfieldSegments(): number {
  // A HANDSET KEEPS 256 (2026-09-16). 513² samples measured 761ms on one node
  // core against 257²'s 156ms, and the collider is rebuilt on every terrain
  // dial and painted pond (throttled by `TERRAIN_REBUILD_MIN_MS`, which is
  // what makes it survivable rather than free). At 256 over 800 units the
  // cell is 3.12 units, coarser than a riser, so a stone can roll off a
  // terrace it should have stopped on — a physics nicety on a page that is
  // usually a VIEWER anyway (physics runs only on the simulating page), and
  // the projection that actually hosts a room keeps the 1.56-unit cell. At
  // scale 1.1 the handset's cell is 1.56 units rather than 3.12: 440 units
  // over the 256 kept here is coarser than the projection only above scale 2.
  if (isPhoneTier()) return HEIGHTFIELD_SEGMENTS;
  return Math.round(HEIGHTFIELD_SEGMENTS * mapScale());
}
/**
 * A terrain rebuild costs a collider build over ~66k samples, so an
 * interactive sculpt (the paint brush, a terrain dial being dragged) must
 * not ask for one per frame. Half a tertiary beat — from the motion tokens,
 * never a literal.
 */
export const TERRAIN_REBUILD_MIN_MS = MOTION.tertiaryMs / 2;

/**
 * Fill the heights buffer of a rapier heightfield collider. ENVPAINT'S,
 * VERBATIM — see the module header on the column-major convention.
 *
 * @param sample height at u (along X) and v (along Z), both 0..1 across the field
 * @param segments cells per side
 */
export function buildHeightfieldHeights(
  sample: (u: number, v: number) => number,
  segments: number = HEIGHTFIELD_SEGMENTS,
): Float32Array {
  const n = segments + 1;
  const heights = new Float32Array(n * n);
  for (let ix = 0; ix < n; ix++) {
    const u = ix / segments;
    for (let iz = 0; iz < n; iz++) {
      heights[ix * n + iz] = sample(u, iz / segments);
    }
  }
  return heights;
}

/** One reported contact, by COLLIDER handle (not body). */
export interface ContactEvent {
  a: number;
  b: number;
  started: boolean;
}

export interface PhysicsWorld {
  /** The loaded module, for callers that need its descriptors and enums. */
  readonly rapier: Rapier;
  readonly world: RapierWorld;
  /**
   * Advance by `dtMs` of frame time through the fixed-step accumulator, and
   * return the contact events this frame's steps reported.
   *
   * The returned array is REUSED by the next call — copy it to hold it.
   */
  step(dtMs: number): ContactEvent[];
  /**
   * Resample the Surface over the field and replace the terrain collider,
   * then wake every body: the ground moved, so nothing may stay asleep on
   * top of where it used to be.
   */
  rebuildTerrain(): void;
  /** Ask for a rebuild; it happens inside a later `step`, throttled to
   * `TERRAIN_REBUILD_MIN_MS`. What an interactive sculpt calls. */
  requestTerrainRebuild(): void;
  addRigidBody(desc: RapierRigidBodyDesc, collider?: RapierColliderDesc): RapierRigidBody;
  remove(body: RapierRigidBody): void;
  /**
   * Install (or clear) the contact-pair filter. The katamari layer lands
   * later and needs to stop a picked-up rock from colliding with the
   * creature carrying it; `step` passes whatever is installed to
   * `world.step`.
   */
  setHooks(hooks: RapierHooks | null): void;
  dispose(): void;
}

/**
 * Load rapier, build the world and seat the terrain collider on the seam.
 *
 * The import is dynamic so the wasm payload is a chunk of its own and the
 * world runs exactly as it did until the promise resolves (src/world/scene.ts
 * wires it that way on purpose — a projection must never wait on physics to
 * draw its first frame).
 */
export async function createPhysicsWorld(
  surface: Surface,
  fieldSize: number,
): Promise<PhysicsWorld> {
  const mod = await import('@dimforge/rapier3d-compat');
  const rapier: Rapier = (mod as unknown as { default?: Rapier }).default ?? mod;
  await rapier.init();

  const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_STEP_S;
  const terrainBody = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  let terrainCollider: RapierCollider | null = null;

  const events = new rapier.EventQueue(true);
  let hooks: RapierHooks | null = null;
  const drained: ContactEvent[] = [];

  let accumulatorS = 0;
  let rebuildPending = false;
  let sinceRebuildMs = TERRAIN_REBUILD_MIN_MS;

  const wakeAll = (): void => {
    world.forEachRigidBody((body) => body.wakeUp());
  };

  // Read once: the island's scale cannot change under a live world.
  const segments = heightfieldSegments();

  const rebuildTerrain = (): void => {
    // The ONE height source (PLAN §7.2). u/v run 0..1 across the field,
    // which is centred on the origin — rapier centres a heightfield on its
    // body, and the body is at the origin, so the mapping is the ground
    // mesh's own.
    const half = fieldSize / 2;
    const heights = buildHeightfieldHeights(
      (u, v) => surface.sampleHeight(u * fieldSize - half, v * fieldSize - half),
      segments,
    );
    if (terrainCollider) {
      world.removeCollider(terrainCollider, false);
      terrainCollider = null;
    }
    // FIX_INTERNAL_EDGES makes neighbouring cells' contact normals agree.
    // Envpaint's note, and it is not cosmetic: without it a body rolling
    // across a cell boundary gets kicked THROUGH the field.
    const desc = rapier.ColliderDesc.heightfield(
      segments,
      segments,
      heights,
      { x: fieldSize, y: 1, z: fieldSize },
      rapier.HeightFieldFlags.FIX_INTERNAL_EDGES,
    )
      .setFriction(1.1)
      // Envpaint's 0.02. Zero here: a bounce is forbidden at confidence
      // 1.00 (TASTE §2.1), however small.
      .setRestitution(0);
    terrainCollider = world.createCollider(desc, terrainBody);
    rebuildPending = false;
    sinceRebuildMs = 0;
    wakeAll();
  };

  rebuildTerrain();

  return {
    rapier,
    world,
    step(dtMs: number): ContactEvent[] {
      drained.length = 0;

      sinceRebuildMs += dtMs;
      if (rebuildPending && sinceRebuildMs >= TERRAIN_REBUILD_MIN_MS) rebuildTerrain();

      accumulatorS += dtMs / 1000;
      let n = 0;
      while (accumulatorS >= FIXED_STEP_S && n < MAX_SUBSTEPS) {
        world.step(events, hooks ?? undefined);
        events.drainCollisionEvents((a, b, started) => {
          drained.push({ a, b, started });
        });
        accumulatorS -= FIXED_STEP_S;
        n++;
      }
      // Drop the backlog rather than fast-forwarding after a long stall: a
      // catch-up burst is a lurch, and nothing here moves discontinuously.
      if (accumulatorS > FIXED_STEP_S * MAX_SUBSTEPS) accumulatorS = 0;
      return drained;
    },
    rebuildTerrain,
    requestTerrainRebuild(): void {
      rebuildPending = true;
    },
    addRigidBody(desc: RapierRigidBodyDesc, collider?: RapierColliderDesc): RapierRigidBody {
      const body = world.createRigidBody(desc);
      if (collider) world.createCollider(collider, body);
      return body;
    },
    remove(body: RapierRigidBody): void {
      world.removeRigidBody(body);
    },
    setHooks(next: RapierHooks | null): void {
      hooks = next;
    },
    dispose(): void {
      terrainCollider = null;
      events.free();
      world.free();
    },
  };
}
