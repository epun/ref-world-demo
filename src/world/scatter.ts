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
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { sampleDrift } from '../motion/ambient';
import { SURFACE, WORLD } from '../taste/tokens';
import {
  buildPropGeometries,
  INFLATED_PROP_KINDS,
  PROP_VARIANT_COUNTS,
  type InflatedPropKind,
} from './props';

export type ScatterKind = InflatedPropKind | 'tick';

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
/** World seed — one world, one growth. */
export const SCATTER_SEED = 7;

/** [D] Clearing radius around the origin: the hatch ground stays open paper
 * (creature spawns spiral out from the origin; live exclusions arrive later
 * via setExclusions, but the landing field is never planted to begin with). */
const ORIGIN_CLEAR_PROPS = 11;
const ORIGIN_CLEAR_TICKS = 6;

/** Per-cell cluster-seed probability at density 1. Ticks common, trees /
 * conifers / rocks medium, buildings rare (and hard-capped). */
const SEED_PROB: Record<ScatterKind, number> = {
  tick: 0.16,
  bush: 0.014,
  tree: 0.011,
  conifer: 0.009,
  rock: 0.011,
  stump: 0.004,
  building: 0.004,
};

/** At most this many buildings in the whole region, in cell iteration order. */
export const BUILDING_MAX = 4;
/** No two buildings of the same variant within this many world units. */
export const BUILDING_ADJ_RADIUS = SCATTER_STEP * 8;

/** A cluster neighbor repeats its cluster's variant with this probability;
 * otherwise it rerolls uniformly (so a grove is one species plus strays). */
export const CLUSTER_VARIANT_BIAS = 0.6;

const PROP_ROLL_ORDER: InflatedPropKind[] = ['bush', 'tree', 'conifer', 'rock', 'stump', 'building'];

/** Every controllable scatter kind, for generic dev-panel controls. */
export const SCATTER_KINDS: ScatterKind[] = [...INFLATED_PROP_KINDS, 'tick'];

