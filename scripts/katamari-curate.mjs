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
 *   node scripts/katamari-curate.mjs --source <library-dir>
 *   node scripts/katamari-curate.mjs --verify
 *   node scripts/katamari-curate.mjs --catalog
 *
 *   --source   the unpacked library (the folder holding manifest.json and the
 *              .glb files). Also read from KATAMARI_LIBRARY.
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
 *   --quiet    totals only, no per-model table.
 *
 * IDEMPOTENT, in the strong sense: a file whose bytes already match is not
 * rewritten, `catalog.json` carries no timestamp and no counts read off the
 * library (so it is a pure function of the table), and a second run prints the
 * same table and changes nothing. `--verify` after a run must exit 0.
 *
 * NO DEPENDENCIES. Plain node, and the table is loaded straight from the `.ts`
 * file through node's own type stripping (node >= 22.6) — `catalog.ts` imports
 * nothing at runtime for exactly that reason.
 *
 * PROVENANCE. The library is a personal-use extraction from a retail copy of
 * *Katamari Damacy* (`SLUS-21008`); the assets remain Namco's. `valiocon` is a
 * private demo world. See public/katamari/README.md.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Budgets the pick is held to (the brief's own numbers). */
const MAX_TRIANGLES = 150_000;
const MAX_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const out = {
    source: process.env.KATAMARI_LIBRARY ?? '',
    verify: false,
    catalog: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') out.source = argv[++i] ?? '';
    else if (arg === '--verify') out.verify = true;
    else if (arg === '--catalog') out.catalog = true;
    else if (arg === '--quiet') out.quiet = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

async function loadTable() {
  const path = join(ROOT, 'src', 'world', 'katamari', 'catalog.ts');
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
 * `catalog.json`, as a pure function of the table: same key order every time,
 * no timestamp, nothing read off the library. That is what makes `--verify`
 * meaningful and the run idempotent.
 */
function serializeCatalog(table) {
  const models = table.KATAMARI_CATALOG.map((entry) => {
    const row = {
      id: entry.id,
      name: entry.name,
      file: entry.file,
      kind: entry.kind,
      tier: entry.tier,
      heightUnits: entry.heightUnits,
      rooted: entry.rooted,
    };
    if (entry.beach === true) row.beach = true;
    if (entry.inland === true) row.inland = true;
    if (entry.label !== undefined) row.label = entry.label;
    return row;
  });
  return `${JSON.stringify({ baseUrl: table.KATAMARI_BASE_URL, models }, null, 2)}\n`;
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
  return { base, models: join(base, 'models'), catalog: join(base, 'catalog.json') };
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
    if (!existsSync(path)) problems.push(`${entry.id}: ${entry.file} is not published`);
    else rows.push({ ...entry, bytes: readFileSync(path).length });
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
    if (!existsSync(path)) problems.push(`${entry.id}: ${entry.file} is not published`);
    else rows.push({ ...entry, bytes: readFileSync(path).length });
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

async function curate(table, args) {
  const source = resolve(args.source);
  const manifestPath = join(source, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`no manifest.json under ${source} — pass --source <library-dir>`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const byId = new Map(manifest.map((m) => [m.idHex, m]));

  // ── check the table against the library before copying anything ──────────
  const problems = [];
  const seen = new Set();
  const rows = [];
  for (const entry of table.KATAMARI_CATALOG) {
    if (seen.has(entry.id)) problems.push(`${entry.id}: named twice`);
    seen.add(entry.id);
    const model = byId.get(entry.id);
    if (model === undefined) {
      problems.push(`${entry.id}: no such object in the manifest`);
      continue;
    }
    if (model.status !== 'exported') {
      problems.push(`${entry.id}: manifest status is ${model.status}`);
      continue;
    }
    if (model.name !== entry.name) {
      problems.push(`${entry.id}: table says ${JSON.stringify(entry.name)}, library says ${JSON.stringify(model.name)}`);
    }
    if (model.file !== entry.file) {
      problems.push(`${entry.id}: table says ${entry.file}, library says ${model.file}`);
    }
    const from = join(source, model.file);
    if (!existsSync(from)) {
      problems.push(`${entry.id}: ${model.file} is in the manifest but not on disk`);
      continue;
    }
    rows.push({
      ...entry,
      triangles: model.triangles,
      parts: model.parts,
      bytes: readFileSync(from).length,
      from,
    });
  }
  if (problems.length > 0) fail(problems);

  // ── copy, then write the catalog ─────────────────────────────────────────
  const paths = publicPaths();
  mkdirSync(paths.models, { recursive: true });
  let copied = 0;
  for (const row of rows) {
    if (writeIfChanged(join(paths.models, row.file), readFileSync(row.from))) copied++;
  }
  // Anything published that the table no longer names would be dead weight in
  // the build; say so rather than deleting a file behind the operator's back.
  const named = new Set(rows.map((r) => r.file));
  const stale = readdirSync(paths.models).filter((f) => f.endsWith('.glb') && !named.has(f));
  const catalogWritten = writeIfChanged(paths.catalog, serializeCatalog(table));

  printTable(rows, args.quiet);
  console.log(
    `copied ${copied} model(s)${copied === 0 ? ' (everything was already current)' : ''}; ` +
      `catalog.json ${catalogWritten ? 'rewritten' : 'unchanged'}.`,
  );
  if (stale.length > 0) {
    console.log(`\n${stale.length} published model(s) the table no longer names — delete by hand:`);
    for (const f of stale) console.log(`  public/katamari/models/${f}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const table = await loadTable();
if (args.verify) await verify(table, args);
else if (args.catalog) writeCatalog(table, args);
else if (args.source === '') {
  console.error('pass --source <library-dir> (or KATAMARI_LIBRARY), or --verify, or --catalog');
  process.exit(2);
} else await curate(table, args);
