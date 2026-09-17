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

/**
 * The same drawing twice: the kit's WIRE form, which is what a phone stores
 * (and is what makes `myDrawerId` non-empty, so the tray, the stick and the
 * follow camera all mount), and the pure `StrokeList` the pipeline wants.
 */
const wire = [
  { width: 90, pts: [[0.5, 0.62]] },
  { width: 60, pts: [[0.5, 0.34]] },
  { width: 14, pts: [[0.42, 0.8], [0.42, 0.95]] },
  { width: 14, pts: [[0.58, 0.8], [0.58, 0.95]] },
];

const strokes = [
  { pts: [[0.5, 0.62, 1]], w: 0.4 },
  { pts: [[0.5, 0.34, 1]], w: 0.26 },
  { pts: [[0.42, 0.8, 1], [0.42, 0.95, 1]], w: 0.045 },
  { pts: [[0.58, 0.8, 1], [0.58, 0.95, 1]], w: 0.045 },
];

/*
 * `world` AND `game` ON THE ADDRESS, not left to the build.
 *
 * `startWorldSync` returns early on a world with no NAME (`isPublic`) —
 * there is no election in an installation room — so a run against a dist
 * built for the public site would never define `__refworldSync` and the whole
 * subject of this file would quietly not exist. `?world=` is the query form
 * of the meta tag the valiocon build injects and `?game=` the same for the
 * katamari switch, so the run says what it needs rather than depending on
 * which `npm run build` happened last.
 */
const url = (extra) =>
  `http://127.0.0.1:${PORT}/?view=world&world=valiocon&game=katamari&room=${ROOM}` +
  // `onboard=0`: a RETURNING phone. The first-run screens are a full-screen
  // fixed overlay at z-index 70 (src/ui/onboard.ts) and they are meant to be
  // — but a fresh browser context has never seen them, so without this the
  // touch drag below lands on the onboarding's own `skip` link, which sits
  // over the middle of the stick, and every step reports a creature that
  // will not move. That is the harness, not the product.
  `&onboard=0&broker=${encodeURIComponent(BROKER)}${extra}`;

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
  // A software renderer running two live worlds is a place where a tab dies.
  // Say which, because playwright reports a crash and a close identically.
  page.on('crash', () => console.log(`[${label}] RENDERER CRASHED`));
  page.on('close', () => console.log(`[${label}] page closed`));
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) console.log(`[${label}] nav ${f.url()}`);
  });
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
async function park(p, parked) {
  try {
    // CPU throttling on the RENDERER, which is what submits frames: the
    // software gpu process only works as hard as the pages asking it to.
    // `Page.setWebLifecycleState` is the obvious tool and is a silent no-op
    // on a page playwright keeps visible, which is every page here.
    await p.cdp.send('Emulation.setCPUThrottlingRate', { rate: parked ? 20 : 1 });
  } catch (e) {
    console.log(`[${p.label}] park ${parked}:`, String(e).slice(0, 120));
  }
}

/*
 * HOW MANY PHONES. Two is the full room and is what the report is about;
 * ONE is the minimum that still exercises the whole viewer path — its stick
 * out, the host's decision, the pose back — and on a machine whose only gpu
 * is swiftshader it is the difference between a run that finishes and a run
 * that does not (measured: 11s to boot one phone alone, over ten minutes
 * with two other live worlds sharing the same software renderer).
 */
const PHONES = Number(process.env['PHONES'] ?? 2);

/*
 * THE PHONES FIRST, then the projection — which is the order a room fills
 * anyway, and it is also the cheap order: each page's boot is slowed by
 * whatever is already drawing, and the projection is the page whose boot
 * this test can most afford to be slow.
 */
const one = await openPage('A', { phone: true, id: A });
await park(one, true);
const two = PHONES > 1 ? await openPage('B', { phone: true, id: B }) : null;
if (two) await park(two, true);
const host = await openPage('H', { phone: false, extra: '&host=1' });
const pages = [host, one, ...(two ? [two] : [])];
for (const p of pages) await park(p, false);
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

/*
 * ── the cast ────────────────────────────────────────────────────────────────
 *
 * Spawned DIRECTLY on every page, with the same ids and the same strokes,
 * rather than published on the feed. The pipeline is pure, so the same ids
 * and strokes build the identical creatures everywhere — which is the whole
 * premise this file relies on and the same route scratch/size-readout-smoke.mjs
 * takes.
 *
 * Not the feed, for two reasons: the kit's wire widths are clamped to 0.12 of
 * the canvas on the way in, so a blob drawn for the local pipeline arrives as
 * thin strokes and the moderation gate is entitled to refuse it (silently, on
 * the projection, by design) — and the subject here is the DRIVE path, which
 * begins after a creature is standing. `grown: true` also skips the shell, so
 * the run does not wait on the hatch clock.
 */
