/**
 * Environment engine: time-of-day + weather for the ink world.
 *
 * Reference: /workspace/cellshader/src/environment.js — a sun-arc model
 * driving a key/sky palette with a weather catalogue layered on top. That
 * project is colorful; this one is monochrome ink, so every axis translates
 * to VALUE, never hue (TASTE — no neon, near-achromatic, grayscale test):
 *
 *   time of day  → key light direction along a stylized sun arc, a
 *                  pre-quantize exposure multiplier (night pulls the toon
 *                  bands down — still band-quantized, never smooth), and a
 *                  background value dip (SURFACE.ground scaled in luma).
 *   weather      → presets that rebalance key/fill (flatter bands), scale
 *                  hatch strength, dip exposure, wash depth with a banded
 *                  paper fog, and drift sparse ink/paper flecks (rain/snow)
 *                  through the composite. All achromatic by construction:
 *                  presets are pure scalars applied to token-derived values.
 *   wind         → a per-preset strength (mirroring cellshader's per-weather
 *                  `wind` driving its cloud drift) that scene.ts feeds into
 *                  the scatter's per-vertex sway via state.wind.
 *
 * TRANSITIONS ARE THE POINT: setWeather / setTimeOfDay / setIntensity only
 * retarget ζ≥1 springs at t.primary — a weather change is a slow drift of
 * every affected uniform, never a cut (TASTE §2.1, confidence 1.00).
 *
 * Stamped-shadow length/direction follows the sun arc via the read-only
 * `sun` getter below — scene.ts feeds it to FlatShadows/scatter each frame
 * (src/world/shadows.ts owns the ellipse math).
 *
 * Dependencies are injected so this module stays testable in node: the
 * lighting handles are structural (intensity + position), the ink surface is
 * the two setters InkPass exposes, and the background is a luma-scale
 * callback owned by scene.ts.
 */

import { Vector3 } from 'three';
import { Spring } from '../motion/spring';
import { MOTION } from '../taste/tokens';
import type { InkEnvironment } from './ink';
import { KEY_DIRECTION } from './lighting';

// ── weather catalogue ────────────────────────────────────────────────────────
// Mirrors the cellshader WEATHER structure, translated to monochrome: no
// tints, no sky colors — only value scalars and streak selection.

export type WeatherName = 'clear' | 'overcast' | 'fog' | 'rain' | 'snow';

export const WEATHER_NAMES: readonly WeatherName[] = [
  'clear',
  'overcast',
  'fog',
  'rain',
  'snow',
];

export type StreakKind = 'rain' | 'snow' | null;

export interface WeatherPreset {
  /** Multiplier on the calibrated key intensity (down = flatter bands). */
  keyMul: number;
  /** Multiplier on the calibrated fill intensity (up = flatter bands). */
  fillMul: number;
  /** Multiplier on the ink pass hatch strength. */
  hatchMul: number;
  /** Pre-quantize exposure multiplier (composes with the day/night ramp). */
  exposureMul: number;
  /** Depth-banded paper-wash amount, 0–1 (2–3 drawn layers, not smooth). */
  fogAmt: number;
  /** Which streak overlay the composite draws, if any. */
  streaks: StreakKind;
  /** Streak coverage at full intensity, 0–1. Kept low — nothing packed. */
  streakDensity: number;
  /**
   * Wind strength driving the scatter's per-vertex sway (grass ticks +
   * tree/conifer/bush crowns), mirroring cellshader's per-weather `wind`
   * scalar. Even clear air breathes; fog hangs almost still; rain leans in.
   */
  wind: number;
}

