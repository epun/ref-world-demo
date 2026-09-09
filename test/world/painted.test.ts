/**
 * The painted height map and the hook it hangs on — pure, no WebGL, no DOM.
 *
 * Two things are pinned here and they matter in different ways.
 *
 * The MAP (src/world/painted.ts) is a data structure shared texel for texel
 * with an `envpaint/core` paint layer, so its sampling has to agree with a
 * texture's: half-texel centres, bilinear between them, and — the one place
 * it deliberately differs — exactly zero outside instead of the border value
 * smeared outward.
 *
 * The HOOK (src/world/landscape.ts `setPaintedHeight`) sits inside the one
 * module allowed to know how high the ground is, so the load-bearing test is
 * that with nothing painted the world is the world: the authored terrain,
 * sample for sample, at 2,000 points. After that, that a painted constant
 * comes out as `terrace(field + constant)` — the expectation re-derived from
 * the module's own dials at each point, never a recorded number.
 *
 * THE LEVEL LAYER rides alongside the height one, same shape, same sharing,
 * `DRY` where there is no water — so it is pinned here on the same terms: it
 * is adopted by reference, it clears back to dry rather than to zero, and it
 * survives the round trip. A map saved before water existed carries no level
 * layer at all and has to load as a dry one, or every committed map breaks
 * the day the feature lands. (What a level MEANS — bodies, shores, the
 * distance field — is test/world/painted-water.test.ts.)
 *
 * THE MODE. Everything above is about the AUTHORED field a painted offset is
 * added to, and that field only exists in the landscape mode — the world
 * ships plain (src/world/landscape.ts `LandscapeMode`). So this file switches
 * the map on and puts it back. The plain world is paintable too, and that is
 * not an afterthought but the point of the mode (open flat, sculpt live): it
 * has a block of its own at the bottom.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  isWater,
  setLandscapeMode,
  setPaintedHeight,
  TERRAIN,
  terrainHeight,
  terrainNormal,
  terrainParams,
  WATER_BODIES,
  waterLevel,
  wobbledRadius,
} from '../../src/world/landscape';
import { ROLLING_SURFACE } from '../../src/world/surface';
import {
  clearPaintedMap,
  createPaintedMap,
  deserializeMap,
  DRY,
  paintedRange,
  paintedSampler,
  sampleHeight,
  serializeMap,
  PAINTED_RES,
  PAINTED_SIZE,
} from '../../src/world/painted';

beforeAll(() => setLandscapeMode('landscape'));
afterAll(() => setLandscapeMode('plain'));
afterEach(() => setPaintedHeight(null));

/** Deterministic probes over the field, the same sin-hash family the world
 * itself uses. Spread over ±180 so the far fade and the water bodies are
 * both in the sample. */
function probes(count: number, extent = 180): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
    const b = Math.sin(i * 269.5 + 183.3) * 43758.5453123;
    out.push([
      (a - Math.floor(a)) * 2 * extent - extent,
      (b - Math.floor(b)) * 2 * extent - extent,
    ]);
  }
  return out;
}

