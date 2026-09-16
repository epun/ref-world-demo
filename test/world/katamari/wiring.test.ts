/**
 * The WIRING: the library as this world's prop source (src/world/katamari/
 * source.ts, docs/katamari-props.md §a–§e).
 *
 * What is pinned here is the seam, not the look:
 *
 *   - the COUNTS come off the in-bundle catalog and not off the download, so
 *     the placement is the same on a fast connection and a slow one — and
 *     the STOCK counts are untouched, which is what keeps meridian and the
 *     public world placement-identical;
 *   - the per-VARIANT region filter admits the `beach: true` models onto the
 *     sand and keeps the rest off it, deterministically: the same seed rolls
 *     the same picks twice;
 *   - `stickyFor` lets a MODEL disagree with its kind about rootedness (a
 *     bench is not planted, the vending machine beside it is);
 *   - the chunk map is the models' own parts, aligned with the variant
 *     order;
 *   - and a world with no game never reaches for the loader at all, which is
 *     the one thing a test can prove about a network call that must not
 *     happen.
 *
 * The global prop source is installed and torn down around every test that
 * needs it (`setActivePropSource(null)`), because it is a global for the same
 * reason the scatter seed is one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STICKY, stickyFor } from '../../../src/creatures/sticky';
import { buildChunkGeometries } from '../../../src/world/chunks';
import {
  KATAMARI_CATALOG,
  KATAMARI_REPLACED_KINDS,
  katamariVariantsOf,
  type KatamariEntry,
} from '../../../src/world/katamari/catalog';
import {
  assembleLibrary,
  buildKatamariModel,
  type KatamariLibrary,
} from '../../../src/world/katamari/models';
import {
  KATAMARI_KIND_DENSITY,
  katamariPendingSource,
  katamariPlacementSource,
  startKatamariWorld,
} from '../../../src/world/katamari/source';
import { katamariChunksByKind, katamariPropSource } from '../../../src/world/katamari/attach';
import {
  PROP_VARIANT_COUNTS,
  activePropCounts,
  setActivePropSource,
  type PropKind,
} from '../../../src/world/props';
import { computePlacements, setScatterSeed, variantCount } from '../../../src/world/scatter';
import {
  sampleLandscape,
  setIslandMode,
  setLandscapeMode,
} from '../../../src/world/landscape';

const MODELS = join(process.cwd(), 'public', 'katamari', 'models');

/** One single-mesh prop and one multipart one — both part routes. The
 * catalog is generated now, so these are ids that survived the curation:
 * `03a9` is a rock, `0136` is the bus (three meshes). */
const ROCK = KATAMARI_CATALOG.find((e) => e.id === '03a9')!;
const CAR = KATAMARI_CATALOG.find((e) => e.id === '0136')!;

