/**
 * The lake with its islet gone, seen (2026-09-17, user ask — *"let's remove
 * the small island within the island."*, src/world/landscape.ts
 * `LAKE_ISLET_ON_ISLAND`).
 *
 * Three frames on the katamari world at 1280x800:
 *
 *   lake-islet-gone.png       the default framing panned over the lake's
 *                             centre — open water edge to edge, no hill, no
 *                             second drawn shoreline.
 *   lake-islet-gone-crop.png  the lake itself, 520x400 around it.
 *   lake-islet-minimap.png    the minimap crop: one grey lake, nothing
 *                             painted back over it.
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4290 --strictPort   (in another shell)
 *   node scratch/lake-islet-shot.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 4290);
/** The lake's centre on the scaled map: (80, 70) * 1.32. */
const LAKE = { x: 105.6, z: 92.4 };

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

// SHIFT+drag pans; a plain drag orbits (src/world/scene.ts).
const cx = 640;
const cy = 400;
for (let attempt = 0; attempt < 6; attempt++) {
  const at = await screenOf(LAKE);
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
// …then out, far enough that the whole lake is in frame. At the default
// framing 1280 px is ~64 world units and the lake is 110 across, so the frame
// is INSIDE it: open water and ripples, which is true but unreadable.
const OUT = Number(process.env['OUT'] ?? 16);
await page.mouse.move(cx, cy);
for (let i = 0; i < OUT; i++) {
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(12_000);
const lakeAt = await screenOf(LAKE);
await page.waitForTimeout(6_000);
const full = join(HERE, 'lake-islet-gone.png');
await page.screenshot({ path: full });
const crop = join(HERE, 'lake-islet-gone-crop.png');
const clipX = Math.min(760, Math.max(0, Math.round(lakeAt.px) - 260));
const clipY = Math.min(400, Math.max(0, Math.round(lakeAt.py) - 200));
await page.screenshot({ path: crop, clip: { x: clipX, y: clipY, width: 520, height: 400 } });

// …and the map of it.
const map = join(HERE, 'lake-islet-minimap.png');
const box = await page.locator('canvas.world-minimap').first().boundingBox();
if (box) {
  await page.screenshot({
    path: map,
    clip: {
      x: Math.max(0, box.x - 6),
      y: Math.max(0, box.y - 6),
      width: Math.min(1280, box.width + 12),
      height: Math.min(800, box.height + 12),
    },
  });
}

await browser.close();

console.log(JSON.stringify({ lakeAt, map: box }, null, 2));
console.log('shots', full, crop, box ? map : '(no minimap canvas found)');
if (problems.length > 0) {
  console.error('lake-islet-shot FAILED:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('lake-islet-shot ok — no shader log, no page error');
}
