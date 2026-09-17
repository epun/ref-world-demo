/**
 * Headless proof of ZERO GRAVITY: press `g`, the cast lifts off; press it
 * again, the cast settles back.
 *
 * > User ask, 2026-09-17: *"i want a zero gravity mode where i can hit g on
 * > the keyboard and it turns off gravity for the map. characters should float
 * > in space."*
 *
 * Boots the built valiocon site in a real chromium (swiftshader, no gpu) at
 * 1280x800 as a HOST, puts a handful of creatures on the ground near the
 * origin — where the default framing is looking — and then presses the key
 * the operator presses. Two frames come out of it, and beside them the
 * numbers: each creature's float offset and the Y its root is actually at,
 * read off the manager rather than off the picture.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/zero-gravity-shot.mjs
 *     # scratch/zero-gravity-aloft.png, scratch/zero-gravity-grounded.png
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4281);
const ROOM = 'xkcd';

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

// One blobby drawing, the shared fixture's shape.
const strokes = [
  { pts: [[0.5, 0.62, 1]], w: 0.4 },
  { pts: [[0.5, 0.34, 1]], w: 0.26 },
  {
    pts: [
      [0.42, 0.8, 1],
      [0.42, 0.95, 1],
    ],
    w: 0.045,
  },
  {
    pts: [
      [0.58, 0.8, 1],
      [0.58, 0.95, 1],
    ],
    w: 0.045,
  },
];

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
server.stdout.on('data', (b) => process.stdout.write(`[preview] ${b}`));
server.stderr.on('data', (b) => process.stdout.write(`[preview!] ${b}`));
await new Promise((resolve) => setTimeout(resolve, 5000));

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

const url = `http://127.0.0.1:${PORT}/?view=world&host=1&room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

/*
 * A few creatures, near the origin. `spawnSpot` is pure in the slot id, so
 * the ids are chosen rather than the places: two dozen are spawned, the six
 * nearest the origin are kept and the rest cleared.
 */
const kept = await page.evaluate(
  ([s]) => {
    const m = window.__refworldCreatures;
    const probes = [];
    for (let i = 0; i < 24; i++) probes.push(`zg-${i}`);
    for (const p of probes) m.spawn(p, s, { hatchMs: 100, grown: true });
    const by = m
      .poses()
      .map((p) => ({ id: p.id, d: Math.hypot(p.x, p.z) }))
      .sort((a, b) => a.d - b.d);
    const keep = new Set(by.slice(0, 6).map((p) => p.id));
    for (const p of probes) if (!keep.has(p)) m.clear(p);
    return [...keep];
  },
  [strokes],
);
console.log('creatures', kept);
// Let them stand, and let the gaits settle.
await page.waitForTimeout(8_000);

const read = async (label) => {
  const out = await page.evaluate(
    ([ids]) => {
      const m = window.__refworldCreatures;
      let scene = window.__refworldWater?.group ?? null;
      while (scene?.parent) scene = scene.parent;
      const roots = new Map();
      for (const child of scene?.children ?? []) {
        if (typeof child.name === 'string' && child.name.startsWith('creature')) {
          roots.set(child.name, child);
        }
      }
      return {
        gravity: m.gravity(),
        rows: ids.map((id) => ({
          id,
          float: Number(m.floatOffset(id).toFixed(3)),
          blend: Number(m.floatBlend(id).toFixed(3)),
        })),
        // Every live root's Y and tilt, whichever creature it belongs to.
        roots: [...roots.values()].map((r) => ({
          y: Number(r.position.y.toFixed(3)),
          tiltX: Number(r.rotation.x.toFixed(3)),
          tiltZ: Number(r.rotation.z.toFixed(3)),
        })),
      };
    },
    [kept],
  );
  console.log(label, JSON.stringify(out));
  return out;
};

await read('grounded (before g)');

// ── the key an operator presses ────────────────────────────────────────────
await page.keyboard.press('g');
/*
 * The lift is a ζ ≥ 1 spring over MOTION.primaryMs — but on swiftshader ONE
 * FRAME of the ghibli chain takes seconds, and the frame loop clamps its dt
 * at `DT_CLAMP_MS` (250 ms), so the spring only advances a quarter of a
 * second per drawn frame however long the wall clock says. Measured: 20 s of
 * wall clock was 0.66 s of spring (blend 0.639, mid-slide). So this waits
 * long enough for the slide to finish rather than long enough to look
 * finished.
 */
await page.waitForTimeout(90_000);
await read('aloft (after one g)');
const aloft = join(HERE, 'zero-gravity-aloft.png');
await page.screenshot({ path: aloft });

await page.keyboard.press('g');
await page.waitForTimeout(90_000);
await read('grounded (after two g)');
const grounded = join(HERE, 'zero-gravity-grounded.png');
await page.screenshot({ path: grounded });

// And what actually went into the log — the scene event, once per press.
const log = await page.evaluate(() =>
  (window.__refworldSession?.log()?.events ?? [])
    .filter((e) => e.k === 'world' && e.field === 'gravity')
    .map((e) => ({ t: e.t, value: e.value })),
);
console.log('gravity events in the log', JSON.stringify(log));

await browser.close();
server.kill('SIGTERM');
console.log('shots', aloft, grounded);
