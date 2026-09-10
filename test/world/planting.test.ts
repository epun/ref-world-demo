/**
 * The environment brush kit — painted planting (2026-09-09, user ask:
 * *"in the collection we should have brushes for trees, rocks, grass,
 * flowers, rivers, clouds, ponds, etc."*).
 *
 * Three things are worth pinning, and they are the three the demo depends on:
 *
 *   1. the sampler and its round trip — a painted map is the only copy of a
 *      live-painted world, and a half-read one samples plausible garbage;
 *   2. an UNPAINTED world is byte-identical to the shipped one, in both
 *      landscape modes — the brush kit adds, it never re-rolls;
 *   3. painting one brush moves nothing another brush planted, and clouds
 *      stay out of the ground systems entirely.
 *
 * Pure throughout: no WebGL, no DOM. The geometry block builds meshes with
 * three's BufferGeometry only, which needs no context.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPaintedMap,
  createPaintedMap,
  deserializeMap,
  PLANT_BRUSHES,
  PLANTING_RES,
  plantingSampler,
  samplePlanting,
  serializeMap,
  zeroPlanting,
  type PaintedMap,
  type PlantBrush,
} from '../../src/world/painted';
import {
  isWater,
  sampleLandscape,
  setLandscapeMode,
  setPaintedPlanting,
  landscapeMode,
} from '../../src/world/landscape';
import {
  buildMarkGeometries,
  cloudLift,
  colliderFor,
  computePlacements,
  filterExcluded,
  MARK_VARIANT_COUNTS,
  PAINT_SEED,
  CLOUD_ALTITUDE,
  CLOUD_ALTITUDE_SPREAD,
  type Placement,
} from '../../src/world/scatter';
import { buildPropGeometries, PROP_VARIANT_COUNTS } from '../../src/world/props';

/** Stamp a disc of weight into one brush's layer — the pure stand-in for a
 * dab, so this file never needs the brush engine. */
function stamp(map: PaintedMap, brush: PlantBrush, x: number, z: number, r: number, v = 1): void {
  const data = map.planting[brush];
  const res = map.plantingRes;
  for (let ty = 0; ty < res; ty++) {
    for (let tx = 0; tx < res; tx++) {
      const wx = ((tx + 0.5) / res - 0.5) * map.size;
      const wz = ((ty + 0.5) / res - 0.5) * map.size;
      if (Math.hypot(wx - x, wz - z) <= r) data[ty * res + tx] = v;
    }
  }
}

const key = (p: Placement): string =>
  `${p.kind}:${p.variant}:${p.x.toFixed(4)}:${p.z.toFixed(4)}:${p.scale.toFixed(4)}:${p.rotY.toFixed(4)}`;

/** Run `f` with a painted map installed, then put the world back unpainted. */
function painted<T>(map: PaintedMap, f: () => T): T {
  setPaintedPlanting(plantingSampler(map));
  try {
    return f();
  } finally {
    setPaintedPlanting(null);
  }
}

afterEach(() => {
  setPaintedPlanting(null);
  setLandscapeMode('plain');
});