export const WEATHER: Record<WeatherName, WeatherPreset> = {
  // The identity preset: every other state blends over this one.
  clear: {
    keyMul: 1,
    fillMul: 1,
    hatchMul: 1,
    exposureMul: 1,
    fogAmt: 0,
    streaks: null,
    streakDensity: 0,
    wind: 0.3,
  },
  // Fill up / key down — the frame flattens; hatching thins; value dips a touch.
  overcast: {
    keyMul: 0.35,
    fillMul: 1.12,
    hatchMul: 0.55,
    exposureMul: 0.93,
    fogAmt: 0,
    streaks: null,
    streakDensity: 0,
    wind: 0.45,
  },
  // Depth washes toward the light token in banded steps — drawn layers of paper.
  // The air hangs nearly still in fog.
  fog: {
    keyMul: 0.55,
    fillMul: 1.05,
    hatchMul: 0.5,
    exposureMul: 0.97,
    fogAmt: 0.8,
    streaks: null,
    streakDensity: 0,
    wind: 0.15,
  },
  // Sparse diagonal ink hairlines drifting down the page; frame value down.
  // The strongest lean the world ever takes — still measured, never stormy.
  rain: {
    keyMul: 0.5,
    fillMul: 0.95,
    hatchMul: 0.85,
    exposureMul: 0.86,
    fogAmt: 0.3,
    streaks: 'rain',
    streakDensity: 0.55,
    wind: 0.7,
  },
  // Sparse light flecks swaying slowly downward; a thin distance wash.
  snow: {
    keyMul: 0.6,
    fillMul: 1.08,
    hatchMul: 0.6,
    exposureMul: 1,
    fogAmt: 0.35,
    streaks: 'snow',
    streakDensity: 0.5,
    wind: 0.4,
  },
};

// ── sun arc ──────────────────────────────────────────────────────────────────
// t ∈ [0, 1]: 0 = midnight, 0.5 = noon. A stylized altitude cosine (the same
// shape the cellshader's NOAA model produces over a day) anchored so that
// noon reproduces the calibrated KEY_DIRECTION exactly — the default frame is
// bit-identical to the pre-environment render.

/** Noon altitude: asin of the calibrated key's y (≈ 53°). */
const NOON_ALTITUDE = Math.asin(KEY_DIRECTION.y);

/** Noon azimuth, measured so noon lands on the calibrated key direction. */
const NOON_AZIMUTH = Math.atan2(KEY_DIRECTION.x, KEY_DIRECTION.z);

/** How far the azimuth sweeps over the full day (stylized, not geographic). */
const AZIMUTH_SWING = Math.PI * 1.4;

/** Below this altitude the sun contributes nothing (key fades to 0). */
const DUSK_START = -0.1;

/** Above this altitude it is fully day. */
const DAY_FULL = 0.25;

/** Whole-frame pre-quantize exposure at deep night (day = 1.0). */
const NIGHT_EXPOSURE = 0.55;

/** Background (sky/ground field) luma scale at deep night. */
const NIGHT_BACKGROUND = 0.72;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface SunArc {
  /** Altitude in radians; negative = below the horizon. */
  altitude: number;
  /** Azimuth in radians (world atan2(x, z) convention). */
  azimuth: number;
}

/** Sun altitude/azimuth for a time of day t ∈ [0, 1] (wrapped). */
export function sunArc(t: number): SunArc {
  const phase = ((t % 1) + 1) % 1;
  return {
    altitude: NOON_ALTITUDE * Math.cos((phase - 0.5) * 2 * Math.PI),
    azimuth: NOON_AZIMUTH + (phase - 0.5) * AZIMUTH_SWING,
  };
}

/**
 * World-space key direction for a time of day. The y component is floored a
 * touch above the horizon so the hatch threshold (which keys off this
 * direction) stays sane when the sun is down and the key is dark anyway.
 */
export function sunDirection(t: number, out: Vector3 = new Vector3()): Vector3 {
  const { altitude, azimuth } = sunArc(t);
  const cosAlt = Math.cos(altitude);
  return out
    .set(
      Math.sin(azimuth) * cosAlt,
      Math.max(Math.sin(altitude), 0.08),
      Math.cos(azimuth) * cosAlt,
    )
    .normalize();
}

/** Daylight factor, 0 at night → 1 in full day. */
export function daylight(t: number): number {
  return smoothstep(DUSK_START, DAY_FULL, sunArc(t).altitude);
}

// ── engine ───────────────────────────────────────────────────────────────────

/** Structural slice of a DirectionalLight the engine drives. */
export interface KeyLightLike {
  intensity: number;
  readonly position: Vector3;
}

/** Structural slice of a HemisphereLight the engine drives. */
export interface FillLightLike {
  intensity: number;
}

/** Structural slice of the InkPass surface the engine drives. */
export interface InkLike {
  setKeyDirection(direction: Vector3): void;
  setEnvironment(env: InkEnvironment): void;
}