describe('painted map — sampling', () => {
  it('reads a texel back at its own centre', () => {
    const map = createPaintedMap(4, 400);
    // Texel (1, 2): centre at uv ((1 + 0.5) / 4, (2 + 0.5) / 4).
    map.height[2 * 4 + 1] = 7;
    const x = (1.5 / 4 - 0.5) * 400;
    const z = (2.5 / 4 - 0.5) * 400;
    expect(sampleHeight(map, x, z)).toBeCloseTo(7, 12);
  });

  it('is bilinear between four texel centres', () => {
    const map = createPaintedMap(4, 400);
    // A 2x2 block of known values; sample the exact middle of it.
    map.height[1 * 4 + 1] = 0;
    map.height[1 * 4 + 2] = 2;
    map.height[2 * 4 + 1] = 4;
    map.height[2 * 4 + 2] = 6;
    const x = (2 / 4 - 0.5) * 400; // between texel columns 1 and 2
    const z = (2 / 4 - 0.5) * 400; // between texel rows 1 and 2
    expect(sampleHeight(map, x, z)).toBeCloseTo((0 + 2 + 4 + 6) / 4, 12);
    // …and a quarter of the way across in x only.
    const qx = ((1.5 + 0.25) / 4 - 0.5) * 400;
    const qz = (1.5 / 4 - 0.5) * 400;
    expect(sampleHeight(map, qx, qz)).toBeCloseTo(0 + (2 - 0) * 0.25, 12);
  });

  it('is zero outside the map, and reaches zero continuously at the rim', () => {
    const map = createPaintedMap(8, 400);
    map.height.fill(3);
    const half = 400 / 2;
    for (const [x, z] of [
      [half + 0.001, 0],
      [-half - 0.001, 0],
      [0, half + 0.001],
      [0, -half - 0.001],
      [1e6, 1e6],
    ] as [number, number][]) {
      expect(sampleHeight(map, x, z)).toBe(0);
    }
    // The last half texel fades rather than stepping: at the very rim the
    // outside neighbour reads 0, so the value is half the painted one.
    expect(sampleHeight(map, half, 0)).toBeCloseTo(1.5, 12);
    // …and just inside the outermost texel centre it is the full value.
    const inner = (7.5 / 8 - 0.5) * 400;
    expect(sampleHeight(map, inner, inner)).toBeCloseTo(3, 12);
  });

  it('adopts an existing float array without copying it', () => {
    const shared = new Float32Array(16 * 16);
    const map = createPaintedMap(16, 400, shared);
    expect(map.height).toBe(shared);
    // A write through the original array is visible through the map — this
    // is the whole point: a paint layer stamps, the sampler sees it.
    shared[8 * 16 + 8] = 5;
    const at = (8.5 / 16 - 0.5) * 400;
    expect(sampleHeight(map, at, at)).toBeCloseTo(5, 12);
  });

  it('refuses an array of the wrong length', () => {
    expect(() => createPaintedMap(16, 400, new Float32Array(4))).toThrow();
  });

  it('starts dry, and adopts a level array by reference too', () => {
    const fresh = createPaintedMap(8, 400);
    expect(fresh.water.length).toBe(64);
    expect(Array.from(fresh.water).every((v) => v === DRY)).toBe(true);

    const shared = new Float32Array(16 * 16).fill(DRY);
    const map = createPaintedMap(16, 400, undefined, shared);
    expect(map.water).toBe(shared);
    shared[8 * 16 + 8] = 2.5;
    expect(map.water[8 * 16 + 8]).toBe(2.5);
  });

  it('refuses a level array of the wrong length', () => {
    expect(() => createPaintedMap(16, 400, undefined, new Float32Array(4))).toThrow();
  });

  it('clears height to zero and water to dry, in place', () => {
    // In place matters: the arrays are the paint layers' own buffers, so a
    // clear that replaced them would leave the brush stamping into the old
    // ones and the map would never come back.
    const height = new Float32Array(8 * 8).fill(3);
    const water = new Float32Array(8 * 8).fill(1.5);
    const map = createPaintedMap(8, 400, height, water);
    clearPaintedMap(map);
    expect(map.height).toBe(height);
    expect(map.water).toBe(water);
    expect(Array.from(height).every((v) => v === 0)).toBe(true);
    expect(Array.from(water).every((v) => v === DRY)).toBe(true);
  });

  it('reports the painted range, zero on an unpainted map', () => {
    const map = createPaintedMap(8, 400);
    expect(paintedRange(map)).toEqual({ min: 0, max: 0 });
    map.height[3] = 4.5;
    map.height[9] = -2.25;
    expect(paintedRange(map)).toEqual({ min: -2.25, max: 4.5 });
  });
});

