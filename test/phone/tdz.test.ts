/**
 * `publicWorld` has to be declared before `mounts` is, not merely before
 * `createMachine` is called: a restore (a kept link, or a handset
 * returning to a room it already drew in) starts the machine straight on
 * `alive`, and `createMachine` can invoke that mount synchronously — so a
 * `const publicWorld` sitting after `mounts` throws `ReferenceError:
 * Cannot access 'publicWorld' before initialization` on exactly that boot
 * path (the companion's prewarmed iframe hit it dead on arrival). Pinned
 * as a source fact because the TDZ only fires on a code path, not on
 * every load, so a run-time test could pass while this regressed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(join(process.cwd(), 'src/phone/main.ts'), 'utf8');

describe('publicWorld is declared before its first use', () => {
  it('the `const publicWorld` declaration comes before every other reference', () => {
    const text = src();

    const declMatch = /const publicWorld =/.exec(text);
    expect(declMatch, 'const publicWorld declaration not found').toBeTruthy();
    const declIndex = declMatch!.index;
    // The identifier as it appears inside its own declaration — excluded
    // below so the declaration doesn't get compared against itself.
    const declUseIndex = declIndex + 'const '.length;

    const otherUses = [...text.matchAll(/\bpublicWorld\b/g)]
      .map((m) => m.index)
      .filter((i) => i !== declUseIndex);

    expect(otherUses.length).toBeGreaterThan(0);
    for (const i of otherUses) {
      expect(i, `use of publicWorld at index ${i} precedes its declaration at ${declIndex}`).toBeGreaterThan(
        declIndex,
      );
    }
  });
});
