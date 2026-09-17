/**
 * HOW BIG A BALL CAN GET, AND WHAT IT COSTS TO GET THERE.
 *
 * > User ask, 2026-09-17: *"we should allow for larger mass sizes than 10
 * > meters for users."*
 *
 * There was never a cap. `growth` is a cube root with no ceiling in it, and
 * `decideContact` has put SIZE FIRST since 2026-09-16 — so a ball whose radius
 * has passed a building's takes the building out of the ground whole, and the
 * `breakStrength: Infinity` on that row was only ever about the carrier that
 * is too small. What there was, was a PACE: at `GROWTH_K` 0.35 a 10 m ball
 * cost about 170 tree-sized items and a 20 m one about 1400, and nobody meets
 * 1400 trees. A threshold no pile ever meets is dead, which is the same thing
 * that was wrong with `breakStrength: 14` (src/creatures/sticky.ts).
 *
 * So this file is the LADDER, rung by rung, in the currency the game is
 * denominated in — and the three things that have to survive the top of it:
 *
 *   - every rung is reachable by the carry limit ALONE. No impact threshold,
 *     no `loose` round trip, no tier check: stones, then trees, then cars,
 *     then houses, then buildings, each one carried because the ball is now
 *     bigger than it is;
 *   - `growth` stays sane with Σr³ in the thousands — no NaN, no runaway,
 *     monotone, and still a cube root;
 *   - the SEAT arithmetic copes with an item of radius 4–8 u on a 5+ u ball:
 *     `clumpLocalOffset` is what every screen derives the same seat from, so
 *     an infinity or a NaN in it is a pile that disagrees across the room.
 *
 * Pure: no manager, no scene, no three.js. The manager end of the same ladder
 * — a building actually reported, decided and seated — is in
 * test/creatures/phone-host.test.ts and test/creatures/sticky.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  CLUMP_FIT,
  GROWTH_K,
  PICKUP_RATIO,
  STICKY,
  STUCK_COLLIDERS_MAX,
  carryLimit,
  ROLL_GROWTH,
  ROLL_MASS_ITEMS,
  clumpLocalOffset,
  decideContact,
  growth,
  rollTarget,
} from '../../src/creatures/sticky';
import { WORLD_SCALE } from '../../src/world/katamari/rules';
import { formatLength, metresOf } from '../../src/ui/size';

/** A hatchling's measured body radius — what the generator produces for a
 * small drawing, and the base every rung below is climbed from. */
const BASE_R = 0.9;

/** Diameter in metres → the body radius that reads as it. */
const radiusForMetres = (m: number): number => (m * WORLD_SCALE) / 2;
/** …and back, which is exactly what the ball-size readout does. */
const metresOfRadius = (r: number): number => metresOf(2 * r);

/** The volume one item of radius `r` contributes (`growth` drops the 4π/3). */
const vol = (r: number): number => r * r * r;

/** How much absorbed volume it takes to reach this body radius. */
function volumeFor(bodyR: number): number {
  const g = bodyR / BASE_R;
  return ((g * g * g - 1) * BASE_R ** 3) / GROWTH_K;
}

/** How many items of radius `r` that is. */
const itemsFor = (bodyR: number, r: number): number => Math.ceil(volumeFor(bodyR) / vol(r));

/**
 * The rungs, as the world actually places them. The radii are footprints, not
 * heights: a bench and a vending machine are the object library's `medium`
 * tier, a car its `large` one, and a building is `building` whichever source
 * the props came from.
 */
const RUNGS = [
  { what: 'stone', r: 0.5 },
  { what: 'tree', r: 1.2 },
  { what: 'car', r: 0.85 },
  { what: 'house', r: 2.5 },
  { what: 'building', r: 3.5 },
] as const;