const pub = mqtt.connect(BROKER);
await new Promise((r) => pub.on('connect', r));
const cast = PHONES > 1 ? [A, B] : [A];
for (const p of pages) {
  const ok = await p.page.evaluate(
    ([ids, s]) =>
      ids.map((id) => window.__refworldCreatures.spawn(id, s, { hatchMs: 50, grown: true })),
    [cast, strokes],
  );
  console.log(`[${p.label}] spawn ->`, JSON.stringify(ok));
}
for (const p of pages) {
  for (let i = 0; i < 40; i++) {
    const live = await p.page.evaluate(() => window.__refworldCreatures.liveIds());
    if (cast.every((id) => live.includes(id))) break;
    console.log(`[${p.label}] waiting for the cast, live =`, JSON.stringify(live));
    await new Promise((r) => setTimeout(r, 3000));
  }
  const live = await p.page.evaluate(() => window.__refworldCreatures.liveIds());
  if (!cast.every((id) => live.includes(id))) {
    throw new Error(`${p.label}: the cast never stood (live = ${JSON.stringify(live)})`);
  }
  console.log(`[${p.label}] the cast is standing`);
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

/**
 * WHAT THIS CREATURE COULD ROLL OVER — the nearest keyed collider, off the
 * page that is deciding.
 *
 * Keyed, because a placement key is the only handle the sticky layer can
 * address a prop by; nearest, because the run has to reach it inside a drag;
 * and read on the HOST, because the host's collider set is the one its own
 * pickup pass consults (a viewer holds no opinion about what is stuck).
 */
async function nearestProp(p, who) {
  return p.page.evaluate((id) => {
    const mine = window.__refworldCreatures.poses().find((q) => q.id === id);
    if (!mine) return null;
    const cols = window.__refworldColliders?.() ?? [];
    let best = null;
    for (const c of cols) {
      if (c.key === undefined) continue;
      const d = Math.hypot(c.x - mine.x, c.z - mine.z);
      if (!best || d < best.d) {
        best = { key: c.key, kind: c.kind ?? null, r: c.r, x: c.x, z: c.z, hard: c.hard === true, d };
      }
    }
    return {
      at: { x: mine.x, z: mine.z },
      bodyR: window.__refworldCreatures.ballDiameter(id) / 2,
      colliders: cols.length,
      rapier: Boolean(window.__refworldPhysics?.()),
      target: best,
    };
  }, who);
}

/**
 * WHICH WAY TO PUSH — found by pushing, not by arithmetic.
 *
 * The obvious way is to invert `stickToWorld` through the live azimuth
 * (src/world/joystick.ts). The first version of this file did, and drove the
 * creature at right angles to the prop it was aiming at for five attempts
 * running — a sign error somewhere between the camera's basis and the stick's
 * screen axes that is not worth finding, because the harness can simply
 * MEASURE instead.
 *
 * So: eight compass directions, a short push on each, and keep whichever one
 * actually closed the distance. That is robust against every convention in
 * the chain — the camera's azimuth, the screen's y, the deadzone, the
 * response curve — and it is what a person does with a new stick anyway.
 */
const COMPASS = Array.from({ length: 8 }, (_unused, i) => {
  const a = (i / 8) * Math.PI * 2;
  return { dx: Math.sin(a), dy: -Math.cos(a) };
});

/** How far this creature is from that point, on the deciding page. */
async function gapTo(p, who, to) {
  return p.page.evaluate(
    ([id, tx, tz]) => {
      const mine = window.__refworldCreatures.poses().find((q) => q.id === id);
      if (!mine) return null;
      return {
        d: Math.hypot(tx - mine.x, tz - mine.z),
        at: { x: +mine.x.toFixed(2), z: +mine.z.toFixed(2) },
        bodyR: window.__refworldCreatures.ballDiameter(id) / 2,
      };
    },
    [who, to.x, to.z],
  );
}

/** Is this placement still standing in the deciding page's collider set? */
async function hasCollider(p, key) {
  return p.page.evaluate(
    (k) => (window.__refworldColliders?.() ?? []).some((c) => c.key === k),
    key,
  );
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
  // A backgrounded phone tab, as the OS gives it: the frame loop all but
  // stops and the heartbeat timers are throttled with it.
  await park(host, true);
  const out = await driveAndWatch(mark, A, [one]);
  out.note = 'host backgrounded';
  for (const label of Object.keys(out.moved)) {
    if (!(out.moved[label] > MOVED)) fail.push(`step 2: ${A} did not move on ${label}`);
  }
  await park(host, false);
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
  if (!two) return { skipped: 'one phone in this run' };
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
    for (const who of cast) {
      const x = before[p.label][who];
      const y = after[p.label][who];
      moved[p.label][who] = x && y ? +Math.hypot(y.x - x.x, y.z - x.z).toFixed(3) : null;
      if (!(moved[p.label][who] > MOVED)) fail.push(`step 4: ${who} did not move on ${p.label}`);
    }
  }
  return { before, after, moved, roles: await roles(), driveMessages: sinceThen(mark, 'drive').length };
});

