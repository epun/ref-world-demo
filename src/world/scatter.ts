/**
 * Scatter — jittered iso-grid placement of the prop motifs (TASTE §2.5:
 * the grid places, it NEVER forms; §2.3: global density holds near 0.39
 * with generous empty paper between clusters).
 *
 * Placement is a pure, deterministic function of (cell, seed, density):
 * per-cell hash rolls decide whether a cell seeds a cluster and of what
 * kind; a seeded cell rolls 1–4 neighbors of the same kind (GENERATOR:
 * "small grove surrounded by empty land"). No Math.random anywhere — the
 * same world grows on every device.
 *
 * VARIANCE: every kind carries several authored variants. Each cluster
 * picks a cluster variant; neighbors bias ~60% toward it, so a grove reads
 * as one species with strays — matching the forest reference, where a
 * stand is mostly one crown build plus outliers. Buildings are rare
 * (capped across the region), stand alone, and no two of the same variant
 * sit near each other.
 *
 * Rendering: one InstancedMesh per (kind, variant) — ~20 draws. Inflated
 * props carry the LIGHT paper albedo (the ink pass draws their form);
 * ticks are the ONLY dark environment marks — tiny crossed ink quads doing
 * the ground-texture work of the reference, numerous relative to the props.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { Collider } from '../physics/colliders';
import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import {
  isWater,
  sampleLandscape,
  shoreSamples,
  waterColliders,
  WATER_BODIES,
  type LandscapeSample,
} from './landscape';
import {
  BUILDING_COURTYARD_VARIANT,
  buildPropGeometries,
  MOUNTAIN_FOOTPRINT,
  PROP_KINDS,
  PROP_VARIANT_COUNTS,
  type PropKind,
} from './props';
import { stampEllipse, stampRotationY, type StampEllipse } from './shadows';

export type ScatterKind = PropKind | 'tick' | 'reed';

/** The flat ink marks: no collider, no shadow stamp, no inflated variant
 * geometry behind them. Everything else in a placement list is a prop. */
function isMark(kind: ScatterKind): kind is 'tick' | 'reed' {
  return kind === 'tick' || kind === 'reed';
}

export interface Placement {
  kind: ScatterKind;
  /** Variant index within the kind's authored set (0 for ticks). */
  variant: number;
  x: number;
  z: number;
  /** Uniform instance scale, 0.7–1.3. */
  scale: number;
  /** Y rotation, radians. */
  rotY: number;
}

export interface Exclusion {
  x: number;
  z: number;
  r: number;
}

// ── placement (pure) ─────────────────────────────────────────────────────────

/** Iso-grid step in world units. */
export const SCATTER_STEP = 6;
/** Half-extent of the scattered region. */
export const SCATTER_EXTENT = 120;
/** World seed — one world, one growth. The shipped default. */
export const SCATTER_SEED = 7;

/**
 * The seed actually in force.
 *
 * Placement is a pure function of (cell, seed, density), so changing this
 * re-rolls every cluster — a different world from the same rules, which is
 * exactly what the panel's seed control is for (user ask). It is module
 * state rather than a placement option because `cellHash` is called from
 * the pure placement helpers, which take no instance.
 *
 * Determinism is unaffected: the same seed always grows the same world, and
 * the shipped default is unchanged, so a session that never touches the
 * control is byte-identical to before.
 */
let activeSeed: number = SCATTER_SEED;

/** The seed the world is currently grown from. */
export function scatterSeed(): number {
  return activeSeed;
}

/** Re-seed the placement. Callers must rebuild the scatter to see it. */
export function setScatterSeed(seed: number): void {
  activeSeed = Math.floor(seed);
}

/** [D] Clearing radius around the origin: the hatch ground stays open paper
 * (creature spawns spiral out from the origin; live exclusions arrive later
 * via setExclusions, but the landing field is never planted to begin with). */
const ORIGIN_CLEAR_PROPS = 11;
const ORIGIN_CLEAR_TICKS = 6;

/** Per-cell cluster-seed probability at density 1. Ticks common, trees /
 * conifers / rocks medium, buildings rare (and hard-capped), the new
 * hidden-folks kinds rare: palm groves like conifer stands, cacti sparse
 * loners, picnic tables scarce, water towers landmark-capped, monoliths in
 * rare pairs. */
const SEED_PROB: Record<ScatterKind, number> = {
  tick: 0.16,
  bush: 0.014,
  tree: 0.011,
  conifer: 0.009,
  rock: 0.011,
  stump: 0.004,
  building: 0.008,
  palm: 0.006,
  cactus: 0.0045,
  picnicTable: 0.003,
  waterTower: 0.004,
  monolith: 0.004,
  // Neither of these rolls per cell in the plain. A mountain is landscape:
  // it comes from the map's own weight field in a pre-pass. A reed grows on
  // a shoreline or nowhere.
  mountain: 0,
  reed: 0,
};

// ── landscape-aware seeding ──────────────────────────────────────────────────
// The plain is still the world that shipped: a cell whose forest and mountain
// weights are both 0 rolls EXACTLY the old expression (see `prob` in
// computePlacements). What the map adds is three regional tables that blend
// in with those weights, a water cut-out that nothing crosses, and mountains
// placed from the weight field before anything else claims the ground.

type RegionSeed = Partial<Record<ScatterKind, number>>;

/** Inside the forest: a real stand — trees and conifers an order of
 * magnitude past the plain's, bushes and stumps under them, the odd stone.
 * Absolute per-cell probabilities; the panel's sliders scale them through
 * `userMult`, so a slider at its shipped default leaves these as authored. */
const FOREST_SEED: RegionSeed = {
  tree: 0.26,
  conifer: 0.18,
  bush: 0.05,
  stump: 0.03,
  rock: 0.006,
  tick: 0.1,
};

/** On the range: scree, stubborn conifers, standing stones, thin grass. */
const MOUNTAIN_SEED: RegionSeed = {
  rock: 0.05,
  conifer: 0.04,
  monolith: 0.012,
  bush: 0.006,
  tick: 0.06,
};

/** The island grows its own thing. Nothing BUILT is in this table, so no
 * building, tower, picnic table or cactus ever reaches it. */
const ISLAND_SEED: RegionSeed = {
  palm: 0.12,
  tree: 0.06,
  rock: 0.04,
  bush: 0.04,
  tick: 0.16,
};

/** [D] Planting keep-out from every shoreline. A cell this close to water
 * seeds NOTHING — not even a tick — so a cluster's seed can never sit on
 * the waterline and throw its whole grove into the pond. */
const SHORE_KEEPOUT = 1;
/** [D] The final cut: no placement of any kind, cluster neighbours and
 * shoreline reeds included, may stand in water or this close to it. */
const WATER_KEEPOUT = 0.6;

/** Mountain weight a cell needs before it may seed a mountain at all. */
const MOUNTAIN_MIN_WEIGHT = 0.35;
/** Per-cell mountain roll at weight 1. Squared in the weight below, so the
 * range crowds its own core and never strays onto its skirt. [D] */
const MOUNTAIN_SEED_PROB = 0.22;
/** Hash salts for the mountain pre-pass and the shoreline reed walk. Both
 * APPENDED to the salt family: every pre-existing kind still rolls the
 * exact salt it rolled before the map existed. */
const MOUNTAIN_SALT = 71.9;
const REED_SALT = 81.3;

/** At most this many mountains in the region, in cell order — a backdrop
 * range, not a mountain world. */
export const MOUNTAIN_MAX = 16;
/** Fraction of a mountain's footprint swept clear of everything else. A
 * tree poking out of a mountainside is a bug; the 0.85 leaves the skirt
 * plantable, so the range meets the forest instead of ending on bare
 * paper. [D] */
export const MOUNTAIN_CLEAR_FIT = 0.85;

/** [D] The island is barely wider than one cluster's normal reach and
 * offers a handful of grid cells to seed from at all, so a cluster that
 * lands there is drawn in tight and carries a couple of extra neighbours:
 * one grove, rather than two lone palms with the rest of the stand drowned
 * in the lake. */
const ISLAND_CLUSTER_SPREAD = 0.4;
const ISLAND_CLUSTER_EXTRAS = 2;

/** Fraction of shore samples carrying a reed at density 1 — reeds are the
 * shoreline's texture, so this is a keep rate, not a rarity. */
const REED_SHORE_KEEP = 0.6;
/** How far a reed steps off its shore sample, along the outward normal. */
const REED_OFFSET_MIN = 0.3;
const REED_OFFSET_SPAN = 0.9;

/** At most this many buildings in the whole region, in cell iteration order.
 * Raised from 4 (user report: "where are the buildings") — structures should
 * be encountered while roaming; the panel's building-density slider layers
 * on top via setKindDensity('building'). */
export const BUILDING_MAX = 10;
/** No two buildings of the same variant within this many world units. */
export const BUILDING_ADJ_RADIUS = SCATTER_STEP * 8;

/** At most this many water towers in the region — the same landmark-rarity
 * family as buildings, spaced by the building adjacency radius. */
export const WATER_TOWER_MAX = 2;

/** A cluster neighbor repeats its cluster's variant with this probability;
 * otherwise it rerolls uniformly (so a grove is one species plus strays). */
export const CLUSTER_VARIANT_BIAS = 0.6;

/** Roll order — new kinds APPEND so the pre-existing kinds keep their hash
 * salts (the same world grows, plus new inhabitants in freed cells). */
