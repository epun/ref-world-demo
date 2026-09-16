/**
 * Load the curated katamari models and hand back prop-shaped geometry
 * (docs/katamari-props.md).
 *
 * WHAT COMES OUT. One `KatamariModel` per catalog row, carrying exactly what
 * the scatter already expects of a `PropVariant` — geometry scaled to the
 * variant height, grounded at y = 0, centred in x/z, plus the footprint
 * `radius` — so a katamari world can hand these to `buildPropGeometries`'s
 * consumers without any of them knowing a glb arrived. It additionally carries
 * the model's one baked texture, its alpha mode, and a `parts` list shaped like
 * `src/world/chunks.ts`'s `Chunk` so the destruction layer has something to
 * break the prop into.
 *
 * THE NORMALISE RULE IS NOT REINVENTED. `variantTransform` from
 * `src/world/props.ts` is the world's single statement of "scale to the
 * authored height, ground, centre", and it is imported rather than copied —
 * the same rule the destruction layer already reads. The glb's own metres are
 * the PS2 game's scale and carry no meaning here (a "Big Tree" and a "Brick"
 * are both about a metre in the source), so `heightUnits` from the catalog is
 * the only size that counts.
 *
 * PARTS, TWO WAYS.
 *
 *   1. A MULTIPART model (a car's body / wheels / windows, a signal's three
 *      lamps) already has its seams: one `parts` entry per mesh in the glb,
 *      stages assigned top-down, which is the same shape as route 1 in
 *      `src/world/chunks.ts` ("the parts ARE the chunks").
 *   2. A SINGLE-MESH model is cut by wobbled height planes, which is route 3
 *      of that same file. `cutByHeightPlane` is COPIED from there (it is not
 *      exported, and `src/world/chunks.ts` belongs to another delegate) with
 *      one deliberate extension: this copy carries `normal` and `uv` through
 *      the cut, because a katamari chunk is TEXTURED and a chunk that lost its
 *      uv would render as one flat texel. Everything else — centroid-side
 *      assignment, jagged uncapped cut, the `shash` wobble — is that function's
 *      behaviour and its rationale.
 *
 * DETERMINISM. Every seed comes from the model's own id through `hash`/`shash`
 * in `src/world/props.ts` — the world's one noise family. No `Math.random`,
 * no clock: two handsets must cut the same building into the same chunks.
 *
 * ASYNC, AND LATE. `loadKatamariModels` is the only impure function here; it
 * fetches `catalog.json` and then the glbs, at most 8 in flight. Everything it
 * calls is a pure function over `BufferGeometry` and is unit-tested as such.
 * The wiring plan (docs/katamari-props.md §e) has the scatter stand on its
 * inflated props until the library arrives, the way physics arrives late.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  NearestFilter,
  SRGBColorSpace,
} from 'three';
import type { Mesh, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
/**
 * THE MESHOPT DECODER — ~30 kb, and only on a katamari world.
 *
 * Every published glb is `EXT_meshopt_compression`d by
 * `scripts/katamari-curate.mjs` (3.82 mb → 2.35 mb over the wire), so the
 * loader cannot read one without this. A STATIC import is correct here for
 * exactly the reason the header gives about this whole file: `./models` is
 * only ever reached through the dynamic import in `./source.ts`, behind
 * `game === 'katamari'`, so no other world's first chunk carries it.
 */
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { hash, shash, variantTransform, type PartStage } from '../props';
import {
  KATAMARI_BASE_URL,
  KATAMARI_CATALOG_FILE,
  KATAMARI_MODELS_DIR,
  TIER_LOAD_ORDER,
  type KatamariEntry,
  type KatamariKind,
} from './catalog';
import type { Tier } from '../../creatures/sticky';

/** How many glbs are in flight at once. [D] — small enough not to starve the
 * first frame's own requests, large enough to finish 82 files promptly. */
export const KATAMARI_LOAD_CONCURRENCY = 8;

