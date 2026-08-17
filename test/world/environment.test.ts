/**
 * Environment engine tests — pure node, no WebGL. The engine takes
 * structural deps (light slices, ink setters, a background callback), so
 * everything here runs against plain fakes.
 */

import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  createEnvironment,
  daylight,
  sunArc,
  sunDirection,
  WEATHER,
  WEATHER_NAMES,
  WIND_OVERRIDE_MAX,
  type EnvironmentDeps,
  type WeatherPreset,
} from '../../src/world/environment';
import type { InkEnvironment } from '../../src/world/ink';
import { KEY_DIRECTION } from '../../src/world/lighting';

const BASE_KEY = 0.95;
const BASE_FILL = 2.85;

interface FakeDeps extends EnvironmentDeps {
  lighting: { key: { intensity: number; position: Vector3 }; fill: { intensity: number } };
  lastInk: InkEnvironment | null;
  lastKeyDir: Vector3;
  lastBackground: number;
}

function makeDeps(): FakeDeps {
  const deps: FakeDeps = {
    lighting: {
      key: { intensity: BASE_KEY, position: new Vector3() },
      fill: { intensity: BASE_FILL },
    },
    lastInk: null,
    lastKeyDir: new Vector3(),
    lastBackground: 1,
    ink: {
      setKeyDirection(direction: Vector3): void {
        deps.lastKeyDir.copy(direction);
      },
      setEnvironment(env: InkEnvironment): void {
        deps.lastInk = { ...env };
      },
    },
    setBackground(lumaScale: number): void {
      deps.lastBackground = lumaScale;
    },
  };
  return deps;
}

/** Advance well past the primary settle window in frame-sized steps. */
function settle(env: { update(dt: number, nowMs: number): void }, ms = 10000): void {
  for (let t = 0; t < ms; t += 16) env.update(16, t);
}

describe('weather catalogue', () => {
  it('covers every advertised name with a complete, finite preset', () => {
    const fields: (keyof WeatherPreset)[] = [
      'keyMul',
      'fillMul',
      'hatchMul',
      'exposureMul',
      'fogAmt',
      'streakDensity',
      'wind',
    ];
    for (const name of WEATHER_NAMES) {
      const preset = WEATHER[name];
      expect(preset).toBeDefined();
      for (const field of fields) {
        const v = preset[field];
        expect(typeof v, `${name}.${field}`).toBe('number');
        expect(Number.isFinite(v as number), `${name}.${field}`).toBe(true);
      }
      expect([null, 'rain', 'snow']).toContain(preset.streaks);
      // No streak kind → no streak coverage.
      if (preset.streaks === null) expect(preset.streakDensity).toBe(0);
    }
    expect(Object.keys(WEATHER).sort()).toEqual([...WEATHER_NAMES].sort());
  });

  it('keeps clear as the identity preset', () => {
    expect(WEATHER.clear).toEqual({
      keyMul: 1,
      fillMul: 1,
      hatchMul: 1,
      exposureMul: 1,
      fogAmt: 0,
      streaks: null,
      streakDensity: 0,
      wind: 0.3,
    });
  });

  it('carries the calibrated wind strength per weather', () => {
    // Even clear air breathes (0.3); fog hangs almost still; rain leans in
    // hardest but stays measured — never stormy.
    expect(WEATHER.clear.wind).toBe(0.3);
    expect(WEATHER.overcast.wind).toBe(0.45);
    expect(WEATHER.fog.wind).toBe(0.15);
    expect(WEATHER.rain.wind).toBe(0.7);
    expect(WEATHER.snow.wind).toBe(0.4);
    for (const name of WEATHER_NAMES) {
      expect(WEATHER[name].wind).toBeGreaterThan(0); // nothing ever fully still
      expect(WEATHER[name].wind).toBeLessThanOrEqual(1); // nothing ever stormy
    }
  });

  it('keeps streak coverage sparse — nothing packed', () => {
    for (const name of WEATHER_NAMES) {
      expect(WEATHER[name].streakDensity).toBeLessThanOrEqual(0.6);
    }
  });
});

describe('sun arc', () => {
  it('peaks at noon and sits below the horizon at midnight', () => {
    const noon = sunArc(0.5).altitude;
    expect(noon).toBeGreaterThan(0);
    for (const t of [0, 0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 1]) {
      expect(sunArc(t).altitude).toBeLessThanOrEqual(noon + 1e-12);
    }
    expect(sunArc(0).altitude).toBeLessThan(0);
    expect(sunArc(1).altitude).toBeLessThan(0);
    // Sunrise/sunset shoulders cross zero.
    expect(Math.abs(sunArc(0.25).altitude)).toBeLessThan(1e-9);
  });

  it('reproduces the calibrated key direction exactly at noon', () => {
    const dir = sunDirection(0.5);
    expect(dir.x).toBeCloseTo(KEY_DIRECTION.x, 6);
    expect(dir.y).toBeCloseTo(KEY_DIRECTION.y, 6);
    expect(dir.z).toBeCloseTo(KEY_DIRECTION.z, 6);
  });

  it('maps daylight 1 at noon, 0 at midnight', () => {
    expect(daylight(0.5)).toBe(1);
    expect(daylight(0)).toBe(0);
  });
});