const PROP_ROLL_ORDER: PropKind[] = [
  'bush',
  'tree',
  'conifer',
  'rock',
  'stump',
  'building',
  'palm',
  'cactus',
  'picnicTable',
  'waterTower',
  'monolith',
];

/** Every controllable scatter kind, for generic dev-panel controls.
 * `mountain` rides in through PROP_KINDS; `reed` is scatter's own. */
export const SCATTER_KINDS: ScatterKind[] = [...PROP_KINDS, 'tick', 'reed'];

function cellHash(ix: number, iz: number, salt: number): number {
  const x =
    Math.sin(ix * 127.1 + iz * 311.7 + activeSeed * 74.7 + salt * 53.13) * 43758.5453123;
  return x - Math.floor(x);
}

export interface PlacementOptions {
  /** Global density multiplier — scales every seed probability. */
  density?: number;
  /** Per-kind density multipliers, layered on the global one. Each kind
   * rolls independently (own hash salt), so changing one kind's multiplier
   * never moves another kind's placements. */
  kindDensity?: Partial<Record<ScatterKind, number>>;
}

/**
 * Deterministic placements for the whole region. Cluster mechanics: a cell
 * whose roll lands under its kind's (density-scaled) probability becomes a
 * cluster seed and spawns 1–4 neighbors at 0.6–1.6 steps around it (ticks:
 * 2–4 marks total). Neighbor counts hash independently of the kind roll, so
 * the total instance count is monotone in the density multiplier.
 *
 * The map (src/world/landscape.ts) governs WHICH kinds roll where: the
 * forest, the range and the island each carry their own per-cell table,
 * blended in by the cell's soft weight, and water is a hole nothing crosses.
 * Mountains are placed first — they are landscape, so the ground they cover
 * has to be known before anything else is planted on it.
 *
 * PERF: this runs on every density-slider move, so the landscape is sampled
 * exactly ONCE per cell (into `land` below) and shared by both passes.
 */
