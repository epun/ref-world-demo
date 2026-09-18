/**
 * A LADEN CREATURE, RENDERED — the picture the packing work never produced.
 *
 * > User, 2026-09-18, of two screenshots of creatures carrying nothing:
 * > *"This looks terrible still. The objects should be showing and it should
 * > be sticking to the character."*
 *
 * Every earlier harness failed for one of two reasons. `ball-scale-shot.mjs`
 * hand-seats its props with offsets of its own, so it renders an arrangement
 * the packer never made. `packed-pile-shot.mjs` drives a creature into the
 * junk for real — and on swiftshader a driven creature covers about a fifth
 * of a unit a second, so it spends the whole run travelling and collects
 * nothing.
 *
 * So this one CARRIES THE CREATURE TO THE PROPS instead of driving it: the
 * position is written straight onto the root between frames, the game's own
 * pickup pass fires the moment the overlap exists, and the seat comes out of
 * the real `clumpLocalOffset`/`packSeatDistance` on the deciding page. Four
 * frames a pickup rather than four hundred.
 *
 *   VITE_WORLD=valiocon npm run build
 *   VIEW=projection node scratch/laden-shot.mjs   # scratch/laden-projection-*.png
 *   VIEW=phone      node scratch/laden-shot.mjs   # scratch/laden-phone-390x844.png
 *
 * PNGs land in scratch/ and are gitignored; the harness is committed.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4295);
const VIEW = process.env['VIEW'] === 'phone' ? 'phone' : 'projection';
const WANT = Number(process.env['ITEMS'] ?? 14);
const ROOM = 'xkcd';
const ID = 'laden1';

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
const context = await browser.newContext(
  VIEW === 'phone'
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 } },
);
if (VIEW === 'phone') {
  await context.addInitScript(
    ([room, id, s]) => {
      try {
        localStorage.setItem(
          `refworld:submission:${room}`,
          JSON.stringify({ id, name: null, strokes: s, ts: Date.now(), epoch: null }),
        );
        localStorage.setItem('refworld:drawer', id);
        localStorage.setItem('refworld:hinted-emote', '1');
        localStorage.setItem('refworld:hinted:2', '1');
      } catch {
        /* not a private window */
      }
    },
    [ROOM, ID, strokes],
  );
}
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

const host = VIEW === 'phone' ? '' : '&host=1';
const url = `http://127.0.0.1:${PORT}/?view=world${host}&room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.waitForFunction(() => (window.__refworldColliders?.() ?? []).length > 50, null, {
  timeout: 600_000,
});
// The scatter's JUNK lands after its trees, and the junk is what a hatchling
// can actually carry.
await page.waitForTimeout(15_000);

await page.evaluate(
  ([id, s]) => {
    const m = window.__refworldCreatures;
    /*
     * NO `pauseAi(true)` HERE. It reads as "hold the wanderers still", but
     * `simulating()` reads it too — it switches the GAME off, so nothing can
     * be picked up. A run with it on teleported this creature onto ten props
     * and collected none of them, and the frame was a hatchling with an empty
     * pile (measured, 2026-09-18).
     */
    m.spawn(id, s, { hatchMs: 100, grown: true });
  },
  [ID, strokes],
);
await page.waitForTimeout(3000);

/*
 * THE PICKUPS. One prop at a time, nearest first among the ones this creature
 * can actually carry — `carryLimit` is 1.15 of its own radius and grows with
 * the pile, so the list is re-read after every one.
 */
const log = await page.evaluate(
  async ([id, want]) => {
    const m = window.__refworldCreatures;
    const root = m.rootOf(id);
    if (!root) return { error: 'no root' };
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const took = [];
    const start = { x: root.position.x, z: root.position.z };
    for (let n = 0; n < want; n++) {
      const before = m.ballDiameter(id);
      const bodyR = Math.max(0.5, before / 2);
      const here = { x: root.position.x, z: root.position.z };
      let best = null;
      for (const c of window.__refworldColliders?.() ?? []) {
        // What it can carry: the same 1.15 of its own radius the game uses,
        // kept a shade under so a marginal one does not simply shove.
        if (!(c.r > 0) || c.r > bodyR * 1.05) continue;
        const d = Math.hypot(c.x - here.x, c.z - here.z);
        if (d < 0.2) continue;
        if (!best || d < best.d) best = { x: c.x, z: c.z, r: c.r, d };
      }
      if (!best) break;
      // Carried, not driven: the pickup pass reads the overlap, and this is
      // the only way to get one inside a swiftshader frame budget.
      root.position.x = best.x;
      root.position.z = best.z;
      for (let f = 0; f < 8; f++) await frame();
      // Count what actually STUCK, not what was approached: the ball's own
      // size is the only honest witness.
      const after = m.ballDiameter(id);
      if (after > before + 1e-6) took.push({ r: Number(best.r.toFixed(3)), size: after });
    }
    // Back to where it hatched, then let the springs settle so the shot is of
    // a resting creature and not of a slide.
    root.position.x = start.x;
    root.position.z = start.z;
    for (let f = 0; f < 30; f++) await frame();
    const pos = m.positionOf(id);
    return {
      took: took.length,
      ballDiameter: m.ballDiameter(id),
      pileFloor: m.pileFloor?.(id) ?? null,
      pileFootprint: m.pileFootprint?.(id) ?? null,
      groundLift: m.groundLift?.(id) ?? null,
      at: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    };
  },
  [ID, WANT],
);
console.log('pickups', JSON.stringify(log, null, 2));

// Frame the creature: the projection's default view looks at the origin, and
// a creature that hatched elsewhere needs the camera brought to it.
if (VIEW === 'projection') {
  await page.evaluate((id) => {
    const m = window.__refworldCreatures;
    const rig = window.__refworldCameraRig ?? window.__refworldCamera;
    const pos = m.positionOf(id);
    if (!pos || !rig) return;
    if (typeof rig.lookAtGround === 'function') rig.lookAtGround(pos.x, pos.z);
    else if (rig.target?.set) rig.target.set(pos.x, 0, pos.z);
    if (typeof rig.setZoom === 'function') rig.setZoom(3.2);
    else if ('zoom' in rig) rig.zoom = 3.2;
  }, ID);
  await page.waitForTimeout(8000);
}

const name = VIEW === 'phone' ? 'laden-phone-390x844' : 'laden-projection-1280x800';
const shot = join(HERE, `${name}.png`);
await page.screenshot({ path: shot });
console.log('shot', shot);

if (VIEW === 'projection') {
  const box = await page.evaluate((id) => {
    const m = window.__refworldCreatures;
    const camera = window.__refworldCamera;
    const pos = m.positionOf(id);
    if (!pos || !camera) return null;
    const v = new (window.__refworldThree?.Vector3 ?? Object)();
    if (!v.set) return null;
    v.set(pos.x, pos.y, pos.z).project(camera);
    return {
      x: ((v.x + 1) / 2) * window.innerWidth,
      y: ((1 - v.y) / 2) * window.innerHeight,
    };
  }, ID);
  if (box) {
    const half = 260;
    const crop = join(HERE, 'laden-projection-crop.png');
    await page.screenshot({
      path: crop,
      clip: {
        x: Math.max(0, Math.round(box.x - half)),
        y: Math.max(0, Math.round(box.y - half)),
        width: half * 2,
        height: half * 2,
      },
    });
    console.log('crop', crop);
  } else {
    console.log('no crop — camera or creature not readable');
  }
}

await browser.close();
server.kill('SIGTERM');
console.log('laden-shot done');
