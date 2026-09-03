#!/usr/bin/env node
/**
 * Give a world an address of its own.
 *
 * A named world has always existed — `/?world=meridian` reaches it, and has
 * since the store went in. What it did not have was a PLACE: the link you
 * send a client is the one index.html with a setting stuck on the end of
 * it, and the card it unfurls into says "ref world", because that card is
 * hardcoded into the only page there is.
 *
 * So a world gets a page. `worlds/<name>/index.html` is a sibling of
 * index.html that loads the same app from the same absolute paths and
 * differs in exactly two ways: it declares its world in a meta tag instead
 * of a query string, and it carries its own open-graph tags. Nothing about
 * the world moves — same derived room, same store, same drawings as
 * `/?world=<name>` — only the address does.
 *
 * That is why this is a script and not a folder somebody copies. The page
 * is a template with one hole in it; the next client should be one command,
 * not a copy-paste that quietly keeps the previous client's og:url. The
 * committed worlds/meridian/index.html is this script's own output, run
 * once and left alone.
 *
 * vite picks the page up on its own (every worlds/<name>/index.html is a
 * rollup input — see vite.config.ts), so nothing else needs editing.
 *
 * Usage:
 *   node scripts/new-world.mjs <name> [--force] [--out <dir>]
 *
 *   node scripts/new-world.mjs meridian
 *
 *   --force   overwrite a page that already exists
 *   --out     write under <dir> instead of the repo's worlds/ (tests use it)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** where the deployment lives; the card's urls have to be absolute. */
const SITE = 'https://ref-world-demo.vercel.app';

/**
 * The same rule the app and the api sanitise with (docs/PUBLIC.md §urls):
 * lowercase letters, digits and hyphens, up to 24 characters. A name that
 * would be altered on the way in is refused here rather than silently
 * turned into a different world than the one that was asked for.
 */
const NAME_RULE = /^[a-z0-9-]{1,24}$/;

/**
 * The page, with one hole in it.
 *
 * Absolute script paths (`/vendor/…`, `/src/main.ts`) because this file
 * lives one folder down: relative ones would resolve to
 * /worlds/<name>/src/main.ts in dev and break the build's rewrite too.
 */
export function worldPage(name) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ref world · ${name}</title>
    <!--
      A PAGE OF ITS OWN, for the world named "${name}".

      Written by scripts/new-world.mjs — do not hand-edit; re-run the script.

      This is index.html with two changes and no others: the world is
      declared below in a meta tag instead of read from a query string, and
      the card is this world's rather than the public one's. Everything
      after that is the same app, loaded from the same absolute paths.

      The world it names is the same world /?world=${name} reaches — same
      derived room, same store, same drawings. Only the address differs, and
      the address is the point: a client gets a link that is a place.
    -->
    <meta name="refworld:world" content="${name}" />
    <!--
      THE CARD a shared link unfurls into.

      The image is the public world's frame, reused deliberately: it is a
      real render of thirty creatures somebody drew, made by the same
      pipeline that will render this world's, so it is a true picture of
      what happens here rather than a mockup. Re-run scripts/og.mjs and it
      is the world as it is now.

      Lowercase throughout, like every other piece of type here (TASTE §5).
    -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ref world" />
    <meta property="og:title" content="${name}" />
    <meta
      property="og:description"
      content="a world for ${name}. draw a creature on your phone and it hatches somewhere everyone can see."
    />
    <meta property="og:url" content="${SITE}/worlds/${name}/" />
    <meta property="og:image" content="${SITE}/og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="a grey field with thirty small black creatures standing on it" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${name}" />
    <meta
      name="twitter:description"
      content="a world for ${name}. draw a creature on your phone and it hatches somewhere everyone can see."
    />
    <meta name="twitter:image" content="${SITE}/og.png" />
    <!-- inline ink-blob favicon (qa audit p1): a loose hand-drawn dot in the environment ink value, no binary asset -->
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12.3 4.6c3.9.2 6.9 3.4 7 7.3.1 4.1-3 7.6-7.1 7.7-4 .1-7.4-3-7.5-7.1-.1-4.2 3.4-8.1 7.6-7.9z' fill='%23353534'/></svg>" />
    <style>
      /* background matches SURFACE.ground (src/taste/tokens.ts) so there is no flash before first paint */
      html,
      body {
        margin: 0;
        height: 100%;
        overflow: hidden;
        background: #dfdfdf;
      }
      #world {
        display: block;
        width: 100vw;
        height: 100vh;
      }
    </style>
  </head>
  <body>
    <canvas id="world"></canvas>
    <!-- vendored MQTT client for the draw-to-3d feed; sets window.mqtt -->
    <script src="/vendor/mqtt.min.js"></script>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

// ── cli ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { name: '', force: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--out') args.out = argv[++i] ?? '';
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.name) args.name = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

const USAGE = `usage: node scripts/new-world.mjs <name> [--force] [--out <dir>]

  node scripts/new-world.mjs meridian

a name is lowercase letters, digits and hyphens, up to 24 characters.
`;

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

  const here = dirname(fileURLToPath(import.meta.url));
  const worldsDir = args.out ? resolve(args.out) : resolve(here, '..', 'worlds');
  const dir = join(worldsDir, args.name);
  const page = join(dir, 'index.html');

  if (existsSync(page) && !args.force) {
    console.error(`${page} already exists — pass --force to overwrite it.`);
    return 1;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(page, worldPage(args.name), 'utf8');

  const url = `${SITE}/worlds/${args.name}/`;
  console.log(`wrote ${page}

  page    ${url}
  phone   ${url}   (the page sends a handset to the pad on its own)

seed it with an existing population:

  node scripts/seed-world.mjs ${SITE} ${args.name}
`);
  return 0;
}

// importable for tests; only the direct run touches the exit code.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(run(process.argv.slice(2)));
}
