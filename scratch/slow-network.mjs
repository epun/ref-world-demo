/**
 * WHAT THIS WORLD COSTS ON A SLOW LINK — the measurement, before the fix.
 *
 * > User ask, 2026-09-16: *"we need to be able to run this on a slow network
 * > on people's devices."*
 *
 * A perf claim that is not measured on the wire is a guess, and every number
 * in the slow-network work (docs/PLAN.md §7.1 "slow network") came out of
 * this file. It builds the katamari world, serves it off `vite preview`, and
 * opens it in a real chromium whose network is THROTTLED BY THE BROWSER —
 * CDP's `Network.emulateNetworkConditions`, which shapes every request the
 * page makes, including the ones a service worker or a fetch inside a module
 * makes later. Two profiles:
 *
 *   slow   1.5 Mbit/s down, 750 Kbit/s up, 150 ms RTT — the link the ask is
 *          about, and the one the library's 4 MB is unaffordable on.
 *   ok     5 Mbit/s down, 2 Mbit/s up, 60 ms RTT — a decent 4G phone.
 *
 * …and two pages, because they are not the same page:
 *
 *   phone       390x844, `isMobile`, coarse pointer, `?view=world&host=1`
 *               with a drawing already in this handset's storage. That store
 *               is what makes `myDrawerId` non-empty, which is what mounts
 *               the tray and makes this page a page with a creature OF ITS
 *               OWN — the thing the ask is about (scratch/size-readout-smoke.mjs
 *               sets up the same way).
 *   projection  1280x800, fine pointer, `?view=world&host=1`. Same main.ts,
 *               same four passes, a different tier.
 *
 * WHAT IT RECORDS, per (profile, page):
 *
 *   bytes transferred by resource type   from CDP, `encodedDataLength` — what
 *                                        went over the wire, not what was parsed
 *   time to the first rendered frame     `performance.mark('refworld:first-frame')`
 *   time until the player's creature is standing
 *   time each library tier was attached  `refworld:katamari-tier:<tier>`
 *   total bytes
 *
 * THE CREATURE IS SPAWNED BY THIS HARNESS, deliberately. On a live room the
 * handset publishes its drawing over mqtt and the world builds it from the
 * feed; there is no broker here, so the harness hands the stored drawing to
 * `__refworldCreatures.spawn` as soon as the manager exists — the same pure
 * pipeline, the same blueprint pool, the same hatch. What is measured is
 * therefore "how long from opening the page until this person's character is
 * on the ground", with the broker round trip taken out of it, and that is the
 * number the ask is about.
 *
 * ⚠️ UNDER SWIFTSHADER THE FRAME IS SOFTWARE. A first frame here is a
 * software rasteriser's first frame and is several times a real phone's; the
 * comparison that means anything is BEFORE against AFTER on the same machine,
 * which is what the tables in the plan are. The BYTES are exact.
 *
 *   node scratch/slow-network.mjs                    # both profiles, both pages
 *   node scratch/slow-network.mjs --profile slow     # one profile
 *   node scratch/slow-network.mjs --page phone
 *   node scratch/slow-network.mjs --no-build         # reuse dist/
 *   node scratch/slow-network.mjs --json out.json    # also write the raw rows
 *
 * It builds `VITE_WORLD=valiocon` itself and serves it on its own port, so it
 * never collides with a dev server. Playwright is not this repo's dependency;
 * it is resolved out of whatever checkout has it, as the other scratch
 * harnesses do.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4210);
const ROOM = 'xkcd';
const ID = 'slow1';

// ── the two link profiles ───────────────────────────────────────────────────
// CDP wants bytes per second; the names are the bit rates the ask quotes.
const KBIT = 1024 / 8;
const PROFILES = {
  slow: {
    label: '1.5 Mbps / 750 Kbps / 150 ms',
    downloadThroughput: 1500 * KBIT,
    uploadThroughput: 750 * KBIT,
    latency: 150,
  },
  ok: {
    label: '5 Mbps / 2 Mbps / 60 ms',
    downloadThroughput: 5000 * KBIT,
    uploadThroughput: 2000 * KBIT,
    latency: 60,
  },
};

const PAGES = {
  phone: {
    label: 'phone world view',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  projection: {
    label: 'projection',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

// ── arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const wantProfiles = opt('profile') ? [opt('profile')] : Object.keys(PROFILES);
const wantPages = opt('page') ? [opt('page')] : Object.keys(PAGES);
const jsonOut = opt('json', '');
const doBuild = !argv.includes('--no-build');
/** How long to wait for a thing that may never happen, ms. Swiftshader is
 * slow enough that this is minutes, not seconds. */