/** Cut height as a fraction of the prop, and how far the cut wanders —
 * `src/world/chunks.ts`'s `TREE_CUT` / `TREE_CUT_WOBBLE`, mirrored so a
 * library prop tears at the same proportion an authored one does. */
const CUT_FRACTION = 0.35;
const CUT_WOBBLE = 0.06;

/** Kinds that come down in three stages rather than two (their `STICKY` rows
 * carry `stages`). */
const STAGED_KINDS: ReadonlySet<KatamariKind> = new Set(['building', 'mountain']);

/** How the PS2 material's alpha was exported. */
export type KatamariAlphaMode = 'opaque' | 'mask' | 'blend';

/** One breakable piece, in the WHOLE prop's object space at scale 1 — the
 * same contract as `Chunk` in `src/world/chunks.ts`. */
export interface KatamariPart {
  geometry: BufferGeometry;
  /** Centre of the piece in the prop's object space (the geometry itself is
   * re-centred on its own origin). */
  offset: { x: number; y: number; z: number };
  /** Bounding radius at scale 1. */
  radius: number;
  /** Which stage of a staged collapse removes it. */
  stage: PartStage;
}

export interface KatamariModel extends KatamariEntry {
  /** Every primitive merged, scaled to `heightUnits`, base at y = 0, centred
   * in x/z. */
  geometry: BufferGeometry;
  /** `heightUnits`, restated as the `PropVariant` field name. */
  height: number;
  /** Footprint radius at scale 1, exactly as `normalizeVariant` measures it. */
  radius: number;
  /** The one baked texture, at nearest filtering as extracted. */
  texture: Texture | null;
  /** Every texture the glb carried (one per material; the curated set has
   * exactly one each, and the loader keeps the list so a future pick with
   * more is not silently flattened). */
  textures: Texture[];
  alphaMode: KatamariAlphaMode;
  /** Back-face culling as the game had it: false means both faces draw. */
  doubleSide: boolean;
  parts: KatamariPart[];
}

export interface KatamariLibrary {
  models: KatamariModel[];
  byId: Map<string, KatamariModel>;
  byKind: Map<KatamariKind, KatamariModel[]>;
  /** Every geometry and texture this library owns. */
  dispose(): void;
}

// ── pure geometry ────────────────────────────────────────────────────────────

/**
 * position / normal / uv only, non-indexed, with the missing two synthesised.
 *
 * A glTF primitive from this library always has all three, but a geometry that
 * is short one attribute cannot be merged with one that is not, and the merge
 * below reads fixed strides — so the shape is made uniform here rather than
 * guarded at four call sites.
 */
/**
 * One attribute as plain floats, THROUGH the accessor rather than off its
 * array.
 *
 * ⚠️ `Float32Array.from(attribute.array)` is what this used to do, and it is
 * wrong for any attribute that is not already float (2026-09-16, found by
 * `scratch/props-compare.mjs` while measuring the compression): a
 * `KHR_mesh_quantization` model stores position as normalised shorts and uv
 * as normalised unsigned shorts, so the raw array holds 32767 where the
 * value is 1.0. Position survived it by accident — the factor is uniform and
 * `normalizeKatamariGeometry` scales the whole prop to its catalog height
 * anyway — but the UVs came out in the tens of thousands and every one of
 * those models would have drawn the wrong texel. `getX`/`getY`/`getZ`
 * de-normalise, and they also read an INTERLEAVED buffer correctly, which is
 * the other thing a compressed glb can hand back.
 */
function floatsOf(
  attribute: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number },
  items: 2 | 3,
): Float32Array {
  const out = new Float32Array(attribute.count * items);
  for (let i = 0; i < attribute.count; i++) {
    const at = i * items;
    out[at] = attribute.getX(i);
    out[at + 1] = attribute.getY(i);
    if (items === 3) out[at + 2] = attribute.getZ(i);
  }
  return out;
}

