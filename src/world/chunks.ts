/**
 * Break-apart chunk geometry for breakable props.
 *
 * A prop that comes apart has to come apart into DRAWN FRAGMENTS of itself
 * — pieces you could believe were torn off the silhouette — and never into
 * boxes. TASTE §2.5 forbids engineered form outright, and a destruction
 * layer is exactly where a renderer is tempted to reach for a box: no
 * chunk here is authored, every one comes out of the same builder that made
 * the whole prop.
 *
 * Three routes, matching the two construction paths in `props.ts`:
 *
 * 1. ARCHITECTURAL (building, waterTower, picnicTable, palm) — the PARTS
 *    ARE THE CHUNKS. Every arch builder hands back a labelled part list
 *    before the merge; chunks are those parts grouped by their group key.
 *    Where a family is one lathe or one extrude with no natural seam
 *    (adobe and longhouse boxes, the cottage's gable body, the
 *    mushroom-house lathe, the water tower's tank+roof), the builder is
 *    asked for `{ split: true }` and cuts the profile at one or two
 *    WOBBLED heights into stacked sections — a torn seam, never a ruled
 *    line.
 *
 * 2. INFLATED LUMPS (monolith, mountain, rock) — the same strokes re-run
 *    through analyze() + inflate() at the small mask, scaled to roughly
 *    half the parent's height and laid out on a seeded jittered ring
 *    inside the parent's bounding volume, so their union roughly fills the
 *    silhouette. A rock shatters into smaller rocks of itself.
 *
 * 3. TREES (tree, conifer) — the inflated geometry cut by a WOBBLED height
 *    plane into crown and trunk. Triangles go whole to the side their
 *    centroid lands on: the cut is jagged, which is what a break looks
 *    like, and nothing is re-triangulated or capped (an open cut is fine
 *    for an ink-rendered blob). The palm takes route 1 instead — its
 *    fronds and trunk are already separate parts.
 *
 * Determinism, as everywhere in the prop pipeline: every seed comes from
 * the variant's identity through the same `hash`/`shash` family
 * `props.ts` wobbles with. Never `Math.random`, never a clock. Two calls
 * return identical arrays, so a chunk that flies off on one handset flies
 * off the same way on every other.
 *
 * Cost: `buildChunkGeometries()` runs once, well inside the init budget.
 * Nothing is cached here — the caller owns the map and its disposal.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import {
  ARCH_VARIANT_DEFS,
  PROP_MASK_SIZE_SMALL,
  PROP_VARIANT_DEFS,
  buildInflatedVariant,
  hash,
  mergeParts,
  shash,
  variantTransform,
  type ArchPart,
  type ArchPropKind,
  type InflatedPropKind,
  type PartStage,
} from './props';

export interface Chunk {
  geometry: BufferGeometry;
  /** Centre of the chunk in the WHOLE prop's object space, at scale 1 (the
   * geometry itself is re-centred on its own origin). */
  offset: { x: number; y: number; z: number };
  /** Bounding radius of the chunk at scale 1. */
  radius: number;
  /** Which stage of a staged collapse removes it: 0 = first impact,
   * 1 = second, 2 = collapse (single-stage kinds use 2 for everything). */
  stage: 0 | 1 | 2;
}

/** Every prop kind that can break. Ordered inflated → architectural →
 * trees, the way the three routes above are. */
export const CHUNK_KINDS = [
  'monolith',
  'mountain',
  'rock',
  'building',
  'waterTower',
  'picnicTable',
  'tree',
  'conifer',
  'palm',
] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

/** Kinds whose chunks are their builder's parts, grouped. */
const ARCH_CHUNK_KINDS = ['building', 'waterTower', 'picnicTable', 'palm'] as const;

/** How many lumps an inflated kind shatters into. [D] — few enough to
 * read individually at prop scale, enough to fill the silhouette. */
const LUMP_COUNTS: Record<'monolith' | 'mountain' | 'rock', number> = {
  rock: 3,
  monolith: 4,
  mountain: 5,
};

/**
 * Where each lump sits and when it goes. `lift` is its centre's height as
 * a fraction of the room between the ground and the parent's top, so a
 * lump is always wholly inside the parent's box. Two low, one or two high.
 * Rock and monolith shatter at once (all stage 2); a mountain comes down
 * in stages — summit first, shoulders next, foot last.
 */
const LUMP_TIERS: Record<'monolith' | 'mountain' | 'rock', { lift: number; stage: PartStage }[]> = {
  rock: [
    { lift: 0.04, stage: 2 },
    { lift: 0.16, stage: 2 },
    { lift: 0.74, stage: 2 },
  ],
  monolith: [
    { lift: 0.05, stage: 2 },
    { lift: 0.18, stage: 2 },
    { lift: 0.62, stage: 2 },
    { lift: 0.86, stage: 2 },
  ],
  mountain: [
    { lift: 0.04, stage: 2 },
    { lift: 0.15, stage: 2 },
    { lift: 0.46, stage: 1 },
    { lift: 0.58, stage: 1 },
    { lift: 0.88, stage: 0 },
  ],
};

