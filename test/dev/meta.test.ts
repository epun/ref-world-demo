/**
 * Pure metadata tests for the ghost-panel dev skills (PLAN §10). The
 * descriptors live in src/dev/skills-meta.ts precisely so this can run in
 * node with no DOM and no ghost-panel import.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERRAIN_DEFAULTS, TERRAIN_LIMITS } from '../../src/world/landscape';
import { DEV_SKILLS_META } from '../../src/dev/skills-meta';

describe('dev skill metadata', () => {
  it('has at least the specced skills', () => {
    const ids = DEV_SKILLS_META.map((m) => m.id);
    for (const required of [
      'refworld.demo',
      'refworld.environment',
      'refworld.character',
      'refworld.taste',
      'refworld.weather',
    ]) {
      expect(ids).toContain(required);
    }
  });

  it('ids are unique', () => {
    const ids = DEV_SKILLS_META.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ids are namespaced under refworld.', () => {
    for (const m of DEV_SKILLS_META) {
      expect(m.id).toMatch(/^refworld\.[a-z][a-z-]*$/);
    }
  });

  it('names, categories, and descriptions are lowercase (taste §5)', () => {
    for (const m of DEV_SKILLS_META) {
      expect(m.name).not.toMatch(/[A-Z]/);
      expect(m.category).not.toMatch(/[A-Z]/);
      expect(m.description).not.toMatch(/[A-Z]/);
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
    }
  });

  it('src/dev is importable in node and initDevPanel bails without a dom', async () => {
    const mod = await import('../../src/dev');
    expect(typeof mod.initDevPanel).toBe('function');
    // No DOM in the vitest node environment → resolves null, imports nothing.
    const handle = await mod.initDevPanel({} as never);
    expect(handle).toBeNull();
    // The fallback fixtures ride along and stay deterministic data.
    expect(mod.FALLBACK_DRAWINGS.length).toBeGreaterThanOrEqual(2);
    for (const drawing of mod.FALLBACK_DRAWINGS) {
      expect(drawing.length).toBeGreaterThan(0);
    }
  });
});

describe('the environment folder carries the terrain dials', () => {
  // The panel needs a DOM to mount, so — like the ground/scene seam tests —
  // this reads the source. What it pins is the wiring the user asked for
  // (2026-09-03: adjust the amount of elevation and the spacing of the
  // tiers), plus the two things easy to drop: the debounce in front of a
  // ~300ms rebuild, and the session record so a replay re-applies the dial.
  const source = readFileSync(join(process.cwd(), 'src/dev/index.ts'), 'utf8');

  it('adds elevation, tier spacing and relief spread, at the module limits', () => {
    for (const label of ["'elevation'", "'tier spacing'", "'relief spread'"]) {
      expect(source, label).toContain(`folder.addSlider(${label}, {`);
    }
    expect(source).toContain('TERRAIN_LIMITS.elevation[0]');
    expect(source).toContain('TERRAIN_LIMITS.elevation[1]');
    expect(source).toContain('TERRAIN_LIMITS.tierStep[0]');
    expect(source).toContain('TERRAIN_LIMITS.relief[1]');
    // …and the sliders start where the world actually is, not at a literal.
    expect(source).toContain('value: live.elevation');
    expect(source).toContain('value: live.tierStep');
    expect(source).toContain('value: live.relief');
  });

  it('debounces the rebuild and records each dial into the session log', () => {
    expect(source).toContain('const TERRAIN_DEBOUNCE_MS = 150;');
    expect(source).toContain('TERRAIN_DEBOUNCE_MS);');
    for (const kind of ['elevation', 'tierStep', 'relief']) {
      expect(source, kind).toContain(`session?.world('terrain', v, '${kind}')`);
    }
  });

  it('and main.ts replays that field back onto the world', () => {
    const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).toContain("field === 'terrain'");
    expect(main).toContain('world.setTerrain({ [kind]: value })');
  });

  it('keeps the shipped defaults inside their own limits', () => {
    for (const key of ['elevation', 'tierStep', 'relief'] as const) {
      const [lo, hi] = TERRAIN_LIMITS[key];
      expect(TERRAIN_DEFAULTS[key], key).toBeGreaterThanOrEqual(lo);
      expect(TERRAIN_DEFAULTS[key], key).toBeLessThanOrEqual(hi);
    }
  });
});
