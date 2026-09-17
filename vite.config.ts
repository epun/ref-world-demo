/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  applyWorldToHtml,
  applyWorldToPhoneHtml,
  readWorlds,
  resolveWorld,
  sanitizeGame,
} from './scripts/world-build.mjs';

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
 * index.html gets the world's card and all five of its tags. phone.html is
 * the companion handset's page: it belongs to whatever world its projection
 * is in and has no card of its own, so it gets only the two tags that
 * describe the DEPLOYMENT rather than the room — `refworld:style`, which
 * decides what palette its chrome paints in (src/ui/theme.ts), and
 * `refworld:game`. Both only when they are not the default, so the public
 * world's phone.html is byte-identical too.
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
        if (!world) return html;
        const file = basename(ctx.filename);
        if (file === 'index.html') return applyWorldToHtml(html, world);
        if (file === 'phone.html') return applyWorldToPhoneHtml(html, world);
        return html;
      },
    },
  };
}

/**
 * The katamari object library ships to the KATAMARI WORLD only.
 *
 * `public/katamari/` is a personal-use extraction from a retail copy of
 * *Katamari Damacy* (`public/katamari/README.md`); the assets remain
 * Namco's. The app already never fetches them without the game
 * (`startKatamariWorld`, src/world/katamari/source.ts), and this is the
 * other half of that statement: a deployment whose world did not ask for
 * the game does not carry the files at all. Vite copies `public/` wholesale,
 * so the drop happens after the copy — the one place that knows both the
 * output directory and which world this build is for.
 */
function katamariAssets(world: ReturnType<typeof resolveWorld>): Plugin {
  const keep = sanitizeGame(world?.game) === 'katamari';
  let outDir = 'dist';
  return {
    name: 'ref-world-katamari-assets',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      if (keep) return;
      rmSync(resolve(__dirname, outDir, 'katamari'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [worldIdentity(WORLD), katamariAssets(WORLD)],
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
        /**
         * THE BIG VENDORS GET THEIR OWN CONTENT-HASHED CHUNKS (2026-09-16).
         *
         * > User ask: *"we need to be able to run this on a slow network on
         * > people's devices."*
         *
         * Rollup's automatic split put three.js inside whichever async chunk
         * first reached it — it shipped as `assets/minimap-<hash>.js`, three
         * hundred kilobytes of a library that has not changed since
         * 0.180.0 wearing the hash of a file that changes every deploy. So
         * every deploy re-downloaded three on every device, on top of the
         * app code that genuinely did change.
         *
         * Naming them here fixes the hash to the dependency: `three-<hash>`
         * and `rapier-<hash>` only move when the package does, and the
         * `immutable` year in `vercel.json` then means something. It is also
         * why the split is by PACKAGE and not by size — a chunk whose
         * contents are "whatever was big" is a chunk whose hash is a lottery.
         *
         * `rapier` still only exists in a build that reaches it, and it is
         * still only FETCHED by a page that calls `enablePhysics`
         * (src/world/scene.ts) — this names the chunk, it does not load it.
         */
        manualChunks: (id) => {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/@dimforge/rapier3d-compat')) return 'rapier';
          return null;
        },
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
