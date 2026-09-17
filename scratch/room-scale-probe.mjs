/**
 * IS THE CREATURE DRAWN AT ITS OWN SIZE IN A REAL ROOM? (user report,
 * 2026-09-17, off the live room: *"we are rendering a ball and the character
 * is growing with the size of the ball."*)
 *
 * The rider's counter-scale is verified on a host's own frame and in the
 * in-memory room (test/net/two-page-room.test.ts). This is the same question
 * asked of TWO REAL BROWSERS over a real broker, because the report came from
 * a phone watching a projection:
 *
 *   H  a projection, `?host=1` -> wins the election and hosts;
 *   A  a handset, 390x844, coarse pointer, with its own stored submission.
 *
 * Six props are put on A's creature ON THE HOST through the recorder's own
 * `stick` seam -- which is what puts a scene event on the wire (src/main.ts's
 * one scene tap) -- so the pile reaches the phone the way a real pickup does.
 * Then both pages are asked for the same numbers about that creature: the
 * root's scale (the growth), the CHARACTER's world scale (1 is its drawn size,
 * and the report is that it is not), the packed seats, and `bodyR`.
 *
 * Playwright, aedes, ws and mqtt are not this repo's dependencies; they are
 * resolved the way scratch/room-drive-smoke.mjs resolves them.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/room-scale-probe.mjs
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
 * HIDE A PAGE WHILE THE NEXT ONE BOOTS — two live WebGL worlds share one
 * swiftshader process here, and a page already drawing one starves the next
 * page's boot (see scratch/room-drive-smoke.mjs, which measured it). Nothing
 * about the subject: both pages are active for every reading.
 */
async function park(p, parked) {
  try {
    await p.cdp.send('Emulation.setCPUThrottlingRate', { rate: parked ? 20 : 1 });
  } catch (e) {
    console.log(`[${p.label}] park ${parked}:`, String(e).slice(0, 120));
  }
}

const one = await openPage('A', { phone: true, id: A });
await park(one, true);
const host = await openPage('H', { phone: false, extra: '&host=1' });
await park(one, false);
const pages = [host, one];
// Let the election settle and the first rosters go round.
await new Promise((r) => setTimeout(r, 12_000));

/** A's drawing, published on the feed the way /draw/ publishes it. */
const client = mqtt.connect(BROKER);
await new Promise((r) => client.on('connect', r));
client.publish(
  FEED_TOPIC,
  JSON.stringify({ t: 'drawing', id: A, name: null, room: ROOM, strokes: wire, ts: Date.now() }),
);
await new Promise((r) => setTimeout(r, 20_000));

const alive = async (p) =>
  p.page.evaluate((id) => Boolean(window.__refworldCreatures.rootOf(id)), A);
console.log('creature standing on H / A:', await alive(host), await alive(one));

/*
 * SIX PROPS, ON THE HOST, through the seam that records AND publishes.
 *
 * `__refworldSession.recorder.stick` is the recorder's own entry point and
 * src/main.ts hangs the scene layer's one tap on it — so this is a decision
 * leaving the host exactly as `simulateSticky` would have left it, and the
 * phone applies it through the replay driver like any other scene event. The
 * host also applies its own decision directly, which is what the real path
 * does (`applyingScene` swallows its own events on the way out).
 */
const seatInfo = await host.page.evaluate((id) => {
  const m = window.__refworldCreatures;
  const baseR = m.ballDiameter(id) / 2;
  const itemR = 1.2;
  const out = [];
  for (let i = 0; i < 6; i++) {
    const th = (i / 6) * Math.PI * 2;
    const g = Math.cbrt(1 + (4 * i * itemR ** 3) / baseR ** 3);
    const local = (baseR + itemR * 0.7) / g;
    const record = {
      id,
      item: `rock:0:${i}.00:0.00`,
      kind: 'rock',
      variant: 0,
      scale: itemR,
      r: itemR,
      ox: Math.cos(th) * local,
      oy: 0,
      oz: Math.sin(th) * local,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    };
    m.applyStick(record);
    window.__refworldSession.recorder.stick(record);
    out.push(Number(local.toFixed(4)));
  }
  return { baseR, itemR, locals: out };
}, A);
console.log('seated on the host', JSON.stringify(seatInfo));

