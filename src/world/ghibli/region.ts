/**
 * The REGION texture: the geography, baked small, for the element shaders to
 * read per vertex and per fragment.
 *
 * envpaint's blades ask a painted `grass` layer whether to exist. This world
 * has that layer too (`src/world/painted.ts`), but it also has something
 * envpaint does not: an AUTHORED map (`src/world/landscape.ts`), and the user
 * ask is a tropical island — grass on the meadow with nobody painting it,
 * thinning across the sand, and none of it standing in the sea. A vertex
 * shader cannot call `sampleLandscape`, so the map is baked once into three
 * channels of one small texture:
 *
 *   **r** meadow weight — land that is not mountain: plain, forest, island.
 *   **g** beach weight — land within `BEACH_RUN` of the waterline, 1 at the
 *         water's edge falling to 0 inland.
 *   **b** water proximity — exactly `WATER_MARK` (1.0) IN water, and
 *         `0.9 · (1 − d / WATER_NEAR)` on land, so a shader can read both
 *         "am I wet" (`step(0.95, b)`) and "how close is the sea"
 *         (the ramp) off one channel without a second sampler.
 *
 * WHY 128² [D]: the coarsest thing in it is a shoreline, `FIELD_SIZE / 128`
 * is 3.1 world units a texel, and the two consumers both smooth it further
 * (the grass compares it against a per-blade random, the ground ramps it).
 * It is 64 KB and it re-bakes in a few milliseconds, which matters because
 * `WorldHandles.setLandscape` re-bakes it on a drag.
 *
 * THE MAP IS THE SOURCE. Every value here comes from `sampleLandscape`; this
 * module derives no shoreline of its own (CLAUDE.md, PLAN's landscape
 * invariant). The distance-to-water field is a chamfer sweep over the sampled
 * water mask — a transform of the map, not a second opinion about it.
 */

import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import { isPhoneTier } from '../device';
import { FIELD_SIZE, fieldSize } from '../field';
import { sampleLandscape } from '../landscape';

/** Texels a side on a world with no island. */
export const REGION_RES = 128;

/** World units the bake spans on a world with no island, centred on the
 * origin — the displaced ground field's own extent. */
export const REGION_SIZE = FIELD_SIZE;

/**
 * …and the two the bake actually uses: both through `mapScale` (2026-09-16,
 * `MAP_SCALE` in src/world/landscape.ts), so the TEXEL stays 3.1 world units
 * whatever the island's size — 256² over 800 units on the doubled island.
 *
 * The bake spans the GROUND FIELD and the painted layers span the PAINTED
 * MAP, and on the doubled island those are no longer the same square: the
 * consumers read the region at `xz / GG_MAP_SIZE` and a painted layer at
 * `xz / GG_SIZE`, two constants instead of the one they shared. The painted
 * map stays 400 units because its extent is on the wire
 * (`SCENE_EXTENT` in src/session/scene.ts).
 */
export function regionSize(): number {
  return fieldSize();
}

export function regionRes(): number {
  // A HANDSET KEEPS 128 (2026-09-16), for the same reason the shore bake does
  // and with less at stake: both consumers smooth this further (the grass
  // compares it against a per-blade random, the ground ramps it), so 6.25
  // world units a texel instead of 3.1 costs a softer edge on a shoreline
  // ramp nobody reads at full size on a phone. 155ms → 106ms a rebuild.
  if (isPhoneTier()) return REGION_RES;
  return Math.round(REGION_RES * (fieldSize() / FIELD_SIZE));
}

/** [D] How far inland the beach runs, world units. Wide enough to read as a
 * shore from the isometric camera, narrow enough that an inland pond gets a
 * sandy rim rather than a sandy county. */
export const BEACH_RUN = 9;

/** [D] How far the water-proximity ramp reaches inland, world units. The
 * ground's wet-sand band lives inside the last couple of these. */
export const WATER_NEAR = 6;

/** The value the b channel takes IN water — above every land value, so a
 * `step(0.95, b)` is exactly "wet". */
export const WATER_MARK = 1;

/** The ceiling of the land half of the b ramp. Kept under `WATER_MARK` so the
 * two can never be confused by a bilinear tap. */
