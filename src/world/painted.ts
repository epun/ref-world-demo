/**
 * The painted height map — PURE (no Three.js, no DOM, no clocks, no
 * Math.random, and deliberately no `envpaint` import either).
 *
 * PLAN §7 "painted terrain (dev)". The world's geography is authored in
 * src/world/landscape.ts and stays authored; this is the one thing a person
 * may add to it by hand — an offset in world units, per texel, over a square
 * centred on the origin. `landscape.ts` owns where that offset enters a
 * height (`setPaintedHeight`); this module owns what the offset IS.
 *
 * THE ARRAY IS SHARED, NOT COPIED. `height` is exactly the buffer an
 * `envpaint/core` `PaintLayer` writes into — one float channel, `res` texels
 * a side, same row-major layout, same half-texel-centred uv mapping — so the
 * dev paint skill hands `layer.data` straight to `createPaintedMap` and every
 * stamp is visible to the sampler on the next height read with nothing in
 * between. That is why the texel maths below is spelled out rather than
 * borrowed: the coupling is a data layout, not a dependency, and the demo
 * build must never pull the brush engine in behind a height sample.
 *
 * WHY IT IS NOT A `Surface` [D]: PLAN §7.2 keeps the seam two methods wide
 * and the world sampling exactly one of them. A painted map is not a second
 * surface — it is a term inside the one surface there is, which is why it
 * arrives as a sampler handed to `landscape.ts` and not as a `Surface` some
 * consumers would have to be switched over to.
 *
 * The offset is 0 outside the square, and it FADES to 0 across the last half
 * texel rather than stepping there: the terrain's normals are central
 * differences, so a discontinuity at the map's rim would draw itself as a
 * contour line in the ink pass — a square one, which is the one shape TASTE
 * §2.5 will not have on screen.
 *
 * WATER rides alongside it in a second layer of the same shape: `water`, one
 * absolute surface LEVEL per texel, `DRY` where there is none. It is a layer
 * and not a body — what a level layer MEANS (components, shorelines, a signed
 * distance field) is src/world/painted-water.ts's job, exactly as what a
 * height offset means is landscape.ts's. Region weights, the clearing and the
 * painted map's own baking are still later steps (envpaint
 * docs/port-meridian.md §5 steps 5-6).
 * PLANTING (2026-09-09, user ask: "in the collection we should have brushes
 * for trees, rocks, grass, flowers, rivers, clouds, ponds, etc.") — the same
 * idea, one dimension over: seven weight layers, [0,1], that say how much of
 * each motif family somebody wants HERE. They are NOT heights and they never
 * touch the surface; `scatter.ts` reads them as an extra term in its per-cell
 * roll, which is why they live beside `height` in the one painted map rather
 * than in a second one — a projection restores one object, not two.
 *
 * The planting layers are coarser than the height map on purpose: placement
 * is decided per scatter cell (6 u), so a texel finer than the step buys
 * nothing but memory, and there are seven of them.
 *
 * Water (ponds, rivers) is NOT here: another branch owns the painted water
 * tools, and a second module writing water would be the second shoreline
 * this project keeps warning about.
 */

/** [D] Texels a side. 512 over 400 units is 0.78 u a texel — finer than the
 * terrace risers, which are the smallest thing the ground draws. */
export const PAINTED_RES = 512;

/**
 * [D] World units the map spans, centred on the origin: the displaced ground
 * field is exactly this wide (`FIELD_SIZE` in src/world/ground.ts), so the
 * paintable region is precisely the region that has vertices to move. Past
 * it the far ring is flat by construction and nothing could show a stamp.
 */
export const PAINTED_SIZE = 400;

/**
 * "No water in this texel" in the level layer.
 *
 * This MUST equal `DRY` exported by `envpaint/core` (src/core/WaterOps.js) —
 * the level layer is that engine's buffer, shared texel for texel like the
 * height one, so a value it writes to drain a texel has to read as dry here.
 * The number is re-declared rather than imported for the reason the header
 * gives (this module pulls in no brush engine), and src/dev/paint.ts asserts
 * the two are equal at startup so the duplication cannot drift in silence.
 */
export const DRY = -1000;