const LIMIT = Number(process.env['LIMIT_MS'] ?? 300_000);

for (const p of wantProfiles) if (!PROFILES[p]) throw new Error(`no such profile: ${p}`);
for (const p of wantPages) if (!PAGES[p]) throw new Error(`no such page: ${p}`);

// ── playwright and a browser, wherever this machine keeps them ──────────────
const req = createRequire(import.meta.url);
let chromium = null;
for (const from of [
  'playwright',
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  '/opt/node22/lib/node_modules/playwright',
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

let executablePath = '/opt/pw-browsers/chromium';
if (!existsSync(executablePath)) executablePath = undefined;
for (const d of existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers') : []) {
  if (!d.startsWith('chromium-')) continue;
  const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
  if (existsSync(at)) executablePath = at;
}

// ── the drawing, in both forms (scratch/size-readout-smoke.mjs) ─────────────
const wire = [
  { width: 90, pts: [[0.5, 0.62]] },
  { width: 60, pts: [[0.5, 0.34]] },
  {
    width: 14,
    pts: [
      [0.42, 0.8],
      [0.42, 0.95],
    ],
  },
  {
    width: 14,
    pts: [
      [0.58, 0.8],
      [0.58, 0.95],
    ],
  },
];
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

// ── build and serve ─────────────────────────────────────────────────────────
if (doBuild) {
  console.log('building VITE_WORLD=valiocon …');
  execFileSync('npm', ['run', 'build'], {
    cwd: ROOT,
    env: { ...process.env, VITE_WORLD: 'valiocon' },
    stdio: 'inherit',
  });
}

console.log(`serving dist/ on 127.0.0.1:${PORT} …`);
const server = spawn(
  'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  {
    cwd: ROOT,
    env: { ...process.env, NO_PROXY: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
server.stdout.on('data', (b) => process.stdout.write(`[preview] ${b}`));
server.stderr.on('data', (b) => process.stderr.write(`[preview] ${b}`));
await waitForServer();

async function waitForServer() {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('vite preview never came up');
}

/** Which bucket a request's bytes are charged to. */
function bucketOf(url, type) {
  if (url.includes('/katamari/models/')) return 'library glb';
  if (url.includes('/katamari/catalog.json')) return 'library catalog';
  if (/rapier/i.test(url)) return 'rapier';
  if (/mqtt/i.test(url)) return 'mqtt';
  if (url.endsWith('.wasm')) return 'wasm';
  if (type === 'Document') return 'html';
  if (type === 'Script') return 'app js';
  if (type === 'Stylesheet') return 'css';
  if (type === 'Image') return 'image';
  if (type === 'Font') return 'font';
  return type ? type.toLowerCase() : 'other';
}

// ── one run ─────────────────────────────────────────────────────────────────
async function measure(profileName, pageName) {
  const profile = PROFILES[profileName];
  const page = PAGES[pageName];
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });
  const context = await browser.newContext({
    viewport: page.viewport,
    deviceScaleFactor: page.deviceScaleFactor,
    isMobile: page.isMobile,
    hasTouch: page.hasTouch,
  });
  // The phone's own drawing, in the handset's store — the same init script
  // the size-readout smoke uses. The projection gets none: it is somebody
  // else's screen and has no creature of its own, so on that page the
  // "standing" number is the harness's spawn either way.
  await context.addInitScript(
    ([room, id, drawing]) => {
      try {
        localStorage.setItem(
          `refworld:submission:${room}`,
          JSON.stringify({
            id,
            name: null,
            strokes: drawing,
            ts: Date.now(),
            epoch: null,
          }),
        );
        localStorage.setItem('refworld:drawer', id);
        localStorage.setItem('refworld:hinted-emote', '1');
      } catch {
        /* a blocked store simply mounts no tray, and the run says so */
      }
    },
    [ROOM, ID, wire],
  );

  const tab = await context.newPage();
  tab.setDefaultTimeout(LIMIT);
  const errors = [];
  tab.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  // ── the wire, off CDP ─────────────────────────────────────────────────
  const cdp = await context.newCDPSession(tab);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latency,
    downloadThroughput: profile.downloadThroughput,
    uploadThroughput: profile.uploadThroughput,
  });
  const byId = new Map();
  const bytes = new Map();
  let total = 0;
  let requests = 0;
  cdp.on('Network.requestWillBeSent', (e) => {
    byId.set(e.requestId, { url: e.request.url, type: e.type });
  });
  cdp.on('Network.responseReceived', (e) => {
    const row = byId.get(e.requestId) ?? { url: e.response.url };
    row.type = e.type ?? row.type;
    row.url = e.response.url ?? row.url;
    byId.set(e.requestId, row);
  });
  const charge = (e) => {
    const row = byId.get(e.requestId);
    if (!row || row.charged) return;
    row.charged = true;
    const n = e.encodedDataLength ?? 0;
    const key = bucketOf(row.url, row.type);
    bytes.set(key, (bytes.get(key) ?? 0) + n);
    total += n;
    requests++;
  };
  cdp.on('Network.loadingFinished', charge);
  cdp.on('Network.loadingFailed', charge);

  const url = `http://127.0.0.1:${PORT}/?view=world&host=1&room=${ROOM}`;
  const t0 = Date.now();
  await tab.goto(url, { waitUntil: 'commit', timeout: LIMIT });

  const since = () => Date.now() - t0;
  /** A mark's time, in ms from this harness's t0 rather than the page's own
   * origin — `timeOrigin` is the navigation, so the two agree to a frame. */
  const markAt = async (name) =>
    tab.evaluate((n) => {
      const e = performance.getEntriesByName(n);
      return e.length > 0 ? Math.round(e[0].startTime) : null;
    }, name);
  const waitMark = async (name) => {
    try {
      await tab.waitForFunction((n) => performance.getEntriesByName(n).length > 0, name, {
        timeout: LIMIT,
      });
    } catch {
      return null;
    }
    return markAt(name);
  };

  const firstFrame = await waitMark('refworld:first-frame');
  console.log(`  first frame ${firstFrame ?? '—'} ms (wall ${since()} ms)`);

  // The creature, through the page's own manager, as soon as it exists.
  await tab.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
    timeout: LIMIT,
  });
  const spawnAt = since();
  await tab.evaluate(
    ([id, s]) => {
      window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: false });
      performance.mark('refworld:harness-spawn');
    },
    [ID, strokes],
  );
  // STANDING: hatched, in the world, with a pose the rest of the room could
  // follow. `positionOf` answers null until the character exists.
  let standing = null;
  try {
    await tab.waitForFunction(
      (id) => {
        const m = window.__refworldCreatures;
        const at = m?.positionOf?.(id);
        if (!at) return false;
        performance.mark('refworld:harness-standing');
        return true;
      },
      ID,
      { timeout: LIMIT },
    );
    standing = await markAt('refworld:harness-standing');
  } catch {
    /* it never stood; the row says null and the report says so */
  }
  console.log(`  standing ${standing ?? '—'} ms (spawn asked at ${spawnAt} ms)`);

  /*
   * THE WHOLE LIBRARY FIRST, AND THEN THE TIERS — the order matters and
   * getting it wrong is silent. Each tier's mark is written as that tier
   * lands, so reading them before the library has resolved reports every one
   * of them as null: the first version of this file did exactly that, and
   * made a staircase that was working look like it was not happening at all.
   *
   * `building` is the LAST tier and `onTier` skips its call
   * (src/world/katamari/source.ts), so the whole-library mark is its time.
   */
  const library = await waitMark('refworld:katamari-library');
  const tiers = {};
  for (const tier of ['small', 'medium', 'large', 'building']) {
    tiers[tier] = await markAt(`refworld:katamari-tier:${tier}`);
  }
  tiers.building ??= library;
  // Every mark the page actually wrote, so a null above is a fact about the
  // page and not about this file's guess at a name.
  const marks = await tab.evaluate(() =>
    performance
      .getEntriesByType('mark')
      .filter((m) => m.name.startsWith('refworld:'))
      .map((m) => `${m.name}@${Math.round(m.startTime)}`),
  );
  console.log(`  tiers ${JSON.stringify(tiers)} library ${library ?? '—'} ms`);

  // One more settle, so anything the last rebuild pulled is on the wire.
  await tab.waitForTimeout(3_000);

  const shot = join(HERE, `slow-network-${profileName}-${pageName}.png`);
  await tab.screenshot({ path: shot });
  const rapierLoaded = await tab.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .some((r) => /rapier/i.test(r.name) || r.name.endsWith('.wasm')),
  );
  await browser.close();

  return {
    profile: profileName,
    page: pageName,
    firstFrameMs: firstFrame,
    standingMs: standing,
    spawnAskedMs: spawnAt,
    tiers,
    libraryMs: library,
    marks,
    rapierLoaded,
    requests,
    totalBytes: total,
    bytes: Object.fromEntries([...bytes.entries()].sort((a, b) => b[1] - a[1])),
    errors: errors.slice(0, 5),
    shot,
  };
}

