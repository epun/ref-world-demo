/**
 * Headless check for the refworld.paint skill (PLAN §7.3).
 *
 * Boots the dev build in a real chromium (swiftshader, no gpu), turns
 * painting on through the panel's own handle, drives the brush at (60, 0)
 * until the painted map holds ~6 units there, then asserts what the port
 * actually promises:
 *
 *   1. the Surface seam moved — ROLLING_SURFACE.sampleHeight(60, 0) is
 *      higher than it was, so every walker, shadow and prop sees the hill;
 *   2. the ground mesh moved with it — the field vertex at (60, 0) rose,
 *      so the hill is on screen and not just in an array;
 *   3. ground 200 units away did not move — a map, not a world;
 *   4. undo really is the panel's stack, and a stroke undoes;
 *   5. the strip goes when painting does, and clearing the map puts the
 *      authored height back exactly.
 *
 * Screenshots before and after land next to this file. Playwright is
 * envpaint's devDependency, not this repo's; it is resolved out of that
 * checkout with createRequire rather than installed here.
 *
 *   node scratch/paint-smoke.mjs
 */

import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENVPAINT = process.env['ENVPAINT_DIR'] ?? '/home/user/envpaint';

const req = createRequire(join(ENVPAINT, 'package.json'));
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
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE ERROR', m.text());
});

const url = server.resolvedUrls.local[0];
await page.goto(url, { waitUntil: 'load' });

// __IS_DEV__ is true under the dev server (vite.config.ts: NODE_ENV !==
// 'production'), so the panel mounts at boot and registers refworld.paint.
await page.waitForFunction(() => Boolean(window.__refworldPaint), null, { timeout: 120000 });
console.log('dev panel up, refworld.paint registered');

const AT = { x: 60, z: 0 };

/** Height through the seam every consumer samples, and off the mesh. */
const probe = async () =>
  page.evaluate(async (at) => {
    const surface = await import('/src/world/surface.ts');
    const scene = window.__refworldPaint.brush.ctx.scene;
    const field = scene.getObjectByName('ground-field');
    const pos = field.geometry.getAttribute('position');
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i) - at.x, pos.getZ(i) - at.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return {
      surface: surface.ROLLING_SURFACE.sampleHeight(at.x, at.z),
      vertex: pos.getY(best),
      vertexAt: [pos.getX(best), pos.getZ(best)],
      vertexDist: bestD,
      painted: window.__refworldPaint.sampleAt(at.x, at.z),
      range: window.__refworldPaint.range(),
      // A vertex nowhere near the brush, to show the map moved and not the
      // world: the far corner of the field, 200 units away.
      farVertex: (() => {
        let f = -1;
        let fd = Infinity;
        for (let i = 0; i < pos.count; i++) {
          const d = Math.hypot(pos.getX(i) + 150, pos.getZ(i) + 150);
          if (d < fd) {
            fd = d;
            f = i;
          }
        }
        return pos.getY(f);
      })(),
    };
  }, AT);

/**
 * Frame the spot before either screenshot, through the world's own controls
 * (wheel zoom, shift+drag pan) rather than by writing the camera — the rig
 * owns its transform and rewrites it every frame. Both shots are taken from
 * this view, so before and after are the same picture minus one hill.
 */