describe('createEnvironment', () => {
  it('starts at clear noon, identical to the pre-environment render', () => {
    const deps = makeDeps();
    createEnvironment(deps);
    expect(deps.lighting.key.intensity).toBeCloseTo(BASE_KEY, 6);
    expect(deps.lighting.fill.intensity).toBeCloseTo(BASE_FILL, 6);
    expect(deps.lastInk?.exposure).toBeCloseTo(1, 6);
    expect(deps.lastInk?.fogAmt).toBe(0);
    expect(deps.lastKeyDir.distanceTo(KEY_DIRECTION)).toBeLessThan(1e-6);
    expect(deps.lastBackground).toBeCloseTo(1, 6);
  });

  it('sends the key to ~0 when the sun drops below the horizon', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setTimeOfDay(0);
    settle(env);
    expect(deps.lighting.key.intensity).toBeLessThan(BASE_KEY * 0.01);
    // Night exposure pulls the quantize bands down, never to black.
    expect(deps.lastInk!.exposure).toBeLessThan(0.6);
    expect(deps.lastInk!.exposure).toBeGreaterThan(0.4);
    // The background field dips in value too.
    expect(deps.lastBackground).toBeLessThan(0.8);
  });

  it('glides monotonically toward a weather target with no overshoot', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWeather('rain');
    const target = WEATHER.rain.exposureMul;
    let prev = env.state.exposure;
    for (let t = 0; t < 10000; t += 16) {
      env.update(16, t);
      const now = env.state.exposure;
      expect(now).toBeLessThanOrEqual(prev + 1e-9); // monotone toward target
      expect(now).toBeGreaterThanOrEqual(target - 1e-6); // never crosses it
      prev = now;
    }
    expect(prev).toBeCloseTo(target, 2);
    expect(env.state.rainAmt).toBeCloseTo(WEATHER.rain.streakDensity, 2);
    expect(env.state.snowAmt).toBeCloseTo(0, 3);
  });

  it('does not cut: one frame after a weather change the values have barely moved', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWeather('overcast');
    env.update(16, 0);
    // A 16ms step of a t.primary glide covers a sliver of the distance.
    expect(env.state.keyMul).toBeGreaterThan(0.98);
    expect(env.state.hatchMul).toBeGreaterThan(0.98);
  });

  it('blends any weather at intensity 0 back to exactly clear', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWeather('rain', 1);
    settle(env);
    env.setIntensity(0);
    settle(env);
    const s = env.state;
    expect(s.keyMul).toBeCloseTo(WEATHER.clear.keyMul, 3);
    expect(s.fillMul).toBeCloseTo(WEATHER.clear.fillMul, 3);
    expect(s.hatchMul).toBeCloseTo(WEATHER.clear.hatchMul, 3);
    expect(s.exposure).toBeCloseTo(1, 3);
    expect(s.fogAmt).toBeCloseTo(0, 3);
    expect(s.rainAmt).toBeCloseTo(0, 3);
    expect(s.snowAmt).toBeCloseTo(0, 3);
  });

  it('scales the blend with intermediate intensity', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWeather('fog', 0.5);
    settle(env);
    expect(env.state.fogAmt).toBeCloseTo(WEATHER.fog.fogAmt * 0.5, 2);
    expect(env.state.keyMul).toBeCloseTo((1 + WEATHER.fog.keyMul) / 2, 2);
  });

  it('ignores unknown weather names', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWeather('sharknado');
    expect(env.state.weather).toBe('clear');
  });

  it('glides the wind monotonically to the preset with no overshoot', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    expect(env.state.wind).toBeCloseTo(WEATHER.clear.wind, 6);
    env.setWeather('rain');
    const target = WEATHER.rain.wind;
    let prev = env.state.wind;
    for (let t = 0; t < 10000; t += 16) {
      env.update(16, t);
      const now = env.state.wind;
      expect(now).toBeGreaterThanOrEqual(prev - 1e-9); // monotone toward target
      expect(now).toBeLessThanOrEqual(target + 1e-6); // never crosses it
      prev = now;
    }
    expect(prev).toBeCloseTo(target, 2);
    // One frame after a change the wind has barely moved — never a cut.
    env.setWeather('fog');
    env.update(16, 0);
    expect(env.state.wind).toBeGreaterThan(target - 0.02);
  });

  it('scales the wind with intermediate intensity', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWeather('rain', 0.5);
    settle(env);
    expect(env.state.wind).toBeCloseTo(
      WEATHER.clear.wind + (WEATHER.rain.wind - WEATHER.clear.wind) * 0.5,
      2,
    );
  });

  it('setWindOverride pins the wind, survives weather changes, and null releases it', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWindOverride(1.2);
    expect(env.state.windOverride).toBe(1.2);
    settle(env);
    expect(env.state.wind).toBeCloseTo(1.2, 3);
    // Weather changes keep the override pinned.
    env.setWeather('fog');
    settle(env);
    expect(env.state.wind).toBeCloseTo(1.2, 3);
    // Release: the wind glides back to the weather-driven value.
    env.setWindOverride(null);
    expect(env.state.windOverride).toBeNull();
    settle(env);
    expect(env.state.wind).toBeCloseTo(WEATHER.fog.wind, 2);
    // The override clamps into [0, WIND_OVERRIDE_MAX].
    env.setWindOverride(99);
    expect(env.state.windOverride).toBe(WIND_OVERRIDE_MAX);
    env.setWindOverride(-4);
    expect(env.state.windOverride).toBe(0);
  });

  it('crossfades streak kinds through zero (rain → snow)', () => {
    const deps = makeDeps();
    const env = createEnvironment(deps);
    env.setWeather('rain', 1);
    settle(env);
    env.setWeather('snow');
    let maxRain = 0;
    for (let t = 0; t < 10000; t += 16) {
      env.update(16, t);
      maxRain = Math.max(maxRain, env.state.rainAmt);
    }
    // Rain only ever decays after the switch — no re-spray.
    expect(maxRain).toBeLessThanOrEqual(WEATHER.rain.streakDensity + 1e-6);
    expect(env.state.rainAmt).toBeCloseTo(0, 3);
    expect(env.state.snowAmt).toBeCloseTo(WEATHER.snow.streakDensity, 2);
  });
});