/**
 * The planting brushes, in strip order. Each is one weight layer.
 *
 * The ids are EnvPaint's own (2026-09-10, user ask: *"i want to have the
 * same brushes as env paint but in the ref style"*) — `trees` was `grove`
 * and `mask` was `clearing`, and the strip they belong to is the one
 * EnvPaint ships, minus the brushes this world has no environment item for.
 * `cottages` went with that pass: EnvPaint has no such brush, so the weight
 * layer went too and buildings are the field's own again. A stored map or
 * session log written under the old ids still applies — src/dev/paint-tools.ts
 * `LEGACY_TOOLS` maps them on the way in.
 *
 * Two of them plant nothing. `mask` is the eraser of the set: it SUPPRESSES
 * the world's own seeding (scatter.ts), which is how an operator opens a
 * glade in a forest without lowering a global density that would thin the
 * whole field. `path` is a place things cannot stand — it suppresses the
 * world's seeding AND the painted term (the one way it differs from the
 * mask: a trail with a tree standing in it is not a trail), and it is the
 * one planting layer the GROUND reads as well, drawing itself as an ink
 * dirt trail (src/world/ground.ts).
 *
 * The water brush (pond) is NOT in this list: water is a LEVEL layer of its
 * own with its own tool, not a weight (see `DRY` above).
 */
export const PLANT_BRUSHES = [
  'mask',
  'path',
  'grass',
  'flowers',
  'trees',
  'rocks',
  'clouds',
] as const;
export type PlantBrush = (typeof PLANT_BRUSHES)[number];

/** One weight per brush at a point, each in [0,1]. */
export type PlantingWeights = Record<PlantBrush, number>;

/**
 * [D] Texels a side for every planting layer. 256 over 400 units is 1.56 u a
 * texel — finer than the 6 u scatter step (so a brushstroke's edge falls
 * between cells rather than on them), and a quarter of the height map's
 * memory, which matters because there are seven of these and one of that.
 */
export const PLANTING_RES = 256;

/**
 * [D] Channels in the `comb` direction layer, and the neutral both hold when
 * nothing is combed — re-declared from src/world/comb.ts's own constants
 * only where the ALLOCATION needs them, so this module keeps carrying no
 * dependency it does not need. `clearPaintedMap` fills to the neutral, not
 * to zero, because the live paint layer whose buffer this IS is constructed
 * at the neutral (src/dev/paint.ts).
 */
export const COMB_CHANNELS = 2;
export const COMB_NEUTRAL = 0.5;

/** A zeroed weight set — an unplanted point, and the value every consumer
 * gets when no map is installed. A fresh object per call: nobody mutates a
 * shared sample (same discipline as `sampleLandscape`). */
export function zeroPlanting(): PlantingWeights {
  const out = {} as PlantingWeights;
  for (const brush of PLANT_BRUSHES) out[brush] = 0;
  return out;
}

export interface PaintedMap {
  /** Texels a side. */
  res: number;
  /** World units the map spans, centred on the origin. */
  size: number;
  /**
   * Height offset in world units, row-major, `res * res` floats — texel
   * (tx, ty) at index `ty * res + tx`. THE SAME buffer as the paint layer's
   * when one is wired in; never copy it, or the two silently diverge.
   */
  height: Float32Array;
  /**
   * Absolute water surface level in world units, row-major, `res * res`
   * floats, same indexing as `height` — `DRY` in every texel that holds no
   * water. A level is absolute, never an offset: a painted body's surface is
   * one plane at a height somebody chose, and no terrain dial scales it.
   */
  water: Float32Array;
  /** Texels a side for every planting layer. */
  plantingRes: number;
  /**
   * Planting weight per brush, [0,1], row-major, `plantingRes²` floats each.
   * Shared with the brush's own paint layers exactly as `height` is — a dab
   * is visible to the next placement roll with nothing in between.
   */
  planting: Record<PlantBrush, Float32Array>;
  /**
   * The comb: a DIRECTION per texel, two channels (`dir.x`, `dir.z`) encoded
   * `d * 0.5 + 0.5`, `plantingRes²` texels — `2 * plantingRes²` floats. Read
   * by scatter's mark placement through src/world/comb.ts, never by the
   * ground. Shared with the brush's own layer like every other array here.
   */
  comb: Float32Array;
  /**
   * The fire brush's weight, [0,1], `plantingRes²` floats, same indexing as
   * a planting layer. NOT one of `PLANT_BRUSHES`: fire plants nothing and
   * rolls no kind — what it means is src/world/fire.ts's `burnState`, exactly
   * as what a water level means is painted-water.ts's.
   */
  fire: Float32Array;
}

