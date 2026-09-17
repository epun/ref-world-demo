/**
 * Headless check for the projection's top ten (src/ui/leaderboard.ts).
 *
 * > User ask, 2026-09-17: *"on the web view i want to see a leaderboard on
 * > the left hand side of the top 10."*
 *
 * Boots the built site in a real chromium (swiftshader, no gpu) as a
 * PROJECTION — 1280x800, fine pointer, no stored submission, so `handheld`
 * is false and the board mounts. Twelve drawings are OFFERED THROUGH THE
 * GATE, the way a phone's arrive (`window.__refworldModeration`), half of
 * them signed and half not; then each is fed a different number of things so
 * that twelve different ball sizes exist. Then it asserts what the board
 * promises:
 *
 *   1. ten rows for twelve creatures, biggest first;
 *   2. every row's number is that creature's own `ballDiameter` through
 *      `WORLD_SCALE`, formatted the way the game says it;
 *   3. lowercase everywhere, signed names as signed and a stand-in for the
 *      creatures nobody named;
 *   4. it is at the LEFT EDGE, near the top, and clear of the join code in
 *      the corner below it.
 *
 * A screenshot lands next to this file (gitignored — evidence for one run).
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/leaderboard-smoke.mjs
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4270);
const ROOM = 'xkcd';

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

// ── twelve different creatures ──────────────────────────────────────────────
// A body, a head and two legs, with the proportions varied per drawer so the
// field is twelve silhouettes rather than one twelve times.
const NAMES = ['ana', 'bo', 'cid', 'dot', 'eli', 'fen', null, null, null, null, null, null];
const drawings = NAMES.map((name, i) => {
  const t = i / (NAMES.length - 1);
  return {
    id: `drawer-${i}`,
    name,
    strokes: [
      { pts: [[0.5, 0.62, 1]], w: 0.34 + 0.12 * t },
      { pts: [[0.48 + 0.04 * t, 0.32, 1]], w: 0.2 + 0.1 * (1 - t) },
      {
        pts: [
          [0.42, 0.8, 1],
          [0.4 + 0.04 * t, 0.95, 1],
        ],
        w: 0.045,
      },
      {
        pts: [
          [0.58, 0.8, 1],
          [0.6 - 0.04 * t, 0.95, 1],
        ],
        w: 0.045,
      },
    ],
  };
});
const snack = [{ pts: [[0.5, 0.5, 1]], w: 0.3 }];

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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

const url = `http://127.0.0.1:${PORT}/?room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });

await page.waitForFunction(
  () => Boolean(window.__refworldCreatures) && Boolean(window.__refworldModeration),
  null,
  { timeout: 600_000 },
);

// Through the gate, exactly as a phone's drawing arrives — which is also
// where the signed name the board reads back comes from.
const offered = await page.evaluate((list) => {
  const gate = window.__refworldModeration;
  return list.map((d) => {
    const entry = gate.offer({
      id: d.id,
      name: d.name,
      strokes: d.strokes,
      personality: null,
      hatchMs: 100,
      grown: true,
    });
    return { id: d.id, disposition: entry.disposition };
  });
}, drawings);
console.log('gate:', JSON.stringify(offered));
await page.waitForTimeout(20_000);

// Twelve different piles. The twelve drawings are already twelve different
// bodies, so the pickups only have to shuffle that order — a few each rather
// than a hundred creatures on one core under swiftshader.
await page.evaluate(
  ([list, s]) => {
    const m = window.__refworldCreatures;
    list.forEach((d, i) => {
      const eats = (list.length - 1 - i) % 4;
      for (let k = 0; k < eats; k++) {
        const snackId = `snack-${i}-${k}`;
        m.spawn(snackId, s, { hatchMs: 100, grown: true });
        m.applyStick({
          id: d.id,
          item: `creature:${snackId}`,
          ox: 0,
          oy: 1,
          oz: k * 0.2,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
        });
      }
    });
  },
  [drawings, snack],
);
// The rows slide, the numbers roll, and the growth curve eases too.
await page.waitForTimeout(40_000);

const seen = await page.evaluate(() => {
  const box = (n) => {
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  // Document order is NOT rank order: the rows are placed by transform so a
  // rank change can slide instead of reflowing. So read the y off each row
  // and sort by it — which is the order a person actually reads.
  const rows = [...document.querySelectorAll('.world-leaderboard-row')]
    .map((row) => ({
      rank: row.querySelector('.world-leaderboard-rank')?.textContent ?? null,
      name: row.querySelector('.world-leaderboard-name')?.textContent ?? null,
      size: row.querySelector('.world-leaderboard-size')?.textContent ?? null,
      opacity: Number(getComputedStyle(row).opacity),
      y: Number(/translateY\(([-\d.]+)px\)/.exec(row.style.transform)?.[1] ?? '0'),
    }))
    .sort((a, b) => a.y - b.y);
  const head = document.querySelector('.world-leaderboard-head');
  const m = window.__refworldCreatures;
  return {
    mounted: Boolean(document.querySelector('.world-leaderboard')),
    shown: head ? head.classList.contains('in') : null,
    header: head?.textContent ?? null,
    rule: head ? getComputedStyle(head).borderBottomWidth : null,
    background: head ? getComputedStyle(document.querySelector('.world-leaderboard')).backgroundColor : null,
    shadow: head ? getComputedStyle(document.querySelector('.world-leaderboard')).boxShadow : null,
    rows,
    board: box(document.querySelector('.world-leaderboard')),
    qr: box(document.querySelector('.join-qr')),
    minimap: box(document.querySelector('.world-minimap')),
    // One row per BALL: the ids whose own pile they are (`ballOwner`), which
    // is what the board is handed. A creature stuck to somebody else's pile
    // answers `ballDiameter` with that pile's size and is not a competitor.
    diameters: m
      .liveIds()
      .filter((id) => m.ballOwner(id) === id)
      .map((id) => [id, m.ballDiameter(id)]),
    passengers: m.liveIds().filter((id) => m.ballOwner(id) !== id).length,
  };
});

const shot = join(HERE, 'world-leaderboard-1280x800.png');
await page.screenshot({ path: shot });
await browser.close();
await server.close();

// ── what it promised ────────────────────────────────────────────────────────
const fail = [];
const check = (ok, what) => {
  if (!ok) fail.push(what);
};
/** The module's own format, written out here so the run checks the app. */
const format = (units) => {
  const metres = units / 0.94;
  if (metres >= 100) return `${Math.round(metres)}m`;
  if (metres >= 1) {
    const cm = Math.round(metres * 100);
    return `${Math.floor(cm / 100)}m ${cm % 100}cm`;
  }
  const mm = Math.round(metres * 1000);
  return `${Math.floor(mm / 10)}cm ${mm % 10}mm`;
};