const LAND_NEAR_MAX = 0.9;

/** Chamfer weights for the distance sweep: orthogonal and diagonal steps, in
 * texels. The classic 3×3 approximation — within ~4% of euclidean, which is
 * a tenth of a texel here. */
const D_ORTHO = 1;
const D_DIAG = Math.SQRT2;

function texelToWorld(i: number, res: number, size: number): number {
  return -size / 2 + ((i + 0.5) / res) * size;
}

/**
 * Bake the map into a fresh `DataTexture`. Linear-filtered: the consumers
 * want a ramp across a shoreline, not a staircase.
 */
export function bakeRegionTexture(res: number = regionRes()): DataTexture {
  const texture = new DataTexture(
    new Uint8Array(res * res * 4),
    res,
    res,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  rebakeRegion(texture);
  return texture;
}

/**
 * Re-bake IN PLACE — same buffer, same texture object, one `needsUpdate`.
 *
 * This is the call that belongs beside `scatter.refreshLandscape()`: the
 * authored mode changed, or somebody painted a pond, so the shoreline moved
 * and every element that reads it has to see the new one.
 */
export function rebakeRegion(texture: DataTexture): void {
  const res = texture.image.width;
  const data = texture.image.data as Uint8Array;
  const size = regionSize();
  const count = res * res;

  const meadow = new Float32Array(count);
  // Distance to the nearest water texel, in TEXELS, swept below.
  const dist = new Float32Array(count);
  const INF = res * 4;

  for (let ty = 0; ty < res; ty++) {
    const z = texelToWorld(ty, res, size);
    for (let tx = 0; tx < res; tx++) {
      const x = texelToWorld(tx, res, size);
      const s = sampleLandscape(x, z);
      const i = ty * res + tx;
      // Land that is not mountain grows grass: plain, forest and the island.
      meadow[i] = s.water ? 0 : Math.max(0, 1 - s.mountain);
      dist[i] = s.water ? 0 : INF;
    }
  }

  // Two chamfer sweeps — forward over the rows, then backward. Deterministic,
  // allocation-free, and exact enough for a shoreline ramp.
  for (let ty = 0; ty < res; ty++) {
    for (let tx = 0; tx < res; tx++) {
      const i = ty * res + tx;
      let d = dist[i]!;
      if (ty > 0) {
        d = Math.min(d, dist[i - res]! + D_ORTHO);
        if (tx > 0) d = Math.min(d, dist[i - res - 1]! + D_DIAG);
        if (tx + 1 < res) d = Math.min(d, dist[i - res + 1]! + D_DIAG);
      }
      if (tx > 0) d = Math.min(d, dist[i - 1]! + D_ORTHO);
      dist[i] = d;
    }
  }
  for (let ty = res - 1; ty >= 0; ty--) {
    for (let tx = res - 1; tx >= 0; tx--) {
      const i = ty * res + tx;
      let d = dist[i]!;
      if (ty + 1 < res) {
        d = Math.min(d, dist[i + res]! + D_ORTHO);
        if (tx > 0) d = Math.min(d, dist[i + res - 1]! + D_DIAG);
        if (tx + 1 < res) d = Math.min(d, dist[i + res + 1]! + D_DIAG);
      }
      if (tx + 1 < res) d = Math.min(d, dist[i + 1]! + D_ORTHO);
      dist[i] = d;
    }
  }

  const perTexel = size / res;
  for (let i = 0; i < count; i++) {
    const wet = dist[i] === 0;
    const world = dist[i]! * perTexel;
    const beach = wet ? 0 : Math.max(0, 1 - world / BEACH_RUN);
    const near = wet ? WATER_MARK : LAND_NEAR_MAX * Math.max(0, 1 - world / WATER_NEAR);
    // Sand takes the ground where the beach weight is high, so the meadow
    // channel gives way to it rather than fighting it.
    const grow = meadow[i]! * (1 - 0.85 * beach);
    data[i * 4] = Math.round(255 * Math.min(1, Math.max(0, grow)));
    data[i * 4 + 1] = Math.round(255 * beach);
    data[i * 4 + 2] = Math.round(255 * near);
    data[i * 4 + 3] = 255;
  }
  texture.needsUpdate = true;
}
