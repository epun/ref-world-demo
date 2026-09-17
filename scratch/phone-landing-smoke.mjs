/**
 * The REAL phone path, end to end, on a katamari world.
 *
 * > User report, 2026-09-17: *"the mobile experience is really bad."* / *"on
 * > mobile I'm not seeing the loading screen."*
 *
 * phone.html at 390x844, coarse pointer, nothing in storage — the state a
 * person is in when they scan the code:
 *
 *   ① the pad         draw one stroke on the case's screen
 *   ② done            the bottom-right key
 *   ③ the onboarding  three screens, over the case
 *   ④ start           the case slides out and the page navigates
 *   ⑤ the world view  the stick, the minimap, the loading line
 *
 * A screenshot per step lands next to this file (gitignored — evidence for
 * one run). The preview server is expected to be running already:
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4260 --strictPort &
 *   NO_PROXY=127.0.0.1 node scratch/phone-landing-smoke.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 4260);
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

let executablePath = '/opt/pw-browsers/chromium';
if (existsSync('/opt/pw-browsers')) {
  for (const d of readdirSync('/opt/pw-browsers')) {
    if (d.startsWith('chromium-')) {
      const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

const browser = await chromium.launch({
  executablePath,
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
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) console.log('  navigated ->', f.url().replace(`http://127.0.0.1:${PORT}`, ''));
});

const shot = async (name) => {
  const at = join(HERE, `${name}-390x844.png`);
  await page.screenshot({ path: at });
  console.log('  ->', at);
};

// ① the pad. `game=katamari` on the address stands in for the injected tag,
// which is what a deployed build carries (applyGameToPhoneHtml).
const url = `http://127.0.0.1:${PORT}/phone.html?room=${ROOM}&world=valiocon&game=katamari`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForSelector('.device-well canvas, .device-well svg', { timeout: 600_000 });
await page.waitForTimeout(2_000);
console.log('step 1 — the pad:', JSON.stringify(await page.evaluate(() => ({
  keys: [...document.querySelectorAll('.device-key')].map((k) => k.getAttribute('aria-label') ?? k.textContent),
  onboarding: Boolean(document.querySelector('.world-onboard')),
}))));
await shot('phone-1-pad');

// ② one stroke, then done.
const well = await page.$('.device-well');
const box = await well.boundingBox();
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(
    box.x + box.width * (0.35 + 0.02 * i),
    box.y + box.height * (0.35 + 0.025 * i),
  );
}
await page.mouse.up();
await page.waitForTimeout(1_000);
await shot('phone-2-stroke');

// By its LABEL, not its slot: the hidden top row carries the same data-key
// indices, and a click on an invisible button waits forever.
console.log('step 2 — done enabled:', await page.isEnabled('.device-key[aria-label=\"done\"]'));
await page.click('.device-key[aria-label=\"done\"]');

// ③ the onboarding, over the case.
await page.waitForSelector('.world-onboard', { timeout: 600_000 });
await page.waitForTimeout(2_500);
console.log('step 3 — onboarding:', JSON.stringify(await page.evaluate(() => ({
  line: document.querySelector('.onboard-screen:not(.out) .onboard-line')?.textContent ?? null,
  ticks: [...document.querySelectorAll('.onboard-tick')].map((t) => t.dataset.at),
  skip: document.querySelector('.onboard-skip')?.textContent ?? null,
  url: location.pathname + location.search,
}))));
await shot('phone-3-onboard');

// tap through to the last screen
await page.mouse.click(195, 300);
await page.waitForTimeout(1_500);
await page.mouse.click(195, 300);
await page.waitForTimeout(1_500);
console.log('step 4 — last screen:', JSON.stringify(await page.evaluate(() => ({
  line: document.querySelector('.onboard-screen:not(.out) .onboard-line')?.textContent ?? null,
  start: document.querySelector('.onboard-start')?.classList.contains('in') ?? null,
}))));
await shot('phone-4-start');

// ④ start → the case slides, then the page navigates to the world view.
await page.click('.onboard-start');
await page.waitForURL(/view=world/, { timeout: 600_000 });
console.log('step 5 — landed on:', await page.evaluate(() => location.pathname + location.search));

// ⑤ the world view: the stick, the minimap, the loading line.
await page.waitForSelector('.world-stick', { timeout: 600_000 });
await page.waitForTimeout(6_000);
console.log('step 5 — the game view:', JSON.stringify(await page.evaluate(() => ({
  stick: Boolean(document.querySelector('.world-stick')),
  minimap: Boolean(document.querySelector('.world-minimap')),
  tray: Boolean(document.querySelector('.world-tray')),
  loading: document.querySelector('.world-loading-line')?.textContent ?? null,
  onboardingAgain: Boolean(document.querySelector('.world-onboard')),
  onboardedFlag: (() => {
    try {
      return localStorage.getItem('refworld:onboarded');
    } catch {
      return 'unreadable';
    }
  })(),
}))));
await shot('phone-5-world');

await context.close();
await browser.close();
console.log('done');
