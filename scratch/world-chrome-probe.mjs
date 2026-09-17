/**
 * One picture of the world view's own chrome on a handset, alone in its own
 * process — the stick, the tray, the corner readouts (src/ui/theme.ts).
 *
 * Split out of scratch/device-theme-shot.mjs because the world page is the
 * expensive half: the island, three bakes and a creature through swiftshader
 * on a shared box took the tab out more than once, and a crash there should
 * not cost the phone pictures. `STYLE=ink` takes the other one.
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4300 --strictPort &
 *   NO_PROXY=127.0.0.1 STYLE=ghibli node scratch/world-chrome-probe.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 4300);
const STYLE = process.env['STYLE'] ?? 'ghibli';
const WAIT_MS = Number(process.env['WAIT_MS'] ?? 90_000);
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

let executablePath = '/opt/pw-browsers/chromium';
if (existsSync('/opt/pw-browsers')) {
  for (const d of readdirSync('/opt/pw-browsers')) {
    if (d.startsWith('chromium-')) {
      const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
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

const browser = await chromium.launch({
  executablePath,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    // the shared box has a small /dev/shm; a software raster of this size
    // filled it and the tab went away without a page error.
    '--disable-dev-shm-usage',
  ],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
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
      /* a blocked store simply mounts no tray, and the run says so */
    }
  },
  [ROOM, ID, wire],
);
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
page.on('crash', () => console.log('[crash] the tab went away'));

const url =
  `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&game=katamari` +
  `&style=${STYLE}&onboard=0`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForSelector('canvas#world', { timeout: 600_000 });

// Poll rather than sleep in one block: a long single wait loses everything if
// the tab dies, and the chrome is worth photographing as soon as it mounts.
const started = Date.now();
let seen = null;
while (Date.now() - started < WAIT_MS) {
  await page.waitForTimeout(5_000);
  try {
    seen = await page.evaluate(() => ({
      stick: Boolean(document.querySelector('.world-stick')),
      tray: Boolean(document.querySelector('.world-tray')),
      minimap: Boolean(document.querySelector('.world-minimap')),
      size: document.querySelector('.world-size-value')?.textContent ?? null,
      loading: Boolean(document.querySelector('.world-loading')),
      roles: Object.fromEntries(
        ['paper', 'ink', 'muted', 'light', 'pad', 'accent'].map((k) => [
          k,
          getComputedStyle(document.documentElement).getPropertyValue(`--rw-${k}`).trim(),
        ]),
      ),
    }));
  } catch (err) {
    console.log('[gone]', String(err).slice(0, 120));
    break;
  }
  console.log(`${Math.round((Date.now() - started) / 1000)}s`, JSON.stringify(seen));
  const at = join(HERE, `world-chrome-${STYLE}-390x844.png`);
  try {
    await page.screenshot({ path: at });
    console.log('  ->', at);
  } catch (err) {
    console.log('[shot failed]', String(err).slice(0, 120));
    break;
  }
  if (seen.stick && seen.tray && !seen.loading) break;
}

await browser.close();
console.log('done');
