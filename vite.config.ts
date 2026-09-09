/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { basename, resolve } from 'node:path';
import { applyWorldToHtml, readWorlds, resolveWorld } from './scripts/world-build.mjs';

/**
 * A client's world is a deployment of its own.
 *
 * Not a path on the public site: its own vercel project, its own hostname,
 * the same repo. So what varies between deployments — which world the page
 * shows, what its link unfurls into, whether it opens with a population —
 * is decided here, at build time, because the card is read by crawlers
 * that never run the app.
 *
 * worlds.json gives each world its hostname and its settings; the rules
 * live in scripts/world-build.mjs so they can be tested without a build.
 * The public deployment is not in the map, resolves to null, and its
 * index.html comes out byte-identical — test/worlds/build.test.ts pins that.
 *
 * index.html only. phone.html is the companion handset's page; it belongs
 * to whatever world its projection is in and has no card of its own.
 */
/** The world this build is for, or null for the public deployment — read
 * once, because the html transform and the `__IS_DEV__` define both need it. */
const WORLD = resolveWorld(process.env, readWorlds(resolve(__dirname, 'worlds.json')));

function worldIdentity(world: ReturnType<typeof resolveWorld>): Plugin {
  if (world) {
    console.log(
      `ref-world: building "${world.name}" at ${world.host}, residents ${world.residents}`,
    );
  }
  return {
    name: 'ref-world-identity',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!world || basename(ctx.filename) !== 'index.html') return html;
        return applyWorldToHtml(html, world);
      },
    },
  };
}

export default defineConfig({
  plugins: [worldIdentity(WORLD)],
  build: {
    rollupOptions: {
      input: {
        world: resolve(__dirname, 'index.html'),
        phone: resolve(__dirname, 'phone.html'),
        // The content screen, for the vendored draw pad (which is plain
        // html in public/ and cannot import from src/). Fixed filename so
        // that page can script-tag it: src/moderation/standalone.ts.
        screen: resolve(__dirname, 'src/moderation/standalone.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'screen' ? 'screen.js' : 'assets/[name]-[hash].js',
      },
    },
    target: 'es2022',
  },
  define: {
    // isDev gates src/dev/ (Ghost Panel skills). Must be a static boolean so the
    // demo build tree-shakes the entire dev surface out. Two builds keep it:
    // a world whose worlds.json entry says `dev: true` (meridian is its
    // author's workbench as well as a demo, and the painted terrain lives in
    // the panel with no other way to be reached), and any vercel PREVIEW — a
    // branch alias is a thing a reviewer opens to look at, never the url a
    // client is handed. Every production build without the flag, the public
    // world first among them, stays stripped exactly as before.
    __IS_DEV__: JSON.stringify(
      process.env.NODE_ENV !== 'production' ||
        WORLD?.dev === true ||
        process.env.VERCEL_ENV === 'preview',
    ),
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
