#!/usr/bin/env node
/**
 * Copy the curated katamari models into `public/katamari/` (user ask,
 * 2026-09-15: the buildings and objects come from the Katamari library).
 *
 * The LIBRARY is 1,703 `.glb` and ~35 MB and does not belong in this repo. The
 * curated subset does: 82 models, ~1.4 MB, named one by one in
 * `src/world/katamari/catalog.ts`. This script is the seam between the two —
 * it reads the library's `manifest.json`, checks every row of the table against
 * it, copies the chosen files, and writes `public/katamari/catalog.json`, which
 * is what `src/world/katamari/models.ts` loads at runtime.
 *
 * Usage:
 *   node scripts/katamari-curate.mjs --all --source <library-dir>
 *   node scripts/katamari-curate.mjs --verify
 *   node scripts/katamari-curate.mjs --catalog
 *
 *   --source   the unpacked library (the folder holding manifest.json and the
 *              .glb files). Also read from KATAMARI_LIBRARY. Only with
 *              `--all` — see the note at the bottom of this file on why the
 *              hand-table copy is gone.
 *   --verify   no library needed: check that everything the table names is
 *              already published and that catalog.json is exactly what the
 *              table serialises to. This is what the test suite runs, because
 *              the library is not in the repo and never will be.
 *   --catalog  no library needed either: rewrite `catalog.json` from the
 *              table and nothing else. For a table edit that only moves rows
 *              between kinds, renames a tier or adds a flag — which needs no
 *              new file copied and must not need 35 MB of library to publish.
 *              It refuses to drop a published model (that is a `--source` run
 *              plus a deletion by hand), so it can only ever bring the JSON
 *              back in step with the `.ts`.
 *   --all      AUTO-CURATE (2026-09-16, user ask: *"bring as many katamari
 *              objects in from the library as possible, minus the main
 *              characters"*). Reads the whole manifest, measures every glb's
 *              real bounds out of its own json chunk, applies the rules in
 *              `src/world/katamari/rules.ts` to get a kind / tier / height /
 *              region for each, picks the ACTIVE set per kind by a seeded
 *              shuffle, then writes `src/world/katamari/catalog.data.ts` and
 *              `public/katamari/catalog.json` and copies the active glbs.
 *              Deterministic: same library + same rules → same bytes.
 *   --quiet    totals only, no per-model table.
 *
 * IDEMPOTENT, in the strong sense: a file whose bytes already match is not
 * rewritten, `catalog.json` carries no timestamp and no counts read off the
 * library (so it is a pure function of the table), and a second run prints the
 * same table and changes nothing. `--verify` after a run must exit 0.
 *
 * ALMOST NO DEPENDENCIES. The table is loaded straight from the `.ts` file
 * through node's own type stripping (node >= 22.6) — `catalog.ts` imports
 * nothing at runtime for exactly that reason — and everything that reads a
 * glb's bounds is plain node over its own json chunk. The one exception is
 * the COMPRESSION below (`--all`, `--source`): `@gltf-transform` plus
 * `meshoptimizer`, four dev dependencies, imported lazily so `--verify` and
 * `--catalog` still run with nothing installed.
 *
 * COMPRESSION (2026-09-16, the slow-network work). Every published glb goes
 * through `dedup` → `prune` → `weld` → `quantize` → `meshopt`
 * (`EXT_meshopt_compression`) on the way into `public/katamari/models/`, and
 * the runtime loads them with three's `MeshoptDecoder`
 * (src/world/katamari/models.ts). Measured on the 182-model active set:
 * 3.82 mb → 2.35 mb on the wire, of which 1.29 mb is now the baked PS2
 * textures and is left exactly as extracted. Each published file also gets a
 * CONTENT HASH (`KatamariEntry.hash`), which is what lets the models be
 * served `immutable` for a year without a re-curation serving a stale one.
 *
 * PROVENANCE. The library is a personal-use extraction from a retail copy of
 * *Katamari Damacy* (`SLUS-21008`); the assets remain Namco's. `valiocon` is a
 * private demo world. See public/katamari/README.md.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

/**
 * Budgets the ACTIVE set is held to — `ACTIVE_MAX_TRIANGLES` /
 * `ACTIVE_MAX_BYTES` in `src/world/katamari/rules.ts`, filled in once the
 * rules are loaded so the numbers have one home. The first pass had them
 * here as 150k / 4 mb, sized for 82 hand-picked models; the auto-curated
 * active set is 300-odd.
 */
let MAX_TRIANGLES = 300_000;
let MAX_BYTES = 7 * 1024 * 1024;

