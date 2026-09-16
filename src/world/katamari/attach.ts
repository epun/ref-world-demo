/**
 * ATTACHING the loaded library to the world (docs/katamari-props.md §a–§c).
 *
 * The half of the seam that needs the models THEMSELVES: one `PropVariant`
 * per catalog row off the loaded geometry, the two materials the library
 * draws with, and the chunk map its parts already are. Split out of
 * `source.ts` for one reason — it is reached only through the dynamic import
 * in `startKatamariWorld`, so a world with no game carries neither the cel
 * shader nor the loader in its first chunk. The PURE half (counts, region
 * flags, the per-variant meta) stays in `source.ts` because the placement
 * reads it on the first frame.
 *
 * Nothing here imports the scatter, the scene or the destruction layer: the
 * traffic goes the other way, and `test/world/katamari/material.test.ts`
 * pins that.
 */

import {
  MeshStandardMaterial,
  type BufferGeometry,
  type Color,
  type Material,
  type ShaderMaterial,
} from 'three';
import type { WorldStyle } from '../style';
import {
  buildStockVariants,
  PROP_KINDS,
  type PropDraw,
  type PropKind,
  type PropSource,
  type PropVariant,
} from '../props';
import { katamariModelsOf, katamariPlacementSource, katamariPropKinds } from './source';
import { createKatamariMaterialSet } from './material';
import { createCanopyMaterial, type CanopyProfile } from '../ghibli/trees';
import { GHIBLI } from '../../taste/tokens';
import type { PropVariantMeta } from '../props-source';
import type { KatamariLibrary, KatamariModel, KatamariPart } from './models';

/*
 * THE TREE FAMILY IS NOT PAINTED BY ITS TEXTURE (2026-09-16, user report:
 * *"the tree objects don't look like trees"*).
 *
 * Everything else the library draws wears its own baked texture, and for a
 * building that is the whole point — the windows, the door and the fish on
 * the gable survive the quantise as flat poster colours. A PS2 tree's texture
 * is a 32-px green-brown smear standing in for leaves, and posterising THAT
 * gives five flat browns: the models came out as tan lumps.
 *
 * So the tree family takes envpaint's canopy material instead
 * (`createCanopyMaterial`, src/world/ghibli/trees.ts) — three quantised green
 * bands up the crown, a brown trunk under `uTrunkLine`, the hard warm sun
 * dab, a per-instance hue drift — which is what the AUTHORED trees have worn
 * on this style since the ghibli port. The silhouette stays the library's;
 * only the paint changes, and it is the paint this world already uses for
 * foliage.
 *
 * `uTrunkLine` is MEASURED off each model (`trunkLineOf`) rather than shared:
 * the authored trees' 0.42 means nothing to a palm, to a garden plant with no
 * trunk at all, or to a cherry tree.
 */
const CANOPY_KINDS: ReadonlySet<string> = new Set(['tree', 'conifer', 'bush', 'palm']);

/** Which wind recipe a canopy kind sways on — the scatter's own three. */
const CANOPY_PROFILE: Record<string, CanopyProfile> = { palm: 'palm' };

/** How many height bands the width profile is measured in. [D] — fine enough
 * to find a trunk, coarse enough that one stray vertex cannot invent one. */
const TRUNK_BANDS = 24;
/** A band this narrow, relative to the model's widest, is trunk. [D] */
const TRUNK_WIDTH = 0.35;
/** The trunk may not be read as more than this much of the prop: a tall thin
 * thing (a palm) is still a crown on a stick, never a stick. [D] */
const TRUNK_LINE_MAX = 0.62;

/**
 * Where a model stops being trunk and starts being canopy, as a fraction of
 * its height.
 *
 * The width profile along y: the lowest run of bands whose horizontal extent
 * is under `TRUNK_WIDTH` of the widest band is the trunk, and the top of that
 * run is the line. A model with no narrow foot — a garden plant, a bush —
 * answers 0 and is canopy all the way down, which is the truth about a bush.
 *
 * Pure and deterministic: a vertex scan, no hashing, no clock.
 */
