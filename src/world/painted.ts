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
 * Water, region weights, clearing and the painted map's own baking are later
 * steps (envpaint docs/port-meridian.md §5 steps 4-6). This file is height.
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
}

/** The serialised form: the same numbers, base64, for a committed map.json. */
export interface PaintedMapJson {
  res: number;
  size: number;
  /** Base64 of the raw little-endian Float32 bytes. */
  height: string;
}

/**
 * A painted map over `size` world units at `res` texels a side.
 *
 * `height` adopts an existing array when one is passed — the paint layer's
 * own `data` — and allocates a zeroed one otherwise. It is adopted by
 * reference on purpose (see the header); a wrong-length array is a
 * programming error and throws rather than being quietly resized, because
 * the alternative is a map that samples garbage at one corner.
 */
export function createPaintedMap(
  res: number = PAINTED_RES,
  size: number = PAINTED_SIZE,
  height?: Float32Array,
): PaintedMap {
  if (!Number.isInteger(res) || res < 2) throw new Error(`painted map: res must be >= 2, got ${res}`);
  if (!(size > 0)) throw new Error(`painted map: size must be positive, got ${size}`);
  if (height && height.length !== res * res) {
    throw new Error(`painted map: height must hold ${res * res} floats, got ${height.length}`);
  }
  return { res, size, height: height ?? new Float32Array(res * res) };
}

/** Every texel back to zero — the map, and with it the paint layer sharing
 * the buffer, is unpainted again. */
export function clearPaintedMap(map: PaintedMap): void {
  map.height.fill(0);
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
  const bytes = new Uint8Array(map.height.buffer, map.height.byteOffset, map.height.byteLength);
  return { res: map.res, size: map.size, height: encodeBase64(bytes) };
}

/** The inverse. Throws on a payload whose byte count is not the resolution it
 * claims — a half-read map would sample plausible garbage. */
export function deserializeMap(o: PaintedMapJson): PaintedMap {
  const bytes = decodeBase64(o.height);
  const floats = o.res * o.res;
  if (bytes.length !== floats * 4) {
    throw new Error(`painted map: expected ${floats * 4} bytes for res ${o.res}, got ${bytes.length}`);
  }
  const height = new Float32Array(floats);
  new Uint8Array(height.buffer).set(bytes);
  return createPaintedMap(o.res, o.size, height);
}