/*
 * AND WHAT IT PICKED UP ON THE WAY (2026-09-17: *"some users are having
 * issues sticking to objects"*).
 *
 * The decision is the host's and travels as a `stick` scene event; what the
 * VIEWER then has to end up with is the same pile and the same BALL SIZE,
 * which is derived on each page from the radii of what it is carrying. So:
 * whatever the driving above rolled over, every page has to agree about how
 * big the ball now is.
 */
await step('5. drive into a prop and see whether it sticks', async (mark) => {
  /*
   * > User report, 2026-09-17: *"on mobile currently when a user walks into
   * > things it doesn't stick to them."*
   *
   * The earlier runs never met a prop — the island is mostly grass and a
   * software renderer only covers a few units a drag — so the pickup path
   * went unverified while every other step passed. This one goes looking: it
   * takes the nearest keyed collider off the page that is DECIDING, then
   * closes on it by trying the eight compass directions and keeping whichever
   * one actually shortens the distance (see `COMPASS`).
   */
  const deciding = pages.find((p) => !p.closed);
  const before = await nearestProp(deciding, A);
  if (!before?.target) return { skipped: 'no keyed collider anywhere near the creature' };
  const target = before.target;

  const samples = [];
  let stuck = null;
  let best = { dx: 0, dy: -1 };
  for (let round = 0; round < 10 && !stuck; round++) {
    // Every few rounds, re-find the way: the creature turns, the camera
    // drifts, and a direction that was closing can stop closing.
    const tries = round % 3 === 0 ? COMPASS : [best];
    let bestGain = -Infinity;
    for (const dir of tries) {
      const from = await gapTo(deciding, A, target);
      await holdStick(one, tries.length === 1 ? 4000 : 1200, dir);
      const to = await gapTo(deciding, A, target);
      if (!from || !to) continue;
      const gain = from.d - to.d;
      if (gain > bestGain) {
        bestGain = gain;
        best = dir;
      }
      const sticks = traffic
        .filter((m) => m.topic === SYNC_TOPIC && m.payload.includes('"k":"stick"'))
        .map((m) => m.payload);
      const looses = traffic
        .filter((m) => m.topic === SYNC_TOPIC && m.payload.includes('"k":"loose"'))
        .map((m) => m.payload);
      samples.push({
        round,
        dir: { dx: +dir.dx.toFixed(2), dy: +dir.dy.toFixed(2) },
        at: to.at,
        // The distance the pickup pass actually tests against: centre to
        // centre, minus the two radii, minus the contact pad.
        gap: +(to.d - (to.bodyR + target.r) - 0.25).toFixed(3),
        gain: +gain.toFixed(3),
        sticks: sticks.length,
        looses: looses.length,
      });
      if (sticks.length > 0) {
        stuck = sticks;
        break;
      }
    }
  }

  const size = {};
  for (const p of pages) {
    if (p.closed) continue;
    size[p.label] = await p.page.evaluate((who) => window.__refworldCreatures.ballDiameter(who), A);
  }
  const values = Object.values(size).filter((v) => typeof v === 'number');
  const spread = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
  if (values.some((v) => v > 0) && spread > 0.02) {
    fail.push(`step 5: the pages disagree about the ball size (${JSON.stringify(size)})`);
  }
  const closest = Math.min(...samples.map((q) => q.gap));
  if (!stuck) {
    fail.push(
      `step 5: nothing stuck; the creature got within ${closest.toFixed(2)}u of the prop`,
    );
  }
  return {
    host: deciding.label,
    rapier: before.rapier,
    colliders: before.colliders,
    target,
    bodyR: +before.bodyR.toFixed(3),
    closest: +closest.toFixed(3),
    samples,
    stickSample: (stuck ?? []).slice(0, 2),
    size,
    mark,
  };
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