function arrayBufferOf(file: string): ArrayBuffer {
  const buffer = readFileSync(join(MODELS, file));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

let library: KatamariLibrary;

beforeAll(async () => {
  // The same two globals `models.test.ts` documents: `parseAsync` reaches
  // for `self` and `createImageBitmap` the moment it meets an embedded
  // image, and nothing here samples a texture.
  (globalThis as unknown as { self: unknown }).self ??= globalThis;
  (globalThis as unknown as { createImageBitmap?: unknown }).createImageBitmap ??= async () => ({
    width: 4,
    height: 4,
    close() {},
  });
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const parse = async (entry: KatamariEntry): Promise<KatamariLibrary['models'][number]> => {
    const gltf = await new GLTFLoader().parseAsync(arrayBufferOf(entry.file), '');
    return buildKatamariModel(gltf.scene, entry);
  };
  library = assembleLibrary([await parse(ROCK), await parse(CAR)]);
});

afterEach(() => {
  setActivePropSource(null);
});

describe('the katamari prop source', () => {
  it('takes its variant counts from the catalog, not from the load', () => {
    const source = katamariPlacementSource();
    for (const kind of ['tree', 'building', 'small', 'medium', 'large'] as PropKind[]) {
      expect(source.counts[kind], kind).toBe(katamariVariantsOf(kind).length);
      expect(source.counts[kind], kind).toBeGreaterThan(0);
    }
    // A kind the table does not fill keeps its authored count — `cloud` is
    // the only one, and it is scenery in the sky.
    expect(source.counts.cloud).toBe(PROP_VARIANT_COUNTS.cloud);
    // The PENDING source (no geometry yet) rolls the identical counts: that
    // is the whole reason the two halves are separate.
    expect(katamariPendingSource().counts).toEqual(source.counts);
    expect(katamariPendingSource().variants.size).toBe(0);
  });

  it('leaves the stock counts exactly as they were', () => {
    const before = { ...PROP_VARIANT_COUNTS };
    katamariPlacementSource();
    expect({ ...PROP_VARIANT_COUNTS }).toEqual(before);
    // Nothing installed: the authored table is what the world rolls, and the
    // three library tier kinds have nothing behind them.
    expect(activePropCounts()).toEqual(PROP_VARIANT_COUNTS);
    for (const kind of ['small', 'medium', 'large'] as PropKind[]) {
      expect(variantCount(kind), kind).toBe(0);
    }
  });

  it('answers the installed source once it is installed', () => {
    setActivePropSource(katamariPlacementSource());
    expect(variantCount('small')).toBe(katamariVariantsOf('small').length);
    expect(variantCount('tree')).toBe(katamariVariantsOf('tree').length);
    // The marks are the scatter's own and never came from a prop source.
    expect(variantCount('tick')).toBe(1);
  });

  it('carries the catalog row down to the variant', () => {
    const source = katamariPlacementSource();
    const rows = katamariVariantsOf('medium');
    const meta = source.meta.get('medium' as PropKind)!;
    expect(meta.length).toBe(rows.length);
    rows.forEach((row, i) => {
      expect(meta[i]!.id).toBe(row.id);
      expect(meta[i]!.rooted).toBe(row.rooted);
      expect(meta[i]!.tier).toBe(row.tier);
      expect(meta[i]!.beach ?? false).toBe(row.beach ?? false);
    });
    // Mixed rootedness inside one kind is the whole point of per-variant
    // meta: a bench is not planted and a vending machine is.
    expect(new Set(meta.map((m) => m.rooted)).size).toBe(2);
  });

  it('steps the junk tiers down: small common, large a landmark', () => {
    expect(KATAMARI_KIND_DENSITY.small).toBeGreaterThan(KATAMARI_KIND_DENSITY.medium);
    expect(KATAMARI_KIND_DENSITY.medium).toBeGreaterThan(KATAMARI_KIND_DENSITY.large);
    expect(KATAMARI_KIND_DENSITY.large).toBeGreaterThan(0);
  });

  it('builds a variant per catalog row off the loaded models', () => {
    const source = katamariPropSource(library);
    const rocks = source.variants.get('rock' as PropKind)!;
    expect(rocks.length).toBe(katamariVariantsOf('rock').length);
    // Only one rock was parsed here, so the rows that lost their model wear
    // the one that loaded — the INDEX never shifts, which is what keeps a
    // placement's variant meaning the same thing on every device.
    const rockModel = library.byId.get(ROCK.id)!;
    const at = katamariVariantsOf('rock').findIndex((row) => row.id === ROCK.id);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rocks[at]!.geometry).toBe(rockModel.geometry);
    for (const variant of rocks) expect(variant.geometry).toBe(rockModel.geometry);
    expect(rocks[at]!.height).toBe(ROCK.heightUnits);
    // Every ROW keeps its index; the rows whose model did not load here wear
    // the one that did, so the variant index means the same on every device.
    expect(rocks[at]!.meta!.id).toBe(ROCK.id);
    expect(rocks.map((v) => v.meta!.id)).toEqual(
      katamariVariantsOf('rock').map((row) => row.id),
    );
    // A kind the library has nothing for falls back on the AUTHORED variants
    // (2026-09-16): the mountain and the cloud always, and here — with only
    // two glbs parsed — every other kind as well. A stock variant carries no
    // meta, which is how everything downstream tells the two apart.
    const mountains = source.variants.get('mountain' as PropKind)!;
    expect(mountains.length).toBe(PROP_VARIANT_COUNTS.mountain);
    for (const variant of mountains) expect(variant.meta).toBeUndefined();
    expect(source.variants.get('cloud' as PropKind)!.length).toBe(PROP_VARIANT_COUNTS.cloud);
    expect(source.counts.mountain).toBe(PROP_VARIANT_COUNTS.mountain);
    // …and the two library-drawn kinds here do carry it.
    for (const variant of rocks) expect(variant.meta).toBeDefined();
    source.draw?.dispose();
  });

  it('keeps the mountain authored — the library has no range in it', () => {
    // The game's island masses are floating hexagonal slabs a hundred metres
    // tall; a range built of them read as platforms hovering over the meadow
    // (2026-09-16, off a frame). They are level geometry, the auto-curation
    // drops everything over `MAX_SOURCE_HEIGHT_M`, and `mountain` is not a
    // replacement kind at all — so a katamari mountain is the authored
    // inflated lump, drawn from the mixed source.
    expect(KATAMARI_REPLACED_KINDS).not.toContain('mountain');
    expect(KATAMARI_CATALOG.some((e) => e.kind === 'mountain')).toBe(false);
    expect(katamariPlacementSource().counts.mountain).toBe(PROP_VARIANT_COUNTS.mountain);
    expect(katamariPlacementSource().meta.get('mountain' as PropKind)).toBeUndefined();
  });

  it('holds every row inside a prop’s size', () => {
    // What the level geometry was dropped FOR: a prop is something a creature
    // walks around, and the whole admitted set is normalised into a band.
    for (const entry of KATAMARI_CATALOG) {
      expect(entry.heightUnits, `${entry.id} ${entry.name}`).toBeLessThanOrEqual(12);
      expect(entry.heightUnits, `${entry.id} ${entry.name}`).toBeGreaterThan(0);
    }
  });

  it('draws every library variant with a material of the library’s own', () => {
    const source = katamariPropSource(library);
    const draw = source.draw!;
    const cel = draw.materialFor('large' as PropKind, 0, 'ghibli');
    const flat = draw.materialFor('large' as PropKind, 0, 'ink');
    expect(cel).not.toBeNull();
    expect(flat).not.toBeNull();
    expect(cel).not.toBe(flat);
    // The cel material is the posterised shader; the ink one is a stock
    // standard material wearing the same texture.
    expect(cel!.type).toBe('ShaderMaterial');
    expect(flat!.type).toBe('MeshStandardMaterial');
    expect(draw.windMaterials().length).toBeGreaterThan(0);
    // Asked twice, the same object — one material per texture.
    expect(draw.materialFor('large' as PropKind, 0, 'ink')).toBe(flat);
    draw.dispose();
  });
});