/** Crown/trunk cut height as a fraction of a tree's height, and how far
 * the cut wanders — a wobbled plane, never a level slice. [D] */
const TREE_CUT = 0.35;
const TREE_CUT_WOBBLE = 0.06;

/** A variant's layout seed: kind + name + index folded into the same hash
 * family the prop's own wobble rides on. */
function variantSeed(kind: ChunkKind, name: string, index: number): number {
  let n = index * 97.3 + kind.length * 13.7;
  for (let i = 0; i < name.length; i++) n += name.charCodeAt(i) * (i + 1) * 0.37;
  return n;
}

/**
 * Finish a chunk: normals, then re-centre it on its own bounding-box
 * centre and report that centre (in parent space) as the offset, plus half
 * the box diagonal as the radius.
 */
function finishChunk(geometry: BufferGeometry, stage: PartStage): Chunk {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) throw new Error('chunk built to nothing');
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  geometry.translate(-cx, -cy, -cz);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  const radius =
    Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2;
  return { geometry, offset: { x: cx, y: cy, z: cz }, radius, stage };
}

// ── route 1: architectural parts, grouped ────────────────────────────────────

/** Union bounding box of a part list, as the whole prop's raw box. */
function partsBox(parts: readonly ArchPart[]): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
} {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    const b = part.geometry.boundingBox!;
    min.x = Math.min(min.x, b.min.x);
    min.y = Math.min(min.y, b.min.y);
    min.z = Math.min(min.z, b.min.z);
    max.x = Math.max(max.x, b.max.x);
    max.y = Math.max(max.y, b.max.y);
    max.z = Math.max(max.z, b.max.z);
  }
  return { min, max };
}

function archChunks(kind: ArchPropKind): Chunk[][] {
  return ARCH_VARIANT_DEFS[kind].map((def) => {
    const parts = def.parts({ split: true });
    // The whole prop's grounding transform, so chunks land in the same
    // object space the instanced prop lives in.
    const { scale, translate } = variantTransform(partsBox(parts), def.height);
    const order: string[] = [];
    const groups = new Map<string, { geometries: BufferGeometry[]; stage: PartStage }>();
    for (const part of parts) {
      let group = groups.get(part.group);
      if (!group) {
        group = { geometries: [], stage: part.stage };
        groups.set(part.group, group);
        order.push(part.group);
      }
      group.geometries.push(part.geometry);
    }
    return order.map((key) => {
      const group = groups.get(key)!;
      const geometry = mergeParts(group.geometries);
      geometry.scale(scale, scale, scale);
      geometry.translate(translate[0], translate[1], translate[2]);
      return finishChunk(geometry, group.stage);
    });
  });
}

// ── route 2: re-inflated lumps ───────────────────────────────────────────────

function lumpChunks(kind: 'monolith' | 'mountain' | 'rock'): Chunk[][] {
  const count = LUMP_COUNTS[kind];
  const tiers = LUMP_TIERS[kind];
  return PROP_VARIANT_DEFS[kind].map((def, index) => {
    const seed = variantSeed(kind, def.name, index);
    // One re-inflation per variant, at the small mask: every lump is the
    // same strokes at the same resolution, differing only by a uniform
    // scale and a seeded yaw, so scaling a single template is identical to
    // re-running the pipeline per lump — and ~5x cheaper.
    const template = buildInflatedVariant(kind, index, {
      size: PROP_MASK_SIZE_SMALL,
      gridStep: 12,
    });
    template.geometry.computeBoundingBox();
    const box = template.geometry.boundingBox!;
    // The template is normalized to the parent's own height, so its box IS
    // the parent's bounding volume — the box the lumps lay out inside.
    const height = def.height;
    const halfX = (box.max.x - box.min.x) / 2;
    const halfZ = (box.max.z - box.min.z) / 2;
    const chunks: Chunk[] = [];
    for (let i = 0; i < count; i++) {
      const tier = tiers[i]!;
      const lumpH = height * (0.45 + 0.15 * hash(seed + i * 5.7));
      const geometry = template.geometry.clone();
      const s = lumpH / height;
      geometry.scale(s, s, s);
      // A seeded yaw keeps four lumps off the same strokes from reading as
      // four copies of one shape.
      geometry.rotateY(hash(seed + i * 8.3) * Math.PI * 2);
      // Ring layout, tucked toward the axis as it climbs: wide at the foot,
      // narrow at the top, so the union keeps the parent's taper.
      const angle = (i / count) * Math.PI * 2 + shash(seed + i * 3.1) * 0.7;
      const reach = (0.3 + 0.14 * hash(seed + i * 11.3)) * (1 - 0.75 * tier.lift);
      const lift = Math.min(Math.max(tier.lift + shash(seed + i * 6.9) * 0.04, 0), 1);
      geometry.translate(
        Math.cos(angle) * reach * halfX,
        lumpH / 2 + lift * (height - lumpH),
        Math.sin(angle) * reach * halfZ,
      );
      chunks.push(finishChunk(geometry, tier.stage));
    }
    template.geometry.dispose();
    return chunks;
  });
}

