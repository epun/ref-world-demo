#!/usr/bin/env node
/**
 * Pull a lost session out of Chrome's localStorage files.
 *
 * Recovery of last resort (user need, 2026-08-21: the projection was
 * refreshed mid-session, before the autosave existed on the build that was
 * running, and the population went with it).
 *
 * Chrome keeps localStorage in a LevelDB directory. Two properties make this
 * work:
 *
 *   1. A deleted key is TOMBSTONED, not erased — the old value stays in the
 *      `.log` and `.ldb` blocks until a compaction rewrites them. So a record
 *      that page code deleted is often still on disk.
 *   2. Everything we want is json with a distinctive head. We do not need to
 *      understand LevelDB's block format at all: scan the bytes for the
 *      opening brace of a record we recognise and brace-match forward.
 *
 * Chrome stores a string value either as latin-1 (one byte per char, tag
 * 0x01) or as UTF-16LE (two bytes per char, tag 0x00) depending on whether it
 * is all-ASCII. Stroke json is all-ASCII in practice, but names are not
 * guaranteed to be, so both encodings are scanned.
 *
 * What it finds:
 *
 *   - `refworld:submission:<room>` records — `{id, name, strokes, ts, epoch}`,
 *     one per handset. THE drawings. This is the copy that matters.
 *   - `refworld:session:<epoch>` logs — a whole session log, if the autosave
 *     was running.
 *
 * What it writes: a session log json the world can load directly through the
 * ghost panel's `restore from a log file`. The pipeline is pure in
 * (strokes, id), so restoring it rebuilds the IDENTICAL creatures — this
 * recovers the real population, not an approximation of it.
 *
 * Usage:
 *
 *   # quit chrome first — it holds an exclusive lock and buffers writes
 *   node scripts/recover-from-chrome.mjs "~/Library/Application Support/Google/Chrome/Profile 2/Local Storage/leveldb"
 *
 * Reads only. It never writes into the Chrome directory.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const SESSION_SCHEMA = 'refworld.session';
const SESSION_SCHEMA_VERSION = 1;

/** Defaults matching src/main.ts, so a restored log runs the same world. */
const DEFAULT_HATCH_MS = 20000;
const DEFAULT_MAX_POPULATION = 24;

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error(`
usage: node scripts/recover-from-chrome.mjs <leveldb-dir> [--out session.json]

  <leveldb-dir>   chrome's "Local Storage/leveldb" folder. quit chrome first.
  --out FILE      where to write the recovered session log
                  (default: recovered-session.json in the cwd)
  --room CODE     room code for the log header (default: read from the records)

then, on the projection: shift+d -> session -> "restore from a log file".
`);
  process.exit(message ? 1 : 0);
}

/** `~` is the shell's, not node's — expand it so a pasted path just works. */
function expand(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * The longest record we will try to brace-match. A drawing's stroke json runs
 * to tens of kilobytes; a whole session log to a few megabytes. Past this a
 * candidate is binary noise that happened to contain the head, and scanning
 * on costs more than the record could ever be worth.
 */
const MAX_RECORD_CHARS = 4_000_000;

/**
 * Every complete json object in `text` beginning with `head`.
 *
 * `head` includes its opening brace — `{"id":"`, not `"id":` — and that is
 * load-bearing for speed, not just tidiness. Searching for a bare key means
 * every incidental occurrence in binary data starts a brace-match that runs
 * to the cap before failing, and across twenty leveldb files that is minutes
 * of scanning. Both records we want serialise with a known first key
 * (`JSON.stringify` preserves insertion order), so anchoring on the brace
 * makes a false start nearly impossible and each real one O(record).
 *
 * Brace-matched with string awareness, so a `}` inside a name does not
 * truncate a record.
 */
function carveObjects(text, head) {
  const found = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(head, from);
    if (start === -1) break;
    from = start + 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        if (inString) escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          found.push(text.slice(start, i + 1));
          from = i;
          break;
        }
      }
      // A record that runs past the end of its block is truncated garbage;
      // give up on it rather than scanning the whole file for a brace that
      // is not there.
      if (i - start > MAX_RECORD_CHARS) break;
    }
  }
  return found;
}

