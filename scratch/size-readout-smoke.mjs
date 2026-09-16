/**
 * Headless check for the ball-size readout (src/ui/size.ts).
 *
 * > User ask, 2026-09-16: *"for the mobile ui on the world view i want to
 * > show ball diameter in the top left hand side."*
 *
 * Boots the built site in a real chromium (swiftshader, no gpu) as a PHONE —
 * 390x844, coarse pointer, `?view=world` — with a drawing already in this
 * handset's storage, because a stored submission is what makes `myDrawerId`
 * non-empty and that is what mounts the tray, the stick and this readout.
 * Then it spawns that creature, feeds it four things through the event path
 * and asserts what the corner actually promises:
 *
 *   1. the readout mounted at all, and slid IN (the `in` class, which is
 *      what the sheet transitions — never a pop);
 *   2. the number it shows is the manager's own `ballDiameter` put through
 *      `WORLD_SCALE`, formatted the way the game says it;
 *   3. it sits in the TOP-LEFT, and clear of everything else on the phone:
 *      the device in the tray's left corner, the stick dead centre and the
 *      minimap bottom-right.
 *
 * A screenshot lands next to this file (gitignored — evidence for one run).
 * Playwright is not this repo's dependency; it is resolved out of whatever
 * checkout has it, the same way scratch/paint-smoke.mjs does.
 *
 *   npm run build            # or VITE_WORLD=valiocon npm run build
 *   node scratch/size-readout-smoke.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4197);
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
let executablePath;
if (existsSync(browserRoot)) {
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

// ── the drawing, in both forms ──────────────────────────────────────────────
// The stored submission is the kit's WIRE form (0..1 points, width in 320px
// reference units); the manager wants the pure StrokeList. Same shape twice,
// so the tray portrait and the creature in the world are the same creature.
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
const snack = [{ pts: [[0.5, 0.5, 1]], w: 0.3 }];

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
      // The first-run emote hint would otherwise be in the frame.
      localStorage.setItem('refworld:hinted-emote', '1');
    } catch {
      /* a blocked store simply mounts no tray, and the run says so */
    }
  },
  [ROOM, ID, wire],
);

const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

const url = `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });

// Under swiftshader this is about one frame every few seconds — wait for the
// manager rather than for a clock.
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [ID, strokes],
);
await page.waitForTimeout(8_000);

// Four things on the pile, through the presentation path every page shares.
await page.evaluate(
  ([id, s]) => {
    const m = window.__refworldCreatures;
    for (let i = 0; i < 4; i++) {
      m.spawn(`snack-${i}`, s, { hatchMs: 100, grown: true });
      m.applyStick({
        id,
        item: `creature:snack-${i}`,
        ox: 0,
        oy: 1,
        oz: i * 0.2,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    }
  },
  [ID, snack],
);
// The number rolls up over MOTION.primaryMs and the growth curve eases too.
await page.waitForTimeout(30_000);

const seen = await page.evaluate((id) => {
  const box = (n) => {
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const row = document.querySelector('.world-size-row');
  return {
    mounted: Boolean(document.querySelector('.world-size')),
    shown: row ? row.classList.contains('in') : null,
    text: document.querySelector('.world-size-value')?.textContent ?? null,
    font: row ? getComputedStyle(row).font : null,
    readout: box(document.querySelector('.world-size')),
    device: box(document.querySelector('.tray-device')),
    stick: box(document.querySelector('.world-stick')),
    minimap: box(document.querySelector('.world-minimap')),
    units: window.__refworldCreatures.ballDiameter(id),
  };
}, ID);

const shot = join(HERE, 'world-size-390x844.png');
await page.screenshot({ path: shot });
await browser.close();
await server.close();

// ── what it promised ────────────────────────────────────────────────────────
const fail = [];
const check = (ok, what) => {
  if (!ok) fail.push(what);
};
check(seen.mounted, 'the readout mounted');
check(seen.shown === true, 'it slid in');
check(typeof seen.text === 'string' && seen.text.length > 0, 'it says something');
check(seen.text === seen.text?.toLowerCase(), 'it is lowercase');
check(seen.units > 0, 'the manager has a ball to measure');
// The same conversion the module does — WORLD_SCALE, read backwards.
const metres = seen.units / 0.94;
const want =
  metres >= 100
    ? `${Math.round(metres)}m`
    : metres >= 1
      ? `${Math.floor(Math.round(metres * 100) / 100)}m ${Math.round(metres * 100) % 100}cm`
      : `${Math.floor(Math.round(metres * 1000) / 10)}cm ${Math.round(metres * 1000) % 10}mm`;
check(seen.text === want, `it reads the ball's real size (${seen.text} vs ${want})`);
check(seen.readout.x < 40 && seen.readout.y < 40, 'it is in the top-left');
const clear = (other) =>
  !other ||
  seen.readout.x + seen.readout.w < other.x ||
  other.x + other.w < seen.readout.x ||
  seen.readout.y + seen.readout.h < other.y ||
  other.y + other.h < seen.readout.y;
check(clear(seen.device), 'it is clear of the device');
check(clear(seen.stick), 'it is clear of the stick');
check(clear(seen.minimap), 'it is clear of the minimap');

console.log(JSON.stringify(seen, null, 2));
console.log('shot', shot);
if (fail.length > 0) {
  console.error(`size-readout-smoke FAILED:\n  ${fail.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('size-readout-smoke ok');
}
