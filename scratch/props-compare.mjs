/**
 * DOES THE COMPRESSION SHOW — measured two ways, because one of them is not
 * enough.
 *
 * > User ruling, 2026-09-16: *"I don't want to compromise on quality."*
 *
 * `scripts/katamari-curate.mjs` compresses every published glb, and the one
 * approximation in that pipeline is the quantisation grid
 * (`QUANTIZE_BITS` — 16 bits of position, 12 of normal, 16 of uv). This file
 * is the evidence for the claim that it cannot be seen.
 *
 * ── 1. THE GEOMETRY, EXACTLY ────────────────────────────────────────────────
 *
 * Every model in the active set is loaded twice through the REAL
 * `GLTFLoader` — once from the library as extracted, once from
 * `public/katamari/models/` as published — and put through the app's own
 * `buildKatamariModel`, which is what the world actually draws. Then the two
 * are compared vertex by vertex, in the prop's own normalised space (so the
 * numbers are WORLD UNITS, the units the camera sees):
 *
 *   the largest position deviation, and the same number in SCREEN PIXELS at
 *     the camera's scale;
 *   the largest normal angle, in degrees;
 *   the largest uv deviation, and the same in TEXELS of a 32-px texture;
 *   and the triangle count, which must be identical — nothing is simplified.
 *
 * This is the stronger of the two tests and it has no noise in it at all.
 *
 * ── 2. THE FRAME, WITH A CONTROL ───────────────────────────────────────────
 *
 * …and then the picture, because the ruling asks for a pixel diff. The built
 * `valiocon` world is rendered twice at 2x device pixels — once with the
 * published models, once with the library's originals copied over them — and
 * a crop of the props is compared, ALONGSIDE A FLAT CONTROL CROP of open
 * ground. The control is the whole method: the grain is a full-frame
 * post-process with per-frame noise in it (TASTE §2.7) and the camera drifts,
 * so two runs of the same build differ. A props diff at the control's level
 * means the difference is the grain and not the models — the same argument
 * docs/PLAN.md §7.1 makes about the ground field's segment count.
 *
 *   node scratch/props-compare.mjs --source <unpacked-library-dir>
 *   node scratch/props-compare.mjs --source <dir> --geometry-only
 *
 * The geometry half needs no browser and takes a few seconds. The frame half
 * builds twice and renders under swiftshader, so it takes minutes.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env['PORT'] ?? 4211);

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const SOURCE = opt('source', process.env['KATAMARI_LIBRARY'] ?? '');
const geometryOnly = argv.includes('--geometry-only');
if (!SOURCE) throw new Error('pass --source <unpacked-library-dir>');

const MODELS = join(ROOT, 'public', 'katamari', 'models');
const catalog = JSON.parse(readFileSync(join(ROOT, 'public', 'katamari', 'catalog.json'), 'utf8'));

// ── 1. the geometry, exactly ────────────────────────────────────────────────
/*
 * `GLTFLoader.parseAsync` needs two globals the moment it meets an embedded
 * image and node has neither — the same two stubs
 * test/world/katamari/models.test.ts installs, for the same reason: nothing
 * here samples a texture.
 */
globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 4, height: 4, close() {} });

const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
const { buildKatamariModel } = await import('../src/world/katamari/models.ts');

/** One file through the loader and the app's own assembly. */
async function build(path, entry) {
  const buffer = readFileSync(path);
  const array = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(array, '');
  return buildKatamariModel(gltf.scene, entry);
}

/**
 * THE CAMERA'S SCALE, world units per screen pixel.
 *
 * The isometric rig frames a fixed number of world units across the
 * viewport; 60 units over a 1280-pixel frame is the order the tour sits at
 * (src/world/camera.ts), which makes one pixel ~0.047 world units. Stated
 * here as the one number the deviations are converted with, rather than
 * pretending a sub-millimetre figure means something on its own.
 */
const UNITS_PER_PIXEL = 60 / 1280;

/**
 * ORDER-INDEPENDENT, AND IT HAS TO BE.
 *
 * `weld` re-indexes and `reorder` deliberately shuffles triangles for the
 * vertex cache, and `conformKatamariGeometry` then flattens both sides back
 * to a non-indexed soup — so the i-th vertex of the original and the i-th of
 * the published file are not the same vertex, even though the triangle
 * counts match to the one. Comparing by index measured the SHUFFLE and
 * reported 27 world units of "deviation" on a squid.
 *
 * So the measure is a one-sided Hausdorff distance: for every vertex of the
 * published geometry, the distance to the NEAREST vertex of the original,
 * through a grid hash. That is the honest question — "did any part of this
 * model move" — and it is invariant to every reordering the pipeline does.
 * The matched vertex also carries the normal and uv the published one is
 * compared against.
 */