export function conformKatamariGeometry(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = flat.getAttribute('position');
  const count = position.count;
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(floatsOf(position, 3), 3));
  const normal = flat.getAttribute('normal');
  out.setAttribute(
    'normal',
    normal
      ? new BufferAttribute(floatsOf(normal, 3), 3)
      : new BufferAttribute(new Float32Array(count * 3), 3),
  );
  const uv = flat.getAttribute('uv');
  out.setAttribute(
    'uv',
    uv
      ? new BufferAttribute(floatsOf(uv, 2), 2)
      : new BufferAttribute(new Float32Array(count * 2), 2),
  );
  if (!normal) out.computeVertexNormals();
  if (flat !== geometry) flat.dispose();
  return out;
}

/**
 * Merge conformed geometries into one.
 *
 * The uv-carrying sibling of `mergeParts` in `src/world/props.ts`, which drops
 * uv (nothing it merges is textured) and disposes its inputs. This one keeps
 * uv — a katamari prop is its texture — and leaves the inputs alone, because
 * the same geometries are also the parts.
 */
export function mergeKatamariGeometries(parts: readonly BufferGeometry[]): BufferGeometry {
  let total = 0;
  for (const g of parts) total += g.getAttribute('position').count;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  let v3 = 0;
  let v2 = 0;
  for (const g of parts) {
    positions.set(g.getAttribute('position').array as Float32Array, v3);
    normals.set(g.getAttribute('normal').array as Float32Array, v3);
    uvs.set(g.getAttribute('uv').array as Float32Array, v2);
    v3 += g.getAttribute('position').count * 3;
    v2 += g.getAttribute('uv').count * 2;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(positions, 3));
  out.setAttribute('normal', new BufferAttribute(normals, 3));
  out.setAttribute('uv', new BufferAttribute(uvs, 2));
  return out;
}

/**
 * The scale + translate that takes a raw glb box to the catalog height,
 * grounded and centred — `variantTransform`'s rule, read once so the whole
 * prop and its parts land in the SAME object space.
 */
export function katamariTransform(
  geometry: BufferGeometry,
  heightUnits: number,
): { scale: number; translate: [number, number, number] } {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) throw new Error('katamari model built to nothing');
  return variantTransform(box, heightUnits * heightFraction(box));
}

/**
 * THE FOOTPRINT CAP (2026-09-16, read off a frame — docs/katamari-props.md).
 *
 * How many times its own height a prop may be wide before its WIDTH sets the
 * scale instead. **[D]**
 *
 * Scaling to a height alone is the right rule for a tree and the wrong one
 * for a pizza: the catalog's `heightUnits` is a height, a pizza is two
 * centimetres of it and a foot across, and a pizza normalised to 0.3 units
 * tall came out six units wide — bigger than the tree beside it, which is
 * exactly what the first render of the wired library showed. 2.2 keeps a
 * boat, a wall and a bench looking like themselves (all under it) and reins
 * in the flat food, the shells and the cassette tape: past the cap
 * `heightUnits` reads as "how big is this", not "how tall".
 */
export const KATAMARI_ASPECT_CAP = 2.2;

/**
 * How much of `heightUnits` a model's own height gets — 1 for anything
 * within the cap, less for something flatter, so the uniform scale falls
 * until the footprint fits. Exactly 1 in the common case, so a prop that is
 * taller than it is wide is normalised to its catalog height to the bit.
 */
function heightFraction(box: {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}): number {
  const rawHeight = Math.max(box.max.y - box.min.y, 1e-6);
  const rawWidth = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const effective = Math.max(rawHeight, rawWidth / KATAMARI_ASPECT_CAP);
  return rawHeight / effective;
}

/** Apply one `katamariTransform` in place: scale first, then translate — the
 * order `normalizeVariant` uses, and the order the numbers assume. */
