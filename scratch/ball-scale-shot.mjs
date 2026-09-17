/**
 * Headless render of a GROWN katamari ball: a small creature, a big pile.
 *
 * > User ask, 2026-09-17: *"we should not scale up the characters as they
 * > stick to things."*
 *
 * Boots the built valiocon site in a real chromium (swiftshader, no gpu) at
 * 1280x800 as a HOST, spawns one creature near the origin — where the default
 * framing is looking — and seats fifteen props on its pile through
 * `applyStick`, the presentation path every page shares. The seats are
 * computed here the way `clumpLocalOffset` computes them (the pile's surface
 * plus the item's radius sunk in by `CLUMP_FIT`, divided by the growth), so
 * the fifteen sit ON the ball rather than in a line.
 *
 * What the frame is evidence OF: the drawn creature keeps its drawn size
 * while `ballDiameter` grows. The numbers behind it are printed beside the
 * shot — the creature group's world scale (from its own `matrixWorld`, which
 * is what the renderer used), the root's scale, the ball's radius and the
 * creature's world position.
 *
 *   VITE_WORLD=valiocon npm run build
 *   node scratch/ball-scale-shot.mjs            # scratch/ball-scale-1280x800.png
 *   SHOT=ball-centred node scratch/ball-scale-shot.mjs
 *   SEAT=0 SHOT=walker node scratch/ball-scale-shot.mjs   # the UNLADEN twin
 *
 * `SEAT=0` seats nothing: the same creature on the same spot carrying
 * nothing, which is the control frame for every claim about the ball — no
 * pile, `roll` 0, the sphere parked under the ground, a creature standing on
 * the paper (2026-09-17).
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4280);
const NAME = process.env['SHOT'] ?? 'ball-scale-1280x800';
const ROOM = 'xkcd';
const ID = 'ball1';

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

// ── the drawing ─────────────────────────────────────────────────────────────
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

// `npx vite preview` in its own process, per the ask.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
server.stdout.on('data', (b) => process.stdout.write(`[preview] ${b}`));
server.stderr.on('data', (b) => process.stdout.write(`[preview!] ${b}`));
await new Promise((resolve) => setTimeout(resolve, 5000));

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

const url = `http://127.0.0.1:${PORT}/?view=world&host=1&room=${ROOM}&game=katamari&landscape=1`;
console.log('opening', url);
await page.goto(url, { waitUntil: 'load', timeout: 600_000 });
await page.waitForFunction(() => Boolean(window.__refworldCreatures), null, {
  timeout: 600_000,
});

/*
 * THE SPOT IS THE ID'S. `spawnSpot` is a pure function of the slot id and
 * nothing moves a creature from the outside, so the ID is what gets chosen:
 * two dozen candidates are spawned, `poses()` says where each landed, the
 * nearest to the origin is kept and the rest are cleared. The origin is where
 * the default framing is looking.
 */
const chosen = await page.evaluate(
  ([id, s]) => {
    const m = window.__refworldCreatures;
    const probes = [];
    for (let i = 0; i < 24; i++) probes.push(`${id}-${i}`);
    for (const p of probes) m.spawn(p, s, { hatchMs: 100, grown: true });
    let best = null;
    for (const p of m.poses()) {
      const d = Math.hypot(p.x, p.z);
      if (!best || d < best.d) best = { id: p.id, d, x: p.x, z: p.z };
    }
    for (const p of probes) if (p !== best.id) m.clear(p);
    return best;
  },
  [ID, strokes],
);
console.log('creature at', chosen);
await page.waitForTimeout(8_000);

