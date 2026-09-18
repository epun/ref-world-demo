/**
 * Drawing the things that are no longer scenery.
 *
 * The scatter draws props as instanced rows, one `InstancedMesh` per (kind,
 * variant), and that is the only reason a world of four hundred trees runs.
 * But an instance row is a row in a batch: it cannot be removed, only
 * overwritten, and the moment a tree comes out of the ground the scatter
 * stops drawing it altogether (`setTaken` filters it out of the next
 * rebuild). Something then has to draw the tree that is lying in the field.
 *
 * That something is here, and it runs on EVERY page — the projection that
 * simulates and the phone that only watches. A viewer runs no physics at all
 * (docs/PLAN.md §7.6): it hears a `loose`, a `drop` or a `settle` event, and
 * this is the layer that puts a mesh where the event says. Which is also why
 * the host draws its loose bodies through here rather than through an
 * instance row it could have kept: one draw path means the host and the room
 * cannot end up looking at differently-placed fallen trees.
 *
 * ONE MESH PER ITEM, and that is affordable because the set is small by
 * construction — a loose thing is something a creature knocked over, and the
 * `DEBRIS_CAP` in `src/world/device.ts` is the ceiling the destruction task
 * will hold it to.
 *
 * THE MATERIAL IS SHARED with the scatter's own (`scatter.materialFor`), not
 * copied. A fallen tree can never be a different green from the standing
 * ones, and a style override, a dev tint or the ghibli recolour reaches both
 * in one write.
 */

import { BufferAttribute, Mesh, type BufferGeometry, type Object3D, type Scene } from 'three';
import type { Chunk, ChunkKind } from './chunks';
import type { PropKind } from './props';
import { ROCK_SQUASH_Y, ROCK_WIDEN_XZ, type Scatter } from './scatter';

/**
 * Where a chunk set comes from, when there is one.
 *
 * A GETTER rather than the map, because `buildChunkGeometries()` re-runs the
 * whole prop pipeline and most pages never break anything: the destruction
 * layer builds the map the first time something comes apart
 * (src/world/scene.ts), and this asks for it only when it is handed a chunk
 * id to draw.
 */
export type ChunkSource = () => Map<ChunkKind, Chunk[][]> | null;

/**
 * The `#` in `<placementKey>#<chunkIndex>` — one item id shape for a
 * fragment, shared by the wire (src/session/scene.ts `ITEM_ID`), the debris
 * layer and this one.
 */
export const CHUNK_SEPARATOR = '#';