describe('painted map — serialisation', () => {
  it('round-trips every texel exactly', () => {
    const map = createPaintedMap(32, 400);
    for (let i = 0; i < map.height.length; i++) {
      map.height[i] = Math.sin(i * 0.37) * 6.25;
    }
    const json = serializeMap(map);
    expect(json.res).toBe(32);
    expect(json.size).toBe(400);
    const back = deserializeMap(json);
    expect(back.res).toBe(map.res);
    expect(back.size).toBe(map.size);
    expect(Array.from(back.height)).toEqual(Array.from(map.height));
  });

  it('round-trips the shipped resolution, and the payload is json-safe text', () => {
    const map = createPaintedMap(PAINTED_RES, PAINTED_SIZE);
    map.height[0] = 1.5;
    map.height[map.height.length - 1] = -1.5;
    const json = serializeMap(map);
    expect(json.height).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(JSON.parse(JSON.stringify(json)).height).toBe(json.height);
    const back = deserializeMap(json);
    expect(back.height[0]).toBe(1.5);
    expect(back.height[back.height.length - 1]).toBe(-1.5);
  });

  it('serialises a copy, so painting on after a save cannot rewrite it', () => {
    const map = createPaintedMap(8, 400);
    const json = serializeMap(map);
    map.height.fill(9);
    expect(paintedRange(deserializeMap(json))).toEqual({ min: 0, max: 0 });
  });

  it('refuses a payload that is not the resolution it claims', () => {
    const small = serializeMap(createPaintedMap(8, 400));
    expect(() => deserializeMap({ ...small, res: 16 })).toThrow();
  });

  it('round-trips the level layer beside the height one', () => {
    const map = createPaintedMap(16, 400);
    for (let i = 0; i < map.water.length; i++) {
      map.water[i] = i % 3 === 0 ? DRY : Math.sin(i * 0.21) * 4;
    }
    map.height[7] = 1.25;
    const json = serializeMap(map);
    expect(json.water).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    const back = deserializeMap(json);
    expect(Array.from(back.water)).toEqual(Array.from(map.water));
    expect(back.height[7]).toBe(1.25);
    // A copy, like the height layer: painting on after a save cannot rewrite
    // the payload under the caller.
    map.water.fill(9);
    expect(deserializeMap(json).water[1]).toBe(back.water[1]);
  });

  it('loads a map saved before water existed as a dry one', () => {
    const map = createPaintedMap(8, 400);
    map.height[3] = 2;
    const { water: _dropped, ...old } = serializeMap(map);
    expect('water' in old).toBe(false);
    const back = deserializeMap(old);
    expect(back.height[3]).toBe(2);
    expect(Array.from(back.water).every((v) => v === DRY)).toBe(true);
  });

  it('refuses a level payload that is not the resolution it claims', () => {
    const small = serializeMap(createPaintedMap(8, 400));
    const big = serializeMap(createPaintedMap(16, 400));
    expect(() => deserializeMap({ ...small, water: big.water! })).toThrow();
  });
});

describe('the painted hook — parity with the authored world', () => {
  const points = probes(2000);

  it('changes nothing at all when no sampler is set', () => {
    const authored = points.map(([x, z]) => terrainHeight(x, z));
    // Reading it twice is the control: the module is deterministic.
    points.forEach(([x, z], i) => expect(terrainHeight(x, z)).toBe(authored[i]));
    setPaintedHeight(null);
    points.forEach(([x, z], i) => expect(terrainHeight(x, z)).toBe(authored[i]));
  });

  it('changes nothing with an all-zero map installed', () => {
    const authored = points.map(([x, z]) => terrainHeight(x, z));
    const map = createPaintedMap();
    setPaintedHeight(paintedSampler(map));
    points.forEach(([x, z], i) => {
      expect(terrainHeight(x, z)).toBe(authored[i]);
      // …and through the seam the world actually samples.
      expect(ROLLING_SURFACE.sampleHeight(x, z)).toBe(authored[i]);
    });
  });

  it('changes nothing outside the map, whatever is painted inside it', () => {
    const map = createPaintedMap();
    map.height.fill(6);
    const outside: [number, number][] = [
      [PAINTED_SIZE, 0],
      [0, -PAINTED_SIZE],
      [300, 300],
    ];
    const authored = outside.map(([x, z]) => terrainHeight(x, z));
    setPaintedHeight(paintedSampler(map));
    outside.forEach(([x, z], i) => expect(terrainHeight(x, z)).toBe(authored[i]));
  });
});

