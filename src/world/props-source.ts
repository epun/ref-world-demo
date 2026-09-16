/**
 * WHICH PROPS this world is made of — the pure half of the seam
 * (docs/katamari-props.md §a, wired 2026-09-16).
 *
 * A prop source is the answer to two questions the world asks constantly and
 * has always answered from `src/world/props.ts` alone: how many variants has
 * this kind got, and what is true of THIS variant. The shipped world's
 * answer is the authored table and "nothing per variant" — every authored
 * tree is planted, every authored rock is loose, the facts belong to the
 * kind. The katamari library's answer is not: a bench is not planted and a
 * vending machine is, a parasol belongs on the sand and a mailbox does not
 * (docs/katamari-props.md §d).
 *
 * WHY THIS IS ITS OWN FILE, and a tiny one. The two readers are the pure
 * placement math (`src/world/scatter.ts`) and the pure pickup rules
 * (`src/creatures/sticky.ts`), and the second of those has no three.js in it
 * and must keep none. `src/world/props.ts` builds geometry and therefore
 * imports three, so the registry lives here instead and this module imports
 * nothing at runtime at all.
 *
 * ONE GLOBAL, installed once per world, for the same reason `setScatterSeed`
 * and `setIslandMode` are one: these readers are module functions with no
 * world handle to ask, and a second answer in flight would be a second
 * world. Nothing installed — every world but a katamari one, and every test
 * that does not say otherwise — is the shipped props.
 */

import type { Tier } from '../creatures/sticky';
import type { PropKind } from './props';

/**
 * Per-VARIANT facts a non-stock prop source carries.
 *
 * The stock props have none of these, which is why the whole interface is
 * optional at the read: `propVariantMeta` answering null means "the kind's
 * own rules answer for this variant", and that is the shipped world.
 */
export interface PropVariantMeta {
  /** The library model's id — the key its material and its parts hang on. */
  id: string;
  /** Lowercase display name, where the variant has one (TASTE §5). */
  label?: string;
  /** Belongs on the sand rather than inland (the scatter's region filter). */
  beach?: boolean;
  /** In the ground: overrides the kind's `STICKY.rooted`. */
  rooted: boolean;
  /** Overrides the kind's `STICKY.tier`. */
  tier: Tier;
}

/**
 * The PURE half of a prop source: everything the deterministic placement
 * math and the pickup rules need, and not one byte of geometry.
 *
 * Split from `PropSource` (src/world/props.ts) because the placement must
 * not wait for a download and must not vary with one: the katamari counts
 * and region flags come off the in-bundle catalog table, so every device
 * rolls the same world whether or not the glbs have arrived
 * (docs/katamari-props.md §e).
 */
export interface PropPlacementSource {
  /** Variants per kind, for the roll. */
  counts: Record<PropKind, number>;
  /** Per-kind variant meta, indexed by variant. */
  meta: Map<PropKind, readonly PropVariantMeta[]>;
  /** True for a library-backed source. */
  library: boolean;
}

let active: PropPlacementSource | null = null;

/** Install the source this world rolls and resolves against; `null` restores
 * the shipped props. */
export function setActivePropSource(source: PropPlacementSource | null): void {
  active = source;
}

/** The installed source, or null for the shipped props. */
export function activePropSource(): PropPlacementSource | null {
  return active;
}

/** The meta for one (kind, variant) — null whenever the kind is stock. */
export function propVariantMeta(kind: PropKind, variant: number): PropVariantMeta | null {
  return active?.meta.get(kind)?.[variant] ?? null;
}
