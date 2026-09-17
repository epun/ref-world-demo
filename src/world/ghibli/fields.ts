/**
 * WHICH ELEMENT FIELDS A PAGE LAYS OUT, and their construction — lifted out of
 * `src/world/scene.ts`'s `ensureFields` (2026-09-17) so the answer can be
 * asserted in a unit test with no canvas in it.
 *
 * The decision itself is `fieldPlanFor` in src/world/device.ts and is not
 * repeated here: a projection lays the dense near field, the map-fixed base
 * field and the bloom field; a handset lays NONE of them, because at its zoom
 * floor the base field's pixel-width floor turned every blade into a 4.3-unit
 * horizontal dash and forty thousand independently tinted dashes read as camo
 * (the 2026-09-17 user report — `PHONE_DRAWS_GRASS`). On that tier the ghibli
 * ground shader carries the whole meadow.
 *
 * `meshes` comes back in DRAW ORDER — the base field first, so the dense near
 * field draws over it — and is exactly what the caller adds to the scene. An
 * empty plan returns an empty list and builds nothing at all: no layout, no
 * buffers, no program.
 */

import type { Object3D, Texture } from 'three';
import { fieldPlanFor, type DeviceTier } from '../device';
import {
  createFlowerField,
  FLOWER_COUNT_PHONE,
  FLOWER_COUNT_PROJECTION,
  FLOWER_SPAN_PHONE,
  FLOWER_SPAN_PROJECTION,
  type FlowerField,
} from './flowers';
import {
  createGrassField,
  GRASS_BASE_PHONE,
  GRASS_BASE_PROJECTION,
  grassBaseBladeWidth,
  grassBaseMinBladePx,
  grassBaseSpan,
  GRASS_COUNT_PHONE,
  GRASS_COUNT_PROJECTION,
  type GrassField,
} from './grass';

/** The painted planting layers a field reads, as the scene remembers them. */
export interface FieldLayers {
  grass: Texture | null;
  flowers: Texture | null;
  comb: Texture | null;
}

export interface FieldDeps {
  /** The baked ground every blade stands on (src/world/ghibli/height.ts). */
  height: Texture | null;
  /** The baked geography (src/world/ghibli/region.ts). */
  region: Texture | null;
  /** The near field's and the bloom field's window span, in world units. */
  nearSpan: number;
  layers: FieldLayers;
}

export interface FieldSet {
  /** The dense window field that follows the look-target. */
  near: GrassField | null;
  /** The map-fixed field over the whole island. */
  base: GrassField | null;
  flowers: FlowerField | null;
  /** Everything built, in draw order — base first. */
  meshes: Object3D[];
}

/**
 * Lay out this tier's fields. Nothing is added to a scene here; the caller
 * owns that, and an empty `meshes` means there is nothing to add.
 */
export function buildFields(tier: DeviceTier, deps: FieldDeps): FieldSet {
  const plan = fieldPlanFor(tier);
  const phone = tier === 'phone';
  const set: FieldSet = { near: null, base: null, flowers: null, meshes: [] };

  if (plan.base) {
    set.base = createGrassField({
      count: phone ? GRASS_BASE_PHONE : GRASS_BASE_PROJECTION,
      layout: 'box',
      // The island's own bounding box, through `mapScale` — 720 on the
      // doubled island (src/world/ghibli/grass.ts).
      span: grassBaseSpan(),
      height: deps.height,
      region: deps.region,
      baseDensity: 1,
      // A base blade stands much farther from its neighbour than a near one,
      // so it is wider and keeps a floor in PIXELS as the camera pulls back —
      // and both numbers go up again on the doubled island, where the same
      // budget covers four times the area.
      bladeWidth: grassBaseBladeWidth(),
      minBladePx: grassBaseMinBladePx(),
      layers: { grass: deps.layers.grass, comb: deps.layers.comb },
    });
  }

  if (plan.near) {
    set.near = createGrassField({
      count: phone ? GRASS_COUNT_PHONE : GRASS_COUNT_PROJECTION,
      span: deps.nearSpan,
      // The ground the blades stand on is a BAKE of the Surface seam, owned by
      // `ground` and re-run there on every rebuild — so sliding the window
      // costs one uniform write instead of 651ms of seam sampling
      // (src/world/ghibli/height.ts).
      height: deps.height,
      region: deps.region,
      // FULL by default (2026-09-15, user direction): the ghibli meadow is
      // envpaint's `fillMeadow` — grass everywhere the map says meadow,
      // thinning on the beach and the mountain and none in the sea.
      baseDensity: 1,
      layers: { grass: deps.layers.grass, comb: deps.layers.comb },
    });
  }

  if (plan.flowers) {
    set.flowers = createFlowerField({
      count: phone ? FLOWER_COUNT_PHONE : FLOWER_COUNT_PROJECTION,
      // The blade field's own window: blooms belong in the grass.
      span: phone ? FLOWER_SPAN_PHONE : FLOWER_SPAN_PROJECTION,
      height: deps.height,
      region: deps.region,
      // A bloom wants meadow under it (`uNeedGrass`), so it reads the grass
      // weight as well as its own.
      layers: { flowers: deps.layers.flowers, grass: deps.layers.grass },
    });
  }

  // Draw order: the base field FIRST, so the dense near field draws over it.
  if (set.base) set.meshes.push(set.base.mesh);
  if (set.near) set.meshes.push(set.near.mesh);
  if (set.flowers) set.meshes.push(set.flowers.mesh);
  return set;
}
