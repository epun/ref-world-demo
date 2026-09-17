/**
 * Headless check for the corner's LIVE VIEW (src/world/portrait.ts + the
 * inset in src/ui/size.ts).
 *
 * > User ask, 2026-09-17: *"in the top left hand corner we should show a live
 * > view of the character and the objects it collects. the 3d view of the
 * > character and the object ball should not scale beyond the radius
 * > measurement ui div in the top left."*
 *
 * Boots the built valiocon site in a real chromium (swiftshader, no gpu) as a
 * PHONE — 390x844, dpr 3, coarse pointer, `?view=world` — with a drawing
 * already in this handset's storage, because a stored submission is what makes
 * `myDrawerId` non-empty and that is what mounts the tray, the readout and
 * this picture (the same arrangement as scratch/size-readout-smoke.mjs).
 *
 * Then it asks the two questions the ask is made of, off the PIXELS rather
 * than off the code:
 *
 *   1. is the creature in the circle — unladen, straight after the hatch;
 *   2. and with a grown ball (fifteen real props seated through `applyStick`,
 *      the way scratch/ball-scale-shot.mjs seats them), does the mass FILL the
 *      circle without exceeding it? The content's own pixel radius is measured
 *      inside the inset's rect and compared with the rect's half-width.
 *
 * …and it reports the frame's cost with the pass and without it: the portrait
 * draws nothing until the readout has slid in, so the frame before the hatch
 * IS the before.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/portrait-smoke.mjs
 *     # scratch/portrait-unladen-390x844.png, scratch/portrait-ball-390x844.png
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4198);
const ROOM = 'xkcd';
const ID = 'shot1';
const DPR = 3;

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

// ── the drawing, in both forms (see size-readout-smoke.mjs) ─────────────────
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
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: DPR,
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
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

const url = `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

/*
 * THE COST BEFORE. Nothing has hatched, so `rect()` is null and the pass
 * returns on its first line — this is the frame without the portrait in it.
 */
const costBefore = await page.evaluate(() => window.__refworldRender());
console.log('cost before', JSON.stringify(pick(costBefore)));

await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [ID, strokes],
);
// One frame every few seconds under swiftshader: give the hatch, the gait and
// the readout's slide room.
await page.waitForTimeout(20_000);

const insetOf = () =>
  page.evaluate(() => {
    const el = document.querySelector('.world-size-inset');
    const row = document.querySelector('.world-size-row');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const rr = row?.getBoundingClientRect() ?? null;
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      shown: el.classList.contains('in'),
      rowW: rr ? rr.width : null,
    };
  });

const unladenInset = await insetOf();
console.log('inset (unladen)', JSON.stringify(unladenInset));
const unladenShot = join(HERE, 'portrait-unladen-390x844.png');
await page.screenshot({ path: unladenShot });

/*
 * FIFTEEN PROPS, seated on the pile's surface — the mix and the seats are
 * scratch/ball-scale-shot.mjs's, which measured the drawn radius of each
 * (kind, variant, scale) off the vendored library's own geometry.
 */
