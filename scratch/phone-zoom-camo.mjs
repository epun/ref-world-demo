/**
 * Headless reproduction of the PHONE ZOOM-FLOOR CAMO (2026-09-17 user report:
 * *"on mobile when you zoom out the shader glitches out and looks like camo"*).
 *
 * Boots the built valiocon site in a real chromium (swiftshader, no gpu) as a
 * PHONE — 390x844, coarse pointer, `?view=world&host=1` with a drawing already
 * in this handset's storage, the same setup scratch/size-readout-smoke.mjs
 * uses — then wheels the camera out to the zoom floor and screenshots.
 *
 * It reads `__refworldRenderer.info` at the default framing and at the floor,
 * which is the before/after frame measurement task 4 asks for, and prints the
 * two candidate frequencies at the zoom the frame is ACTUALLY at, so they can
 * be told apart:
 *
 *   - the BLADE field's pixel floor: `minBladePx` (2.25 on the doubled island)
 *     times units-per-pixel is the blade's world width, so at the floor a
 *     base blade is ~4.3 units wide and 0.8 tall — a horizontal dash, not a
 *     blade, and 40 000 randomly tinted dashes over the island is camo;
 *   - the GROUND stipple's world-space frequency: 3.5 cycles a world unit,
 *     which at 1.9 units a pixel is ~6.6 cycles a PIXEL — thirteen times
 *     nyquist, so it aliases into large moiré blotches.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/phone-zoom-camo.mjs            # writes scratch/camo-before-*.png
 *   TAG=after node scratch/phone-zoom-camo.mjs  # after the fix
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4230);
const TAG = process.env['TAG'] ?? 'before';
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
page.on('console', (m) => {
  const t = m.text();
  if (/webgl|extension|precision|probe|shader|float/i.test(t)) {
    console.log('[console]', t.slice(0, 500));
  }
});

const url = `http://127.0.0.1:${PORT}/?view=world&host=1&room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [ID, strokes],
);
await page.waitForTimeout(20_000);

const snap = () =>
  page.evaluate(() => {
    const r = window.__refworldRenderer;
    const info = r ? r.info : null;
    const cam = window.__refworldCamera ?? null;
    return {
      calls: info ? info.render.calls : null,
      triangles: info ? info.render.triangles : null,
      programs: info && info.programs ? info.programs.length : null,
      geometries: info ? info.memory.geometries : null,
      textures: info ? info.memory.textures : null,
      zoom: cam ? cam.zoom : null,
      unitsPerPx: cam
        ? (cam.top - cam.bottom) / Math.max(0.01, cam.zoom) / window.innerHeight
        : null,
    };
  });

const atDefault = await snap();
console.log('AT DEFAULT ZOOM', JSON.stringify(atDefault));
await page.screenshot({ path: join(HERE, `camo-${TAG}-default.png`) });

// Wheel out to the floor. Each wheel is one spring retarget; it settles.
for (let i = 0; i < 24; i++) {
  await page.mouse.move(195, 420);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(25_000);

// WHAT IS LEFT AT THE FLOOR, if anything: HIDE_SCATTER=1 takes the prop
// scatter out of the frame, which is how the remaining blobs were identified
// as tree canopies and their own flat shadow stamps rather than as shader
// noise (2026-09-17).
if (process.env['HIDE_SCATTER'] === '1') {
  await page.evaluate(() => {
    window.__refworldScatter.group.visible = false;
  });
  await page.waitForTimeout(20_000);
  await page.screenshot({ path: join(HERE, `camo-${TAG}-floor-noscatter.png`) });
  await page.evaluate(() => {
    window.__refworldScatter.group.visible = true;
  });
  await page.waitForTimeout(15_000);
}

const atFloor = await snap();
console.log('AT ZOOM FLOOR', JSON.stringify(atFloor));
const shot = join(HERE, `camo-${TAG}-floor.png`);
await page.screenshot({ path: shot });

if (atFloor.unitsPerPx) {
  const u = atFloor.unitsPerPx;
  console.log('units/px at floor', u.toFixed(3));
  console.log('  ground stipple cycles per PIXEL ', (3.5 * u).toFixed(2), '(nyquist 0.5)');
  console.log('  stipple speck cycles per PIXEL  ', (7 * u).toFixed(2));
  console.log('  base blade width floor, world u ', (2.25 * u).toFixed(2), 'vs authored 0.31');
}

await browser.close();
await server.close();
console.log('shot', shot);
