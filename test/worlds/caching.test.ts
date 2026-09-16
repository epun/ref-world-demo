/**
 * WHAT A SECOND VISIT COSTS — the cache headers, and the versioned paths
 * that make them safe.
 *
 * > User ask, 2026-09-16: *"we need to be able to run this on a slow network
 * > on people's devices."*
 *
 * Measured first (`scratch/slow-network.mjs`): 5.5 MB over the wire, and
 * nearly all of it re-downloaded on every deploy, for two reasons that are
 * both fixed here.
 *
 *   THE MODELS were not hashed at all, so they could not be served
 *     `immutable` — 4 MB of library on every visit. They now carry a content
 *     hash per row (`KatamariEntry.hash`) which the loader puts in the url.
 *   THREE.JS shipped inside whichever async chunk first reached it — it came
 *     out as `assets/minimap-<hash>.js`, a library that has not changed
 *     since 0.180.0 wearing the hash of a file that changes every deploy.
 *
 * So the rule this file pins: a path is served `immutable` for a year if and
 * only if something in it moves when its bytes do. `/assets/*` is rollup's
 * content hash, `/katamari/models/*` is the catalog's, `/vendor/*` is the
 * hash in the vendored file's own name — and the two things that carry no
 * version, the html and `catalog.json`, must revalidate every time or a
 * person would be pinned to last month's world for a year.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const VERCEL = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

/** The `Cache-Control` a source pattern is given, or null. */
function cacheControl(source: string): string | null {
  const rule = VERCEL.headers.find((h) => h.source === source);
  if (!rule) return null;
  return rule.headers.find((h) => h.key === 'Cache-Control')?.value ?? null;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0, must-revalidate';

describe('vercel.json — a year for anything with a version in its path', () => {
  it('serves the hashed build output immutable', () => {
    expect(cacheControl('/assets/(.*)')).toBe(IMMUTABLE);
  });

  it('serves the object library immutable — its urls carry the content hash', () => {
    expect(cacheControl('/katamari/models/(.*)')).toBe(IMMUTABLE);
  });

  it('serves the vendored scripts immutable — their names carry the hash', () => {
    expect(cacheControl('/vendor/(.*)')).toBe(IMMUTABLE);
  });

  it('makes the html and the catalog revalidate, because neither is versioned', () => {
    // These two are how a browser finds out about everything else. A year on
    // either would pin a person to the world as it was the day they first
    // opened it.
    expect(cacheControl('/(.*).html')).toBe(REVALIDATE);
    expect(cacheControl('/katamari/catalog.json')).toBe(REVALIDATE);
  });

  it('never gives a year to a path with nothing versioned in it', () => {
    for (const rule of VERCEL.headers) {
      const value = rule.headers.find((h) => h.key === 'Cache-Control')?.value ?? '';
      if (!value.includes('immutable')) continue;
      // The three, and no others: each is a path where the bytes moving
      // moves the url.
      expect(['/assets/(.*)', '/katamari/models/(.*)', '/vendor/(.*)']).toContain(rule.source);
    }
  });
});

describe('the vendored mqtt client carries its own content hash', () => {
  /**
   * The one un-rottable half of an `immutable` vendored file: the name says
   * what the bytes are, and this says the two agree. Replace the vendor and
   * this fails until the name and both script tags are updated with it.
   */
  const html = ['index.html', 'phone.html'].map((f) => readFileSync(join(ROOT, f), 'utf8'));

  it('is referenced by a hashed filename from both pages', () => {
    for (const source of html) {
      expect(source).toMatch(/\/vendor\/mqtt\.min\.[0-9a-f]{8}\.js/);
      // …and never by the bare name, which is what an immutable year would
      // pin forever.
      expect(source).not.toContain('/vendor/mqtt.min.js"');
    }
  });

  it('names the file after its actual bytes, and both pages agree', () => {
    const names = html.map((s) => /\/vendor\/(mqtt\.min\.[0-9a-f]{8}\.js)/.exec(s)![1]!);
    expect(new Set(names).size).toBe(1);
    const name = names[0]!;
    const bytes = readFileSync(join(ROOT, 'public', 'vendor', name));
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
    expect(name).toBe(`mqtt.min.${hash}.js`);
  });
});

describe('the big vendors get their own chunks', () => {
  it('names three and rapier by package, so their hashes move with the package', async () => {
    const config = (await import('../../vite.config')).default as {
      build: {
        rollupOptions: {
          output: { manualChunks: (id: string) => string | null };
        };
      };
    };
    const chunk = config.build.rollupOptions.output.manualChunks;
    expect(chunk('/x/node_modules/three/build/three.core.js')).toBe('three');
    expect(chunk('/x/node_modules/@dimforge/rapier3d-compat/rapier.es.js')).toBe('rapier');
    // Everything else keeps rollup's own split — a chunk whose contents are
    // "whatever was big" is a chunk whose hash is a lottery.
    expect(chunk('/x/src/world/minimap.ts')).toBe(null);
    expect(chunk('/x/node_modules/envpaint/index.js')).toBe(null);
    // …and `three` matches the PACKAGE, not the word: a source file of ours
    // that happens to mention it is not the library.
    expect(chunk('/x/src/world/threejs-notes.ts')).toBe(null);
  });
});
