/**
 * Headless visual check for the environment brush kit (2026-09-09 user ask).
 *
 * Boots the dev build in a real chromium (swiftshader, no gpu), stamps each
 * planting brush into its own patch of the plain field through the paint
 * probe's `applyPaint` — the same seam a replayed or synced dab lands
 * through — then screenshots the projection and a close-up of each new motif
 * family. Also times the two rebuilds so the plan's cost note is measured
 * rather than guessed.
 *
 *   node scratch/brush-kit-smoke.mjs [outDir]
 */

import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? HERE;
mkdirSync(OUT, { recursive: true });
// Playwright is not this repo's dependency: it is resolved from wherever the
// machine has it (envpaint's checkout, or the global node install) rather
// than added here.
const PW = process.env['PLAYWRIGHT_DIR'] ?? '/opt/node22/lib/node_modules/playwright';
const req = createRequire(join(PW, 'package.json'));
const { chromium } = req('playwright');

const browserRoot = '/opt/pw-browsers';
const candidates = [];
for (const d of readdirSync(browserRoot)) {
  if (d.startsWith('chromium-')) candidates.push(join(browserRoot, d, 'chrome-linux', 'chrome'));
  if (d.startsWith('chromium_headless_shell-')) {
    candidates.push(join(browserRoot, d, 'chrome-linux', 'headless_shell'));
  }
}

const server = await createServer({
  root: join(HERE, '..'),
  server: { host: '127.0.0.1', hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: candidates.find((p) => existsSync(p)),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR', m.text());
});
const url = server.resolvedUrls.local[0];
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__refworldPaint), null, { timeout: 180000 });
console.log('dev panel up, refworld.paint registered');

const settle = (ms) => page.evaluate((d) => new Promise((r) => setTimeout(r, d)), ms);

/** Where each brush is painted. Well apart, so every patch reads on its own. */
const PATCHES = [
  { brush: 'grove', x: -95, z: -55, r: 26 },
  { brush: 'rocks', x: -20, z: -75, r: 22 },
  { brush: 'grass', x: 60, z: -60, r: 24 },
  { brush: 'flowers', x: 110, z: 10, r: 22 },
  { brush: 'cottages', x: -105, z: 45, r: 22 },
  { brush: 'clouds', x: 20, z: 60, r: 40 },
];
/** …and a clearing cut across the middle of the grove. */
const CLEARING = { brush: 'clearing', x: -95, z: -55, r: 13 };

await page.screenshot({ path: join(OUT, 'brush-before.png') });

const stamped = await page.evaluate(
  async ({ patches, clearing }) => {
    const p = window.__refworldPaint;
    const dab = (brush, x, z, r, i) =>
      p.applyPaint({ k: 'paint', t: 0, tool: brush, x, z, r, strength: 1, hardness: 0.7, mode: 'add', seed: i });
    for (const patch of patches) {
      // A few overlapping dabs so the patch saturates and its rim stays a
      // brush rim rather than one disc.
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        dab(patch.brush, patch.x + Math.cos(a) * patch.r * 0.35, patch.z + Math.sin(a) * patch.r * 0.35, patch.r, i);
      }
      dab(patch.brush, patch.x, patch.z, patch.r, 99);
    }
    for (let i = 0; i < 4; i++) dab(clearing.brush, clearing.x, clearing.z, clearing.r, i);

    const t0 = performance.now();
    p.rebuild();
    const scatterOnlyMs = performance.now() - t0;

    // …and the full one, for the comparison: one height dab, then rebuild.
    p.applyPaint({ k: 'paint', t: 0, tool: 'raise', x: 150, z: 150, r: 6, strength: 0.2, mode: 'raise', seed: 1 });
    const t1 = performance.now();
    p.rebuild();
    const fullMs = performance.now() - t1;

    const weights = {};
    for (const patch of patches) weights[patch.brush] = p.plantingAt(patch.brush, patch.x, patch.z);
    weights.clearing = p.plantingAt('clearing', clearing.x, clearing.z);

    const counts = {};
    const scatter = window.__refworldScatter;
    scatter.group.traverse((o) => {
      if (o.isInstancedMesh) counts[o.name] = o.count;
    });
    return { weights, counts, scatterOnlyMs, fullMs };
  },
  { patches: PATCHES, clearing: CLEARING },
);
console.log('weights', JSON.stringify(stamped.weights));
console.log('rebuild ms', JSON.stringify({ scatterOnly: stamped.scatterOnlyMs, full: stamped.fullMs }));
console.log('instanced meshes', JSON.stringify(stamped.counts, null, 1));

await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
await settle(1200);

/**
 * Close-ups. The camera rig owns its transform and rewrites it every frame,
 * so the shots are framed through the world's OWN gestures — shift+drag pans
 * (1:1 in screen space) and the wheel zooms — rather than by writing the
 * camera, which the rig would overwrite on the next frame.
 */
const W = 1200;
const H = 820;

const project = (point) =>
  page.evaluate(
    ({ p, w, h }) => {
      const cam = window.__refworldCamera;
      cam.updateMatrixWorld();
      const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
      const e = m.elements;
      const cw = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
      const ndcX = (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / cw;
      const ndcY = (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / cw;
      return [((ndcX + 1) / 2) * w, ((1 - ndcY) / 2) * h];
    },
    { p: point, w: W, h: H },
  );

const panTo = async (point) => {
  for (let i = 0; i < 6; i++) {
    const [sx, sy] = await project(point);
    const dx = W / 2 - sx;
    const dy = H / 2 - sy;
    if (Math.hypot(dx, dy) < 18) break;
    const fromX = Math.min(W - 60, Math.max(60, W / 2 - dx / 2));
    const fromY = Math.min(H - 60, Math.max(60, H / 2 - dy / 2));
    await page.mouse.move(fromX, fromY);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.move(
      Math.min(W - 20, Math.max(20, fromX + dx)),
      Math.min(H - 20, Math.max(20, fromY + dy)),
      { steps: 10 },
    );
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await settle(700);
  }
};

const zoom = async (clicks) => {
  await page.mouse.move(W / 2, H / 2);
  for (let i = 0; i < Math.abs(clicks); i++) await page.mouse.wheel(0, clicks > 0 ? -320 : 320);
  await settle(1400);
};

const closeUp = async (name, target, clicks) => {
  await panTo({ x: target.x, y: 1, z: target.z });
  await zoom(clicks);
  await panTo({ x: target.x, y: 1, z: target.z });
  await settle(1500);
  await page.screenshot({ path: join(OUT, `brush-${name}.png`) });
  await zoom(-clicks);
  await settle(1200);
};

// The whole painted field, wide enough to hold every patch at once.
await page.mouse.move(600, 410);
for (let i = 0; i < 7; i++) await page.mouse.wheel(0, 320);
await settle(2600);
await page.screenshot({ path: join(OUT, 'brush-projection.png') });
for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -320);
await settle(1800);

await closeUp('grass', { x: 60, z: -60 }, 9);
await closeUp('flowers', { x: 110, z: 10 }, 9);
await closeUp('clouds', { x: 20, z: 60 }, 4);
await closeUp('grove-clearing', { x: -95, z: -55 }, 4);

await browser.close();
await server.close();
console.log('shots in', OUT);
