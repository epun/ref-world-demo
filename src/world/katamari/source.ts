/**
 * The katamari library AS A PROP SOURCE — the seam that puts the game's own
 * objects where the scatter expects authored props (docs/katamari-props.md
 * §a, §e; wired 2026-09-16).
 *
 * WHAT A PROP SOURCE IS. `src/world/props.ts` splits a source in two: the
 * PURE half (`PropPlacementSource` — variant counts and per-variant meta)
 * and the geometry the scatter draws (`PropSource`). This file builds both
 * out of the catalog and the loaded library, and the split is the whole
 * point:
 *
 *   - the COUNTS and the REGION FLAGS come off `KATAMARI_CATALOG`, the
 *     in-bundle hand-written table, and are available on the first frame.
 *     Placement is pure and deterministic (PLAN §7.2), so it may not depend
 *     on how fast 1.4 MB of glb arrived: two handsets that loaded the
 *     library at different speeds must still roll the identical world.
 *   - the GEOMETRY arrives late, and until it does the katamari world draws
 *     its ground, its water and its marks and no props at all. That empty
 *     second is deliberate: the alternative is drawing the inflated props
 *     and then swapping them, which reads as the world changing its mind.
 *
 * VARIANT ORDER IS THE CATALOG'S ORDER, always — `katamariVariantsOf(kind)`.
 * A model that failed to load does not shift its neighbours out of their
 * index: its slot is filled by the first model of the kind that did load, so
 * the placement's variant index means the same thing on every device and a
 * flaky network costs a repeated model rather than a wrong one
 * (docs/katamari-props.md §e.4).
 *
 * PURE BUT FOR THE LOAD. Everything here is a pure function over the catalog
 * and an already-loaded library, except `startKatamariLibrary`, which is the
 * one place the loader is reached for — and it is reached for ONLY on a
 * katamari world. That gate is a function rather than a branch at the call
 * site so a test can prove a `game: 'none'` page never fetches a glb.
 */

import { PROP_VARIANT_COUNTS, type PropKind, type PropSource, type PropVariant } from '../props';
import type { PropPlacementSource, PropVariantMeta } from '../props-source';
import type { WorldGame } from '../game';
import {
  KATAMARI_BASE_URL,
  KATAMARI_CATALOG,
  isKatamariNewKind,
  katamariKinds,
  katamariVariantsOf,
  type KatamariEntry,
} from './catalog';
import type { KatamariLibrary, KatamariModel, KatamariPart } from './models';

/**
 * Per-kind density for the three junk tiers, in the same units as
 * `DEFAULT_KIND_DENSITY` (a multiplier on the regional tables).
 *
 * A katamari town is dense with small things and sparse with large ones, so
 * the tiers step down: mugs and cans everywhere, benches and vending
 * machines often, cars and lamp posts as landmarks. **[D]**
 */
export const KATAMARI_KIND_DENSITY: Record<'small' | 'medium' | 'large', number> = {
  small: 1,
  medium: 0.6,
  large: 0.35,
};

/** Every kind the catalog fills, as `PropKind`s (the table's kinds all are). */
export function katamariPropKinds(): PropKind[] {
  return katamariKinds() as PropKind[];
}

/** The catalog row as the world's per-variant meta (src/world/props.ts). */
function metaOf(entry: KatamariEntry): PropVariantMeta {
  return {
    id: entry.id,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(entry.beach === undefined ? {} : { beach: entry.beach }),
    ...(entry.inland === undefined ? {} : { inland: entry.inland }),
    rooted: entry.rooted,
    tier: entry.tier,
  };
}

/**
 * Counts and meta, off the table alone — no library, no network, no three.
 *
 * A kind the catalog does not fill keeps its stock count (`cloud` is the
 * only one: it is scenery in the sky and no katamari object reads as one).
 */
