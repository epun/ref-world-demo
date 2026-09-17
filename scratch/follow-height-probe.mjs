/**
 * HOW TALL A DRAWN CREATURE STANDS, measured in the world it stands in.
 *
 * The follow framing (`PHONE_FOLLOW_ZOOM`, src/world/camera.ts) centres the
 * frame on the creature's FEET — the look-target is a point on the ground, and
 * it has to be, because locomotion never writes Y (CLAUDE.md, the Surface
 * seam). So the number that decides how tight the frame can be is not the
 * ball's diameter, which is the width of the pile; it is how far the creature
 * reaches ABOVE that point — a stalk with the drawing as its topper, which is
 * most of its height and none of its radius.
 *
 * This measures it off the real rig, per creature, in world units: the drawn
 * subtree's own bounding box, walked by hand (`three` is not in page scope).
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/follow-height-probe.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4208);
const ROOM = 'xkcd';

const req = createRequire(import.meta.url);
let chromium = null;
for (const from of [
  'playwright',
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  join(process.env['ENVPAINT_DIR'] ?? '/home/user/envpaint', 'node_modules/playwright'),
]) {
  try {
    ({ chromium } = await import(from));
    break;
  } catch {
    try {
      ({ chromium } = req(from));
      break;
    } catch {
      /* next candidate */
    }
  }
}
if (!chromium) throw new Error('no playwright on this machine');
const browserRoot = '/opt/pw-browsers';
let executablePath;
if (existsSync(browserRoot)) {
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

/** Three drawings: a fat blob, a tall thin one, a wide low one. */
const CASES = {
  blob: [
    { pts: [[0.5, 0.62, 1]], w: 0.4 },
    { pts: [[0.5, 0.34, 1]], w: 0.26 },
    { pts: [[0.42, 0.8, 1], [0.42, 0.95, 1]], w: 0.045 },
    { pts: [[0.58, 0.8, 1], [0.58, 0.95, 1]], w: 0.045 },
  ],
  tall: [
    { pts: [[0.5, 0.2, 1], [0.5, 0.9, 1]], w: 0.08 },
    { pts: [[0.5, 0.25, 1]], w: 0.12 },
  ],
  wide: [
    { pts: [[0.2, 0.6, 1], [0.8, 0.6, 1]], w: 0.3 },
    { pts: [[0.5, 0.45, 1]], w: 0.2 },
  ],
};

const server = await preview({
  root: ROOT,
  preview: { port: PORT, host: '127.0.0.1', strictPort: true },
});
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(
  `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&game=katamari&landscape=1`,
  { waitUntil: 'load', timeout: 600_000 },
);
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

for (const [name, strokes] of Object.entries(CASES)) {
  const id = `probe-${name}`;
  await page.evaluate(
    ([who, s]) => window.__refworldCreatures.spawn(who, s, { hatchMs: 80, grown: true }),
    [id, strokes],
  );
  await page.waitForTimeout(12_000);
  const out = await page.evaluate((who) => {
    const m = window.__refworldCreatures;
    const root = m.rootOf(who);
    const at = m.positionOf(who);
    if (!root || !at) return null;
    root.updateMatrixWorld(true);
    // `three` is not in this scope, so the box is walked by hand off each
    // mesh's own geometry bounds and its world matrix.
    const scratch = window.__refworldCamera.position.clone();
    let lo = Infinity;
    let hi = -Infinity;
    let wide = 0;
    root.traverse((node) => {
      const g = node.geometry;
      if (!g || typeof g.computeBoundingBox !== 'function') return;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox;
      if (!b) return;
      for (const x of [b.min.x, b.max.x]) {
        for (const y of [b.min.y, b.max.y]) {
          for (const z of [b.min.z, b.max.z]) {
            scratch.set(x, y, z).applyMatrix4(node.matrixWorld);
            lo = Math.min(lo, scratch.y);
            hi = Math.max(hi, scratch.y);
            wide = Math.max(wide, Math.hypot(scratch.x - at.x, scratch.z - at.z));
          }
        }
      }
    });
    return {
      diameter: Number(m.ballDiameter(who).toFixed(2)),
      foot: Number(at.y.toFixed(2)),
      lo: Number(lo.toFixed(2)),
      top: Number(hi.toFixed(2)),
      aboveFoot: Number((hi - at.y).toFixed(2)),
      radius: Number(wide.toFixed(2)),
    };
  }, id);
  console.log(name.padEnd(6), JSON.stringify(out));
}

await browser.close();
await server.close();
