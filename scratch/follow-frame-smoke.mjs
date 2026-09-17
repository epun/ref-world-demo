/**
 * Headless check for the PHONE'S FOLLOW FRAMING (src/world/camera.ts
 * `PHONE_FOLLOW_ZOOM`, src/world/follow.ts `createFollowAim`).
 *
 * > User ask, 2026-09-17: *"on mobile the camera perspective is too zoomed out
 * > on the character. we should be focused on the user's character and always
 * > have it in frame. if a user wants to zoom out and pan around they still
 * > can, but at the start and when the user uses the joystick we should
 * > smoothly focus back on the character."*
 *
 * Boots the built valiocon site in a real chromium (swiftshader, no gpu) as a
 * PHONE — 390x844, coarse pointer, `?view=world` — with a drawing already in
 * this handset's storage, because a stored submission is what makes
 * `myDrawerId` non-empty and that is what mounts the tray, the stick and the
 * follow camera (the arrangement scratch/hints-smoke.mjs uses).
 *
 * Then it photographs the three states the ask is made of and MEASURES each
 * one off the live camera rather than off the code:
 *
 *   (a) the start framing — the creature, at `PHONE_FOLLOW_ZOOM`;
 *   (b) after a real two-finger pinch OUT — wide, and the follow let go;
 *   (c) after a push of the stick — recentred and tight again.
 *
 * …and then the same world at 1280x800 on a fine pointer, which is the
 * PROJECTION: no tray, no follow, zoom 1, the framing it always had.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/follow-frame-smoke.mjs
 *     # scratch/follow-a-start-390x844.png
 *     # scratch/follow-b-pinched-390x844.png
 *     # scratch/follow-c-recentred-390x844.png
 *     # scratch/follow-projection-1280x800.png
 */

import { preview } from 'vite';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4207);
const ROOM = 'xkcd';
const ID = 'shot1';

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

// ── the drawing, in both forms (see scratch/hints-smoke.mjs) ───────────────
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

const store = ([room, id, drawing]) => {
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
};

/**
 * WHERE THE CREATURE IS ON THE SCREEN, and how wide the frame is.
 *
 * Projected through the live camera (`window.__refworldCamera`) rather than
 * measured off the pixels: the question is whether the thing is inside the
 * viewport, which is exactly what the projection matrix answers.
 */
const framing = (page, id) =>
  page.evaluate((who) => {
    const cam = window.__refworldCamera;
    const m = window.__refworldCreatures;
    const at = m?.positionOf?.(who) ?? null;
    const out = {
      zoom: cam ? Number(cam.zoom.toFixed(4)) : null,
      diameter: m?.ballDiameter ? Number(m.ballDiameter(who).toFixed(2)) : null,
      frameW: null,
      onScreen: null,
      topOnScreen: null,
      inside: null,
      wholeInside: null,
    };
    if (cam) {
      // The frame's ground width in world units: the narrower axis a portrait
      // phone is bound by.
      out.frameW = Number((((cam.right - cam.left) / cam.zoom)).toFixed(2));
    }
    if (cam && at) {
      cam.updateMatrixWorld();
      const v = { x: at.x, y: at.y, z: at.z };
      const p = new (window.__refworldThreeVector3 ?? Object)();
      // No three in this scope: do the transform by hand off the two matrices.
      const mvp = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
      const e = mvp.elements;
      const w = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
      const ndc = {
        x: (e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]) / w,
        y: (e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]) / w,
      };
      void p;
      out.onScreen = {
        x: Math.round(((ndc.x + 1) / 2) * window.innerWidth),
        y: Math.round(((1 - ndc.y) / 2) * window.innerHeight),
      };
      // …and its TOPPER, six units up (`FOLLOW_STAND_HEIGHT`): the frame is
      // centred on the ground point and the creature is drawn upwards from
      // it, so the top of it is what leaves the glass first.
      const wt = e[3] * v.x + e[7] * 6 + e[11] * v.z + e[15];
      const tip = {
        x: (e[0] * v.x + e[4] * 6 + e[8] * v.z + e[12]) / wt,
        y: (e[1] * v.x + e[5] * 6 + e[9] * v.z + e[13]) / wt,
      };
      out.topOnScreen = { y: Math.round(((1 - tip.y) / 2) * window.innerHeight) };
      out.inside = Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1;
      out.wholeInside = out.inside && Math.abs(tip.x) < 1 && Math.abs(tip.y) < 1;
    }
    return out;
  }, id);

/**
 * Wait for the rig's springs to ARRIVE before reading the framing.
 *
 * Under swiftshader this world runs at about half a frame a second and the
 * loop clamps dt at 250 ms, so a t.primary reframe takes forty seconds of
 * wall clock rather than two — and a reading taken before that is a reading
 * of the slide, not of the framing. So this polls until the zoom stops
 * moving, which is the honest wait, and says how long it took.
 */
const settle = async (page, id, label) => {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(5_000);
    const now = await framing(page, id);
    if (Math.abs((now.zoom ?? 0) - last) < 0.03) {
      console.log(`  ${label} settled after ~${(i + 1) * 5}s`);
      return now;
    }
    last = now.zoom ?? 0;
  }
  console.log(`  ${label} never settled`);
  return framing(page, id);
};