export interface EnvironmentDeps {
  lighting: { key: KeyLightLike; fill: FillLightLike };
  ink: InkLike;
  /** Scale the scene background's luma (1 = the ground token as-is). */
  setBackground(lumaScale: number): void;
}

export interface EnvironmentState {
  weather: WeatherName;
  /** Requested time of day (spring target). */
  timeOfDay: number;
  /** Live gliding time of day. */
  timeOfDayLive: number;
  intensity: number;
  sunAltitude: number;
  daylight: number;
  /** The live exposure the ink pass is receiving this frame. */
  exposure: number;
  keyMul: number;
  fillMul: number;
  hatchMul: number;
  fogAmt: number;
  rainAmt: number;
  snowAmt: number;
  /** Live (spring-glided) wind strength — scene.ts feeds it to the scatter's
   * vertex wind each frame via scatter.setWind(state.wind, nowMs). */
  wind: number;
  /** The panel's wind override, or null when the weather drives it. */
  windOverride: number | null;
  keyIntensity: number;
  fillIntensity: number;
  backgroundScale: number;
}

/** Live sun read for the stamped-shadow pass (all spring-glided upstream). */
export interface SunState {
  /** Sun azimuth, radians (world atan2(x, z) convention). */
  azimuth: number;
  /** Sun altitude, radians; negative below the horizon. */
  altitude: number;
  /**
   * Stamp presence 0–1: daylight × the gliding weather key balance. keyMul
   * is the monochrome stand-in for cellshader's per-weather `shadow` scalar
   * — overcast/fog/rain flatten the light and the stamps fade with it, and
   * a sunken sun takes presence to 0 (hatching carries night shading).
   */
  presence: number;
}

