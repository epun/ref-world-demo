/**
 * THE MULTI-PAGE ROOM, end to end (user report, 2026-09-17: *"people can't
 * move on their mobile devices"*, *"some characters get stuck when trying to
 * move and glitch on mobile"*).
 *
 * Everything about a phone steering its creature is unit-tested on ONE page:
 * a hatchling drives (test/creatures/manager.ts), a phone host with no rapier
 * drives (test/creatures/phone-host.test.ts). What was never exercised is the
 * room: a handset that is a VIEWER publishes its stick over mqtt, whichever
 * page is host applies it, and the handset gets its own creature back as a
 * pose. Four things have to be true along that path and none of them are
 * visible from a single page.
 *
 * So this stands the room up for real: a local mqtt broker (aedes over ws),
 * one `vite preview`, and THREE chromium pages against it —
 *
 *   H  a projection, 1280x800, `?host=1` → a `forced` id, wins the election;
 *   A  a handset, 390x844, coarse pointer, with its own stored submission;
 *   B  a second handset, likewise.
 *
 * Both handsets' drawings arrive the way a real one does — published on the
 * feed topic from node, exactly the packet /draw/ sends — so all three pages
 * build the identical creatures out of the pure pipeline.
 *
 * Then, in four steps, phone A's creature is steered by a TOUCH DRAG on the
 * stick element (never `__refworldCreatures.drive`, which would skip the whole
 * thing under test) and every page is asked where that creature is:
 *
 *   1. with the projection hosting;
 *   2. with the projection's tab unfocused and hidden (a backgrounded host);
 *   3. with the projection CLOSED, so a phone wins the election and hosts;
 *   4. with both phones driving at once.
 *
 * Every packet on the sync topic is captured at the broker, so a step that
 * fails says which message was missing rather than that a pixel did not move.
 *
 * Playwright and aedes are not this repo's dependencies; both are resolved out
 * of whatever checkout or scratch dir has them, the same way
 * scratch/size-readout-smoke.mjs resolves playwright.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/room-drive-smoke.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4240);
const BROKER_PORT = Number(process.env['BROKER_PORT'] ?? 8084);
const ROOM = 'xkcd';
const A = 'phonea';
const B = 'phoneb';
const SYNC_TOPIC = `drawto3d/v1/${ROOM}/world`;
const FEED_TOPIC = `drawto3d/v1/${ROOM}`;

// ── the modules this machine keeps somewhere else ───────────────────────────
const req = createRequire(import.meta.url);
const SCRATCH_DIRS = [
  process.env['SMOKE_DEPS'] ?? '',
  '/tmp/claude-0/-home-user-ref-world-demo/b8854e85-6e9e-5684-9255-083064bc6780/scratchpad',
].filter(Boolean);

// A dir that has the package resolves it with its OWN require, so a package
// whose `exports` map is the only way in still resolves.
const inDirs = (name) =>
  SCRATCH_DIRS.flatMap((d) => {
    try {
      return [createRequire(join(d, 'package.json')).resolve(name)];
    } catch {
      return [];
    }
  });

async function load(name, extra = []) {
  for (const from of [name, ...extra, ...inDirs(name)]) {
    try {
      return await import(from);
    } catch {
      try {
        return req(from);
      } catch {
        /* next candidate */
      }
    }
  }
  throw new Error(`no ${name} on this machine (set SMOKE_DEPS to a dir that has it)`);
}

const { chromium } = await load('playwright', [
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  join(process.env['ENVPAINT_DIR'] ?? '/home/user/envpaint', 'node_modules/playwright'),
]);
const aedesMod = await load('aedes');
const wsMod = await load('ws');
const mqttMod = await load('mqtt');
const Aedes = aedesMod.Aedes ?? aedesMod.default;
const ws = wsMod.default ?? wsMod;
const WebSocketServer = ws.WebSocketServer ?? ws.Server ?? wsMod.WebSocketServer;
const createWebSocketStream = ws.createWebSocketStream ?? wsMod.createWebSocketStream;
const mqtt = mqttMod.default ?? mqttMod;

