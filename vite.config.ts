/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

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
