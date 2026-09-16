/**
 * The island — pure geography. No WebGL, no DOM.
 *
 * 2026-09-15, user ask: *"I want this map to be an island instead of a large
 * flat plane … it should feel like Studio Ghibli meets Scavengers Reign on a
 * tropical island."* The LOOK is a separate pass; what is pinned here is the
 * geography and the four things every other system reads off it:
 *
 *   the coast   a union of wobbled lobes, inside the displaced ground field,
 *               wound counter-clockwise like every other ring the geography
 *               hands over, and far enough from every authored feature that
 *               the forest, the range, the lake and the ponds all keep real
 *               land between themselves and the sea;
 *   the sea     `isWater` outside that coast, and only in the landscape mode:
 *               the plain world the room opens on is still exactly the flat
 *               field it was (the same parity `test/world/painted.test.ts`
 *               pins for painted height, measured here at 2,000 points);
 *   the height  a mirrored basin — the land climbing out of the waterline,
 *               the floor falling away from it, and nothing anywhere that
 *               sits below the water beside it;
 *   the beach   a soft weight and a `Region`, so scatter can plant sand
 *               without a second shoreline of its own.
 *
 * THE MODE, as everywhere else in this directory: the world SHIPS `'plain'`,
 * so everything that measures the authored map switches it on and puts it
 * back. The plain block at the bottom is the other half of the contract.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zeroPlanting } from '../../src/world/painted';
import {
  BEACH_WIDTH,
  FOREST_BLOBS,
  ISLAND,
  ISLAND_LOBES,
  MOUNTAIN_BLOBS,
  SEA_LEVEL,
  TERRAIN,
  TERRAIN_DEFAULTS,
  WATER_BODIES,
  WATER_COLLIDER_BITE,
  WATER_COLLIDER_R,
  WOBBLE_MAX,
  coastInland,
  coastOutline,
  coastRadius,
  coastShoreSamples,
  farFieldStart,
  isAuthoredWater,
  isWater,
  mapScale,
  sampleLandscape,
  seaLevel,
  setIslandMode,
  setLandscapeMode,
  terrainHeight,
  terrainNormal,
  waterColliders,
  wobbledRadius,
  type Blob,
} from '../../src/world/landscape';
import { fieldSize } from '../../src/world/ground';
import { worldMapExtent } from '../../src/ui/minimap';
import { ROLLING_SURFACE } from '../../src/world/surface';

const TAU = Math.PI * 2;

/** The land the layout keeps between every authored feature's edge and the
 * sea. Authored as a design rule and measured here rather than asserted from
 * a comment: the features were placed (2026-09-03) for a field that had no
 * coast in it at all, and the island's lobes are positioned to clear them. */
const FEATURE_TO_SEA = 12;
/* …and it does NOT ride `mapScale`: twelve units of dry land is a physical
 * clearance, like the beach. Scaling the layout about the origin only ever
 * widens it — measured 12.55 at the authored size and 27.31 on the doubled
 * island — so the rule holds with room to spare at either size. */

/**
 * Every authored feature as a plain blob (water bodies use their outer r).
 *
 * A FUNCTION, never a captured const: `setIslandMode` re-points the exported
 * layout at the map's own scale (src/world/landscape.ts `MAP_SCALE`), and this
 * module is evaluated before `beforeAll` turns the island on.
 */
const features = (): Blob[] => [
  ...FOREST_BLOBS,
  ...MOUNTAIN_BLOBS,
  ...WATER_BODIES.map((b) => ({ x: b.x, z: b.z, r: b.r, seed: b.seed })),
];

/** Points evenly around a blob's wobbled edge. */
function edgePoints(b: Blob, n = 360): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    const r = wobbledRadius(b, t);
    out.push([b.x + Math.cos(t) * r, b.z + Math.sin(t) * r]);
  }
  return out;
}

/**
 * TRUE distance from a point on the island to the sea — the shortest walk in
 * any direction before the ground stops being land, capped at `cap`.
 *
 * Deliberately not `coastInland`: that is the union's own radial field, which
 * overstates the distance wherever the nearest water is not straight out from
 * a lobe's centre. The rule being measured is a distance on the ground, so
 * this measures one.
 */
