/**
 * Headless check for the onboarding screens and the loading line
 * (src/ui/onboard.ts, src/ui/loading.ts, src/ui/empty.ts).
 *
 * > User ask, 2026-09-17 (mobile): *"there should be better empty/loading
 * > states. we should have an onboarding stage to tell people how to play the
 * > game, before they load into the world."*
 *
 * Boots the built site in a real chromium (swiftshader, no gpu) as a PHONE —
 * 390x844, coarse pointer, `?view=world&onboard=1` — with a drawing already in
 * this handset's storage, because a stored submission is what makes
 * `myDrawerId` non-empty and that is what puts this page on the loading path
 * rather than the empty one. Then it taps through the three screens, starts,
 * and photographs the loading line the start uncovers.
 *
 * Five screenshots land next to this file (gitignored — evidence for one run):
 * one per onboarding screen, one of the loading line, one of the empty state.
 *
 * Playwright is not this repo's dependency; it is resolved out of whatever
 * checkout has it, the same way scratch/size-readout-smoke.mjs does. The
 * preview server is expected to be running already:
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4260 --strictPort &
 *   NO_PROXY=127.0.0.1 node scratch/onboard-loading-smoke.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 4260);
const ROOM = 'xkcd';
const ID = 'shot1';

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

/** A phone, with or without a drawing of its own. */
async function phone(withDrawing) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
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

const base = `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&game=katamari`;

// ── the three onboarding screens, and the loading line behind them ──────────
{
  const { context, page } = await phone(true);
  const url = `${base}&onboard=1`;
  console.log('opening', url);
  await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
  await page.waitForSelector('.world-onboard', { timeout: 600_000 });

  for (let i = 1; i <= 3; i++) {
    // The screen slides in over MOTION.secondaryMs (912ms); wait for the
    // class the sheet transitions, then let the transition finish.
    await page.waitForFunction(
      () => document.querySelectorAll('.onboard-screen.in').length > 0,
      null,
      { timeout: 600_000 },
    );
    await page.waitForTimeout(2_000);
    const seen = await page.evaluate(() => {
      const live = [...document.querySelectorAll('.onboard-screen')].filter(
        (s) => !s.classList.contains('out'),
      );
      const at = live[live.length - 1];
      return {
        line: at?.querySelector('.onboard-line')?.textContent ?? null,
        rings: at?.querySelectorAll('.onboard-mark').length ?? 0,
        ticks: [...document.querySelectorAll('.onboard-tick')].map((t) => t.dataset.at),
        start: document.querySelector('.onboard-start')?.classList.contains('in') ?? null,
        skip: document.querySelector('.onboard-skip')?.textContent ?? null,
      };
    });
    console.log(`screen ${i}:`, JSON.stringify(seen));
    const shot = join(HERE, `onboard-${i}-390x844.png`);
    await page.screenshot({ path: shot });
    console.log('  ->', shot);
    if (i < 3) await page.mouse.click(195, 300);
  }

  // Start, and photograph what the field uncovers.
  await page.click('.onboard-start');
  await page.waitForTimeout(2_000);
  const loading = await page.evaluate(() => ({
    mounted: Boolean(document.querySelector('.world-loading')),
    line: document.querySelector('.world-loading-line')?.textContent ?? null,
    fill: document.querySelector('.world-loading-fill')?.style.width ?? null,
    retry: document.querySelector('.world-loading-retry')?.classList.contains('in') ?? null,
    onboardGone: !document.querySelector('.world-onboard'),
  }));
  console.log('loading:', JSON.stringify(loading));
  const shot = join(HERE, 'loading-390x844.png');
  await page.screenshot({ path: shot });
  console.log('  ->', shot);
  await context.close();
}

// ── and the empty state: the same page with nothing of yours in it ──────────
{
  const { context, page } = await phone(false);
  await page.goto(`${base}&onboard=0`, { waitUntil: 'load', timeout: 600_000 });
  await page.waitForSelector('.world-empty', { timeout: 600_000 });
  await page.waitForTimeout(2_000);
  const seen = await page.evaluate(() => ({
    line: document.querySelector('.world-empty-line')?.textContent ?? null,
    href: document.querySelector('.world-empty-link')?.getAttribute('href') ?? null,
    stick: Boolean(document.querySelector('.world-stick')),
    loading: Boolean(document.querySelector('.world-loading')),
  }));
  console.log('empty:', JSON.stringify(seen));
  const shot = join(HERE, 'empty-390x844.png');
  await page.screenshot({ path: shot });
  console.log('  ->', shot);
  await context.close();
}

await browser.close();
console.log('done');
