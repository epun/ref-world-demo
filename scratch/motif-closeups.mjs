/**
 * Close-up studies of the three new motif families (2026-09-09 user ask:
 * a grass-tuft alphabet, flower clusters, a cloud taxonomy).
 *
 * One brush at a time, painted over the origin the camera already looks at —
 * so the framing is a wheel zoom and nothing else, and each family is read
 * against empty paper rather than against the rest of the kit.
 *
 *   node scratch/motif-closeups.mjs [outDir]
 */

import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? HERE;
mkdirSync(OUT, { recursive: true });
const PW = process.env['PLAYWRIGHT_DIR'] ?? '/opt/node22/lib/node_modules/playwright';
const req = createRequire(join(PW, 'package.json'));
const { chromium } = req('playwright');

const browserRoot = '/opt/pw-browsers';
const candidates = [];
for (const d of readdirSync(browserRoot)) {
  if (d.startsWith('chromium-')) candidates.push(join(browserRoot, d, 'chrome-linux', 'chrome'));
  if (d.startsWith('chromium_headless_shell-')) {
    candidates.push(join(browserRoot, d, 'chrome-linux', 'headless_shell'));
  }
}

const W = 1200;
const H = 820;
const server = await createServer({
  root: join(HERE, '..'),
  server: { host: '127.0.0.1', hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: candidates.find((p) => existsSync(p)),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
const url = server.resolvedUrls.local[0];
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__refworldPaint), null, { timeout: 180000 });
const settle = (ms) => page.evaluate((d) => new Promise((r) => setTimeout(r, d)), ms);

const zoom = async (clicks) => {
  await page.mouse.move(W / 2, H / 2);
  for (let i = 0; i < Math.abs(clicks); i++) await page.mouse.wheel(0, clicks > 0 ? -300 : 300);
  await settle(1800);
};

/** Paint one brush over a disc centred on the origin, alone. */
const only = (brush, radius, ring) =>
  page.evaluate(
    ({ brush, radius, ring }) => {
      const p = window.__refworldPaint;
      p.applyPaint({ k: 'paint', t: 0, tool: 'clear' });
      const dab = (x, z, i) =>
        p.applyPaint({
          k: 'paint',
          t: 0,
          tool: brush,
          x,
          z,
          r: radius,
          strength: 1,
          hardness: 0.8,
          mode: 'add',
          seed: i,
        });
      dab(0, 0, 0);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        dab(Math.cos(a) * ring, Math.sin(a) * ring, i + 1);
      }
      p.rebuild();
      const counts = {};
      window.__refworldScatter.group.traverse((o) => {
        if (o.isInstancedMesh && o.count > 0) counts[o.name] = o.count;
      });
      return counts;
    },
    { brush, radius, ring },
  );

const shot = async (name, brush, radius, ring, clicks) => {
  console.log(name, JSON.stringify(await only(brush, radius, ring)));
  await zoom(clicks);
  await settle(1600);
  await page.screenshot({ path: join(OUT, `brush-${name}.png`) });
  await zoom(-clicks);
};

await shot('closeup-grass', 'grass', 14, 16, 11);
await shot('closeup-flowers', 'flowers', 14, 16, 11);
await shot('closeup-clouds', 'clouds', 26, 34, 3);

await browser.close();
await server.close();
console.log('shots in', OUT);