export function applyKatamariTransform(
  geometry: BufferGeometry,
  transform: { scale: number; translate: [number, number, number] },
): BufferGeometry {
  const { scale, translate } = transform;
  geometry.scale(scale, scale, scale);
  geometry.translate(translate[0], translate[1], translate[2]);
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Scale to `heightUnits`, ground (min.y = 0), centre in x/z, and measure the
 * footprint the way `normalizeVariant` does.
 */
export function normalizeKatamariGeometry(
  geometry: BufferGeometry,
  heightUnits: number,
): { geometry: BufferGeometry; height: number; radius: number; transform: ReturnType<typeof katamariTransform> } {
  geometry.computeBoundingBox();
  // The height it actually ENDS at, which is `heightUnits` unless the
  // footprint cap bit (see `KATAMARI_ASPECT_CAP`). `PropVariant.height` is
  // read as a real height — the wind bake and the material's drift both
  // divide by it — so it must be the one on screen.
  const height = heightUnits * heightFraction(geometry.boundingBox!);
  const transform = katamariTransform(geometry, heightUnits);
  applyKatamariTransform(geometry, transform);
  const box = geometry.boundingBox!;
  const radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
  return { geometry, height, radius, transform };
}

/**
 * Cut a geometry's triangles by a wobbled height plane into [below, above].
 *
 * COPIED from `cutByHeightPlane` in `src/world/chunks.ts` (not exported there,
 * and that file belongs to another delegate), with `normal` and `uv` carried
 * through the cut — see the header. A triangle goes whole to the side its
 * centroid lands on; nothing is re-triangulated or capped, which is what a
 * break reads as.
 */
export function cutByHeightPlane(
  geometry: BufferGeometry,
  y: number,
  seed: number,
  wobble: number,
): [BufferGeometry, BufferGeometry] {
  const position = geometry.getAttribute('position').array as ArrayLike<number>;
  const normal = geometry.getAttribute('normal')?.array as ArrayLike<number> | undefined;
  const uv = geometry.getAttribute('uv')?.array as ArrayLike<number> | undefined;
  const index = geometry.index?.array;
  const triangles = (index ? index.length : position.length / 3) / 3;
  const vertexOf = (t: number, k: number): number => (index ? index[t * 3 + k]! : t * 3 + k);
  const up = new Uint8Array(triangles);
  let upCount = 0;
  for (let t = 0; t < triangles; t++) {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < 3; k++) {
      const v = vertexOf(t, k) * 3;
      sx += position[v]!;
      sy += position[v + 1]!;
      sz += position[v + 2]!;
    }
    const cut = y + wobble * shash(seed + (sx / 3) * 3.7 + (sz / 3) * 2.9);
    if (sy / 3 >= cut) {
      up[t] = 1;
      upCount++;
    }
  }
  if (upCount === 0 || upCount === triangles) {
    throw new Error(`height-plane cut at ${y} left one side empty`);
  }
  const make = (count: number): { position: Float32Array; normal: Float32Array; uv: Float32Array } => ({
    position: new Float32Array(count * 9),
    normal: new Float32Array(count * 9),
    uv: new Float32Array(count * 6),
  });
  const above = make(upCount);
  const below = make(triangles - upCount);
  let a3 = 0;
  let a2 = 0;
  let b3 = 0;
  let b2 = 0;
  for (let t = 0; t < triangles; t++) {
    const into = up[t] ? above : below;
    let at3 = up[t] ? a3 : b3;
    let at2 = up[t] ? a2 : b2;
    for (let k = 0; k < 3; k++) {
      const v = vertexOf(t, k);
      into.position[at3] = position[v * 3]!;
      into.position[at3 + 1] = position[v * 3 + 1]!;
      into.position[at3 + 2] = position[v * 3 + 2]!;
      if (normal) {
        into.normal[at3] = normal[v * 3]!;
        into.normal[at3 + 1] = normal[v * 3 + 1]!;
        into.normal[at3 + 2] = normal[v * 3 + 2]!;
      }
      if (uv) {
        into.uv[at2] = uv[v * 2]!;
        into.uv[at2 + 1] = uv[v * 2 + 1]!;
      }
      at3 += 3;
      at2 += 2;
    }
    if (up[t]) {
      a3 = at3;
      a2 = at2;
    } else {
      b3 = at3;
      b2 = at2;
    }
  }
  const build = (side: ReturnType<typeof make>): BufferGeometry => {
    const out = new BufferGeometry();
    out.setAttribute('position', new BufferAttribute(side.position, 3));
    out.setAttribute('normal', new BufferAttribute(side.normal, 3));
    out.setAttribute('uv', new BufferAttribute(side.uv, 2));
    if (!normal) out.computeVertexNormals();
    return out;
  };
  return [build(below), build(above)];
}

