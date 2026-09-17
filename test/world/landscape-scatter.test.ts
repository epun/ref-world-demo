/**
 * Landscape-aware scatter — the map (src/world/landscape.ts) deciding WHAT
 * grows WHERE. Pure placement data; no WebGL except where a test has to
 * look at the built meshes.
 *
 * The invariant these all circle: the plain is still the world that shipped
 * before the map existed, and everything else is a departure from it that
 * the map asked for.
 *
 * THE MODE. That invariant now has a switch on it (src/world/landscape.ts
 * `LandscapeMode`): the world SHIPS plain and the map is revealed live. So
 * this file runs in the landscape mode — that is what it measures — and the
 * last block below flips back to plain and pins the other half: with the map
 * off, the placement really is the pre-map world, whole.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstancedMesh, type Material, type MeshStandardMaterial } from 'three';
import { WORLD } from '../../src/taste/tokens';
import {
  isAuthoredWater,
  isWater,
  mapScale,
  sampleLandscape,
  setIslandMode,
  setLandscapeMode,
  WATER_BODIES,
  wobbledRadius,
  WOBBLE_MAX,
} from '../../src/world/landscape';
import { MOUNTAIN_FOOTPRINT, PROP_VARIANT_COUNTS } from '../../src/world/props';
import {
  computePlacements,
  createScatter,
  filterExcluded,
  MOUNTAIN_CLEAR_FIT,
  MOUNTAIN_MAX,
  SCATTER_STEP,
  SHADOW_FIT,
  SHADOW_MAX_RADIUS,
  type Placement,
} from '../../src/world/scatter';

/* The island is the katamari world's map and ships OFF (src/world/game.ts);
 * every fixture below was taken against the mapped world WITH it, so this
 * file switches it on and puts it back, exactly as it does the mode. */
beforeAll(() => {
  setLandscapeMode('landscape');
  setIslandMode(true);
});
afterAll(() => {
  setLandscapeMode('plain');
  setIslandMode(false);
});

/** Run `f` with the map switched off, then put the file's mode back. */
function inPlain<T>(f: () => T): T {
  setLandscapeMode('plain');
  try {
    return f();
  } finally {
    setLandscapeMode('landscape');
  }
}

const shipped = (): Placement[] => computePlacements();

const kindsOf = (ps: Placement[], kind: Placement['kind']): Placement[] =>
  ps.filter((p) => p.kind === kind);

/** Distance from (x, z) to the nearest water, probed radially. Infinity when
 * there is none inside `max`. */
function distanceToWater(x: number, z: number, max = 4): number {
  for (let r = 0.1; r <= max; r += 0.1) {
    for (let a = 0; a < 32; a++) {
      const th = (a / 32) * Math.PI * 2;
      if (isWater(x + Math.cos(th) * r, z + Math.sin(th) * r)) return r;
    }
  }
  return Infinity;
}

/** Ground area, in square world units, where `pick` holds — a coarse grid
 * integral, the same grid for every region so the ratios are comparable. */
function areaWhere(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  pick: (x: number, z: number) => boolean,
  step = 0.5,
): number {
  let area = 0;
  for (let x = x0; x <= x1; x += step) {
    for (let z = z0; z <= z1; z += step) if (pick(x, z)) area += step * step;
  }
  return area;
}

describe('nothing stands in water', () => {
  it('no placement of any kind is wet', () => {
    for (const p of shipped()) {
      expect(isWater(p.x, p.z), `${p.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`).toBe(false);
    }
  });

  it('holds at cranked density too — the cut is on the placement, not the roll', () => {
    for (const density of [0.5, 2]) {
      for (const p of computePlacements({ density })) {
        expect(isWater(p.x, p.z), `${p.kind} at density ${density}`).toBe(false);
      }
    }
  });
});