function walkToSea(x: number, z: number, cap = 40): number {
  let worst = cap;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * TAU;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    let d = 0;
    // `coastInland < 0` rather than `isWater`: a lake's own edge IS water, and
    // the rule being measured is how far a feature stands from the OCEAN.
    for (; d <= worst; d += 0.25) {
      if (coastInland(x + cos * d, z + sin * d) < 0) break;
    }
    if (d < worst) worst = d;
  }
  return worst;
}

/** A deterministic spread of probe points over a square of half-extent
 * `half` — the same shape of walk `test/world/painted.test.ts` uses for its
 * parity fixture, so the two measure the same kind of coverage. */
function probes(count: number, half = 200): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const x = -half + ((i * 137) % (half * 2));
    const z = -half + ((i * 61) % (half * 2));
    out.push([x, z]);
  }
  return out;
}

/*
 * THE ISLAND IS A PER-WORLD GAME'S MAP (2026-09-15 user ruling,
 * src/world/game.ts). It ships OFF, like the landscape mode beside it and for
 * a sharper reason: the default branch builds every world's production
 * deployment at once, so a coast that is right for the katamari world must not
 * be able to reach meridian or the public one. Everything this file measures
 * is the map with the island ON, so it switches both on and puts both back —
 * test/world/landscape.test.ts's island-off block is the other half.
 */
beforeAll(() => {
  setLandscapeMode('landscape');
  setIslandMode(true);
});
afterAll(() => {
  setLandscapeMode('plain');
  setIslandMode(false);
});

describe('the island — the coast', () => {
  it('is a union of wobbled lobes led by the main mass, and no lobe is a circle', () => {
    expect(ISLAND_LOBES[0]).toBe(ISLAND);
    expect(ISLAND_LOBES.length).toBeGreaterThan(1);
    for (const lobe of ISLAND_LOBES) {
      const radii = new Set<number>();
      for (let i = 0; i < 64; i++) radii.add(wobbledRadius(lobe, (i / 64) * TAU));
      // A circle would answer one radius at every angle (TASTE §2.5: the grid
      // places, it never forms).
      expect(radii.size, `lobe ${lobe.seed}`).toBeGreaterThan(50);
    }
    // …and the union really is bigger than the main mass alone: each lobe has
    // to reach somewhere the main blob does not, or it is not doing anything.
    for (const lobe of ISLAND_LOBES.slice(1)) {
      const dir = Math.atan2(lobe.z, lobe.x);
      const beyond = wobbledRadius(ISLAND, dir);
      expect(coastRadius(dir), `lobe ${lobe.seed}`).toBeGreaterThan(beyond);
    }
  });

  it('is deterministic — the same coast on every call and every device', () => {
    expect(coastOutline()).toEqual(coastOutline());
    expect(coastShoreSamples()).toEqual(coastShoreSamples());
    for (let i = 0; i < 200; i++) {
      const x = -180 + ((i * 137) % 360);
      const z = -180 + ((i * 61) % 360);
      expect(coastInland(x, z)).toBe(coastInland(x, z));
    }
  });

  it('fits inside the displaced ground field, with its floor slope to spare', () => {
    // The ground's own field runs to ±200 and its far ring starts there, so
    // the coast AND the slope that falls from it to the sea floor both have to
    // land inside that square — otherwise the ring would be seated mid-slope
    // and the two would meet at a step.
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < 1440; i++) {
      const r = coastRadius((i / 1440) * TAU);
      mn = Math.min(mn, r);
      mx = Math.max(mx, r);
    }
    // Measured 131.67 .. 176.30 at the authored size, and 263.34 .. 352.52 on
    // the doubled island (2026-09-16, `MAP_SCALE`) — exactly twice, because
    // the scale is uniform and about the origin. Every bound here rides it.
    expect(mn).toBeGreaterThan(120 * mapScale());
    expect(mx).toBeLessThan(184 * mapScale());
    expect(mx + TERRAIN.shoreRamp).toBeLessThan(fieldSize() / 2);
    // …and the map's own extent contains it, so the minimap draws the whole
    // island rather than clipping its south-east headland (src/ui/minimap.ts
    // WORLD_MAP_EXTENT, widened from 175 to 185 for exactly this).
    expect(mx).toBeLessThan(worldMapExtent());
  });

  it('walks counter-clockwise, unrepeated, at the requested budget', () => {
    for (const points of [48, 192, 400]) {
      const poly = coastOutline(points);
      expect(poly).toHaveLength(points);
      // The shoelace of a counter-clockwise ring in x/z is positive — the same
      // convention `waterOutline` and `islandOutline` hand over, which is what
      // lets `(dz, −dx)` point off the island and into the sea at every vertex.
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        area += a[0] * b[1] - b[0] * a[1];
      }
      expect(area / 2, `${points} points`).toBeGreaterThan(0);
      // The last point is not the first repeated, and every point is on the
      // waterline the inside test agrees with.
      expect(poly[0]).not.toEqual(poly[poly.length - 1]);
      for (const [x, z] of poly) {
        expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true);
        expect(Math.abs(coastInland(x, z)), `${x},${z}`).toBeLessThan(1e-6);
      }
    }
  });

  it('keeps every authored feature a dozen units of land clear of the sea', { timeout: 60_000 }, () => {
    // The numeric version of the layout rule. Every feature edge point has to
    // be able to walk FEATURE_TO_SEA units in any direction and still be on
    // land, or an arm of the forest / the range / the lake reaches the coast
    // and the island has eaten it.
    let worst = Infinity;
    let worstAt = '';
    for (const b of features()) {
      for (const [x, z] of edgePoints(b, 240)) {
        const d = walkToSea(x, z);
        if (d < worst) {
          worst = d;
          worstAt = `blob ${b.seed} at ${x.toFixed(1)},${z.toFixed(1)}`;
        }
      }
    }
    // Measured 12.55, at the range's eastern mass (seed 203).
    expect(worst, worstAt).toBeGreaterThanOrEqual(FEATURE_TO_SEA);
  });
});

