/**
 * A REAL PACKED PILE, as a person sees it.
 *
 * > User asks, 2026-09-17: *"the character should be the object that the
 * > items stick to"* / *"the entire mass of objects should keep their original
 * > size"* — and then the corner's live view: *"in the top left hand corner we
 * > should show a live view of the character and the objects it collects."*
 *
 * Every earlier harness SEATED the pile by hand (`scratch/ball-scale-shot.mjs`
 * puts fifteen props on a fibonacci sphere of radius `bodyR` through
 * `applyStick`), which is not what the game draws any more: the seats are
 * packed against the character and against each other by `packSeatDistance`,
 * on the page that decides the pickup. So this one DRIVES — a real creature
 * over the real island's real props, with the game's own contact pass deciding
 * every stick and computing every seat — and shoots the result:
 *
 *   VIEW=projection  1280x800, dpr 1, `?host=1`: the default framing, plus a
 *                    crop on the creature so the packing is legible.
 *   VIEW=phone       390x844, dpr 3, with a drawing already in storage (which
 *                    is what mounts the tray, the readout and the corner's
 *                    live view): the same pile in the inset, with the readout
 *                    clear underneath it.
 *
 * It drives toward the nearest prop, waits for the pile to reach `ITEMS`
 * items, and prints what it measured — the item count, the packed reach
 * (`pileReach`), the readout's `ballDiameter`, and for the phone the corner's
 * two boxes and the gap between them.
 *
 *   VITE_WORLD=valiocon npm run build
 *   VIEW=projection node scratch/packed-pile-shot.mjs
 *   VIEW=phone node scratch/packed-pile-shot.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4291);
const VIEW = process.env['VIEW'] === 'phone' ? 'phone' : 'projection';
const ITEMS = Number(process.env['ITEMS'] ?? 12);
const ROOM = 'xkcd';
const ID = 'packed1';

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

// The same four-stroke creature every katamari harness draws with.
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
    ? {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      }
    : { viewport: { width: 1280, height: 800 } },
);
/*
 * A PHONE WITH A DRAWING ALREADY IN IT. `myDrawerId` is read out of storage at
 * boot and it is what mounts the tray, the readout and the live view, so the
 * handset shot needs it there before the page loads (the same arrangement as
 * scratch/portrait-smoke.mjs).
 */