export function katamariPlacementSource(): PropPlacementSource {
  const counts: Record<PropKind, number> = { ...PROP_VARIANT_COUNTS };
  const meta = new Map<PropKind, readonly PropVariantMeta[]>();
  for (const kind of katamariPropKinds()) {
    const rows = katamariVariantsOf(kind);
    counts[kind] = rows.length;
    meta.set(kind, rows.map(metaOf));
  }
  return { counts, meta, library: true };
}

/**
 * The source a katamari world starts on: the catalog's placement rules with
 * NO geometry behind them, so the first frames draw ground, water and marks
 * and nothing else (see the header).
 */
export function katamariPendingSource(): PropSource {
  return { ...katamariPlacementSource(), variants: new Map<PropKind, PropVariant[]>() };
}

/**
 * The models behind one kind, in CATALOG order, with a failed row's slot
 * filled by the first model of the kind that loaded (see the header).
 * Returns null when the kind lost every one of its models — the caller then
 * leaves that kind out, and the scatter draws none of it.
 */
export function katamariModelsOf(
  library: KatamariLibrary,
  kind: PropKind,
): KatamariModel[] | null {
  const rows = katamariVariantsOf(kind);
  if (rows.length === 0) return null;
  const loaded = rows.map((row) => library.byId.get(row.id) ?? null);
  const first = loaded.find((m): m is KatamariModel => m !== null);
  if (!first) return null;
  return loaded.map((m) => m ?? first);
}

/** Whether a kind is one of the library's own junk tiers. */
export function isKatamariTierKind(kind: string): boolean {
  return isKatamariNewKind(kind as PropKind);
}

/** Every catalog row that belongs on the sand (the scatter's region filter
 * reads the per-variant flag; this is the same fact, for the tests). */
export function katamariBeachIds(): string[] {
  return KATAMARI_CATALOG.filter((entry) => entry.beach === true).map((entry) => entry.id);
}

/** How the library is fetched. Injected so a test can watch it. */
export type KatamariLoad = () => Promise<KatamariLibrary>;

/**
 * One model's breakable pieces — `KatamariPart[]`, which is a `Chunk[]` by
 * another name. Stated structurally so this file needs no import from the
 * destruction layer (the traffic goes the other way).
 */
export type KatamariPartList = KatamariLibrary['models'][number]['parts'];

/** Everything a katamari world needs once its models are in: the library
 * itself, the prop source the scatter swaps to, and the chunk map the
 * destruction layer breaks a prop into. */
export interface KatamariWorld {
  library: KatamariLibrary;
  source: PropSource;
  chunks: Map<string, KatamariPartList[]>;
}

/** The default: a DYNAMIC import, so a world without the game never pulls
 * the loader, `GLTFLoader` or the glbs' url into its first chunk. */
const defaultLoad: KatamariLoad = () =>
  import('./models').then((m) => m.loadKatamariModels(`${KATAMARI_BASE_URL}/`));

/**
 * Start loading the library and attach it — on a katamari world, and nowhere
 * else.
 *
 * Resolves to null on any other game (the loader is never called at all:
 * `test/world/katamari/wiring.test.ts` pins that with a stub) and on a
 * failure, which is warned about rather than thrown: a katamari world with
 * no library is the ground, the water and the marks, which is a frame
 * (docs/katamari-props.md §e.4).
 *
 * `./attach` is imported dynamically for the same reason `./models` is: the
 * cel material and the variant assembly belong to the game, so no other
 * world should carry them.
 */
export async function startKatamariWorld(
  game: WorldGame,
  load: KatamariLoad = defaultLoad,
): Promise<KatamariWorld | null> {
  if (game !== 'katamari') return null;
  try {
    const library = await load();
    const attach = await import('./attach');
    return {
      library,
      source: attach.katamariPropSource(library),
      chunks: attach.katamariChunksByKind(library),
    };
  } catch (error) {
    console.warn('katamari library did not load', error);
    return null;
  }
}