// The scene batch is paced by the outbox (one tertiary beat) and both pages
// then ease their springs over MOTION.primaryMs; swiftshader needs the wall
// clock for it.
await new Promise((r) => setTimeout(r, 60_000));

const read = (p) =>
  p.page.evaluate((id) => {
    const m = window.__refworldCreatures;
    const root = m.rootOf(id);
    if (!root) return { found: false };
    root.updateWorldMatrix(true, true);
    const rider = root.getObjectByName('rider');
    const clump = root.getObjectByName('clump');
    const scaleOf = (o) => {
      const e = o.matrixWorld.elements;
      return Math.hypot(e[0], e[1], e[2]);
    };
    const posOf = (o) => {
      const e = o.matrixWorld.elements;
      return { x: e[12], y: e[13], z: e[14] };
    };
    const centre = clump ? posOf(clump) : { x: 0, y: 0, z: 0 };
    const character = rider?.children?.[0] ?? null;
    return {
      found: true,
      rootScale: Number(root.scale.x.toFixed(4)),
      bodyR: Number((m.ballDiameter(id) / 2).toFixed(4)),
      // THE NUMBER THE REPORT IS ABOUT.
      charWorldScale: character ? Number(scaleOf(character).toFixed(6)) : null,
      riderLocalScale: rider ? Number(rider.scale.x.toFixed(6)) : null,
      shell: Boolean(root.getObjectByName('ball')),
      items: (clump?.children ?? []).length,
      seats: (clump?.children ?? []).map((o) => {
        const at = posOf(o);
        return Number(
          Math.hypot(at.x - centre.x, at.y - centre.y, at.z - centre.z).toFixed(3),
        );
      }),
    };
  }, A);

const seenHost = await read(host);
const seenPhone = await read(one);
console.log('HOST  ', JSON.stringify(seenHost));
console.log('PHONE ', JSON.stringify(seenPhone));

const shotH = join(HERE, 'room-scale-host.png');
const shotA = join(HERE, 'room-scale-phone.png');
await host.page.screenshot({ path: shotH });
await one.page.screenshot({ path: shotA });

const fail = [];
const check = (ok, what) => {
  if (!ok) fail.push(what);
};
check(seenHost.found && seenPhone.found, 'the creature stands on both pages');
check(seenHost.rootScale > 2, `the host grew the ball (${seenHost.rootScale})`);
check(
  Math.abs((seenPhone.rootScale ?? 0) - seenHost.rootScale) < 1e-3,
  `the phone grew it the same (${seenPhone.rootScale} vs ${seenHost.rootScale})`,
);
check(
  Math.abs((seenHost.charWorldScale ?? 0) - 1) < 1e-6,
  `the host draws the creature at its own size (${seenHost.charWorldScale})`,
);
check(
  Math.abs((seenPhone.charWorldScale ?? 0) - 1) < 1e-6,
  `the PHONE draws the creature at its own size (${seenPhone.charWorldScale})`,
);
check(!seenHost.shell && !seenPhone.shell, 'no shell is drawn on either page');
check(
  seenPhone.items === seenHost.items,
  `the same items (${seenPhone.items} vs ${seenHost.items})`,
);

console.log('shots', shotH, shotA);
if (fail.length > 0) {
  console.log('FAIL');
  for (const line of fail) console.log(' -', line);
  process.exitCode = 1;
} else {
  console.log('OK — one pile, one size, and the creature is its drawn size on both pages');
}

client.end(true);
for (const p of pages) await p.context.close();
await browser.close();
await server.close();
await new Promise((r) => wss.close(() => httpd.close(() => aedes.close(r))));