/** The serialised form: the same numbers, base64, for a committed map.json. */
export interface PaintedMapJson {
  res: number;
  size: number;
  /** Base64 of the raw little-endian Float32 bytes. */
  height: string;
  /** The level layer, same encoding. Optional: a map saved before water
   * existed has none, and loads as an entirely dry one. */
  water?: string;
  /** Texels a side for the planting layers. Absent in a map written before
   * planting existed — such a map deserialises with empty layers. */
  plantingRes?: number;
  /** Base64 per brush, same encoding as `height`. A missing brush is an
   * unpainted one. */
  planting?: Partial<Record<PlantBrush, string>>;
  /** The comb layer, same encoding, `2 * plantingRes²` floats. Absent in a
   * map written before the comb existed — such a map loads UNCOMBED, which
   * is what a zeroed buffer reads as (src/world/comb.ts `decodeComb`). */
  comb?: string;
  /** The fire layer, same encoding. Absent in a map written before it, and
   * such a map loads with nothing alight. */
  fire?: string;
}

/**
 * A painted map over `size` world units at `res` texels a side.
 *
 * `height` adopts an existing array when one is passed — the paint layer's
 * own `data` — and allocates a zeroed one otherwise. It is adopted by
 * reference on purpose (see the header); a wrong-length array is a
 * programming error and throws rather than being quietly resized, because
 * the alternative is a map that samples garbage at one corner. `water` is
 * adopted on exactly the same terms, from the level layer, and allocates
 * filled with `DRY` — an unpainted map is dry, not flooded at height 0.
 */
export function createPaintedMap(
  res: number = PAINTED_RES,
  size: number = PAINTED_SIZE,
  height?: Float32Array,
  water?: Float32Array,
  planting?: Partial<Record<PlantBrush, Float32Array>>,
  plantingRes: number = PLANTING_RES,
  /** The two layers that are not planting weights but ride at the planting
   * resolution: the comb (2 channels) and the fire brush's weight. Adopted by
   * reference on the same terms as everything else, and allocated when
   * absent. An OBJECT rather than two more positional arguments — this
   * signature is already six deep. */
  extra?: { comb?: Float32Array; fire?: Float32Array },
): PaintedMap {
  if (!Number.isInteger(res) || res < 2) throw new Error(`painted map: res must be >= 2, got ${res}`);
  if (!(size > 0)) throw new Error(`painted map: size must be positive, got ${size}`);
  if (height && height.length !== res * res) {
    throw new Error(`painted map: height must hold ${res * res} floats, got ${height.length}`);
  }
  if (water && water.length !== res * res) {
    throw new Error(`painted map: water must hold ${res * res} floats, got ${water.length}`);
  }
  if (!Number.isInteger(plantingRes) || plantingRes < 2) {
    throw new Error(`painted map: plantingRes must be >= 2, got ${plantingRes}`);
  }
  // Adopted by reference, exactly like `height` and `water` — the brush's own
  // layer buffer, never a copy — and allocated zeroed for any brush not
  // handed in, so an older caller that knows nothing about planting still
  // gets a complete map back.
  const layers = {} as Record<PlantBrush, Float32Array>;
  for (const brush of PLANT_BRUSHES) {
    const given = planting?.[brush];
    if (given && given.length !== plantingRes * plantingRes) {
      throw new Error(
        `painted map: planting '${brush}' must hold ${plantingRes * plantingRes} floats, got ${given.length}`,
      );
    }
    layers[brush] = given ?? new Float32Array(plantingRes * plantingRes);
  }
  const combCount = plantingRes * plantingRes * COMB_CHANNELS;
  if (extra?.comb && extra.comb.length !== combCount) {
    throw new Error(`painted map: comb must hold ${combCount} floats, got ${extra.comb.length}`);
  }
  const fireCount = plantingRes * plantingRes;
  if (extra?.fire && extra.fire.length !== fireCount) {
    throw new Error(`painted map: fire must hold ${fireCount} floats, got ${extra.fire.length}`);
  }
  return {
    res,
    size,
    height: height ?? new Float32Array(res * res),
    water: water ?? new Float32Array(res * res).fill(DRY),
    plantingRes,
    planting: layers,
    // Zeroed when nobody hands one in — which reads as UNCOMBED, not as a
    // lean to the north-west (src/world/comb.ts explains why that matters).
    comb: extra?.comb ?? new Float32Array(combCount),
    fire: extra?.fire ?? new Float32Array(fireCount),
  };
}

