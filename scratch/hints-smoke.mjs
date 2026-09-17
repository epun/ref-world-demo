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
 *   ① the loading line, with NO hint over it
 *   ② the creature stands  → hint one, above the joystick
 *   ③ the thumb holds the stick → hint one slides out, the creature rolls
 *   ④ a few units later   → hint two, under the ball readout
 *   ⑤ a pickup            → hint three, beside the number it is about
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
    return {
      loading: document.querySelector('.world-loading-line')?.textContent ?? null,
      hint: hint?.querySelector('.world-hint-line')?.textContent ?? null,
      anchor: hint?.closest('.world-hint')?.className ?? null,
      at: box(hint?.closest('.world-hint') ?? null),
      stick: box(document.querySelector('.world-stick')),
      readout: box(document.querySelector('.world-size')),
      icon: hint?.querySelectorAll('.world-hint-mark').length ?? 0,
      skip: hint?.querySelector('.world-hint-skip')?.textContent ?? null,
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

// ③ the thumb holds the stick: hint one leaves.
const stickBox = await (await page.$('.world-stick')).boundingBox();
const cx = stickBox.x + stickBox.width / 2;
const cy = stickBox.y + stickBox.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + stickBox.width * 0.4, cy, { steps: 6 });
await page.waitForTimeout(4_000);
console.log('step 3 — driving:', JSON.stringify(await state()));
await shot('hint-3-driving');
await page.mouse.up();

// ④ …and a few units later, hint two under the readout. Under swiftshader a
// phone walks slowly, so the creature is given the distance by the same
// pose path a host would (`followPoses` is the viewer's own seam).
await page.evaluate((id) => {
  const m = window.__refworldCreatures;
  const at = m.positionOf(id);
  if (at) m.followPoses([{ id, x: at.x + 9, z: at.z + 9, heading: 0.8 }]);
}, ID);
await page.waitForTimeout(4_000);
console.log('step 4 — hint two:', JSON.stringify(await state()));
await shot('hint-4-pickup');

// ⑤ a pickup: hint three, beside the number.
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
await page.waitForTimeout(5_000);
console.log('step 5 — hint three:', JSON.stringify(await state()));
await shot('hint-5-grow');

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