function gridOf(position, cell) {
  const buckets = new Map();
  const key = (x, y, z) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < position.count; i++) {
    const k = key(position.getX(i), position.getY(i), position.getZ(i));
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }
  return {
    /** Indices in the 27 cells around a point. */
    near(x, y, z) {
      const out = [];
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const cz = Math.floor(z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const list = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (list) for (const i of list) out.push(i);
          }
        }
      }
      return out;
    },
  };
}

const worst = {
  position: 0,
  normalDeg: 0,
  uv: 0,
  positionAt: '',
  normalAt: '',
  uvAt: '',
};
let triangleMismatch = 0;
let compared = 0;
let missing = 0;

for (const entry of catalog.models) {
  const published = join(MODELS, entry.file);
  const original = join(SOURCE, entry.file);
  if (!existsSync(original)) {
    missing++;
    continue;
  }
  const a = await build(original, entry);
  const b = await build(published, entry);
  const pa = a.geometry.getAttribute('position');
  const pb = b.geometry.getAttribute('position');
  // NOTHING IS SIMPLIFIED: the same triangles are drawn either way.
  if (Math.round(pa.count / 3) !== Math.round(pb.count / 3)) {
    triangleMismatch++;
    console.log(`  triangles differ: ${entry.id} ${entry.file} ${pa.count / 3} → ${pb.count / 3}`);
  }
  const na = a.geometry.getAttribute('normal');
  const nb = b.geometry.getAttribute('normal');
  const ua = a.geometry.getAttribute('uv');
  const ub = b.geometry.getAttribute('uv');
  // A cell a twentieth of the prop's own height: big enough that a match is
  // always in the 27 around it, small enough to stay cheap.
  const grid = gridOf(pa, Math.max(entry.heightUnits / 20, 1e-3));
  for (let i = 0; i < pb.count; i++) {
    const x = pb.getX(i);
    const y = pb.getY(i);
    const z = pb.getZ(i);
    /*
     * A SEAM IS SEVERAL VERTICES AT ONE POINT. A hard edge puts two
     * vertices at the same position with opposite normals, and a uv seam
     * puts two at the same position with unrelated uvs — so the NEAREST
     * vertex is not necessarily the CORRESPONDING one, and picking it
     * arbitrarily reported 180° of "normal deviation" on a propane tank
     * that had not moved. The honest question is whether a corresponding
     * vertex EXISTS, so each measure is the minimum over the co-located
     * candidates.
     */
    let best = Infinity;
    for (const j of grid.near(x, y, z)) {
      const d = Math.hypot(pa.getX(j) - x, pa.getY(j) - y, pa.getZ(j) - z);
      if (d < best) best = d;
    }
    if (!(best < Infinity)) continue;
    if (best > worst.position) {
      worst.position = best;
      worst.positionAt = entry.file;
    }
    let bestDeg = Infinity;
    let bestUv = Infinity;
    for (const j of grid.near(x, y, z)) {
      const d = Math.hypot(pa.getX(j) - x, pa.getY(j) - y, pa.getZ(j) - z);
      // Only the ones at (as near as makes no difference) the same point.
      if (d > best + 1e-6) continue;
      const dot = na.getX(j) * nb.getX(i) + na.getY(j) * nb.getY(i) + na.getZ(j) * nb.getZ(i);
      const la = Math.hypot(na.getX(j), na.getY(j), na.getZ(j));
      const lb = Math.hypot(nb.getX(i), nb.getY(i), nb.getZ(i));
      if (la > 1e-6 && lb > 1e-6) {
        const deg = (Math.acos(Math.min(1, Math.max(-1, dot / (la * lb)))) * 180) / Math.PI;
        if (deg < bestDeg) bestDeg = deg;
      }
      const du = Math.hypot(ua.getX(j) - ub.getX(i), ua.getY(j) - ub.getY(i));
      if (du < bestUv) bestUv = du;
    }
    if (bestDeg < Infinity && bestDeg > worst.normalDeg) {
      worst.normalDeg = bestDeg;
      worst.normalAt = entry.file;
    }
    if (bestUv < Infinity && bestUv > worst.uv) {
      worst.uv = bestUv;
      worst.uvAt = entry.file;
    }
  }
  compared++;
  a.geometry.dispose();
  b.geometry.dispose();
}

