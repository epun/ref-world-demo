/**
 * The bits every ghibli element shader needs, in one place (docs/TASTE.md §9,
 * docs/ghibli-port.md).
 *
 * Each module under `src/world/ghibli/` is a PORT of one envpaint element
 * shader (`/home/user/envpaint/src/elements/*.js`) onto this world's own
 * seams. Three things differ in every one of them, so they live here rather
 * than four times over:
 *
 *   - **the wind.** envpaint drives its blades from `uWindSpeed` / `uGust` /
 *     `uTime` and its own `windAtT`. This world already has one wind field
 *     with two mirrors (`src/world/wind.ts`) and the scatter's four uniform
 *     names, so the port is re-pointed at `refWindAt` and at
 *     `uWindTime / uWindDir / uWindStrength / uWindGust`. `createWindUniforms`
 *     is that uniform set; `setWindUniforms` is the once-a-frame write, and
 *     the caller passes it the SAME `WindField` the scatter is drawing
 *     (`Scatter.windField()`), so a blade and a tick never disagree about the
 *     weather.
 *   - **the layer stand-ins.** A `sampler2D` that is never bound is undefined
 *     behaviour, and the demo build installs no painted layers at all — so
 *     every layer uniform starts on a 1×1 texel that means "nothing painted
 *     here", exactly as `src/world/ground.ts` does for its own path layer.
 *   - **determinism.** `mulberry32` is envpaint's own PRNG, seeded from a
 *     per-module constant. No `Math.random` anywhere in this folder: the
 *     blade layout is part of the picture and two devices must lay it out
 *     identically, the same contract `src/world/scatter.ts` keeps.
 *
 * NO GRAIN, NO SHADOW MAP. Both deliberate, both for the reasons
 * `src/world/toon.ts` already sets out: grain is a full-frame post-process
 * (TASTE §2.7) so envpaint's `uGrain` lines are dropped, and the shadow term
 * is a constant 1.0 because the flat stamps are the cast shadows (TASTE §2.4).
 */

import { DataTexture, RGBAFormat, RedFormat, UnsignedByteType, Vector2 } from 'three';
import type { Texture } from 'three';
import type { WindField } from '../wind';

/**
 * A number that is always a glsl float literal (never `2` for `2.0`) — the
 * same helper `src/world/ground.ts` and `src/world/scatter.ts` keep, because
 * `2` in a float expression is a compile error on some drivers.
 */
export function ggFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/**
 * envpaint's deterministic 32-bit PRNG (`mulberry32`, verbatim), so a reload
 * — and a second device — lays out identical blades.
 *
 * Seeded from a module constant, never from a clock and never from
 * `Math.random`: the blade field is geometry, and geometry that differs
 * between two machines is a different picture.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The wind uniform set, by the scatter's four names. */
export interface GhibliWindUniforms {
  uWindTime: { value: number };
  uWindDir: { value: Vector2 };
  uWindStrength: { value: number };
  uWindGust: { value: number };
}

/**
 * Mirrors of the scatter's own clamp (`WIND_STRENGTH_MIN/MAX`), re-declared
 * rather than imported: nothing in this folder may depend on
 * `src/world/scatter.ts`, which another delegate owns. Keep the two in step
 * — they are the same dial.
 */
export const GG_WIND_STRENGTH_MIN = 0.05;
export const GG_WIND_STRENGTH_MAX = 1.5;

export function createWindUniforms(): GhibliWindUniforms {
  return {
    uWindTime: { value: 0 },
    uWindDir: { value: new Vector2(1, 0) },
    uWindStrength: { value: GG_WIND_STRENGTH_MIN },
    uWindGust: { value: 0 },
  };
}

/**
 * One frame's wind write — three numbers and a direction, never a recompile.
 *
 * `timeMs` is wall-clock milliseconds and lands in the uniform as SECONDS,
 * which is the unit `refWindAt` and the scatter's `uWindTime` both take.
 */
export function setWindUniforms(
  uniforms: GhibliWindUniforms,
  field: WindField,
  timeMs: number,
): void {
  uniforms.uWindTime.value = timeMs / 1000;
  uniforms.uWindDir.value.set(field.dirX, field.dirZ);
  uniforms.uWindStrength.value = Math.min(
    GG_WIND_STRENGTH_MAX,
    Math.max(GG_WIND_STRENGTH_MIN, field.strength),
  );
  uniforms.uWindGust.value = Math.min(1, Math.max(0, field.gust));
}

/**
 * The same write, for a module that hands back a bare `ShaderMaterial`
 * instead of a handle object (the rock / canopy / cloud / water materials —
 * they are SWAPS for materials the scatter and the water already own, so
 * they cannot grow an interface of their own).
 *
 * A material without the four uniforms is left alone, so this is safe to call
 * over a list that mixes ghibli materials with stock ones.
 */
