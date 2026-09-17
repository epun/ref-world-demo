/**
 * WHICH ELEMENT FIELDS EACH TIER LAYS OUT (src/world/ghibli/fields.ts,
 * src/world/device.ts `fieldPlanFor`).
 *
 * This is the 2026-09-17 user report turned into an assertion: *"let's remove
 * the grass shader for now, it's glitching"* / *"on mobile when you zoom out
 * the shader glitches out and looks like camo"*. A handset lays NO field at
 * all — not the dense near field, not the blooms and not the map-fixed base
 * field the 2026-09-16 work left it with — because at the phone's zoom floor
 * the base blade's pixel-width floor made every blade a 4.3-unit horizontal
 * dash and forty thousand independently tinted dashes is camo. The ghibli
 * ground shader carries the whole meadow there.
 *
 * The projection is untouched and that is the other half of the test: three
 * fields, base first so the dense near field draws over it.
 *
 * The decision lives in a pure function precisely so it can be asserted here,
 * with no canvas: `start` needs a WebGL context, `buildFields` needs three and
 * a seed.
 */

import { describe, expect, it } from 'vitest';
import { PHONE_DRAWS_GRASS, fieldPlanFor } from '../../../src/world/device';
import { buildFields } from '../../../src/world/ghibli/fields';

const deps = {
  height: null,
  region: null,
  nearSpan: 140,
  layers: { grass: null, flowers: null, comb: null },
};

describe('fieldPlanFor', () => {
  it('lays all three on a projection', () => {
    expect(fieldPlanFor('projection')).toEqual({ near: true, base: true, flowers: true });
  });

  it('lays none on a phone', () => {
    // The flag is the whole of the decision, so the test says so rather than
    // pinning the shipped value twice.
    expect(fieldPlanFor('phone')).toEqual({
      near: false,
      base: PHONE_DRAWS_GRASS,
      flowers: false,
    });
    expect(PHONE_DRAWS_GRASS).toBe(false);
  });
});

describe('buildFields', () => {
  it('adds NO field meshes on the phone tier', () => {
    const set = buildFields('phone', deps);
    expect(set.meshes).toEqual([]);
    expect(set.near).toBeNull();
    expect(set.base).toBeNull();
    expect(set.flowers).toBeNull();
  });

  it('adds three on a projection, base field first', () => {
    const set = buildFields('projection', deps);
    expect(set.meshes).toHaveLength(3);
    expect(set.base).not.toBeNull();
    expect(set.near).not.toBeNull();
    expect(set.flowers).not.toBeNull();
    // Draw order: the base field is submitted before the dense near field, so
    // the near one draws over it.
    expect(set.meshes[0]).toBe(set.base?.mesh);
    expect(set.meshes[1]).toBe(set.near?.mesh);
    expect(set.meshes[2]).toBe(set.flowers?.mesh);
    set.base?.dispose();
    set.near?.dispose();
    set.flowers?.dispose();
  });
});