/** Both of Chrome's string encodings, as one searchable latin-1 string. */
function readable(buffer) {
  const latin1 = buffer.toString('latin1');
  // UTF-16LE with an ascii payload is the same bytes with a NUL after each.
  // Dropping every second byte recovers it; misaligned reads produce noise
  // that simply will not match the heads we look for.
  const utf16 = [];
  for (let offset = 0; offset < 2; offset++) {
    const out = Buffer.allocUnsafe(Math.max(0, buffer.length - offset));
    let n = 0;
    for (let i = offset; i + 1 < buffer.length; i += 2) {
      // A pair that is not `<ascii> 00` is not utf-16 text. Write a break
      // rather than resetting: the run BEFORE it is still a real record, and
      // discarding the accumulator loses every record that has binary after
      // it — which, in a leveldb block, is all of them but the last.
      out[n++] = buffer[i + 1] === 0 ? buffer[i] : 0x0a;
    }
    utf16.push(out.subarray(0, n).toString('latin1'));
  }
  return [latin1, ...utf16];
}

function isSubmission(rec) {
  return (
    rec &&
    typeof rec === 'object' &&
    typeof rec.id === 'string' &&
    rec.id.length > 0 &&
    Array.isArray(rec.strokes) &&
    rec.strokes.length > 0 &&
    rec.strokes.every((s) => s && Array.isArray(s.pts))
  );
}

function isSessionLog(rec) {
  return (
    rec &&
    typeof rec === 'object' &&
    rec.schema === SESSION_SCHEMA &&
    Array.isArray(rec.events)
  );
}

/** Their width unit → fraction of canvas. Mirrors src/net/drawFeed.ts. */
const WIDTH_REFERENCE_PX = 320;
const DEFAULT_FEED_WIDTH = 6;
const MIN_W = 0.012;
const MAX_W = 0.12;

/**
 * Kit wire strokes → the pure StrokeList a session log carries. The same
 * conversion `feedStrokeToStroke` does, duplicated here on purpose: this
 * script must run standalone on a machine that has the Chrome profile, with
 * no build step and no import of the app.
 */
function wireToStrokes(wire) {
  const out = [];
  for (const s of wire) {
    if (!Array.isArray(s?.pts) || s.pts.length === 0) continue;
    const pts = [];
    for (const p of s.pts) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const [x, y] = p;
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), 1]);
    }
    if (pts.length === 0) continue;
    const w = (typeof s.width === 'number' ? s.width : DEFAULT_FEED_WIDTH) / WIDTH_REFERENCE_PX;
    out.push({ pts, w: Math.min(MAX_W, Math.max(MIN_W, w)) });
  }
  return out;
}