describe('the per-variant region filter', () => {
  /** The island — and therefore the beach — exists on a katamari world with
   * the map on, and nowhere else (src/world/landscape.ts `setIslandMode`). */
  beforeAll(() => {
    setIslandMode(true);
    setLandscapeMode('landscape');
  });
  afterAll(() => {
    setLandscapeMode('plain');
    setIslandMode(false);
  });

  it('puts the beach rows on the sand and keeps the rest off it', () => {
    setActivePropSource(katamariPlacementSource());
    setScatterSeed(7);
    const meta = katamariPlacementSource().meta;
    const placements = computePlacements({
      kindDensity: { small: 1, medium: 1, large: 1, tree: 1, conifer: 1 },
    });
    let sand = 0;
    let inland = 0;
    for (const p of placements) {
      const rows = meta.get(p.kind as PropKind);
      if (!rows) continue;
      const beachRow = rows[p.variant]?.beach === true;
      if (beachRow) sand++;
      else inland++;
    }
    // Both sets are actually placed — an empty one would make the assertion
    // below vacuous.
    expect(sand).toBeGreaterThan(0);
    expect(inland).toBeGreaterThan(0);
  });

  it('admits the both-region rows on the sand AND inland', () => {
    setActivePropSource(katamariPlacementSource());
    setScatterSeed(7);
    const rows = katamariVariantsOf('rock');
    // The stones carry `inland: true` beside `beach: true` — the beach wants
    // shingle and the same stone belongs in a field (2026-09-16).
    const both = rows
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => row.beach === true && row.inland === true);
    expect(both.length).toBeGreaterThan(0);
    const placements = computePlacements({ kindDensity: { rock: 1 } }).filter(
      (p) => p.kind === 'rock',
    );
    const used = new Set(placements.map((p) => p.variant));
    // Every both-region stone is placed somewhere…
    for (const { i } of both) expect(used, `rock variant ${i}`).toContain(i);
    // …and a beach-ONLY row of another kind stays off the field. Not "never
    // inland": a cluster's region is decided at its SEAT and its neighbours
    // are thrown 0.6–1.6 steps around it, so a cell that straddles the
    // tideline can put one prop of a sand set over the line. That is the
    // grove staying one species, which is the rule the cluster is for — what
    // must not happen is the field growing its own sand set.
    const sandRows = katamariVariantsOf('medium')
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => row.beach === true && row.inland !== true);
    expect(sandRows.length).toBeGreaterThan(0);
    const mediums = computePlacements({ kindDensity: { medium: 1 } }).filter(
      (p) => p.kind === 'medium',
    );
    expect(mediums.length).toBeGreaterThan(20);
    const sandOnly = new Set(sandRows.map(({ i }) => i));
    const placedSand = mediums.filter((p) => sandOnly.has(p.variant));
    expect(placedSand.length).toBeGreaterThan(0);
    // The field is not colonised by the sand set: of everything standing
    // inland, next to nothing is a beach-only row. (Measured this way round
    // on purpose — a cluster seated one step inland of the tideline throws a
    // neighbour or two over the line, which is the grove staying one species
    // and would make the other ratio look alarming for two props.)
    const inland = mediums.filter((p) => sampleLandscape(p.x, p.z).region !== 'beach');
    const inlandSand = inland.filter((p) => sandOnly.has(p.variant));
    expect(inland.length).toBeGreaterThan(20);
    expect(inlandSand.length / inland.length).toBeLessThan(0.05);
    // …and what IS on the sand is the sand set: a beach-only row reaches the
    // beach far more often than its share of the kind's variants.
    const onSand = mediums.filter((p) => sampleLandscape(p.x, p.z).region === 'beach');
    if (onSand.length > 0) {
      const share = onSand.filter((p) => sandOnly.has(p.variant)).length / onSand.length;
      expect(share).toBeGreaterThan(sandRows.length / katamariVariantsOf('medium').length);
    }
  });

  it('rolls the same picks twice from the same seed', () => {
    setActivePropSource(katamariPlacementSource());
    setScatterSeed(7);
    const a = computePlacements({ kindDensity: { small: 1, medium: 1, large: 1 } });
    setScatterSeed(7);
    const b = computePlacements({ kindDensity: { small: 1, medium: 1, large: 1 } });
    expect(a.length).toBe(b.length);
    expect(a.map((p) => `${p.kind}:${p.variant}:${p.x.toFixed(4)}`)).toEqual(
      b.map((p) => `${p.kind}:${p.variant}:${p.x.toFixed(4)}`),
    );
  });

  it('never rolls a variant the source has not got', () => {
    setActivePropSource(katamariPlacementSource());
    setScatterSeed(11);
    for (const p of computePlacements({ kindDensity: { small: 1, medium: 1, large: 1 } })) {
      expect(p.variant, p.kind).toBeGreaterThanOrEqual(0);
      expect(p.variant, p.kind).toBeLessThan(variantCount(p.kind));
    }
  });
});

