/**
 * WHAT A HUNDRED CREATURES COST, as a number with a ceiling on it.
 *
 * > User report, 2026-09-17: *"i spawned 100 people and it crashed."*
 *
 * It was memory, and it was not a leak — it was the per-creature price paid a
 * hundred times. Measured on the built valiocon world in a real chromium at
 * 390×844, the renderer process went from **353 MB to 966 MB** over a hundred
 * `spawn` calls: **6.13 MB of process per creature**, against a phone that
 * gets killed somewhere around a gigabyte. Nothing threw, nothing leaked, no
 * frame guard fired; the page just grew until the platform took it away.
 *
 * Two of those megabytes were dead weight and came off (see `mesh.ts`'s
 * narrowed index and `character.ts`'s `CharacterShape`), which is what this
 * file exists to keep off. `MAX_POPULATION` is documented as a frame-rate
 * guarantee and there is no memory guarantee anywhere — so the guarantee is
 * here, as a budget: a hundred creatures through the real manager against the
 * stub world, and a ceiling on the bytes and the object count each one is
 * allowed to hold.
 *
 * The ceilings are measured values with headroom, not aspirations. When a
 * change trips one, the answer is a number in the report, not a raised
 * ceiling: every megabyte here is multiplied by the population cap, and the
 * cap is 256.
 */

import { Scene, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCharacter } from '../../src/character/character';
import { createCreatureManager } from '../../src/creatures/manager';
import type { StrokeList } from '../../src/shape/types';
import type { WorldHandles } from '../../src/world/scene';
import { FLAT_SURFACE } from '../../src/world/surface';
import { snowman } from '../fixtures/strokes';

/** How many the user spawned. */
const POPULATION = 100;

/**
 * Bytes of typed array one creature may hold, reachable from the scene.
 *
 * Measured after the fix: **2,787,356** — the body's position/normal/index
 * (1.40 MB) and the topper's (1.24 MB), both at `DEFAULT_GRID_STEP` 6, plus
 * the stalk. Before it, 3,715,163. The ceiling sits between the two on
 * purpose: putting back either the 32-bit index (+0.88 MB) or the analysis
 * grids the Character used to carry (+1.31 MB) fails this test on its own.
 */
const BYTES_PER_CREATURE = 3_000_000;

/**
 * Objects one creature may hold, reachable from the scene. Measured: 231.
 *
 * This is the "bounded, not growing" half — a per-frame allocation that
 * accumulated on a slot (a pose, a spring, a neighbour list kept instead of
 * reused) shows up here as a count that climbs with the frames, whatever it
 * costs in bytes.
 */
const OBJECTS_PER_CREATURE = 300;

beforeAll(() => {
  // createEgg paints its shell through a 2d canvas; off-DOM the context is
  // null and every paint is a guarded no-op — only createElement must exist.
  const g = globalThis as { document?: unknown };
  if (typeof g.document === 'undefined') {
    g.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    };
  }
});

/** Minimal world: real scene graph, no renderer, no DOM. Same shape as the
 * one in ./manager.test.ts, without the physics half this file never asks
 * for. */
function stubWorld(): WorldHandles {
  return {
    scene: new Scene(),
    cameraRig: { frameAt: (_p: Vector3) => {} },
    shadows: {
      addShadow: () => ({ setPosition: () => {}, setRadius: () => {} }),
      removeShadow: () => {},
    },
    scatter: {
      colliders: () => [],
      collidersVersion: () => 1,
      bump: () => {},
      positions: () => [],
      nudge: () => {},
    },
  } as unknown as WorldHandles;
}

/**
 * A hundred DISTINCT drawings, seeded.
 *
 * Distinct matters: a hundred copies of one stroke list would still build a
 * hundred meshes, but every silhouette would refine to the same triangle
 * count and the measurement would be one drawing's cost dressed up as an
 * average. This is a body, two to four legs and a head, all jittered.
 */
function drawings(n: number): StrokeList[] {
  const out: StrokeList[] = [];
  let state = 12345;
  const rnd = (): number => ((state = (state * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const strokes: StrokeList = [{ pts: [[0.5, 0.55 + 0.06 * rnd(), 1]], w: 0.3 + 0.2 * rnd() }];
    const legs = 2 + Math.floor(rnd() * 3);
    for (let l = 0; l < legs; l++) {
      const x = 0.3 + (0.4 * l) / Math.max(1, legs - 1);
      strokes.push({
        pts: [
          [x, 0.72, 1],
          [x + 0.04 * (rnd() - 0.5), 0.95, 1],
        ],
        w: 0.04 + 0.03 * rnd(),
      });
    }
    strokes.push({ pts: [[0.42 + 0.16 * rnd(), 0.3 + 0.08 * rnd(), 1]], w: 0.12 + 0.1 * rnd() });
    out.push(strokes);
  }
  return out;
}

/**
 * Every typed array reachable from `root`, and how many objects it took to
 * reach them.
 *
 * A buffer is counted once however many views onto it exist (an interleaved
 * attribute would otherwise be counted per attribute), and `parent` is not
 * followed — an Object3D's back-pointer would walk the whole scene from every
 * child and make one creature's total the world's.
 */
function reachable(root: unknown): { bytes: number; objects: number } {
  const seen = new Set<unknown>();
  let bytes = 0;
  let objects = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 16 || value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    objects++;
    if (ArrayBuffer.isView(value)) {
      const buffer = (value as { buffer: ArrayBufferLike }).buffer;
      if (!seen.has(buffer)) {
        seen.add(buffer);
        bytes += buffer.byteLength;
      }
      return;
    }
    if (value instanceof ArrayBuffer) {
      bytes += value.byteLength;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value instanceof Map) {
      for (const item of value.values()) walk(item, depth + 1);
      return;
    }
    if (value instanceof Set) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === 'parent') continue;
      try {
        walk(record[key], depth + 1);
      } catch {
        /* a getter that throws off-DOM is not a resource */
      }
    }
  };
  walk(root, 0);
  return { bytes, objects };
}