function cellHash(ix: number, iz: number, salt: number): number {
  const x =
    Math.sin(ix * 127.1 + iz * 311.7 + SCATTER_SEED * 74.7 + salt * 53.13) * 43758.5453123;
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
 */
export function computePlacements(opts: PlacementOptions = {}): Placement[] {
  const density = Math.max(0, opts.density ?? 1);
  const kindDensity = opts.kindDensity ?? {};
  const out: Placement[] = [];
  const cells = Math.floor(SCATTER_EXTENT / SCATTER_STEP);
  const buildings: { x: number; z: number; variant: number }[] = [];

  const push = (kind: ScatterKind, variant: number, x: number, z: number, salt: number): void => {
    const clear = kind === 'tick' ? ORIGIN_CLEAR_TICKS : ORIGIN_CLEAR_PROPS;
    if (x * x + z * z < clear * clear) return;
    // Buildings face the default iso camera (azimuth π/4) with a hand-placed
    // jitter: their silhouettes are directional (gate arch, hut doorway) and
    // must read from the frame, where trees and rocks read from any side.
    const rotY =
      kind === 'building'
        ? Math.PI / 4 + (cellHash(Math.round(x * 8), Math.round(z * 8), salt + 4.2) - 0.5) * 0.5
        : cellHash(Math.round(x * 8), Math.round(z * 8), salt + 4.2) * Math.PI * 2;
    out.push({
      kind,
      variant,
      x,
      z,
      scale: 0.7 + cellHash(Math.round(x * 8), Math.round(z * 8), salt + 3.1) * 0.6,
      rotY,
    });
  };

  /** Jittered seed position for the cell (the grid places, never forms). */
  const seedPos = (ix: number, iz: number): { sx: number; sz: number } => {
    const jx = (cellHash(ix, iz, 11.7) - 0.5) * 0.84 * SCATTER_STEP;
    const jz = (cellHash(ix, iz, 12.9) - 0.5) * 0.84 * SCATTER_STEP;
    return { sx: ix * SCATTER_STEP + jx, sz: iz * SCATTER_STEP + jz };
  };

  const cluster = (kind: ScatterKind, ix: number, iz: number, extras: number): void => {
    const { sx, sz } = seedPos(ix, iz);
    const count = kind === 'tick' ? 1 : PROP_VARIANT_COUNTS[kind];
    // The cluster's species: uniform over the kind's variants.
    const clusterVariant = Math.min(count - 1, Math.floor(cellHash(ix, iz, 31.1) * count));
    push(kind, clusterVariant, sx, sz, 1);
    for (let n = 0; n < extras; n++) {
      const a = cellHash(ix, iz, 21.3 + n * 5.7) * Math.PI * 2;
      const r = (0.6 + cellHash(ix, iz, 22.5 + n * 5.7)) * SCATTER_STEP;
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
      const clash = buildings.some(
        (b) =>
          b.variant === variant &&
          (b.x - sx) * (b.x - sx) + (b.z - sz) * (b.z - sz) <
            BUILDING_ADJ_RADIUS * BUILDING_ADJ_RADIUS,
      );
      if (!clash) break;
      variant = (variant + 1) % count;
    }
    buildings.push({ x: sx, z: sz, variant });
    push('building', variant, sx, sz, 1);
  };

  for (let iz = -cells; iz <= cells; iz++) {
    for (let ix = -cells; ix <= cells; ix++) {
      // Tick layer: independent roll — ticks are ground texture, not props.
      if (cellHash(ix, iz, 1.1) < SEED_PROB.tick * density * Math.max(0, kindDensity.tick ?? 1)) {
        const extras = 1 + Math.floor(cellHash(ix, iz, 2.2) * 3); // 2–4 total
        cluster('tick', ix, iz, extras);
      }
      // Prop layer: every kind rolls INDEPENDENTLY (own salt), so a per-kind
      // density change never moves another kind's placements. First passing
      // kind (in roll order) claims the cell — at most one cluster per cell,
      // and collisions are ~1e-4 rare at these probabilities. Neighbor count
      // hashes independently of the chosen kind (monotonicity).
      for (let k = 0; k < PROP_ROLL_ORDER.length; k++) {
        const kind = PROP_ROLL_ORDER[k]!;
        const prob = SEED_PROB[kind] * density * Math.max(0, kindDensity[kind] ?? 1);
        if (cellHash(ix, iz, 3.3 + k * 17.77) < prob) {
          if (kind === 'building') {
            if (buildings.length >= BUILDING_MAX) break;
            placeBuilding(ix, iz);
          } else {
            const extras = 1 + Math.floor(cellHash(ix, iz, 4.4) * 4); // 1–4
            cluster(kind, ix, iz, extras);
          }
          break;
        }
      }
    }
  }
  return out;
}

/** Placements outside every exclusion circle (strictly inside = hidden). */
export function filterExcluded(placements: Placement[], exclusions: Exclusion[]): Placement[] {
  if (exclusions.length === 0) return placements;
  return placements.filter((p) => {
    for (const e of exclusions) {
      const dx = p.x - e.x;
      const dz = p.z - e.z;
      if (dx * dx + dz * dz < e.r * e.r) return false;
    }
    return true;
  });
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

// ── instanced assembly ───────────────────────────────────────────────────────

/** Just proud of the ground; under the creature shadows' 0.02 lift. */
const PROP_SHADOW_LIFT = 0.018;
const TICK_LIFT = 0.015;
/** Shadow stamp sits a touch inside the footprint, like the creatures'. */
const SHADOW_FIT = 0.8;

export interface Scatter {
  group: Group;
  /** Currently visible non-tick props, for behavior affordances. */
  positions(): { x: number; z: number; kind: InflatedPropKind; r: number }[];
  /** Hide instances inside the circles. Rebuilds visibility on call. */
  setExclusions(points: Exclusion[]): void;
  /** Rebuild with a global density multiplier (dev panel). */
  setDensity(mult: number): void;
  /** Per-kind density multiplier, layered on the global one. Independent per
   * kind: changing one kind never moves another kind's placements. */
  setKindDensity(kind: ScatterKind, mult: number): void;
  /** Per-kind uniform scale multiplier on every instance of the kind. */
  setKindScale(kind: ScatterKind, mult: number): void;
  /** Barely-perceptible whole-group sway. Call once per frame. */
  update(nowMs: number): void;
  dispose(): void;
}

/** Stable seed for the scatter group's drift channel. */
const SWAY_SEED = 63.9;
/** The sway rides one shared group transform: per-instance drift would mean
 * re-uploading thousands of matrices every frame for a sub-pixel effect. */
const SWAY_SCALE = 1.6;

export function createScatter(): Scatter {
  const group = new Group();
  const geometries = buildPropGeometries();

  const variantOf = (p: Placement) => geometries.get(p.kind as InflatedPropKind)![p.variant]!;

  // Light paper albedo, fully matte — the ink pass draws the form. Never a
  // grey mass (GENERATOR §ink rendering pass).
  const propMaterial = new MeshStandardMaterial({
    color: WORLD.light,
    roughness: 1,
    metalness: 0,
  });
  // Ticks are unlit ink marks — the only dark the environment carries.
  const tickMaterial = new MeshBasicMaterial({ color: WORLD.ink, side: DoubleSide });
  // Flat stamped shadow discs, one hard value (TASTE §2.4).
  const shadowMaterial = new MeshBasicMaterial({
    color: SURFACE.shadow,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const tickGeometry = buildTickGeometry();
  const shadowGeometry = new CircleGeometry(1, 40);
  shadowGeometry.rotateX(-Math.PI / 2);

  let globalDensity = 1;
  const kindDensity: Partial<Record<ScatterKind, number>> = {};
  const kindScale: Partial<Record<ScatterKind, number>> = {};
  let placements = computePlacements();
  let exclusions: Exclusion[] = [];
  let meshes: InstancedMesh[] = [];

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
      group.remove(mesh);
      mesh.dispose();
    }
    meshes = [];
  }

  /** Rebuild every InstancedMesh from placements minus exclusions. Runs on
   * setExclusions / setDensity calls only — never per frame. */
  function rebuild(): void {
    clearMeshes();
    const visible = filterExcluded(placements, exclusions);

    // One InstancedMesh per (kind, variant) — ~20 draws total.
    for (const kind of INFLATED_PROP_KINDS) {
      const variants = geometries.get(kind)!;
      for (let v = 0; v < variants.length; v++) {
        const of = visible.filter((p) => p.kind === kind && p.variant === v);
        if (of.length === 0) continue;
        const mesh = new InstancedMesh(variants[v]!.geometry, propMaterial, of.length);
        mesh.frustumCulled = false;
        const kMult = scaleOf(kind);
        of.forEach((p, i) => {
          quat.setFromAxisAngle(axisY, p.rotY);
          pos.set(p.x, 0, p.z);
          scl.setScalar(p.scale * kMult);
          mesh.setMatrixAt(i, matrix.compose(pos, quat, scl));
        });
        mesh.instanceMatrix.needsUpdate = true;
        meshes.push(mesh);
        group.add(mesh);
      }
    }

    const ticks = visible.filter((p) => p.kind === 'tick');
    if (ticks.length > 0) {
      const mesh = new InstancedMesh(tickGeometry, tickMaterial, ticks.length);
      mesh.frustumCulled = false;
      const tickMult = scaleOf('tick');
      ticks.forEach((p, i) => {
        quat.setFromAxisAngle(axisY, p.rotY);
        pos.set(p.x, TICK_LIFT, p.z);
        scl.setScalar(p.scale * tickMult);
        mesh.setMatrixAt(i, matrix.compose(pos, quat, scl));
      });
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
      group.add(mesh);
    }

    // One shadow disc per large/medium prop — ticks get none.
    const shadowed = visible.filter((p) => p.kind !== 'tick');
    if (shadowed.length > 0) {
      const mesh = new InstancedMesh(shadowGeometry, shadowMaterial, shadowed.length);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      shadowed.forEach((p, i) => {
        const r = variantOf(p).radius * p.scale * scaleOf(p.kind) * SHADOW_FIT;
        quat.identity();
        pos.set(p.x, PROP_SHADOW_LIFT, p.z);
        scl.set(r, 1, r);
        mesh.setMatrixAt(i, matrix.compose(pos, quat, scl));
      });
      mesh.instanceMatrix.needsUpdate = true;
      meshes.push(mesh);
      group.add(mesh);
    }
  }

  rebuild();

  return {
    group,
    positions() {
      return filterExcluded(placements, exclusions)
        .filter((p) => p.kind !== 'tick')
        .map((p) => ({
          x: p.x,
          z: p.z,
          kind: p.kind as InflatedPropKind,
          r: variantOf(p).radius * p.scale * scaleOf(p.kind),
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
    setKindDensity(kind: ScatterKind, mult: number): void {
      kindDensity[kind] = mult;
      replace();
      rebuild();
    },
    setKindScale(kind: ScatterKind, mult: number): void {
      kindScale[kind] = mult;
      rebuild();
    },
    update(nowMs: number): void {
      const drift = sampleDrift(nowMs, SWAY_SEED, SWAY_SCALE);
      group.position.set(drift.x, 0, drift.y);
      group.rotation.y = drift.rot * 0.5;
    },
    dispose(): void {
      clearMeshes();
      for (const variants of geometries.values())
        for (const v of variants) v.geometry.dispose();
      tickGeometry.dispose();
      shadowGeometry.dispose();
      propMaterial.dispose();
      tickMaterial.dispose();
      shadowMaterial.dispose();
    },
  };
}