/**
 * Re-centre a piece on its own origin and measure it — the same finishing
 * step `src/world/chunks.ts` applies to every chunk, so `offset` means the
 * same thing here as it does there.
 */
export function finishKatamariPart(geometry: BufferGeometry, stage: PartStage): KatamariPart {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const offset = {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
  geometry.translate(-offset.x, -offset.y, -offset.z);
  geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere?.radius ?? 0;
  geometry.computeBoundingBox();
  return { geometry, offset, radius, stage };
}

/**
 * Stages for a list of pieces already sorted top-down: the top goes first
 * (stage 0), the foot goes last (stage 2), anything between is the second
 * impact. Two pieces skip the middle — the crown then the trunk, which is
 * exactly what `chunks.ts` does for a tree. [D]
 */
export function stageForIndex(index: number, count: number): PartStage {
  if (count <= 1) return 2;
  if (index === 0) return 0;
  if (index === count - 1) return 2;
  return 1;
}

/**
 * A single-mesh prop's pieces: cut by one or two wobbled height planes.
 *
 * A twelve-triangle wall has nowhere to put two seams, so a cut that would
 * leave a side empty falls back to fewer bands and, at worst, to the whole
 * prop as one piece. Deterministic either way — the fallback depends only on
 * the geometry.
 */
export function splitByHeightPlanes(
  geometry: BufferGeometry,
  height: number,
  bands: number,
  seed: number,
): KatamariPart[] {
  for (let want = Math.max(1, bands); want > 1; want--) {
    const pieces = tryBands(geometry, height, want, seed);
    if (pieces) {
      // Top-down, so stage 0 is the piece an impact takes first.
      pieces.reverse();
      return pieces.map((g, i) => finishKatamariPart(g, stageForIndex(i, pieces.length)));
    }
  }
  return [finishKatamariPart(geometry.clone(), 2)];
}

/** One attempt at `want` stacked bands, bottom-up, or null if a cut emptied
 * a side. */
function tryBands(
  geometry: BufferGeometry,
  height: number,
  want: number,
  seed: number,
): BufferGeometry[] | null {
  const pieces: BufferGeometry[] = [];
  let rest = geometry.clone();
  try {
    for (let i = 1; i < want; i++) {
      // Cuts climb the prop: one band puts its seam at CUT_FRACTION, three
      // bands put them at a third and two thirds of the way up.
      const at = want === 2 ? height * CUT_FRACTION : (height * i) / want;
      const [below, above] = cutByHeightPlane(rest, at, seed + i * 5.3, height * CUT_WOBBLE);
      pieces.push(below);
      rest.dispose();
      rest = above;
    }
    pieces.push(rest);
    return pieces;
  } catch {
    for (const g of pieces) g.dispose();
    rest.dispose();
    return null;
  }
}

/** A model's layout seed: its game id, folded into the world's hash family. */
export function katamariSeed(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n += id.charCodeAt(i) * (i + 1) * 0.37;
  return n + hash(n) * 13.7;
}

// ── assembly ─────────────────────────────────────────────────────────────────

/** Every mesh in a loaded glb scene, with its node transform baked in. */
function meshGeometries(root: Object3D): { geometry: BufferGeometry; mesh: Mesh }[] {
  const out: { geometry: BufferGeometry; mesh: Mesh }[] = [];
  root.updateWorldMatrix(false, true);
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true) return;
    const geometry = conformKatamariGeometry(mesh.geometry);
    geometry.applyMatrix4(new Matrix4().copy(mesh.matrixWorld));
    out.push({ geometry, mesh });
  });
  return out;
}