check(seen.mounted, 'the board mounted');
check(seen.shown === true, 'the header slid in');
check(seen.header === 'biggest', 'the header says what it is, in lowercase');
check(parseFloat(seen.rule) > 0, 'the one hairline rule is drawn');
check(
  seen.background === 'rgba(0, 0, 0, 0)' || seen.background === 'transparent',
  `no filled panel (${seen.background})`,
);
check(seen.shadow === 'none', `no shadow (${seen.shadow})`);
check(seen.rows.length === 10, `ten rows for twelve creatures (got ${seen.rows.length})`);
check(
  seen.rows.every((r, i) => r.rank === String(i + 1)),
  'the ranks read 1..10',
);
const named = seen.rows.map((r) => r.name);
check(
  named.every((n) => typeof n === 'string' && n === n.toLowerCase() && !/[A-Z]/.test(n)),
  `every name is lowercase (${named.join(', ')})`,
);
check(
  named.some((n) => /^creature \d+$/.test(n)),
  'a creature nobody signed for gets the stand-in, not its id',
);
check(
  !named.some((n) => n.startsWith('drawer-')),
  'no raw id is on screen',
);
// The ten biggest, in order, at the sizes the manager says.
const byBall = seen.diameters
  .filter(([, d]) => d > 0)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
check(byBall.length === 10, `ten measurable balls exist (got ${byBall.length})`);
check(seen.passengers > 0, 'some creatures are riding somebody else’s pile');
const sizes = new Set(seen.rows.map((r) => r.size));
check(sizes.size > 5, `the rows are ten different balls, not one ball ten times (${sizes.size})`);
check(
  seen.rows.every((r) => !r.name.endsWith('…') && !r.name.endsWith('...')),
  `no name is cut off (${named.join(', ')})`,
);
seen.rows.forEach((row, i) => {
  const want = byBall[i] ? format(byBall[i][1]) : null;
  check(row.size === want, `row ${i + 1} reads its own ball (${row.size} vs ${want})`);
  check(row.opacity > 0.98, `row ${i + 1} has finished sliding in`);
});
check(seen.board.x < 80, `it is at the left edge (x=${seen.board?.x})`);
check(seen.board.y < 80, `it is near the top (y=${seen.board?.y})`);
const clear = (other) =>
  !other ||
  seen.board.x + seen.board.w < other.x ||
  other.x + other.w < seen.board.x ||
  seen.board.y + seen.board.h < other.y ||
  other.y + other.h < seen.board.y;
check(clear(seen.qr), 'it is clear of the join code');
check(clear(seen.minimap), 'it is clear of the minimap');

console.log(JSON.stringify(seen, null, 2));
console.log('shot', shot);
if (fail.length > 0) {
  console.error(`leaderboard-smoke FAILED:\n  ${fail.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('leaderboard-smoke ok');
}