describe('a hundred creatures — the resource budget', () => {
  it('spawns, lives and stays inside its per-creature budget', () => {
    const world = stubWorld();
    const scene = (world as unknown as { scene: Scene }).scene;
    const manager = createCreatureManager(world, { autoHatch: true, surface: FLAT_SURFACE });
    const strokes = drawings(POPULATION);

    // Grown, so a hundred characters exist at once — the state the report
    // describes. `hatchMs` is still handed over: `grown` skips the shell, it
    // does not skip the argument.
    for (let i = 0; i < POPULATION; i++) {
      expect(manager.spawn(`budget-${i}`, strokes[i]!, { hatchMs: 0, grown: true })).toBe(true);
    }
    expect(manager.count()).toBe(POPULATION);
    expect(manager.liveIds().length).toBe(POPULATION);
    // The cap is 256 and nothing here should have tripped it.
    expect(scene.children.length).toBe(POPULATION);

    /*
     * A second of a full field, and NO THROW.
     *
     * The frame guard in src/world/scene.ts swallows a throw and logs it
     * once, so a frame that threw at a hundred creatures — a pair pass, a
     * spatial hash, a pose packing — would leave the world half-updated and
     * say so exactly once in a console nobody is reading. Here it is an
     * assertion instead.
     */
    let now = performance.now();
    for (let frame = 0; frame < 30; frame++) {
      now += 33;
      expect(() => manager.update(33, now)).not.toThrow();
    }

    const after = reachable(scene);
    const bytes = Math.round(after.bytes / POPULATION);
    const objects = Math.round(after.objects / POPULATION);
    expect(
      bytes,
      `${bytes} bytes of typed array per creature (${(after.bytes / 1e6).toFixed(0)} MB at ${POPULATION})`,
    ).toBeLessThanOrEqual(BYTES_PER_CREATURE);
    expect(objects, `${objects} objects per creature`).toBeLessThanOrEqual(OBJECTS_PER_CREATURE);

    /*
     * BOUNDED, not merely small: a second more of frames must not add to
     * either count. Anything a frame allocates onto a slot and keeps shows
     * up here, whatever it weighs.
     */
    for (let frame = 0; frame < 30; frame++) {
      now += 33;
      manager.update(33, now);
    }
    const settled = reachable(scene);
    expect(settled.bytes).toBe(after.bytes);
    expect(settled.objects).toBe(after.objects);

    manager.clearAll();
  }, 600_000);

  it('a living creature holds no 512² grid — the analysis comes off it', () => {
    const character = createCharacter(snowman, 1, { identity: 'grids' })!;
    expect(character).not.toBeNull();
    // What it still answers for: the archetype the gait was built from, the
    // contour, the ink bounds, the head lobe.
    expect(['blob', 'biped', 'quadruped', 'bird']).toContain(character.analysis.archetype);
    expect(character.analysis.contour.length).toBeGreaterThan(0);
    // And what it must not still be holding. The type forbids both; this is
    // the byte-level pin behind the type, because the object is built by a
    // hand-written copy and a spread put back would be silent.
    const held = character.analysis as unknown as Record<string, unknown>;
    expect(held['mask']).toBeUndefined();
    expect(held['distance']).toBeUndefined();
    // A 512² mask plus a 512² float field is 1.31 MB; the light half is
    // kilobytes. Anything that reintroduces a grid blows straight past this.
    expect(reachable(character.analysis).bytes).toBeLessThan(200_000);
    character.dispose();
  });

  it('a creature mesh is indexed in 16 bits — the widest buffer it carries', () => {
    const character = createCharacter(snowman, 1, { identity: 'index' })!;
    const meshes: { verts: number; index: ArrayBufferView | null }[] = [];
    character.group.traverse((object) => {
      const mesh = object as unknown as {
        isMesh?: boolean;
        geometry?: {
          index?: { array: ArrayBufferView; count: number } | null;
          attributes?: { position?: { count: number } };
        };
      };
      if (mesh.isMesh !== true || !mesh.geometry) return;
      meshes.push({
        verts: mesh.geometry.attributes?.position?.count ?? 0,
        index: mesh.geometry.index?.array ?? null,
      });
    });
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      if (!mesh.index) continue;
      // The pure pipeline still emits Uint32Array — its MAX_VERTS is 262,144
      // and that genuinely needs 32 bits. The bridge narrows what fits, and
      // a real creature always fits.
      if (mesh.verts <= 0x10000) {
        expect(mesh.index instanceof Uint16Array, `${mesh.verts} verts`).toBe(true);
      }
    }
    character.dispose();
  });
});
