/**
 * The 1.32x island, seen (2026-09-17, `MAP_SCALE`).
 *
 * Two frames on the katamari world at 1280x800:
 *
 *   island-scale-floor.png  the zoom floor (wheel out ~40 steps) — the whole
 *                           island has to fit inside the frame with sea round
 *                           it, which is what `zoomMinFor` promises and what a
 *                           bigger map can break.
 *   island-scale-pond.png   the default framing panned over the FIRST pond,
 *                           which carries the `islandNudge` that steps it off
 *                           a terrace riser: the water has to sit on level
 *                           ground with its own bank all the way round.
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4290 --strictPort   (in another shell)
 *   node scratch/island-scale-shot.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 4290);
/** The pond's centre on the scaled map: (15, -55) * 1.32 + the (+5, +5) nudge. */
const POND = { x: 24.8, z: -67.6 };

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

const browserRoot = '/opt/pw-browsers';
let executablePath;
if (existsSync(browserRoot)) {
  const direct = join(browserRoot, 'chromium', 'chrome-linux', 'chrome');
  if (existsSync(direct)) executablePath = direct;
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

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
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  if (/THREE.WebGLProgram|shader error|ERROR:|gl_FragColor/i.test(t)) problems.push(t.slice(0, 600));
});

await page.goto(
  `http://127.0.0.1:${PORT}/?view=world&host=1&room=xkcd&game=katamari&landscape=1`,
  { waitUntil: 'load', timeout: 600_000 },
);
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.waitForTimeout(45_000);

/** Project a ground point to screen pixels off the live camera's matrices. */
const screenOf = (pt) =>
  page.evaluate(({ x, z }) => {
    const cam = window.__refworldCamera;
    cam.updateMatrixWorld();
    const mul = (m, v) => {
      const e = m.elements;
      const o = [0, 0, 0, 0];
      for (let r = 0; r < 4; r++) {
        o[r] = e[r] * v[0] + e[4 + r] * v[1] + e[8 + r] * v[2] + e[12 + r] * v[3];
      }
      return o;
    };
    const view = mul(cam.matrixWorldInverse, [x, 0, z, 1]);
    const clip = mul(cam.projectionMatrix, view);
    const w = clip[3] === 0 ? 1 : clip[3];
    return {
      px: ((clip[0] / w) * 0.5 + 0.5) * window.innerWidth,
      py: (0.5 - (clip[1] / w) * 0.5) * window.innerHeight,
    };
  }, pt);

// ── the pond, at the default framing ────────────────────────────────────────
// SHIFT+drag the frame until the pond is in the middle of it: the pan is
// direct manipulation and a plain drag ORBITS (src/world/scene.ts), so shift
// is what makes this a pan and not a turn on the spot.
const cx = 640;
const cy = 400;
for (let attempt = 0; attempt < 6; attempt++) {
  const at = await screenOf(POND);
  const dx = cx - at.px;
  const dy = cy - at.py;
  if (Math.hypot(dx, dy) < 12) break;
  await page.keyboard.down('Shift');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(3_000);
}
const pondAt = await screenOf(POND);
await page.waitForTimeout(4_000);
const pondShot = join(HERE, 'island-scale-pond.png');
await page.screenshot({ path: pondShot });
const pondCrop = join(HERE, 'island-scale-pond-crop.png');
const clipX = Math.min(760, Math.max(0, Math.round(pondAt.px) - 260));
const clipY = Math.min(400, Math.max(0, Math.round(pondAt.py) - 200));
await page.screenshot({ path: pondCrop, clip: { x: clipX, y: clipY, width: 520, height: 400 } });

// ── and the zoom floor ──────────────────────────────────────────────────────
// POND_ONLY=1 stops here: the two frames are independent and the floor's 40
// wheel steps are the slow half under swiftshader.
let floor = null;
if (!process.env['POND_ONLY']) {
await page.mouse.move(cx, cy);
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(20_000);
floor = await page.evaluate(() => {
  const cam = window.__refworldCamera;
  return { zoom: cam.zoom, x: cam.position.x, z: cam.position.z };
});
await page.screenshot({ path: join(HERE, 'island-scale-floor.png') });
}

await browser.close();

console.log(JSON.stringify({ pondAt, floor }, null, 2));
console.log('shots', pondShot, pondCrop);
if (problems.length > 0) {
  console.error('island-scale-shot FAILED:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('island-scale-shot ok — no shader log, no page error');
}