const seated = await page.evaluate(
  ([id]) => {
    const m = window.__refworldCreatures;
    const baseR = m.ballDiameter(id) / 2;
    const K = 4;
    const FIT = 0.7;
    const MIX = [
      { kind: 'medium', variant: 1, scale: 1.5, drawnR: 1.161 },
      { kind: 'medium', variant: 0, scale: 2, drawnR: 0.937 },
      { kind: 'medium', variant: 0, scale: 1.5, drawnR: 0.703 },
      { kind: 'medium', variant: 2, scale: 1.5, drawnR: 2.869 },
      { kind: 'medium', variant: 1, scale: 2, drawnR: 1.548 },
    ];
    const items = [];
    for (let i = 0; i < 15; i++) {
      const pick = MIX[i % MIX.length];
      items.push({ ...pick, key: `${pick.kind}:${pick.variant}:${i}:0`, r: pick.drawnR });
    }
    let sum = 0;
    for (const it of items) sum += it.r * it.r * it.r;
    const g = Math.cbrt(1 + (K * sum) / (baseR * baseR * baseR));
    const R = baseR * g;
    const GOLD = Math.PI * (3 - Math.sqrt(5));
    items.forEach((it, i) => {
      const y = 1 - (i / (items.length - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = GOLD * i;
      const reach = (R + it.r * FIT) / g;
      m.applyStick({
        id,
        item: it.key,
        kind: it.kind,
        variant: it.variant,
        scale: it.scale,
        r: it.r,
        ox: Math.cos(th) * rad * reach,
        oy: y * reach,
        oz: Math.sin(th) * rad * reach,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    });
    return { baseR, g, R };
  },
  [ID],
);
console.log('seated', JSON.stringify(seated));
// The growth steps, but the fit spring, the roll blend and the clearance are
// all MOTION.primaryMs — and this is swiftshader, where the loop's dt is
// clamped at 250ms a frame, so the settle needs wall clock.
await page.waitForTimeout(90_000);

const ballInset = await insetOf();
const ballState = await page.evaluate(
  (id) => ({
    diameter: window.__refworldCreatures.ballDiameter(id),
    roll: window.__refworldCreatures.rollBlend(id),
    text: document.querySelector('.world-size-value')?.textContent ?? null,
  }),
  ID,
);
console.log('inset (ball)', JSON.stringify(ballInset), JSON.stringify(ballState));
const ballShot = join(HERE, 'portrait-ball-390x844.png');
await page.screenshot({ path: ballShot });

/*
 * THE COST OF THE PASS, A/B ON THE SAME WORLD.
 *
 * The frame before the hatch is not a fair "before" — nothing had hatched,
 * the library had not landed and the pile did not exist. So the portrait is
 * turned OFF and ON at the grown state instead, by hiding the inset: a rect
 * of zero width is the one thing the pass returns early on
 * (src/world/portrait.ts), so display:none is an honest switch and needs no
 * probe of its own.
 */
const ab = await page.evaluate(async () => {
  const inset = document.querySelector('.world-size-inset');
  const sample = async (n) => {
    const out = [];
    let last = await new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < n; i++) {
      const now = await new Promise((r) => requestAnimationFrame(r));
      out.push(now - last);
      last = now;
    }
    out.sort((a, b) => a - b);
    return Number(out[Math.floor(out.length / 2)].toFixed(1));
  };
  inset.style.display = 'none';
  const off = await window.__refworldRender();
  const offMs = await sample(12);
  inset.style.display = '';
  const on = await window.__refworldRender();
  const onMs = await sample(12);
  return { off, on, offMs, onMs };
});
console.log('cost without the portrait', JSON.stringify(pick(ab.off)), `${ab.offMs}ms`);
console.log('cost with the portrait   ', JSON.stringify(pick(ab.on)), `${ab.onMs}ms`);

await browser.close();
await server.close();

// ── the pixels ──────────────────────────────────────────────────────────────
/**
 * How far from the inset's centre the drawn content reaches, in css px.
 *
 * The paper inside the circle is cleared in GL to the chrome's paper, so
 * "content" is any pixel that differs from the corner's own paper by more
 * than a hair — the creature, the ball, the props. The wavering RING is drawn
 * by the DOM at the rect's rim, so the measurement stops at 0.9 of the radius
 * and cannot mistake the frame for the picture.
 */
function contentRadius(file, rect) {
  const png = PNG.sync.read(readFileSync(file));
  const x0 = Math.round(rect.x * DPR);
  const y0 = Math.round(rect.y * DPR);
  const w = Math.round(rect.w * DPR);
  const h = Math.round(rect.h * DPR);
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const limit = Math.min(w, h) / 2;
  // The paper: the pixel nearest the circle's own rim inside the measured
  // band, which is paper by construction (the picture is centred).
  const at = (x, y) => {
    const i = (png.width * y + x) << 2;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const paper = at(Math.round(cx + limit * 0.86), Math.round(cy));
  let far = 0;
  let pixels = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > limit * 0.9) continue;
      const [r, g, b] = at(x, y);
      const diff =
        Math.abs(r - paper[0]) + Math.abs(g - paper[1]) + Math.abs(b - paper[2]);
      if (diff <= 24) continue;
      pixels++;
      if (d > far) far = d;
    }
  }
  return {
    radiusPx: Number((far / DPR).toFixed(1)),
    halfPx: Number((limit / DPR).toFixed(1)),
    coverage: Number((pixels / (Math.PI * limit * limit * 0.81)).toFixed(3)),
  };
}

const unladenPixels = contentRadius(unladenShot, unladenInset);
const ballPixels = contentRadius(ballShot, ballInset);
console.log('pixels (unladen)', JSON.stringify(unladenPixels));
console.log('pixels (ball)', JSON.stringify(ballPixels));

// ── what it promised ────────────────────────────────────────────────────────
const fail = [];
const check = (ok, what) => {
  if (!ok) fail.push(what);
};
check(Boolean(unladenInset?.shown), 'the inset slid in');
check(
  Math.abs(unladenInset.w - unladenInset.h) < 0.5,
  `the inset is square (${unladenInset.w} x ${unladenInset.h})`,
);
check(unladenInset.x < 40 && unladenInset.y < 40, 'the inset is in the top-left');
check(unladenPixels.coverage > 0.02, `the unladen creature is IN it (${unladenPixels.coverage})`);
check(
  unladenPixels.radiusPx <= unladenPixels.halfPx + 0.5,
  'the unladen creature stays inside the circle',
);
check(ballState.diameter > 10, `there is a real ball (${ballState.diameter})`);
check(
  ballPixels.radiusPx <= ballPixels.halfPx + 0.5,
  `the ball does not exceed the circle (${ballPixels.radiusPx} vs ${ballPixels.halfPx})`,
);
check(ballPixels.coverage > 0.3, `the ball FILLS the circle (${ballPixels.coverage})`);
check(
  Math.abs(ballInset.w - Math.min(132, Math.max(96, ballInset.rowW ?? 0))) < 2,
  `its diameter is the row's width (${ballInset.w} vs ${ballInset.rowW})`,
);

console.log('shots', unladenShot, ballShot);
if (fail.length > 0) {
  console.log('FAIL');
  for (const line of fail) console.log(' -', line);
  process.exitCode = 1;
} else {
  console.log('OK — the live view is in the circle and inside it');
}

/** One frame's cost, the four numbers this is about. */
function pick(info) {
  if (!info || typeof info !== 'object') return info;
  const { drawCalls, triangles, programs, textures } = info;
  return { drawCalls, triangles, programs, textures };
}
