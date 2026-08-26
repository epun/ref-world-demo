/**
 * Is the public world's store actually connected?
 *
 * `scripts/api-smoke/smoke.mjs` proves the handlers are correct against a
 * stand-in. This proves the DEPLOYMENT has somewhere to write — which is a
 * different question, and the one that decides whether a drawing made on a
 * phone still exists tomorrow.
 *
 *   node scripts/api-smoke/live.mjs https://ref-world-demo.vercel.app [world]
 *
 * Set MODERATOR_SECRET in the environment to check the moderation gate too.
 * It writes ONE probe drawing under a device id it makes up, then refuses
 * it again through the moderation endpoint if it can, so the world is left
 * as it was found. Without the secret the probe is left admitted and the
 * script says so rather than pretending it cleaned up.
 */
const base = (process.argv[2] ?? 'https://ref-world-demo.vercel.app').replace(/\/$/, '');
const world = process.argv[3] ?? 'public';
const secret = process.env['MODERATOR_SECRET'] ?? '';

/**
 * Read a body as json, or say what actually came back.
 *
 * A proxy, a login wall or a platform error page answers 200 with html,
 * and `await res.json()` on that throws a parse error three frames deep in
 * undici — which reads like a bug in this script rather than "something
 * else answered". Anything that is not json is reported as what it is.
 */
async function readJson(res, what) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.log(`  ${bad('FAIL')}  ${what} did not return json`);
    console.log(`         status ${res.status}, body starts: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    console.log('\n  Something other than the api answered — a proxy, a login wall, or the wrong url.\n');
    process.exit(1);
  }
}

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
let failed = false;
const check = (pass, label, detail = '') => {
  if (!pass) failed = true;
  console.log(`  ${pass ? ok('PASS') : bad('FAIL')}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const url = `${base}/api/drawings?world=${encodeURIComponent(world)}`;
console.log(`\n${base}  ·  world "${world}"\n`);

// ── 1. can we read, and is there a store behind it ──────────────────────
const first = await fetch(url, { cache: 'no-store' });
check(first.ok, 'GET /api/drawings answers', `status ${first.status}`);
const log = await readJson(first, 'GET /api/drawings');
const store = log?.config?.store;
check(store === 'live', 'a store is configured', `config.store = ${store ?? 'absent'}`);
if (store !== 'live') {
  console.log(`\n  ${bad('No store.')} Every drawing made on a phone is being dropped.`);
  console.log('  Vercel → Storage → connect Upstash Redis to this project, then redeploy.\n');
  process.exit(1);
}
const before = (log.events ?? []).filter((e) => e.k === 'drawing').length;
console.log(`  ${before} drawing(s) currently stored`);

// ── 2. can a phone actually write ───────────────────────────────────────
const id = `probe-${Date.now().toString(36)}`;
const probe = {
  id,
  name: 'probe',
  strokes: [{ w: 0.02, pts: [[0.3, 0.3, 1], [0.7, 0.3, 1], [0.7, 0.7, 1], [0.3, 0.7, 1], [0.3, 0.3, 1]] }],
};
const post = await fetch(`${base}/api/drawings?world=${encodeURIComponent(world)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(probe),
});
check(post.status !== 503, 'POST is not refused for want of a store', `status ${post.status}`);
check(post.ok, 'POST accepted a drawing', `status ${post.status}`);

// ── 3. did it survive the round trip ────────────────────────────────────
await new Promise((r) => setTimeout(r, 1500));  // the GET is cached for 10s
const after = await fetch(`${url}&t=${Date.now()}`, { cache: 'no-store' });
const log2 = await readJson(after, 'the second GET');
const found = (log2.events ?? []).some((e) => e.k === 'drawing' && e.id === id);
check(found, 'the drawing is there when you ask again', found ? '' : 'it did not persist');

// ── 4. one device, one creature ─────────────────────────────────────────
const again = await fetch(`${base}/api/drawings?world=${encodeURIComponent(world)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(probe),
});
check(again.status === 409, 'a second drawing from the same device is refused', `status ${again.status}`);

// ── 5. the moderation gate ──────────────────────────────────────────────
if (secret) {
  const noSecret = await fetch(`${base}/api/moderate?world=${encodeURIComponent(world)}`);
  check(noSecret.status === 404, 'moderation is invisible without the secret', `status ${noSecret.status}`);
  const withSecret = await fetch(`${base}/api/moderate?world=${encodeURIComponent(world)}`, {
    headers: { 'x-moderator': secret },
  });
  check(withSecret.ok, 'moderation opens with the secret', `status ${withSecret.status}`);
  const refuse = await fetch(`${base}/api/moderate?world=${encodeURIComponent(world)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-moderator': secret },
    body: JSON.stringify({ id, disposition: 'refused' }),
  });
  check(refuse.ok, 'the probe drawing was cleaned up', `status ${refuse.status}`);
} else {
  console.log(`  ${bad('SKIP')}  moderation gate — set MODERATOR_SECRET to check it`);
  console.log(`  ${bad('NOTE')}  the probe "${id}" is still admitted in "${world}" — refuse it in /moderate/`);
}

console.log(failed ? `\n${bad('something is not connected')}\n` : `\n${ok('the store is live')}\n`);
process.exit(failed ? 1 : 0);
