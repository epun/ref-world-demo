/**
 * The contextual hints, in a real world view (src/ui/hints.ts).
 *
 * > User ask, 2026-09-17: *"For mobile I want the onboarding to be contextual
 * > within the device."*
 *
 * A phone at 390x844 with a drawing already in storage — the state somebody
 * is in the moment the pad hands them over — opens the world view and is
 * walked through the three lessons the way a person is:
 *
 *   ① the loading line, with NO label over it
 *   ② the creature stands  → `move using the joystick`, centred, and the
 *                            stick wearing its four chevrons
 *   ③ the thumb holds the stick → that label goes, and the chevrons with it
 *   ④ a few units later   → `roll over objects to collect`
 *   ⑤ a pickup            → `become the biggest`
 *   ⑥ …and then nothing, forever
 *
 * A screenshot per step lands next to this file (gitignored — evidence for
 * one run). The preview server is expected to be running already:
 *
 *   VITE_WORLD=valiocon npm run build
 *   npx vite preview --port 4260 --strictPort &
 *   NO_PROXY=127.0.0.1 node scratch/hints-smoke.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT'] ?? 4260);
const ROOM = 'xkcd';
const ID = 'hint1';

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

let executablePath = '/opt/pw-browsers/chromium';
if (existsSync('/opt/pw-browsers')) {
  for (const d of readdirSync('/opt/pw-browsers')) {
    if (d.startsWith('chromium-')) {
      const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

/** The kit's WIRE form — what the pad stores, and all this run needs. */
const wire = [
  { width: 90, pts: [[0.5, 0.62]] },
  { width: 60, pts: [[0.5, 0.34]] },
  { width: 14, pts: [[0.42, 0.8], [0.42, 0.95]] },
  { width: 14, pts: [[0.58, 0.8], [0.58, 0.95]] },
];
/** …and the pure form, for the spawn this run drives by hand. */
const strokes = [
  { pts: [[0.5, 0.62, 1]], w: 0.4 },
  { pts: [[0.5, 0.34, 1]], w: 0.26 },
  { pts: [[0.42, 0.8, 1], [0.42, 0.95, 1]], w: 0.045 },
  { pts: [[0.58, 0.8, 1], [0.58, 0.95, 1]], w: 0.045 },
];
const snack = [{ pts: [[0.5, 0.5, 1]], w: 0.3 }];