describe('the pickup ladder', () => {
  it('climbs: each rung is reachable by the carry limit alone', () => {
    /*
     * The rung is "reachable" when a ball grown on the rung BELOW it is big
     * enough to carry this one: `bodyR * PICKUP_RATIO >= itemR` — no impact,
     * no tier, no threshold.
     */
    let bodyR = BASE_R;
    const climbed: { what: string; items: number; metres: number }[] = [];
    const volumes: number[] = [];
    for (const rung of RUNGS) {
      // Eat this rung until the ball could carry the next one up.
      const target = Math.max(rung.r, bodyR);
      let guard = 0;
      while (bodyR < target * 1.0 + 1e-9 && bodyR < rung.r) {
        volumes.push(vol(rung.r * 0.999));
        bodyR = BASE_R * growth(BASE_R, volumes);
        if (++guard > 100_000) break;
      }
      let items = 0;
      while (bodyR < rung.r * 3 && items < 100_000) {
        volumes.push(vol(rung.r));
        bodyR = BASE_R * growth(BASE_R, volumes);
        items++;
      }
      climbed.push({ what: rung.what, items, metres: Number(metresOfRadius(bodyR).toFixed(1)) });
      // This rung is now unambiguously inside the limit.
      expect(carryLimit(bodyR)).toBeGreaterThan(rung.r);
      expect(
        decideContact({
          itemR: rung.r,
          rooted: true,
          props: STICKY.building,
          impact: 0,
          carrierR: bodyR,
        }),
      ).toBe('stick');
    }
    // Every rung climbed, and the last one is a ball tens of metres across.
    expect(climbed).toHaveLength(RUNGS.length);
    expect(metresOfRadius(bodyR)).toBeGreaterThan(20);
  });

  it('reaches 10 m, 20 m and 40 m in numbers a person could actually meet', () => {
    const ten = radiusForMetres(10);
    const twenty = radiusForMetres(20);
    const forty = radiusForMetres(40);
    // The ladder the doc comment states. Upper bounds, so a future tuning
    // that made the game SLOWER fails here and says so.
    expect(itemsFor(ten, 1.2)).toBeLessThanOrEqual(20); // trees to 10 m
    expect(itemsFor(twenty, 2.5)).toBeLessThanOrEqual(20); // houses to 20 m
    expect(itemsFor(forty, 3.5)).toBeLessThanOrEqual(60); // buildings to 40 m
    // And a floor on each, so it is a climb rather than a cheat.
    expect(itemsFor(ten, 1.2)).toBeGreaterThan(3);
    expect(itemsFor(twenty, 2.5)).toBeGreaterThan(3);
  });

  it('does not double a hatchling on its first stone', () => {
    // The ceiling on GROWTH_K, and the reason it is 4 rather than 7: the
    // biggest first pickup is a stone at the very top of the carry limit,
    // which is PICKUP_RATIO times the carrier's own radius (1.15 since the
    // 2026-09-17 sticking reports — a little headroom, still not a doubling).
    const worst = growth(BASE_R, [vol(carryLimit(BASE_R))]);
    expect(PICKUP_RATIO).toBeCloseTo(1.15, 12);
    expect(worst).toBeLessThan(2);
    expect(worst).toBeCloseTo(Math.cbrt(1 + GROWTH_K * PICKUP_RATIO ** 3), 10);
    // …and the ordinary first stone is a bulge, not a transformation.
    expect(growth(BASE_R, [vol(0.5)])).toBeLessThan(1.35);
    // But it IS visible — the whole point of raising the number.
    expect(growth(BASE_R, [vol(0.5)])).toBeGreaterThan(1.1);
  });
});

describe('a building is not a wall', () => {
  const props = STICKY.building;

  it('sticks WHOLE once the ball is bigger than it, Infinity and all', () => {
    expect(props.breakStrength).toBe(Infinity);
    const itemR = 3.5;
    expect(
      decideContact({ itemR, rooted: true, props, impact: 0, carrierR: itemR + 0.01 }),
    ).toBe('stick');
    // Even at an impact that would burst a monolith: size is asked first.
    expect(
      decideContact({ itemR, rooted: true, props, impact: 999, carrierR: itemR + 0.01 }),
    ).toBe('stick');
  });

  it('still collapses in stages for a carrier that is too small', () => {
    const itemR = 3.5;
    // Under the carry limit and under the block line: pushed past, damaged.
    expect(decideContact({ itemR, rooted: true, props, impact: 7, carrierR: 2.4 })).toBe(
      'shove',
    );
    // Well under: a wall, exactly as before.
    expect(decideContact({ itemR, rooted: true, props, impact: 7, carrierR: 0.9 })).toBe(
      'block',
    );
    // And never `loose` — a building does not come out of the ground whole
    // for anybody who cannot simply carry it.
    for (const carrierR of [0.9, 1.5, 2.4, 3]) {
      expect(
        decideContact({ itemR, rooted: true, props, impact: 1e6, carrierR }),
      ).not.toBe('loose');
    }
  });

  it('is the same for a mountain, a monolith, a water tower and `large`', () => {
    // Nothing else in the table carries an opt-out. `cloud` does, and keeps
    // it: it is scenery in the sky, and stickiness 0 means never.
    for (const kind of ['mountain', 'monolith', 'waterTower', 'large'] as const) {
      const row = STICKY[kind];
      expect(row.stickiness).toBeGreaterThan(0);
      expect(
        decideContact({ itemR: 4, rooted: true, props: row, impact: 0, carrierR: 4.1 }),
      ).toBe('stick');
    }
    expect(STICKY.cloud.stickiness).toBe(0);
    expect(
      decideContact({ itemR: 1, rooted: true, props: STICKY.cloud, impact: 0, carrierR: 40 }),
    ).toBe('shove');
  });
});