describe('shoreline reeds', () => {
  it('are plentiful, dry, and hug the water they line', () => {
    const reeds = kindsOf(shipped(), 'reed');
    expect(reeds.length).toBeGreaterThan(40);
    for (const r of reeds) {
      expect(isWater(r.x, r.z), `reed at ${r.x.toFixed(1)},${r.z.toFixed(1)}`).toBe(false);
      expect(
        distanceToWater(r.x, r.z),
        `reed at ${r.x.toFixed(1)},${r.z.toFixed(1)}`,
      ).toBeLessThan(1.8);
    }
  });

  it('reach every water body, not just the lake', () => {
    const reeds = kindsOf(shipped(), 'reed');
    // Read off WATER_BODIES rather than a copy of their coordinates: the
    // layout moved once (2026-09-03, the features spread out) and a hard-
    // coded list is a second place to have to move it. The radius follows
    // each body's own reach, since the lake's outer shore is 42 units from
    // its center and a pond's is six.
    for (const body of WATER_BODIES) {
      const reach = body.r * WOBBLE_MAX + 4;
      const near = reeds.filter((r) => Math.hypot(r.x - body.x, r.z - body.z) < reach);
      expect(near.length, `reeds near the ${body.kind} at ${body.x},${body.z}`).toBeGreaterThan(2);
    }
  });

  it('scale with the density slider, and zero means none', () => {
    const count = (mult: number): number =>
      kindsOf(computePlacements({ kindDensity: { reed: mult } }), 'reed').length;
    expect(count(0)).toBe(0);
    expect(count(0.5)).toBeLessThan(count(1));
    expect(count(1)).toBeLessThanOrEqual(count(2));
    // Global density scales them too.
    expect(kindsOf(computePlacements({ density: 0 }), 'reed')).toHaveLength(0);
  });

  it('carry no collider and no shadow — they are ink marks, like the grass', () => {
    const scatter = createScatter();
    try {
      // positions() is the prop surface (colliders, minimap, affordances):
      // reeds are not in it.
      expect(scatter.positions().some((p) => (p.kind as string) === 'reed')).toBe(false);
      // …but they are drawn, in their own outliner row.
      const reeds = scatter.group.getObjectByName('reeds');
      expect(reeds).toBeDefined();
      expect(reeds!.children.length).toBeGreaterThan(0);
    } finally {
      scatter.dispose();
    }
  });
});

describe('the forest is a forest', () => {
  it('grows trees an order of magnitude denser than the open plain', () => {
    const placements = shipped();
    const wooded = placements.filter((p) => p.kind === 'tree' || p.kind === 'conifer');

    // The boxes and the annulus ride the map's own scale (2026-09-16,
    // `MAP_SCALE` in src/world/landscape.ts): the western stand moved out with
    // the coast, so a window in world units would measure the open plain and
    // call it a forest.
    const k = mapScale();
    const inForest = wooded.filter((p) => sampleLandscape(p.x, p.z).forest >= 0.8);
    const forestArea = areaWhere(-60 * k, 20 * k, -20 * k, 60 * k, (x, z) =>
      sampleLandscape(x, z).forest >= 0.8,
    );

    // The plain sample: an annulus around the origin, outside the hatch
    // clearing and clear of every feature.
    const openPlain = (x: number, z: number): boolean => {
      const d = Math.hypot(x, z);
      if (d < 14 * k || d > 30 * k) return false;
      const l = sampleLandscape(x, z);
      return l.forest === 0 && l.mountain === 0 && !l.island && !l.water;
    };
    const inPlain = wooded.filter((p) => openPlain(p.x, p.z));
    const plainArea = areaWhere(-30 * k, 30 * k, -30 * k, 30 * k, openPlain);

    expect(forestArea).toBeGreaterThan(200);
    expect(plainArea).toBeGreaterThan(200);
    expect(inForest.length).toBeGreaterThan(20);

    const forestDensity = inForest.length / forestArea;
    const plainDensity = inPlain.length / plainArea;
    expect(forestDensity / plainDensity).toBeGreaterThan(8);
  });
});

