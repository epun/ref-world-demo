/**
 * Recovery: what has to survive a refresh of the projection.
 *
 * The failure this pins happened for real (user report, 2026-08-20): the
 * shared screen was refreshed mid-session and the whole population went
 * with it. Three copies of a drawing existed at that moment — the world's
 * in-memory log, the handset's localStorage record, and the world's
 * autosave — and the code managed to lose two of them, because the paths
 * that NOTICED the restart were the paths that deleted the record.
 *
 * These are source-level pins, deliberately. The two deletions lived in a
 * static html page and in a browser-only entry module, neither of which a
 * unit test can drive — and a comment saying "do not delete this" is not a
 * test. What can be checked is that the destructive calls are not there.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
/** Strip comments — a banned call NAMED in prose must not fail the scan. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the drawing on the handset is never deleted by a world restart', () => {
  it('the draw page does not remove its submission record', () => {
    const src = code(read('public/draw/index.html'));
    // It may still WRITE the key; it must never remove it. The pad is freed
    // by letting the person through, not by destroying the only copy of a
    // drawing that a recall could hand back.
    expect(src).not.toMatch(/removeItem\(\s*SUBMISSION_KEY/);
  });

  it('the companion does not clear the submission on a stale epoch', () => {
    const src = code(read('src/phone/main.ts'));
    // clearSubmission still exists for the one legitimate case — the person
    // pressing "draw something else" after a refusal — so this pins the
    // stale-epoch handler specifically: it must re-home, not erase.
    const handler = src.slice(src.indexOf('onWorldEpoch'));
    expect(handler).not.toMatch(/clearSubmission/);
    expect(handler).toMatch(/resendMine/);
  });

  it('the draw page answers a recall', () => {
    const src = code(read('public/draw/index.html'));
    // The companion bounces here on a stale epoch, so this page is where
    // the handsets that most need to answer a recall actually are.
    expect(src).toMatch(/'recall'/);
    expect(src).toMatch(/function answerRecall/);
  });
});

/**
 * And the reset, which is the opposite decision made about the same bytes.
 *
 * User ask, 2026-09-09/10: a world can be started over, and every handset
 * holding a drawing from before it has to STOP OFFERING that drawing —
 * without the drawing going anywhere. The temptation is obvious and it is
 * the exact mistake the three pins above exist for: the code that notices
 * the world moved on is not allowed to be the code that deletes the record.
 */
describe('a world reset stops the offer, never the keeping', () => {
  it('the draw page frees the pad by generation, not by deletion', () => {
    const src = code(read('public/draw/index.html'));
    // The pad is released for a drawing from an older generation…
    expect(src).toMatch(/function fromOlderWorld/);
    expect(src).toMatch(/if \(fromOlderWorld\(rec\)\) return false;/);
    // …and the removal is still nowhere on this page (the pin above, held
    // against the new path as well).
    expect(src).not.toMatch(/removeItem\(\s*SUBMISSION_KEY/);
  });

  it('the step-down on the draw page keeps the record', () => {
    const src = code(read('public/draw/index.html'));
    const handler = src.slice(src.indexOf('function stepDownToPad'));
    expect(handler.length).toBeGreaterThan(0);
    expect(handler.slice(0, 400)).not.toMatch(/removeItem/);
  });

  it('the companion steps down without clearing the submission', () => {
    const src = code(read('src/phone/main.ts'));
    const handler = src.slice(src.indexOf('const stepDownToPad'));
    // `clearSubmission` is right after a REFUSAL — that creature will never
    // exist. A reset is not a refusal: the drawing is still on this phone,
    // the keepsake still builds from it, and a recall can still ask for it.
    expect(handler.slice(0, 400)).not.toMatch(/clearSubmission/);
    expect(src).toMatch(/generationVerdict\(mine, worldEpoch\) === 'step-down'/);
  });

  it('the heal refuses an older generation rather than deleting anything', () => {
    const src = code(read('src/phone/heal.ts'));
    expect(src).toMatch(/'old-generation'/);
    // heal has never had a reason to write to storage and still has none.
    expect(src).not.toMatch(/localStorage/);
  });
});

describe('the world autosave', () => {
  const src = read('src/main.ts');

  it('keeps the latest-epoch pointer out of the log key namespace', () => {
    // `refworld:session:latest` was read back by the prefix scan as a saved
    // log and handed to JSON.parse; an epoch is not json, and the throw
    // took every entry after it out of the recovery list.
    expect(src).not.toMatch(/'refworld:session:latest'/);
    expect(src).toMatch(/refworld:session-latest/);
  });

  it('restores rather than replays', () => {
    // A replay re-runs a session at the pace it was recorded. For recovery
    // that is the wrong tool: the population must be back now, not over the
    // next hour.
    expect(src).toMatch(/replayNow\(log, replayDriver\)/);
  });
});