const settle = (ms) => page.evaluate((d) => new Promise((r) => setTimeout(r, d)), ms);
await page.mouse.move(550, 380);
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 400);
await page.keyboard.down('Shift');
await page.mouse.down();
await page.mouse.move(430, 330, { steps: 12 });
await page.mouse.up();
await page.keyboard.up('Shift');
await settle(1600);
const framing = await page.evaluate(
  ({ at, w, h }) => {
    const cam = window.__refworldCamera;
    // Where the painted spot lands on screen, so the shots can be read.
    const p = { x: at.x, y: 4, z: at.z };
    cam.updateMatrixWorld();
    const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const e = m.elements;
    const cw = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
    const ndcX = (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / cw;
    const ndcY = (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / cw;
    return {
      zoom: Number(cam.zoom.toFixed(3)),
      spotOnScreen: [Math.round(((ndcX + 1) / 2) * w), Math.round(((1 - ndcY) / 2) * h)],
    };
  },
  { at: AT, w: 1100, h: 760 },
);
console.log('framing', JSON.stringify(framing));

const before = await probe();
console.log('before', JSON.stringify(before));
await page.screenshot({ path: join(HERE, 'paint-before.png') });

// Painting on, exactly as the panel checkbox does it, then stamp until the
// painted map holds about six units under (60, 0).
const painted = await page.evaluate(async (at) => {
  const p = window.__refworldPaint;
  p.setPainting(true);
  const brush = p.brush;
  brush.setTool('raise');
  brush.settings.radius = 18;
  brush.settings.strength = 1;
  let stamps = 0;
  const t0 = performance.now();
  while (p.sampleAt(at.x, at.z) < 6 && stamps < 400) {
    brush._stampAt({ x: at.x, y: 0, z: at.z }, null);
    stamps++;
  }
  const stampMs = performance.now() - t0;
  const r0 = performance.now();
  p.rebuild();
  const rebuildMs = performance.now() - r0;
  return { stamps, stampMs, rebuildMs, painted: p.sampleAt(at.x, at.z), tool: brush.tool };
}, AT);
console.log('painted', JSON.stringify(painted));

// One more animation frame so the render catches up before the screenshot.
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const after = await probe();
console.log('after', JSON.stringify(after));
await page.screenshot({ path: join(HERE, 'paint-after.png') });

// Undo: EnvPaint's History wraps a stroke and, once handed the panel, pushes
// its entries onto ghost-panel's own stack — so this is the panel's ctrl+z,
// not a second stack answering the same key.
const undone = await page.evaluate(async (at) => {
  const p = window.__refworldPaint;
  const history = p.brush.ctx.history;
  const attached = history.ui !== null;
  // One real stroke through the brush's own scope, so there is an entry.
  history.begin('raise');
  p.brush._stampAt({ x: at.x + 40, y: 0, z: at.z }, null);
  history.end();
  const paintedAside = p.sampleAt(at.x + 40, at.z);
  const ok = history.canUndo() ? history.undo() : false;
  p.rebuild();
  return { attached, paintedAside, undoRan: ok, afterUndo: p.sampleAt(at.x + 40, at.z) };
}, AT);
console.log('undo', JSON.stringify(undone));

// A second rebuild, timed on its own, for the throttle note in the plan.
const rebuildMs = await page.evaluate(() => {
  const t = performance.now();
  window.__refworldPaint.rebuild();
  return performance.now() - t;
});
console.log(`rebuild cost: ${rebuildMs.toFixed(0)} ms`);

// Painting off hands the drag back and takes the strip away; the panel's
// "clear map" button puts the authored world back exactly.
const cleared = await page.evaluate(async (at) => {
  const p = window.__refworldPaint;
  p.setPainting(false);
  const stripGone = !document.querySelector('.ep-strip');
  const surface = await import('/src/world/surface.ts');
  const painted = await import('/src/world/painted.ts');
  // The button's own path: clear the map, mark it dirty, rebuild.
  p.brush.ctx.layers.get('height').clear(0);
  p.rebuild();
  return {
    stripGone,
    range: p.range(),
    surface: surface.ROLLING_SURFACE.sampleHeight(at.x, at.z),
    mapSize: painted.PAINTED_SIZE,
  };
}, AT);
console.log('cleared', JSON.stringify(cleared));

const checks = [
  ['painted map holds ~6 u at (60, 0)', painted.painted >= 6],
  ['surface rose', after.surface > before.surface + 1],
  ['ground vertex rose', after.vertex > before.vertex + 1],
  ['vertex tracks the surface', Math.abs(after.vertex - after.surface) < 1e-3],
  ['ground 200 u away is untouched', after.farVertex === before.farVertex],
  ['history adopted the panel stack', undone.attached],
  ['a stroke undoes back to where it started', undone.paintedAside > 0 && undone.afterUndo === 0],
  ['the tool strip goes when painting does', cleared.stripGone],
  ['clearing the map restores the authored height', cleared.surface === before.surface],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(
  `surface ${before.surface.toFixed(3)} -> ${after.surface.toFixed(3)} u; ` +
    `vertex ${before.vertex.toFixed(3)} -> ${after.vertex.toFixed(3)} u; ` +
    `painted map ${JSON.stringify(after.range)}`,
);

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
