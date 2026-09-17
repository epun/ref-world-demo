/**
 * Headless photographs of the HANDSET in the world's own palette
 * (src/ui/theme.ts).
 *
 * > User ask, 2026-09-17: *"can we style the device on mobile in the new
 * > style of the world so it's not just black and white."*
 *
 * Boots the built valiocon site in a real chromium (swiftshader, no gpu) as a
 * phone — 390x844, coarse pointer — and takes three pictures:
 *
 *   1. the DRAW PAD          /phone.html?room=xkcd, empty and then drawn on
 *   2. the DEVICE VIEW       the same page after `done` — the egg in the well
 *   3. the WORLD VIEW CHROME /?view=world — the stick, the tray and the
 *                            corner readouts over the meadow
 *
 * Each is taken twice, once with `?style=ghibli` (what the valiocon build
 * injects) and once with `?style=ink` — the query wins over the tag, which is
 * exactly how an operator compares the two looks on a deployed link — so the
 * pair is the evidence that only the values moved.
 *
 * Playwright is not this repo's dependency; it is resolved out of whatever
 * checkout has it, the same way scratch/onboard-loading-smoke.mjs does. The
 * preview server is expected to be running already:
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4300 --strictPort &
 *   NO_PROXY=127.0.0.1 node scratch/device-theme-shot.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 4300);
const ROOM = 'xkcd';
const ID = 'shot1';
/** `STYLES=ghibli` and `ONLY=world` narrow a re-run: the world view costs a
 * minute of swiftshader apiece, and a crash there should not cost the two
 * phone pictures again. */
const STYLES = (process.env['STYLES'] ?? 'ghibli,ink').split(',');
const ONLY = process.env['ONLY'] ?? 'all';

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
let executablePath = '/opt/pw-browsers/chromium';
if (existsSync(browserRoot)) {
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

/** The kit's WIRE form — what the draw page stores, and all this run needs. */
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
  ],
});

async function phone(withDrawing, scale = 3) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: scale,
    isMobile: true,
    hasTouch: true,
  });
  if (withDrawing) {
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
  }
  const page = await context.newPage();
  page.setDefaultTimeout(600_000);
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  return { context, page };
}

/** The six variables the page published, straight off `:root`. */
async function roles(page) {
  return page.evaluate(() => {
    const at = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      ['paper', 'ink', 'muted', 'light', 'pad', 'accent'].map((k) => [
        k,
        at.getPropertyValue(`--rw-${k}`).trim(),
      ]),
    );
  });
}

async function shoot(page, name) {
  const at = join(HERE, `${name}-390x844.png`);
  await page.screenshot({ path: at });
  console.log('  ->', at);
}

/** Drag a few strokes across the pad, as a thumb would. */
async function scribble(page) {
  const box = await page.locator('.draw-canvas').boundingBox();
  const paths = [
    [[0.32, 0.3], [0.5, 0.2], [0.68, 0.32], [0.72, 0.56], [0.5, 0.72], [0.3, 0.56], [0.32, 0.3]],
    [[0.44, 0.42], [0.45, 0.45]],
    [[0.58, 0.42], [0.59, 0.45]],
    [[0.5, 0.2], [0.52, 0.08]],
  ];
  for (const path of paths) {
    const [first, ...rest] = path;
    await page.mouse.move(box.x + first[0] * box.width, box.y + first[1] * box.height);
    await page.mouse.down();
    for (const [u, v] of rest) {
      await page.mouse.move(box.x + u * box.width, box.y + v * box.height, { steps: 10 });
    }
    await page.mouse.up();
  }
}

for (const style of STYLES) {
  // ── ① the draw pad, and ② the device view the `done` key leads to ────────
  if (ONLY !== 'world') {
    const { context, page } = await phone(false);
    const url = `http://127.0.0.1:${PORT}/phone.html?room=${ROOM}&style=${style}`;
    console.log('opening', url);
    await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
    await page.waitForSelector('.draw-canvas', { timeout: 600_000 });
    await page.waitForTimeout(2_500);
    console.log(`${style} roles:`, JSON.stringify(await roles(page)));
    await scribble(page);
    await page.waitForTimeout(1_200);
    await shoot(page, `draw-pad-${style}`);

    await page.click('[aria-label="done"]');
    // The egg paints on over t.primary and the stage slides; give it room.
    await page.waitForTimeout(8_000);
    console.log(
      `${style} after done:`,
      JSON.stringify(
        await page.evaluate(() => ({
          state: document.querySelector('.stage')?.dataset.state ?? null,
          keys: [...document.querySelectorAll('.device-key')].map((k) =>
            k.getAttribute('aria-label'),
          ),
          brow: document.querySelector('.stage-brow')?.textContent ?? null,
        })),
      ),
    );
    await shoot(page, `device-view-${style}`);
    await context.close();
  }

  // ── ③ the world view's own chrome ────────────────────────────────────────
  if (ONLY !== 'phone') {
    // one device pixel per css pixel: the whole island through swiftshader at
    // 3x is 1170x2532 of software raster, which took the tab out.
    const { context, page } = await phone(true, 1);
    const url =
      `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&game=katamari` +
      `&style=${style}&onboard=0`;
    console.log('opening', url);
    await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
    await page.waitForSelector('canvas#world', { timeout: 600_000 });
    // The world builds its island, bakes three textures and stands a
    // creature up; on one swiftshader core that is tens of seconds.
    await page.waitForTimeout(60_000);
    console.log(
      `${style} chrome:`,
      JSON.stringify(
        await page.evaluate(() => ({
          stick: Boolean(document.querySelector('.world-stick')),
          tray: Boolean(document.querySelector('.world-tray')),
          minimap: Boolean(document.querySelector('.world-minimap')),
          size: document.querySelector('.world-size-value')?.textContent ?? null,
          loading: Boolean(document.querySelector('.world-loading')),
        })),
      ),
    );
    await shoot(page, `world-chrome-${style}`);
    await context.close();
  }
}

await browser.close();
console.log('done');
