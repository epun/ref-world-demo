/**
 * The curate script is idempotent, and `public/katamari/` matches the table.
 *
 * THE LIBRARY IS NOT IN THE REPO — 1,703 glb and 35 MB of somebody else's
 * assets — so this cannot run the copy. It runs `--verify`, which is the mode
 * that exists for exactly this: it checks that every model the table names is
 * published, that nothing published is unnamed, and that `catalog.json` is
 * byte-for-byte what the table serialises to. Running it twice must change
 * nothing and say the same thing both times, which is the idempotency that
 * matters — `catalog.json` carries no timestamp and no count read off the
 * library, so it is a pure function of `catalog.ts`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'katamari-curate.mjs');
const CATALOG = join(ROOT, 'public', 'katamari', 'catalog.json');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('scripts/katamari-curate.mjs', () => {
  it('verifies the published set against the table', () => {
    const out = run('--verify', '--quiet');
    expect(out).toContain('verified');
    expect(out).toMatch(/\d+ models/);
  });

  it('is idempotent — a second verify prints the same thing and touches nothing', () => {
    const before = readFileSync(CATALOG, 'utf8');
    const first = run('--verify', '--quiet');
    const second = run('--verify', '--quiet');
    expect(second).toBe(first);
    expect(readFileSync(CATALOG, 'utf8')).toBe(before);
  });

  it('prints a table of the pick, with the budgets it is held to', () => {
    const out = run('--verify');
    expect(out).toContain('kind');
    expect(out).toContain('tier');
    expect(out).toContain('height');
    expect(out).toContain('budget');
  });

  it('refuses to run without a library and without --verify', () => {
    expect(() => run()).toThrow();
  });

  it('the published catalog is stable json with no timestamp in it', () => {
    const text = readFileSync(CATALOG, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const parsed = JSON.parse(text) as { baseUrl: string; models: unknown[] };
    expect(parsed.baseUrl).toBe('/katamari');
    expect(parsed.models.length).toBeGreaterThan(60);
    // Round-trips: what is on disk is what a re-serialise would write.
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(text);
  });
});