let executablePath;
if (existsSync('/opt/pw-browsers')) {
  for (const d of readdirSync('/opt/pw-browsers')) {
    if (!d.startsWith('chromium-')) continue;
    const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
    if (existsSync(at)) executablePath = at;
  }
}

// ── the broker, with a tap on it ────────────────────────────────────────────
const traffic = [];
const aedes = Aedes.createBroker ? await Aedes.createBroker() : new Aedes();
aedes.on('publish', (packet, client) => {
  if (!client) return;
  const topic = String(packet.topic);
  if (topic !== SYNC_TOPIC && topic !== FEED_TOPIC && topic !== `${FEED_TOPIC}/up`) return;
  traffic.push({
    at: Date.now(),
    topic,
    from: client.id,
    payload: packet.payload ? packet.payload.toString().slice(0, 400) : '',
  });
});
const httpd = createServer();
const wss = new WebSocketServer({ server: httpd });
wss.on('connection', (socket) => {
  const stream = createWebSocketStream(socket, { decodeStrings: false });
  stream.on('error', () => {});
  aedes.handle(stream);
});
await new Promise((r) => httpd.listen(BROKER_PORT, '127.0.0.1', r));
const BROKER = `ws://127.0.0.1:${BROKER_PORT}/mqtt`;
console.log('broker at', BROKER);

const since = () => traffic.length;
const sinceThen = (mark, kind) =>
  traffic
    .slice(mark)
    .filter((m) => m.topic === SYNC_TOPIC && (!kind || m.payload.includes(`"t":"${kind}"`)));

// ── the site ────────────────────────────────────────────────────────────────
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

// The kit's WIRE form, which is what a phone stores and publishes.
const wire = [
  { width: 90, pts: [[0.5, 0.62]] },
  { width: 60, pts: [[0.5, 0.34]] },
  { width: 14, pts: [[0.42, 0.8], [0.42, 0.95]] },
  { width: 14, pts: [[0.58, 0.8], [0.58, 0.95]] },
];

const url = (extra) =>
  `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&broker=${encodeURIComponent(BROKER)}${extra}`;