export function trunkLineOf(geometry: BufferGeometry, height: number): number {
  const position = geometry.getAttribute('position');
  if (!position || height <= 0) return 0;
  const widest = new Float64Array(TRUNK_BANDS);
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const band = Math.min(TRUNK_BANDS - 1, Math.max(0, Math.floor((y / height) * TRUNK_BANDS)));
    const r = Math.hypot(position.getX(i), position.getZ(i));
    if (r > widest[band]!) widest[band] = r;
  }
  let max = 0;
  for (const r of widest) max = Math.max(max, r);
  if (max <= 0) return 0;
  let bands = 0;
  while (bands < TRUNK_BANDS && widest[bands]! < max * TRUNK_WIDTH) bands++;
  return Math.min(bands / TRUNK_BANDS, TRUNK_LINE_MAX);
}

/** One model as a `PropVariant`: the loader already normalised it. */
function variantOf(model: KatamariModel, meta: PropVariantMeta): PropVariant {
  return { geometry: model.geometry, height: model.height, radius: model.radius, meta };
}

/**
 * The full source: the catalog's counts and meta, one `PropVariant` per row
 * off the library's normalised geometry — and the AUTHORED variants for the
 * kinds the catalog does not fill.
 *
 * IT MIXES, and by 2026-09-16 that is deliberate rather than a leftover. Two
 * kinds have no honest library answer:
 *
 *   - **`mountain`.** The game's own island masses are floating hexagonal
 *     slabs; a range built out of them read as stacked platforms hovering
 *     over the meadow. A mountain here is the authored inflated lump, which
 *     is also what `MOUNTAIN_FOOTPRINT` and the mountain pre-pass measure.
 *     The two islands moved to the `large` tier as beached outcrops.
 *   - **`cloud`.** Scenery in the sky with no collider, placed only by a
 *     brush. No katamari object reads as one, and a painted sky on a
 *     katamari world should still draw.
 *
 * A stock variant carries no `meta`, so `stickyFor` answers the kind's own
 * row for it and `materialFor` falls through to the stock/ghibli albedo — the
 * mixing costs no branch anywhere downstream.
 *
 * A kind whose models ALL failed to load falls back the same way, which is
 * the better of the two frames: an authored mountain range beside library
 * trees is odd, an empty kind is a hole.
 */
export function katamariPropSource(library: KatamariLibrary): PropSource {
  const placement = katamariPlacementSource();
  const variants = new Map<PropKind, PropVariant[]>();
  const models = new Map<PropKind, KatamariModel[]>();
  const stock: PropKind[] = [];
  for (const kind of PROP_KINDS) {
    const list = katamariModelsOf(library, kind);
    if (!list) {
      // No library row for this kind (or nothing of it loaded): the authored
      // variants stand, and the catalog's counts already say how many there
      // are — `katamariPlacementSource` leaves an unfilled kind's stock count
      // exactly as it was.
      if (placement.counts[kind] > 0) stock.push(kind);
      continue;
    }
    models.set(kind, list);
    const meta = placement.meta.get(kind)!;
    variants.set(
      kind,
      list.map((model, i) => variantOf(model, meta[i]!)),
    );
  }
  for (const [kind, built] of buildStockVariants(stock)) variants.set(kind, built);
  return { ...placement, variants, draw: katamariDraw(library, models) };
}

/** The kinds this source draws from the AUTHORED props — for the tests and
 * the chunk map (`katamariChunksByKind` leaves them out, so the destruction
 * layer builds their authored chunks). */
export function katamariStockKinds(library: KatamariLibrary): PropKind[] {
  return PROP_KINDS.filter(
    (kind) => katamariModelsOf(library, kind) === null && katamariPlacementSource().counts[kind] > 0,
  );
}

/**
 * HOW THE LIBRARY DRAWS (docs/katamari-props.md §b, decision 3).
 *
 * Two looks, because the world has two (`src/world/style.ts`) and the game
 * is not the look: a katamari world set to `ghibli` wears the posterised cel
 * material this library came with (`createKatamariMaterial` — toon over a
 * quantised PS2 texture), and one set to `ink` wears a plain
 * `MeshStandardMaterial` with the same texture on it, so the models still
 * read as props with the toon chain inert. What is NOT on offer is the stock
 * albedo: a library model with its texture thrown away is a grey lump.
 *
 * Both sets are built lazily and shared per TEXTURE, so eighty-two models
 * are eighty-two draw calls and not eighty-two compiles.
 */