// ── run them, one at a time ─────────────────────────────────────────────────
const rows = [];
for (const profileName of wantProfiles) {
  for (const pageName of wantPages) {
    console.log(
      `\n── ${profileName} (${PROFILES[profileName].label}) · ${pageName} (${PAGES[pageName].label})`,
    );
    rows.push(await measure(profileName, pageName));
  }
}
server.kill('SIGTERM');

// ── the table ───────────────────────────────────────────────────────────────
const mb = (n) => (n / 1048576).toFixed(2);
const ms = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)}`);
console.log(
  '\n\nprofile  page        first  standing  small  medium  large  building  total MB  reqs',
);
console.log('-------  ----------  -----  --------  -----  ------  -----  --------  --------  ----');
for (const r of rows) {
  console.log(
    [
      r.profile.padEnd(7),
      r.page.padEnd(10),
      ms(r.firstFrameMs).padStart(5),
      ms(r.standingMs).padStart(8),
      ms(r.tiers.small).padStart(5),
      ms(r.tiers.medium).padStart(6),
      ms(r.tiers.large).padStart(5),
      ms(r.tiers.building).padStart(8),
      mb(r.totalBytes).padStart(8),
      String(r.requests).padStart(4),
    ].join('  '),
  );
}
console.log('\nbytes by type, MB');
for (const r of rows) {
  const parts = Object.entries(r.bytes).map(([k, v]) => `${k} ${mb(v)}`);
  console.log(`  ${r.profile}/${r.page}: ${parts.join(', ')}`);
  console.log(`    rapier fetched: ${r.rapierLoaded}`);
  console.log(`    marks: ${(r.marks ?? []).join(' ')}`);
  if (r.errors.length > 0) console.log(`    page errors: ${r.errors.join(' | ')}`);
}
if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`\nraw rows → ${jsonOut}`);
}
