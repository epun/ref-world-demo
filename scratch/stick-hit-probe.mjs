/**
 * IS THE STICK REACHABLE BY A THUMB? — one phone page, one question.
 *
 * > User report, 2026-09-17: *"people can't move on their mobile devices."*
 *
 * The room smoke (scratch/room-drive-smoke.mjs) found the stick reporting
 * `data-held="false"` after a real touch drag on its own centre, which means
 * the touch never reached it. That is not a sync question and it does not need
 * two pages or a broker: it needs the element stack at the point a thumb lands
 * on, and whatever is sitting on top of it.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/stick-hit-probe.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4242);
const ROOM = 'xkcd';
const ID = 'phonea';

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
      /* next */
    }
  }
}
if (!chromium) throw new Error('no playwright on this machine');

let executablePath;
if (existsSync('/opt/pw-browsers')) {
  for (const d of readdirSync('/opt/pw-browsers')) {
    if (!d.startsWith('chromium-')) continue;
    const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
    if (existsSync(at)) executablePath = at;
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
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(
  ([room, who, drawing]) => {
    try {
      localStorage.setItem(
        `refworld:submission:${room}`,
        JSON.stringify({ id: who, name: null, strokes: drawing, ts: Date.now(), epoch: null }),
      );
      localStorage.setItem('refworld:drawer', who);
      localStorage.setItem('refworld:hinted-emote', '1');
    } catch {
      /* a blocked store mounts no tray, and the run says so */
    }
  },
  [ROOM, ID, wire],
);
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(
  `http://127.0.0.1:${PORT}/?view=world&world=valiocon&game=katamari&room=${ROOM}` +
    `&onboard=${process.env['ONBOARD'] ?? '0'}`,
  { waitUntil: 'commit', timeout: 600_000 },
);
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.evaluate(
  ([who, s]) => window.__refworldCreatures.spawn(who, s, { hatchMs: 50, grown: true }),
  [ID, strokes],
);
await page.waitForTimeout(4000);

/** Everything between a thumb and the stick, at the point the thumb lands. */
const seen = await page.evaluate(() => {
  const el = document.querySelector('.world-stick');
  if (!el) return { stick: null };
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const describe = (n) =>
    n
      ? {
          tag: n.tagName.toLowerCase(),
          cls: String(n.className?.baseVal ?? n.className ?? ''),
          id: n.id || null,
          pe: getComputedStyle(n).pointerEvents,
          z: getComputedStyle(n).zIndex,
          pos: getComputedStyle(n).position,
          box: (() => {
            const b = n.getBoundingClientRect();
            return {
              x: Math.round(b.x),
              y: Math.round(b.y),
              w: Math.round(b.width),
              h: Math.round(b.height),
            };
          })(),
        }
      : null;
  // The whole stack, topmost first — which is the only thing that answers
  // "did the touch reach the stick".
  const stack = document.elementsFromPoint(cx, cy).map(describe);
  // …and every full-screen thing on the page, whatever it is.
  const overlays = [...document.body.querySelectorAll('*')]
    .filter((n) => {
      const b = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return (
        b.width >= innerWidth * 0.9 &&
        b.height >= innerHeight * 0.9 &&
        cs.position === 'fixed' &&
        cs.display !== 'none' &&
        cs.visibility !== 'hidden'
      );
    })
    .map(describe);
  return {
    stick: { box: describe(el), cx: Math.round(cx), cy: Math.round(cy) },
    topmost: stack[0],
    stack,
    overlays,
    held: el.dataset.held,
  };
});

console.log(JSON.stringify(seen, null, 2));

// …and then actually try it, the way a thumb does.
if (seen.stick) {
  const cdp = await context.newCDPSession(page);
  const { cx, cy } = seen.stick;
  const at = (dx, dy) => [{ x: cx + dx, y: cy + dy }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0, 0) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(0, -28) });
  const held = await page.evaluate(
    () => document.querySelector('.world-stick')?.dataset.held ?? null,
  );
  const drive = await page.evaluate(() => window.__refworldCreatures.driven());
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  console.log('after a real touch drag:', JSON.stringify({ held, drive }));
}

await page.screenshot({ path: join(HERE, 'stick-hit-probe.png') });
await browser.close();
await server.close();
process.exit(0);
