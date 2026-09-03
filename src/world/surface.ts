/**
 * The Surface seam (PLAN §7.2) — PURE (no Three.js, no DOM, no clocks, no
 * Math.random).
 *
 * §7.2 promised this from day one: **locomotion never touches world-space Y**.
 * Everything that needs to know how high the ground is — creatures, scatter,
 * water, shadow stamps, the ground mesh — samples a `Surface` and nothing
 * else derives a height of its own. That discipline is the whole cost of
 * keeping the sphere planet available later: `SphereSurface` implements the
 * same two methods and no caller changes.
 *
 * Two implementations ship today:
 *
 *   ROLLING_SURFACE  the world's authored terrain (src/world/landscape.ts).
 *   FLAT_SURFACE     y = 0 everywhere — the world before the terrain existed,
 *                    kept for tests that want a plane and for the phone's
 *                    character stage, which has no landscape at all.
 *
 * The seam is deliberately two methods wide. A height and an up-normal is
 * everything a walker, a prop or a shadow needs; anything richer would start
 * encoding the flat map's assumptions into its callers, which is exactly
 * what §7.2 exists to prevent.
 */

import { terrainHeight, terrainNormal } from './landscape';

export interface Surface {
  /** Ground height at (x, z). */
  sampleHeight(x: number, z: number): number;
  /** Unit up-normal at (x, z). */
  normalAt(x: number, z: number): { x: number; y: number; z: number };
}

/** The world's terrain (src/world/landscape.ts). */
export const ROLLING_SURFACE: Surface = {
  sampleHeight: (x, z) => terrainHeight(x, z),
  normalAt: (x, z) => terrainNormal(x, z),
};

/** y = 0 everywhere — the world before terrain, kept for tests and the phone
 * stage. Returns a fresh normal each call, like the rolling one, so a caller
 * can never mutate a shared vector by accident. */
export const FLAT_SURFACE: Surface = {
  sampleHeight: () => 0,
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
};