describe('the island — the sea', () => {
  it('is water outside the coast and land inside it, on every bearing', () => {
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * TAU;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const r = coastRadius(th);
      // Just inside: land. Just outside, and a long way outside: sea.
      expect(isWater(cos * (r - 1), sin * (r - 1)), `inside at ${th.toFixed(2)}`).toBe(false);
      for (const out of [1, 10, 60, 400]) {
        expect(isWater(cos * (r + out), sin * (r + out)), `${out} out at ${th.toFixed(2)}`).toBe(
          true,
        );
      }
      // …and the region label agrees with the wet test.
      expect(sampleLandscape(cos * (r + 4), sin * (r + 4)).region).toBe('water');
    }
    // The hatch clearing is a long way from any of it.
    expect(isWater(0, 0)).toBe(false);
    expect(coastInland(0, 0)).toBeGreaterThan(100);
  });

  it('grows and shrinks with the pad, like every other body', () => {
    for (let i = 0; i < 180; i++) {
      const th = (i / 180) * TAU;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const r = coastRadius(th);
      // A positive pad pulls the waterline INLAND (the keep-out planting
      // asks for); a negative one pushes it out to sea.
      expect(isWater(cos * (r - 3), sin * (r - 3), 5)).toBe(true);
      expect(isWater(cos * (r + 3), sin * (r + 3), -5)).toBe(false);
    }
  });

  it('is part of the authored map, so the renderer can build it while hidden', () => {
    // `isAuthoredWater` is the map AS WRITTEN and ignores the mode — the water
    // pass builds its coast ribbon once, at startup, while the world is still
    // opening plain (src/world/water.ts).
    setLandscapeMode('plain');
    try {
      expect(isAuthoredWater(0, 400)).toBe(true);
      expect(isAuthoredWater(0, 0)).toBe(false);
      // …but the world is not reading it.
      expect(isWater(0, 400)).toBe(false);
    } finally {
      setLandscapeMode('landscape');
    }
  });
});