describe('the arithmetic survives the top of the ladder', () => {
  it('growth stays finite, monotone and cube-root shaped with Σ in the thousands', () => {
    const volumes: number[] = [];
    let last = 1;
    for (let i = 0; i < 400; i++) {
      volumes.push(vol(3.5));
      const g = growth(BASE_R, volumes);
      expect(Number.isFinite(g)).toBe(true);
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
    const sum = volumes.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(10_000);
    // Still exactly the closed form — no clamp, no special case.
    expect(last).toBeCloseTo(Math.cbrt(1 + (GROWTH_K * sum) / BASE_R ** 3), 8);
    // …and a ball of this radius is eighty-odd metres across, which the
    // readout can say (see below) and the camera can frame
    // (src/world/camera.ts `followZoomFor`).
    expect(metresOfRadius(BASE_R * last)).toBeGreaterThan(80);
  });

  it('seats an item of radius 4–8 on a 5+ u ball without an infinity', () => {
    for (const itemR of [4, 5.5, 8]) {
      for (const R of [5, 9.4, 18.8]) {
        const g = R / BASE_R;
        const offset = clumpLocalOffset({
          itemX: R * 0.7,
          itemY: 1,
          itemZ: -R * 0.7,
          centreX: 0,
          centreY: 0,
          centreZ: 0,
          headingX: 0,
          headingZ: 1,
          selfR: BASE_R,
          itemR,
          seats: [],
          clumpWorldQ: { x: 0, y: 0, z: 0, w: 1 },
          growth: g,
        });
        for (const v of [offset.x, offset.y, offset.z]) expect(Number.isFinite(v)).toBe(true);
        /*
         * THE FIRST ITEM sits on the CHARACTER — its own radius plus the
         * item's sunk in by `CLUMP_FIT`, expressed in the clump's own
         * (unscaled) frame, so its length is `(baseR + itemR·CLUMP_FIT) /
         * growth` exactly, whatever the sizes (2026-09-17: there is no shell
         * to seat on, and everything after the first packs against the seats
         * already taken — `packSeatDistance`, tested in sticky.test.ts).
         */
        const want = (BASE_R + itemR * CLUMP_FIT) / g;
        expect(Math.hypot(offset.x, offset.y, offset.z)).toBeCloseTo(want, 8);
      }
    }
  });

  it('only ever gives colliders to the outermost handful, however big the pile', () => {
    // A 40 m ball is hundreds of items; the stand-ins are capped so the
    // solver is not handed one body per stone (src/creatures/manager.ts).
    expect(STUCK_COLLIDERS_MAX).toBe(24);
    expect(itemsFor(radiusForMetres(40), 3.5)).toBeGreaterThan(STUCK_COLLIDERS_MAX);
  });
});

describe('the readout still reads at the top of the ladder', () => {
  it('says metres alone past a hundred of them', () => {
    expect(formatLength(123)).toBe('123m');
    expect(formatLength(metresOfRadius(radiusForMetres(40) * 3))).toMatch(/^\d+m$/);
  });

  it('says both units at 10 m and 20 m, and is lowercase throughout', () => {
    const ten = formatLength(metresOfRadius(radiusForMetres(10)));
    const twenty = formatLength(metresOfRadius(radiusForMetres(20)));
    expect(ten).toMatch(/^10m \d+cm$/);
    expect(twenty).toMatch(/^20m \d+cm$/);
    for (const s of [ten, twenty, formatLength(123), formatLength(0.345)]) {
      expect(s).toBe(s.toLowerCase());
    }
  });
});

describe('when a creature stops walking and starts rolling', () => {
  /*
   * `rollTarget` had no test of its own — it was only ever exercised through
   * the manager, where the pace change moved which of its two thresholds
   * fires first (test/creatures/manager.test.ts). Both halves, pinned here.
   */
  it('rolls on the COUNT, whatever the mass', () => {
    // A handful of pebbles: no real growth, but three is a pile.
    expect(rollTarget(ROLL_MASS_ITEMS - 1, 1.0001)).toBe(0);
    expect(rollTarget(ROLL_MASS_ITEMS, 1.0001)).toBe(1);
  });

  it('rolls on the MASS, whatever the count', () => {
    // One thing its own size is more mass than three pebbles — and since
    // GROWTH_K became 4 that is exactly what the first body-sized pickup is.
    expect(rollTarget(1, ROLL_GROWTH - 0.001)).toBe(0);
    expect(rollTarget(1, ROLL_GROWTH)).toBe(1);
    const oneBodySized = growth(BASE_R, [vol(BASE_R)]);
    expect(oneBodySized).toBeGreaterThan(ROLL_GROWTH);
    expect(rollTarget(1, oneBodySized)).toBe(1);
  });

  it('walks again on an empty pile', () => {
    // Robbed: `growth` is exactly 1 with nothing carried, so both thresholds
    // fall away together and the creature walks. The two arguments always
    // arrive from the same clump, which is why this is the only empty case
    // that is reachable.
    expect(growth(BASE_R, [])).toBe(1);
    expect(rollTarget(0, growth(BASE_R, []))).toBe(0);
  });
});