/** Every texel back to unpainted — height to zero, water to `DRY`, every
 * planting weight to zero — and with it every paint layer sharing a buffer
 * with the map. `clear map` means the map, not a third of it. */
export function clearPaintedMap(map: PaintedMap): void {
  map.height.fill(0);
  map.water.fill(DRY);
  for (const brush of PLANT_BRUSHES) map.planting[brush]?.fill(0);
  // The comb goes back to NEUTRAL rather than to zero: its buffer is the live
  // paint layer's, and that layer is constructed at the neutral.
  map.comb.fill(COMB_NEUTRAL);
  map.fire.fill(0);
}

/**
 * The painted offset at (x, z), world units. Bilinear between texel centres,
 * exactly 0 outside the map.
 *
 * Texel centres sit at `(i + 0.5) / res` in uv, which is where a paint layer
 * puts them, so a stamp lands here at the position it was painted at. Texels
 * off the edge of the array read 0 rather than clamping to the border value
 * (which is what a texture sampler does): a painted offset must not smear
 * out of the map into the far field, and the zero reads are what make the
 * value continuous across the rim.
 */
export function sampleHeight(map: PaintedMap, x: number, z: number): number {
  const { res, size, height } = map;
  const u = x / size + 0.5;
  const v = z / size + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const fx = u * res - 0.5;
  const fy = v * res - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (tex: number, tey: number): number => {
    if (tex < 0 || tex >= res || tey < 0 || tey >= res) return 0;
    return height[tey * res + tex] ?? 0;
  };
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
  const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
  return top + (bot - top) * ty;
}

/**
 * The map as the sampler `landscape.ts`'s `setPaintedHeight` takes.
 *
 * Bound to the map object, not to its array: the paint skill may hand the
 * map a different buffer later (a loaded one), and the installed sampler
 * must follow it rather than keep pointing at the array it was made from.
 */
export function paintedSampler(map: PaintedMap): (x: number, z: number) => number {
  return (x: number, z: number): number => sampleHeight(map, x, z);
}

/**
 * One brush's planting weight at (x, z), [0,1]. Bilinear between texel
 * centres, exactly 0 outside the map, fading over the last half texel — the
 * same recipe (and the same reason) as `sampleHeight`: texels off the array
 * read 0 instead of clamping to the border, so a stroke that runs to the rim
 * fades out instead of smearing a straight edge across the field.
 *
 * Deliberately NOT clamped here: the brush clamps as it stamps, and a
 * sampler that quietly repaired out-of-range data would hide the day
 * something wrote 3.
 */
export function samplePlanting(map: PaintedMap, brush: PlantBrush, x: number, z: number): number {
  const res = map.plantingRes;
  const data = map.planting[brush];
  if (!data) return 0;
  const u = x / map.size + 0.5;
  const v = z / map.size + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const fx = u * res - 0.5;
  const fy = v * res - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (tex: number, tey: number): number => {
    if (tex < 0 || tex >= res || tey < 0 || tey >= res) return 0;
    return data[tey * res + tex] ?? 0;
  };
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
  const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
  return top + (bot - top) * ty;
}

/**
 * The map as the sampler `landscape.ts`'s `setPaintedPlanting` takes — every
 * brush's weight at a point, in one object.
 *
 * ALL OF THEM at once rather than a sampler per brush: `sampleLandscape` is
 * called once per scatter cell and the roll needs every weight, so a call
 * per brush would be seven bilinear reads at the same point through seven
 * closures. Bound to the map object like `paintedSampler`, for the same
 * reason: the buffers may be swapped for loaded ones under it.
 */
export function plantingSampler(map: PaintedMap): (x: number, z: number) => PlantingWeights {
  return (x: number, z: number): PlantingWeights => {
    const out = {} as PlantingWeights;
    for (const brush of PLANT_BRUSHES) out[brush] = samplePlanting(map, brush, x, z);
    return out;
  };
}