function katamariDraw(
  library: KatamariLibrary,
  models: Map<PropKind, KatamariModel[]>,
): PropDraw {
  let cel: ReturnType<typeof createKatamariMaterialSet> | null = null;
  const flat = new Map<string, MeshStandardMaterial>();
  /** One canopy material per tree-family MODEL: the trunk line and the crown
   * centre are measured off that model, so they cannot be shared. */
  const canopies = new Map<string, ShaderMaterial>();
  const modelAt = (kind: PropKind, variant: number): KatamariModel | null =>
    models.get(kind)?.[variant] ?? null;
  /** The ink-style material for one model: its texture, nothing else. One
   * per texture, keyed the way the cel set keys its own. */
  const flatFor = (model: KatamariModel): MeshStandardMaterial => {
    const key = `${model.texture ? model.id : 'flat'}|${model.alphaMode}|${model.doubleSide ? 'two' : 'one'}`;
    const existing = flat.get(key);
    if (existing) return existing;
    const material = new MeshStandardMaterial({
      name: `katamari-flat-${model.id}`,
      map: model.texture,
      roughness: 1,
      metalness: 0,
      ...(model.doubleSide ? { side: 2 } : {}),
    });
    if (model.alphaMode === 'mask') material.alphaTest = 0.5;
    else if (model.alphaMode === 'blend') {
      material.transparent = true;
      material.depthWrite = false;
    }
    flat.set(key, material);
    return material;
  };
  /** The canopy material for one tree-family model (see CANOPY_KINDS). */
  const canopyFor = (kind: PropKind, model: KatamariModel): ShaderMaterial => {
    const existing = canopies.get(model.id);
    if (existing) return existing;
    const trunkLine = trunkLineOf(model.geometry, model.height);
    const material = createCanopyMaterial({
      profile: CANOPY_PROFILE[kind] ?? 'sway',
      trunkLine,
      // The crown's own middle: the blob-normal approximation the canopy
      // shader mixes in wants the centre of the foliage, not of the prop.
      crownY: model.height * ((trunkLine + 1) / 2),
      // Frond blades and leaf cards are thin: both faces draw, as the
      // authored palm's do.
      doubleSide: model.doubleSide || kind === 'palm',
    });
    material.name = `katamari-canopy-${model.id}`;
    // The cherry tree blossoms. **[D]** — it is the one pink this world
    // already has a token for, and a cherry tree in an anime spring is not
    // green. The dark band stays canopy shade, so it reads as blossom over
    // leaf rather than as a pink lump.
    if (model.id === '0369') {
      (material.uniforms.uCanopyLight!.value as Color).set(GHIBLI.flowerPink);
    }
    canopies.set(model.id, material);
    return material;
  };
  return {
    materialFor(kind: PropKind, variant: number, style: WorldStyle): Material | null {
      const model = modelAt(kind, variant);
      if (!model) return null;
      // Under `ink` every library prop keeps its texture — the canopy
      // material is a cel material and has no business on that style.
      if (style !== 'ghibli') return flatFor(model);
      if (CANOPY_KINDS.has(kind)) return canopyFor(kind, model);
      cel ??= createKatamariMaterialSet(library);
      return cel.materialFor(model);
    },
    /** The cel and canopy materials carry the wind uniforms; the flat ones
     * are ordinary standard materials with no shader of their own. */
    windMaterials(): ShaderMaterial[] {
      return [...(cel ? cel.materials() : []), ...canopies.values()];
    },
    dispose(): void {
      cel?.dispose();
      cel = null;
      for (const material of flat.values()) material.dispose();
      flat.clear();
      for (const material of canopies.values()) material.dispose();
      canopies.clear();
    },
  };
}

/**
 * The library's breakable parts, keyed and ORDERED exactly as the variants
 * are — the katamari half of `buildChunkGeometries` (docs/katamari-props.md
 * §c). A `KatamariPart` IS a `Chunk` by another name — same four fields, same
 * object space — so nothing is rebuilt here: the loader already cut every
 * model, and the type stays the library's own so this file needs no import
 * from the destruction layer.
 */
export function katamariChunksByKind(library: KatamariLibrary): Map<string, KatamariPart[][]> {
  const out = new Map<string, KatamariPart[][]>();
  for (const kind of katamariPropKinds()) {
    const models = katamariModelsOf(library, kind);
    if (!models) continue;
    out.set(
      kind,
      models.map((model) => model.parts.map((part) => ({ ...part }))),
    );
  }
  return out;
}
