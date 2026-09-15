/**
 * The gust-front wind field — PURE (no Three.js, no DOM, no clocks, no
 * Math.random).
 *
 * Ported verbatim from envpaint's `windAtT` (its `src/core/shaders/toon.glsl.js`)
 * and its CPU mirror `Wind.sampleAt` (`src/core/Wind.js`). The point of the
 * port is the *read*: the scatter's old gust was two octaves of 1D value
 * noise in time, which makes a field **breathe in place**. This field is
 * gust CELLS stretched three to four times ALONG the wind that race
 * downwind, sharpened into fronts with calm paper between them, with a fast
 * cat's-paw ripple riding on top — which is what makes a field read as
 * **blown**. [D] (`threeD` is not observed in either brief — TASTE §1 — so
 * how the wind is modelled is ours to make and to label; what is NOT ours is
 * the motion law it has to obey, and it does: the field is a smooth product
 * of smoothstepped noise and a squared sine, so it has no discontinuity, no
 * overshoot and no arrest anywhere in it. TASTE §2.1.)
 *
 * TWO MIRRORS, ONE LAW. `windAt` (this file) and `WIND_FIELD_GLSL`
 * (`refWindAt`, injected into the scatter's vertex wind) are the same
 * arithmetic in two languages, down to the hash. That is load-bearing, not
 * tidiness: `src/world/rocks.ts` pushes small stones around with the CPU
 * sampler while the shader bends the grass with the GPU one, and if the two
 * disagreed a rock would skitter against a still tuft. `test/world/wind.test.ts`
 * pins `windAt` against numbers taken from envpaint's own `Wind.sampleAt`.
 * Edit neither half alone.
 *
 * Determinism: hash → noise → fbm is float arithmetic on the sample point
 * and the wind time. No clock is read here and no state is kept, so the same
 * (x, z, t) is the same wind on every device — the discipline the scatter's
 * header sets out, extended to the weather.
 */

/** Live wind, as both mirrors read it. Direction is expected unit-length. */
export interface WindField {
  dirX: number;
  dirZ: number;
  /** Overall amplitude (the scatter clamps this — `clampWindStrength`). */
  strength: number;
  /** Multiplies the wind clock: how fast the fronts travel. */
  speed: number;
  /** The slow wandering gust envelope, 0–1 (`gustAt`). */
  gust: number;
}

const fract = (x: number): number => x - Math.floor(x);

/** envpaint's `hash21`: sine-free float bit-mixing, GLSL `fract(p.xyx * 0.1031)`. */
function windHash21(x: number, y: number): number {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1031);
  let pz = fract(x * 0.1031);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
}

/** Value noise in [0, 1], smoothstep interpolation. */
function windVnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = windHash21(ix, iy);
  const b = windHash21(ix + 1, iy);
  const c = windHash21(ix, iy + 1);
  const d = windHash21(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uy;
}

/** Fractal sum of `windVnoise`, roughly [0, 1]. Three octaves, as envpaint. */
function windFbm(x: number, y: number, octaves = 3): number {
  let v = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  const n = Math.min(5, Math.max(1, octaves | 0));
  for (let i = 0; i < n; i++) {
    v += amp * windVnoise(px, py);
    px = px * 2.02 + 17.0;
    py = py * 2.02 + 17.0;
    amp *= 0.5;
  }
  return v;
}

/** GLSL smoothstep. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Wind push at a ground point, in world x/z. `tSeconds` is wall-clock
 * seconds; the field multiplies it by `f.speed` itself, exactly as the
 * shader's `refWindAt` receives an already-scaled wind clock from its
 * caller and envpaint's `sampleAt` scales by `uWindSpeed`.
 *
 * Magnitude runs roughly 0.08–1.4 × strength: the front peaks are an order
 * above the calm between them, which is the whole point of the field.
 */
export function windAt(
  x: number,
  z: number,
  tSeconds: number,
  f: WindField,
): { x: number; z: number } {
  const t = tSeconds * f.speed;
  // Along/across the wind. Cells are sampled at 0.07 along against 0.4
  // across, so a gust is ~6x longer downwind than it is wide: a front, not
  // a blob.
  const along = x * f.dirX + z * f.dirZ;
  const across = -x * f.dirZ + z * f.dirX;
  // The cell field itself, racing downwind (-t) and sharpened by the
  // smoothstep into fronts with calm paper between them.
  let g = windFbm(along * 0.07 - t * 0.7, across * 0.4 + 3.1, 3);
  g = smoothstep(0.3, 0.62, g * 1.15);
  // The cat's-paw: a fast squared ripple travelling along the wind, gated by
  // the front so calm paper stays calm.
  let wave = Math.sin(along * 0.55 - t * 3.6) * 0.5 + 0.5;
  wave *= wave;
  const m =
    f.strength * (0.18 + 0.82 * g) * (0.75 + 0.5 * wave * g) * (0.6 + 0.8 * f.gust);
  return { x: f.dirX * m, z: f.dirZ * m };
}

/**
 * The slow wandering gust envelope, 0–1 — envpaint's `Wind.update` random
 * walk made PURE IN TIME.
 *
 * Its version integrated a smoothed follow of `fbm(t*0.23, t*0.11+5.7, 3)`
 * toward the noise, which makes the value a function of frame history: two
 * devices at the same wall clock would disagree, and the scatter's whole
 * contract is that they do not. The follow was only smoothing an already
 * smooth field, so dropping it costs nothing and buys determinism. The
 * `gustiness 0.5` scaling envpaint applies (`_gust * gustiness * 2`) is
 * identity at its own default, so this is the same curve it ships.
 */
export function gustAt(tSeconds: number): number {
  const g = windFbm(tSeconds * 0.23, tSeconds * 0.11 + 5.7, 3);
  return Math.min(1, Math.max(0, g));
}

/**
 * The GPU half. Declares `refWindAt` plus its own noise chain, namespaced
 * `wind*` so it can be appended beside the scatter's existing `windHash` /
 * `windNoise` without a duplicate function name — the scatter injects both
 * blocks into one shader.
 *
 * Keep in lockstep with `windAt` above.
 */
export const WIND_FIELD_GLSL = `
float windHash21(vec2 p) {
  vec3 p3 = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float windVnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = windHash21(i);
  float b = windHash21(i + vec2(1.0, 0.0));
  float c = windHash21(i + vec2(0.0, 1.0));
  float d = windHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float windFbm(vec2 p, int octaves) {
  float v = 0.0;
  float amp = 0.5;
  vec2 q = p;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    v += amp * windVnoise(q);
    q = q * 2.02 + 17.0;
    amp *= 0.5;
  }
  return v;
}
vec2 refWindAt(vec2 p, float t, vec2 dir, float strength, float gust) {
  vec2 perp = vec2(-dir.y, dir.x);
  float along = dot(p, dir);
  float across = dot(p, perp);
  float g = windFbm(vec2(along * 0.07 - t * 0.7, across * 0.4 + 3.1), 3);
  g = smoothstep(0.30, 0.62, g * 1.15);
  float wave = sin(along * 0.55 - t * 3.6) * 0.5 + 0.5;
  wave *= wave;
  float m = strength * (0.18 + 0.82 * g) * (0.75 + 0.5 * wave * g) * (0.6 + 0.8 * gust);
  return dir * m;
}
`;
