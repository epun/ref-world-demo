/**
 * `?fresh=1` comes up with ZERO creatures — and a plain load still restores.
 *
 * The real projection against a real (mocked) store: the drawings endpoint
 * answers with a session log holding three drawings, exactly as the store
 * does after a run, and the page is opened three ways.
 *
 *   1. no flag        → the creatures come back (the demo-day property)
 *   2. ?fresh=1       → nothing stands up, and nothing was reset in the store
 *   3. ?mod=&fresh=1  → the reset is POSTed, the generation steps, still zero
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/fresh-load-smoke.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4239);
const SECRET = 'a-long-enough-secret';

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

// Three real drawings, taken off the recovered seed so the strokes are the
// shape the pipeline actually eats.
const seed = JSON.parse(readFileSync(join(ROOT, 'public/recovered/session.json'), 'utf8'));
const drawings = seed.events.filter((e) => e.k === 'drawing').slice(0, 3);

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

/** One load, with its own mocked store. Returns what stood up. */
async function run(query, { secret = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(240_000);
  const problems = [];
  const resets = [];
  let generation = 0;
  page.on('pageerror', (e) => problems.push(`pageerror ${String(e).slice(0, 300)}`));

  // The store's drawings, as api/drawings.ts serves them.
  await page.route('**/api/drawings**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schema: 'refworld.session',
        version: 1,
        epoch: `w-valiocon-g${generation}`,
        room: 'xkcd',
        startedAt: new Date().toISOString(),
        config: { hatchMs: 20000, maxPopulation: 64, generation, store: 'kv' },
        events: generation > 0 ? [] : drawings,
      }),
    });
  });
  // The moderator's endpoint: only a correct secret bumps, like the real one.
  await page.route('**/api/moderate**', async (route) => {
    const body = route.request().postDataJSON?.() ?? {};
    const given = route.request().headers()['x-moderator'] ?? '';
    resets.push({ reset: body?.reset === true, secret: given });
    if (given !== SECRET) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      return;
    }
    if (body?.reset === true) generation += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, generation }),
    });
  });
  await page.route('**/api/scene**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [], store: 'kv' }),
    });
  });

  const url =
    `http://127.0.0.1:${PORT}/?view=world&host=1&room=xkcd&world=valiocon` +
    (secret ? `&mod=${SECRET}` : '') +
    query;
  await page.goto(url, { waitUntil: 'load', timeout: 240_000 });
  await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
    timeout: 240_000,
  });
  // Long enough for the first pull, the worker pool and a few frames.
  await page.waitForTimeout(25_000);
  const creatures = await page.evaluate(() => window.__refworldCreatures.count());
  const address = page.url();
  await context.close();
  return { creatures, resets, generation, address, problems };
}

const plain = await run('');
const fresh = await run('&fresh=1');
const freshMod = await run('&fresh=1', { secret: true });

await browser.close();
await server.close();

const report = {
  plain: { creatures: plain.creatures, resets: plain.resets.length },
  fresh: { creatures: fresh.creatures, resets: fresh.resets.length, address: fresh.address },
  freshMod: {
    creatures: freshMod.creatures,
    resets: freshMod.resets,
    generation: freshMod.generation,
    address: freshMod.address,
  },
};
console.log(JSON.stringify(report, null, 2));

const fail = [];
if (plain.creatures !== drawings.length) {
  fail.push(`a plain load must restore ${drawings.length} — got ${plain.creatures}`);
}
if (plain.resets.length !== 0) fail.push('a plain load must not reset anything');
if (fresh.creatures !== 0) fail.push(`?fresh=1 must come up empty — got ${fresh.creatures}`);
if (fresh.resets.length !== 0) fail.push('?fresh=1 with no secret must not post a reset');
if (freshMod.creatures !== 0) {
  fail.push(`?mod=&fresh=1 must come up empty — got ${freshMod.creatures}`);
}
if (!freshMod.resets.some((r) => r.reset && r.secret === SECRET)) {
  fail.push('?mod=&fresh=1 must post {"reset":true} with the secret');
}
if (freshMod.generation !== 1) fail.push('the generation must step exactly once');
for (const [name, out] of [['plain', plain], ['fresh', fresh], ['freshMod', freshMod]]) {
  if (/[?&]fresh=/.test(out.address)) fail.push(`${name} left ?fresh= on the address`);
  if (/[?&]mod=/.test(out.address)) fail.push(`${name} left ?mod= on the address`);
  if (out.problems.length > 0) fail.push(`${name}: ${out.problems.join(' / ')}`);
}

if (fail.length > 0) {
  console.error('fresh-load-smoke FAILED:\n  ' + fail.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('fresh-load-smoke ok — a plain load restores, ?fresh=1 comes up empty');
}