/** Lowest and highest painted offset in the map, world units. Both 0 on an
 * unpainted map — the readout the dev panel shows. */
export function paintedRange(map: PaintedMap): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (let i = 0; i < map.height.length; i++) {
    const h = map.height[i] ?? 0;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max };
}

// ── base64, both ways, without btoa ──────────────────────────────────────────
// The map is committed as json (envpaint docs/port-meridian.md §2.1 "Save
// map"), so it has to encode in the browser that painted it and decode in
// node when a test reads it back. `btoa`/`atob` are DOM, `Buffer` is node:
// this module is pure and may have neither, so it carries the 24-bit
// transform itself. Little-endian floats, which is every platform this runs
// on and is asserted by the round-trip test rather than assumed.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const word = (a << 16) | (b << 8) | c;
    out += B64[(word >> 18) & 63];
    out += B64[(word >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(word >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[word & 63] : '=';
  }
  return out;
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i] ?? 'A');
    const b = B64.indexOf(clean[i + 1] ?? 'A');
    const c = B64.indexOf(clean[i + 2] ?? 'A');
    const d = B64.indexOf(clean[i + 3] ?? 'A');
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (word >> 16) & 255;
    if (o < out.length) out[o++] = (word >> 8) & 255;
    if (o < out.length) out[o++] = word & 255;
  }
  return out;
}

/**
 * The map as committable json. A COPY of the bytes — the caller may hold the
 * result while painting continues, and a live paint layer's buffer is
 * mutating underneath.
 */
export function serializeMap(map: PaintedMap): PaintedMapJson {
  const height = new Uint8Array(map.height.buffer, map.height.byteOffset, map.height.byteLength);
  const water = new Uint8Array(map.water.buffer, map.water.byteOffset, map.water.byteLength);
  const planting: Partial<Record<PlantBrush, string>> = {};
  for (const brush of PLANT_BRUSHES) {
    const data = map.planting[brush];
    planting[brush] = encodeBase64(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  const comb = new Uint8Array(map.comb.buffer, map.comb.byteOffset, map.comb.byteLength);
  const fire = new Uint8Array(map.fire.buffer, map.fire.byteOffset, map.fire.byteLength);
  return {
    res: map.res,
    size: map.size,
    height: encodeBase64(height),
    water: encodeBase64(water),
    plantingRes: map.plantingRes,
    planting,
    comb: encodeBase64(comb),
    fire: encodeBase64(fire),
  };
}

/** The inverse. Throws on a payload whose byte count is not the resolution it
 * claims — a half-read map would sample plausible garbage. A payload with no
 * `water` at all is not half-read but OLD, and loads dry. */
export function deserializeMap(o: PaintedMapJson): PaintedMap {
  const floats = o.res * o.res;
  const layer = (text: string, which: string, count: number): Float32Array => {
    const bytes = decodeBase64(text);
    if (bytes.length !== count * 4) {
      const want = count * 4;
      throw new Error(
        `painted map: expected ${want} ${which} bytes for res ${o.res}, got ${bytes.length}`,
      );
    }
    const out = new Float32Array(count);
    new Uint8Array(out.buffer).set(bytes);
    return out;
  };
  const height = layer(o.height, 'height', floats);
  const water = o.water === undefined ? undefined : layer(o.water, 'water', floats);
  // Planting rides at its own resolution, and a brush nobody painted (or a
  // map written before planting existed) simply has no entry.
  const plantingRes = o.plantingRes ?? PLANTING_RES;
  const plantFloats = plantingRes * plantingRes;
  const planting: Partial<Record<PlantBrush, Float32Array>> = {};
  for (const brush of PLANT_BRUSHES) {
    const b64 = o.planting?.[brush];
    if (b64 === undefined) continue;
    planting[brush] = layer(b64, `planting '${brush}'`, plantFloats);
  }
  // Both are OPTIONAL on the way in: a map written before either layer
  // existed simply has none, and loads uncombed and unlit.
  const extra: { comb?: Float32Array; fire?: Float32Array } = {};
  if (o.comb !== undefined) extra.comb = layer(o.comb, 'comb', plantFloats * COMB_CHANNELS);
  if (o.fire !== undefined) extra.fire = layer(o.fire, 'fire', plantFloats);
  return createPaintedMap(o.res, o.size, height, water, planting, plantingRes, extra);
}