describe('the mountain range', () => {
  const mountains = (ps = shipped()): Placement[] => kindsOf(ps, 'mountain');

  it('places a range, capped, only where the map says mountain', () => {
    const mts = mountains();
    expect(mts.length).toBeGreaterThanOrEqual(6);
    expect(mts.length).toBeLessThanOrEqual(MOUNTAIN_MAX);
    for (const m of mts) {
      expect(
        sampleLandscape(m.x, m.z).mountain,
        `mountain at ${m.x.toFixed(1)},${m.z.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(0.35);
      expect(m.variant).toBeLessThan(PROP_VARIANT_COUNTS.mountain);
    }
    // Every authored variant gets used somewhere in the range.
    expect(new Set(mts.map((m) => m.variant)).size).toBe(PROP_VARIANT_COUNTS.mountain);
  });

  it('sweeps its own ground clear — nothing else stands on a mountain', () => {
    const all = shipped();
    const mts = mountains(all);
    for (const p of all) {
      if (p.kind === 'mountain') continue;
      for (const m of mts) {
        const r = MOUNTAIN_FOOTPRINT[m.variant]! * m.scale * MOUNTAIN_CLEAR_FIT;
        expect(
          Math.hypot(p.x - m.x, p.z - m.z),
          `${p.kind} inside the mountain at ${m.x.toFixed(1)},${m.z.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(r);
      }
    }
  });

  it('survives creature exclusions — landscape does not blink out', () => {
    const all = shipped();
    const mts = mountains(all);
    expect(mts.length).toBeGreaterThan(0);
    // An exclusion circle centered on every mountain, generous enough to
    // swallow it whole.
    const exclusions = mts.map((m) => ({ x: m.x, z: m.z, r: 30 }));
    const kept = filterExcluded(all, exclusions);
    expect(kindsOf(kept, 'mountain')).toEqual(mts);
    // …while everything else inside those circles is gone, as before.
    for (const p of kept) {
      if (p.kind === 'mountain') continue;
      for (const e of exclusions) {
        expect(Math.hypot(p.x - e.x, p.z - e.z)).toBeGreaterThanOrEqual(e.r);
      }
    }
  });

  it('is rigid, paper-light, and stamps no shadow', () => {
    const scatter = createScatter();
    try {
      const meshes: InstancedMesh[] = [];
      scatter.group.traverse((o) => {
        if (o instanceof InstancedMesh && o.name.startsWith('mountain-')) meshes.push(o);
      });
      expect(meshes.length).toBeGreaterThan(0);
      const stump = scatter.group.getObjectByName('stumps')!.children[0] as InstancedMesh;
      for (const mesh of meshes) {
        // The LIGHT paper albedo the ink pass draws over — shared with the
        // other rigid built kinds, never the mid-tone stone material.
        expect((mesh.material as MeshStandardMaterial).color.getHexString()).toBe(
          WORLD.light.slice(1),
        );
        expect(mesh.material as Material).toBe(stump.material as Material);
        // Rigid: no wind height attribute, so nothing to bend.
        expect(mesh.geometry.getAttribute('aWindHeight'), mesh.name).toBeUndefined();
      }
      // No stamp: a mountain's footprint is past SHADOW_MAX_RADIUS at every
      // instance scale the placement can roll (0.7–1.3), so the existing
      // shadow filter drops it. A hard flat ellipse under a landmass would
      // read as a hole in the ground.
      for (const p of scatter.positions()) {
        if (p.kind !== 'mountain') continue;
        expect(p.r * SHADOW_FIT).toBeGreaterThan(SHADOW_MAX_RADIUS);
      }
      for (let v = 0; v < MOUNTAIN_FOOTPRINT.length; v++) {
        const smallest = MOUNTAIN_FOOTPRINT[v]! * 0.7 * SHADOW_FIT;
        expect(smallest, `mountain variant ${v} at the smallest scale`).toBeGreaterThan(
          SHADOW_MAX_RADIUS * 0.95,
        );
      }
    } finally {
      scatter.dispose();
    }
  });

  it('blocks like a mountain: one hard collider at its base extent', () => {
    const scatter = createScatter();
    try {
      const props = scatter.positions();
      const colliders = scatter.colliders();
      props.forEach((p, i) => {
        if (p.kind !== 'mountain') return;
        expect(colliders[i]!.hard).toBe(true);
        // Grounded kinds block at the built footprint, not a trunk circle.
        expect(colliders[i]!.r).toBeCloseTo(p.r, 9);
        expect(colliders[i]!.r).toBeGreaterThan(4);
      });
      expect(props.some((p) => p.kind === 'mountain')).toBe(true);
    } finally {
      scatter.dispose();
    }
  });
});

describe('the island', () => {
  const onIsland = (p: Placement): boolean => sampleLandscape(p.x, p.z).island;

  it('plants nothing inside the lake — the island map has no islet', () => {
    // 2026-09-17, user ask — src/world/landscape.ts `LAKE_ISLET_ON_ISLAND`.
    // There is no `island` ground anywhere on this map, so the island's own
    // flora table (scatter's ISLAND_SEED, ISLAND_CLUSTER_SPREAD) is simply
    // never reached and the lake is water edge to edge.
    expect(shipped().filter(onIsland)).toHaveLength(0);
    const lake = WATER_BODIES[0]!;
    for (const p of shipped()) {
      const d = Math.hypot(p.x - lake.x, p.z - lake.z);
      expect(
        d,
        `${p.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)} is inside the lake`,
      ).toBeGreaterThan(wobbledRadius(lake, Math.atan2(p.z - lake.z, p.x - lake.x)));
    }
  });

  it('grows its own flora and nothing built on the AUTHORED map', () => {
    // The authored lake — the public world's and meridian's — still has its
    // islet, and it is the island's own table that dresses it. Flora from
    // that table, not a palm count: which of the islet's cells rolls a palm
    // rather than a tree is not a guarantee this module makes. It is a
    // 14-unit hill off the middle of a 42-unit lake (2026-09-03) — no
    // causeway, so nothing walks there and nothing built stands there either.
    setIslandMode(false);
    try {
      const island = shipped().filter(onIsland);
      const flora = island.filter((p) =>
        (['palm', 'tree', 'rock', 'bush'] as const).some((k) => k === p.kind),
      );
      expect(flora.length).toBeGreaterThanOrEqual(2);
      for (const kind of ['building', 'waterTower', 'cactus', 'picnicTable'] as const) {
        expect(island.filter((p) => p.kind === kind), `${kind} on the island`).toHaveLength(0);
      }
    } finally {
      setIslandMode(true);
    }
  });
});

describe('the plain is the world that shipped', () => {
  /** Deep plain: no feature weight at all, and far enough from every shore
   * that the cell which seeded it cannot have been inside the shore
   * keep-out either. Everything in here rolled exactly the pre-map
   * expression, so it must be byte-identical to the pre-map output. */
  function deepPlain(p: Placement): boolean {
    const l = sampleLandscape(p.x, p.z);
    if (l.forest !== 0 || l.mountain !== 0 || l.island || l.water) return false;
    for (let r = 1; r <= 13; r += 0.5) {
      for (let a = 0; a < 24; a++) {
        const th = (a / 24) * Math.PI * 2;
        if (isWater(p.x + Math.cos(th) * r, p.z + Math.sin(th) * r)) return false;
      }
    }
    return true;
  }

  const key = (p: Placement): string =>
    `${p.kind}:${p.variant}:${p.x.toFixed(4)}:${p.z.toFixed(4)}:${p.scale.toFixed(4)}:${p.rotY.toFixed(4)}`;

  /** Distance from a placement to the nearest ground the MAP claims — forest
   * weight, mountain weight, or beach — or Infinity past two scatter steps.
   * This is what separates "a cluster spilled over a region's edge" from "the
   * map leaked into open plain". */
  function nearestClaimed(p: Placement): number {
    for (let r = 0.5; r <= SCATTER_STEP * 2; r += 0.5) {
      for (let a = 0; a < 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        const l = sampleLandscape(p.x + Math.cos(th) * r, p.z + Math.sin(th) * r);
        if (l.forest > 0 || l.mountain > 0 || l.beach >= 0.5) return r;
      }
    }
    return Infinity;
  }

  /** fnv-1a, 32 bit — a stable digest, not a hash with any other job. */
  function digest(parts: string[]): string {
    let h = 0x811c9dc5;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // Fixture taken from `computePlacements()` on the PRE-map code (the commit
  // before landscape.ts existed), filtered by deepPlain above. If this moves,
  // the map has leaked into ground it was never supposed to touch.
  //
  // Re-taken 2026-09-03 (was 831 / a9eac96d): the environments were spread
  // across a bigger field (SCATTER_EXTENT 120 → 160), so the SET of
  // placements deepPlain selects moved with them — ground that used to be
  // deep plain is now inside the lake's reach, ground that used to be forest
  // is open again, and there is half as much again of it. The values
  // themselves are still the pre-map ones; the readable half of this fixture
  // (the hatch clearing, spelled out below) sits far from every feature in
  // every layout and has not moved a digit, which is what says the
  // expression is intact.
  //
  // Re-taken 2026-09-09 (was 1127 / ffb4d6bf and 1123 / 0aa1f225): BUILDING_MAX
  // went 10 → 12 with the environment brush kit, so the region's own rolls now
  // seat two more cottages before the cap stops them. Nothing else moved —
  // every painted kind seeds at 0 unpainted, and the per-kind counts are
  // otherwise digit-for-digit what they were.
  //
  // Re-taken 2026-09-15 (was 1129 / 7d360949): THE MAP BECAME AN ISLAND. This
  // fixture is the set of placements the predicate above calls deep plain, and
  // that SET has shrunk by more than half - not because the expression moved
  // but because the ground did. Everything outside the authored coast is sea
  // now, which plants nothing at all; everything within 13 units of it is
  // excluded by the predicate's own shore clearance; and the band inside that
  // is `region: 'beach'`, which rolls its own table. The readable half of the
  // fixture below - the hatch clearing, spelled out - has not moved a digit,
  // and that is what still says the expression is intact: the island's coast
  // is 131 units from the origin at its nearest.
  //
  // Re-taken 2026-09-16 (was 511 / 948fffcd): THE ISLAND DOUBLED. The scattered
  // region's half-extent rides the map (`MAP_SCALE`, src/world/landscape.ts;
  // `scatterExtent` in src/world/scatter.ts), so the field is four times the
  // area at the same 6-unit grid step and the deep plain inside it grows with
  // it — 511 → 3103, a factor of 6.07 rather than 4 because the coast and its
  // shore clearance eat a smaller share of a bigger island.
  //
  // Re-taken 2026-09-17 (was 3103 / 4881ed0e): THE ISLAND CAME BACK DOWN, to
  // `MAP_SCALE` 1.1 by way of 1.3 (two user asks in a day, both "too big").
  // The same arithmetic runs backwards: the scattered square is 176 units of
  // half-extent rather than 320 at the same 6-unit step, so there are 3.3
  // times fewer cells, and the coast and its 13-unit shore clearance are back
  // to eating a large share of a small island — 3103 → 674, below the 1.21×
  // the area alone would suggest against the authored 511 for exactly that
  // reason.
  //
  // Re-taken 2026-09-17 again (was 674 / 6ca0c6ee): AND BACK UP 20%, to
  // `MAP_SCALE` 1.32 ("map is now too small"). 211 units of half-extent
  // against 176 at the same 6-unit step is 1.44 times the cells, and the deep
  // plain inside them grows FASTER than that — 674 → 1143, 1.70× — because the
  // coast and its 13-unit shore clearance are a fixed width eating a smaller
  // share of a bigger island, the same asymmetry that made the way down steep.
  //
  // The expression is untouched at every one of those re-takes, and the way
  // this file KNOWS that is the readable half below: the four ticks in the
  // hatch clearing are a fixed place on the map and have not moved a digit
  // through any of 1 → 2 → 1.3 → 1.1 → 1.32.
  const PLAIN_COUNT = 1143;
  const PLAIN_DIGEST = '1363ef73';

  it('places exactly what it placed before the map existed', () => {
    const plain = shipped().filter(deepPlain).map(key);
    expect(plain).toHaveLength(PLAIN_COUNT);
    expect(digest(plain)).toBe(PLAIN_DIGEST);
  });

  it('is untouched around the hatch clearing, placement for placement', () => {
    // The readable half of the same fixture: the disc the creatures spawn
    // into, spelled out rather than digested.
    // 14 units, NOT scaled: the hatch clearing is a fixed place on the map
    // (`TERRAIN.clearRadius`, and scatter's own `ORIGIN_CLEAR_PROPS`), so this
    // half of the fixture is the same four ticks at any map scale — which is
    // exactly what makes it the readable check that the expression is intact.
    const disc = shipped()
      .filter((p) => Math.hypot(p.x, p.z) <= 14)
      .map(key);
    expect(disc).toEqual([
      'tick:0:1.3146:7.1223:0.8188:3.3447',
      'tick:0:-4.8633:9.7157:1.2596:2.7263',
      'tick:0:-8.4336:9.1790:0.9504:5.2106',
      'tick:0:10.3971:2.5703:1.0100:1.5532',
    ]);
  });

  // ── …and with the map switched OFF, that is the WHOLE world ────────────
  // The block above measures the deep plain inside the MAPPED world: the
  // ground the map does not reach. In the plain mode there is no map to reach
  // anywhere, so the same pre-map expression governs every cell — which is
  // the world the room now opens on (2026-09-09, user ask).

  /** The same deep-plain digest, taken in the plain mode. Eight short of the
   * mapped fixture, and the assertions below say exactly why: a cluster
   * seeded inside the forest — or, since the map became an island, on the
   * beach — can throw a neighbour a step or two clear of it, onto ground the
   * predicate calls deep plain. Those spill-overs are the map's, so the plain
   * world does not have them.
   *
   * Re-taken 2026-09-17 with the fixture above (`MAP_SCALE` 2 → 1.1, then
   * 1.1 → 1.32). Ten short of the mapped fixture at this scale. */
  const PLAIN_MODE_COUNT = 1133;
  const PLAIN_MODE_DIGEST = '015eeaf7';

  /** Deep-plain placements the PLAIN world has and the mapped one does not —
   * located rather than counted below. Two on the doubled island (2026-09-16),
   * one before it, none at 1.1 and ONE again at 1.32 (2026-09-17, a tick at
   * 58.1, -197.1): the traffic runs both ways only where the beach has claimed
   * the seed cell of a cluster that threw a neighbour clear, and how many of
   * those there are is a property of where the coast falls on the scatter grid
   * at this scale. The assertion below compares the two sets in full and
   * locates every one of them, so the count is a measurement and never a
   * tolerance. */
  const PLAIN_ONLY = 1;

  it('places no mountain and no reed anywhere in the plain mode', () => {
    const plain = inPlain(() => computePlacements());
    expect(plain.length).toBeGreaterThan(0);
    expect(kindsOf(plain, 'mountain')).toHaveLength(0);
    expect(kindsOf(plain, 'reed')).toHaveLength(0);
    // Both really do exist in the mapped world — the assertions above are not
    // measuring an empty list.
    expect(kindsOf(shipped(), 'mountain').length).toBeGreaterThan(0);
    expect(kindsOf(shipped(), 'reed').length).toBeGreaterThan(0);
  });

  // 30s: this rolls the whole scatter twice to compare the two modes, and the
  // deep-plain predicate probes 24 bearings at 25 radii per placement.
  it('rolls the pre-map expression over the ENTIRE field in the plain mode', () => {
    const plain = inPlain(() => computePlacements());
    // The fixture selects deep-plain GROUND, so the predicate is evaluated
    // against the map (this file's mode) even though the placements were
    // rolled without it.
    const deep = plain.filter(deepPlain).map(key);
    expect(deep).toHaveLength(PLAIN_MODE_COUNT);
    expect(digest(deep)).toBe(PLAIN_MODE_DIGEST);

    // Nothing MOVED: every deep-plain placement of the plain world is in the
    // mapped one too, digit for digit — with one exception since the map
    // became an island, and the exception is located rather than counted.
    // (The map used only to ADD to this ground. An island takes some away, so
    // a cluster whose seed cell the beach has claimed loses the neighbour it
    // threw clear of it.)
    const mapped = new Set(shipped().filter(deepPlain).map(key));
    const gone = deep.filter((k) => !mapped.has(k));
    expect(gone).toHaveLength(PLAIN_ONLY);
    for (const p of plain.filter(deepPlain).filter((q) => gone.includes(key(q)))) {
      expect(
        nearestClaimed(p),
        `${p.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`,
      ).toBeLessThanOrEqual(SCATTER_STEP * 2);
    }
  }, 30_000);

  // 30s: same reason as the test above — this rolls the scatter in both
  // modes.
  it('differs from the mapped fixture only where a region spills over its edge', () => {
    const plain = new Set(inPlain(() => computePlacements()).filter(deepPlain).map(key));
    const extra = shipped().filter(deepPlain).filter((p) => !plain.has(key(p)));
    // The difference either way: the mapped world's extra deep-plain
    // placements are the count gap plus the `PLAIN_ONLY` ones the plain world
    // has and it does not (which the test above locates rather than counts).
    expect(extra).toHaveLength(PLAIN_COUNT - PLAIN_MODE_COUNT + PLAIN_ONLY);
    // Buildings and water towers are the CAPPED kinds in this set
    // (BUILDING_MAX, WATER_TOWER_MAX), so one can differ between the modes for
    // a reason that has nothing to do with where it stands: the mapped world
    // drops every one that rolled inside the forest or on the beach (neither
    // table names a built kind), which frees cap slots for cells further down
    // the iteration order. That is the cap working, not the map leaking — so
    // they are counted rather than located, and the spill rule below is
    // asserted over everything else.
    //
    // Seven on the doubled island against four before it (2026-09-16,
    // `MAP_SCALE`): there are four times the cells competing for the same
    // BUILDING_MAX / WATER_TOWER_MAX slots, so the cap bites earlier and the
    // two modes disagree about more of the boundary. Five at 1.1 and five
    // again at 1.32 (2026-09-17), between the two, for the same reason read
    // backwards. Still a handful, and still the cap rather than the map — the
    // bound is left at 8 because it is the measured worst of the scales this
    // has run at, not a fit to the current one.
    const capped = extra.filter((p) => p.kind === 'building' || p.kind === 'waterTower');
    expect(capped.length, 'cap-boundary structures').toBeLessThanOrEqual(8);
    for (const p of extra.filter((q) => q.kind !== 'building' && q.kind !== 'waterTower')) {
      // Every one of them stands within a couple of scatter steps of ground
      // the map claims — forest weight, mountain weight, or beach — which is
      // to say a neighbour thrown clear of a cluster seeded on ground the
      // plain world has no seed for. Two steps, not one: a cluster throws its
      // neighbours 0.6–1.6 steps out, and the beach's own clusters sit
      // further from the plain than the forest's do.
      expect(
        nearestClaimed(p),
        `${p.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`,
      ).toBeLessThanOrEqual(SCATTER_STEP * 2);
    }
  }, 30_000);

  it('is untouched around the hatch clearing in the plain mode too', () => {
    // The readable half of the fixture, in the other mode: the disc the
    // creatures spawn into is far from every feature in either world, so it
    // must not move a digit when the map goes away.
    const disc = inPlain(() =>
      computePlacements()
        .filter((p) => Math.hypot(p.x, p.z) <= 14)
        .map(key),
    );
    expect(disc).toEqual([
      'tick:0:1.3146:7.1223:0.8188:3.3447',
      'tick:0:-4.8633:9.7157:1.2596:2.7263',
      'tick:0:-8.4336:9.1790:0.9504:5.2106',
      'tick:0:10.3971:2.5703:1.0100:1.5532',
    ]);
  });

  it('plants the ground the map used to claim, and every cell reads as plain', () => {
    const plain = inPlain(() => computePlacements());
    // The lake's own footprint: ground nothing may stand on in the mapped
    // world, open field in this one.
    expect(plain.filter((p) => isAuthoredWater(p.x, p.z)).length).toBeGreaterThan(10);
    // …and the map's own weights are gone, so every placement rolled the
    // open-plain expression.
    inPlain(() => {
      for (const p of plain) {
        const at = `${p.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`;
        expect(isWater(p.x, p.z), at).toBe(false);
        const l = sampleLandscape(p.x, p.z);
        expect(l.region, at).toBe('plain');
        expect(l.forest + l.mountain, at).toBe(0);
      }
    });
    // MORE props overall than the mapped world, and that flipped when the map
    // became an island (2026-09-15). It used to be fewer, which was the forest
    // doing its job — a stand is an order of magnitude denser than open field.
    // The sea is the bigger term by far now: the plain mode plants the whole
    // ±160 field, and the mapped world plants only the island inside a coast
    // whose nearest point is 131 units out.
    expect(plain.length).toBeGreaterThan(shipped().length);
  });

  it('gives the identical world back when the map is switched on again', () => {
    const before = shipped().map(key);
    inPlain(() => computePlacements());
    expect(shipped().map(key)).toEqual(before);
  });

  it('stays cheap enough to run on a slider drag', () => {
    // Warm the module (first call pays for the shoreline polygons).
    computePlacements();
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) computePlacements({ density: 1 + i * 0.05 });
    const each = (performance.now() - t0) / 3;
    expect(each).toBeLessThan(150);
  });
});