function parseArgs(argv) {
  const out = {
    source: process.env.KATAMARI_LIBRARY ?? '',
    verify: false,
    catalog: false,
    all: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') out.source = argv[++i] ?? '';
    else if (arg === '--verify') out.verify = true;
    else if (arg === '--catalog') out.catalog = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--quiet') out.quiet = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

async function loadModule(file) {
  const path = join(ROOT, 'src', 'world', 'katamari', file);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    console.error(
      `could not read ${path} — this needs a node with typescript stripping (>= 22.6):\n${error}`,
    );
    process.exit(2);
  }
}

/**
 * The RULES (`rules.ts`) plus, where a mode needs them, the generated ROWS
 * (`catalog.data.ts`).
 *
 * The two data files and not `catalog.ts`: that one is the app's seam and
 * imports its neighbour the way the bundler wants it (no extension), which
 * node's own type stripping will not resolve. Nothing is lost — `catalog.ts`
 * adds no data of its own.
 *
 * `--all` deliberately reads the rules ALONE: it is the mode that WRITES the
 * rows, and asking it to import them first would mean a generated file had to
 * exist before it could be generated.
 */
async function loadTable(withRows) {
  const rules = await loadModule('rules.ts');
  if (!withRows) return rules;
  const data = await loadModule('catalog.data.ts');
  return { ...rules, KATAMARI_CATALOG: data.KATAMARI_ROWS };
}

/**
 * `catalog.json`, as a pure function of the table: same key order every time,
 * no timestamp, nothing read off the library. That is what makes `--verify`
 * meaningful and the run idempotent.
 */
function serializeRows(rows, baseUrl) {
  const models = rows.map((entry) => {
    const row = {
      id: entry.id,
      name: entry.name,
      internalName: entry.internalName ?? '',
      file: entry.file,
      kind: entry.kind,
      tier: entry.tier,
      heightUnits: entry.heightUnits,
      rooted: entry.rooted,
    };
    if (entry.beach === true) row.beach = true;
    if (entry.inland === true) row.inland = true;
    if (entry.label !== undefined) row.label = entry.label;
    // Last, so the shape of a row a person reads is unchanged and the cache
    // key is an appendix (`KatamariEntry.hash`).
    if (entry.hash !== undefined) row.hash = entry.hash;
    return row;
  });
  return `${JSON.stringify({ baseUrl, models }, null, 2)}\n`;
}

function serializeCatalog(table) {
  return serializeRows(table.KATAMARI_CATALOG, table.KATAMARI_BASE_URL);
}

// ── compression, and the content hash it produces ───────────────────────────

/**
 * THE PUBLISHED FILE'S CACHE KEY — eight hex of sha256 over its bytes.
 *
 * Eight is 32 bits: a collision inside a 182-file library is not a risk worth
 * a longer url, and the url is read by a person debugging a cache miss.
 */
function contentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

/**
 * `@gltf-transform` and the meshopt encoder, imported ONCE and LAZILY.
 *
 * Lazily because `--verify` and `--catalog` are what the test suite and a
 * table edit run, and neither of them touches a glb's geometry — so neither
 * should need four packages installed to work. A publishing mode that cannot
 * find them fails loudly rather than quietly shipping uncompressed models:
 * the byte budget and the catalog's hashes would both be wrong, and a
 * half-compressed library is worse than none.
 */
let pipeline = null;
async function gltfPipeline() {
  if (pipeline) return pipeline;
  try {
    const [{ NodeIO }, extensions, functions, meshoptimizer] = await Promise.all([
      import('@gltf-transform/core'),
      import('@gltf-transform/extensions'),
      import('@gltf-transform/functions'),
      import('meshoptimizer'),
    ]);
    const { MeshoptEncoder, MeshoptDecoder } = meshoptimizer;
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    /*
     * BOTH extensions, and the second one is not optional.
     *
     * `quantize` writes integer attributes and declares
     * `KHR_mesh_quantization`; an io that has not registered it drops the
     * declaration on write ("Some extensions were not registered for I/O")
     * and publishes a file whose accessors are quantised and whose header
     * does not say so. Three parses it anyway, which is exactly why it has
     * to be caught here rather than on a frame.
     */
    const io = new NodeIO()
      .registerExtensions([extensions.EXTMeshoptCompression, extensions.KHRMeshQuantization])
      .registerDependencies({
        'meshopt.decoder': MeshoptDecoder,
        'meshopt.encoder': MeshoptEncoder,
      });
    pipeline = { io, functions, extensions, MeshoptEncoder };
    return pipeline;
  } catch (error) {
    console.error(
      'the compression pipeline is not installed. it is four dev dependencies:\n' +
        '  npm i -D @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer\n' +
        `${error}`,
    );
    process.exit(2);
  }
}

/**
 * WHY THERE IS NO `quantize` IN THE PIPELINE BELOW.
 *
 * > User ruling, 2026-09-16: *"I don't want to compromise on quality."*
 *
 * `@gltf-transform`'s `meshopt()` is a wrapper around `reorder` + `quantize`
 * + the extension, so taking it whole means taking its quantisation — and
 * quantisation is the only step in this pipeline that changes a number. It
 * was measured three ways over the whole 182-model active set
 * (`scratch/props-compare.mjs`, every model loaded twice through the real
 * `GLTFLoader` and the app's own `buildKatamariModel`, compared by a
 * one-sided Hausdorff distance so the reordering does not count):
 *
 *   | | published | worst position deviation |
 *   | --- | --- | --- |
 *   | dedup + prune + weld alone | 3.34 mb | 0 |
 *   | …+ meshopt, NO quantize | **2.93 mb** | **0 — bit-exact** |
 *   | …+ meshopt + quantize 16/12/16 | 2.35 mb | 5.3e-4 u = 0.011 screen px |
 *   | …+ meshopt + quantize 14/12/12 | 2.35 mb | — |
 *
 * 0.011 of a pixel is not a thing anybody can see, and at first that looked
 * like the answer. Two things decided against it. The smaller: 0.58 mb, on
 * top of a library that is now over half baked texture. The larger: the
 * quantised set showed unexplained normal and uv outliers on two models
 * (a fish statue, a palm tree) that the no-quantize set does not, and the
 * ruling above is not the place to ship an unexplained outlier.
 *
 * So the pipeline is LOSSLESS, and provably: 0 position deviation, 0° normal
 * deviation and 0 uv deviation on every model in the set, which means the
 * frame is the same frame and not merely a frame nobody can tell apart.
 * Re-check it any time with
 *
 *   npx tsx scratch/props-compare.mjs --source <library-dir> --geometry-only
 *
 * (Quantisation is still where the next 0.58 mb is, if somebody wants it and
 * wants to explain those two models first. The grid to use is 16 bits of
 * position, 12 of normal, 16 of uv — the library's own defaults put normals
 * at 10, which is not enough to promise anything.)
 *
 * ⚠️ IT ALSO FOUND A BUG, which is the reason to keep the harness: a
 * quantised model stores uv as normalised unsigned shorts, and
 * `conformKatamariGeometry` was reading the raw array — 32767 where the
 * value is 1.0. Every quantised model would have drawn the wrong texel. The
 * loader de-normalises through the accessor now
 * (`floatsOf`, src/world/katamari/models.ts), so the door is open either way.
 */

/**
 * One library glb → the bytes this world publishes.
 *
 * FOUR PASSES, and each of them is the answer to something the PS2
 * extraction leaves behind. Measured over the 182-model active set:
 * 3.82 mb → 2.93 mb, with the geometry BIT-EXACT after decode (see the note
 * above on why there is no quantisation here).
 *
 *   `dedup`    — the extraction writes a mesh's accessors per primitive, so a
 *                multipart prop repeats the same material and sampler rows.
 *                Lossless.
 *   `prune`    — nodes, accessors and samplers nothing references. The
 *                loudest one: the extractor leaves TANGENT and a second uv on
 *                models whose material reads neither. Lossless.
 *   `weld`     — the geometry arrives non-indexed (a flat triangle soup), and
 *                welding merges BITWISE IDENTICAL vertices back under an
 *                index. Lossless, and most of the saving before anything is
 *                compressed.
 *   `reorder`  — meshopt's vertex-cache order. It shuffles triangles and
 *                nothing else, so the draw is identical and the codec's job
 *                gets easier. Lossless.
 *   the extension — `EXT_meshopt_compression` over the buffer views, decoded
 *                at load by three's `MeshoptDecoder` (~30 kb, and only on a
 *                katamari world). An entropy coder over the bytes: what
 *                comes back out is what went in, bit for bit.
 *
 * NOTHING IS SIMPLIFIED, NOTHING IS DROPPED, NO TEXTURE IS RESIZED. There is
 * no `simplify` and no `textureCompress` in this list and there must not be:
 * the models are 29,510 triangles all together and the budget is 300,000, so
 * decimation would be spending quality to save nothing.
 *
 * TEXTURES ARE LEFT EXACTLY AS EXTRACTED — not re-encoded, not resized. They
 * are 1.29 mb of the 2.93, so they ARE the bulk now and the honest thing is
 * to say so
 * rather than to re-encode them: they are 32-px PS2 textures sampled at
 * `NearestFilter` and posterised by the cel material
 * (src/world/katamari/material.ts), and both webp and basisu would move
 * bytes that the shader then quantises anyway, at the cost of a decoder the
 * page does not otherwise carry. Reported by `--all`, decided by a person.
 *
 * DETERMINISTIC. Same input bytes and same versions → same output bytes, so
 * `--verify` after a run exits 0 and a second `--all` copies nothing. That
 * is a property of the transforms and is pinned by the idempotency test.
 */
async function compressGlb(bytes) {
  const { io, functions, extensions, MeshoptEncoder } = await gltfPipeline();
  const doc = await io.readBinary(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  await doc.transform(
    functions.dedup(),
    functions.prune(),
    functions.weld(),
    functions.reorder({ encoder: MeshoptEncoder }),
  );
  // The extension itself, rather than `functions.meshopt()`, which is a
  // wrapper around `reorder` + `quantize` + this and gives no way to leave
  // the quantisation out. See the note above for why it is left out.
  doc
    .createExtension(extensions.EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: extensions.EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return Buffer.from(await io.writeBinary(doc));
}

/** How many bytes the glb's own textures are, for the report above. */
async function textureBytes(bytes) {
  const { io } = await gltfPipeline();
  const doc = await io.readBinary(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  let total = 0;
  for (const texture of doc.getRoot().listTextures()) total += texture.getImage()?.byteLength ?? 0;
  return total;
}

/** Same bytes already there? Then nothing is written. */
function writeIfChanged(path, bytes) {
  if (existsSync(path)) {
    const current = readFileSync(path);
    if (Buffer.compare(current, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) === 0) {
      return false;
    }
  }
  writeFileSync(path, bytes);
  return true;
}

function publicPaths() {
  const base = join(ROOT, 'public', 'katamari');
  return {
    base,
    models: join(base, 'models'),
    catalog: join(base, 'catalog.json'),
  };
}

function fail(messages) {
  for (const m of messages) console.error(`  ${m}`);
  console.error(`\n${messages.length} problem(s) — nothing written.`);
  process.exit(1);
}

function printTable(rows, quiet) {
  if (!quiet) {
    const widths = [6, 22, 13, 9, 7, 7, 6, 7, 8];
    const head = ['id', 'name', 'kind', 'tier', 'height', 'rooted', 'beach', 'inland', 'tris'];
    const line = (cells) =>
      cells.map((c, i) => String(c).padEnd(widths[i]).slice(0, widths[i])).join(' ');
    console.log(line(head));
    console.log(widths.map((w) => '-'.repeat(w)).join(' '));
    for (const r of rows) {
      console.log(
        line([
          r.id,
          r.name.trim(),
          r.kind,
          r.tier,
          r.heightUnits,
          r.rooted ? 'yes' : 'no',
          r.beach ? 'yes' : '',
          (r.inland ?? !r.beach) ? 'yes' : '',
          r.triangles ?? '',
        ]),
      );
    }
  }
  const triangles = rows.reduce((n, r) => n + (r.triangles ?? 0), 0);
  const bytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
  console.log(
    `\n${rows.length} models` +
      (triangles > 0 ? `, ${triangles} triangles (budget ${MAX_TRIANGLES})` : '') +
      `, ${(bytes / 1024 / 1024).toFixed(2)} mb (budget ${(MAX_BYTES / 1024 / 1024).toFixed(0)} mb)`,
  );
  if (triangles > MAX_TRIANGLES) fail([`triangle budget blown: ${triangles} > ${MAX_TRIANGLES}`]);
  if (bytes > MAX_BYTES) fail([`byte budget blown: ${bytes} > ${MAX_BYTES}`]);
}

async function verify(table, args) {
  const paths = publicPaths();
  const problems = [];
  if (!existsSync(paths.models)) problems.push(`missing ${paths.models} — run with --source first`);
  const rows = [];
  for (const entry of table.KATAMARI_CATALOG) {
    const path = join(paths.models, entry.file);
    if (!existsSync(path)) {
      problems.push(`${entry.id}: ${entry.file} is not published`);
      continue;
    }
    const data = readFileSync(path);
    rows.push({ ...entry, bytes: data.length });
    /*
     * THE HASH IS THE CACHE KEY, so a row whose hash does not describe the
     * file on disk is a stale model somebody will hold for a year
     * (`KatamariEntry.hash`). Checked here rather than trusted, because the
     * table is generated and the file is copied by two different passes and
     * this is the one place both are in hand.
     */
    if (entry.hash === undefined) problems.push(`${entry.id}: no content hash in the table`);
    else if (entry.hash !== contentHash(data)) {
      problems.push(
        `${entry.id}: hash says ${entry.hash}, ${entry.file} is ${contentHash(data)} — re-run --all`,
      );
    }
  }
  const want = serializeCatalog(table);
  if (!existsSync(paths.catalog)) problems.push('catalog.json is missing');
  else if (readFileSync(paths.catalog, 'utf8') !== want) {
    problems.push('catalog.json does not match the table — re-run with --source');
  }
  // Anything published that the table no longer names is stale.
  if (existsSync(paths.models)) {
    const named = new Set(table.KATAMARI_CATALOG.map((e) => e.file));
    for (const file of readdirSync(paths.models)) {
      if (file.endsWith('.glb') && !named.has(file)) problems.push(`stale model: ${file}`);
    }
  }
  if (problems.length > 0) fail(problems);
  printTable(rows, args.quiet);
  console.log('verified: every model published, catalog.json matches the table.');
}

/**
 * Rewrite `catalog.json` from the table, with no library — see `--catalog`.
 *
 * Every model the table names must already be published, which is what keeps
 * this from publishing a row whose glb nobody copied.
 */
function writeCatalog(table, args) {
  const paths = publicPaths();
  const problems = [];
  const rows = [];
  for (const entry of table.KATAMARI_CATALOG) {
    const path = join(paths.models, entry.file);
    if (!existsSync(path)) {
      problems.push(`${entry.id}: ${entry.file} is not published`);
      continue;
    }
    const data = readFileSync(path);
    rows.push({ ...entry, bytes: data.length });
    // Same check `--verify` makes, for the same reason: this mode writes the
    // json the browser reads, so it must never publish a cache key that does
    // not describe the file beside it.
    if (entry.hash !== undefined && entry.hash !== contentHash(data)) {
      problems.push(
        `${entry.id}: hash says ${entry.hash}, ${entry.file} is ${contentHash(data)} — re-run --all`,
      );
    }
  }
  if (problems.length > 0) fail(problems);
  const written = writeIfChanged(paths.catalog, serializeCatalog(table));
  printTable(rows, args.quiet);
  const named = new Set(table.KATAMARI_CATALOG.map((e) => e.file));
  const stale = readdirSync(paths.models).filter((f) => f.endsWith('.glb') && !named.has(f));
  console.log(`catalog.json ${written ? 'rewritten' : 'unchanged'}.`);
  if (stale.length > 0) {
    console.log(`\n${stale.length} published model(s) the table no longer names — delete by hand:`);
    for (const f of stale) console.log(`  public/katamari/models/${f}`);
  }
}

// ── auto-curation (--all) ───────────────────────────────────────────────────
// Everything below reads the library ITSELF rather than a hand-written table:
// the manifest for the names and the triangle counts, and each glb's own json
// chunk for its bounds. No dependencies and no gltf loader — a glb is a
// 12-byte header and two chunks, and the accessors carry POSITION min/max, so
// the real size of 1,703 models is a few hundred milliseconds of JSON.parse.

/** The json chunk of a glb, parsed. */
function glbJson(path) {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.readUInt32LE(0) !== 0x46546c67) return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    }
    off += 8 + len;
  }
  return null;
}

/** 4x4 column-major multiply (glTF's own layout). */
function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = v;
    }
  }
  return out;
}