export interface Environment {
  /** Glide to a weather state. Unknown names are ignored. */
  setWeather(name: string, intensity?: number): void;
  /** Glide to a time of day, t ∈ [0, 1] (0 midnight, 0.5 noon). */
  setTimeOfDay(t: number): void;
  /** Glide the weather blend strength over clear, 0–1. */
  setIntensity(v: number): void;
  /**
   * Override the wind strength (a panel slider), or pass null to hand it
   * back to the weather presets. Clamped to [0, WIND_OVERRIDE_MAX]; the
   * change glides on the same ζ≥1 spring as every other channel.
   */
  setWindOverride(v: number | null): void;
  readonly weatherNames: readonly WeatherName[];
  readonly state: EnvironmentState;
  /** Current sun azimuth/altitude/presence for the flat shadow stamps. */
  readonly sun: SunState;
  /** Advance the glide springs and push the frame's values into the deps. */
  update(dt: number, nowMs: number): void;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Ceiling for the panel's wind override — headroom over the rain preset
 * without ever letting the world read stormy (TASTE §2.1: measured, ambient). */
export const WIND_OVERRIDE_MAX = 1.5;

export function createEnvironment(deps: EnvironmentDeps): Environment {
  const { key, fill } = deps.lighting;
  // The calibrated intensities are the baseline every multiplier scales.
  const baseKey = key.intensity;
  const baseFill = fill.intensity;

  let weather: WeatherName = 'clear';
  let intensity = 1;
  let timeTarget = 0.5;

  // One spring per continuous channel — a weather or time change is a slow
  // drift of every affected value at t.primary, never a cut. ζ defaults to 1
  // (critically damped) so nothing can overshoot.
  const glide = (initial: number): Spring =>
    new Spring(initial, { settleMs: MOTION.primaryMs });

  const time = glide(0.5);
  const keyMul = glide(1);
  const fillMul = glide(1);
  const hatchMul = glide(1);
  const exposureMul = glide(1);
  const fogAmt = glide(0);
  const rainAmt = glide(0);
  const snowAmt = glide(0);
  const wind = glide(WEATHER.clear.wind);

  /** Non-null while the panel is holding the wind; weather changes still
   * retarget every other channel but leave the wind pinned here. */
  let windOverride: number | null = null;

  /** Retarget every weather channel at the current preset × intensity blend.
   * At intensity 0 the targets are exactly the clear preset. */
  const retargetWeather = (): void => {
    const preset = WEATHER[weather];
    const clear = WEATHER.clear;
    const blend = (a: number, b: number): number => a + (b - a) * intensity;
    keyMul.retarget(blend(clear.keyMul, preset.keyMul));
    fillMul.retarget(blend(clear.fillMul, preset.fillMul));
    hatchMul.retarget(blend(clear.hatchMul, preset.hatchMul));
    exposureMul.retarget(blend(clear.exposureMul, preset.exposureMul));
    fogAmt.retarget(blend(clear.fogAmt, preset.fogAmt));
    rainAmt.retarget(preset.streaks === 'rain' ? preset.streakDensity * intensity : 0);
    snowAmt.retarget(preset.streaks === 'snow' ? preset.streakDensity * intensity : 0);
    wind.retarget(windOverride ?? blend(clear.wind, preset.wind));
  };

  const direction = new Vector3().copy(KEY_DIRECTION);
  const inkEnv: InkEnvironment = {
    exposure: 1,
    fogAmt: 0,
    rainAmt: 0,
    snowAmt: 0,
    hatchMul: 1,
  };
  let lastDay = 1;
  let lastBackground = 1;

  const update = (dt: number, _nowMs: number): void => {
    const t = time.update(dt);
    const day = daylight(t);
    lastDay = day;
    sunDirection(t, direction);

    // Lights: the key follows the sun arc and dies below the horizon; the
    // fill carries the exposure and only rebalances with the weather.
    key.intensity = baseKey * day * keyMul.update(dt);
    key.position.copy(direction).multiplyScalar(50);
    fill.intensity = baseFill * fillMul.update(dt);

    // Ink composite: exposure ramp (night → darker quantize bands) composed
    // with the weather's exposure, plus fog/streak/hatch amounts.
    inkEnv.exposure = (NIGHT_EXPOSURE + (1 - NIGHT_EXPOSURE) * day) * exposureMul.update(dt);
    inkEnv.fogAmt = fogAmt.update(dt);
    inkEnv.rainAmt = rainAmt.update(dt);
    inkEnv.snowAmt = snowAmt.update(dt);
    inkEnv.hatchMul = hatchMul.update(dt);
    deps.ink.setKeyDirection(direction);
    deps.ink.setEnvironment(inkEnv);

    // Wind: no dep of its own — scene.ts reads state.wind after this update
    // and pushes it into the scatter's vertex-wind uniforms.
    wind.update(dt);

    // Night sky: the background field dips in value — achromatic, a luma
    // scale on the ground token, applied by scene.ts.
    lastBackground = NIGHT_BACKGROUND + (1 - NIGHT_BACKGROUND) * day;
    deps.setBackground(lastBackground);
  };

  // Settle the initial frame so the world renders consistently before the
  // first loop tick (noon, clear — identical to the pre-environment render).
  update(0, 0);

  return {
    setWeather(name: string, nextIntensity?: number): void {
      if (!(name in WEATHER)) return;
      weather = name as WeatherName;
      if (nextIntensity !== undefined) intensity = clamp01(nextIntensity);
      retargetWeather();
    },
    setTimeOfDay(t: number): void {
      timeTarget = clamp01(t);
      time.retarget(timeTarget);
    },
    setIntensity(v: number): void {
      intensity = clamp01(v);
      retargetWeather();
    },
    setWindOverride(v: number | null): void {
      windOverride =
        v === null ? null : Math.min(WIND_OVERRIDE_MAX, Math.max(0, v));
      retargetWeather();
    },
    weatherNames: WEATHER_NAMES,
    get sun(): SunState {
      const arc = sunArc(time.value);
      return {
        azimuth: arc.azimuth,
        altitude: arc.altitude,
        presence: lastDay * clamp01(keyMul.value),
      };
    },
    get state(): EnvironmentState {
      return {
        weather,
        timeOfDay: timeTarget,
        timeOfDayLive: time.value,
        intensity,
        sunAltitude: sunArc(time.value).altitude,
        daylight: lastDay,
        exposure: inkEnv.exposure,
        keyMul: keyMul.value,
        fillMul: fillMul.value,
        hatchMul: hatchMul.value,
        fogAmt: fogAmt.value,
        rainAmt: rainAmt.value,
        snowAmt: snowAmt.value,
        wind: wind.value,
        windOverride,
        keyIntensity: key.intensity,
        fillIntensity: fill.intensity,
        backgroundScale: lastBackground,
      };
    },
    update,
  };
}
