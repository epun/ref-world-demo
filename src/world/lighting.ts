/**
 * Lighting (PLAN §7, TASTE §2.4): a hard directional key over a broad
 * hemisphere fill. keyToFill 0.333 [M] means even and low-drama — the fill
 * carries most of the exposure and the key adds just enough directionality
 * for gloss highlights and legible form.
 *
 * Three.js shadow mapping stays OFF. Shadows are the flat stamped pass in
 * shadows.ts — a soft shadow map would be a penumbra, which is forbidden.
 */

import { DirectionalLight, Group, HemisphereLight, Vector3 } from 'three';
import { LIGHTING, WORLD } from '../taste/tokens';

/** World-space key light direction (normalized), exported for the ink pass:
 * hatching keys off "facing away from the key" (GENERATOR §ink pass). */
export const KEY_DIRECTION = new Vector3(24, 40, 18).normalize();

/** Fill carries the exposure; calibrated so the ground renders at its token
 * value under fill + key together. Measured against a rendered frame: at
 * 0.85 the ground came out at display luma 0.42 vs the 0.74 target [M],
 * which also inverted the shadow read (unlit stamp lighter than lit ground).
 * Intensity is linear in radiance but the target is display sRGB, so the
 * calibration runs through the transfer curve: 2.85 lands the rendered
 * ground on its token and restores shadow polarity. */
const FILL_INTENSITY = 2.85;

/** Key derived from the measured ratio — key sits at a third of the fill. */
const KEY_INTENSITY = FILL_INTENSITY * LIGHTING.keyToFill;

/** Live light handles, exposed so the environment engine (environment.ts)
 * can drive the sun arc and weather rebalance through springs. */
export interface Lighting {
  group: Group;
  key: DirectionalLight;
  fill: HemisphereLight;
}

export function createLighting(): Lighting {
  const group = new Group();

  // Broad ambient fill: sky in the palette's light role, bounce from the
  // ground's mid value. Even, non-directional.
  const fill = new HemisphereLight(WORLD.light, WORLD.neutralMid, FILL_INTENSITY);

  // Hard key. No shadow mapping — sharp shadow edges come from the flat
  // stamped shadow pass, never from a shadow map.
  const key = new DirectionalLight(WORLD.light, KEY_INTENSITY);
  key.position.copy(KEY_DIRECTION).multiplyScalar(50);
  key.castShadow = false;

  group.add(fill, key, key.target);
  return { group, key, fill };
}