if (VIEW === 'phone') {
  await context.addInitScript(
    ([room, id, s]) => {
      try {
        localStorage.setItem(`refworld:${room}:mydrawing`, JSON.stringify({ id, strokes: s }));
        localStorage.setItem('refworld:drawer', id);
      } catch {
        /* a private window is not what this harness runs in */
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
/*
 * …AND FOR THE PROPS. The scatter is built a little after the manager exists,
 * and the spawn below is chosen by what is lying around each candidate spot —
 * asked a frame too early, `__refworldColliders` answers an empty list and
 * every spot scores zero (measured: a run that picked a spawn 154 units from
 * the origin, off the side of the frame).
 */
await page.waitForFunction(() => (window.__refworldColliders?.() ?? []).length > 50, null, {
  timeout: 600_000,
});

/*
 * ONE CREATURE, WHERE THE JUNK IS. `spawnSpot` is a pure function of the slot
 * id and nothing moves a creature from the outside, so the way to choose a
 * spot is to try ids — and the spot that matters is not the one nearest the
 * origin but the one with the most PICKABLE props around it. A headless
 * chromium on swiftshader walks a creature at about a fifth of a unit a
 * second, so a spawn with its nearest stone eight units away spends two
 * minutes getting to its first pickup, and one behind a building spends the
 * whole run there (measured — the first three runs of this harness).
 */
const chosen = await page.evaluate(
  ([id, s]) => {
    const m = window.__refworldCreatures;
    const probes = [];
    for (let i = 0; i < 24; i++) probes.push(`${id}-${i}`);
    for (const p of probes) m.spawn(p, s, { hatchMs: 100, grown: true });
    const colliders = window.__refworldColliders?.() ?? [];
    // What a hatchling can take: `carryLimit` is 1.15 x its own radius.
    const limit = 1.15 * 0.95;
    let best = null;
    for (const p of m.poses()) {
      let near = 0;
      for (const c of colliders) {
        if (!(c.r <= limit)) continue;
        if (Math.hypot(c.x - p.x, c.z - p.z) <= 10) near++;
      }
      const score = { id: p.id, near, d: Math.hypot(p.x, p.z), x: p.x, z: p.z };
      // The junk first, the framing second: a spot with things to eat, and of
      // those the one nearest where the camera is already looking.
      if (!best || score.near > best.near || (score.near === best.near && score.d < best.d)) {
        best = score;
      }
    }
    for (const p of probes) if (p !== best.id) m.clear(p);
    return best;
  },
  [ID, strokes],
);
console.log('creature at', chosen);
await page.waitForTimeout(10_000);

/*
 * THE DRIVE. A hand on the creature, re-published on an interval the way a
 * thumb on the stick would be (a drive decays — `isDriven` has a timeout),
 * pointed at the nearest prop still standing: `__refworldColliders` is the
 * scatter's own list, which is the list the pickup pass reads.
 */
await page.evaluate((id) => {
  const m = window.__refworldCreatures;
  /*
   * NO `pauseAi` HERE, and that was the first run's mistake: `simulating()`
   * is `katamari && deciding() && !aiPaused` (src/creatures/manager.ts), so
   * pausing the ai does not just stand the wanderer down — it turns the whole
   * game off on this page, and the creature sat on its spawn spot for two
   * minutes with a stone eight units away. A drive stands the agent down by
   * itself (`isDriven`), which is all this harness wanted.
   */
  const colliders = () => window.__refworldColliders?.() ?? [];
  let held = null;
  let heldUntil = 0;
  let wasAt = null;
  let stalledSince = 0;
  window.__packedDrive = setInterval(() => {
    const me = m.poses().find((p) => p.id === id);
    if (!me) return;
    /*
     * BUMP AND TURN. The island has hard props on it — a building is not
     * something a hatchling picks up, it is a wall — and a hand that points
     * at the nearest stone behind one holds the creature against it forever
     * (measured: three ticks at the same coordinate, 1.35 u short of a
     * pebble). So a creature that has not moved for two seconds takes a
     * fixed turn for the next few, which is what a person's thumb does.
     */
    const now = Date.now();
    if (!wasAt || Math.hypot(me.x - wasAt.x, me.z - wasAt.z) > 0.25) {
      wasAt = { x: me.x, z: me.z };
      stalledSince = now;
    }
    if (now - heldUntil > 0 && now - stalledSince > 2000) {
      const turn = (now / 1000) % (Math.PI * 2);
      held = { x: Math.cos(turn), z: Math.sin(turn) };
      heldUntil = now + 4000;
      stalledSince = now;
    }
    if (held && now < heldUntil) {
      m.drive(id, { x: held.x, z: held.z, mag: 1 });
      return;
    }
    /*
     * THE NEAREST THING IT CAN ACTUALLY EAT. `carryLimit` is
     * `PICKUP_RATIO x carrierR` (src/creatures/sticky.ts, 1.15) and anything
     * over it is an OBSTACLE — a hatchling parked against a tree it can
     * never pick up is what the first run of this harness did for two
     * minutes. The limit grows with the pile, so the targets get bigger as
     * the game intends.
     */
    const limit = 1.15 * (m.ballDiameter(id) / 2);
    let best = null;
    for (const c of colliders()) {
      if (!(c.r <= limit)) continue;
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      // Already under it: something it cannot reach is the next target.
      if (d < 0.5) continue;
      if (!best || d < best.d) best = { d, x: c.x, z: c.z };
    }
    if (!best) return;
    const dx = best.x - me.x;
    const dz = best.z - me.z;
    const len = Math.hypot(dx, dz) || 1;
    m.drive(id, { x: dx / len, z: dz / len, mag: 1 });
  }, 120);
}, chosen.id);

/** What the pile IS, off the rig — the drawn seats, not a record. */
const pileOf = () =>
  page.evaluate((id) => {
    const m = window.__refworldCreatures;
    const root = m.rootOf(id);
    const clump = root?.getObjectByName('clump') ?? null;
    const seats = (clump?.children ?? []).filter(
      (o) => typeof o.name === 'string' && o.name.startsWith('loose'),
    );
    const me = m.poses().find((p) => p.id === id) ?? null;
    // Where it is and what it is chasing: a harness that reports neither
    // cannot tell a creature that will not move from a world with nothing in
    // it that this creature is allowed to pick up.
    const limit = 1.15 * (m.ballDiameter(id) / 2);
    let near = null;
    for (const c of window.__refworldColliders?.() ?? []) {
      if (!me) break;
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if (!near || d < near.d) near = { d: +d.toFixed(2), r: c.r, kind: c.kind, take: c.r <= limit };
    }
    return {
      items: seats.length,
      reach: Number(m.pileReach(id).toFixed(3)),
      diameter: Number(m.ballDiameter(id).toFixed(3)),
      roll: Number(m.rollBlend(id).toFixed(3)),
      at: me ? { x: +me.x.toFixed(2), z: +me.z.toFixed(2) } : null,
      limit: +limit.toFixed(2),
      near,
    };
  }, chosen.id);

let pile = await pileOf();
for (let tick = 0; tick < 60 && pile.items < ITEMS; tick++) {
  await page.waitForTimeout(5_000);
  pile = await pileOf();
  console.log('pile', tick, JSON.stringify(pile));
}
/*
 * Then the hand comes off and the pile settles where it stands: a seat slides
 * in over `MOTION.primaryMs` and a creature under a thumb is a blur at this
 * frame rate.
 */
await page.evaluate(() => {
  clearInterval(window.__packedDrive);
  window.__refworldCreatures.clearDrives();
});
await page.waitForTimeout(25_000);
pile = await pileOf();
console.log('pile settled', JSON.stringify(pile));

if (VIEW === 'phone') {
  const corner = await page.evaluate(() => {
    const el = document.querySelector('.world-size-inset');
    const row = document.querySelector('.world-size-row');
    if (!el || !row) return null;
    const r = el.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    return {
      circle: {
        x: +r.x.toFixed(2),
        y: +r.y.toFixed(2),
        w: +r.width.toFixed(2),
        h: +r.height.toFixed(2),
      },
      row: {
        x: +rr.x.toFixed(2),
        y: +rr.y.toFixed(2),
        w: +rr.width.toFixed(2),
        h: +rr.height.toFixed(2),
      },
      gap: +(rr.y - (r.y + r.height)).toFixed(2),
      text: document.querySelector('.world-size-value')?.textContent ?? null,
    };
  });
  console.log('corner', JSON.stringify(corner));
  const shot = join(HERE, 'packed-phone-390x844.png');
  await page.screenshot({ path: shot });
  console.log('shot', shot);
} else {
  const full = join(HERE, 'packed-projection-1280x800.png');
  await page.screenshot({ path: full });
  console.log('shot', full);
  /*
   * AND A CROP ON THE CREATURE, because a pile a few metres across is a small
   * part of a 528-unit island. The creature's world position goes through the
   * world's own camera, and the crop is sized off a second point one reach
   * above it — so the frame follows the mass at whatever it grew to, with no
   * assumption about the projection.
   */
  const box = await page.evaluate((id) => {
    const m = window.__refworldCreatures;
    const camera = window.__refworldCamera;
    const at = m.positionOf(id);
    if (!at || !camera) return null;
    const reach = Math.max(1, m.pileReach(id));
    const p = at.clone();
    p.project(camera);
    const q = at.clone();
    q.y += reach;
    q.project(camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const px = ((p.x + 1) / 2) * w;
    const py = ((1 - p.y) / 2) * h;
    const qy = ((1 - q.y) / 2) * h;
    return {
      px: +px.toFixed(1),
      py: +py.toFixed(1),
      radiusPx: +Math.abs(qy - py).toFixed(1),
      w,
      h,
    };
  }, chosen.id);
  console.log('crop box', JSON.stringify(box));
  if (box) {
    const pad = Math.max(120, box.radiusPx * 3);
    const x = Math.max(0, Math.round(box.px - pad));
    const y = Math.max(0, Math.round(box.py - pad));
    const width = Math.min(box.w - x, Math.round(pad * 2));
    const height = Math.min(box.h - y, Math.round(pad * 2));
    const crop = join(HERE, 'packed-projection-crop.png');
    await page.screenshot({ path: crop, clip: { x, y, width, height } });
    console.log('shot', crop);
  }
}

await browser.close();
server.kill('SIGTERM');
