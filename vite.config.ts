/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every world with a page of its own is a build input.
 *
 * `worlds/<name>/index.html` (written by scripts/new-world.mjs) is the same
 * app declaring its world in a meta tag, so a client demo has an address
 * that is a place rather than a query string. Discovered rather than listed
 * so adding one is one command and no config edit — the build output lands
 * at dist/worlds/<name>/index.html, which is what /worlds/<name>/ serves.
 */
function worldPages(root: string): Record<string, string> {
  const dir = resolve(root, 'worlds');
  if (!existsSync(dir)) return {};
  const inputs: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const page = resolve(dir, name, 'index.html');
    if (!statSync(resolve(dir, name)).isDirectory()) continue;
    if (!existsSync(page)) continue;
    inputs[`world-${name}`] = page;
  }
  return inputs;
}

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        world: resolve(__dirname, 'index.html'),
        phone: resolve(__dirname, 'phone.html'),
        // The content screen, for the vendored draw pad (which is plain
        // html in public/ and cannot import from src/). Fixed filename so
        // that page can script-tag it: src/moderation/standalone.ts.
        screen: resolve(__dirname, 'src/moderation/standalone.ts'),
        ...worldPages(__dirname),
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
    // demo build tree-shakes the entire dev surface out.
    __IS_DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
