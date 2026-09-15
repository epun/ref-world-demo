/**
 * Where test/world/wind.test.ts's fixtures come from.
 *
 * src/world/wind.ts is a port of envpaint's gust-front field, and a port is
 * only worth anything if it is pinned against the original. This script runs
 * envpaint's OWN `Wind.sampleAt` (over its own `noise.js`) with the wind
 * pinned — default 30° heading, strength 1, speed 1, gust 0.5 — and prints
 * the numbers that are pasted into that test as fixtures. Re-run it if the
 * vendored envpaint ever moves:
 *
 *   node scratch/wind-fixture.mjs
 *
 * It reads the VENDORED copy (node_modules/envpaint, from
 * vendor/envpaint-0.1.0.tgz) by path rather than by package name, because
 * the package's `exports` map does not publish its internals. That copy is
 * byte-identical to the sibling clone the port was read from.
 */

import { Wind } from '../node_modules/envpaint/src/core/Wind.js';
import { fbm } from '../node_modules/envpaint/src/core/noise.js';

const wind = new Wind();
wind.strength = 1;
wind.speed = 1;
wind.uniforms.uWindStrength.value = 1;
wind.uniforms.uWindSpeed.value = 1;
wind.uniforms.uGust.value = 0.5;

const dir = wind.uniforms.uWindDir.value;
console.log('dir', dir.x, dir.y);

for (const [x, z, t] of [
  [0, 0, 0],
  [12.5, -7.25, 3.5],
  [-40, 80, 11.75],
  [100, 100, 60],
]) {
  const w = wind.sampleAt(x, z, t);
  console.log(JSON.stringify({ x, z, t, wx: w.x, wz: w.z }));
}

wind.uniforms.uGust.value = 0.9;
console.log('gust 0.9', JSON.stringify(wind.sampleAt(12.5, -7.25, 3.5)));

// gustAt: envpaint's Wind.update gust walk, made pure in time (its default
// gustiness of 0.5 makes the `_gust * gustiness * 2` scaling identity).
for (const t of [0, 1.5, 7.25, 40]) {
  console.log('gustAt', t, fbm(t * 0.23, t * 0.11 + 5.7, 3));
}