export function computePlacements(opts: PlacementOptions = {}): Placement[] {
  const density = Math.max(0, opts.density ?? 1);
  const kindDensity = { ...DEFAULT_KIND_DENSITY, ...(opts.kindDensity ?? {}) };
  const out: Placement[] = [];
  const cells = Math.floor(SCATTER_EXTENT / SCATTER_STEP);
  const buildings: { x: number; z: number; variant: number }[] = [];
  const towers: { x: number; z: number; variant: number }[] = [];
  /** Placed mountains as footprint circles (radius at instance scale). */
  const mountains: { x: number; z: number; r: number }[] = [];

  /**
   * The panel's slider RELATIVE to the shipped default. The regional tables
   * above are authored in absolute per-cell terms, so they must not be
   * multiplied by a default that is already baked into them — but a slider
   * still has to scale them, and 0 still has to mean none.
   */
  const userMult = (kind: ScatterKind): number =>
    Math.max(0, kindDensity[kind] ?? 1) / (DEFAULT_KIND_DENSITY[kind] ?? 1);

  /** Inside a placed mountain's swept ground. */
  const underMountain = (x: number, z: number): boolean => {
    for (const mt of mountains) {
      const dx = x - mt.x;
      const dz = z - mt.z;
      const r = mt.r * MOUNTAIN_CLEAR_FIT;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };

  /** Instance scale for a placement, hashed from its quantized position. */
  const scaleAt = (x: number, z: number, salt: number): number =>
    0.7 + cellHash(Math.round(x * 8), Math.round(z * 8), salt + 3.1) * 0.6;

  /** The one gate every placement passes through, cluster neighbours and
   * shoreline reeds included: the hatch clearing, then the water cut-out,
   * then the ground a mountain already stands on. */
  const place = (
    kind: ScatterKind,
    variant: number,
    x: number,
    z: number,
    scale: number,
    rotY: number,
  ): void => {
    const clear = isMark(kind) ? ORIGIN_CLEAR_TICKS : ORIGIN_CLEAR_PROPS;
    if (x * x + z * z < clear * clear) return;
    // Nothing ever stands in water.
    if (isWater(x, z, WATER_KEEPOUT)) return;
    // …and nothing but a mountain stands on a mountain.
    if (kind !== 'mountain' && underMountain(x, z)) return;
    out.push({ kind, variant, x, z, scale, rotY });
  };

  const push = (kind: ScatterKind, variant: number, x: number, z: number, salt: number): void => {
    // Buildings face the default iso camera (azimuth π/4) with a hand-placed
    // jitter: their silhouettes are directional (gate arch, hut doorway) and
    // must read from the frame, where trees and rocks read from any side.
    const rotY =
      kind === 'building'
        ? Math.PI / 4 + (cellHash(Math.round(x * 8), Math.round(z * 8), salt + 4.2) - 0.5) * 0.5
        : cellHash(Math.round(x * 8), Math.round(z * 8), salt + 4.2) * Math.PI * 2;
    place(kind, variant, x, z, scaleAt(x, z, salt), rotY);
  };

  /** Jittered seed position for the cell (the grid places, never forms). */
  const seedPos = (ix: number, iz: number): { sx: number; sz: number } => {
    const jx = (cellHash(ix, iz, 11.7) - 0.5) * 0.84 * SCATTER_STEP;
    const jz = (cellHash(ix, iz, 12.9) - 0.5) * 0.84 * SCATTER_STEP;
    return { sx: ix * SCATTER_STEP + jx, sz: iz * SCATTER_STEP + jz };
  };

  // One landscape sample per cell, shared by the mountain pre-pass and the
  // seeding loop. A cell inside the shore keep-out is recorded as null: it
  // seeds nothing at all, so its region never has to be resolved.
  const span = cells * 2 + 1;
  const cellAt = (ix: number, iz: number): number => (iz + cells) * span + (ix + cells);
  const seeds: { sx: number; sz: number }[] = new Array<{ sx: number; sz: number }>(span * span);
  const land: (LandscapeSample | null)[] = new Array<LandscapeSample | null>(span * span);
  for (let iz = -cells; iz <= cells; iz++) {
    for (let ix = -cells; ix <= cells; ix++) {
      const sp = seedPos(ix, iz);
      const i = cellAt(ix, iz);
      seeds[i] = sp;
      land[i] = isWater(sp.sx, sp.sz, SHORE_KEEPOUT) ? null : sampleLandscape(sp.sx, sp.sz);
    }
  }

  const cluster = (
    kind: ScatterKind,
    ix: number,
    iz: number,
    extras: number,
    spread = 1,
  ): void => {
    const { sx, sz } = seedPos(ix, iz);
    const count = kind === 'tick' || kind === 'reed' ? 1 : PROP_VARIANT_COUNTS[kind];
    // The cluster's species: uniform over the kind's variants.
    const clusterVariant = Math.min(count - 1, Math.floor(cellHash(ix, iz, 31.1) * count));
    push(kind, clusterVariant, sx, sz, 1);
    for (let n = 0; n < extras; n++) {
      const a = cellHash(ix, iz, 21.3 + n * 5.7) * Math.PI * 2;
      const r = (0.6 + cellHash(ix, iz, 22.5 + n * 5.7)) * SCATTER_STEP * spread;
      // Neighbor bias: mostly the cluster's variant, sometimes a stray.
      const variant =
        cellHash(ix, iz, 32.2 + n * 5.7) < CLUSTER_VARIANT_BIAS
          ? clusterVariant
          : Math.min(count - 1, Math.floor(cellHash(ix, iz, 33.3 + n * 5.7) * count));
      push(kind, variant, sx + Math.cos(a) * r, sz + Math.sin(a) * r, 2 + n);
    }
  };

  /** A building stands alone; its variant hashes uniformly, then advances
   * cyclically until it differs from every already-placed building nearby. */
  const placeBuilding = (ix: number, iz: number): void => {
    const { sx, sz } = seedPos(ix, iz);
    if (sx * sx + sz * sz < ORIGIN_CLEAR_PROPS * ORIGIN_CLEAR_PROPS) return;
    const count = PROP_VARIANT_COUNTS.building;
    let variant = Math.min(count - 1, Math.floor(cellHash(ix, iz, 31.1) * count));
    for (let tries = 0; tries < count; tries++) {
      const clash =
        buildings.some(
          (b) =>
            b.variant === variant &&
            (b.x - sx) * (b.x - sx) + (b.z - sz) * (b.z - sz) <
              BUILDING_ADJ_RADIUS * BUILDING_ADJ_RADIUS,
        ) ||
        // The walled courtyard is the pack's largest landmark: one, ever.
        (variant === BUILDING_COURTYARD_VARIANT &&
          buildings.some((b) => b.variant === BUILDING_COURTYARD_VARIANT));
      if (!clash) break;
      variant = (variant + 1) % count;
    }
    buildings.push({ x: sx, z: sz, variant });
    push('building', variant, sx, sz, 1);
  };

  /** A water tower is a landmark: capped at WATER_TOWER_MAX, spaced by the
   * building adjacency radius (against other towers only — per-kind
   * independence), never repeating a variant among the placed towers. */
  const placeWaterTower = (ix: number, iz: number): void => {
    const { sx, sz } = seedPos(ix, iz);
    if (sx * sx + sz * sz < ORIGIN_CLEAR_PROPS * ORIGIN_CLEAR_PROPS) return;
    if (
      towers.some(
        (t) =>
          (t.x - sx) * (t.x - sx) + (t.z - sz) * (t.z - sz) <
          BUILDING_ADJ_RADIUS * BUILDING_ADJ_RADIUS,
      )
    )
      return;
    const count = PROP_VARIANT_COUNTS.waterTower;
    let variant = Math.min(count - 1, Math.floor(cellHash(ix, iz, 31.1) * count));
    if (towers.some((t) => t.variant === variant)) variant = (variant + 1) % count;
    towers.push({ x: sx, z: sz, variant });
    push('waterTower', variant, sx, sz, 1);
  };

  /** Place one mountain and record the ground it covers. Mountains are the
   * only kind exempt from their own clearing, so a range is a merged mass
   * rather than a ring of separated cones. */
  const mountainCount = PROP_VARIANT_COUNTS.mountain;
  const pushMountain = (variant: number, x: number, z: number, salt: number): void => {
    if (mountains.length >= MOUNTAIN_MAX) return;
    // The weight gate applies to the extras too, not just the cell that
    // rolled: a summit that wandered off the range onto open plain would
    // read as a mistake, not as scenery.
    if (sampleLandscape(x, z).mountain < MOUNTAIN_MIN_WEIGHT) return;
    const before = out.length;
    push('mountain', variant, x, z, salt);
    if (out.length === before) return; // dropped: origin clearing or water
    const p = out[out.length - 1]!;
    mountains.push({ x: p.x, z: p.z, r: (MOUNTAIN_FOOTPRINT[variant] ?? 0) * p.scale });
  };

  // ── mountains: a PRE-pass over the same cells ─────────────────────────
  // Landscape, not dressing. Placed before anything else so `underMountain`
  // is complete by the time the seeding loop reads it.
  for (let iz = -cells; iz <= cells && mountains.length < MOUNTAIN_MAX; iz++) {
    for (let ix = -cells; ix <= cells && mountains.length < MOUNTAIN_MAX; ix++) {
      const sample = land[cellAt(ix, iz)];
      if (!sample || sample.mountain < MOUNTAIN_MIN_WEIGHT) continue;
      const m = sample.mountain;
      const prob = MOUNTAIN_SEED_PROB * m * m * density * userMult('mountain');
      if (cellHash(ix, iz, MOUNTAIN_SALT) >= prob) continue;
      const { sx, sz } = seeds[cellAt(ix, iz)]!;
      const variant = Math.min(
        mountainCount - 1,
        Math.floor(cellHash(ix, iz, MOUNTAIN_SALT + 1.3) * mountainCount),
      );
      pushMountain(variant, sx, sz, 1);
      // 0–2 more summits at 1.2–2.2 steps: a range, never a lone cone.
      const extras = Math.floor(cellHash(ix, iz, MOUNTAIN_SALT + 2.6) * 3);
      for (let n = 0; n < extras; n++) {
        const a = cellHash(ix, iz, MOUNTAIN_SALT + 4.1 + n * 5.7) * Math.PI * 2;
        const r = (1.2 + cellHash(ix, iz, MOUNTAIN_SALT + 5.3 + n * 5.7)) * SCATTER_STEP;
        const v = Math.min(
          mountainCount - 1,
          Math.floor(cellHash(ix, iz, MOUNTAIN_SALT + 6.7 + n * 5.7) * mountainCount),
        );
        pushMountain(v, sx + Math.cos(a) * r, sz + Math.sin(a) * r, 2 + n);
      }
    }
  }

  for (let iz = -cells; iz <= cells; iz++) {
    for (let ix = -cells; ix <= cells; ix++) {
      const sample = land[cellAt(ix, iz)];
      // Water (plus its shore keep-out) seeds nothing — not even a tick.
      if (!sample) continue;
      const { sx, sz } = seeds[cellAt(ix, iz)]!;
      // Ground a mountain stands on is landscape, not planting soil.
      if (underMountain(sx, sz)) continue;
      const f = sample.forest;
      const m = sample.mountain;
      /**
       * The cell's probability for one kind. With f = m = 0 and no island
       * this collapses to EXACTLY the pre-map expression, so the open plain
       * is still the world that shipped.
       */
      const prob = (kind: ScatterKind): number => {
        const user = density * userMult(kind);
        // The island is its own flora list, not a blend over the plain.
        if (sample.island) return (ISLAND_SEED[kind] ?? 0) * user;
        const base = SEED_PROB[kind] * density * Math.max(0, kindDensity[kind] ?? 1);
        return (
          base * (1 - f) * (1 - m) +
          f * (FOREST_SEED[kind] ?? 0) * user +
          m * (MOUNTAIN_SEED[kind] ?? 0) * user
        );
      };
      // The island's own grove rule (see ISLAND_CLUSTER_SPREAD).
      const spread = sample.island ? ISLAND_CLUSTER_SPREAD : 1;
      const bonus = sample.island ? ISLAND_CLUSTER_EXTRAS : 0;
      // Tick layer: independent roll — ticks are ground texture, not props.
      if (cellHash(ix, iz, 1.1) < prob('tick')) {
        const extras = 1 + Math.floor(cellHash(ix, iz, 2.2) * 3) + bonus; // 2–4 (+island)
        cluster('tick', ix, iz, extras, spread);
      }
      // Prop layer: every kind rolls INDEPENDENTLY (own salt), so a per-kind
      // density change never moves another kind's placements. First passing
      // kind (in roll order) claims the cell — at most one cluster per cell,
      // and collisions are ~1e-4 rare at these probabilities. Neighbor count
      // hashes independently of the chosen kind (monotonicity).
      for (let k = 0; k < PROP_ROLL_ORDER.length; k++) {
        const kind = PROP_ROLL_ORDER[k]!;
        if (cellHash(ix, iz, 3.3 + k * 17.77) < prob(kind)) {
          if (kind === 'building') {
            if (buildings.length >= BUILDING_MAX) break;
            placeBuilding(ix, iz);
          } else if (kind === 'waterTower') {
            if (towers.length >= WATER_TOWER_MAX) break;
            placeWaterTower(ix, iz);
          } else if (kind === 'cactus' || kind === 'picnicTable') {
            cluster(kind, ix, iz, 0, spread); // sparse loners
          } else if (kind === 'monolith') {
            // Standing stones come mostly in pairs, sometimes alone.
            cluster(kind, ix, iz, cellHash(ix, iz, 4.4) < 0.65 ? 1 : 0, spread);
          } else {
            const extras = 1 + Math.floor(cellHash(ix, iz, 4.4) * 4) + bonus; // 1–4 (+island)
            cluster(kind, ix, iz, extras, spread);
          }
          break;
        }
      }
    }
  }

  // ── shoreline reeds ───────────────────────────────────────────────────
  // The shore's own texture, walked off the landscape's shore samples
  // rather than the iso grid: every pond gets a fringe, and the fringe
  // follows the drawn waterline instead of a lattice near it. Deterministic
  // in (sample index, body index) through the same cellHash family.
  const reedKeep = REED_SHORE_KEEP * density * userMult('reed');
  if (reedKeep > 0) {
    for (let b = 0; b < WATER_BODIES.length; b++) {
      const samples = shoreSamples(WATER_BODIES[b]!);
      for (let i = 0; i < samples.length; i++) {
        if (cellHash(i, b, REED_SALT) >= reedKeep) continue;
        const s = samples[i]!;
        // Step onto land along the shore normal, then let the water cut-out
        // in `place` drop anything still standing too near the edge.
        const off = REED_OFFSET_MIN + cellHash(i, b, REED_SALT + 1.7) * REED_OFFSET_SPAN;
        place(
          'reed',
          0,
          s.x + s.nx * off,
          s.z + s.nz * off,
          0.8 + cellHash(i, b, REED_SALT + 2.9) * 0.5,
          cellHash(i, b, REED_SALT + 4.3) * Math.PI * 2,
        );
      }
    }
  }
  return out;
}

// ── per-instance shape variation (pure) ──────────────────────────────────────
// "No two identical": beyond the authored variants, every placed instance
// deforms its silhouette a little — non-uniform scale, a slight lean, a
// low-frequency radial bulge/pinch — driven by a per-instance attribute
// seeded from the SAME placement hash family as position/scale/rotation, so
// the same world grows (and deforms) identically on every device. The
// amplitudes are deliberately subtle: a cottage still reads as that cottage
// variant, a conifer as that conifer — individuals, not random shapes.

/** Non-uniform scale jitter: ±7% on x/z, ±5% on y. */
export const VARIATION_SCALE_XZ = 0.07;
export const VARIATION_SCALE_Y = 0.05;
/** Height-weighted lean, radians (≈±2.5°). */
export const VARIATION_LEAN_RAD = 0.0436;
/** Low-frequency radial bulge/pinch, ±4%. */
export const VARIATION_BULGE = 0.04;

/** Rocks additionally squash flat and wide (instance-matrix bias): together
 * with their mid-tone albedo this separates a stone's low mass from the
 * egg's tall LIGHT ellipse — the user could not tell them apart. */
export const ROCK_SQUASH_Y = 0.82;
export const ROCK_WIDEN_XZ = 1.12;

/**
 * The four seeded variation channels for an instance at (x, z), each in
 * [0, 1): x-scale, z-scale, y-scale, and a phase channel (lean azimuth +
 * bulge phase + lean amount). Same quantized-position hash family as the
 * placement's own scale/rotation rolls — pure and deterministic.
 */
export function instanceVariation(x: number, z: number): [number, number, number, number] {
  const ix = Math.round(x * 8);
  const iz = Math.round(z * 8);
  return [
    cellHash(ix, iz, 61.7),
    cellHash(ix, iz, 62.9),
    cellHash(ix, iz, 63.3),
    cellHash(ix, iz, 64.1),
  ];
}

/**
 * Pure TS mirror of the vertex-stage variation (VARIATION_BEGIN_GLSL below):
 * scale → bulge → lean, in object space, before the instance matrix. Kept in
 * lockstep with the GLSL so the amplitude-bound tests measure the real
 * displacement law. `p` is an object-space vertex position.
 */
export function applyInstanceVariation(
  p: { x: number; y: number; z: number },
  v: readonly [number, number, number, number],
): { x: number; y: number; z: number } {
  const sx = 1 + (v[0] - 0.5) * 2 * VARIATION_SCALE_XZ;
  const sz = 1 + (v[1] - 0.5) * 2 * VARIATION_SCALE_XZ;
  const sy = 1 + (v[2] - 0.5) * 2 * VARIATION_SCALE_Y;
  let x = p.x * sx;
  const y = p.y * sy;
  let z = p.z * sz;
  const phase = v[3] * Math.PI * 2;
  const bulge = 1 + VARIATION_BULGE * Math.sin(y * 1.7 + phase * 3.0);
  x *= bulge;
  z *= bulge;
  const lean = (((v[3] * 7.13) % 1) - 0.5) * 2 * VARIATION_LEAN_RAD;
  const rise = Math.max(y, 0);
  x += Math.cos(phase) * lean * rise;
  z += Math.sin(phase) * lean * rise;
  return { x, y, z };
}

/** Placements outside every exclusion circle (strictly inside = hidden).
 *
 * Mountains are EXEMPT. The exclusion circles are a character's negative
 * space (TASTE §2.3) and hiding the dressing around a creature is the whole
 * point of them — but a mountain is landscape, and a mountain blinking out
 * because a creature wandered up to it would be absurd. */
export function filterExcluded(placements: Placement[], exclusions: Exclusion[]): Placement[] {
  if (exclusions.length === 0) return placements;
  return placements.filter((p) => {
    if (p.kind === 'mountain') return true;
    for (const e of exclusions) {
      const dx = p.x - e.x;
      const dz = p.z - e.z;
      if (dx * dx + dz * dz < e.r * e.r) return false;
    }
    return true;
  });
}

// ── colliders (hard/soft body physics) ───────────────────────────────────────
// One footprint circle per placed prop instance, for the physics/behavior
// layer (src/physics/). Hard bodies block (positional resolve + slide); the
// soft body — bush — damps a creature's speed and sways when brushed. Ticks
// are flat ink marks on the ground: no collider at all.
//
// Trees and conifers block at the TRUNK, not the crown: the canopy overhangs
// walkable ground, so their footprint is a small circle under the stem.
// Grounded kinds (rock/building/stump) block at their base extent (the
// variant's inflated footprint radius).

export type { Collider } from '../physics/colliders';

/** Fixed hard-footprint radius at instance scale 1, world units. Trunk
 * kinds (tree/conifer/palm) block small under an overhanging crown; the
 * built kinds carry authored footprints: cactus column, picnic table's
 * bench extent, the water tower's leg square, the monolith's base. */
export const TRUNK_FOOTPRINT: Partial<Record<PropKind, number>> = {
  tree: 0.65,
  conifer: 0.55,
  palm: 0.5,
  cactus: 0.6,
  picnicTable: 1.2,
  waterTower: 1.4,
  monolith: 1.6,
};

/** Soft bush footprint at instance scale 1, world units. */
export const BUSH_SOFT_FOOTPRINT = 1.0;

/**
 * Pure per-placement collider. `baseRadius` is the variant's inflated
 * footprint radius (grounded kinds use it); trunk kinds override it with
 * their trunk footprint. Returns null for the flat ink marks (ticks,
 * reeds). Mountains take the grounded path: they block at their base
 * extent, which is exactly what a mountain does.
 */
export function colliderFor(
  p: Placement,
  baseRadius: number,
  kindScaleMult = 1,
): Collider | null {
  if (isMark(p.kind)) return null;
  const s = p.scale * kindScaleMult;
  if (p.kind === 'bush') {
    return { x: p.x, z: p.z, r: BUSH_SOFT_FOOTPRINT * s, hard: false };
  }
  const trunk = TRUNK_FOOTPRINT[p.kind];
  // Rocks render widened (ROCK_WIDEN_XZ) — the collider follows the visual.
  const widen = p.kind === 'rock' ? ROCK_WIDEN_XZ : 1;
  return { x: p.x, z: p.z, r: (trunk ?? baseRadius) * s * widen, hard: true };
}

// ── tick geometry ────────────────────────────────────────────────────────────
// A grass tick is 2–3 tiny ink strokes: thin leaning quads in two crossing
// vertical planes so the mark reads from the iso camera at any y-rotation.
// NOT inflated 3D forms — they are flat marks, the drawn texture of the
// ground in the reference.

const TICK_BLADES: { rotY: number; lean: number; h: number; w: number }[] = [
  { rotY: 0.4, lean: -0.38, h: 0.55, w: 0.05 },
  { rotY: 1.35, lean: 0.22, h: 0.44, w: 0.045 },
  { rotY: 0.9, lean: 0.52, h: 0.36, w: 0.045 },
];

function buildTickGeometry(): BufferGeometry {
  const positions: number[] = [];
  for (const blade of TICK_BLADES) {
    const dirX = Math.cos(blade.rotY);
    const dirZ = -Math.sin(blade.rotY);
    // Base center at origin; top displaced along the blade plane by the lean.
    const topX = dirX * Math.sin(blade.lean) * blade.h;
    const topY = Math.cos(blade.lean) * blade.h;
    const topZ = dirZ * Math.sin(blade.lean) * blade.h;
    const hx = dirX * blade.w * 0.5;
    const hz = dirZ * blade.w * 0.5;
    // Two triangles: slightly tapered quad (narrower at the top — a pen
    // flick, not a rectangle).
    const t = 0.35;
    positions.push(
      -hx, 0, -hz, hx, 0, hz, topX + hx * t, topY, topZ + hz * t,
      -hx, 0, -hz, topX + hx * t, topY, topZ + hz * t, topX - hx * t, topY, topZ - hz * t,
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ── reed geometry ────────────────────────────────────────────────────────────
// A shoreline reed is the tick's tall cousin: three thin blades in crossing
// vertical planes, two of them carrying a cattail head just under the tip.
// Ink marks, not inflated forms — same unlit ink material and the same tick
// wind profile, so the fringe around a pond sways harder than the grass
// inland and the water reads as somewhere the weather touches.

const REED_BLADES: { rotY: number; lean: number; h: number; w: number; head: boolean }[] = [
  { rotY: 0.3, lean: -0.16, h: 1.45, w: 0.05, head: true },
  { rotY: 1.25, lean: 0.13, h: 1.2, w: 0.045, head: true },
  { rotY: 0.85, lean: 0.26, h: 1.1, w: 0.04, head: false },
];
/** Cattail head — a small ellipse of a few triangles, carried by the stem. */
const REED_HEAD_H = 0.28;
const REED_HEAD_W = 0.11;
const REED_HEAD_SEGMENTS = 7;

function buildReedGeometry(): BufferGeometry {
  const positions: number[] = [];
  for (const blade of REED_BLADES) {
    const dirX = Math.cos(blade.rotY);
    const dirZ = -Math.sin(blade.rotY);
    const topX = dirX * Math.sin(blade.lean) * blade.h;
    const topY = Math.cos(blade.lean) * blade.h;
    const topZ = dirZ * Math.sin(blade.lean) * blade.h;
    const hx = dirX * blade.w * 0.5;
    const hz = dirZ * blade.w * 0.5;
    // Reeds taper less than grass: a standing stem, not a pen flick.
    const t = 0.55;
    positions.push(
      -hx, 0, -hz, hx, 0, hz, topX + hx * t, topY, topZ + hz * t,
      -hx, 0, -hz, topX + hx * t, topY, topZ + hz * t, topX - hx * t, topY, topZ - hz * t,
    );
    if (!blade.head) continue;
    // Fan ellipse in the blade's OWN plane, centered just below the tip, so
    // the head always reads as carried by that stem — never floating.
    const cy = topY - REED_HEAD_H * 0.55;
    const k = cy / topY;
    const cx = topX * k;
    const cz = topZ * k;
    for (let i = 0; i < REED_HEAD_SEGMENTS; i++) {
      const a0 = (i / REED_HEAD_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / REED_HEAD_SEGMENTS) * Math.PI * 2;
      const rim = (a: number): number[] => [
        cx + dirX * Math.cos(a) * REED_HEAD_W * 0.5,
        cy + Math.sin(a) * REED_HEAD_H * 0.5,
        cz + dirZ * Math.cos(a) * REED_HEAD_W * 0.5,
      ];
      positions.push(cx, cy, cz, ...rim(a0), ...rim(a1));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ── wind (environment physics) ───────────────────────────────────────────────
// Per-vertex wind in the shared scatter materials, injected via
// onBeforeCompile. This REPLACES the old whole-group sampleDrift sway: the
// group transform is now identity and the always-on motion the stillness
// probe requires comes from these gusts instead — value noise never sits
// still, and the strength floor below keeps it from ever reaching zero.
//
// Motion law (TASTE §2.1): gusts are smooth 2-octave value noise — no
// jitter, no shiver, nothing linear. Displacement bends vertices by height
// fraction squared (roots pinned, crowns sway) along the wind direction,
// plus a small perpendicular flutter. Rigid kinds (building, rock, stump,
// picnicTable, waterTower, monolith) get NO injection at all — stone and
// timber don't lean with the weather.

/** Kinds whose foliage bends in the wind. Everything else is rigid. Palms
 * sway hardest (drooping fronds); cacti barely register a gust. */
export const WIND_SWAY_KINDS: readonly PropKind[] = [
  'tree',
  'conifer',
  'bush',
  'palm',
  'cactus',
];

/** setWind clamps into this range. The floor keeps the world breathing —
 * nothing ever fully still (TASTE §3) — the cap keeps it composed. */
export const WIND_STRENGTH_MIN = 0.05;
export const WIND_STRENGTH_MAX = 1.5;

export function clampWindStrength(v: number): number {
  if (!Number.isFinite(v)) return WIND_STRENGTH_MIN;
  return Math.min(WIND_STRENGTH_MAX, Math.max(WIND_STRENGTH_MIN, v));
}

/** The wind heading wanders over ~6 ambient periods (~22s) so gusts drift
 * around the compass instead of pumping one axis forever. */
export const WIND_AZIMUTH_PERIOD_MS = MOTION.ambientMs * 6;

/** Deterministic hash → [0, 1). Same recipe family as motion/ambient. */
function windHash01(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

/** 1D value noise in [-1, 1] — smoothstep between hashed lattice points. */
function windValueNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = windHash01(i * 127.1 + seed * 311.7);
  const b = windHash01((i + 1) * 127.1 + seed * 311.7);
  return (a + (b - a) * u) * 2 - 1;
}

const WIND_AZIMUTH_SEED = 41.7;

/** Slow-drifting wind heading (radians), pure in nowMs — deterministic, so
 * two devices see the same weather lean the same way. Two octaves keep the
 * wander organic without ever snapping. */
export function windAzimuth(nowMs: number): number {
  const t = nowMs / WIND_AZIMUTH_PERIOD_MS;
  return (
    (windValueNoise(t, WIND_AZIMUTH_SEED) * 0.75 +
      windValueNoise(t * 0.37 + 11.3, WIND_AZIMUTH_SEED + 1) * 0.45) *
    Math.PI
  );
}

/** Amplitude/frequency recipe baked into a material's injected GLSL. */
interface WindProfile {
  /** Lean amplitude in radians at strength 1 (the gust envelope's mean). */
  bend: number;
  /** Gust noise frequency, Hz — kept near the ambient period. */
  gustHz: number;
  /** Perpendicular flutter amplitude in radians at strength 1. */
  flutter: number;
  flutterHz: number;
  /** Per-instance detune (seconds) hashed from instance position, so
   * neighbors move coherently but never identically. */
  phaseJitter: number;
  /** GLSL factor multiplying position.y into the displacement: trees use
   * their aWindHeight attribute (→ heightFrac², roots pinned, crowns sway);
   * ticks use 1.0 (full-blade bend pivoting at the root). */
  heightExpr: string;
}

/** Trees / conifers / bushes: slow crown sway, small amplitude — the gust
 * envelope spans ~0°–2.9° at strength 1 (≈1.4° mean), trunks nearly still
 * because displacement scales with heightFrac². Most of the amplitude is in
 * the gust (0.45 + 0.55·g below), not a static lean, so the crowns visibly
 * breathe instead of holding one bent pose. */
const WIND_PROFILE_SWAY: WindProfile = {
  bend: 0.05,
  gustHz: 0.38,
  flutter: 0.016,
  flutterHz: 0.7,
  phaseJitter: 1.6,
  heightExpr: 'aWindHeight',
};

/** Grass ticks: tiny marks, so they carry the wind read — ~2× the trees'
 * angular sway with a quicker (still smooth) flutter. */
const WIND_PROFILE_TICK: WindProfile = {
  bend: 0.1,
  gustHz: 0.7,
  flutter: 0.07,
  flutterHz: 1.5,
  phaseJitter: 2.4,
  heightExpr: '1.0',
};

/** Palms: the fronds carry the strongest sway in the frame — over twice
 * the trees' bend with a livelier (still smooth) flutter. heightFrac²
 * keeps the trunk base near-still while the crown rides the gust. */
const WIND_PROFILE_PALM: WindProfile = {
  bend: 0.11,
  gustHz: 0.45,
  flutter: 0.045,
  flutterHz: 0.9,
  phaseJitter: 1.9,
  heightExpr: 'aWindHeight',
};

/** Cacti: barely — a column of water hardly acknowledges the gust, but the
 * stillness floor never lets it freeze entirely. */
const WIND_PROFILE_CACTUS: WindProfile = {
  bend: 0.008,
  gustHz: 0.3,
  flutter: 0.003,
  flutterHz: 0.5,
  phaseJitter: 1.2,
  heightExpr: 'aWindHeight',
};

const glslFloat = (v: number): string => v.toFixed(5);

/** Top-level declarations appended after <common>. */
function windCommonGlsl(declareHeightAttr: boolean): string {
  return `
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
${declareHeightAttr ? 'attribute float aWindHeight;' : ''}
float windHash(float n) { return fract(sin(n) * 43758.5453123); }
float windNoise(float t, float seed) {
  float i = floor(t);
  float f = t - i;
  float u = f * f * (3.0 - 2.0 * f);
  float a = windHash(i * 127.1 + seed * 311.7);
  float b = windHash((i + 1.0) * 127.1 + seed * 311.7);
  return (a + (b - a) * u) * 2.0 - 1.0;
}
`;
}

/** begin_vertex replacement: smooth value-noise gusts keyed on the instance's
 * world position (a wave traveling downwind, so neighbors lean together a
 * beat apart), bending vertices along the wind + a small perpendicular
 * flutter. Displacement is computed in world axes and rotated back into
 * object space through the instance matrix (transpose ≙ inverse rotation),
 * normalized so the sway angle is scale-consistent across instance sizes. */
function windBeginGlsl(p: WindProfile): string {
  return `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
  vec2 windCell = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  mat3 windRot = mat3(instanceMatrix);
  float windS2 = max(dot(windRot[0], windRot[0]), 1e-6);
  #else
  vec2 windCell = vec2(0.0);
  mat3 windRot = mat3(1.0);
  float windS2 = 1.0;
  #endif
  float windPhase = dot(windCell, uWindDir) * -0.05
    + windHash(dot(windCell, vec2(127.1, 311.7))) * ${glslFloat(p.phaseJitter)};
  float windT = uWindTime * ${glslFloat(p.gustHz)} + windPhase;
  float windGust = 0.72 * windNoise(windT, 17.3) + 0.28 * windNoise(windT * 2.3 + 5.1, 29.7);
  float windBend = ${glslFloat(p.bend)} * uWindStrength * (0.45 + 0.55 * windGust);
  float windFlut = ${glslFloat(p.flutter)} * uWindStrength
    * windNoise(uWindTime * ${glslFloat(p.flutterHz)} + windPhase * 1.7, 47.9);
  vec2 windLean = uWindDir * windBend + vec2(-uWindDir.y, uWindDir.x) * windFlut;
  vec3 windWorld = vec3(windLean.x, 0.0, windLean.y) * (${p.heightExpr} * position.y);
  transformed += (windWorld * windRot) * inversesqrt(windS2);
}`;
}

// ── per-instance shape variation (GLSL) ──────────────────────────────────────
// The shader half of applyInstanceVariation — keep the two in lockstep. Runs
// at the head of the begin_vertex chain (in object space, before the wind /
// nudge displacements and the instance matrix), so every kind — buildings,
// rocks, stumps, bushes, trees, conifers, ticks — gets it, and the swaying
// kinds compose it with their wind cleanly.

function variationBeginGlsl(): string {
  return `#include <begin_vertex>
{
  transformed *= vec3(
    1.0 + (aVariation.x - 0.5) * ${glslFloat(2 * VARIATION_SCALE_XZ)},
    1.0 + (aVariation.z - 0.5) * ${glslFloat(2 * VARIATION_SCALE_Y)},
    1.0 + (aVariation.y - 0.5) * ${glslFloat(2 * VARIATION_SCALE_XZ)});
  float varPhase = aVariation.w * 6.2831853;
  float varBulge = 1.0 + ${glslFloat(VARIATION_BULGE)} * sin(transformed.y * 1.7 + varPhase * 3.0);
  transformed.xz *= varBulge;
  float varLean = (fract(aVariation.w * 7.13) - 0.5) * ${glslFloat(2 * VARIATION_LEAN_RAD)};
  transformed.xz += vec2(cos(varPhase), sin(varPhase)) * (varLean * max(transformed.y, 0.0));
}`;
}

// ── instanced assembly ───────────────────────────────────────────────────────

/** Just proud of the ground; under the creature shadows' 0.02 lift. */
const PROP_SHADOW_LIFT = 0.018;
const TICK_LIFT = 0.015;
/** Shadow stamp sits a touch inside the footprint, like the creatures'. */
export const SHADOW_FIT = 0.8;
/** No stamp beyond this radius: the walled courtyard's footprint would
 * flood its own open interior with one giant disc — a building that large
 * is its own ground figure. */
export const SHADOW_MAX_RADIUS = 4;

/** Re-lay the instanced shadow matrices only when the sun has moved beyond
 * ~1° in azimuth or altitude — it glides slowly, so most frames are just the
 * (cheap) shared material-value update. */
export const SHADOW_SUN_EPS = Math.PI / 180;

export interface Scatter {
  group: Group;
  /** Currently visible props, for behavior affordances. The flat ink
   * marks (ticks, reeds) are not props and never appear here. */
  positions(): { x: number; z: number; kind: PropKind; r: number }[];
  /** Hide instances inside the circles. Rebuilds visibility on call. */
  setExclusions(points: Exclusion[]): void;
  /** Rebuild with a global density multiplier (dev panel). */
  setDensity(mult: number): void;
  /** Re-roll placement from a new seed — a different world, same rules. */
  setSeed(seed: number): void;
  /** Per-kind density multiplier, layered on the global one. Independent per
   * kind: changing one kind never moves another kind's placements. */
  setKindDensity(kind: ScatterKind, mult: number): void;
  /** Per-kind uniform scale multiplier on every instance of the kind. */
  setKindScale(kind: ScatterKind, mult: number): void;
  /**
   * Sun-drive the instanced shadow discs (same ellipse system as
   * FlatShadows — stretched away from the sun's azimuth, one shared flat
   * value). Call once per frame: the material value updates cheaply every
   * call; instance matrices only re-lay when azimuth/altitude have moved
   * beyond SHADOW_SUN_EPS (~1°).
   */
  setSun(azimuth: number, altitude: number, presence: number): void;
  /**
   * Drive the vertex wind. Call once per frame with the environment's live
   * (spring-glided) wind strength and the frame time; strength is clamped to
   * [WIND_STRENGTH_MIN, WIND_STRENGTH_MAX] and the heading drifts on its own
   * via windAzimuth(timeMs). Three uniform writes — no matrix re-uploads.
   */
  setWind(strength: number, timeMs: number): void;
  /** Live wind values (dev panel / tests). */
  windState(): { strength: number; azimuth: number; timeMs: number };
  /**
   * Physics colliders for the currently visible props: hard bodies block,
   * soft bodies (bush) damp + sway; the ink marks have none. The
   * landscape's water circles are appended after them — water blocks
   * creatures, and it rides this cache so consumers keep ONE spatial index.
   * Cached — rebuilt lazily after placements/exclusions/scales change.
   * Consumers key their spatial index on collidersVersion() and re-query
   * only when it moves.
   */
  colliders(): Collider[];
  /** Bumps whenever the collider set may have changed. */
  collidersVersion(): number;
  /**
   * Soft-body brush: kick a brief localized sway impulse into swaying
   * instances near (x, z) — the visible read of a creature pushing through
   * a bush. Strength ~[0, 1]; decays on its own (~1s smooth pulse).
   */
  nudge(x: number, z: number, strength: number): void;
  /** Live nudge slots (tests / dev panel). */
  nudgeState(): { x: number; z: number; strength: number; t0: number }[];
  /**
   * Dev color grade: tint every prop albedo by hue [0,1) and saturation
   * [0,1], keeping each material's token lightness so the value structure
   * (and the toon bands downstream) never move. Saturation 0 restores the
   * exact achromatic tokens. Shadow stamps are deliberately excluded — the
   * sun re-derives their one flat value every frame.
   */
  setTint(hue: number, saturation: number): void;
  /** Live tint values (dev panel / tests). */
  tintState(): { hue: number; saturation: number };
  dispose(): void;
}

/** Scene-outliner labels for the per-kind container groups (user ask: ONE
 * row per kind — "all the trees in the scene should be one object"). */
/**
 * Shipped per-kind density defaults (panel export, user ask). Only the
 * wooded kinds differ from 1: the world reads as open field with sparse
 * groves rather than forest. Every one stays a live panel slider.
 */
export const DEFAULT_KIND_DENSITY: Partial<Record<ScatterKind, number>> = {
  tree: 0.15,
  conifer: 0.15,
};

export const KIND_GROUP_LABELS: Record<ScatterKind, string> = {
  tree: 'trees',
  conifer: 'conifers',
  rock: 'rocks',
  building: 'buildings',
  bush: 'bushes',
  stump: 'stumps',
  palm: 'palms',
  cactus: 'cacti',
  monolith: 'monoliths',
  picnicTable: 'picnic tables',
  waterTower: 'water towers',
  mountain: 'mountains',
  tick: 'grass',
  reed: 'reeds',
};

export function createScatter(): Scatter {
  const group = new Group();
  // One named container group per kind, created up front and never removed:
  // the outliner row is stable even at density zero, so the kind stays
  // clickable as a controller. Variant meshes live inside their kind group;
  // only the shadow stamps stay directly on the root.
  const kindGroups = new Map<ScatterKind, Group>();
  for (const kind of Object.keys(KIND_GROUP_LABELS) as ScatterKind[]) {
    const g = new Group();
    g.name = KIND_GROUP_LABELS[kind];
    kindGroups.set(kind, g);
    group.add(g);
  }
  const groupFor = (kind: ScatterKind): Group => kindGroups.get(kind) ?? group;
  const geometries = buildPropGeometries();

  const variantOf = (p: Placement) => geometries.get(p.kind as PropKind)![p.variant]!;

  // Light paper albedo, fully matte — the ink pass draws the form. Never a
  // grey mass (GENERATOR §ink rendering pass). Rigid kinds (building, stump,
  // picnicTable, waterTower) render with this stock material: no wind
  // injection at all.
  const propMaterial = new MeshStandardMaterial({
    color: WORLD.light,
    roughness: 1,
    metalness: 0,
  });
  // Rocks (and monoliths) step down to the MID band: eggs are the palette's
  // light role and must be the only light-shelled lumps on the field (user
  // report: light rocks read as eggs). Mid-tone stone masses.
  const rockMaterial = new MeshStandardMaterial({
    color: WORLD.neutral,
    roughness: 1,
    metalness: 0,
  });
  // Swaying kinds share the same look plus the vertex wind.
  const swayMaterial = new MeshStandardMaterial({
    color: WORLD.light,
    roughness: 1,
    metalness: 0,
  });
  // Palms carry their own (stronger) wind — and thin frond blades need both
  // faces drawn.
  const palmMaterial = new MeshStandardMaterial({
    color: WORLD.light,
    roughness: 1,
    metalness: 0,
    side: DoubleSide,
  });
  // Cacti barely sway — their own near-still wind profile.
  const cactusMaterial = new MeshStandardMaterial({
    color: WORLD.light,
    roughness: 1,
    metalness: 0,
  });
  // Ticks are unlit ink marks — the only dark the environment carries.
  const tickMaterial = new MeshBasicMaterial({ color: WORLD.ink, side: DoubleSide });

  // Dev color grade (see Scatter.setTint): the tintable albedos and each
  // one's token lightness, captured once so re-tints never drift.
  const gradedMaterials = [
    propMaterial,
    rockMaterial,
    swayMaterial,
    palmMaterial,
    cactusMaterial,
    tickMaterial,
  ];
  const gradeLightness = gradedMaterials.map((m) => {
    const hsl = { h: 0, s: 0, l: 0 };
    m.color.getHSL(hsl);
    return hsl.l;
  });
  let tintHue = 0;
  let tintSaturation = 0;

  // One shared uniform set drives every wind-injected material; setWind is
  // three value writes, never a recompile.
  const windUniforms = {
    uWindTime: { value: 0 },
    uWindDir: { value: new Vector2(1, 0) },
    uWindStrength: { value: WIND_STRENGTH_MIN },
  };
  let windTimeMs = 0;

  const injectWind = (
    material: MeshStandardMaterial | MeshBasicMaterial,
    profile: WindProfile,
    cacheKey: string,
  ): void => {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, windUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\n${windCommonGlsl(profile.heightExpr === 'aWindHeight')}`,
        )
        .replace('#include <begin_vertex>', windBeginGlsl(profile));
    };
    // The injected chunks change the program — never share a cache slot with
    // the stock material.
    material.customProgramCacheKey = () => cacheKey;
  };
  injectWind(swayMaterial, WIND_PROFILE_SWAY, 'scatter-wind-sway-v1');
  injectWind(tickMaterial, WIND_PROFILE_TICK, 'scatter-wind-tick-v1');
  injectWind(palmMaterial, WIND_PROFILE_PALM, 'scatter-wind-palm-v1');
  injectWind(cactusMaterial, WIND_PROFILE_CACTUS, 'scatter-wind-cactus-v1');

  // ── soft-body nudge impulses (colliders section) ─────────────────────────
  // [seam: wind agent] A creature brushing through a bush kicks a brief
  // localized sway. This is a SECOND, additive onBeforeCompile wrap on the
  // sway material's chain: the wind injection above runs first, then this
  // wrap appends its own uniforms and begin_vertex block (the wind block's
  // replacement keeps the literal `#include <begin_vertex>` at its head, so
  // this block lands beside it — both displace `transformed`). Impulses
  // decay in-shader against uWindTime (seconds, driven by setWind), so a
  // nudge needs no per-frame CPU upkeep. Wind agent: keep this wrap AFTER
  // the injectWind calls and keep uWindTime in seconds.
  const NUDGE_SLOTS = 8;
  /** World-unit falloff radius around the brush point. */
  const NUDGE_RADIUS = 2.5;
  /** Re-kick cadence while pushing through (past the pulse crest). */
  const NUDGE_REKICK_S = 0.45;
  // Slot layout: x, y = world x/z of the brush; z = strength; w = t0 (s).
  const nudgeUniforms = {
    uNudge: { value: Array.from({ length: NUDGE_SLOTS }, () => new Vector4()) },
  };
  let nudgeCursor = 0;

  const nudgeBeginGlsl = `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
  vec2 nudgeCell = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  mat3 nudgeRot = mat3(instanceMatrix);
  float nudgeS2 = max(dot(nudgeRot[0], nudgeRot[0]), 1e-6);
  #else
  vec2 nudgeCell = vec2(0.0);
  mat3 nudgeRot = mat3(1.0);
  float nudgeS2 = 1.0;
  #endif
  vec2 nudgeLean = vec2(0.0);
  for (int i = 0; i < ${NUDGE_SLOTS}; i++) {
    float nudgeStr = uNudge[i].z;
    vec2 nudgeD = nudgeCell - uNudge[i].xy;
    float nudgeDist = length(nudgeD);
    float nudgeFall = 1.0 - smoothstep(0.0, ${glslFloat(NUDGE_RADIUS)}, nudgeDist);
    float nudgeAge = max(uWindTime - uNudge[i].w, 0.0);
    float nudgeEnv = (nudgeAge * 4.0) * exp(1.0 - nudgeAge * 4.0);
    nudgeLean += (nudgeD / max(nudgeDist, 1e-4))
      * (nudgeStr * nudgeFall * nudgeEnv * 0.22);
  }
  vec3 nudgeWorld = vec3(nudgeLean.x, 0.0, nudgeLean.y) * (aWindHeight * position.y);
  transformed += (nudgeWorld * nudgeRot) * inversesqrt(nudgeS2);
}`;

  const windSwayCompile = swayMaterial.onBeforeCompile;
  swayMaterial.onBeforeCompile = (shader, renderer): void => {
    windSwayCompile(shader, renderer);
    Object.assign(shader.uniforms, nudgeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uNudge[${NUDGE_SLOTS}];`)
      .replace('#include <begin_vertex>', nudgeBeginGlsl);
  };
  const windSwayKey = swayMaterial.customProgramCacheKey.bind(swayMaterial);
  swayMaterial.customProgramCacheKey = (): string => `${windSwayKey()}+nudge-v1`;

  // ── per-instance shape variation (see the pure section up top) ────────────
  // Chained onto each material's EXISTING onBeforeCompile (wind agent seam:
  // never clobber the chain). Each replacement keeps the literal
  // `#include <begin_vertex>` at its head, so wrapping LAST lands this block
  // FIRST in the shader source — the variation deforms the object-space form
  // before the wind/nudge displacements add on top. ALL kinds carry it:
  // rigid (building / rock / stump), swaying (tree / conifer / bush), ticks.
  const chainVariation = (
    material: MeshStandardMaterial | MeshBasicMaterial,
    cacheKey?: string,
  ): void => {
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer): void => {
      previous.call(material, shader, renderer);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aVariation;')
        .replace('#include <begin_vertex>', variationBeginGlsl());
    };
    if (cacheKey !== undefined) {
      // The rigid material had the stock program until now — give it a key.
      material.customProgramCacheKey = (): string => cacheKey;
    } else {
      const previousKey = material.customProgramCacheKey.bind(material);
      material.customProgramCacheKey = (): string => `${previousKey()}+variation-v1`;
    }
  };
  chainVariation(propMaterial, 'scatter-prop-variation-v1');
  chainVariation(rockMaterial, 'scatter-rock-variation-v1');
  chainVariation(swayMaterial);
  chainVariation(tickMaterial);
  chainVariation(palmMaterial);
  chainVariation(cactusMaterial);

  // Bake the height-fraction attribute the sway shader bends by. Rigid kinds
  // deliberately never get this attribute (taste guard: tests assert it).
  const swayKindSet = new Set<PropKind>(WIND_SWAY_KINDS);
  for (const kind of WIND_SWAY_KINDS) {
    for (const variant of geometries.get(kind)!) {
      const position = variant.geometry.getAttribute('position');
      const heights = new Float32Array(position.count);
      for (let i = 0; i < position.count; i++) {
        heights[i] = Math.min(Math.max(position.getY(i) / variant.height, 0), 1);
      }
      variant.geometry.setAttribute('aWindHeight', new BufferAttribute(heights, 1));
    }
  }
  // Flat stamped shadow discs, one hard value (TASTE §2.4). The sun retints
  // the ONE shared value (toward the ground as presence falls) and reshapes
  // the shared ellipse — the fill itself never gradates.
  const shadowMaterial = new MeshBasicMaterial({
    color: SURFACE.shadow,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const shadowGroundValue = new Color(SURFACE.ground);
  const shadowInkValue = new Color(SURFACE.shadow);

  const tickGeometry = buildTickGeometry();
  const reedGeometry = buildReedGeometry();
  const shadowGeometry = new CircleGeometry(1, 40);
  shadowGeometry.rotateX(-Math.PI / 2);

  // Sun-driven shadow ellipse, shared by every instanced disc. null = the
  // noon circle (identical to the static layout). Matrices re-lay only when
  // the sun moves beyond SHADOW_SUN_EPS.
  let sunEllipse: StampEllipse | null = null;
  let sunAzimuth = Number.NaN;
  let sunAltitude = Number.NaN;
  let shadowMesh: InstancedMesh | null = null;
  let shadowSpots: { x: number; z: number; r: number }[] = [];

  let globalDensity = 1;
  const kindDensity: Partial<Record<ScatterKind, number>> = { ...DEFAULT_KIND_DENSITY };
  const kindScale: Partial<Record<ScatterKind, number>> = {};
  let placements = computePlacements();
  let exclusions: Exclusion[] = [];
  let meshes: InstancedMesh[] = [];

  // Collider cache — invalidated by rebuild() (every placement / exclusion /
  // scale mutation funnels through it), rebuilt lazily on colliders().
  let colliderCache: Collider[] | null = null;
  let colliderVersion = 0;

  const scaleOf = (kind: ScatterKind): number => Math.max(0, kindScale[kind] ?? 1);

  function replace(): void {
    placements = computePlacements({ density: globalDensity, kindDensity });
  }

  const matrix = new Matrix4();
  const quat = new Quaternion();
  const axisY = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scl = new Vector3();

  function clearMeshes(): void {
    for (const mesh of meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    meshes = [];
    shadowMesh = null;
    shadowSpots = [];
  }

  /** Write every shadow-disc instance matrix from the current sun ellipse:
   * long axis r×stretch along the away-from-sun direction, short axis r,
   * center pushed away from the sun by offset×r. Circle when the sun is at
   * the noon reference (or before the first setSun). */
  function layShadows(): void {
    if (!shadowMesh) return;
    const e = sunEllipse;
    if (e) quat.setFromAxisAngle(axisY, stampRotationY(e));
    else quat.identity();
    for (let i = 0; i < shadowSpots.length; i++) {
      const s = shadowSpots[i]!;
      const push = e ? e.offset * s.r : 0;
      pos.set(
        s.x + (e ? e.dirX * push : 0),
        PROP_SHADOW_LIFT,
        s.z + (e ? e.dirZ * push : 0),
      );
      scl.set(s.r * (e ? e.stretch : 1), 1, s.r);
      shadowMesh.setMatrixAt(i, matrix.compose(pos, quat, scl));
    }
    shadowMesh.instanceMatrix.needsUpdate = true;
  }

  /** Rebuild every InstancedMesh from placements minus exclusions. Runs on
   * setExclusions / setDensity calls only — never per frame. */
  function rebuild(): void {
    clearMeshes();
    // Colliders track visible placements: drop the cache, bump the version.
    colliderCache = null;
    colliderVersion++;
    const visible = filterExcluded(placements, exclusions);

    // One InstancedMesh per (kind, variant) — ~30 draws total.
    for (const kind of PROP_KINDS) {
      const variants = geometries.get(kind)!;
      for (let v = 0; v < variants.length; v++) {
        const of = visible.filter((p) => p.kind === kind && p.variant === v);
        if (of.length === 0) continue;
        const material =
          kind === 'rock' || kind === 'monolith'
            ? rockMaterial
            : kind === 'palm'
              ? palmMaterial
              : kind === 'cactus'
                ? cactusMaterial
                : swayKindSet.has(kind)
                  ? swayMaterial
                  : propMaterial;
        const mesh = new InstancedMesh(variants[v]!.geometry, material, of.length);
        // Named so the ghost-panel scene outliner represents environment
        // objects legibly, like it does each created character (user ask).
        // The `kind-` prefix stays machine-parseable (tests split on it).
        mesh.name = `${kind}-${v + 1} (${of.length})`;
        mesh.frustumCulled = false;
        const kMult = scaleOf(kind);
        // Rocks squash flat and wide — the anti-egg silhouette bias.
        const widenXZ = kind === 'rock' ? ROCK_WIDEN_XZ : 1;
        const squashY = kind === 'rock' ? ROCK_SQUASH_Y : 1;
        // Per-instance shape variation, seeded from the placement hash —
        // rebuilt alongside the matrices so attribute rows always pair with
        // their instances.
        const variation = new Float32Array(of.length * 4);
        of.forEach((p, i) => {
          quat.setFromAxisAngle(axisY, p.rotY);
          pos.set(p.x, 0, p.z);
          scl.set(p.scale * kMult * widenXZ, p.scale * kMult * squashY, p.scale * kMult * widenXZ);
          mesh.setMatrixAt(i, matrix.compose(pos, quat, scl));
          variation.set(instanceVariation(p.x, p.z), i * 4);
        });
        mesh.geometry.setAttribute('aVariation', new InstancedBufferAttribute(variation, 4));
        mesh.instanceMatrix.needsUpdate = true;
        meshes.push(mesh);
        groupFor(kind).add(mesh);
      }
    }

    const ticks = visible.filter((p) => p.kind === 'tick');
    if (ticks.length > 0) {
      const mesh = new InstancedMesh(tickGeometry, tickMaterial, ticks.length);
      mesh.name = `grass (${ticks.length})`;
      mesh.frustumCulled = false;
      const tickMult = scaleOf('tick');
      // Ticks ride the same variation path — for them it reads as blade
      // length / bend jitter.
      const variation = new Float32Array(ticks.length * 4);
      ticks.forEach((p, i) => {
        quat.setFromAxisAngle(axisY, p.rotY);
        pos.set(p.x, TICK_LIFT, p.z);
        scl.setScalar(p.scale * tickMult);
        mesh.setMatrixAt(i, matrix.compose(pos, quat, scl));
        variation.set(instanceVariation(p.x, p.z), i * 4);
      });
      mesh.geometry.setAttribute('aVariation', new InstancedBufferAttribute(variation, 4));
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
      groupFor('tick').add(mesh);
    }

    // Reeds: the same ink material and wind profile as the grass, their own
    // taller geometry, their own outliner row.
    const reeds = visible.filter((p) => p.kind === 'reed');
    if (reeds.length > 0) {
      const mesh = new InstancedMesh(reedGeometry, tickMaterial, reeds.length);
      mesh.name = `reeds (${reeds.length})`;
      mesh.frustumCulled = false;
      const reedMult = scaleOf('reed');
      const variation = new Float32Array(reeds.length * 4);
      reeds.forEach((p, i) => {
        quat.setFromAxisAngle(axisY, p.rotY);
        pos.set(p.x, TICK_LIFT, p.z);
        scl.setScalar(p.scale * reedMult);
        mesh.setMatrixAt(i, matrix.compose(pos, quat, scl));
        variation.set(instanceVariation(p.x, p.z), i * 4);
      });
      mesh.geometry.setAttribute('aVariation', new InstancedBufferAttribute(variation, 4));
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
      groupFor('reed').add(mesh);
    }

    // One shadow disc per large/medium prop — the flat ink marks get none,
    // and a mountain's footprint is far past SHADOW_MAX_RADIUS so the
    // filter below drops it too (a mountain is its own ground figure).
    // Matrices are laid by layShadows from the current sun ellipse.
    const shadowed = visible.filter((p) => !isMark(p.kind));
    const spots = shadowed
      .map((p) => ({
        x: p.x,
        z: p.z,
        r:
          variantOf(p).radius *
          p.scale *
          scaleOf(p.kind) *
          (p.kind === 'rock' ? ROCK_WIDEN_XZ : 1) *
          SHADOW_FIT,
      }))
      .filter((s) => s.r <= SHADOW_MAX_RADIUS);
    if (spots.length > 0) {
      const mesh = new InstancedMesh(shadowGeometry, shadowMaterial, spots.length);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      shadowSpots = spots;
      shadowMesh = mesh;
      meshes.push(mesh);
      group.add(mesh);
      layShadows();
    }
  }

  rebuild();

  return {
    group,
    positions() {
      return filterExcluded(placements, exclusions)
        .filter((p) => !isMark(p.kind))
        .map((p) => ({
          x: p.x,
          z: p.z,
          kind: p.kind as PropKind,
          r:
            variantOf(p).radius *
            p.scale *
            scaleOf(p.kind) *
            (p.kind === 'rock' ? ROCK_WIDEN_XZ : 1),
        }));
    },
    setExclusions(points: Exclusion[]): void {
      exclusions = points;
      rebuild();
    },
    setDensity(mult: number): void {
      globalDensity = mult;
      replace();
      rebuild();
    },
    setSeed(seed: number): void {
      setScatterSeed(seed);
      replace();
      rebuild();
    },
    setKindDensity(kind: ScatterKind, mult: number): void {
      kindDensity[kind] = mult;
      replace();
      rebuild();
    },
    setKindScale(kind: ScatterKind, mult: number): void {
      kindScale[kind] = mult;
      rebuild();
    },
    setSun(azimuth: number, altitude: number, presence: number): void {
      // The one flat value every stamp shares this frame — presence 0 lands
      // exactly on the ground value (invisible; night/storm).
      shadowMaterial.color
        .copy(shadowGroundValue)
        .lerp(shadowInkValue, Math.min(1, Math.max(0, presence)));
      // Throttled shape update: NaN sentinels force the first lay.
      const moved =
        !(Math.abs(azimuth - sunAzimuth) < SHADOW_SUN_EPS) ||
        !(Math.abs(altitude - sunAltitude) < SHADOW_SUN_EPS);
      if (!moved) return;
      sunAzimuth = azimuth;
      sunAltitude = altitude;
      sunEllipse = stampEllipse(azimuth, altitude);
      layShadows();
    },
    // NOTE: the old whole-group sampleDrift sway (position + rotation.y on
    // `group`) is gone — the per-vertex wind below is what keeps the scatter
    // off the stillness probe now, and it does it in-material instead of
    // nudging thousands of instances through one shared transform.
    setWind(strength: number, timeMs: number): void {
      windTimeMs = timeMs;
      windUniforms.uWindStrength.value = clampWindStrength(strength);
      windUniforms.uWindTime.value = timeMs / 1000;
      const azimuth = windAzimuth(timeMs);
      windUniforms.uWindDir.value.set(Math.cos(azimuth), Math.sin(azimuth));
    },
    windState(): { strength: number; azimuth: number; timeMs: number } {
      return {
        strength: windUniforms.uWindStrength.value,
        azimuth: windAzimuth(windTimeMs),
        timeMs: windTimeMs,
      };
    },
    colliders(): Collider[] {
      if (!colliderCache) {
        colliderCache = [];
        for (const p of filterExcluded(placements, exclusions)) {
          if (isMark(p.kind)) continue;
          const c = colliderFor(p, variantOf(p).radius, scaleOf(p.kind));
          if (c) colliderCache.push(c);
        }
        // Water blocks creatures. The landscape's circles are static (the
        // lake's is a RING, left open at the land bridge so the island stays
        // walkable), but they ride the same cache so consumers keep ONE
        // spatial index keyed on collidersVersion(). Appended LAST, so the
        // prop colliders still pair 1:1 with positions() by index.
        for (const c of waterColliders()) colliderCache.push(c);
      }
      return colliderCache;
    },
    collidersVersion: (): number => colliderVersion,
    nudge(x: number, z: number, strength: number): void {
      const s = Math.min(1.5, Math.max(0, strength));
      if (s <= 0) return;
      const now = windUniforms.uWindTime.value; // seconds (wind seam)
      const slots = nudgeUniforms.uNudge.value;
      // A nudge near a live slot refreshes it instead of burning a new one;
      // re-kick only past the pulse crest, so pushing through a bush reads
      // as a repeated gentle rock, never a frozen rise.
      for (const slot of slots) {
        if (slot.z <= 0) continue;
        const dx = slot.x - x;
        const dz = slot.y - z;
        if (dx * dx + dz * dz < 0.8) {
          if (now - slot.w >= NUDGE_REKICK_S) slot.set(x, z, Math.max(slot.z, s), now);
          else slot.z = Math.max(slot.z, s);
          return;
        }
      }
      slots[nudgeCursor]!.set(x, z, s, now);
      nudgeCursor = (nudgeCursor + 1) % NUDGE_SLOTS;
    },
    nudgeState(): { x: number; z: number; strength: number; t0: number }[] {
      return nudgeUniforms.uNudge.value
        .filter((v) => v.z > 0)
        .map((v) => ({ x: v.x, z: v.y, strength: v.z, t0: v.w }));
    },
    setTint(hue: number, saturation: number): void {
      tintHue = ((hue % 1) + 1) % 1;
      tintSaturation = Math.min(1, Math.max(0, saturation));
      gradedMaterials.forEach((m, i) =>
        m.color.setHSL(tintHue, tintSaturation, gradeLightness[i]!),
      );
    },
    tintState(): { hue: number; saturation: number } {
      return { hue: tintHue, saturation: tintSaturation };
    },
    dispose(): void {
      clearMeshes();
      for (const variants of geometries.values())
        for (const v of variants) v.geometry.dispose();
      tickGeometry.dispose();
      reedGeometry.dispose();
      shadowGeometry.dispose();
      propMaterial.dispose();
      rockMaterial.dispose();
      swayMaterial.dispose();
      palmMaterial.dispose();
      cactusMaterial.dispose();
      tickMaterial.dispose();
      shadowMaterial.dispose();
    },
  };
}
