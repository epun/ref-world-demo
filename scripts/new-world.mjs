#!/usr/bin/env node
/**
 * Give a world a deployment of its own.
 *
 * A named world has always existed — `/?world=meridian` reaches it, and has
 * since the store went in. What it did not have was a PLACE. The link you
 * hand a client should be an address, not the public site with a setting
 * stuck on the end of it, and it should unfurl into a card with their name
 * on it rather than the public world's. Two clients should also not be able
 * to find each other by reading a url.
 *
 * So a client world is its own vercel deployment of this same repo, at its
 * own hostname (ref-world-meridian.vercel.app, a custom domain later). One
 * codebase, one store, many deployments; worlds.json gives each world its
 * hostname and its settings, and the build reads it
 * (scripts/world-build.mjs) to inject the world, its card and how it starts
 * into index.html. The public deployment is absent from the file and is not
 * touched by any of this.
 *
 * This script owns the part of that which is data: the worlds.json entry.
 * The rest is a vercel project, which is a thing you click, so it prints
 * the recipe instead of pretending to do it.
 *
 * Usage:
 *   node scripts/new-world.mjs <name> [--clean] [--host <hostname>] [--file <path>]
 *
 *   node scripts/new-world.mjs meridian --clean
 *
 *   --clean  open with no population at all. the public world's twenty-three
 *            residents are ITS exhibit; a client's world starts empty and
 *            fills only with what its own people draw.
 *   --host   the deployment's production hostname
 *            (default ref-world-<name>.vercel.app)
 *   --file   write a different worlds.json (tests use it)
 *
 * Idempotent: the same world twice changes nothing and says so.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHost, sanitizeResidents, sanitizeWorldName } from './world-build.mjs';

/**
 * The same rule the app and the api sanitise with (docs/PUBLIC.md §urls):
 * lowercase letters, digits and hyphens, up to 24 characters. A name that
 * would be altered on the way in is refused here rather than silently
 * becoming a different world than the one that was asked for.
 */
const NAME_RULE = /^[a-z0-9-]{1,24}$/;

function parseArgs(argv) {
  const args = { name: '', host: '', file: '', clean: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clean') args.clean = true;
    else if (a === '--host') args.host = argv[++i] ?? '';
    else if (a === '--file') args.file = argv[++i] ?? '';
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.name) args.name = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

const USAGE = `usage: node scripts/new-world.mjs <name> [--clean] [--host <hostname>] [--file <path>]

  node scripts/new-world.mjs meridian --clean

a name is lowercase letters, digits and hyphens, up to 24 characters.
`;

function recipe(name, host, residents) {
  return `next, the parts that are a dashboard rather than a file:

  1. make a vercel project named ref-world-${name}, linked to the same
     repo (epun/ref-world-demo) — in the dashboard, or \`vercel link\`
     in a checkout of this repo. its production url has to be ${host},
     or worlds.json will not recognise its builds.
  2. connect the SAME kv store integration to it, and set
     MODERATOR_SECRET in its environment (an env var name, so it keeps
     its shouting). one store, many deployments — worlds partition it,
     so ${name} cannot see another world's drawings.
  3. deploy it. the build reads worlds.json, sees ${host}, and bakes the
     world, its card and how it starts into index.html.
${
  residents === 'none'
    ? `  4. nothing to seed. this world opens empty on purpose and fills with
     what its own people draw. if that is ever wrong:

     node scripts/seed-world.mjs https://${host} ${name}
`
    : `  4. put a population in, so the first person to arrive has something
     to join:

     node scripts/seed-world.mjs https://${host} ${name}
`
}
look at it locally before any of that:

  VITE_WORLD=${name} npm run dev
`;
}

function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 1;
  }

  if (!args.name) {
    console.error(USAGE);
    return 1;
  }
  if (!NAME_RULE.test(args.name)) {
    console.error(
      `"${args.name}" is not a world name — lowercase letters, digits and hyphens, up to 24 characters.\n\n${USAGE}`,
    );
    return 1;
  }
  const name = sanitizeWorldName(args.name);
  const host = normalizeHost(args.host || `ref-world-${name}.vercel.app`);
  if (!host.includes('.')) {
    console.error(`"${args.host}" is not a hostname.`);
    return 1;
  }

  const residents = sanitizeResidents(args.clean ? 'none' : 'shipped');

  const here = dirname(fileURLToPath(import.meta.url));
  const file = args.file ? resolve(args.file) : resolve(here, '..', 'worlds.json');
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const worlds = doc.worlds ?? {};

  // a hostname belongs to exactly one world. pointing an existing
  // deployment at a different world renames somebody's live link, and this
  // script is not where that happens silently.
  const owner = Object.keys(worlds).find((w) => normalizeHost(worlds[w]?.host) === host);
  if (owner !== undefined && owner !== name) {
    console.error(`${host} is already the address of "${owner}" — pick another host.`);
    return 1;
  }

  const before = JSON.stringify(worlds[name] ?? null);
  worlds[name] = { host, residents };
  const known = before === JSON.stringify(worlds[name]);
  if (!known) {
    doc.worlds = Object.fromEntries(Object.entries(worlds).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }

  console.log(`${known ? `${name} is already in ${file}` : `wrote ${name} to ${file}`}

  world       ${name}
  link        https://${host}/
  residents   ${residents === 'none' ? 'none — it opens empty' : 'shipped — the recovered room stands in it'}

${recipe(name, host, residents)}`);
  return 0;
}

// importable for tests; only the direct run touches the exit code.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(run(process.argv.slice(2)));
}

export { run };