// ── the phone ──────────────────────────────────────────────────────────────
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await phone.addInitScript(store, [ROOM, ID, wire]);
const page = await phone.newPage();
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

const url = `http://127.0.0.1:${PORT}/?view=world&room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

// (a) THE START. The creature stands up and the frame comes to it — on the
// first followed frame, not on the hatch, which is the case a rejoin has.
await page.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [ID, strokes],
);
// One frame every few seconds under swiftshader: the zoom spring is
// MOTION.secondaryMs and the pan is t.primary, so give both wall clock — and
// the pan has the whole way from the world's origin to this creature's spawn
// to cover, which is what the frame WIDENS for while it is behind.
await page.waitForTimeout(20_000);
const a = await settle(page, ID, '(a)');
console.log('(a) start      ', JSON.stringify(a));
const shotA = join(HERE, 'follow-a-start-390x844.png');
await page.screenshot({ path: shotA });

// (b) A REAL TWO-FINGER PINCH OUT, through CDP so the pointer events are
// trusted (the canvas captures the pointer, which a synthetic event cannot).
const cdp = await phone.newCDPSession(page);
const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], i) => ({ x, y, id: i })),
  });
const cx = 195;
const cy = 330;
await touch('touchStart', [
  [cx - 90, cy],
  [cx + 90, cy],
]);
for (let i = 1; i <= 8; i++) {
  const d = 90 - i * 9;
  await touch('touchMove', [
    [cx - d, cy],
    [cx + d, cy],
  ]);
  await page.waitForTimeout(120);
}
await touch('touchEnd', []);
const b = await settle(page, ID, '(b)');
console.log('(b) pinched out', JSON.stringify(b));
const shotB = join(HERE, 'follow-b-pinched-390x844.png');
await page.screenshot({ path: shotB });

// (c) A PUSH OF THE STICK: the follow comes back and the frame slides in.
const stickBox = await (await page.$('.world-stick')).boundingBox();
const sx = stickBox.x + stickBox.width / 2;
const sy = stickBox.y + stickBox.height / 2;
await page.mouse.move(sx, sy);
await page.mouse.down();
await page.mouse.move(sx + stickBox.width * 0.35, sy, { steps: 6 });
await page.waitForTimeout(6_000);
await page.mouse.up();
// The recentre rides the rig's own springs: t.secondary on the zoom and
// t.primary on the look-target.
const c = await settle(page, ID, '(c)');
console.log('(c) recentred  ', JSON.stringify(c));
const shotC = join(HERE, 'follow-c-recentred-390x844.png');
await page.screenshot({ path: shotC });
await page.close();

// ── the projection, unchanged ──────────────────────────────────────────────
const wall = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const big = await wall.newPage();
big.setDefaultTimeout(600_000);
big.on('pageerror', (e) => console.log('[pageerror wall]', String(e).slice(0, 300)));
await big.goto(url, { waitUntil: 'load', timeout: 600_000 });
await big.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});
await big.evaluate(
  ([id, s]) => window.__refworldCreatures.spawn(id, s, { hatchMs: 100, grown: true }),
  [`${ID}-wall`, strokes],
);
await big.waitForTimeout(25_000);
const wallState = await framing(big, `${ID}-wall`);
console.log('projection     ', JSON.stringify(wallState));
const shotW = join(HERE, 'follow-projection-1280x800.png');
await big.screenshot({ path: shotW });

await browser.close();
await server.close();

// ── what it promised ───────────────────────────────────────────────────────
const fail = [];
const check = (ok, what) => {
  if (!ok) fail.push(what);
};
// At or a little under the framing: a creature the agent is walking about has
// the frame behind it, and the net widens for exactly that (`headroomZoom` /
// `FOLLOW_FRAME_FILL`). The shipped default this replaces is zoom 1 — an 18.5
// unit frame — so the claim is a frame under a third of that.
check(a.zoom > 2.6 && a.zoom <= 3.25, `(a) opens at the follow framing (${a.zoom})`);
check(a.wholeInside === true, '(a) the WHOLE creature, topper included, is in frame');
check(b.zoom < a.zoom / 2, `(b) the pinch opened the view (${b.zoom})`);
// Back at the framing, or a little wider: a creature that is still moving has
// the frame behind it, and the net widens for exactly that (`headroomZoom`).
check(c.zoom > 2.6 && c.zoom <= 3.25, `(c) the stick brought the framing back (${c.zoom})`);
check(c.zoom > b.zoom * 3, `(c) it came back from the pinch (${b.zoom} -> ${c.zoom})`);
check(c.wholeInside === true, '(c) the whole creature is in frame after the drive');
check(
  Math.abs(wallState.zoom - 1) < 0.01,
  `the projection is still at zoom 1 (${wallState.zoom})`,
);

console.log('shots', shotA, shotB, shotC, shotW);
if (fail.length > 0) {
  console.log('FAIL');
  for (const line of fail) console.log(' -', line);
  process.exitCode = 1;
} else {
  console.log('OK — tight at the start, free in the middle, tight again on the stick');
}
