/**
 * The PROJECTION tier still compiles and still lays three fields
 * (2026-09-17).
 *
 * The phone work above touches two things a handset never compiles: the blade
 * field's and the bloom field's fragment shaders now carry the cel block's own
 * `precision highp float`, and a GLSL error there would only ever show on a
 * projection — as a blank frame with a console message, which is exactly the
 * class of bug this repo has a note about. So: a desktop viewport, a FINE
 * pointer, one screenshot, and the console watched for a shader log.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/projection-smoke.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4232);

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
  const direct = join(browserRoot, 'chromium', 'chrome-linux', 'chrome');
  if (existsSync(direct)) executablePath = direct;
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
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
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
// A FINE pointer: no isMobile, no touch — `deviceTier` answers 'projection'.
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.setDefaultTimeout(600_000);
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  if (/THREE.WebGLProgram|shader error|ERROR:|gl_FragColor/i.test(t)) {
    problems.push(t.slice(0, 600));
  }
});

await page.goto(`http://127.0.0.1:${PORT}/?view=world&host=1&room=xkcd&game=katamari&landscape=1`, {
  waitUntil: 'load',
  timeout: 600_000,
});
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.waitForTimeout(90_000);

const seen = await page.evaluate(() => {
  const r = window.__refworldRenderer;
  return {
    tier: window.matchMedia('(pointer: coarse)').matches ? 'phone' : 'projection',
    programs: r.info.programs.length,
    geometries: r.info.memory.geometries,
    // Which programs exist is the question: the two field shaders are named.
    named: r.info.programs.map((p) => p.name).filter((n) => /grass|flower|ghibli/i.test(n)),
  };
});
const shot = join(HERE, 'projection-1280x800.png');
await page.screenshot({ path: shot });
await browser.close();
await server.close();

console.log(JSON.stringify(seen, null, 2));
console.log('shot', shot);
if (problems.length > 0) {
  console.error('projection-smoke FAILED:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('projection-smoke ok — no shader log, no page error');
}
