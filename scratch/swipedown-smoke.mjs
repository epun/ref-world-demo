/**
 * The swipe down from the top of the device view (src/phone/swipedown.ts).
 *
 * > User ask, 2026-09-17: *"on mobile if you swipe down at the top of the
 * > screen on the device view it should take you back to the world"*.
 *
 * A real phone-sized chromium on /phone.html with a drawing already in
 * storage: a short drag in the middle must NOT leave (that gesture turns the
 * creature), and a pull from the top band must land on `?view=world`.
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4260 --strictPort &
 *   NO_PROXY=127.0.0.1 node scratch/swipedown-smoke.mjs
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
for (const from of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
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
await context.addInitScript(
  ([room]) => {
    try {
      localStorage.setItem(
        `refworld:submission:${room}`,
        JSON.stringify({
          id: 'swipe1',
          name: null,
          strokes: [{ width: 60, pts: [[0.5, 0.5]] }],
          ts: Date.now(),
          epoch: null,
        }),
      );
      localStorage.setItem('refworld:drawer', 'swipe1');
      // Already taught, so nothing is over the world when we land.
      localStorage.setItem('refworld:hinted', '1');
    } catch {
      /* a blocked store simply restores no creature, and the run says so */
    }
  },
  [ROOM],
);
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

const url = `http://127.0.0.1:${PORT}/phone.html?room=${ROOM}&world=valiocon&game=katamari`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForSelector('.device-well', { timeout: 600_000 });
await page.waitForTimeout(3_000);
console.log('on the device view:', await page.evaluate(() => location.pathname + location.search));
await page.screenshot({ path: join(HERE, 'swipe-1-device-390x844.png') });

/** A one-finger drag, as touches (the gesture only reads touch events). */
const drag = async (fromX, fromY, toX, toY) => {
  await page.touchscreen.tap(fromX, fromY).catch(() => {});
  await page.evaluate(
    ([x0, y0, x1, y1]) => {
      const point = (x, y) => ({ clientX: x, clientY: y, identifier: 1, target: document.body });
      const send = (type, x, y) => {
        const touch = point(x, y);
        document.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === 'touchend' ? [] : [new Touch({ ...touch })],
            targetTouches: type === 'touchend' ? [] : [new Touch({ ...touch })],
            changedTouches: [new Touch({ ...touch })],
          }),
        );
      };
      send('touchstart', x0, y0);
      for (let i = 1; i <= 8; i++) {
        send('touchmove', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
      }
      send('touchend', x1, y1);
    },
    [fromX, fromY, toX, toY],
  );
};

// ① the gesture that must NOT leave: a drag in the middle (that turns the creature).
await drag(195, 420, 195, 620);
await page.waitForTimeout(2_500);
const afterMiddle = await page.evaluate(() => location.pathname + location.search);
console.log('after a middle drag:', afterMiddle);

// ② the gesture that must: a pull from the top band.
await drag(195, 40, 205, 260);
await page
  .waitForURL(/view=world/, { timeout: 30_000 })
  .catch(() => console.log('!! the swipe did not navigate'));
console.log('after a top-band pull:', await page.evaluate(() => location.pathname + location.search));
await page.waitForSelector('.world-stick', { timeout: 600_000 });
await page.waitForTimeout(4_000);
console.log(
  'landed with:',
  JSON.stringify(
    await page.evaluate(() => ({
      stick: Boolean(document.querySelector('.world-stick')),
      minimap: Boolean(document.querySelector('.world-minimap')),
      hint: document.querySelector('.world-hint-line')?.textContent ?? null,
    })),
  ),
);
await page.screenshot({ path: join(HERE, 'swipe-2-world-390x844.png') });

await context.close();
await browser.close();
console.log('done');