/** The chunk index an item id names, or null when it names a whole thing. */
export function chunkIndexOf(item: string): number | null {
  const at = item.lastIndexOf(CHUNK_SEPARATOR);
  if (at < 0) return null;
  const index = Number(item.slice(at + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return index;
}

/** The rotation a loose item is drawn at. Plain floats, the same four the
 * `drop`/`settle` scene events carry — never a `Quaternion`, so a caller
 * can hand over what came off the wire. */
export interface LooseRotation {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface LooseMeshes {
  /**
   * Start drawing `item` as a mesh of `kind`/`variant` at instance `scale`.
   *
   * Idempotent per item: showing one that is already shown returns the mesh
   * it already has, so a replayed log that sticks and drops the same stone
   * twice does not leak two of them.
   */
  show(item: string, kind: PropKind, variant: number, scale: number): Object3D;
  /** Where it is. `y` is the caller's — a viewer samples the Surface seam,
   * the host passes the body's real height. This module derives no heights. */
  move(item: string, x: number, y: number, z: number, q: LooseRotation): void;
  remove(item: string): void;
  get(item: string): Object3D | undefined;
  /**
   * GIVE THE ONES THAT ARRIVED TOO EARLY THEIR GEOMETRY.
   *
   * > User report, 2026-09-18, of a phone showing a 67 m ball with no objects
   * > on it and the props gone from the meadow: *"The objects should be
   * > showing and it should be sticking to the character."*
   *
   * `show` is called the moment a `stick` is applied, and on a katamari world
   * the prop LIBRARY is loaded after the first frame and the person's own
   * creature — a phone on a slow link is minutes behind the room. An item
   * stuck before its model landed got a `Mesh` with no geometry, and because
   * `show` is idempotent it kept that empty mesh forever: the placement was
   * already hidden from the scatter, so the object simply vanished.
   *
   * So a mesh with no geometry is remembered, and this hands it the geometry
   * as soon as the library has it. Cheap by construction: it walks nothing
   * when nothing is waiting, which is every frame after the first pickups.
   */
  retryMissing(): void;
  dispose(): void;
}

/**
 * [D] The neutral value of the scatter's per-instance variation channel.
 *
 * `aVariation` is a vec4 the sway/prop shaders read as *(scale x, scale z,
 * scale y, phase)*, each component used as `value - 0.5` — so 0.5 is the
 * identity and 0 would shrink every fallen prop by 7% at the instant it fell.
 * A loose item therefore loses its placement's own size jitter and its
 * sub-degree lean, which is a fraction of a degree against a tree in the act
 * of falling over. [D], and said plainly rather than left as a zero-fill that
 * looks like it means nothing.
 */
const VARIATION_NEUTRAL = 0.5;

/**
 * A non-instanced clone of one (kind, variant) geometry, cached.
 *
 * Two reasons it cannot be the scatter's geometry itself. Its `aVariation`
 * and `aBend` are `InstancedBufferAttribute`s living on the batch's geometry,
 * and a plain `Mesh` drawn with an instanced attribute reads garbage or
 * refuses to compile depending on the driver. And the scatter rebuilds its
 * geometries; a mesh holding one would be holding a disposed buffer.
 *
 * So: clone the positions once per (kind, variant) and lay flat, ordinary
 * per-vertex buffers over the two instanced names. `aWindHeight` is already a
 * plain attribute on the source geometry (the scatter bakes it per vertex),
 * so it comes along with the clone and needs nothing.
 */
/**
 * The kind's own non-uniform DRAW SHAPE, as the scatter's instances carry it.
 *
 * > User report, 2026-09-18: *"Right now the objects shrink in size when the
 * > character rolls over an object."*
 *
 * A rock standing in the world is drawn `ROCK_WIDEN_XZ` wider and
 * `ROCK_SQUASH_Y` flatter than its own uniform scale (`scl.set(...)` in
 * src/world/scatter.ts), and the scale a stuck or loose mesh is handed —
 * `instanceRefs`' `scale`, which is what the `stick` event carries — is the
 * UNIFORM part alone. So the moment a creature rolled over a stone the stone
 * lost 12% of its width: the same object, drawn two ways.
 *
 * Baked into the geometry clone rather than put on the mesh's transform,
 * because the transform is not this module's to keep: the clump writes
 * `object.scale.setScalar(...)` on whatever it is given, every frame
 * (src/creatures/clump.ts). The clone is already per (kind, variant) and
 * shared by every item of that shape, and this shape is a constant of the
 * kind, so baking it is exact and costs nothing per frame.
 */
const drawShape = (kind: PropKind): { xz: number; y: number } =>
  kind === 'rock' ? { xz: ROCK_WIDEN_XZ, y: ROCK_SQUASH_Y } : { xz: 1, y: 1 };

function nonInstanced(source: BufferGeometry, kind: PropKind): BufferGeometry {
  const geometry = source.clone();
  const shape = drawShape(kind);
  if (shape.xz !== 1 || shape.y !== 1) geometry.scale(shape.xz, shape.y, shape.xz);
  const count = geometry.getAttribute('position')?.count ?? 0;
  const variation = new Float32Array(count * 4).fill(VARIATION_NEUTRAL);
  geometry.setAttribute('aVariation', new BufferAttribute(variation, 4));
  // The recoil channel. Zero is correct and not merely safe: a thing that is
  // lying on the ground has no spring in it to kick.
  geometry.setAttribute('aBend', new BufferAttribute(new Float32Array(count * 2), 2));
  return geometry;
}

export function createLooseMeshes(
  scatter: Scatter,
  scene: Scene,
  chunks: ChunkSource = () => null,
): LooseMeshes {
  const meshes = new Map<string, Mesh>();
  /** One clone per (kind, variant) — or per (kind, variant, chunk) — shared
   * by every item of that shape. */
  const geometries = new Map<string, BufferGeometry>();

  /**
   * ONE CHUNK of a broken prop, as a drawable geometry.
   *
   * The same two fixes `nonInstanced` makes, plus a third: `aWindHeight` is
   * baked per vertex by the scatter for its swaying kinds and a chunk never
   * went through that bake, so it is laid down as ZEROES — which is not a
   * fallback but the truth. A branch torn off a tree is lying on the ground
   * with no root to sway from, exactly as `aBend` is zero for the same
   * reason.
   */
  const chunkGeometry = (
    kind: PropKind,
    variant: number,
    index: number,
  ): BufferGeometry | null => {
    const cacheKey = `${kind}:${variant}#${index}`;
    const cached = geometries.get(cacheKey);
    if (cached) return cached;
    const set = chunks()?.get(kind as ChunkKind);
    const chunk = set?.[variant]?.[index];
    if (!chunk) return null;
    const geometry = chunk.geometry.clone();
    const count = geometry.getAttribute('position')?.count ?? 0;
    geometry.setAttribute(
      'aVariation',
      new BufferAttribute(new Float32Array(count * 4).fill(VARIATION_NEUTRAL), 4),
    );
    geometry.setAttribute('aBend', new BufferAttribute(new Float32Array(count * 2), 2));
    geometry.setAttribute('aWindHeight', new BufferAttribute(new Float32Array(count), 1));
    geometries.set(cacheKey, geometry);
    return geometry;
  };

  /** Items drawn with no geometry because the library had not loaded yet. */
  const awaiting = new Map<string, { kind: PropKind; variant: number }>();

  const geometryFor = (
    kind: PropKind,
    variant: number,
    item: string,
  ): BufferGeometry | null => {
    // A chunk id is the one case where the ITEM says which geometry, not the
    // kind: the parent's kind and variant pick the chunk SET, the suffix
    // picks the piece out of it (src/world/chunks.ts).
    const index = chunkIndexOf(item);
    if (index !== null) return chunkGeometry(kind, variant, index);
    const cacheKey = `${kind}:${variant}`;
    const cached = geometries.get(cacheKey);
    if (cached) return cached;
    const source = scatter.geometryFor(kind, variant);
    if (!source) return null;
    const built = nonInstanced(source, kind);
    geometries.set(cacheKey, built);
    return built;
  };

  return {
    show(item, kind, variant, scale): Object3D {
      const existing = meshes.get(item);
      if (existing) return existing;
      const geometry = geometryFor(kind, variant, item);
      // No geometry yet — the library is still loading. Remember it and let
      // `retryMissing` finish the job, or the object is lost (see above).
      if (!geometry) awaiting.set(item, { kind, variant });
      const mesh = new Mesh(geometry ?? undefined, scatter.materialFor(kind));
      // Named so the ghost-panel outliner lists it legibly, the same way the
      // scatter names its batches and the manager names each creature.
      mesh.name = `loose ${kind}`;
      mesh.scale.setScalar(scale);
      // No frustum culling: these are a handful of objects and every one of
      // them is being moved by a solver on another page, so a bounding
      // sphere computed once here would be wrong the moment it mattered.
      mesh.frustumCulled = false;
      meshes.set(item, mesh);
      scene.add(mesh);
      return mesh;
    },

    retryMissing(): void {
      if (awaiting.size === 0) return;
      for (const [item, what] of [...awaiting]) {
        const mesh = meshes.get(item);
        if (!mesh) {
          awaiting.delete(item);
          continue;
        }
        const geometry = geometryFor(what.kind, what.variant, item);
        if (!geometry) continue;
        (mesh as Mesh).geometry = geometry;
        awaiting.delete(item);
      }
    },

    move(item, x, y, z, q): void {
      const mesh = meshes.get(item);
      if (!mesh) return;
      mesh.position.set(x, y, z);
      mesh.quaternion.set(q.x, q.y, q.z, q.w);
    },

    remove(item): void {
      awaiting.delete(item);
      const mesh = meshes.get(item);
      if (!mesh) return;
      meshes.delete(item);
      scene.remove(mesh);
      // The geometry is the shared per-(kind, variant) clone and the
      // material is the scatter's own — neither is this item's to dispose.
    },

    get(item): Object3D | undefined {
      return meshes.get(item);
    },

    dispose(): void {
      for (const mesh of meshes.values()) scene.remove(mesh);
      meshes.clear();
      for (const geometry of geometries.values()) geometry.dispose();
      geometries.clear();
    },
  };
}
