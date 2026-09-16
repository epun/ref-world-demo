/**
 * Headless crop of the world minimap, in both looks (src/ui/minimap.ts).
 *
 * > User ask, 2026-09-16: *"The mini map should update to be in the more
 * > colored style."*
 *
 * Boots the built site in a real chromium (swiftshader, no gpu) as a
 * PROJECTION — 1280x800, `?host=1` — waits for the world to have actually
 * rendered a few frames under software GL, and crops the bottom-right corner
 * twice:
 *
 *   1. as the world ships (`valiocon` → `style: ghibli`): the painted body —
 *      sea bands, sand ring, meadow, forest, range, the lake and its rim;
 *   2. with `?style=ink` on the same build: the grey paper-and-ink sketch,
 *      unchanged. That is the whole point of the gate — every other world's
 *      map is the one that shipped.
 *
 * Screenshots land next to this file (gitignored — evidence for one run).
 * Playwright is not this repo's dependency; it is resolved out of whatever
 * checkout has it, the same way scratch/size-readout-smoke.mjs does.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/minimap-style-smoke.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4202);
/** Frames come every few seconds under swiftshader; the map itself draws at
 * 30fps off its own rAF, so this is the world settling, not the map. */
const SETTLE_MS = 30_000;

// ── playwright and a browser, wherever this machine keeps them ──────────────
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
  const direct = join(browserRoot, 'chromium');
  if (existsSync(direct)) executablePath = direct;
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

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

/** One look: open the world, wait, crop the map with a little air round it. */
async function shoot(label, search) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(600_000);
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  const url = `http://127.0.0.1:${PORT}/${search}`;
  console.log('opening', url);
  await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
  await page.waitForSelector('canvas.world-minimap', { timeout: 600_000 });
  await page.waitForTimeout(SETTLE_MS);
  const map = await page.$('canvas.world-minimap');
  const box = await map.boundingBox();
  const pad = 8;
  const shot = join(HERE, `minimap-${label}.png`);
  await page.screenshot({
    path: shot,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  await page.screenshot({ path: join(HERE, `minimap-${label}-full.png`) });
  console.log(label, 'map', JSON.stringify(box), '->', shot);
  await page.close();
}

// The world's own look first, then the shipped one forced back on over it.
await shoot('ghibli', '?host=1');
await shoot('ink', '?host=1&style=ink');

await browser.close();
await server.close();
