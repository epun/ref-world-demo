/**
 * Headless reproduction of the LOW-TILT CAMO (2026-09-17 user report, with a
 * screenshot: *"when I rotate the view too much on mobile"* the frame at the
 * zoom floor is covered in large soft blotches — dark navy over the sea,
 * grey-lavender over the green land — while the default framing is fine).
 *
 * The sibling of scratch/phone-zoom-camo.mjs, which found the first half of
 * that report (the blade field's pixel floor, and the ground stipple past
 * nyquist). This one adds the axis that scalar could not express: the camera's
 * TILT. On the ground plane the depth axis foreshortens by `1/sin(tilt)`, so at
 * the rig's lowest orbit the surface is sampled 3.4x more coarsely along depth
 * than the frame's screen-plane number says, and a lattice noise stepped near
 * its own cell spacing beats into large soft blobs.
 *
 * Three frames per run, on either tier:
 *
 *   {tag}-{tier}-default.png   the default view — must not change
 *   {tag}-{tier}-default-b.png the same view a second later, which is the
 *                              ANIMATION FLOOR: the wind, the sun arc, the
 *                              sparkle beat and the ambient drift all move, so
 *                              this is how big a "no change" diff can be
 *   {tag}-{tier}-floor.png     the zoom floor at the default tilt
 *   {tag}-{tier}-lowtilt.png   the zoom floor at the rig's lowest orbit
 *
 * …and, over a SEA patch and a LAND patch of the last one, three numbers:
 * the patch's luminance standard deviation, the same after an 8-pixel box blur
 * (which is what a large soft blotch shows up in and a fine speckle does not),
 * and the rms of the high-pass residual. A fix drops the blurred sd.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/tilt-camo.mjs                     # writes scratch/tilt-after-*.png
 *   TAG=before TIER=projection node scratch/tilt-camo.mjs
 *
 * PORT, TAG, TIER (phone|projection) and KEEP_OPEN are the dials.
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4240);
const TAG = process.env['TAG'] ?? 'after';
const TIER = process.env['TIER'] ?? 'phone';
const ROOM = 'xkcd';
const ID = 'shot1';

const VIEWPORT = TIER === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 };
/** The phone tier is a COARSE POINTER (src/world/device.ts `deviceTier`), which
 * is what `hasTouch` gives a chromium context. */
const CONTEXT =
  TIER === 'phone'
    ? { viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: VIEWPORT };

const req = createRequire(import.meta.url);
let chromium = null;
for (const from of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
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
  const direct = join(browserRoot, 'chromium', 'chrome-linux', 'chrome');
  if (existsSync(direct)) executablePath = direct;
  for (const d of readdirSync(browserRoot)) {
    if (d.startsWith('chromium-')) {
      const at = join(browserRoot, d, 'chrome-linux', 'chrome');
      if (existsSync(at)) executablePath = at;
    }
  }
}

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

// ── the measures ────────────────────────────────────────────────────────────

function luma(png) {
  const { width, height, data } = png;
  const out = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    out[i] =
      0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  }
  return { width, height, out };
}

/** Separable box blur of radius r over a luminance plane. */
function blur(plane, r) {
  const { width, height, out } = plane;
  const tmp = new Float64Array(width * height);
  const res = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= width) continue;
        s += out[y * width + xx];
        n++;
      }
      tmp[y * width + x] = s / n;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= height) continue;
        s += tmp[yy * width + x];
        n++;
      }
      res[y * width + x] = s / n;
    }
  }
  return { width, height, out: res };
}

function sd(plane, rect) {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const v = plane.out[y * plane.width + x];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  const mean = s / n;
  return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)), n };
}

/** The three numbers over one patch: raw sd, sd of the 8px-blurred plane
 * (large soft mottle), rms of the high-pass residual (fine speckle). */