function firstMaterial(mesh: Mesh): {
  texture: Texture | null;
  alphaMode: KatamariAlphaMode;
  doubleSide: boolean;
} {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | {
        map?: Texture | null;
        transparent?: boolean;
        alphaTest?: number;
        side?: number;
      }
    | undefined;
  const texture = material?.map ?? null;
  const alphaMode: KatamariAlphaMode =
    material?.transparent === true ? 'blend' : (material?.alphaTest ?? 0) > 0 ? 'mask' : 'opaque';
  // three's DoubleSide is 2; the extractor preserved the game's culling.
  return { texture, alphaMode, doubleSide: material?.side === 2 };
}

/** Nearest, no mipmaps, srgb — the filtering the extraction preserved. */
function conformTexture(texture: Texture): Texture {
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One catalog row plus one parsed glb scene → a `KatamariModel`.
 *
 * Pure but for the three objects it takes ownership of (the geometries and the
 * texture), and the one function a node test can call with a real glb.
 */
export function buildKatamariModel(root: Object3D, entry: KatamariEntry): KatamariModel {
  const meshes = meshGeometries(root);
  if (meshes.length === 0) throw new Error(`katamari model ${entry.id} has no mesh`);
  const merged = mergeKatamariGeometries(meshes.map((m) => m.geometry));
  const { height, radius, transform } = normalizeKatamariGeometry(merged, entry.heightUnits);

  const seed = katamariSeed(entry.id);
  let parts: KatamariPart[];
  if (meshes.length > 1) {
    // Route 1: the glb's own meshes are the seams. Top-down by centre height,
    // so the stage order reads as a collapse.
    const placed = meshes.map(({ geometry }) => {
      const piece = applyKatamariTransform(geometry.clone(), transform);
      piece.computeBoundingBox();
      const box = piece.boundingBox!;
      return { piece, centre: (box.min.y + box.max.y) / 2 };
    });
    placed.sort((a, b) => b.centre - a.centre);
    parts = placed.map(({ piece }, i) => finishKatamariPart(piece, stageForIndex(i, placed.length)));
  } else {
    // Route 2: one wobbled height plane, or two for a staged collapse.
    parts = splitByHeightPlanes(merged, height, STAGED_KINDS.has(entry.kind) ? 3 : 2, seed);
  }
  for (const { geometry } of meshes) geometry.dispose();

  const { texture, alphaMode, doubleSide } = firstMaterial(meshes[0]!.mesh);
  const textures: Texture[] = [];
  for (const { mesh } of meshes) {
    const own = firstMaterial(mesh).texture;
    if (own && !textures.includes(own)) textures.push(conformTexture(own));
  }
  return {
    ...entry,
    geometry: merged,
    height,
    radius,
    texture: texture ? conformTexture(texture) : null,
    textures,
    alphaMode,
    doubleSide,
    parts,
  };
}

/**
 * One model's url — the published path, plus its CONTENT HASH as the cache
 * key (`KatamariEntry.hash`, 2026-09-16).
 *
 * The models are served `public, max-age=31536000, immutable` (`vercel.json`)
 * so a person on a slow link pays for the library once and never again. That
 * is only safe if the url moves when the bytes do, and the filename may not:
 * it is the provenance trail back to the game's own object id. So the hash
 * rides in the query, which is part of the cache key in every browser and in
 * Vercel's edge cache alike. A row with no hash (a hand-written one, or a
 * catalog published before this landed) asks for the bare path and is simply
 * cached less aggressively than it could be.
 */
export function modelUrl(root: string, entry: KatamariEntry): string {
  const path = `${root}/${KATAMARI_MODELS_DIR}/${entry.file}`;
  return entry.hash === undefined ? path : `${path}?v=${entry.hash}`;
}

/** The published catalog, as written by `scripts/katamari-curate.mjs`. */
export interface KatamariCatalogFile {
  baseUrl: string;
  models: KatamariEntry[];
}

/** Resolve up to `limit` promises at a time, keeping input order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Fetch `catalog.json` and every model it names.
 *
 * The one impure function in this file. Rejects if the catalog is missing; a
 * single model that fails to load is SKIPPED with a console warning rather
 * than taking the world down with it — the scatter's authored props are still
 * standing (docs/katamari-props.md §e), and a library short one building is a
 * better frame than no frame.
 */
export interface KatamariLoadOptions {
  /**
   * Called as each TIER finishes, with everything loaded so far and whether
   * that was the last one.
   *
   * The tiers load small → medium → large → building (`TIER_LOAD_ORDER`), so
   * the field fills in with cups and cans within a second or two and the
   * skyline arrives while the room is already looking at something. The
   * caller turns each call into a scatter rebuild (docs/katamari-props.md
   * §e); a caller that does not care simply waits for the promise.
   */
  onTier?: (library: KatamariLibrary, tier: Tier, done: boolean) => void;
}

export async function loadKatamariModels(
  baseUrl: string = KATAMARI_BASE_URL,
  opts: KatamariLoadOptions = {},
): Promise<KatamariLibrary> {
  const root = baseUrl.replace(/\/+$/, '');
  const response = await fetch(`${root}/${KATAMARI_CATALOG_FILE}`);
  if (!response.ok) {
    throw new Error(`katamari catalog ${response.status} at ${root}/${KATAMARI_CATALOG_FILE}`);
  }
  const catalog = (await response.json()) as KatamariCatalogFile;
  const loader = new GLTFLoader();
  // The models are meshopt-compressed (see the import). One decoder for the
  // whole library — it is a wasm module and instantiating it per file would
  // cost more than the compression saves.
  loader.setMeshoptDecoder(MeshoptDecoder);
  const one = async (entry: KatamariEntry): Promise<KatamariModel | null> => {
    try {
      const gltf = await loader.loadAsync(modelUrl(root, entry));
      return buildKatamariModel(gltf.scene, entry);
    } catch (error) {
      console.warn(`katamari model ${entry.id} (${entry.file}) did not load`, error);
      return null;
    }
  };
  // The tiers, in load order, then anything whose tier is not in that list
  // (nothing today — the guard is so a new tier cannot silently not load).
  const groups: { tier: Tier; rows: KatamariEntry[] }[] = [];
  const taken = new Set<KatamariEntry>();
  for (const tier of TIER_LOAD_ORDER) {
    const rows = catalog.models.filter((entry) => entry.tier === tier);
    for (const row of rows) taken.add(row);
    if (rows.length > 0) groups.push({ tier, rows });
  }
  const rest = catalog.models.filter((entry) => !taken.has(entry));
  if (rest.length > 0) groups.push({ tier: rest[0]!.tier, rows: rest });

  const models: KatamariModel[] = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const loaded = await mapWithLimit(group.rows, KATAMARI_LOAD_CONCURRENCY, one);
    for (const model of loaded) if (model !== null) models.push(model);
    opts.onTier?.(assembleLibrary(models), group.tier, g === groups.length - 1);
  }
  return assembleLibrary(models);
}

/** Index a list of models by id and by kind, and give it a `dispose`. */
export function assembleLibrary(models: KatamariModel[]): KatamariLibrary {
  const byId = new Map<string, KatamariModel>();
  const byKind = new Map<KatamariKind, KatamariModel[]>();
  for (const model of models) {
    byId.set(model.id, model);
    const list = byKind.get(model.kind);
    if (list) list.push(model);
    else byKind.set(model.kind, [model]);
  }
  return {
    models,
    byId,
    byKind,
    dispose(): void {
      for (const model of models) {
        model.geometry.dispose();
        for (const part of model.parts) part.geometry.dispose();
        for (const texture of model.textures) texture.dispose();
      }
    },
  };
}