console.log(`\ngeometry: ${compared} models compared, ${missing} not in the library`);
console.log(
  `  worst position deviation  ${worst.position.toExponential(3)} u ` +
    `= ${(worst.position / UNITS_PER_PIXEL).toExponential(3)} screen px  [${worst.positionAt}]`,
);
console.log(`  worst normal deviation    ${worst.normalDeg.toFixed(4)}°  [${worst.normalAt}]`);
console.log(
  `  worst uv deviation        ${worst.uv.toExponential(3)} ` +
    `= ${(worst.uv * 32).toExponential(3)} texels of a 32-px map  [${worst.uvAt}]`,
);
console.log(`  triangle-count mismatches ${triangleMismatch}`);

if (geometryOnly) process.exit(triangleMismatch === 0 ? 0 : 1);

// ── 2. the frame, with a control ───────────────────────────────────────────
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

let executablePath = existsSync('/opt/pw-browsers/chromium')
  ? '/opt/pw-browsers/chromium'
  : undefined;
for (const d of existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers') : []) {
  if (!d.startsWith('chromium-')) continue;
  const at = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
  if (existsSync(at)) executablePath = at;
}

/** Build, serve, render one frame of the default view, hand back the png. */
async function shoot(label) {
  execFileSync('npm', ['run', 'build'], {
    cwd: ROOT,
    env: { ...process.env, VITE_WORLD: 'valiocon' },
    stdio: 'inherit',
  });
  const server = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, env: { ...process.env, NO_PROXY: '127.0.0.1' }, stdio: 'ignore' },
  );
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });
  // 2x device pixels — the "2x zoom" the ruling asks the comparison to hold at.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(600_000);
  await tab.goto(`http://127.0.0.1:${PORT}/?view=world&host=1&landscape=1`, {
    waitUntil: 'load',
    timeout: 600_000,
  });
  // The library, then a fixed number of composed frames — so the camera's
  // own drift has gone the same distance in both runs.
  await tab.waitForFunction(
    () => performance.getEntriesByName('refworld:katamari-library').length > 0,
    null,
    { timeout: 600_000 },
  );
  await tab.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  });
  const path = join(HERE, `props-compare-${label}.png`);
  await tab.screenshot({ path });
  await browser.close();
  server.kill('SIGTERM');
  return path;
}

// The published models, then the library's originals in their place.
const backup = join(HERE, 'props-compare-published');
rmSync(backup, { recursive: true, force: true });
mkdirSync(backup, { recursive: true });
for (const entry of catalog.models)
  copyFileSync(join(MODELS, entry.file), join(backup, entry.file));

const after = await shoot('after');
let before = null;
try {
  for (const entry of catalog.models) {
    const original = join(SOURCE, entry.file);
    if (existsSync(original)) copyFileSync(original, join(MODELS, entry.file));
  }
  before = await shoot('before');
} finally {
  // Always put the published bytes back — the catalog's hashes describe them.
  for (const entry of catalog.models)
    copyFileSync(join(backup, entry.file), join(MODELS, entry.file));
  rmSync(backup, { recursive: true, force: true });
}

// ── the diff, on two crops ─────────────────────────────────────────────────
const { PNG } = await (async () => {
  try {
    return await import('pngjs');
  } catch {
    return { PNG: null };
  }
})();
if (!PNG) {
  console.log(
    `\nno pngjs on this machine — the two frames are at:\n  ${before}\n  ${after}\n` +
      'compare them with whatever is to hand; the geometry half above is the ' +
      'measurement that does not need a decoder.',
  );
  process.exit(0);
}

function read(path) {
  return PNG.sync.read(readFileSync(path));
}
/** Mean and max per-channel difference over one crop. */
function diff(a, b, x0, y0, w, h) {
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[i + c] - b.data[i + c]);
        sum += d;
        if (d > max) max = d;
        n++;
      }
    }
  }
  return { mean: sum / n, max };
}

const A = read(before);
const B = read(after);
// The props crop is the middle band, where the scatter draws; the control is
// a strip of open sky/ground at the very top, which has no prop in it.
const props = diff(
  A,
  B,
  Math.round(A.width * 0.25),
  Math.round(A.height * 0.45),
  Math.round(A.width * 0.5),
  Math.round(A.height * 0.35),
);
const control = diff(A, B, 0, 0, A.width, Math.round(A.height * 0.08));
console.log('\nframe, 1280x800 at 2x device pixels:');
console.log(`  props crop    mean ${props.mean.toFixed(3)} / max ${props.max} per channel`);
console.log(`  control crop  mean ${control.mean.toFixed(3)} / max ${control.max} per channel`);
console.log(
  "  (the control has no prop in it: a props diff at the control's level is the\n" +
    '   grain and the camera drift, not the models — docs/PLAN.md §7.1)',
);
console.log(`\n  ${before}\n  ${after}`);