function patchMetrics(png, rect) {
  const plane = luma(png);
  const soft = blur(plane, 8);
  const raw = sd(plane, rect);
  const blurred = sd(soft, rect);
  const hp = { width: plane.width, height: plane.height, out: new Float64Array(plane.out.length) };
  for (let i = 0; i < plane.out.length; i++) hp.out[i] = plane.out[i] - soft.out[i];
  const high = sd(hp, rect);
  return {
    mean: Number(raw.mean.toFixed(2)),
    sd: Number(raw.sd.toFixed(3)),
    sdBlur8: Number(blurred.sd.toFixed(3)),
    rmsHighPass: Number(Math.sqrt(high.sd * high.sd + high.mean * high.mean).toFixed(3)),
  };
}

/** Mean absolute per-channel difference between two equally sized frames. */
function frameDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  let sum = 0;
  let max = 0;
  let over2 = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]));
    sum += d;
    if (d > max) max = d;
    if (d > 2) over2++;
  }
  return {
    meanAbs: Number((sum / n).toFixed(4)),
    maxAbs: max,
    pctPixelsOver2: Number(((100 * over2) / n).toFixed(3)),
  };
}

// ── the run ─────────────────────────────────────────────────────────────────

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
const context = await browser.newContext(CONTEXT);
await context.addInitScript(
  ([room, id, drawing]) => {
    try {
      localStorage.setItem(
        `refworld:submission:${room}`,
        JSON.stringify({ id, name: null, strokes: drawing, ts: Date.now(), epoch: null }),
      );
      localStorage.setItem('refworld:drawer', id);
      localStorage.setItem('refworld:hinted-emote', '1');
      // The handset's onboarding stands over the whole world view and eats
      // every pointer (src/ui/onboard.ts) — this page has "seen" it.
      localStorage.setItem('refworld:onboarded', '1');
    } catch {
      /* a blocked store simply mounts no tray */
    }
  },
  [ROOM, ID, wire],
);

const page = await context.newPage();
page.setDefaultTimeout(600_000);
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  // Shader logs only: the mqtt broker is unreachable from here and its
  // certificate complaint is not this script's business.
  if (/THREE.WebGLProgram|shader error|ERROR: 0:|gl_FragColor/i.test(t)) {
    problems.push(t.slice(0, 800));
  }
});

const url =
  `http://127.0.0.1:${PORT}/?view=world&host=1&room=${ROOM}` +
  `&game=katamari&landscape=1&onboard=0`;
console.log('opening', url, 'as', TIER);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, { timeout: 600_000 });
await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [ID, strokes],
);
await page.waitForTimeout(25_000);

/** zoom, units-per-pixel and the rig's live ELEVATION, off the camera alone:
 * the +Z column of its world matrix is the normalised iso offset, so its y is
 * `sin(elevation)`. */
const snap = () =>
  page.evaluate(() => {
    const cam = window.__refworldCamera;
    const r = window.__refworldRenderer;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    return {
      zoom: Number(cam.zoom.toFixed(4)),
      unitsPerPxCss: Number(
        ((cam.top - cam.bottom) / Math.max(0.01, cam.zoom) / window.innerHeight).toFixed(4),
      ),
      elevationRad: Number(Math.asin(Math.max(-1, Math.min(1, e[9]))).toFixed(4)),
      pixelRatio: r ? r.getPixelRatio() : null,
      calls: r ? r.info.render.calls : null,
    };
  });

const shot = async (name) => {
  const path = join(HERE, `tilt-${TAG}-${TIER}-${name}.png`);
  await page.screenshot({ path });
  return path;
};

const report = {};

// (a) the default view, twice, a second apart — the animation floor.
report.default = await snap();
const defaultShot = await shot('default');
await page.waitForTimeout(1_000);
const defaultShotB = await shot('default-b');
report.animationFloor = frameDiff(
  PNG.sync.read(readFileSync(defaultShot)),
  PNG.sync.read(readFileSync(defaultShotB)),
);

