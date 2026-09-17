/**
 * WHAT ONE PHONE FRAME COSTS — draw calls, triangles and passes, per pass and
 * per frame (2026-09-17).
 *
 * `renderer.info` resets itself at the top of every `render` call, and this
 * world's frame is four of them (colour, normals, ink composite, grain), so a
 * plain read only ever shows the LAST pass. So this turns `info.autoReset`
 * off, wraps `renderer.render`, and records the delta each pass adds. A frame
 * is then the repeating group in that list.
 *
 * Same phone setup as scratch/phone-zoom-camo.mjs: 390x844, coarse pointer,
 * `?view=world&host=1`, a drawing already in storage. Run it at the default
 * framing, which is where a person plays.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/phone-frame-cost.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4231);
const TAG = process.env['TAG'] ?? 'after';
const ROOM = 'xkcd';
const ID = 'shot1';

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
  const direct = join(browserRoot, 'chromium', 'chrome-linux', 'chrome');
  if (existsSync(direct)) executablePath = direct;
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

const wire = [
  { width: 90, pts: [[0.5, 0.62]] },
  { width: 60, pts: [[0.5, 0.34]] },
  { width: 14, pts: [[0.42, 0.8], [0.42, 0.95]] },
  { width: 14, pts: [[0.58, 0.8], [0.58, 0.95]] },
];
const strokes = [
  { pts: [[0.5, 0.62, 1]], w: 0.4 },
  { pts: [[0.5, 0.34, 1]], w: 0.26 },
  { pts: [[0.42, 0.8, 1], [0.42, 0.95, 1]], w: 0.045 },
  { pts: [[0.58, 0.8, 1], [0.58, 0.95, 1]], w: 0.045 },
];

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
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(
  ([room, id, drawing]) => {
    try {
      localStorage.setItem(
        `refworld:submission:${room}`,
        JSON.stringify({ id, name: null, strokes: drawing, ts: Date.now(), epoch: null }),
      );
      localStorage.setItem('refworld:drawer', id);
      localStorage.setItem('refworld:hinted-emote', '1');
    } catch {
      /* a blocked store simply mounts no tray */
    }
  },
  [ROOM, ID, wire],
);

const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(
  `http://127.0.0.1:${PORT}/?view=world&host=1&room=${ROOM}&game=katamari&landscape=1`,
  { waitUntil: 'load', timeout: 600_000 },
);
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [ID, strokes],
);
await page.waitForTimeout(25_000);

// Wrap `render` and record what each pass adds.
await page.evaluate(() => {
  const r = window.__refworldRenderer;
  r.info.autoReset = false;
  window.__passes = [];
  const original = r.render.bind(r);
  r.render = (scene, camera) => {
    const before = { calls: r.info.render.calls, tris: r.info.render.triangles };
    original(scene, camera);
    window.__passes.push({
      calls: r.info.render.calls - before.calls,
      tris: r.info.render.triangles - before.tris,
    });
  };
});
await page.waitForTimeout(60_000);

const out = await page.evaluate(() => ({
  passes: window.__passes.slice(0, 40),
  geometries: window.__refworldRenderer.info.memory.geometries,
  textures: window.__refworldRenderer.info.memory.textures,
  programs: window.__refworldRenderer.info.programs.length,
}));
await browser.close();
await server.close();

console.log(`--- ${TAG} ---`);
console.log('per-pass deltas (calls/triangles), in submission order:');
for (const [i, p] of out.passes.entries()) {
  console.log(`  ${String(i).padStart(2)}  calls ${String(p.calls).padStart(5)}  tris ${p.tris}`);
}
// The frame is the repeating group; find its length by matching the call
// pattern against itself.
const calls = out.passes.map((p) => p.calls);
let period = 0;
for (let n = 2; n <= 8 && period === 0; n++) {
  let ok = calls.length > n * 2;
  for (let i = 0; i < calls.length - n && ok; i++) {
    if (calls[i] !== calls[i + n]) ok = false;
  }
  if (ok) period = n;
}
console.log('passes a frame:', period || 'not periodic in this sample');
if (period > 0) {
  const frame = out.passes.slice(0, period);
  console.log(
    'one frame:',
    frame.reduce((a, p) => a + p.calls, 0),
    'draw calls,',
    frame.reduce((a, p) => a + p.tris, 0),
    'triangles',
  );
}
console.log('memory:', out.geometries, 'geometries,', out.textures, 'textures');
console.log('programs:', out.programs);
