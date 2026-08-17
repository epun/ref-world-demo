/**
 * Lighting (PLAN §7, TASTE §2.4): a hard directional key over a broad
 * hemisphere fill. keyToFill 0.333 [M] means even and low-drama — the fill
 * carries most of the exposure and the key adds just enough directionality
 * for gloss highlights and legible form.
 *
 * Three.js shadow mapping stays OFF. Shadows are the flat stamped pass in
 * shadows.ts — a soft shadow map would be a penumbra, which is forbidden.
 */

import { DirectionalLight, Group, HemisphereLight } from 'three';
import { LIGHTING, WORLD } from '../taste/tokens';

/** Fill carries the exposure; calibrated so the ground renders at its token
 * value under fill + key together. */
const FILL_INTENSITY = 0.85;

/** Key derived from the measured ratio — key sits at a third of the fill. */
const KEY_INTENSITY = FILL_INTENSITY * LIGHTING.keyToFill;

export function createLighting(): Group {
  const group = new Group();

  // Broad ambient fill: sky in the palette's light role, bounce from the
  // ground's mid value. Even, non-directional.
  const fill = new HemisphereLight(WORLD.light, WORLD.neutralMid, FILL_INTENSITY);

  // Hard key. No shadow mapping — sharp shadow edges come from the flat
  // stamped shadow pass, never from a shadow map.
  const key = new DirectionalLight(WORLD.light, KEY_INTENSITY);
  key.position.set(24, 40, 18);
  key.castShadow = false;

  group.add(fill, key, key.target);
  return group;
}
