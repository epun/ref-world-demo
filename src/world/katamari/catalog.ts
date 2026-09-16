/**
 * THE CATALOG — which library models this world draws (user ask, 2026-09-15
 * and 2026-09-16: *"replace them with the objects from the Katamari
 * library"*, then *"bring as many katamari objects in from the library as
 * possible, minus the main characters"*).
 *
 * This file is the seam and nothing else:
 *
 *   - the RULES that derive a row from a library model — what is excluded,
 *     how a name picks a kind, how metres become units, how many variants of
 *     each kind the world draws — are `./rules.ts`, hand-written and
 *     documented, and they are what a reviewer reads;
 *   - the ROWS are `./catalog.data.ts`, GENERATED from the library's
 *     `manifest.json` and those rules by `scripts/katamari-curate.mjs --all`.
 *     Do not edit them by hand: the next curate run would throw the edit
 *     away, and the test pins that the file is a pure function of the two
 *     inputs.
 *
 * It replaced 82 rows written out one at a time. The first pass was hand-made
 * because the shape of the thing was unknown; 1,500 rows is not, and a table
 * that size is only trustworthy if it is derived — one rule with a reason
 * beats a thousand eyeballed numbers.
 *
 * NAMES ARE DATA. `name` and `internalName` are the manifest's own strings,
 * verbatim, so any row can be traced back to the library and to the game;
 * they are keys, never rendered. Anything this world would ever SHOW is
 * `label`, and every label is lowercase (TASTE §5).
 *
 * PROVENANCE. These models are a personal-use extraction from a retail copy
 * of *Katamari Damacy* (`SLUS-21008`). The assets remain Namco's; `valiocon`
 * is a private demo world and they ship to that deployment only (the vite
 * config drops `public/katamari/` from every other build). See
 * `public/katamari/README.md` and `docs/katamari-props.md`.
 *
 * PURE. Nothing at runtime but the generated rows beside it — no three.js —
 * so `scripts/katamari-curate.mjs` can load this straight through node's type
 * stripping.
 */

import { KATAMARI_ROWS } from './catalog.data';
import type { KatamariEntry, KatamariKind } from './rules';

export type {
  KatamariEntry,
  KatamariKind,
  KatamariNewKind,
} from './rules';
export {
  ACTIVE_BUDGET,
  ACTIVE_SEED,
  BEACH_NAME_PATTERN,
  BOTH_REGIONS_NAME_PATTERN,
  EXCLUDED_INTERNAL_PREFIXES,
  EXCLUDED_NAME_WORDS,
  KATAMARI_BASE_URL,
  KATAMARI_CATALOG_FILE,
  KATAMARI_MODELS_DIR,
  KATAMARI_NEW_KINDS,
  KATAMARI_REPLACED_KINDS,
  KIND_HEIGHT_BANDS,
  KIND_NAME_RULES,
  MAX_SOURCE_HEIGHT_M,
  ROOTED_KINDS,
  ROOTED_NAME_PATTERN,
  TIER_BANDS,
  TIER_LOAD_ORDER,
  WORLD_SCALE,
  isKatamariNewKind,
  kindHeightBand,
} from './rules';

/**
 * The table: the ACTIVE set, in catalog order.
 *
 * "Active" because the admitted set is over 1,500 models and the scatter
 * draws one `InstancedMesh` per (kind, variant). `ACTIVE_BUDGET` in
 * `./rules.ts` says how many of each kind ship; the pick is a seeded shuffle
 * of the admitted rows, materialised here so every device draws the identical
 * world with no shuffle at runtime.
 */
export const KATAMARI_CATALOG: readonly KatamariEntry[] = KATAMARI_ROWS;

/** Rows for one kind, in table order (the scatter's variant order). */
export function katamariVariantsOf(kind: KatamariKind): KatamariEntry[] {
  return KATAMARI_CATALOG.filter((entry) => entry.kind === kind);
}

/** Every kind the table actually fills. */
export function katamariKinds(): KatamariKind[] {
  const out: KatamariKind[] = [];
  for (const entry of KATAMARI_CATALOG) if (!out.includes(entry.kind)) out.push(entry.kind);
  return out;
}

/** One row by its game id, or undefined. */
export function katamariEntry(id: string): KatamariEntry | undefined {
  return KATAMARI_CATALOG.find((entry) => entry.id === id);
}
