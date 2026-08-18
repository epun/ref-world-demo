/**
 * src/session/ carries the same purity contract as src/shape/ and
 * src/moderation/: data in, data out. The recorder takes its clock as an
 * injected function and the replay takes its timer the same way, so the whole
 * module runs under node — which is what lets a session log be replayed,
 * diffed or re-derived off a browser entirely.
 *
 * A leaked `Date` would also put a wall clock in the log body, which the
 * format forbids outright (one stamp, in the header, passed in).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'src/session');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

/** Strip line and block comments before scanning for banned sources. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('src/session purity', () => {
  it('has files to scan', () => {
    expect(FILES.length).toBeGreaterThan(3);
  });

  for (const file of FILES) {
    it(`${file} uses no clock, no randomness, no dom, no three.js`, () => {
      const body = code(readFileSync(join(DIR, file), 'utf8'));
      expect(body).not.toMatch(/Math\.random/);
      expect(body).not.toMatch(/\bDate\b/);
      expect(body).not.toMatch(/performance\.now/);
      expect(body).not.toMatch(/\bdocument\b|\bwindow\b/);
      expect(body).not.toMatch(/from 'three'/);
    });
  }

  it('imports nothing from the world, the dom layers, or three.js', () => {
    for (const file of FILES) {
      const body = readFileSync(join(DIR, file), 'utf8');
      const imports = [...body.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports) {
        // Only pure siblings: shape types and this directory's own modules.
        expect(
          spec.startsWith('./') || spec === '../shape/types',
          `${file} imports ${spec}`,
        ).toBe(true);
      }
    }
  });
});
