/**
 * Which world is THIS build, and how does it start?
 *
 * A client's world is not a path on the public site — it is its own vercel
 * deployment of this same repo, at its own hostname
 * (ref-world-meridian.vercel.app, a custom domain later). One codebase, one
 * store, many deployments; the only things that differ between them are
 * which world the page shows, what its link unfurls into, and whether it
 * ships with a population.
 *
 * Those differences cannot be a runtime lookup, because the card is read by
 * crawlers that never run the app. So they are baked in at build time: the
 * deployment knows its own production hostname (vercel sets
 * VERCEL_PROJECT_PRODUCTION_URL in every build, preview and production
 * alike), worlds.json maps a world name to that hostname and its settings,
 * and the html is transformed on the way out.
 *
 * The public deployment is simply absent from the file, so it resolves to
 * nothing and its html comes out byte-identical to the file on disk. That
 * is the property worth protecting: adding a client must not be able to
 * change the main site, and a test pins it.
 *
 * Pure and dependency-free (one small fs read, everything else injected) so
 * every rule here can be tested without running a build — the whole point
 * of it not living inside vite.config.ts.
 */

import { existsSync, readFileSync } from 'node:fs';

/** the card image is the public world's frame, absolute so it loads anywhere. */
export const CARD_IMAGE = 'https://ref-world-demo.vercel.app/og.png';

/**
 * Does a world open with the shipped population standing in it?
 *
 * `shipped` is the public world: the creatures recovered from the
 * designers-and-machines room are its exhibit, and an empty field is a bad
 * landing for a link anyone can open. `none` is a client's world, which
 * starts clean and fills only with what its own people draw — somebody
 * else's twenty-three creatures are not a welcome there, they are clutter
 * with no story attached.
 */
export const RESIDENTS = ['shipped', 'none'];

/** unknown values mean the default, so a typo in the file cannot empty a world. */
export function sanitizeResidents(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'none' ? 'none' : 'shipped';
}

/**
 * Who opens the eggs in this world?
 *
 * `timer` is what a public link has always done: nobody is standing there,
 * so an egg that never hatched would be a person who drew something and got
 * nothing back. `manual` is a world with an OPERATOR in front of it — the
 * demo (user ask, 2026-09-10: *"in the demo let's pause the hatching until
 * I press h on the keyboard"*). Nothing hatches until somebody presses `h`,
 * and every screen in the room opens together when they do.
 */
export const HATCH_MODES = ['timer', 'manual'];

/**
 * Only the exact word pauses a world's hatching, for the same reason a typo
 * cannot empty one: the failure of a misread `manual` is a room of eggs that
 * never open and an operator with no idea why.
 */
export function sanitizeHatch(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'manual' ? 'manual' : 'timer';
}

/**
 * The same rule the app sanitises with (docs/PUBLIC.md §urls, and
 * sanitizeWorld in src/main.ts): lowercase letters, digits and hyphens, up
 * to 24 characters. Anything else is stripped rather than refused, so a
 * name can never arrive here in a form the app would read differently.
 */
export function sanitizeWorldName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 24);
}

/** a hostname, however it was written: with a scheme, a port, a trailing path. */
export function normalizeHost(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][\w+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/**
 * Read worlds.json into `{ <name>: { host, residents } }`, tolerating its
 * absence — a checkout without it still builds, as the public site.
 */
export function readWorlds(file) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const worlds = parsed?.worlds ?? {};
  return Object.fromEntries(
    Object.entries(worlds).map(([name, config]) => [
      sanitizeWorldName(name),
      {
        host: normalizeHost(config?.host),
        residents: sanitizeResidents(config?.residents),
        hatch: sanitizeHatch(config?.hatch),
        // Does this world's deployment keep the dev surface (the ghost panel
        // and everything behind __IS_DEV__)? Off unless the file says exactly
        // `true`: a client's world is a place people visit, not a workbench,
        // and only a world that is also its author's workbench opts in.
        dev: config?.dev === true,
      },
    ]),
  );
}

/**
 * The world this build is for, or null for the public deployment.
 *
 * `VITE_WORLD` wins so a world can be looked at locally
 * (`VITE_WORLD=meridian npm run dev`) before its deployment exists — and it
 * works for a name the file has never heard of, which then takes the
 * defaults. Otherwise the deployment's own production hostname is looked
 * up, which is why a preview build of a client project shows the client's
 * world too: previews carry the same production url.
 *
 * The host in the card is `VITE_SITE_URL` if set, else the production url,
 * else the hostname the file already gives this world, else the naming
 * convention. It only ever appears in og:url, and an og:url pointing at the
 * wrong host is worse than one pointing at the conventional one.
 */
export function resolveWorld(env = {}, worlds = {}) {
  const productionHost = normalizeHost(env.VERCEL_PROJECT_PRODUCTION_URL);
  const byHost = productionHost
    ? (Object.keys(worlds).find((name) => worlds[name].host === productionHost) ?? '')
    : '';
  const name = sanitizeWorldName(env.VITE_WORLD) || byHost;
  if (!name) return null;
  const configured = worlds[name];
  const host =
    normalizeHost(env.VITE_SITE_URL) ||
    productionHost ||
    configured?.host ||
    `ref-world-${name}.vercel.app`;
  return {
    name,
    host,
    residents: configured?.residents ?? 'shipped',
    hatch: configured?.hatch ?? 'timer',
    dev: configured?.dev === true,
  };
}

// ── the html transform ───────────────────────────────────────────────────────

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** rewrite one meta tag's content, leaving the tag's own formatting alone. */
function setMeta(html, attr, key, value) {
  const re = new RegExp(`(<meta\\s+${attr}="${key}"[^>]*?content=")(?:[^"]*)(")`, 'i');
  return html.replace(re, (_m, open, close) => `${open}${escapeAttr(value)}${close}`);
}

/**
 * Make index.html this world's page.
 *
 * The app is told which world it is in and how it starts (src/main.ts reads
 * both meta tags), the tab says the world's name, and the card's title, url
 * and description are the world's rather than the public one's. The image
 * stays the public frame — it is a real render by the same pipeline, so it
 * is a true picture of what happens in any of these worlds.
 *
 * The residents tag is written ONLY for a world that wants none, and the
 * hatch tag ONLY for a world that waits for an operator, so the public html
 * keeps not mentioning settings it does not have.
 *
 * All lowercase, like every other piece of type here (TASTE §5).
 */
export function applyWorldToHtml(html, world) {
  if (!world) return html;
  const { name, host } = world;
  const description = `a world for ${name}. draw a creature on your phone and it hatches somewhere everyone can see.`;
  const clean = sanitizeResidents(world.residents) === 'none';
  const manual = sanitizeHatch(world.hatch) === 'manual';

  let out = html.replace(
    /([ \t]*)<title>[\s\S]*?<\/title>/i,
    (_m, indent) =>
      `${indent}<!-- injected at build time by scripts/world-build.mjs — this deployment's world -->\n` +
      `${indent}<meta name="refworld:world" content="${escapeAttr(name)}" />\n` +
      (clean ? `${indent}<meta name="refworld:residents" content="none" />\n` : '') +
      (manual ? `${indent}<meta name="refworld:hatch" content="manual" />\n` : '') +
      `${indent}<title>ref world · ${name}</title>`,
  );
  out = setMeta(out, 'property', 'og:title', name);
  out = setMeta(out, 'name', 'twitter:title', name);
  out = setMeta(out, 'property', 'og:url', `https://${host}/`);
  out = setMeta(out, 'property', 'og:description', description);
  out = setMeta(out, 'name', 'twitter:description', description);
  return out;
}