const browser = await chromium.launch({
  executablePath,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(
  ([room, id, drawing]) => {
    try {
      localStorage.setItem(
        `refworld:submission:${room}`,
        JSON.stringify({ id, name: null, strokes: drawing, ts: Date.now(), epoch: null }),
      );
      localStorage.setItem('refworld:drawer', id);
      localStorage.setItem('refworld:hinted-emote', '1');
    } catch {
      /* a blocked store simply mounts no tray, and the run says so */
    }
  },
  [ROOM, ID, wire],
);

const page = await context.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

/**
 * Wait for whatever hint is up to finish ARRIVING before photographing it.
 *
 * The hints slide in over MOTION.secondaryMs, and a screenshot taken the
 * instant a hint is created catches it at opacity 0 — which is a picture of
 * the transition, not of the hint.
 */
const settled = async () => {
  await page
    .waitForFunction(
      () =>
        !document.querySelector('.world-hint-row') ||
        Boolean(document.querySelector('.world-hint-row.in')),
      null,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1_400);
};

const shot = async (name) => {
  await settled();
  const at = join(HERE, `${name}-390x844.png`);
  await page.screenshot({ path: at });
  console.log('  ->', at);
};
const state = () =>
  page.evaluate(() => {
    const hint = document.querySelector('.world-hint-row:not(.out)');
    const box = (n) => {
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    };
    const arrows = document.querySelector('.world-hint-arrows');
    return {
      loading: document.querySelector('.world-loading-line')?.textContent ?? null,
      label: hint?.querySelector('.world-hint-line')?.textContent ?? null,
      at: box(hint?.closest('.world-hint') ?? null),
      centred: (() => {
        const host = hint?.closest('.world-hint');
        if (!host) return null;
        const r = host.getBoundingClientRect();
        return {
          dx: Math.round(r.x + r.width / 2 - window.innerWidth / 2),
          dy: Math.round(r.y + r.height / 2 - window.innerHeight / 2),
        };
      })(),
      paper: hint?.querySelector('.world-hint-paper')?.getAttribute('d')?.slice(0, 12) ?? null,
      arrows: arrows ? document.querySelectorAll('.world-hint-arrow').length : 0,
      arrowsOn: arrows ? Number.parseFloat(getComputedStyle(arrows).opacity) > 0.5 : false,
      arrowsInStick: Boolean(arrows?.closest('.world-stick')),
      stick: box(document.querySelector('.world-stick')),
      readout: box(document.querySelector('.world-size')),
      skip: document.querySelector('.world-hint-skip') ? 'present' : null,
    };
  });

const url = `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&world=valiocon&game=katamari`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

// ① the loading line, and nothing taught over it.
await page.waitForSelector('.world-loading-line', { timeout: 600_000 });
console.log('step 1 — loading:', JSON.stringify(await state()));
await shot('hint-1-loading');

// ② the creature stands: hint one, above the stick.
await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 80 }),
  [ID, strokes],
);
await page.waitForSelector('.world-hint-row', { timeout: 600_000 });
await page.waitForTimeout(3_000);
console.log('step 2 — hint one:', JSON.stringify(await state()));
await shot('hint-2-move');

// ③ the thumb holds the stick just past DRIVE_HELD_MS: label one goes, the
// chevrons go with it, and the creature has rolled far enough for label two.
// (A long drive would run the WHOLE tour — the meadow is full of props — so
// the hold is deliberately the shortest one that counts as a drive.)
const stickBox = await (await page.$('.world-stick')).boundingBox();
const cx = stickBox.x + stickBox.width / 2;
const cy = stickBox.y + stickBox.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + stickBox.width * 0.4, cy, { steps: 6 });
await page.waitForTimeout(1_600);
await page.mouse.up();
console.log('step 3 — after the drive:', JSON.stringify(await state()));
await shot('hint-3-driving');

// ④ label two, centred, with no chevrons on the stick.
console.log('step 4 — hint two:', JSON.stringify(await state()));
await shot('hint-4-pickup');

// ⑤ a pickup: the last label, photographed straight away — it only stays
// GROW_MS, and that is the point of it.
await page.evaluate(
  ([id, s]) => {
    const m = window.__refworldCreatures;
    m.spawn('snack-0', s, { hatchMs: 60, grown: true });
    m.applyStick({
      id,
      item: 'creature:snack-0',
      ox: 0,
      oy: 1,
      oz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    });
  },
  [ID, snack],
);
// The pile's growth eases in, so "has the ball grown" becomes true a moment
// after the item sticks — wait for the label rather than for a clock.
await page
  .waitForFunction(
    () => document.querySelector('.world-hint-line')?.textContent === 'become the biggest',
    null,
    { timeout: 60_000 },
  )
  .catch(() => console.log('!! the last label never arrived'));
await page.waitForTimeout(1_200);
console.log('step 5 — hint three:', JSON.stringify(await state()));
const lastShot = join(HERE, 'hint-5-grow-390x844.png');
await page.screenshot({ path: lastShot });
console.log('  ->', lastShot);

// ⑥ and then nothing, forever.
await page.waitForTimeout(12_000);
console.log('step 6 — after the tour:', JSON.stringify(await state()));
await shot('hint-6-done');
console.log(
  'flag:',
  await page.evaluate(() => {
    try {
      return localStorage.getItem('refworld:hinted');
    } catch {
      return 'unreadable';
    }
  }),
);

await context.close();
await browser.close();
console.log('done');
