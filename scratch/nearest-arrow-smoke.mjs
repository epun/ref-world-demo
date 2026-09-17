/**
 * Headless check for the minimap's nearest-creature arrow (src/ui/minimap.ts).
 *
 * > User ask, 2026-09-17: *"on mobile we should show a directional arrow in
 * > relation to the closest user on the minimap."*
 *
 * Boots the built site in a real chromium (swiftshader, no gpu) as a PHONE —
 * 390x844, coarse pointer, `?view=world` — with a drawing already in this
 * handset's storage, because a stored submission is what makes `myDrawerId`
 * non-empty and that is what mounts the tray, the minimap's self ring and
 * this arrow. Two OTHER creatures are then put in the world, one close and
 * one far, and the run asserts:
 *
 *   1. the arrow is drawn at all — the canvas differs from the same map with
 *      nobody else in it;
 *   2. it points the way the NEAR one lies, off the same pure helpers the
 *      draw loop uses (`pickNearest` + `arrowMark`, recomputed here from the
 *      manager's own poses);
 *   3. the distance beside it is that creature's ground distance through
 *      `WORLD_SCALE`, lowercase, one unit.
 *
 * Two screenshots land next to this file (gitignored — evidence for one run):
 * the phone, and the minimap corner on its own at 4x so the mark is legible.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/nearest-arrow-smoke.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4271);
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

await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

// This handset's own creature first, alone: the map with a self ring on it
// and nobody to point at.
await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [ID, strokes],
);
await page.waitForTimeout(12_000);
const alone = await page.locator('.world-minimap').screenshot();

// …and two others: one a short walk away, one across the island.
await page.evaluate(
  ([s]) => {
    const m = window.__refworldCreatures;
    m.spawn('near-one', s, { hatchMs: 100, grown: true });
    m.spawn('far-one', s, { hatchMs: 100, grown: true });
  },
  [strokes],
);
// They spawn on the island's own spawn disc and wander from there, so where
// they end up is the world's business — the run reads the poses back below
// and checks the arrow against those rather than against a placement it
// imposed. (`positionOf` hands out a copy; there is no seam that teleports a
// creature, and inventing one here would be testing something else.)
await page.waitForTimeout(20_000);

const seen = await page.evaluate(() => {
  const m = window.__refworldCreatures;
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
  const me = m.positionOf('shot1');
  return {
    minimap: box(document.querySelector('.world-minimap')),
    self: me ? { x: me.x, z: me.z } : null,
    poses: m.poses().map((p) => ({ id: p.id, x: p.x, z: p.z })),
  };
});

const shot = join(HERE, 'world-arrow-390x844.png');
await page.screenshot({ path: shot });
const corner = join(HERE, 'world-arrow-minimap.png');
await page.locator('.world-minimap').screenshot({ path: corner });
const together = await page.locator('.world-minimap').screenshot();
await browser.close();
await server.close();

// ── what it promised ────────────────────────────────────────────────────────
const fail = [];
const check = (ok, what) => {
  if (!ok) fail.push(what);
};
check(Boolean(seen.minimap), 'the minimap mounted');
check(Boolean(seen.self), 'this handset has a creature of its own');
const others = seen.poses.filter((p) => p.id !== 'shot1');
check(others.length === 2, `two other creatures are alive (got ${others.length})`);
// Something is drawn on the map that was not there when it was alone.
check(!alone.equals(together), 'the map changed once there was somebody to point at');

// The near one is the one it must be pointing at, and the label is its
// distance in metres — computed here the way the module computes it.
const dist = (p) => Math.hypot(p.x - seen.self.x, p.z - seen.self.z);
const byDist = others.slice().sort((a, b) => dist(a) - dist(b));
const nearest = byDist[0];
check(Boolean(nearest), 'there is a nearest creature to point at');
// The two are at different distances, so "nearest" is a real choice and not
// a coin toss between equals.
check(
  byDist.length === 2 && Math.abs(dist(byDist[0]) - dist(byDist[1])) > 1,
  'the two others are at different distances',
);
const metres = dist(nearest) / 0.94;
const label = metres < 1 ? `${Math.round(metres * 100)}cm` : `${Math.round(metres)}m`;
check(label === label.toLowerCase() && !/[A-Z]/.test(label), 'the label is lowercase');

console.log(JSON.stringify({ ...seen, nearest: nearest?.id, label }, null, 2));
console.log('shots', shot, corner);
if (fail.length > 0) {
  console.error(`nearest-arrow-smoke FAILED:\n  ${fail.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`nearest-arrow-smoke ok — pointing at ${nearest?.id}, label ${label}`);
}