describe('the planting layers', () => {
  it('allocates one zeroed layer per brush at the planting resolution', () => {
    const map = createPaintedMap();
    expect(Object.keys(map.planting).sort()).toEqual([...PLANT_BRUSHES].sort());
    expect(map.plantingRes).toBe(PLANTING_RES);
    for (const brush of PLANT_BRUSHES) {
      expect(map.planting[brush].length).toBe(PLANTING_RES * PLANTING_RES);
      expect(map.planting[brush].every((v) => v === 0)).toBe(true);
    }
  });

  it('adopts handed-in buffers by reference, never copying them', () => {
    const trees = new Float32Array(PLANTING_RES * PLANTING_RES);
    const map = createPaintedMap(undefined, undefined, undefined, undefined, { trees });
    expect(map.planting.trees).toBe(trees);
    // The coupling the whole design rests on: a stamp into the layer's own
    // buffer is visible to the next sample with nothing in between.
    trees[Math.floor(PLANTING_RES / 2) * PLANTING_RES + Math.floor(PLANTING_RES / 2)] = 1;
    expect(samplePlanting(map, 'trees', 0, 0)).toBeGreaterThan(0);
  });

  it('throws on a planting buffer of the wrong length', () => {
    expect(() =>
      createPaintedMap(undefined, undefined, undefined, undefined, { grass: new Float32Array(9) }),
    ).toThrow(/grass/);
  });

  it('samples 0 outside the map and fades over the last half texel', () => {
    const map = createPaintedMap();
    map.planting.grass.fill(1);
    // Dead centre: fully painted.
    expect(samplePlanting(map, 'grass', 0, 0)).toBeCloseTo(1, 6);
    // Outside: exactly nothing, on every side.
    for (const [x, z] of [
      [map.size, 0],
      [-map.size, 0],
      [0, map.size],
      [0, -map.size],
    ]) {
      expect(samplePlanting(map, 'grass', x!, z!)).toBe(0);
    }
    // The rim fades rather than stepping — a stroke that runs off the edge
    // must not draw a straight line across the field.
    const rim = map.size / 2 - map.size / PLANTING_RES / 4;
    const v = samplePlanting(map, 'grass', 0, rim);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it('reads back every brush at once through the sampler', () => {
    const map = createPaintedMap();
    stamp(map, 'trees', 20, 20, 10);
    stamp(map, 'clouds', 20, 20, 10, 0.5);
    const at = plantingSampler(map)(20, 20);
    expect(at.trees).toBeCloseTo(1, 3);
    expect(at.clouds).toBeCloseTo(0.5, 3);
    expect(at.rocks).toBe(0);
    // A fresh object each call: nobody may mutate a shared sample.
    expect(plantingSampler(map)(20, 20)).not.toBe(at);
  });

  it('round-trips through serialize / deserialize, planting and all', () => {
    const map = createPaintedMap();
    map.height[1234] = -3.25;
    stamp(map, 'flowers', -40, 15, 12);
    stamp(map, 'mask', 60, -60, 8, 0.25);
    const back = deserializeMap(JSON.parse(JSON.stringify(serializeMap(map))));
    expect(back.plantingRes).toBe(map.plantingRes);
    expect(back.height[1234]).toBe(-3.25);
    for (const brush of PLANT_BRUSHES) {
      expect(Array.from(back.planting[brush]), brush).toEqual(Array.from(map.planting[brush]));
    }
  });

  it('deserializes a map written before planting existed', () => {
    const map = createPaintedMap();
    const json = serializeMap(map);
    delete json.planting;
    delete json.plantingRes;
    const back = deserializeMap(json);
    expect(back.plantingRes).toBe(PLANTING_RES);
    for (const brush of PLANT_BRUSHES) expect(back.planting[brush].every((v) => v === 0)).toBe(true);
  });

  it('clear map clears the planting as well as the height', () => {
    const map = createPaintedMap();
    map.height[0] = 4;
    stamp(map, 'trees', 0, 0, 30);
    clearPaintedMap(map);
    expect(map.height[0]).toBe(0);
    expect(samplePlanting(map, 'trees', 0, 0)).toBe(0);
  });
});

describe('the landscape seam', () => {
  it('answers all-zero planting when nothing is installed, in both modes', () => {
    for (const mode of ['plain', 'landscape'] as const) {
      setLandscapeMode(mode);
      expect(landscapeMode()).toBe(mode);
      for (const [x, z] of [
        [0, 0],
        [40, -70],
        [-120, 30],
      ]) {
        expect(sampleLandscape(x!, z!).planting, `${mode} ${x},${z}`).toEqual(zeroPlanting());
      }
    }
  });

  it('reports painted planting in BOTH modes — a person’s hand is not part of the map', () => {
    const map = createPaintedMap();
    stamp(map, 'grass', 30, 30, 12);
    painted(map, () => {
      for (const mode of ['plain', 'landscape'] as const) {
        setLandscapeMode(mode);
        expect(sampleLandscape(30, 30).planting.grass, mode).toBeCloseTo(1, 3);
        expect(sampleLandscape(-30, -30).planting.grass, mode).toBe(0);
      }
    });
  });
});

describe('painted placement', () => {
  it('places exactly the shipped world when nothing is painted', () => {
    for (const mode of ['plain', 'landscape'] as const) {
      setLandscapeMode(mode);
      const shipped = computePlacements().map(key);
      const empty = createPaintedMap();
      const withMap = painted(empty, () => computePlacements().map(key));
      expect(withMap, mode).toEqual(shipped);
    }
  });

  it('is byte-identical for identical painted layers — same map, same world', () => {
    const a = createPaintedMap();
    const b = createPaintedMap();
    for (const map of [a, b]) {
      stamp(map, 'trees', 40, 40, 25);
      stamp(map, 'flowers', -50, 20, 18);
      stamp(map, 'clouds', 0, -60, 30);
    }
    expect(painted(a, () => computePlacements().map(key))).toEqual(
      painted(b, () => computePlacements().map(key)),
    );
  });

  it('grows what the brush names, and nothing it does not', () => {
    const map = createPaintedMap();
    stamp(map, 'trees', 60, 60, 30);
    const before = computePlacements();
    const after = painted(map, () => computePlacements());
    const count = (ps: Placement[], k: string): number => ps.filter((p) => p.kind === k).length;
    expect(count(after, 'tree')).toBeGreaterThan(count(before, 'tree'));
    // The trees brush names tree / conifer / bush / tick — and nothing else.
    expect(Object.keys(PAINT_SEED.trees).sort()).toEqual(['bush', 'conifer', 'tick', 'tree']);
    for (const kind of ['rock', 'cactus', 'waterTower', 'flower', 'cloud']) {
      expect(count(after, kind), kind).toBe(count(before, kind));
    }
  });

  it('never moves a placement another brush made — painting adds (monotonicity)', () => {
    const rocksOnly = createPaintedMap();
    stamp(rocksOnly, 'rocks', -40, 40, 26);
    const both = createPaintedMap();
    stamp(both, 'rocks', -40, 40, 26);
    stamp(both, 'trees', -40, 40, 26);

    const rocksBefore = painted(rocksOnly, () =>
      computePlacements().filter((p) => p.kind === 'rock').map(key),
    );
    const rocksAfter = new Set(
      painted(both, () => computePlacements().filter((p) => p.kind === 'rock').map(key)),
    );
    expect(rocksBefore.length).toBeGreaterThan(0);
    // Every rock the rocks brush planted is still there, digit for digit.
    for (const k of rocksBefore) expect(rocksAfter.has(k), k).toBe(true);
  });

  it('the mask brush suppresses the base term without touching a painted one', () => {
    const trees = createPaintedMap();
    stamp(trees, 'trees', 60, 60, 30);
    const cleared = createPaintedMap();
    stamp(cleared, 'mask', 0, 0, 60);

    const base = computePlacements().filter((p) => Math.hypot(p.x, p.z) < 45).length;
    const swept = painted(cleared, () =>
      computePlacements().filter((p) => Math.hypot(p.x, p.z) < 45),
    ).length;
    expect(swept).toBeLessThan(base);
  });

  it('the path brush suppresses the painted term as well as the base one', () => {
    // The one way a path is not a mask: a mask opens a glade in the world's
    // own seeding and leaves a painted grove standing in it; a path is ground
    // nothing stands on, painted or not. A trail with a tree in the middle of
    // it is not a trail.
    const grove = createPaintedMap();
    stamp(grove, 'trees', 0, 0, 40);
    const masked = createPaintedMap();
    stamp(masked, 'trees', 0, 0, 40);
    stamp(masked, 'mask', 0, 0, 40);
    const trailed = createPaintedMap();
    stamp(trailed, 'trees', 0, 0, 40);
    stamp(trailed, 'path', 0, 0, 40);

    const inside = (map: PaintedMap): number =>
      painted(map, () => computePlacements().filter((p) => Math.hypot(p.x, p.z) < 30)).length;

    const planted = inside(grove);
    expect(planted).toBeGreaterThan(0);
    // The mask leaves the painted stand alone…
    expect(inside(masked)).toBeGreaterThan(0);
    // …and the path clears the ground entirely.
    expect(inside(trailed)).toBe(0);
  });

  it('the path plants nothing of its own', () => {
    // It is a weight layer the GROUND reads (src/world/ground.ts inks the
    // trail); it names no scatter kind at all.
    expect(Object.keys(PAINT_SEED.path)).toEqual([]);
    const map = createPaintedMap();
    stamp(map, 'path', 60, 60, 25);
    // Well inside the stamp, where the weight is saturated: at the rim it
    // fades, and a fading path is meant to let the field back in.
    const near = painted(map, () =>
      computePlacements().filter((p) => Math.hypot(p.x - 60, p.z - 60) < 12),
    );
    expect(near).toEqual([]);
  });

  it('plants grass tufts and flowers only where they are painted', () => {
    const map = createPaintedMap();
    stamp(map, 'grass', 70, -70, 25);
    stamp(map, 'flowers', -70, 70, 25);
    expect(computePlacements().some((p) => p.kind === 'grass' || p.kind === 'flower')).toBe(false);
    const after = painted(map, () => computePlacements());
    const tufts = after.filter((p) => p.kind === 'grass');
    const flowers = after.filter((p) => p.kind === 'flower');
    expect(tufts.length).toBeGreaterThan(0);
    expect(flowers.length).toBeGreaterThan(0);
    // Tufts land under EITHER patch: the flowers brush plants grass through
    // its meadow too (PAINT_SEED.flowers), which is the mix, not a leak.
    for (const p of tufts) {
      const near = Math.min(Math.hypot(p.x - 70, p.z + 70), Math.hypot(p.x + 70, p.z - 70));
      expect(near).toBeLessThan(45);
    }
    for (const p of flowers) expect(Math.hypot(p.x + 70, p.z - 70)).toBeLessThan(45);
    // Both alphabets get used.
    expect(new Set(tufts.map((p) => p.variant)).size).toBeGreaterThan(1);
    for (const p of [...tufts, ...flowers]) {
      expect(p.variant).toBeLessThan(MARK_VARIANT_COUNTS[p.kind as 'grass' | 'flower']);
    }
  });
});

describe('clouds', () => {
  const cloudy = (): Placement[] => {
    const map = createPaintedMap();
    stamp(map, 'clouds', 0, 0, 80);
    return painted(map, () => computePlacements().filter((p) => p.kind === 'cloud'));
  };

  it('paints a sky', () => {
    const clouds = cloudy();
    expect(clouds.length).toBeGreaterThan(3);
    expect(new Set(clouds.map((p) => p.variant)).size).toBeGreaterThan(1);
    for (const p of clouds) expect(p.variant).toBeLessThan(PROP_VARIANT_COUNTS.cloud);
  });

  it('floats at CLOUD_ALTITUDE plus a per-instance spread', () => {
    for (const p of cloudy()) {
      const lift = cloudLift(p);
      expect(lift).toBeGreaterThanOrEqual(CLOUD_ALTITUDE);
      expect(lift).toBeLessThanOrEqual(CLOUD_ALTITUDE + CLOUD_ALTITUDE_SPREAD);
      // Pure in the placement: the same cloud lifts the same way every time.
      expect(cloudLift(p)).toBe(lift);
    }
  });

  it('is exempt from the creature exclusion circles', () => {
    const clouds = cloudy();
    const p = clouds[0]!;
    const kept = filterExcluded(clouds, [{ x: p.x, z: p.z, r: 200 }]);
    expect(kept.length).toBe(clouds.length);
  });

  it('carries no collider — nothing walks into weather', () => {
    for (const p of cloudy()) expect(colliderFor(p, 4)).toBeNull();
  });

  it('reaches the hatch clearing and the water, which nothing on the ground does', () => {
    setLandscapeMode('landscape');
    const map = createPaintedMap();
    stamp(map, 'clouds', 0, 0, 200);
    const all = painted(map, () => computePlacements());
    const clouds = all.filter((p) => p.kind === 'cloud');
    // Over the hatch clearing, where no prop may stand…
    expect(clouds.some((p) => Math.hypot(p.x, p.z) < 11)).toBe(true);
    for (const p of all) {
      if (p.kind === 'cloud') continue;
      expect(Math.hypot(p.x, p.z), p.kind).toBeGreaterThanOrEqual(6);
    }
    // …and over the lake, where nothing stands at all.
    expect(clouds.some((p) => isWater(p.x, p.z))).toBe(true);
  });
});

describe('the new motif geometry', () => {
  it('builds four grass tufts and three flowers, all in their size band', () => {
    const marks = buildMarkGeometries();
    expect(marks.grass).toHaveLength(MARK_VARIANT_COUNTS.grass);
    expect(marks.flower).toHaveLength(MARK_VARIANT_COUNTS.flower);
    for (const g of marks.grass) {
      g.computeBoundingBox();
      const b = g.boundingBox!;
      // 3-7 blades, 0.35-0.7 u tall (the design ask), fanning from one root.
      expect(b.max.y).toBeGreaterThan(0.34);
      expect(b.max.y).toBeLessThan(0.75);
      expect(b.min.y).toBeGreaterThanOrEqual(-0.02);
      expect(Math.max(b.max.x - b.min.x, b.max.z - b.min.z)).toBeLessThan(0.7);
    }
    for (const f of marks.flower) {
      f.computeBoundingBox();
      const b = f.boundingBox!;
      // 0.8-1.1 u tall — doubled from 0.3-0.5 (2026-09-10, user report: the
      // flowers were too small to read at the projection's framing), which
      // puts a bloom's head clear of the tallest grass blade below.
      expect(b.max.y).toBeGreaterThan(0.75);
      expect(b.max.y).toBeLessThan(1.15);
      expect(Math.max(b.max.x - b.min.x, b.max.z - b.min.z)).toBeLessThan(0.9);
    }
    // …and a bloom really does stand above the grass it grows through.
    const tallestBlade = Math.max(
      ...marks.grass.map((g) => {
        g.computeBoundingBox();
        return g.boundingBox!.max.y;
      }),
    );
    for (const f of marks.flower) expect(f.boundingBox!.max.y).toBeGreaterThan(tallestBlade);
    for (const variants of Object.values(marks)) for (const g of variants) g.dispose();
  });

  it('builds every cloud variant wide, low and grounded at y = 0', () => {
    const props = buildPropGeometries();
    const clouds = props.get('cloud')!;
    expect(clouds).toHaveLength(4);
    for (const v of clouds) {
      v.geometry.computeBoundingBox();
      const b = v.geometry.boundingBox!;
      expect(b.min.y).toBeCloseTo(0, 5);
      expect(b.max.y).toBeCloseTo(v.height, 4);
      // Wider than tall: a heap over a flat base, never a column.
      expect(v.radius * 2).toBeGreaterThan(v.height);
      expect(v.radius).toBeLessThan(9);
    }
    for (const variants of props.values()) for (const v of variants) v.geometry.dispose();
  });
});
