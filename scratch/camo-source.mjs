/**
 * WHICH PASS DRAWS THE LOW-TILT BLOTCHES — one instrumented frame, three ways
 * (2026-09-17, the second camo report).
 *
 * The band limit and the water's new limits kill every world-space noise term
 * on the surface at the zoom floor, and the sea STILL reads mottled. So this
 * asks the page directly: it prints the shared band-limit uniform at the low
 * tilt (which says whether the limits are firing at all), and then takes the
 * same frame with the water hidden and with the scatter hidden, so whatever is
 * left can be named rather than guessed at.
 *
 *   VITE_WORLD=valiocon npm run build
 *   PORT=4380 node scratch/camo-source.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4380);
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
      /* next */
    }
  }
}
let executablePath;
if (existsSync('/opt/pw-browsers')) {
  const direct = join('/opt/pw-browsers', 'chromium', 'chrome-linux', 'chrome');
  if (existsSync(direct)) executablePath = direct;
  for (const d of readdirSync('/opt/pw-browsers')) {
    if (d.startsWith('chromium-')) {
      const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

const server = await preview({
  root: ROOT,
  preview: { port: PORT, host: '127.0.0.1', strictPort: true },
});
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(() => {
  try {
    localStorage.setItem('refworld:onboarded', '1');
  } catch {
    /* blocked store */
  }
});
const page = await context.newPage();
page.setDefaultTimeout(600_000);
await page.goto(
  `http://127.0.0.1:${PORT}/?view=world&host=1&room=${ROOM}&game=katamari&landscape=1&onboard=0`,
  { waitUntil: 'load', timeout: 600_000 },
);
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.waitForTimeout(20_000);

for (let i = 0; i < 24; i++) {
  await page.mouse.move(195, 420);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(18_000);
await page.mouse.move(195, 420);
await page.mouse.down();
for (let i = 1; i <= 30; i++) {
  await page.mouse.move(195, 420 - i * 10);
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.waitForTimeout(15_000);

/** The shared band-limit uniform, off the sea's own material — plus what each
 * term's limit evaluates to at it, computed here the way the shader does. */
console.log(
  'UNIFORMS',
  JSON.stringify(
    await page.evaluate(() => {
      const found = [];
      const seen = new Set();
      window.__refworldWater?.group?.traverse?.((o) => {
        const m = o.material;
        if (!m || !m.uniforms || seen.has(m.name)) return;
        seen.add(m.name);
        found.push({
          name: m.name,
          visible: o.visible,
          toonOn: m.uniforms.uToonOn?.value ?? null,
          unitsPerPx: m.uniforms.uToonUnitsPerPx?.value ?? null,
        });
      });
      const smooth = (e0, e1, x) => {
        const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
      };
      const u = found[0]?.unitsPerPx ?? null;
      const limits = {};
      if (u) {
        for (const c of [0.0667, 0.18, 0.529, 0.55, 0.769, 0.8, 1.6, 1.9, 2, 3.5, 6, 7]) {
          limits[c] = Number(smooth(1.5, 2.5, 1 / (c * u)).toFixed(3));
        }
      }
      return { materials: found, limits };
    }),
    null,
    1,
  ),
);

const shot = (n) => page.screenshot({ path: join(HERE, `camo-source-${n}.png`) });
await shot('all');

await page.evaluate(() => {
  window.__refworldWater.group.visible = false;
  if (window.__refworldWater.paintedGroup) window.__refworldWater.paintedGroup.visible = false;
});
await page.waitForTimeout(12_000);
await shot('nowater');

await page.evaluate(() => {
  window.__refworldWater.group.visible = true;
  if (window.__refworldWater.paintedGroup) window.__refworldWater.paintedGroup.visible = true;
  window.__refworldScatter.group.visible = false;
});
await page.waitForTimeout(12_000);
await shot('noscatter');

await browser.close();
await server.close();
console.log('shots', join(HERE, 'camo-source-*.png'));