async function openPage(label, { phone, id, extra = '' }) {
  const context = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 900, height: 600 } },
  );
  if (id) {
    await context.addInitScript(
      ([room, who, drawing]) => {
        try {
          localStorage.setItem(
            `refworld:submission:${room}`,
            JSON.stringify({ id: who, name: null, strokes: drawing, ts: Date.now(), epoch: null }),
          );
          localStorage.setItem('refworld:drawer', who);
          localStorage.setItem('refworld:hinted-emote', '1');
        } catch {
          /* a blocked store mounts no tray, and the run says so */
        }
      },
      [ROOM, id, wire],
    );
  }
  const page = await context.newPage();
  page.setDefaultTimeout(600_000);
  page.on('pageerror', (e) => console.log(`[${label} pageerror]`, String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[${label} console]`, m.text().slice(0, 200));
  });
  const t0 = Date.now();
  await page.goto(url(extra), { waitUntil: 'commit', timeout: 600_000 });
  console.log(`[${label}] commit ${Date.now() - t0}ms ${page.url()}`);
  await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
  console.log(`[${label}] manager ${Date.now() - t0}ms`);
  await page.waitForFunction(() => Boolean(window.__refworldSync), null, { timeout: 600_000 });
  console.log(`[${label}] up ${Date.now() - t0}ms`);
  return { label, page, context, cdp: await context.newCDPSession(page) };
}

/*
 * HIDE A PAGE WHILE THE NEXT ONE BOOTS.
 *
 * Three live WebGL worlds share ONE swiftshader process on this machine, and
 * a page already drawing one starves the next page's boot into the tens of
 * minutes (measured: 6s alone, over 15 minutes with one other page up). A
 * HIDDEN page stops its rAF, which is the whole of the cost; its timers keep
 * running at 1hz, so the mqtt keepalive holds, and if the socket does drop
 * mqtt.js reconnects and `startWorldSync` re-subscribes on connect.
 *
 * Nothing about the test's subject: every page is ACTIVE for every step.
 */
async function lifecycle(p, state) {
  try {
    await p.cdp.send('Page.enable');
    await p.cdp.send('Page.setWebLifecycleState', { state });
  } catch (e) {
    console.log(`[${p.label}] lifecycle ${state}:`, String(e).slice(0, 120));
  }
}

const host = await openPage('H', { phone: false, extra: '&host=1' });
await lifecycle(host, 'frozen');
const one = await openPage('A', { phone: true, id: A });
await lifecycle(one, 'frozen');
const two = await openPage('B', { phone: true, id: B });
const pages = [host, one, two];
for (const p of pages) await lifecycle(p, 'active');
// Let the election settle and the first rosters go round with everybody
// drawing again.
await new Promise((r) => setTimeout(r, 10_000));

const sync = async (p) => p.page.evaluate(() => window.__refworldSync());
const posesOf = async (p, id) =>
  p.page.evaluate((who) => {
    const all = window.__refworldCreatures.poses();
    const mine = all.find((q) => q.id === who);
    return mine ? { x: +mine.x.toFixed(3), z: +mine.z.toFixed(3) } : null;
  }, id);
const roles = async () => {
  const out = {};
  for (const p of pages) {
    if (p.closed) continue;
    const s = await sync(p);
    out[p.label] = { me: s.me, hosting: s.hosting, winner: s.winner, roster: s.roster };
  }
  return out;
};

// ── the drawings arrive the way a phone's does ──────────────────────────────
const pub = mqtt.connect(BROKER);
await new Promise((r) => pub.on('connect', r));
for (const id of [A, B]) {
  pub.publish(FEED_TOPIC, JSON.stringify({ id, name: null, strokes: wire, ts: Date.now() }));
}
console.log('published two drawings on', FEED_TOPIC);

// The public hatch clock is 7s; the pure pipeline takes a moment on a
// software renderer. Wait for the creature to be ALIVE on every page.
for (const p of pages) {
  await p.page.waitForFunction(
    (ids) => ids.every((id) => window.__refworldCreatures.liveIds().includes(id)),
    [A, B],
    { timeout: 600_000 },
  );
  console.log(`[${p.label}] both creatures alive`);
}

console.log('roles:', JSON.stringify(await roles()));

// ── the drag ────────────────────────────────────────────────────────────────
/** Hold the stick toward one corner for `ms`, with real touch events. */
async function holdStick(p, ms, dir = { dx: 0, dy: -1 }) {
  const box = await p.page.evaluate(() => {
    const el = document.querySelector('.world-stick');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, r: r.width / 2 };
  });
  if (!box) throw new Error(`${p.label}: no stick on this page`);
  const cdp = p.cdp;
  const at = (f) => [{ x: box.cx + dir.dx * box.r * f, y: box.cy + dir.dy * box.r * f }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0.1) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(0.9) });
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(0.9) });
    await new Promise((r) => setTimeout(r, 200));
  }
  const held = await p.page.evaluate(
    () => document.querySelector('.world-stick')?.dataset.held ?? null,
  );
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return held;
}

const fail = [];
const steps = [];

async function step(name, body) {
  console.log(`\n── ${name} ──`);
  const mark = since();
  const out = await body(mark);
  steps.push({ name, ...out });
  console.log(JSON.stringify(out, null, 2));
}

/** Drive `p`'s creature and report where every page thinks it went. */
async function driveAndWatch(mark, who, drivers, ms = HOLD_MS) {
  const before = {};
  for (const p of pages) if (!p.closed) before[p.label] = await posesOf(p, who);
  const held = await Promise.all(drivers.map((d) => holdStick(d, ms)));
  const after = {};
  for (const p of pages) if (!p.closed) after[p.label] = await posesOf(p, who);
  // A pose frame is 200ms; give the world a second to say where it ended up.
  await new Promise((r) => setTimeout(r, 1500));
  const settled = {};
  for (const p of pages) if (!p.closed) settled[p.label] = await posesOf(p, who);
  const moved = {};
  for (const label of Object.keys(before)) {
    const a = before[label];
    const b = settled[label];
    moved[label] =
      a && b ? +Math.hypot(b.x - a.x, b.z - a.z).toFixed(3) : null;
  }
  const drives = sinceThen(mark, 'drive');
  return {
    who,
    held,
    before,
    after,
    settled,
    moved,
    roles: await roles(),
    driveMessages: drives.length,
    driveSample: drives.slice(0, 3).map((m) => m.payload),
    poseMessages: sinceThen(mark, 'poses').length,
    rosterSample: sinceThen(mark, 'roster').slice(0, 1).map((m) => m.payload),
  };
}

/**
 * How long a thumb is held, and how far the creature has to get.
 *
 * Generous on both counts, because a software renderer running three of these
 * pages at once draws a frame every second or so and a creature only advances
 * on a frame. On real hardware the same drag covers thirty units.
 */
const HOLD_MS = Number(process.env['HOLD_MS'] ?? 20000);
const MOVED = 0.1;

await step('1. projection hosting, phone A drives', async (mark) => {
  const out = await driveAndWatch(mark, A, [one]);
  for (const label of Object.keys(out.moved)) {
    if (!(out.moved[label] > MOVED)) fail.push(`step 1: ${A} did not move on ${label}`);
  }
  return out;
});

await step('2. host tab hidden and unfocused, phone A drives', async (mark) => {
  await host.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await lifecycle(host, 'frozen');
  const out = await driveAndWatch(mark, A, [one]);
  out.note = 'host backgrounded';
  for (const label of Object.keys(out.moved)) {
    if (!(out.moved[label] > MOVED)) fail.push(`step 2: ${A} did not move on ${label}`);
  }
  await lifecycle(host, 'active');
  return out;
});

await step('3. projection closed, a phone hosts, phone A drives', async (mark) => {
  await host.context.close();
  host.closed = true;
  // Two heartbeats plus the stale window, so the election has certainly run.
  await new Promise((r) => setTimeout(r, 9000));
  const out = await driveAndWatch(mark, A, [one]);
  for (const label of Object.keys(out.moved)) {
    if (!(out.moved[label] > MOVED)) fail.push(`step 3: ${A} did not move on ${label}`);
  }
  return out;
});

await step('4. both phones drive at once', async (mark) => {
  const before = {};
  for (const p of pages) {
    if (p.closed) continue;
    before[p.label] = { [A]: await posesOf(p, A), [B]: await posesOf(p, B) };
  }
  await Promise.all([holdStick(one, HOLD_MS), holdStick(two, HOLD_MS, { dx: 1, dy: 0 })]);
  await new Promise((r) => setTimeout(r, 1500));
  const after = {};
  const moved = {};
  for (const p of pages) {
    if (p.closed) continue;
    after[p.label] = { [A]: await posesOf(p, A), [B]: await posesOf(p, B) };
    moved[p.label] = {};
    for (const who of [A, B]) {
      const x = before[p.label][who];
      const y = after[p.label][who];
      moved[p.label][who] = x && y ? +Math.hypot(y.x - x.x, y.z - x.z).toFixed(3) : null;
      if (!(moved[p.label][who] > MOVED)) fail.push(`step 4: ${who} did not move on ${p.label}`);
    }
  }
  return { before, after, moved, roles: await roles(), driveMessages: sinceThen(mark, 'drive').length };
});

// ── what happened ───────────────────────────────────────────────────────────
const out = join(HERE, 'room-drive-traffic.json');
writeFileSync(out, JSON.stringify({ steps, traffic }, null, 2));
console.log('traffic', out, traffic.length, 'packets');

pub.end();
await browser.close();
await server.close();
await new Promise((r) => wss.close(() => httpd.close(() => aedes.close(r))));

if (fail.length > 0) {
  console.error(`room-drive-smoke FAILED:\n  ${fail.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('room-drive-smoke ok');
}
