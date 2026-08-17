/**
 * `__IS_DEV__` is a static boolean injected by vite's `define` block
 * (vite.config.ts). It is `true` for dev builds and `false` when
 * NODE_ENV=production, which lets rollup drop the entire `src/dev/`
 * surface (and its lazy ghost-panel chunk) from the demo build.
 */
declare const __IS_DEV__: boolean;
