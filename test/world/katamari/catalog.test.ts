/**
 * The catalog table is data, and data that is wrong here is wrong everywhere
 * downstream: a row naming a model that was never copied is a 404 at startup,
 * a row whose `tier` disagrees with `STICKY` is a prop that draws one way and
 * behaves another, and a height off by a factor of ten is a mug the size of a
 * building.
 *
 * So every claim the table makes is checked against something else that
 * already knows: the published files under `public/katamari/models/`, the
 * `PropKind` union, and `src/creatures/sticky.ts`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STICKY, type Tier } from '../../../src/creatures/sticky';
import {
  KATAMARI_BASE_URL,
  KATAMARI_CATALOG,
  KATAMARI_NEW_KINDS,
  KATAMARI_REPLACED_KINDS,
  isKatamariNewKind,
  katamariKinds,
  katamariVariantsOf,
} from '../../../src/world/katamari/catalog';
import { PROP_KINDS, type PropKind } from '../../../src/world/props';

const MODELS = join(process.cwd(), 'public', 'katamari', 'models');
const CATALOG_JSON = join(process.cwd(), 'public', 'katamari', 'catalog.json');

const TIERS: readonly Tier[] = ['small', 'medium', 'large', 'building'];

describe('katamari catalog', () => {
  it('names between 60 and 80-odd models, with no duplicate ids', () => {
    expect(KATAMARI_CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(KATAMARI_CATALOG.length).toBeLessThanOrEqual(90);
    const ids = KATAMARI_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const files = KATAMARI_CATALOG.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('every row names a glb that is published', () => {
    for (const entry of KATAMARI_CATALOG) {
      expect(entry.file.endsWith('.glb'), entry.id).toBe(true);
      // The file is named after the object id, which is how a row is traced
      // back to the library.
      expect(entry.file.startsWith(`${entry.id}_`), entry.file).toBe(true);
      expect(existsSync(join(MODELS, entry.file)), entry.file).toBe(true);
    }
  });

  it('publishes nothing the table does not name', () => {
    const named = new Set(KATAMARI_CATALOG.map((e) => e.file));
    for (const file of readdirSync(MODELS)) {
      if (file.endsWith('.glb')) expect(named.has(file), file).toBe(true);
    }
  });

  it('every kind is either a PropKind it replaces or a katamari tier kind', () => {
    for (const entry of KATAMARI_CATALOG) {
      if (isKatamariNewKind(entry.kind)) {
        expect(KATAMARI_NEW_KINDS).toContain(entry.kind);
      } else {
        expect(PROP_KINDS as readonly string[]).toContain(entry.kind);
        expect(KATAMARI_REPLACED_KINDS).toContain(entry.kind);
      }
    }
  });

  it('a replacement row agrees with STICKY about tier and rootedness', () => {
    for (const entry of KATAMARI_CATALOG) {
      if (isKatamariNewKind(entry.kind)) continue;
      const rules = STICKY[entry.kind as PropKind];
      expect(entry.tier, `${entry.id} ${entry.kind} tier`).toBe(rules.tier);
      expect(entry.rooted, `${entry.id} ${entry.kind} rooted`).toBe(rules.rooted);
    }
  });

  it('every tier is a real tier, and the new kinds carry their own tier', () => {
    for (const entry of KATAMARI_CATALOG) {
      expect(TIERS).toContain(entry.tier);
      if (entry.kind === 'small') expect(entry.tier).toBe('small');
      if (entry.kind === 'medium') expect(entry.tier).toBe('medium');
      if (entry.kind === 'large') expect(entry.tier).toBe('large');
    }
  });

  it('heights are sane, and in the band the kind stands in', () => {
    // The bands the world actually uses, read off PROP_VARIANT_DEFS, widened
    // enough that a variant may out-top or under-run the authored set a
    // little. A height outside these is a units mistake, not taste.
    const bands: Record<string, [number, number]> = {
      tree: [3, 8],
      conifer: [4, 8],
      bush: [0.6, 2],
      rock: [0.6, 2],
      stump: [0.6, 2],
      cactus: [1.5, 4],
      monolith: [3, 6],
      // No `mountain` row any more (2026-09-16): the game's island masses
      // are floating slabs and read as platforms, so the mountain stays the
      // authored inflated lump and the two islands are `large` outcrops.
      building: [2.4, 12],
      palm: [4, 8],
      picnicTable: [1, 3],
      waterTower: [5, 8],
      small: [0.1, 0.8],
      medium: [0.6, 3],
      large: [1, 7],
    };
    for (const entry of KATAMARI_CATALOG) {
      const band = bands[entry.kind];
      expect(band, `no height band for ${entry.kind}`).toBeDefined();
      expect(entry.heightUnits, `${entry.id} ${entry.name}`).toBeGreaterThanOrEqual(band![0]);
      expect(entry.heightUnits, `${entry.id} ${entry.name}`).toBeLessThanOrEqual(band![1]);
    }
  });

  it('every kind the table fills has at least one variant', () => {
    for (const kind of katamariKinds()) {
      expect(katamariVariantsOf(kind).length).toBeGreaterThan(0);
    }
    // Every new kind is actually populated — an empty tier is a scatter with
    // nothing to place.
    for (const kind of KATAMARI_NEW_KINDS) {
      expect(katamariVariantsOf(kind).length, kind).toBeGreaterThan(2);
    }
  });

  it('the new kinds carry a lowercase label, and the replacements do not need one', () => {
    for (const entry of KATAMARI_CATALOG) {
      if (!isKatamariNewKind(entry.kind)) continue;
      expect(entry.label, entry.id).toBeDefined();
      // TASTE §5: no uppercase, anywhere, in anything this world shows.
      expect(entry.label).toBe(entry.label!.toLowerCase());
    }
  });

  it('the beach set is real and small — sand, not a second world', () => {
    const beach = KATAMARI_CATALOG.filter((e) => e.beach === true);
    expect(beach.length).toBeGreaterThan(4);
    expect(beach.length).toBeLessThan(KATAMARI_CATALOG.length / 2);
  });

  it('the published catalog.json is the table', () => {
    const published = JSON.parse(readFileSync(CATALOG_JSON, 'utf8')) as {
      baseUrl: string;
      models: { id: string; file: string; heightUnits: number }[];
    };
    expect(published.baseUrl).toBe(KATAMARI_BASE_URL);
    expect(published.models.map((m) => m.id)).toEqual(KATAMARI_CATALOG.map((e) => e.id));
    expect(published.models.map((m) => m.heightUnits)).toEqual(
      KATAMARI_CATALOG.map((e) => e.heightUnits),
    );
  });
});