// ── the terrace, re-derived here from the module's own exported dials ────────
// Not imported: `terrace` is private to landscape.ts, and a test that shared
// the implementation could not catch it changing. These three lines are the
// same arithmetic written out from TERRAIN.terraceRiser and the live tierStep.

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function terraceOf(v: number): number {
  const step = terrainParams().tierStep;
  const k = Math.floor(v / step);
  const f = v / step - k;
  return step * (k + smoothstep(TERRAIN.terraceRiser[0], TERRAIN.terraceRiser[1], f));
}

/** Inverse of `t*t*(3-2*t)` on 0..1 — the closed form of the cubic. */
function unSmoothstep(y: number): number {
  return 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3);
}

/**
 * The smooth field at (x, z), recovered THROUGH the hook rather than read
 * out of the module (`smoothField` is private, and rightly so).
 *
 * `terracedLand` is `terrace(field + painted)`, so painting a known constant
 * `s` slides the field along the staircase. Land on a riser — where the
 * terrace is strictly increasing and therefore invertible — and the tier
 * index plus the inverted smoothstep give `field + s` exactly; subtract `s`.
 * The caller checks the answer against the authored height, so a wrong
 * recovery fails loudly instead of quietly weakening the assertion.
 */
function recoverField(x: number, z: number): number | null {
  const step = terrainParams().tierStep;
  const [r0, r1] = TERRAIN.terraceRiser;
  const tries = 24;
  for (let i = 0; i < tries; i++) {
    const s = (i / tries) * step;
    setPaintedHeight(() => s);
    const h = terrainHeight(x, z);
    const k = h / step;
    const y = k - Math.floor(k);
    // A plateau (y at 0 or 1) carries no information; keep sliding.
    if (y < 1e-6 || y > 1 - 1e-6) continue;
    const f = r0 + unSmoothstep(y) * (r1 - r0);
    return step * (Math.floor(k) + f) - s;
  }
  return null;
}

/** Probes clear of every basin's shore ramp, every island and the far fade —
 * where `terrainHeight` is `terracedLand` and nothing else. */
function openLandProbes(count: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [x, z] of probes(count * 6, 120)) {
    if (Math.hypot(x, z) >= TERRAIN.farStart) continue;
    let clear = true;
    for (const body of WATER_BODIES) {
      const d = Math.hypot(x - body.x, z - body.z);
      const edge = wobbledRadius(body, Math.atan2(z - body.z, x - body.x));
      if (d - edge < TERRAIN.shoreRamp * terrainParams().relief) clear = false;
    }
    if (!clear) continue;
    out.push([x, z]);
    if (out.length === count) break;
  }
  return out;
}