/** One `drawing` event, as if the gate had admitted it. */
function drawingEvent(sub, t) {
  return {
    t,
    k: 'drawing',
    id: sub.id,
    name: typeof sub.name === 'string' && sub.name.length > 0 ? sub.name : null,
    personality: null,
    source: 'phone',
    strokes: wireToStrokes(sub.strokes),
    hatchMs: DEFAULT_HATCH_MS,
    disposition: 'admitted',
    verdict: 'allow',
    reason: null,
    confidence: 1,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) usage();

  let dir = null;
  let out = 'recovered-session.json';
  let room = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') out = argv[++i] ?? out;
    else if (arg === '--room') room = argv[++i] ?? null;
    else if (!dir) dir = arg;
  }
  if (!dir) usage('no leveldb directory given.');
  dir = resolve(expand(dir));

  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    usage(`cannot read ${dir}\n${err.message}`);
    return;
  }
  if (entries.some((f) => f === 'LOCK') && entries.includes('LOG')) {
    // Not fatal — we only read — but a running Chrome may not have flushed.
    console.error('note: this looks like a live profile. quit chrome for the best chance.');
  }

  const submissions = new Map(); // id → newest record
  const logs = [];
  let scanned = 0;

  for (const file of entries.sort()) {
    const path = join(dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      continue;
    }
    scanned++;
    // Twenty leveldb files, three decodings each, and no output for minutes
    // reads as a hang. Say what is happening.
    process.stderr.write(
      `  ${file} (${(stat.size / 1024).toFixed(0)}kb) — ` +
        `${submissions.size} drawing${submissions.size === 1 ? '' : 's'} so far\n`,
    );

    for (const text of readable(buffer)) {
      // `{"id":"` — the draw page and writeSubmission both build the record
      // with `id` first, so the brace is right there.
      for (const raw of carveObjects(text, '{"id":"')) {
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!isSubmission(rec)) continue;
        const prev = submissions.get(rec.id);
        // Newest wins: a handset that redrew has two records on disk.
        if (!prev || (rec.ts ?? 0) >= (prev.ts ?? 0)) submissions.set(rec.id, rec);
      }
      for (const raw of carveObjects(text, `{"schema":"${SESSION_SCHEMA}"`)) {
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          continue;
        }
        if (isSessionLog(rec)) logs.push(rec);
      }
    }
  }

  console.log(`scanned ${scanned} file${scanned === 1 ? '' : 's'} in ${dir}`);
  console.log(`found ${submissions.size} drawing${submissions.size === 1 ? '' : 's'}`);
  console.log(`found ${logs.length} session log${logs.length === 1 ? '' : 's'}`);

  // A whole autosaved log beats reassembled drawings — it carries the names,
  // the hatch state and the operator decisions. Fullest wins.
  const bestLog = logs.sort((a, b) => b.events.length - a.events.length)[0];
  if (bestLog && bestLog.events.length > 0) {
    writeFileSync(out, JSON.stringify(bestLog));
    console.log(
      `\nwrote ${out} — a full session log, epoch ${bestLog.epoch}, ` +
        `${bestLog.events.length} events.`,
    );
    console.log('load it: shift+d -> session -> "restore from a log file".');
    return;
  }

  if (submissions.size === 0) {
    console.log('\nnothing recoverable in this folder.');
    console.log('try the other chrome profiles, and check that chrome is quit.');
    process.exitCode = 1;
    return;
  }

  // No log — rebuild one from the drawings. Ordered by when each handset
  // sent, so the spawn spiral lays them out in roughly the original order.
  const ordered = [...submissions.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const first = ordered[0]?.ts ?? 0;
  const events = [];
  for (const sub of ordered) {
    const t = Math.max(0, (sub.ts ?? first) - first);
    const drawing = drawingEvent(sub, t);
    if (drawing.strokes.length === 0) continue;
    events.push(drawing);
    // Hatched, not left as eggs: these creatures already lived once.
    events.push({ t: t + 1, k: 'hatch', id: sub.id, cause: 'forced' });
  }

  const epochs = ordered.map((s) => s.epoch).filter((e) => typeof e === 'string' && e);
  const log = {
    schema: SESSION_SCHEMA,
    version: SESSION_SCHEMA_VERSION,
    epoch: epochs[0] ?? 'recovered',
    room: room ?? '',
    startedAt: new Date(first || Date.now()).toISOString(),
    config: {
      hatchMs: DEFAULT_HATCH_MS,
      maxPopulation: DEFAULT_MAX_POPULATION,
      recovered: true,
    },
    events,
  };
  writeFileSync(out, JSON.stringify(log));
  console.log(
    `\nwrote ${out} — ${events.length / 2} creature${events.length === 2 ? '' : 's'} ` +
      'rebuilt from the handset records.',
  );
  console.log('load it: shift+d -> session -> "restore from a log file".');
}

main();