describe('stickyFor', () => {
  it('is STICKY[kind] with no source installed', () => {
    for (const kind of ['tree', 'rock', 'building', 'small', 'medium'] as PropKind[]) {
      expect(stickyFor(kind, 0)).toBe(STICKY[kind]);
      expect(stickyFor(kind, 3)).toBe(STICKY[kind]);
    }
  });

  it('lets a library MODEL overrule its kind about rootedness', () => {
    setActivePropSource(katamariPlacementSource());
    const rows = katamariVariantsOf('medium');
    const planted = rows.findIndex((r) => r.rooted);
    const loose = rows.findIndex((r) => !r.rooted);
    expect(planted).toBeGreaterThanOrEqual(0);
    expect(loose).toBeGreaterThanOrEqual(0);
    expect(stickyFor('medium' as PropKind, planted).rooted).toBe(true);
    expect(stickyFor('medium' as PropKind, loose).rooted).toBe(false);
    // Everything else about the row is the tier's: the override is two
    // fields, not a second table.
    expect(stickyFor('medium' as PropKind, loose).breakStrength).toBe(
      STICKY.medium.breakStrength,
    );
    expect(stickyFor('medium' as PropKind, loose).attachmentStrength).toBe(
      STICKY.medium.attachmentStrength,
    );
  });

  it('agrees with the kind wherever the catalog does', () => {
    setActivePropSource(katamariPlacementSource());
    for (const entry of KATAMARI_CATALOG) {
      const kind = entry.kind as PropKind;
      const index = katamariVariantsOf(kind).indexOf(entry);
      const rules = stickyFor(kind, index);
      expect(rules.rooted, `${entry.id} ${entry.name}`).toBe(entry.rooted);
      expect(rules.tier, `${entry.id} ${entry.name}`).toBe(entry.tier);
    }
  });
});