describe('the painted hook — a constant painted everywhere', () => {
  it('lifts the land to terrace(field + 1), point by point', () => {
    const points = openLandProbes(200);
    expect(points.length).toBe(200);

    for (const [x, z] of points) {
      setPaintedHeight(null);
      const authored = terrainHeight(x, z);

      const field = recoverField(x, z);
      expect(field, `field at ${x},${z}`).not.toBeNull();
      if (field === null) continue;
      // The recovery agrees with the world it was taken from.
      expect(terraceOf(field)).toBeCloseTo(authored, 6);

      setPaintedHeight(() => 1);
      expect(terrainHeight(x, z), `painted +1 at ${x},${z}`).toBeCloseTo(
        terraceOf(field + 1),
        6,
      );
    }
  });

  it('lifts it by exactly one tier when the constant IS a tier', () => {
    // The terrace is shift-equivariant by a whole step — terrace(v + step) is
    // terrace(v) + step — so this one needs no recovery at all, and it pins
    // that the offset really does go in before the terrace rather than after.
    const points = openLandProbes(200);
    const step = terrainParams().tierStep;
    const authored = points.map(([x, z]) => terrainHeight(x, z));
    setPaintedHeight(() => step);
    points.forEach(([x, z], i) => {
      expect(terrainHeight(x, z)).toBeCloseTo((authored[i] ?? 0) + step, 9);
    });
  });

  it('keeps every basin flat, at its own recomputed water level', () => {
    setPaintedHeight(() => 1);
    for (const body of WATER_BODIES) {
      const level = waterLevel(body);
      let found = 0;
      for (let i = 0; i < 32 && found < 6; i++) {
        const th = (i / 32) * Math.PI * 2;
        const x = body.x + Math.cos(th) * body.r * 0.8;
        const z = body.z + Math.sin(th) * body.r * 0.8;
        if (!isWater(x, z)) continue;
        found++;
        expect(terrainHeight(x, z), `${body.kind} at ${x},${z}`).toBeCloseTo(level, 9);
      }
      expect(found, `${body.kind} water samples`).toBeGreaterThan(0);
    }
  });

  it('raises the water level with the land it is cut into', () => {
    const before = WATER_BODIES.map((b) => waterLevel(b));
    setPaintedHeight(() => terrainParams().tierStep);
    WATER_BODIES.forEach((b, i) => {
      // The basin is cut from the terraced land at the body's centre, so one
      // painted tier under a pond lifts the pond by exactly one tier.
      expect(waterLevel(b)).toBeCloseTo((before[i] ?? 0) + terrainParams().tierStep, 9);
    });
  });
});

// ── the plain world is paintable ─────────────────────────────────────────────