// (b) the zoom floor at the default tilt.
const cx = Math.round(VIEWPORT.width / 2);
const cy = Math.round(VIEWPORT.height / 2);
await page.mouse.move(cx, cy);
for (let i = 0; i < 24; i++) {
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(25_000);
report.floor = await snap();
await shot('floor');

// (c) …and the lowest orbit the rig allows. A plain vertical drag ORBITS
// (src/world/scene.ts); dragging UP lowers the elevation, and `rotateBy`
// clamps at ELEVATION_MIN, so over-dragging simply parks on the bound. dx is
// zero throughout so the azimuth — and therefore the framing — is untouched.
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 30; i++) {
  await page.mouse.move(cx, cy - i * 10);
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.waitForTimeout(20_000);
report.lowTilt = await snap();
const lowShot = await shot('lowtilt');

// ── where the sea and the land are in that last frame ───────────────────────
// Projected from WORLD points through the live camera, so both runs measure
// the same ground: the island's centre is land, and a point out past the coast
// is sea. Land is picked as the projected origin; sea as the furthest of four
// compass points that still lands inside the frame with room for a patch.
const PATCH = TIER === 'phone' ? 96 : 128;
const screenOf = (pt) =>
  page.evaluate(({ x, z }) => {
    const cam = window.__refworldCamera;
    cam.updateMatrixWorld();
    const mul = (m, v) => {
      const e = m.elements;
      const o = [0, 0, 0, 0];
      for (let r = 0; r < 4; r++) {
        o[r] = e[r] * v[0] + e[4 + r] * v[1] + e[8 + r] * v[2] + e[12 + r] * v[3];
      }
      return o;
    };
    const view = mul(cam.matrixWorldInverse, [x, 0, z, 1]);
    const clip = mul(cam.projectionMatrix, view);
    const w = clip[3] === 0 ? 1 : clip[3];
    return {
      px: ((clip[0] / w) * 0.5 + 0.5) * window.innerWidth,
      py: (0.5 - (clip[1] / w) * 0.5) * window.innerHeight,
      dpr: window.devicePixelRatio,
    };
  }, pt);

const png = PNG.sync.read(readFileSync(lowShot));
const scale = png.width / VIEWPORT.width;
const rectAt = (at) => {
  const x = Math.round(at.px * scale - PATCH / 2);
  const y = Math.round(at.py * scale - PATCH / 2);
  return {
    x: Math.max(0, Math.min(png.width - PATCH, x)),
    y: Math.max(0, Math.min(png.height - PATCH, y)),
    w: PATCH,
    h: PATCH,
  };
};

/** Is this rect mostly blue (sea) or mostly green (land)? A sanity check on
 * the projection, printed so a mis-aimed patch is visible in the log. */
const classify = (rect) => {
  let blue = 0;
  let green = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 2) {
    for (let x = rect.x; x < rect.x + rect.w; x += 2) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (b > g && b > r) blue++;
      else if (g >= b && g > r) green++;
    }
  }
  const total = blue + green || 1;
  return { blue: Number((blue / total).toFixed(2)), green: Number((green / total).toFixed(2)) };
};

const landAt = await screenOf({ x: 0, z: 0 });
let seaAt = null;
for (const pt of [
  { x: 330, z: 0 },
  { x: 0, z: 330 },
  { x: -330, z: 0 },
  { x: 0, z: -330 },
  { x: 250, z: 250 },
]) {
  const at = await screenOf(pt);
  const ok =
    at.px > PATCH / scale && at.px < VIEWPORT.width - PATCH / scale &&
    at.py > PATCH / scale && at.py < VIEWPORT.height - PATCH / scale;
  if (!ok) continue;
  const c = classify(rectAt(at));
  if (c.blue > 0.85) {
    seaAt = { at, pt, c };
    break;
  }
}

const landRect = rectAt(landAt);
report.land = { rect: landRect, colour: classify(landRect), ...patchMetrics(png, landRect) };
if (seaAt) {
  const seaRect = rectAt(seaAt.at);
  report.sea = {
    world: seaAt.pt,
    rect: seaRect,
    colour: classify(seaRect),
    ...patchMetrics(png, seaRect),
  };
} else {
  report.sea = 'no sea patch found inside the frame';
}

if (!process.env['KEEP_OPEN']) {
  await browser.close();
  await server.close();
}

console.log(JSON.stringify({ tag: TAG, tier: TIER, ...report }, null, 2));
console.log('shots', join(HERE, `tilt-${TAG}-${TIER}-*.png`));
if (problems.length > 0) {
  console.error('tilt-camo FAILED:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('tilt-camo ok — no shader log, no page error');
}
