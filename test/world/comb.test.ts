/**
 * The comb (src/world/comb.ts) and the lean it puts on a grass mark at
 * PLACEMENT (src/world/scatter.ts).
 *
 * Two halves, and the second is the one worth having: decoding a direction
 * layer is arithmetic, but "a combed cell tips its tufts over" is the whole
 * feature, and it lives in an instance matrix rather than in a return value.
 * So the second block builds a real scatter over a real painted comb and
 * measures where the mark's own +y ended up.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Matrix4, Vector3, type InstancedMesh, type Object3D } from 'three';
import {
  COMB_LEAN_MAX,
  COMB_MIN,
  COMB_NEUTRAL,
  combLean,
  decodeComb,
  sampleComb,
} from '../../src/world/comb';
import { setPaintedLean, setPaintedPlanting } from '../../src/world/landscape';
import { createScatter, KIND_GROUP_LABELS } from '../../src/world/scatter';
import { zeroPlanting, type PlantingWeights } from '../../src/world/painted';
import { FLAT_SURFACE } from '../../src/world/surface';

const RES = 16;
const SIZE = 400;

describe('the comb layer', () => {
  it('reads a neutral texel, and an unset one, as no comb at all', () => {
    expect(decodeComb(COMB_NEUTRAL, COMB_NEUTRAL)).toEqual({ x: 0, z: 0 });
    // The one value that is NOT neutral in the encoding and has to be: a
    // buffer nobody has painted, and a map written before the comb existed.
    expect(decodeComb(0, 0)).toEqual({ x: 0, z: 0 });
  });

  it('decodes a painted heading, and answers nothing off the map', () => {
    const data = new Float32Array(RES * RES * 2).fill(COMB_NEUTRAL);
    // One texel combed hard along +x, at the centre of the layer.
    const tx = RES / 2;
    const ty = RES / 2;
    data[(ty * RES + tx) * 2] = 1;
    data[(ty * RES + tx) * 2 + 1] = COMB_NEUTRAL;
    const centre = ((tx + 0.5) / RES - 0.5) * SIZE;
    const got = sampleComb(data, RES, SIZE, centre, ((ty + 0.5) / RES - 0.5) * SIZE);
    expect(got.x).toBeCloseTo(1, 5);
    expect(got.z).toBeCloseTo(0, 5);
    // Off the square: exactly nothing, never the border value.
    expect(sampleComb(data, RES, SIZE, SIZE, 0)).toEqual({ x: 0, z: 0 });
    expect(sampleComb(null, RES, SIZE, 0, 0)).toEqual({ x: 0, z: 0 });
  });

  it('turns a heading into a capped lean about the right axis', () => {
    expect(combLean({ x: 0, z: 0 })).toBeNull();
    expect(combLean({ x: COMB_MIN * 0.5, z: 0 })).toBeNull();
    const lean = combLean({ x: 1, z: 0 });
    expect(lean).not.toBeNull();
    expect(lean!.lean).toBeCloseTo(COMB_LEAN_MAX, 6);
    // The axis is the one that carries +y toward the comb direction — check
    // it by rotating, rather than by re-deriving the same formula.
    const tipped = new Vector3(0, 1, 0).applyAxisAngle(
      new Vector3(lean!.axisX, 0, lean!.axisZ),
      lean!.lean,
    );
    expect(tipped.x).toBeGreaterThan(0.4);
    expect(tipped.z).toBeCloseTo(0, 5);
    // …and a half-strength comb leans half as far.
    expect(combLean({ x: 0.5, z: 0 })!.lean).toBeCloseTo(COMB_LEAN_MAX * 0.5, 6);
  });
});

describe('the comb at placement', () => {
  afterEach(() => {
    setPaintedPlanting(null);
    setPaintedLean(null);
  });

  /** Every grass mark's own up-vector, in world axes. */
  function grassUps(): Vector3[] {
    const scatter = createScatter({ surface: FLAT_SURFACE });
    const ups: Vector3[] = [];
    const matrix = new Matrix4();
    const up = new Vector3();
    scatter.group.traverse((o: Object3D) => {
      if (!o.name.startsWith(KIND_GROUP_LABELS.grass) && !o.name.startsWith('grass-')) return;
      const mesh = o as InstancedMesh;
      if (typeof mesh.getMatrixAt !== 'function') return;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        up.set(0, 1, 0).transformDirection(matrix).normalize();
        ups.push(up.clone());
      }
    });
    scatter.dispose();
    return ups;
  }

  it('leans the tufts of a combed field, and leaves an uncombed one upright', () => {
    // A field of painted grass everywhere, so there are tufts to lean.
    const everywhere = (): PlantingWeights => ({ ...zeroPlanting(), grass: 1 });
    setPaintedPlanting(everywhere);

    const upright = grassUps();
    expect(upright.length).toBeGreaterThan(0);
    for (const u of upright) expect(u.y).toBeGreaterThan(0.999);

    // …now comb the whole field hard along +x.
    setPaintedLean(() => ({ dirX: 1, dirZ: 0 }));
    const leaned = grassUps();
    expect(leaned.length).toBe(upright.length);
    for (const u of leaned) {
      // Tipped by the full cap, and tipped the way the comb points.
      expect(u.y).toBeCloseTo(Math.cos(COMB_LEAN_MAX), 4);
      expect(u.x).toBeCloseTo(Math.sin(COMB_LEAN_MAX), 4);
    }
  });
});