export function setWindOnMaterial(
  material: { uniforms: Record<string, { value: unknown }> },
  field: WindField,
  timeMs: number,
): void {
  const u = material.uniforms;
  if (u.uWindTime === undefined || u.uWindDir === undefined) return;
  setWindUniforms(u as unknown as GhibliWindUniforms, field, timeMs);
}

/** A 1×1 single-channel zero: "nothing painted here". */
export function emptyLayerTexture(): DataTexture {
  const tex = new DataTexture(new Uint8Array([0]), 1, 1, RedFormat);
  tex.needsUpdate = true;
  return tex;
}

/**
 * A 1×1 rest texel for the PRESS layer: direction neutral (0.5, 0.5 decodes
 * to a zero push vector) and zero force, so a field with nothing rolling
 * over it stands up straight. The layer itself is deferred —
 * docs/ghibli-port.md.
 */
export function restPressTexture(): DataTexture {
  const tex = new DataTexture(
    new Uint8Array([128, 128, 0, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  tex.needsUpdate = true;
  return tex;
}

/**
 * A 1×1 neutral texel for the COMB layer (`src/world/comb.ts`'s
 * `COMB_NEUTRAL` in both channels): nothing parted, so the global lean holds.
 */
export function neutralCombTexture(): DataTexture {
  const tex = new DataTexture(
    new Uint8Array([128, 128, 0, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  tex.needsUpdate = true;
  return tex;
}

/**
 * The scatter's own smooth 1-D value noise, renamed `ggWindNoise`.
 *
 * COPIED, not imported (the scatter belongs to another delegate), and
 * renamed so that concatenating this block beside `WIND_FIELD_GLSL` and
 * `src/world/toon.ts`'s `toon*` chain can never declare one function twice —
 * which is a compile error, and the one thing
 * `test/world/ghibli/*.test.ts` checks on every chunk.
 *
 * It carries the FLUTTER and the cloud drift: the gust-front field
 * (`refWindAt`) is the right read for a lean arriving, and this smooth field
 * is the right read for a lateral drift that must never snap or arrest
 * (TASTE §2.1, and the same split `src/world/scatter.ts` documents for its
 * cloud profile).
 */
export const GG_WIND_NOISE_GLSL = /* glsl */ `
float ggWindHash(float n) { return fract(sin(n) * 43758.5453123); }
float ggWindNoise(float t, float seed) {
  float i = floor(t);
  float f = t - i;
  float u = f * f * (3.0 - 2.0 * f);
  float a = ggWindHash(i * 127.1 + seed * 311.7);
  float b = ggWindHash((i + 1.0) * 127.1 + seed * 311.7);
  return (a + (b - a) * u) * 2.0 - 1.0;
}`;

/**
 * The scatter's per-instance shape variation, as a standalone block.
 *
 * COPIED from `variationBeginGlsl` in `src/world/scatter.ts` (same constants:
 * `VARIATION_SCALE_XZ` 0.07, `VARIATION_SCALE_Y` 0.05, `VARIATION_BULGE`
 * 0.04, `VARIATION_LEAN_RAD` 0.0436) because a ghibli material REPLACES a
 * scatter material and has to carry everything that one did — an instanced
 * rock that lost its variation would suddenly be a field of identical
 * stones. Declare `attribute vec4 aVariation;` yourself and call
 * `ggVariation(pos)` on the object-space position first, before any wind.
 *
 * Keep in lockstep with `applyInstanceVariation` on the CPU side.
 */
export const GG_VARIATION_GLSL = /* glsl */ `
vec3 ggVariation(vec3 p, vec4 v) {
  vec3 q = p * vec3(
    1.0 + (v.x - 0.5) * 0.14,
    1.0 + (v.z - 0.5) * 0.10,
    1.0 + (v.y - 0.5) * 0.14);
  float varPhase = v.w * 6.2831853;
  float varBulge = 1.0 + 0.04 * sin(q.y * 1.7 + varPhase * 3.0);
  q.xz *= varBulge;
  float varLean = (fract(v.w * 7.13) - 0.5) * 0.0872;
  q.xz += vec2(cos(varPhase), sin(varPhase)) * (varLean * max(q.y, 0.0));
  return q;
}`;

/** Every module's layer handles, so `setLayers` reads the same everywhere. */
export interface GhibliLayers {
  grass?: Texture | null;
  flowers?: Texture | null;
  comb?: Texture | null;
  press?: Texture | null;
  path?: Texture | null;
  mask?: Texture | null;
}
