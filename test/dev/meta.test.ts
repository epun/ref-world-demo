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
      'refworld.landscape',
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

describe('the landscape folder carries the map switch and the terrain dials', () => {
  // The panel needs a DOM to mount, so — like the ground/scene seam tests —
  // this reads the source. What it pins is the wiring the user asked for
  // (2026-09-03: adjust the amount of elevation and the spacing of the
  // tiers; 2026-09-09: ship the flat plain and put the map behind a toggle
  // to sculpt live), plus the two things easy to drop: the debounce in front
  // of a ~300ms rebuild, and the session record so a replay re-applies it.
  const source = readFileSync(join(process.cwd(), 'src/dev/index.ts'), 'utf8');

  it('is a skill of its own, declared right after environment', () => {
    const ids = DEV_SKILLS_META.map((m) => m.id);
    expect(ids).toContain('refworld.landscape');
    expect(ids.indexOf('refworld.landscape')).toBe(ids.indexOf('refworld.environment') + 1);
    expect(source).toContain("metaOf('refworld.landscape')");
    expect(source).toContain("panelUi.addFolder('landscape')");
  });

  it('opens with the map switch, reading and writing the world handle', () => {
    expect(source).toContain("folder.addCheckbox('landscape', {");
    // Starts where the world is, never at a literal.
    expect(source).toContain('value: readLandscape?.() ?? false');
    expect(source).toContain('setLandscape(on)');
    // …and it is recorded, so a replay re-applies it (docs/SESSION.md).
    expect(source).toContain("session?.world('landscape', on ? 1 : 0)");
  });

  it('holds the terrain dials in the same folder, under the switch', () => {
    // They belong with the map they shape: the switch reveals the geography,
    // these three sculpt it. Order matters — the checkbox is first.
    const folder = source.slice(source.indexOf("panelUi.addFolder('landscape')"));
    expect(folder.indexOf("addCheckbox('landscape'")).toBeLessThan(
      folder.indexOf("addSlider('elevation'"),
    );
    // …and they left the environment folder behind them.
    const environment = source.slice(
      source.indexOf("panelUi.addFolder('environment')"),
      source.indexOf("panelUi.addFolder('landscape')"),
    );
    expect(environment).not.toContain("addSlider('elevation'");
  });

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

  it('and main.ts reads the mode off the address and writes it back', () => {
    // The panel tree-shakes out of the demo build, so `?landscape=1` is the
    // only way to open a deployed link on the map — and the toggle writes the
    // parameter back, so a reload during a demo keeps what was built up.
    const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).toContain("params.get('landscape')");
    expect(main).toContain("landscapeParam === '1' || landscapeParam === 'on'");
    expect(main).toContain('if (wantsLandscape) world.setLandscape(true);');
    expect(main).toContain("params.set('landscape', '1')");
    expect(main).toContain("params.delete('landscape')");
    expect(main).toContain('history.replaceState(null, ');
    // …and it is applied before anything is spawned into the world.
    expect(main.indexOf('if (wantsLandscape) world.setLandscape(true);')).toBeLessThan(
      main.indexOf('const creatures = createCreatureManager('),
    );
    // The panel handle drives both.
    expect(main).toContain('writeLandscapeParam(on)');
    expect(main).toContain('landscape: () => world.landscape()');
  });

  it('and main.ts replays the mode as a world event', () => {
    const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).toContain("field === 'landscape'");
    expect(main).toContain('world.setLandscape(value === 1 || value === true)');
  });

  it('keeps the shipped defaults inside their own limits', () => {
    for (const key of ['elevation', 'tierStep', 'relief'] as const) {
      const [lo, hi] = TERRAIN_LIMITS[key];
      expect(TERRAIN_DEFAULTS[key], key).toBeGreaterThanOrEqual(lo);
      expect(TERRAIN_DEFAULTS[key], key).toBeLessThanOrEqual(hi);
    }
  });
});