describe('the island — the beach', () => {
  it('reads 1 at the waterline and fades to 0 a beach-width inland', () => {
    // Read against `coastInland` itself rather than against a radial step off
    // `coastRadius`: the inland field is the UNION's, so a point one unit in
    // from the coast along a ray out of the origin is only approximately one
    // unit of inland field in (measured within ~1.5 units, where a second
    // lobe's own radius is the one that answers). The field is what every
    // consumer reads, so the profile is pinned in its terms.
    for (let i = 0; i < 180; i++) {
      const th = (i / 180) * TAU;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const r = coastRadius(th);
      let previous = Infinity;
      let lastInland = -Infinity;
      for (let step = 0.25; step <= 40; step += 0.25) {
        const x = cos * (r - step);
        const z = sin * (r - step);
        const at = sampleLandscape(x, z);
        const inland = coastInland(x, z);
        expect(at.beach, `${step} in at ${th.toFixed(2)}`).toBe(
          Math.min(1, Math.max(0, 1 - inland / BEACH_WIDTH)),
        );
        // Monotone in the field: a beach fades inland, it does not come and go.
        if (inland > lastInland) {
          expect(at.beach, `${step} in at ${th.toFixed(2)}`).toBeLessThanOrEqual(previous);
        }
        lastInland = inland;
        previous = at.beach;
      }
      // At the waterline it is full…
      expect(sampleLandscape(cos * (r - 0.01), sin * (r - 0.01)).beach).toBeGreaterThan(0.999);
      // …and well past a beach-width of field there is none of it left.
      for (const step of [BEACH_WIDTH + 4, BEACH_WIDTH + 20, 70]) {
        expect(
          sampleLandscape(cos * (r - step), sin * (r - step)).beach,
          `${step} in`,
        ).toBeLessThan(1e-9);
      }
      // The sea's own surface is not a beach.
      expect(sampleLandscape(cos * (r + 4), sin * (r + 4)).beach).toBe(0);
    }
    // …and the middle of the island is not one either.
    expect(sampleLandscape(0, 0).beach).toBe(0);
    for (const b of features())
      expect(sampleLandscape(b.x, b.z).beach, `blob ${b.seed}`).toBe(0);
  });

  it('labels the half of it nearest the water as a region of its own', () => {
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * TAU;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const r = coastRadius(th);
      // `beach >= 0.5` is the inner half of BEACH_WIDTH, measured in the
      // inland field — so the label is asserted against that field, not
      // against a radial step (see the profile test above).
      for (let step = 0.25; step <= 40; step += 0.25) {
        const x = cos * (r - step);
        const z = sin * (r - step);
        const at = sampleLandscape(x, z);
        // A walk this long crosses the lake and the range on some bearings;
        // those carry their own labels and the priority order puts them first.
        if (at.water || at.island || at.forest >= 0.5 || at.mountain >= 0.5) continue;
        const want = coastInland(x, z) <= BEACH_WIDTH / 2 ? 'beach' : 'plain';
        expect(at.region, `${step} in at ${th.toFixed(2)}`).toBe(want);
      }
    }
  });

  it('never contends with a feature region — the layout keeps them apart', { timeout: 60_000 }, () => {
    // The beach claims at most BEACH_WIDTH / 2 = 7 units of inland field, and
    // every authored feature keeps 12 units of land, so a beach cell can never
    // also be forest, mountain, island or water. That is what makes the
    // `Region` priority a tie-break rather than a decision.
    let beached = 0;
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * TAU;
      const r = coastRadius(th);
      for (let step = 0.25; step <= 20; step += 0.25) {
        const x = Math.cos(th) * (r - step);
        const z = Math.sin(th) * (r - step);
        const at = sampleLandscape(x, z);
        if (at.region !== 'beach') continue;
        beached++;
        // A whisker of forest weight can reach the beach where the western
        // stand's falloff runs out (measured 9e-5 at one point), so what is
        // pinned is that neither region ever CONTENDS for the label: both
        // stay under the 0.5 that would claim it.
        expect(at.forest, `${x.toFixed(1)},${z.toFixed(1)}`).toBeLessThan(0.5);
        expect(at.mountain).toBeLessThan(0.5);
        expect(at.island).toBe(false);
        expect(at.water).toBe(false);
        // …and it really is beside the sea, not a stray label inland.
        expect(walkToSea(x, z), `${x.toFixed(1)},${z.toFixed(1)}`).toBeLessThan(BEACH_WIDTH);
      }
    }
    // Not an empty sweep: the coast is lined with beach the whole way round.
    expect(beached).toBeGreaterThan(2000);
  });
});

