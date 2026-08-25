#!/usr/bin/env node
/**
 * Put an existing population into a public world.
 *
 * A brand new public world is an empty field, and an empty field is a bad
 * invitation: the first person to arrive has nothing to join. Seeding it
 * with the recovered room means whoever opens the link sees a world that is
 * already alive and adds themselves to it, which is the actual proposition.
 *
 * It posts through the ORDINARY submission endpoint — no privileged path,
 * no direct store access. So the seeded drawings go through the same
 * screen, take the same dispositions, and claim device slots under their
 * own ids exactly as a handset's would. If seeding could bypass the gate,
 * the gate would have a hole in it shaped like this script.
 *
 * Idempotent: a drawing whose id is already claimed comes back 409 and is
 * counted as already-there rather than retried. Run it twice and nothing
 * doubles.
 *
 * Usage:
 *   node scripts/seed-world.mjs <base-url> [world] [log.json]
 *
 *   node scripts/seed-world.mjs https://ref-world-demo.vercel.app public
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const world = process.argv[3] ?? 'public';
const logPath = process.argv[4] ?? 'public/recovered/session.json';

if (!base) {
  console.error(`usage: node scripts/seed-world.mjs <base-url> [world] [log.json]

  node scripts/seed-world.mjs https://ref-world-demo.vercel.app public
`);
  process.exit(1);
}

/** Their width unit, mirrored from src/net/drawFeed.ts. */
const WIDTH_REFERENCE_PX = 320;

/**
 * Pure StrokeList → the kit's wire shape the endpoint takes.
 *
 * The log stores what the pipeline consumes (`{pts: [x, y, widthScale][],
 * w}`); the api takes what a handset publishes (`{pts: [[x, y]], width}`).
 * Converting here rather than adding a second accepted shape to the
 * endpoint keeps exactly one wire format on the server.
 */
function toWire(strokes) {
  return strokes
    .map((s) => ({
      color: '#111111',
      width: Math.max(1, Math.round((s.w ?? 0.022) * WIDTH_REFERENCE_PX)),
      pts: (s.pts ?? []).map((p) => [p[0], p[1]]),
    }))
    .filter((s) => s.pts.length > 0);
}

const log = JSON.parse(readFileSync(resolve(logPath), 'utf8'));
const drawings = (log.events ?? []).filter((e) => e.k === 'drawing');
if (drawings.length === 0) {
  console.error(`no drawings in ${logPath}`);
  process.exit(1);
}

console.log(`seeding ${drawings.length} creatures into "${world}" at ${base}`);

let added = 0;
let already = 0;
let failed = 0;

for (const [n, d] of drawings.entries()) {
  const strokes = toWire(d.strokes ?? []);
  if (strokes.length === 0) {
    failed++;
    continue;
  }
  let res;
  try {
    res = await fetch(`${base}/api/drawings?world=${encodeURIComponent(world)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: d.id, name: d.name ?? '', strokes }),
    });
  } catch (err) {
    console.error(`  ${d.id}: ${err instanceof Error ? err.message : 'request failed'}`);
    failed++;
    continue;
  }
  if (res.status === 201) added++;
  else if (res.status === 409) already++;
  else {
    const body = await res.text();
    console.error(`  ${d.id}: ${res.status} ${body.slice(0, 120)}`);
    failed++;
    // A 503 means no store: every subsequent post fails the same way, and
    // printing sixty-eight identical errors helps nobody.
    if (res.status === 503) {
      console.error('\nthe deployment has no store configured — nothing was seeded.');
      process.exit(1);
    }
  }
  if ((n + 1) % 10 === 0) console.log(`  ${n + 1}/${drawings.length}…`);
}

console.log(`\nadded ${added} · already there ${already} · failed ${failed}`);
if (failed > 0) process.exitCode = 1;
