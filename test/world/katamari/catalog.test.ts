/**
 * The catalog table is data, and data that is wrong here is wrong everywhere
 * downstream: a row naming a model that was never copied is a 404 at startup,
 * a row whose `tier` disagrees with `STICKY` is a prop that draws one way and
 * behaves another, and a height off by a factor of ten is a mug the size of a
 * building.
 *
 * So every claim the table makes is checked against something else that
 * already knows: the published files under `public/katamari/models/`, the
 * `PropKind` union, `src/creatures/sticky.ts` — and, since the table became
 * GENERATED (2026-09-16, `--all`), the rules it was generated from. The rows
 * are no longer hand-written, so what is worth pinning is that the generator
 * obeyed its own rules: the characters are out, every kind is inside its
 * height band, the active budget held, and the published json is the table.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STICKY, type Tier } from '../../../src/creatures/sticky';
import {
  ACTIVE_BUDGET,
  EXCLUDED_INTERNAL_PREFIXES,
  EXCLUDED_NAME_WORDS,
  KATAMARI_BASE_URL,
  KATAMARI_CATALOG,
  KATAMARI_NEW_KINDS,
  KATAMARI_REPLACED_KINDS,
  KIND_HEIGHT_BANDS,
  isKatamariNewKind,
  katamariKinds,
  katamariVariantsOf,
} from '../../../src/world/katamari/catalog';
import { PROP_KINDS, type PropKind } from '../../../src/world/props';

const MODELS = join(process.cwd(), 'public', 'katamari', 'models');
const CATALOG_JSON = join(process.cwd(), 'public', 'katamari', 'catalog.json');

const TIERS: readonly Tier[] = ['small', 'medium', 'large', 'building'];

describe('katamari catalog', () => {
  it('names a few hundred models, with no duplicate ids', () => {
    // The ACTIVE set (ACTIVE_BUDGET in rules.ts): enough variety that a field
    // does not read as one model stamped everywhere, few enough that the
    // scatter's one InstancedMesh per (kind, variant) stays a sane frame.
    expect(KATAMARI_CATALOG.length).toBeGreaterThanOrEqual(200);
    expect(KATAMARI_CATALOG.length).toBeLessThanOrEqual(400);
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

  it('heights are in the band the kind stands in', () => {
    // The bands are `KIND_HEIGHT_BANDS` in rules.ts — the same table the
    // generator clamps against, read here rather than copied, so the check
    // and the rule cannot drift. (There is no `mountain` band to check: the
    // game's island masses read as floating platforms, so that kind stays
    // the authored inflated lump.)
    for (const entry of KATAMARI_CATALOG) {
      const band = KIND_HEIGHT_BANDS[entry.kind];
      expect(band, `no height band for ${entry.kind}`).toBeDefined();
      expect(entry.heightUnits, `${entry.id} ${entry.name}`).toBeGreaterThanOrEqual(band![0]);
      expect(entry.heightUnits, `${entry.id} ${entry.name}`).toBeLessThanOrEqual(band![1]);
    }
  });

  it('keeps the game’s characters out', () => {
    // The one exclusion the user asked for, and the only one that matters:
    // every cousin is `OUJI<n>` internally, so the prefix takes the lot.
    for (const entry of KATAMARI_CATALOG) {
      for (const prefix of EXCLUDED_INTERNAL_PREFIXES) {
        expect(
          entry.internalName.startsWith(prefix),
          `${entry.id} ${entry.name} (${entry.internalName})`,
        ).toBe(false);
      }
      for (const word of EXCLUDED_NAME_WORDS) {
        expect(entry.name.toLowerCase().includes(word), `${entry.id} ${entry.name}`).toBe(false);
      }
    }
  });

  it('holds every kind to its active budget', () => {
    for (const kind of katamariKinds()) {
      const budget = ACTIVE_BUDGET[kind];
      expect(budget, `no budget for ${kind}`).toBeDefined();
      expect(katamariVariantsOf(kind).length, kind).toBeLessThanOrEqual(budget!);
    }
  });

  it('carries the provenance trail on every row', () => {
    for (const entry of KATAMARI_CATALOG) {
      // The id, the game's own internal name and the file are how a row is
      // traced back to the library; the file is named after the id.
      expect(entry.internalName.length, entry.id).toBeGreaterThan(0);
      expect(entry.file.startsWith(`${entry.id}_`), entry.file).toBe(true);
    }
  });

  it('every kind the table fills has at least one variant', () => {
    for (const kind of katamariKinds()) {
      expect(katamariVariantsOf(kind).length).toBeGreaterThan(0);
    }
    // Every new kind is actually populated — an empty tier is a scatter with
    // nothing to place — and the junk tiers carry real variety now.
    for (const kind of KATAMARI_NEW_KINDS) {
      expect(katamariVariantsOf(kind).length, kind).toBeGreaterThan(20);
    }
    // …and every kind the library stands in for is filled, so a katamari
    // world never draws an authored prop next to a library one (bar the
    // mountain and the cloud, which have no library answer).
    for (const kind of KATAMARI_REPLACED_KINDS) {
      expect(katamariVariantsOf(kind).length, kind).toBeGreaterThan(0);
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
    // Some of it stands in both places (a stone, a shell), and `inland` is
    // never written where it is already the default.
    const both = KATAMARI_CATALOG.filter((e) => e.inland === true);
    expect(both.length).toBeGreaterThan(0);
    for (const entry of both) expect(entry.beach, entry.id).toBe(true);
  });

  it('the published catalog.json is the table', () => {
    const published = JSON.parse(readFileSync(CATALOG_JSON, 'utf8')) as {
      baseUrl: string;
      models: { id: string; file: string; heightUnits: number; tier: string }[];
    };
    expect(published.baseUrl).toBe(KATAMARI_BASE_URL);
    expect(published.models.map((m) => m.id)).toEqual(KATAMARI_CATALOG.map((e) => e.id));
    expect(published.models.map((m) => m.heightUnits)).toEqual(
      KATAMARI_CATALOG.map((e) => e.heightUnits),
    );
    // The tier rides in the json because the LOADER reads it: the models are
    // fetched tier by tier so the junk appears before the skyline.
    expect(new Set(published.models.map((m) => m.tier))).toEqual(
      new Set(KATAMARI_CATALOG.map((e) => e.tier)),
    );
  });
});