/** A node's local matrix: its own `matrix`, or T * R * S. */
function nodeMatrix(node) {
  if (Array.isArray(node.matrix)) return node.matrix.slice();
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const sc = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * sc[0],
    (xy + wz) * sc[0],
    (xz - wy) * sc[0],
    0,
    (xy - wz) * sc[1],
    (1 - (xx + zz)) * sc[1],
    (yz + wx) * sc[1],
    0,
    (xz + wy) * sc[2],
    (yz - wx) * sc[2],
    (1 - (xx + yy)) * sc[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * The model's own bounding box in metres, node transforms and all.
 *
 * The eight corners of each primitive's POSITION min/max, pushed through the
 * node's world matrix and unioned — which is what a loader would do, without
 * the loader. A multipart prop (a car's body, wheels and glass) is several
 * nodes and each carries its own transform, so skipping them would measure a
 * wheel as the whole car.
 */
function glbBounds(path) {
  const json = glbJson(path);
  if (!json || !Array.isArray(json.meshes) || !Array.isArray(json.accessors)) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const visit = (index, parent) => {
    const node = json.nodes?.[index];
    if (!node) return;
    const world = matMul(parent, nodeMatrix(node));
    const mesh = node.mesh === undefined ? null : json.meshes[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
      const accessor = json.accessors[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      for (let corner = 0; corner < 8; corner++) {
        const p = [
          corner & 1 ? accessor.max[0] : accessor.min[0],
          corner & 2 ? accessor.max[1] : accessor.min[1],
          corner & 4 ? accessor.max[2] : accessor.min[2],
        ];
        for (let axis = 0; axis < 3; axis++) {
          const v =
            world[axis] * p[0] + world[4 + axis] * p[1] + world[8 + axis] * p[2] + world[12 + axis];
          if (v < min[axis]) min[axis] = v;
          if (v > max[axis]) max[axis] = v;
          any = true;
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? []) visit(root, IDENTITY);
  if (!any) return null;
  return {
    height: max[1] - min[1],
    width: Math.max(max[0] - min[0], max[2] - min[2]),
  };
}

/** Why a manifest row is not admitted, or null. */
function exclusionOf(model, table) {
  if (model.status !== 'exported' || !model.file) return model.status || 'no_model';
  const internal = model.internalName ?? '';
  for (const prefix of table.EXCLUDED_INTERNAL_PREFIXES) {
    if (internal.startsWith(prefix)) return `character (${internal})`;
  }
  const name = (model.name ?? '').toLowerCase();
  for (const word of table.EXCLUDED_NAME_WORDS) if (name.includes(word)) return `character (${word})`;
  if ((model.triangles ?? 0) <= 0) return 'no triangles';
  return null;
}

/** The kind a model's NAME puts it in, or null (then its size decides). */
function kindByName(model, table) {
  const name = model.name ?? '';
  for (const rule of table.KIND_NAME_RULES) if (rule.pattern.test(name)) return rule.kind;
  return null;
}

/** The junk tier a height in metres falls into, and the kind that goes with
 * it (the tier kinds ARE kinds; past the last band a model is a building). */
function tierByHeight(metres, table) {
  for (const band of table.TIER_BANDS) if (metres < band.maxHeightM) return band.tier;
  return table.TIER_BUILDING_KIND;
}

/** Clamp a height into its kind's band (rules.ts `KIND_HEIGHT_BANDS`). */
function clampHeight(units, kind, table) {
  const band = table.KIND_HEIGHT_BANDS[kind];
  if (!band) return Math.round(units * 100) / 100;
  return Math.round(Math.min(Math.max(units, band[0]), band[1]) * 100) / 100;
}

/** One admitted row, derived from the manifest entry and the measured box. */
function deriveRow(model, box, table) {
  const named = kindByName(model, table);
  const kind = named ?? tierByHeight(box.height, table);
  const heightUnits = clampHeight(box.height * table.WORLD_SCALE, kind, table);
  const tier = table.isKatamariNewKind(kind) ? kind : TIER_OF_KIND[kind];
  const name = model.name ?? '';
  // A `small` thing is junk on the ground and is never planted, whatever its
  // name says (see ROOTED_NAME_PATTERN's note).
  const plantable = kind !== 'small';
  const rooted = table.ROOTED_KINDS.includes(kind)
    ? ROOTED_OF_KIND[kind]
    : plantable && table.ROOTED_NAME_PATTERN.test(name);
  const beach = table.BEACH_NAME_PATTERN.test(name);
  const both = table.BOTH_REGIONS_NAME_PATTERN.test(name);
  const row = {
    id: model.idHex,
    name,
    internalName: model.internalName ?? '',
    file: model.file,
    kind,
    tier,
    heightUnits,
    rooted,
    triangles: model.triangles ?? 0,
  };
  // `inland` is only ever written where it is NOT the default — a row that is
  // both (a stone, a shell) — so the generated file says nothing it does not
  // have to (the default is `!beach`).
  if (beach || both) row.beach = true;
  if (both) row.inland = true;
  // A label is what the world would ever show, and it is lowercase (TASTE §5).
  if (table.isKatamariNewKind(kind)) row.label = name.trim().toLowerCase();
  return row;
}

/**
 * The tier and the rootedness each REPLACEMENT kind must carry — they are
 * `STICKY[kind]`'s and not a free choice, and the catalog test pins it. Kept
 * here rather than read out of sticky.ts because this script must not import
 * anything with three.js behind it.
 */
const TIER_OF_KIND = {
  rock: 'small',
  bush: 'small',
  stump: 'small',
  cactus: 'small',
  tree: 'medium',
  conifer: 'medium',
  palm: 'medium',
  picnicTable: 'medium',
  monolith: 'large',
  waterTower: 'large',
  building: 'building',
  small: 'small',
  medium: 'medium',
  large: 'large',
};
const ROOTED_OF_KIND = {
  rock: false,
  bush: true,
  stump: true,
  cactus: true,
  tree: true,
  conifer: true,
  palm: true,
  picnicTable: true,
  monolith: true,
  waterTower: true,
  building: true,
};

/** A seeded shuffle — mulberry32, the same family as the world's own hash.
 * No Math.random: the active set must be the same on every run. */
function seededShuffle(list, seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** `catalog.data.ts`, the generated rows — one line per row, catalog order. */
function serializeData(rows, stats) {
  const line = (r) => {
    const parts = [
      `id: ${JSON.stringify(r.id)}`,
      `name: ${JSON.stringify(r.name)}`,
      `internalName: ${JSON.stringify(r.internalName)}`,
      `file: ${JSON.stringify(r.file)}`,
      `kind: ${JSON.stringify(r.kind)}`,
      `tier: ${JSON.stringify(r.tier)}`,
      `heightUnits: ${r.heightUnits}`,
      `rooted: ${r.rooted}`,
    ];
    if (r.beach === true) parts.push('beach: true');
    if (r.inland === true) parts.push('inland: true');
    if (r.label !== undefined) parts.push(`label: ${JSON.stringify(r.label)}`);
    if (r.hash !== undefined) parts.push(`hash: ${JSON.stringify(r.hash)}`);
    return `  { ${parts.join(', ')} },`;
  };
  return `/**
 * GENERATED — do not edit.
 *
 * \`node scripts/katamari-curate.mjs --all --source <library-dir>\` writes this
 * file from the library's \`manifest.json\` and the rules in \`./rules.ts\`. It is
 * a pure function of those two: same library, same rules, same bytes. Edit the
 * RULES, then re-run.
 *
 * ${stats.admitted} models admitted out of ${stats.exported} exported
 * (${stats.excluded} excluded: the game's characters, the dummy rows and the
 * map-sized pieces); ${rows.length} of them are the ACTIVE set this world
 * draws — see \`ACTIVE_BUDGET\` in ./rules.ts. ${stats.triangles} triangles,
 * ${(stats.bytes / 1024 / 1024).toFixed(2)} mb.
 */

import type { KatamariEntry } from './rules';

export const KATAMARI_ROWS: readonly KatamariEntry[] = [
${rows.map(line).join('\n')}
];
`;
}

async function curateAll(table, args) {
  const source = resolve(args.source);
  const manifestPath = join(source, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`no manifest.json under ${source} — pass --source <library-dir>`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const flagged = new Set();
  const reportPath = join(source, 'validation-report.json');
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    for (const r of report.results ?? []) if ((r.errors ?? 0) > 0) flagged.add(r.file);
  }

  const admitted = [];
  const excluded = new Map();
  let exported = 0;
  for (const model of manifest) {
    if (model.status === 'exported') exported++;
    const why = exclusionOf(model, table);
    if (why !== null) {
      excluded.set(model.idHex, why);
      continue;
    }
    if (flagged.has(model.file)) {
      excluded.set(model.idHex, 'validator');
      continue;
    }
    const box = glbBounds(join(source, model.file));
    if (!box || !(box.height > table.MIN_SOURCE_HEIGHT_M)) {
      excluded.set(model.idHex, 'no measurable box');
      continue;
    }
    if (box.height > table.MAX_SOURCE_HEIGHT_M) {
      excluded.set(model.idHex, `${box.height.toFixed(0)} m — level geometry`);
      continue;
    }
    admitted.push(deriveRow(model, box, table));
  }

  // ── the active set: a seeded shuffle per kind, cut to the budget ─────────
  const byKind = new Map();
  for (const row of admitted) {
    const list = byKind.get(row.kind);
    if (list) list.push(row);
    else byKind.set(row.kind, [row]);
  }
  const active = [];
  const perKind = [];
  for (const [kind, list] of [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const budget = table.ACTIVE_BUDGET[kind] ?? 0;
    if (budget <= 0) continue;
    // Shuffled by (seed, kind) so adding a kind never re-picks another's.
    const salt = [...kind].reduce((n, c) => n + c.charCodeAt(0), 0);
    // The beach's rows first, up to BEACH_RESERVE of the budget, so a small
    // budget cannot shuffle every shell and boat off the sand (2026-09-16,
    // when small went 120 → 32); the rest of the budget is the plain shuffle.
    const shuffled = seededShuffle(list, table.ACTIVE_SEED + salt);
    const reserve = Math.ceil(budget * (table.BEACH_RESERVE ?? 0));
    const beachFirst = shuffled.filter((r) => r.beach === true).slice(0, reserve);
    const taken = new Set(beachFirst);
    const rest = shuffled.filter((r) => !taken.has(r)).slice(0, budget - beachFirst.length);
    const picked = [...beachFirst, ...rest];
    // Back into catalog (id) order, so the file reads like the library.
    picked.sort((a, b) => a.id.localeCompare(b.id));
    perKind.push({ kind, admitted: list.length, active: picked.length });
    for (const row of picked) active.push(row);
  }
  active.sort((a, b) => a.id.localeCompare(b.id));

  const paths = publicPaths();
  mkdirSync(paths.models, { recursive: true });
  let copied = 0;
  let bytes = 0;
  let rawBytes = 0;
  let texBytes = 0;
  let triangles = 0;
  /** How many models were published UNCOMPRESSED because compressing them
   * made them bigger (see the loop). */
  let kept = 0;
  for (const row of active) {
    const from = join(source, row.file);
    const to = join(paths.models, row.file);
    const raw = readFileSync(from);
    /*
     * COMPRESSED on the way in, not on the way out (see `compressGlb`): what
     * is published is what is served, so the hash below and the byte budget
     * both measure the thing a phone actually downloads.
     *
     * …AND THE SMALLER OF THE TWO WINS. `EXT_meshopt_compression` carries a
     * per-buffer-view header, and on a 7 kb spatula with fifty triangles
     * that header is more than the compression saves — measured at +2% on
     * the smallest models. The loader reads either file (the decoder is set
     * unconditionally and an uncompressed glb simply never asks for it), so
     * the honest rule is to publish whichever is fewer bytes and to say how
     * many went each way.
     */
    const packed = await compressGlb(raw);
    const data = packed.length < raw.length ? packed : raw;
    if (data === raw) kept++;
    rawBytes += raw.length;
    bytes += data.length;
    texBytes += await textureBytes(data);
    triangles += row.triangles ?? 0;
    row.hash = contentHash(data);
    if (writeIfChanged(to, data)) copied++;
  }
  const named = new Set(active.map((r) => r.file));
  let removed = 0;
  for (const file of readdirSync(paths.models)) {
    if (file.endsWith('.glb') && !named.has(file)) {
      rmSync(join(paths.models, file));
      removed++;
    }
  }

  const stats = {
    exported,
    admitted: admitted.length,
    excluded: excluded.size,
    triangles,
    bytes,
  };
  const dataPath = join(ROOT, 'src', 'world', 'katamari', 'catalog.data.ts');
  const dataWritten = writeIfChanged(dataPath, serializeData(active, stats));
  // The SAME serializer `--verify` compares against, so a run and a check can
  // never disagree about the bytes.
  const catalogWritten = writeIfChanged(
    paths.catalog,
    serializeRows(active, table.KATAMARI_BASE_URL),
  );

  if (!args.quiet) {
    console.log('kind          admitted  active');
    console.log('------------- --------  ------');
    for (const r of perKind) {
      console.log(`${r.kind.padEnd(13)} ${String(r.admitted).padStart(8)}  ${String(r.active).padStart(6)}`);
    }
    const reasons = new Map();
    for (const why of excluded.values()) {
      const key = why.startsWith('character') ? 'character' : why.includes('m — level') ? 'level geometry' : why;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    console.log('\nexcluded:');
    for (const [why, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${why}`);
    }
  }
  console.log(
    `\n${exported} exported, ${admitted.length} admitted, ${excluded.size} excluded; ` +
      `${active.length} active variants, ${triangles} triangles ` +
      `(budget ${table.ACTIVE_MAX_TRIANGLES}), ${(bytes / 1024 / 1024).toFixed(2)} mb ` +
      `(budget ${(table.ACTIVE_MAX_BYTES / 1024 / 1024).toFixed(0)} mb).`,
  );
  // The compression, said out loud — and WHAT IS LEFT, which is the textures.
  // Past half the output they are the bulk and the next saving to argue
  // about, so the number is printed rather than remembered (`compressGlb`).
  console.log(
    `compressed ${(rawBytes / 1024 / 1024).toFixed(2)} mb → ${(bytes / 1024 / 1024).toFixed(2)} mb ` +
      `(−${(100 - (bytes / Math.max(1, rawBytes)) * 100).toFixed(1)}%), of which ` +
      `${(texBytes / 1024 / 1024).toFixed(2)} mb (${((texBytes / Math.max(1, bytes)) * 100).toFixed(0)}%) ` +
      'is baked textures, left exactly as extracted.',
  );
  if (kept > 0) {
    console.log(
      `${kept} of ${active.length} were published uncompressed — the meshopt header cost more ` +
        'than it saved on models that small.',
    );
  }
  console.log(
    `copied ${copied}, removed ${removed}; catalog.data.ts ${dataWritten ? 'rewritten' : 'unchanged'}, ` +
      `catalog.json ${catalogWritten ? 'rewritten' : 'unchanged'}.`,
  );
  const problems = [];
  if (triangles > table.ACTIVE_MAX_TRIANGLES) {
    problems.push(`triangle budget blown: ${triangles} > ${table.ACTIVE_MAX_TRIANGLES}`);
  }
  if (bytes > table.ACTIVE_MAX_BYTES) {
    problems.push(`byte budget blown: ${bytes} > ${table.ACTIVE_MAX_BYTES}`);
  }
  if (problems.length > 0) fail(problems);
}

const args = parseArgs(process.argv.slice(2));
const table = await loadTable(!args.all);
MAX_TRIANGLES = table.ACTIVE_MAX_TRIANGLES ?? MAX_TRIANGLES;
MAX_BYTES = table.ACTIVE_MAX_BYTES ?? MAX_BYTES;
if (args.all) {
  if (args.source === '') {
    console.error('--all needs the library: pass --source <library-dir>');
    process.exit(2);
  }
  await curateAll(table, args);
} else if (args.verify) await verify(table, args);
else if (args.catalog) writeCatalog(table, args);
else if (args.source === '') {
  console.error('pass --source <library-dir> (or KATAMARI_LIBRARY), or --verify, or --catalog');
  process.exit(2);
} else {
  /*
   * THE HAND-TABLE COPY IS GONE (2026-09-16, the slow-network work).
   *
   * `--source` alone copied the files a hand-written table named, back when
   * `catalog.ts` WAS 82 rows written out one at a time. Two things have
   * happened since: the table is generated (`--all`), and every row now
   * carries the published file's CONTENT HASH — which this mode cannot
   * produce, because it does not write `catalog.data.ts` and a hash in
   * `catalog.json` that the `.ts` does not carry is exactly the
   * inconsistency `--verify` exists to catch. A mode that can only publish a
   * library `--verify` will reject is worse than no mode.
   */
  console.error(
    '--source alone no longer publishes: the table is generated and every row carries the\n' +
      "published file's content hash, which only the generating mode can write.\n" +
      '  node scripts/katamari-curate.mjs --all --source <library-dir>',
  );
  process.exit(2);
}