describe('the painted hook — sculpting the world the room opens on', () => {
  /** Probes inside the far fade, where a height is whatever was painted and
   * nothing else — past `farStart` the ground settles onto the flat outer
   * disc, painted or authored, which the rim test below pins separately.
   * (`probes` walks a SQUARE, so a radial cut is not the same as a smaller
   * extent: the corners of a ±130 square reach 184.) */
  const inField = (count: number): [number, number][] =>
    probes(count, TERRAIN.farStart).filter(([x, z]) => Math.hypot(x, z) < TERRAIN.farStart - 10);

  /** Run `f` with the map switched off — the mode the world ships in — then
   * put this file's mode back. */
  function inPlain<T>(f: () => T): T {
    setLandscapeMode('plain');
    try {
      return f();
    } finally {
      setLandscapeMode('landscape');
    }
  }

  it('is exactly flat paper while nothing is painted', () => {
    inPlain(() => {
      for (const [x, z] of probes(400, 260)) {
        expect(terrainHeight(x, z), `${x},${z}`).toBe(0);
        expect(ROLLING_SURFACE.sampleHeight(x, z), `${x},${z}`).toBe(0);
        expect(terrainNormal(x, z), `${x},${z}`).toEqual({ x: 0, y: 1, z: 0 });
      }
      // …and an all-zero map installed changes not one sample of that.
      const map = createPaintedMap();
      setPaintedHeight(paintedSampler(map));
      for (const [x, z] of probes(400, 260)) expect(terrainHeight(x, z), `${x},${z}`).toBe(0);
    });
  });

  it('raises the flat field where it is painted — this is the whole point of the mode', () => {
    // 2026-09-09, user ask: the world opens flat and the environment is
    // sculpted live from there. A painted offset that the mode swallowed
    // would make the plain world the one world nobody can shape.
    inPlain(() => {
      const step = terrainParams().tierStep;
      setPaintedHeight(() => step);
      // Inside `farStart`: past it the far fade settles every height onto the
      // flat outer disc, painted or authored, which the rim test below pins.
      const points = inField(300);
      expect(points.length).toBeGreaterThan(100);
      for (const [x, z] of points) {
        // No authored field under it, so the painted tier IS the height —
        // terraced, exactly as an authored one would be…
        expect(terrainHeight(x, z), `${x},${z}`).toBeCloseTo(step, 9);
      }
      // …including in the hatch clearing, which the authored relief is gated
      // out of but a person's own hand is not.
      expect(terrainHeight(0, 0)).toBeCloseTo(step, 9);
      // …and through the seam the world actually samples.
      expect(ROLLING_SURFACE.sampleHeight(12, -8)).toBeCloseTo(step, 9);
    });
  });

  it('terraces a painted hill on the plain, the same way it terraces the map', () => {
    // A painted ramp comes out as a flight of treads, not a smooth swell —
    // the reason the offset goes in BEFORE the terrace (TASTE §3, and the ink
    // pass only draws elevation where there is a contour).
    inPlain(() => {
      const step = terrainParams().tierStep;
      // A gentle ramp across x, sampled well inside the far fade so the only
      // thing shaping the profile is the terrace.
      const ramp = (x: number): number => (x + 130) / 40;
      setPaintedHeight(ramp);
      const heights: number[] = [];
      const raw: number[] = [];
      for (let x = -120; x <= 120; x += 1) {
        heights.push(terrainHeight(x, 0));
        raw.push(ramp(x));
      }
      const onTread = (vs: number[]): number =>
        vs.filter((h) => Math.abs(h / step - Math.round(h / step)) < 1e-9).length;
      // A LINEAR ramp crosses a tier only at isolated points; the terraced
      // one holds each tread for a stretch, which is what the ink pass needs
      // to find a contour at all. That difference is the whole assertion.
      expect(onTread(raw)).toBeLessThan(5);
      expect(onTread(heights)).toBeGreaterThan(heights.length / 4);
      // …and it is still the same hill: never more than one tier off the
      // ramp it was painted as.
      heights.forEach((h, i) => expect(Math.abs(h - (raw[i] ?? 0))).toBeLessThanOrEqual(step));
    });
  });

  it('gives a painted hill real normals, where the bare plain has none', () => {
    inPlain(() => {
      // The bare plain: straight up, everywhere.
      expect(terrainNormal(30, 0)).toEqual({ x: 0, y: 1, z: 0 });
      // A ramp painted across x. The terraced surface is FLAT on its treads,
      // so only the risers tilt — walk the ramp and find them.
      setPaintedHeight((x) => x * 0.05);
      let tilted = 0;
      for (let x = 0; x <= 60; x += 0.25) {
        const n = terrainNormal(x, 0);
        expect(Math.hypot(n.x, n.y, n.z), `${x}`).toBeCloseTo(1, 12);
        // Whatever the sample, the tilt is against x and never across z: a
        // ramp in x has no gradient in z, painted or not.
        expect(Math.abs(n.z), `${x}`).toBeLessThan(1e-9);
        expect(n.x, `${x}`).toBeLessThanOrEqual(0);
        if (n.y < 0.999) tilted++;
      }
      // The risers are really there — a plain that swallowed the paint would
      // have reported straight up at every one of those samples.
      expect(tilted).toBeGreaterThan(10);
    });
  });

  it('settles onto the flat outer disc at the rim, mode or no mode', () => {
    inPlain(() => {
      setPaintedHeight(() => 3);
      // Past `farEnd` the ground is the flat ring, and a painted offset may
      // not lift it off the paper any more than an authored one may.
      for (const [x, z] of [[0, 300], [300, 0], [-260, 260]] as [number, number][]) {
        expect(terrainHeight(x, z), `${x},${z}`).toBe(0);
      }
    });
  });

  it('keeps the paint across the switch, in both directions', () => {
    // Toggling the map is a rebuild, never a re-authoring — and a person's
    // own hand is not part of the map, so it survives the trip.
    const step = terrainParams().tierStep;
    const points = inField(160);
    setPaintedHeight(() => step);
    const mapped = points.map(([x, z]) => terrainHeight(x, z));
    const plain = inPlain(() => points.map(([x, z]) => terrainHeight(x, z)));
    // Still painted in the plain world…
    expect(plain.every((h) => Math.abs(h - step) < 1e-9)).toBe(true);
    // …and the mapped world comes back exactly as it was.
    points.forEach(([x, z], i) => expect(terrainHeight(x, z)).toBe(mapped[i]));
  });
});