// ── route 3: trees, cut by a wobbled height plane ────────────────────────────

/**
 * Cut a geometry's triangles by a wobbled height plane into [below,
 * above]. A triangle goes whole to the side its centroid lands on — the
 * cut is jagged and nothing is re-triangulated or capped, which is what a
 * break reads as on an inked blob.
 */
function cutByHeightPlane(
  geometry: BufferGeometry,
  y: number,
  seed: number,
  wobble: number,
): [BufferGeometry, BufferGeometry] {
  const position = geometry.getAttribute('position').array as ArrayLike<number>;
  const index = geometry.index?.array;
  const triangles = (index ? index.length : position.length / 3) / 3;
  const corner = (t: number, k: number): number => (index ? index[t * 3 + k]! : t * 3 + k) * 3;
  // Which side each triangle lands on, then the two arrays at exact size.
  const up = new Uint8Array(triangles);
  let upCount = 0;
  for (let t = 0; t < triangles; t++) {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < 3; k++) {
      const v = corner(t, k);
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
  const above = new Float32Array(upCount * 9);
  const below = new Float32Array((triangles - upCount) * 9);
  let ai = 0;
  let bi = 0;
  for (let t = 0; t < triangles; t++) {
    const into = up[t] ? above : below;
    let at = up[t] ? ai : bi;
    for (let k = 0; k < 3; k++) {
      const v = corner(t, k);
      into[at++] = position[v]!;
      into[at++] = position[v + 1]!;
      into[at++] = position[v + 2]!;
    }
    if (up[t]) ai = at;
    else bi = at;
  }
  const make = (values: Float32Array): BufferGeometry => {
    const out = new BufferGeometry();
    out.setAttribute('position', new BufferAttribute(values, 3));
    return out;
  };
  return [make(below), make(above)];
}

function treeChunks(kind: InflatedPropKind): Chunk[][] {
  return PROP_VARIANT_DEFS[kind].map((def, index) => {
    const seed = variantSeed(kind as ChunkKind, def.name, index);
    const parent = buildInflatedVariant(kind, index);
    const [trunk, crown] = cutByHeightPlane(
      parent.geometry,
      def.height * TREE_CUT,
      seed,
      def.height * TREE_CUT_WOBBLE,
    );
    parent.geometry.dispose();
    // Crown first (it is what an impact takes), trunk last.
    return [finishChunk(crown, 0), finishChunk(trunk, 2)];
  });
}

// ── the build ────────────────────────────────────────────────────────────────

/**
 * Every breakable kind's chunks, per variant: `[variant] → chunks`. Built
 * once; the caller owns the map (nothing is cached here).
 *
 * ROUTE 4, THE LIBRARY (2026-09-16, docs/katamari-props.md §c). On a katamari
 * world most props are the game's own models and their seams came with them:
 * `katamariChunksByKind` (src/world/katamari/attach.ts) hands back a
 * `Chunk[][]` per kind — a multipart glb's own meshes staged top-down, a
 * single-mesh one cut by the same wobbled height plane a tree is cut by — and
 * those REPLACE that kind's authored chunks.
 *
 * Only that kind's, though: a breakable kind the library does not cover keeps
 * its authored route, because the prop source keeps its authored VARIANTS too
 * (`mountain` — the game's island masses read as floating slabs, so a range
 * here is still the inflated lump). One prop set per kind, either way, and the
 * chunks always match the variants on screen.
 *
 * The keys of the library map are `PropKind`s and a few of them (the three
 * junk tiers, and the bushes and stumps the authored world never broke) are
 * not `ChunkKind`s. They are cast in, and the cast is safe for the only
 * reason that matters: every consumer looks a kind UP
 * (`set?.[variant]?.[index]`, src/world/loose.ts and src/world/debris.ts) and
 * a kind the map has no row for is already handled as "nothing to draw".
 */
export function buildChunkGeometries(
  library?: ReadonlyMap<string, Chunk[][]> | null,
): Map<ChunkKind, Chunk[][]> {
  const out = new Map<ChunkKind, Chunk[][]>();
  const fromLibrary = new Set<string>();
  if (library) {
    for (const [kind, chunks] of library) {
      out.set(kind as ChunkKind, chunks);
      fromLibrary.add(kind);
    }
  }
  for (const kind of ['monolith', 'mountain', 'rock'] as const) {
    if (!fromLibrary.has(kind)) out.set(kind, lumpChunks(kind));
  }
  for (const kind of ARCH_CHUNK_KINDS) {
    if (!fromLibrary.has(kind)) out.set(kind, archChunks(kind));
  }
  for (const kind of ['tree', 'conifer'] as const) {
    if (!fromLibrary.has(kind)) out.set(kind, treeChunks(kind));
  }
  return out;
}