describe('the chunk map', () => {
  it('is the models’ own parts, aligned with the variant order', () => {
    const chunks = katamariChunksByKind(library);
    const cars = chunks.get('large')!;
    const rows = katamariVariantsOf('large');
    expect(cars.length).toBe(rows.length);
    const car = library.byId.get(CAR.id)!;
    expect(cars[rows.findIndex((r) => r.id === CAR.id)]!.length).toBe(car.parts.length);
    for (const chunk of cars[0]!) {
      expect(chunk.geometry.getAttribute('position').count).toBeGreaterThan(0);
      // A katamari chunk is TEXTURED — a piece that lost its uv would draw
      // as one flat texel.
      expect(chunk.geometry.getAttribute('uv')).toBeDefined();
      expect(chunk.radius).toBeGreaterThan(0);
      expect([0, 1, 2]).toContain(chunk.stage);
    }
  });

  it('replaces the authored chunk routes wholesale', () => {
    const library_ = katamariChunksByKind(library);
    const built = buildChunkGeometries(library_);
    // A kind the library covers comes from the library…
    expect(built.get('rock')).toBe(library_.get('rock'));
    // …and a breakable kind it does not keeps its authored route, because the
    // prop source keeps that kind's authored VARIANTS too. One prop set per
    // kind, and the chunks always match what is on screen.
    expect(library_.has('mountain')).toBe(false);
    expect(built.get('mountain')!.length).toBe(PROP_VARIANT_COUNTS.mountain);
    // …and with no library it is exactly the authored map it always was.
    const stock = buildChunkGeometries();
    expect(stock.has('monolith')).toBe(true);
    expect(stock.get('tree')!.length).toBe(PROP_VARIANT_COUNTS.tree);
  });
});

describe('the loader gate', () => {
  it('is never reached for on a world with no game', async () => {
    let calls = 0;
    const load = async (): Promise<KatamariLibrary> => {
      calls++;
      return library;
    };
    expect(await startKatamariWorld('none', { load })).toBeNull();
    expect(calls).toBe(0);
    // …and not a tier of it either.
    let tiers = 0;
    expect(
      await startKatamariWorld('none', { load, onTier: () => tiers++ }),
    ).toBeNull();
    expect(tiers).toBe(0);
  });

  it('loads on a katamari world', async () => {
    let calls = 0;
    const tiers: string[] = [];
    const load = async (
      onTier?: (lib: KatamariLibrary, tier: string, done: boolean) => void,
    ): Promise<KatamariLibrary> => {
      calls++;
      // What `loadKatamariModels` does: one call per tier, the last one
      // flagged done (the caller attaches that one itself).
      onTier?.(library, 'small', false);
      onTier?.(library, 'building', true);
      return library;
    };
    const ready = await startKatamariWorld('katamari', {
      load,
      onTier: (_world, tier) => tiers.push(tier),
    });
    // The junk tier arrived on its own rebuild; the final one is the return.
    expect(tiers).toEqual(['small']);
    expect(ready?.library).toBe(library);
    expect(ready?.source.variants.size).toBeGreaterThan(0);
    expect(ready?.chunks.size).toBeGreaterThan(0);
    expect(calls).toBe(1);
    ready?.source.draw?.dispose();
  });

  it('survives a failed load with the world still standing', async () => {
    const load = (): Promise<KatamariLibrary> => Promise.reject(new Error('offline'));
    expect(await startKatamariWorld('katamari', { load })).toBeNull();
  });
});