/*
 * FIFTEEN PROPS, SEATED ON THE PILE'S SURFACE.
 *
 * A prop's FOOTPRINT (`r`, which is what the pile grows on) and the size its
 * model is actually DRAWN at are two different numbers, and a `stick` carries
 * only the first — so a record is free to claim a 1.5 u footprint for a shed
 * that draws fourteen metres across, and the pile then reads as three huge
 * objects hanging off a small ball rather than as a ball. A seat cannot be
 * corrected afterwards either: `seat` refuses a key the clump already holds.
 *
 * So the drawn radius of each (kind, variant, scale) is a MEASURED constant
 * here, read off the vendored object library's own geometry by an earlier run
 * of this script, and `r` is set to it. The measurement is repeated after the
 * fact and printed beside the table, so a change in the library says so.
 */
const SEAT = process.env['SEAT'] !== '0';
const seated = !SEAT ? { skipped: true } : await page.evaluate(
  ([id]) => {
    const m = window.__refworldCreatures;
    const baseR = m.ballDiameter(id) / 2;
    // `growth` (src/creatures/sticky.ts): GROWTH_K = 4, CLUMP_FIT = 0.7.
    const K = 4;
    const FIT = 0.7;
    /*
     * The pile's mix: `medium` junk at three variants and two scales, whose
     * drawn radii (measured) span 0.7 to 2.9 u — a ball of benches and
     * shipping containers rather than one shed and fourteen pebbles.
     */
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
      // The key carries `i`, so no two of the fifteen share one.
      items.push({ ...pick, key: `${pick.kind}:${pick.variant}:${i}:0`, r: pick.drawnR });
    }
    const stick = (it, ox, oy, oz) =>
      m.applyStick({
        id,
        item: it.key,
        kind: it.kind,
        variant: it.variant,
        scale: it.scale,
        r: it.r,
        ox,
        oy,
        oz,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      });
    let sum = 0;
    for (const it of items) sum += it.r * it.r * it.r;
    const g = Math.cbrt(1 + (K * sum) / (baseR * baseR * baseR));
    const R = baseR * g;
    // A fibonacci sphere, so fifteen seats cover the ball evenly.
    const GOLD = Math.PI * (3 - Math.sqrt(5));
    items.forEach((it, i) => {
      const y = 1 - (i / (items.length - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = GOLD * i;
      const reach = (R + it.r * FIT) / g;
      stick(it, Math.cos(th) * rad * reach, y * reach, Math.sin(th) * rad * reach);
    });
    /*
     * And the check on the table: what each one is actually drawn as, from
     * its own geometry's bounding sphere at the scale the loose layer used.
     * The clump's `loose …` children are the fifteen in the order they were
     * seated, so they line up with `items`.
     */
    let scene = window.__refworldWater?.group ?? null;
    while (scene?.parent) scene = scene.parent;
    let clump = null;
    for (const child of scene?.children ?? []) {
      if (typeof child.name === 'string' && child.name.startsWith('creature')) {
        clump = child.getObjectByName('clump') ?? clump;
      }
    }
    const meshes = (clump?.children ?? []).filter(
      (o) => typeof o.name === 'string' && o.name.startsWith('loose'),
    );
    const measured = items.map((it, i) => {
      const probe = meshes[i] ?? null;
      if (!probe?.geometry) return null;
      if (!probe.geometry.boundingSphere) probe.geometry.computeBoundingSphere();
      const radius = probe.geometry.boundingSphere?.radius ?? null;
      return radius === null ? null : Number((radius * it.scale).toFixed(3));
    });
    return {
      baseR,
      g,
      R,
      sum,
      table: items.map((it) => it.r),
      measured,
    };
  },
  [chosen.id],
);
console.log('seated', seated);
// The growth, the roll blend and the clearance are springs over
// MOTION.primaryMs — and this is swiftshader, so give it a long settle. The
// unladen twin has nothing to settle, so it takes the shorter wait.
await page.waitForTimeout(SEAT ? 45_000 : 10_000);

const seen = await page.evaluate(
  ([id]) => {
    const m = window.__refworldCreatures;
    // The scene, through the water handle's group (src/world/scene.ts adds it
    // to the scene directly).
    let scene = window.__refworldWater?.group ?? null;
    while (scene?.parent) scene = scene.parent;
    const scaleOf = (o) => {
      const e = o.matrixWorld.elements;
      return Math.hypot(e[0], e[1], e[2]);
    };
    const posOf = (o) => {
      const e = o.matrixWorld.elements;
      return { x: Number(e[12].toFixed(3)), y: Number(e[13].toFixed(3)), z: Number(e[14].toFixed(3)) };
    };
    const out = {
      ballDiameter: m.ballDiameter(id),
      rollBlend: m.rollBlend(id),
      groundLift: m.groundLift(id),
    };
    let root = null;
    for (const child of scene?.children ?? []) {
      if (typeof child.name === 'string' && child.name.startsWith('creature')) root = child;
    }
    if (!root) return { ...out, found: false };
    const clump = root.getObjectByName('clump');
    const ball = root.getObjectByName('ball');
    const rider = root.getObjectByName('rider');
    const node = rider ?? ball;
    // The character's own group is the node's only child; the drawn body is
    // the first Mesh under it, and the topper hangs on that.
    const charGroup = node?.children?.[0] ?? null;
    let body = null;
    node?.traverse?.((o) => {
      if (!body && o.isMesh) body = o;
    });
    const topper = root.getObjectByName('topper');
    /*
     * WHERE THE ITEMS SIT and WHERE THE GROUND IS (2026-09-17, the floating
     * report). The ball has no body of its own to measure, so the pile's own
     * children are the only witnesses to where the sphere the creature is
     * standing on actually is: their world Y range, against the ground under
     * the creature's centre (`root.y - groundLift` is exactly the height the
     * frame's one ground pass sampled) and against the creature's feet.
     */
    const seats = (clump?.children ?? [])
      .filter((o) => typeof o.name === 'string' && o.name.startsWith('loose'))
      .map((o) => posOf(o));
    const ys = seats.map((s) => s.y);
    const items = {
      n: seats.length,
      minY: ys.length ? Number(Math.min(...ys).toFixed(3)) : null,
      maxY: ys.length ? Number(Math.max(...ys).toFixed(3)) : null,
      spreadXZ: seats.length
        ? Number(
            Math.max(...seats.map((s) => Math.hypot(s.x - posOf(root).x, s.z - posOf(root).z))).toFixed(3),
          )
        : null,
    };
    return {
      ...out,
      found: true,
      bodyR: Number((out.ballDiameter / 2).toFixed(3)),
      // The Surface's own height under the centre: the ground pass writes
      // `sampleHeight + groundLift`, so this subtracts the lift back off.
      groundY: Number((posOf(root).y - out.groundLift).toFixed(3)),
      items,
      rootScale: Number(root.scale.x.toFixed(4)),
      rootPos: posOf(root),
      nodeName: node?.name ?? null,
      nodeScale: node ? Number(node.scale.x.toFixed(4)) : null,
      nodeLocalY: node ? Number(node.position.y.toFixed(4)) : null,
      // THE NUMBER THIS SHOT IS ABOUT: the drawn creature's world scale,
      // which must not move as the ball grows. 1 means "its drawn size".
      charWorldScale: charGroup ? Number(scaleOf(charGroup).toFixed(4)) : null,
      charWorldPos: charGroup ? posOf(charGroup) : null,
      // The body's own mesh scale is a constant of the generator; the RATIO
      // of body to char group is what the counter-scale leaves alone.
      bodyWorldScale: body ? Number(scaleOf(body).toFixed(4)) : null,
      topperWorldScale: topper ? Number(scaleOf(topper).toFixed(4)) : null,
      stuck: clump ? clump.children.length : null,
    };
  },
  [chosen.id],
);
console.log('seen', JSON.stringify(seen, null, 2));

const shot = join(HERE, `${NAME}.png`);
await page.screenshot({ path: shot });
await browser.close();
server.kill('SIGTERM');
console.log('shot', shot);