describe('the island — the height', () => {
  it('meets the sea exactly at the waterline, and never below it beside it', () => {
    const level = seaLevel();
    expect(level).toBe(SEA_LEVEL * TERRAIN_DEFAULTS.elevation);
    // Under the plain's own tier 0, so the beach is a step DOWN to the water.
    expect(level).toBeLessThan(0);
    for (let i = 0; i < 360; i++) {
      const th = (i / 360) * TAU;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const r = coastRadius(th);
      // Exactly the water's own level at the waterline — no authored basin's
      // shore ramp reaches the coast, which is what the south-east lobe's
      // radius is tuned for (src/world/landscape.ts ISLAND_LOBES).
      expect(terrainHeight(cos * r, sin * r), `waterline at ${th.toFixed(2)}`).toBeCloseTo(
        level,
        9,
      );
      // …and the first units of beach hold at or above it, so no ground the
      // water could lap over is left lower than the water (the rim guard).
      for (let inland = 0; inland <= TERRAIN.basinRim; inland += 0.25) {
        expect(
          terrainHeight(cos * (r - inland), sin * (r - inland)),
          `rim ${inland} in at ${th.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(level - 1e-9);
      }
    }
  });

  it('falls monotonically from the waterline to a flat sea floor', () => {
    const level = seaLevel();
    const floor = level - TERRAIN.basinDrop * TERRAIN_DEFAULTS.elevation;
    for (let i = 0; i < 180; i++) {
      const th = (i / 180) * TAU;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const r = coastRadius(th);
      let previous = level + 1e-9;
      for (let out = 0; out <= TERRAIN.shoreRamp; out += 0.5) {
        const h = terrainHeight(cos * (r + out), sin * (r + out));
        expect(h, `sea ${out} out at ${th.toFixed(2)}`).toBeLessThanOrEqual(previous + 1e-9);
        expect(h).toBeGreaterThanOrEqual(floor - 1e-9);
        previous = h;
      }
      // …and flat from there to the horizon: the far ground ring is sea floor.
      // Measured in the inland FIELD rather than at a radial offset, for the
      // reason the beach profile gives: a step out along the ray is only
      // approximately a step of field.
      for (const out of [60, 400, 1200]) {
        const x = cos * (r + out);
        const z = sin * (r + out);
        expect(coastInland(x, z)).toBeLessThan(-TERRAIN.shoreRamp);
        expect(terrainHeight(x, z), `floor ${out} out`).toBe(floor);
      }
    }
  });

  it('climbs out of the sea onto the terraced land, in tiers', () => {
    // A coast that read as a smooth swell would read as nothing at all in an
    // orthographic ink render (TASTE §3, and the whole reason the field is
    // terraced). Walk in from the waterline on a bearing where the land
    // stands well above the sea and count the plateaus.
    const th = Math.atan2(-130, 62); // the north-east coast, under the range
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const r = coastRadius(th);
    // THE WHOLE TRAVERSE, waterline to hatch clearing, rather than a fixed 60
    // units (2026-09-16, `MAP_SCALE`). The window has to be a share of the
    // island and not a count of units: on the doubled island 60 units is a
    // sixth of the way in and lands entirely on the range's own shoulder,
    // which is ONE tread — the walk found a 4.8 plateau and nothing else.
    // Waterline to clearing is the same journey at either size.
    const line: number[] = [];
    const reach = r - TERRAIN.clearEdge;
    for (let inland = 0; inland <= reach; inland += 0.5) {
      line.push(terrainHeight(cos * (r - inland), sin * (r - inland)));
    }
    // It really does climb — measured 7.07 from the waterline to the crest of
    // the shoulder (the walk ENDS on the flat clearing, so this is the climb
    // and not the end-to-end difference).
    expect(Math.max(...line) - line[0]!).toBeGreaterThan(2);
    // …and it arrives on the world's own tiers rather than on heights of its
    // own: at least two of them, past the coast ramp AND past the far fade,
    // which covers the outer stretch of the coast at any map scale (the land
    // there is multiplied by the gate, so no sample on it is on a tier).
    // Measured 4 on the doubled island: 0, 1.6, 3.2 and 4.8.
    const clear = Math.max(TERRAIN.coastRamp, r - farFieldStart());
    const tiers = new Set<number>();
    for (const h of line.slice(Math.floor(clear * 2))) {
      const k = h / TERRAIN_DEFAULTS.tierStep;
      if (Math.abs(k - Math.round(k)) < 1e-9) tiers.add(Math.round(k));
    }
    expect(tiers.size).toBeGreaterThanOrEqual(2);
  });

  it('is sampled through the Surface seam, like everything else', () => {
    for (const [x, z] of probes(300)) {
      expect(ROLLING_SURFACE.sampleHeight(x, z)).toBe(terrainHeight(x, z));
      const n = ROLLING_SURFACE.normalAt(x, z);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
      expect(n.y).toBeGreaterThan(0);
    }
  });

  it('flattens the sea with the elevation dial, floor and all', () => {
    // Every authored vertical rides the dial, `SEA_LEVEL` included — which is
    // what keeps elevation 0 an exactly flat world rather than a flat world
    // with an ocean cut into it. (`test/world/landscape.test.ts` pins the
    // whole-map version; this is the sea's own half of it.)
    expect(seaLevel()).toBe(SEA_LEVEL * TERRAIN_DEFAULTS.elevation);
  });
});

describe('the island — the physics', () => {
  it('walls the coast with hard circles a creature cannot thread', () => {
    const cols = waterColliders();
    const sea = cols.filter((c) => coastInland(c.x, c.z) < 0);
    // A WALL along the coast, not a tiling of the ocean: the count has to stay
    // the size of a coastline. Measured 476 for a ~940-unit coast, and 958 for
    // the doubled island's ~1880-unit one — the wall is an arc LENGTH, so it
    // rides `mapScale` once and not twice (a tiling of the ocean would have
    // gone up fourfold, which is the whole reason this is a wall).
    expect(sea.length).toBeGreaterThan(200 * mapScale());
    expect(sea.length, `sea colliders: ${sea.length}`).toBeLessThan(600 * mapScale());
    for (const c of sea) {
      expect(c.hard).toBe(true);
      expect(c.r).toBe(WATER_COLLIDER_R);
      // Centred on water, like every other collider on the map.
      expect(isWater(c.x, c.z)).toBe(true);
    }
    // No gap: step out from the waterline on any bearing and a circle stops
    // you within the bite it is allowed to take off the beach.
    for (let i = 0; i < 720; i++) {
      const th = (i / 720) * TAU;
      const r = coastRadius(th);
      const x = Math.cos(th) * (r + WATER_COLLIDER_BITE);
      const z = Math.sin(th) * (r + WATER_COLLIDER_BITE);
      expect(
        sea.some((c) => Math.hypot(x - c.x, z - c.z) < c.r),
        `unblocked coast at ${th.toFixed(3)}`,
      ).toBe(true);
    }
  });

  it('leaves the beach walkable — the wall bites no further than it may', () => {
    // The keep rule, for the sea's wall: a circle's centre stands
    // `WATER_COLLIDER_R - WATER_COLLIDER_BITE` out to sea, so the circle
    // protrudes at most `WATER_COLLIDER_BITE` onto the beach. (The lakes and
    // ponds are TILED rather than walled and sit far inland, so they are not
    // what this measures — test/world/landscape.test.ts covers those.)
    for (const c of waterColliders()) {
      if (coastInland(c.x, c.z) >= 0) continue;
      // Slack, because the circles are placed off the coast POLYGON (which the
      // renderer also draws) and measured here against the inland FIELD, and
      // the two agree to a fraction of a unit rather than exactly — see the
      // beach profile test. Measured worst 0.734 against a 0.6 bite at the
      // authored size; 0.930 on the doubled island (2026-09-16, `MAP_SCALE`),
      // because the union's signed field is measured from each lobe's OWN
      // centre and the lobes now stand twice as far off the origin, so a push
      // along the polygon's normal lands a little less far out than it asks
      // for. Still under a unit of a 14-unit beach, and the beach is a beach
      // at either size (`BEACH_WIDTH` does not scale).
      expect(coastInland(c.x, c.z) + WATER_COLLIDER_R).toBeLessThan(WATER_COLLIDER_BITE + 0.4);
    }
  });

  it('lines the coast with shore samples that stand on dry land', () => {
    const samples = coastShoreSamples();
    // A ~940-unit coast at the default 2.2-unit spacing.
    expect(samples.length).toBeGreaterThan(300);
    const sectors = new Set<number>();
    for (const s of samples) {
      expect(isWater(s.x, s.z), `sample at ${s.x},${s.z}`).toBe(false);
      expect(Math.hypot(s.nx, s.nz)).toBeCloseTo(1, 9);
      // The normal points AWAY from the water, which here is inland.
      expect(coastInland(s.x + s.nx, s.z + s.nz)).toBeGreaterThan(coastInland(s.x, s.z));
      sectors.add(Math.floor(((Math.atan2(s.z, s.x) + TAU) % TAU) / (Math.PI / 6)));
    }
    // …all twelve 30° sectors: the whole coast is lined, not one arc of it.
    expect(sectors.size).toBe(12);
  });
});

describe('the island — the plain mode is untouched', () => {
  it('has no sea, no beach and no coast colliders in it, at 2,000 points', () => {
    // The parity the painted hook is held to, for the map's newest feature:
    // the room opens on a flat field, and an island that leaked into it would
    // make the mode the one world nobody can open on.
    setLandscapeMode('plain');
    try {
      for (const [x, z] of probes(2000, 260)) {
        const at = `${x},${z}`;
        expect(isWater(x, z), at).toBe(false);
        expect(isWater(x, z, 8), at).toBe(false);
        expect(terrainHeight(x, z), at).toBe(0);
        expect(terrainNormal(x, z), at).toEqual({ x: 0, y: 1, z: 0 });
        expect(sampleLandscape(x, z), at).toEqual({
          forest: 0,
          mountain: 0,
          water: false,
          island: false,
          beach: 0,
          region: 'plain',
          planting: zeroPlanting(),
        });
      }
      expect(seaLevel()).toBe(0);
      expect(waterColliders()).toEqual([]);
    } finally {
      setLandscapeMode('landscape');
    }
    // …and the mapped answers are not a tautology: the same probes find a real
    // island with the map switched on.
    const wet = probes(2000, 260).filter(([x, z]) => isWater(x, z));
    expect(wet.length).toBeGreaterThan(100);
    const beached = probes(2000, 260).filter(([x, z]) => sampleLandscape(x, z).region === 'beach');
    expect(beached.length).toBeGreaterThan(0);
  });

  it('keeps the coast exported whatever the mode — the renderer builds from it', () => {
    const mapped = coastOutline();
    setLandscapeMode('plain');
    try {
      expect(coastOutline()).toEqual(mapped);
      expect(ISLAND_LOBES.length).toBeGreaterThan(1);
      expect(ISLAND.r * WOBBLE_MAX).toBeGreaterThan(150);
    } finally {
      setLandscapeMode('landscape');
    }
    expect(coastOutline()).toEqual(mapped);
  });
});
