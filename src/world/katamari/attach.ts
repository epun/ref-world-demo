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

import { MeshStandardMaterial, type Material, type ShaderMaterial } from 'three';
import type { WorldStyle } from '../style';
import type { PropDraw, PropKind, PropSource, PropVariant } from '../props';
import { katamariModelsOf, katamariPlacementSource, katamariPropKinds } from './source';
import { createKatamariMaterialSet } from './material';
import type { PropVariantMeta } from '../props-source';
import type { KatamariLibrary, KatamariModel, KatamariPart } from './models';

/** One model as a `PropVariant`: the loader already normalised it. */
function variantOf(model: KatamariModel, meta: PropVariantMeta): PropVariant {
  return { geometry: model.geometry, height: model.height, radius: model.radius, meta };
}

/**
 * The full source: the catalog's counts and meta, plus one `PropVariant` per
 * row backed by the library's normalised geometry.
 *
 * Kinds the catalog does not fill are absent from `variants`, which the
 * scatter reads as "draw none of this kind" — so a katamari world shows the
 * library's objects and never a mix of library models and inflated props.
 */
export function katamariPropSource(library: KatamariLibrary): PropSource {
  const placement = katamariPlacementSource();
  const variants = new Map<PropKind, PropVariant[]>();
  const models = new Map<PropKind, KatamariModel[]>();
  for (const kind of katamariPropKinds()) {
    const list = katamariModelsOf(library, kind);
    if (!list) continue;
    models.set(kind, list);
    const meta = placement.meta.get(kind)!;
    variants.set(
      kind,
      list.map((model, i) => variantOf(model, meta[i]!)),
    );
  }
  return { ...placement, variants, draw: katamariDraw(library, models) };
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
  return {
    materialFor(kind: PropKind, variant: number, style: WorldStyle): Material | null {
      const model = modelAt(kind, variant);
      if (!model) return null;
      if (style !== 'ghibli') return flatFor(model);
      cel ??= createKatamariMaterialSet(library);
      return cel.materialFor(model);
    },
    /** Only the cel materials carry the wind uniforms; the flat ones are
     * ordinary standard materials with no shader of their own. */
    windMaterials(): ShaderMaterial[] {
      return cel ? cel.materials() : [];
    },
    dispose(): void {
      cel?.dispose();
      cel = null;
      for (const material of flat.values()) material.dispose();
      flat.clear();
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
