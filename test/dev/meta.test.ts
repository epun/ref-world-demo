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
      'refworld.paint',
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

  it('sits next to paint — the switch, then the brush that sculpts what it reveals', () => {
    // The folders mount in DEV_SKILLS_META order (the apply loop at the end
    // of initDevPanel), so this IS the panel's reading order: reveal the map,
    // then shape it by hand.
    const ids = DEV_SKILLS_META.map((m) => m.id);
    expect(ids.indexOf('refworld.paint')).toBe(ids.indexOf('refworld.landscape') + 1);
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

describe('the paint skill is wired the way the port plan asks', () => {
  // Same reading as the terrain-dial block above: the panel needs a dom to
  // mount, so this pins the wiring in source. What it protects is the four
  // things a refactor could silently drop and nothing else would notice —
  // the hook into the one module that owns heights, the world size the layer
  // is mapped against, the gate that keeps the world's own pointer working,
  // and the rebuild that has to happen when the pointer lifts.
  const source = readFileSync(join(process.cwd(), 'src/dev/paint.ts'), 'utf8');

  it('installs the painted sampler on the landscape, and takes it off again', () => {
    expect(source).toMatch(/import \{[^}]*\bsetPaintedHeight\b[^}]*\} from '\.\.\/world\/landscape'/);
    expect(source).toMatch(/import \{[^}]*\bsetPaintedPlanting\b[^}]*\} from '\.\.\/world\/landscape'/);
    expect(source).toContain('setPaintedHeight(paintedSampler(map))');
    expect(source).toContain('setPaintedHeight(null)');
    // …and the planting seam beside it (the environment brush kit).
    expect(source).toContain('setPaintedPlanting(plantingSampler(map))');
    expect(source).toContain('setPaintedPlanting(null)');
  });

  it('shares every paint layer buffer with the map rather than copying them', () => {
    expect(source).toContain('createPaintedMap(');
    expect(source).toContain('heightLayer.data as Float32Array');
    expect(source).toContain('waterLayer.data as Float32Array');
    // …and one weight layer per planting brush, on the same terms.
    expect(source).toContain('plantData[brush] = l.data as Float32Array;');
    expect(source).toContain('worldSize: PAINTED_SIZE');
  });

  it('leaves the world its pointer until painting is switched on', () => {
    // Shift became the INVERT modifier (2026-09-09, user ask), so the camera
    // escape moved to space, the secondary button and two fingers.
    expect(source).toContain(
      'painting && !spaceHeld && event.button === 0 && event.isPrimary',
    );
    expect(source).toContain('brush.enabled = false');
    expect(source).toContain('handles.setSoloDrag?.(!on)');
  });

  it('registers the four height tools and the two water ones, hotkeys 1-6', () => {
    // The height four are built through `recorded(id, …)` — the helper that
    // records the dab and then stamps it — so the id is its first argument
    // rather than a literal field, and the ids come from HEIGHT_TOOL_IDS —
    // the same table the replay routing reads (src/dev/paint-tools.ts). The
    // water two carry an `onStamp` of their own (`stampWater`), so they stay
    // literal descriptors.
    for (let i = 0; i < 4; i++) {
      expect(source, `tool ${i}`).toContain(`recorded(HEIGHT_TOOL_IDS[${i}]`);
    }
    for (const id of ['pond', 'drain']) {
      expect(source, id).toContain(`id: '${id}'`);
    }
    expect(source).toContain("const TOOL_KEYS = ['1', '2', '3', '4', '5', '6'] as const;");
    expect(source).toContain('layer: HEIGHT_LAYER');
    expect(source).toContain('layer: WATER_LAYER');
    expect(source).toContain("altMode: 'smooth'");
  });

  // The water half of the port (plan step 4). Same reading as above: what a
  // refactor could drop in silence is the CHAIN — a level layer that shares
  // the map's buffer is worth nothing until it is derived, installed on the
  // geography, handed to the renderer and rebuilt, and each of those four is
  // a different module answering for a different part of the same pond.
  it('derives the water and hands it to the geography, the renderer and the world', () => {
    expect(source).toMatch(/import \{[^}]*\bsetPaintedWater\b[^}]*\} from '\.\.\/world\/landscape'/);
    expect(source).toContain('const field = deriveWater(map);');
    expect(source).toContain('setPaintedWater(field);');
    expect(source).toContain('handles.setPaintedWater(field);');
    expect(source).toContain('handles.rebuildLandscape();');
    // …and gives all of it back on teardown.
    expect(source).toContain('setPaintedWater(null);');
    expect(source).toContain('handles.setPaintedWater(null);');
  });

  it('asserts the two DRY sentinels are the same number', () => {
    expect(source).toContain('if (WATER_DRY !== DRY)');
  });

  it('a pond stroke is one plane, at the authored basin drop under the bank', () => {
    expect(source).toContain('TERRAIN.basinDrop * handles.terrain().elevation');
    expect(source).toContain('bankHeight(handles.sampleHeight');
    // An extension of a body already painted keeps that body's own level.
    expect(source).toContain('field.level(hit.x, hit.z)');
    // [D] spatter off: `deriveWater` would cull the droplets texel by texel.
    expect(source).toContain('const shape: EdgeShape = { spatter: 0 };');
  });

  it('rebuilds from a dirty rect, so an undo reaches the world too', () => {
    const sweep = source.slice(source.indexOf('handles.onFrame(() => {'));
    expect(sweep.slice(0, 1400)).toContain('if (waterLayer.dirtyRect)');
    expect(sweep.slice(0, 1400)).toContain('if (heightLayer.dirtyRect) rebuildSoon();');
    // …and before `commitAll`, which is what clears those rects.
    expect(sweep.indexOf('dirtyRect')).toBeLessThan(sweep.indexOf('layers.commitAll()'));
  });

  it('throttles the rebuild during a stroke and always rebuilds on strokeend', () => {
    expect(source).toContain('const REBUILD_MIN_MS = 125;');
    expect(source).toContain("brush.on('stroke', ()");
    expect(source).toContain("brush.on('strokeend', () => {");
    // the strokeend handler is the unthrottled one
    const end = source.slice(source.indexOf("brush.on('strokeend'"));
    expect(end.slice(0, 400)).toContain('rebuildNow()');
  });

  it('records one session event per dab, on the stamp and not on the stroke', () => {
    // Plan step 6, wired (docs/SESSION.md §paint). It has to hang off the
    // per-dab `onStamp`: the Brush emits `stroke` once per BATCH of dabs and
    // hands it no op, so a stroke-level hook could not say where anything
    // landed.
    expect(source).toContain('session hook');
    expect(source).toContain('const recordStamp = (');
    expect(source).toContain('handles.session?.paint(');
    expect(source).toContain('onStamp: (_ctx: unknown, op: StampOp): void => {');
    // The clear, and the replay seam the world's driver reaches for.
    expect(source).toContain("tool: 'clear'");
    expect(source).toContain('applyPaint');
  });

  it('records a water dab with the plane it filled to, and replays it', () => {
    // A pond dab's level is chosen from the bank around the stroke's first
    // dab, and by replay time that bank may have been painted over — so the
    // number rides in the event rather than being re-derived.
    expect(source).toContain('recordStamp(record, op, drain ? undefined : (strokeLevel ?? undefined))');
    // …and a replayed dab lays it, through the same `stampWater` a live one
    // uses, without recording itself a second time.
    expect(source).toContain('strokeLevel = event.level ?? null;');
    expect(source).toContain('stampWater(op, { x: event.x, y: 0, z: event.z, u, v }, drain, null);');
    expect(source).toContain('strokeLevel = held;');
  });
});
