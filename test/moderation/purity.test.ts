/**
 * src/moderation/ carries the same purity contract as src/shape/: the
 * verdict must be a function of the strokes alone. If a clock, a random
 * source, the DOM or Three.js ever leaks in, the same drawing could screen
 * differently on two devices — and a moderation decision that is not
 * reproducible cannot be audited after an event.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'src/moderation');
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

/** Strip line and block comments before scanning for banned sources. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('src/moderation purity', () => {
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
});
