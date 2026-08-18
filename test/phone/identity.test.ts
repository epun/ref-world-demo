/**
 * One handset, one creature: the identity that makes it true, and the
 * wire/storage shapes the vendored draw page mirrors inline.
 */

import { describe, expect, it } from 'vitest';
import {
  clearSubmission,
  DRAWER_KEY,
  drawerId,
  isStale,
  readSubmission,
  submissionKey,
  writeSubmission,
  type StorageLike,
} from '../../src/phone/identity';
import { readEmoteMessage, readHello, readVerdict, readWorldEpoch } from '../../src/net/phoneLink';
import { isEmoteName } from '../../src/net/drawFeed';
import { EMOTE_NAMES } from '../../src/net/protocol';

function memoryStore(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('drawerId', () => {
  it('mints once and then never changes — the creature stays the same one', () => {
    const store = memoryStore();
    let n = 0;
    const random = (): number => (n++ % 97) / 97;
    const first = drawerId({ store, random });
    expect(first).toMatch(/^d/);
    expect(store.map.get(DRAWER_KEY)).toBe(first);
    for (let i = 0; i < 5; i++) expect(drawerId({ store, random })).toBe(first);
  });

  it('keeps an id that is already stored, whatever it looks like', () => {
    const store = memoryStore({ [DRAWER_KEY]: 'd-existing' });
    expect(drawerId({ store })).toBe('d-existing');
  });

  it('still returns an id when storage refuses (private mode)', () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(drawerId({ store: blocked })).toMatch(/^d/);
  });

  it('two handsets get two ids — one creature each, not one shared', () => {
    let n = 1;
    const random = (): number => ((n = (n * 48271) % 2147483647) / 2147483647);
    const a = drawerId({ store: memoryStore(), random });
    const b = drawerId({ store: memoryStore(), random });
    expect(a).not.toBe(b);
  });
});

describe('submission record', () => {
  it('round-trips per room, so a reload restores that creature', () => {
    const store = memoryStore();
    writeSubmission('cfaa', { id: 'd1', name: 'ana', strokes: [{ pts: [[0, 0]] }], ts: 5 }, { store });
    expect(store.map.has(submissionKey('cfaa'))).toBe(true);
    const back = readSubmission('cfaa', { store });
    expect(back?.id).toBe('d1');
    expect(back?.name).toBe('ana');
    expect(back?.strokes).toHaveLength(1);
  });

  it('is scoped to its room — a different room is a clean slate', () => {
    const store = memoryStore();
    writeSubmission('cfaa', { id: 'd1', name: null, strokes: [{ pts: [] }], ts: 5 }, { store });
    expect(readSubmission('zzzz', { store })).toBeNull();
  });

  it('rejects junk rather than restoring a broken creature', () => {
    for (const raw of ['', 'not json', '{}', '{"id":"d1"}', '{"id":"d1","strokes":[]}']) {
      const store = memoryStore({ [submissionKey('cfaa')]: raw });
      expect(readSubmission('cfaa', { store }), raw).toBeNull();
    }
  });
});

describe('emote messages on the wire', () => {
  it('reads a well-formed emote', () => {
    for (const emote of EMOTE_NAMES) {
      expect(readEmoteMessage({ type: 'emote', from: 'd1', emote }, isEmoteName)).toEqual({
        from: 'd1',
        emote,
      });
    }
  });

  it('ignores drawings and malformed traffic — the two share a topic', () => {
    const cases: unknown[] = [
      null,
      'emote',
      { strokes: [{ pts: [] }] }, // a drawing
      { type: 'emote' },
      { type: 'emote', from: '', emote: 'happy' },
      { type: 'emote', from: 'd1' },
      { type: 'emote', from: 'd1', emote: 'jubilant' }, // not in the protocol
      { type: 'emote', from: 'd1', emote: 7 },
      { type: 'pose', from: 'd1', emote: 'happy' },
    ];
    for (const c of cases) expect(readEmoteMessage(c, isEmoteName), JSON.stringify(c)).toBeNull();
  });
});

describe('a world that restarted', () => {
  const record = (epoch?: string | null) => ({
    id: 'd1',
    name: null,
    strokes: [{ pts: [[0, 0]] }],
    ts: 1,
    ...(epoch === undefined ? {} : { epoch }),
  });

  it('frees the handset when the running world is a different session', () => {
    expect(isStale(record('w-old'), 'w-new')).toBe(true);
  });

  it('holds the record while the same world is still running', () => {
    expect(isStale(record('w-same'), 'w-same')).toBe(false);
  });

  it('never frees it on silence — no world heard from is not a new world', () => {
    expect(isStale(record('w-old'), null)).toBe(false);
    expect(isStale(record('w-old'), '')).toBe(false);
    expect(isStale(null, 'w-new')).toBe(false);
  });

  it('treats a record from before sessions existed as stale', () => {
    expect(isStale(record(), 'w-new')).toBe(true);
    expect(isStale(record(null), 'w-new')).toBe(true);
  });

  it('round-trips the session with the submission, and clears on demand', () => {
    const store = memoryStore();
    writeSubmission('cfaa', { id: 'd1', name: null, strokes: [{ pts: [] }], ts: 1, epoch: 'w1' }, { store });
    expect(readSubmission('cfaa', { store })?.epoch).toBe('w1');
    clearSubmission('cfaa', { store });
    expect(readSubmission('cfaa', { store })).toBeNull();
  });
});

describe('what the world says back', () => {
  it('reads a verdict addressed to me, and ignores everyone else\'s', () => {
    const msg = { type: 'verdict', to: 'd1', disposition: 'refused', reason: 'phallus: …', epoch: 'w1' };
    expect(readVerdict(msg, 'd1')).toEqual({
      disposition: 'refused',
      reason: 'phallus: …',
      epoch: 'w1',
    });
    expect(readVerdict(msg, 'd2')).toBeNull();
  });

  it('ignores malformed verdicts rather than showing a notice for nothing', () => {
    for (const m of [null, 'refused', {}, { type: 'verdict' }, { type: 'verdict', to: 'd1' }, { type: 'world', to: 'd1', disposition: 'refused' }]) {
      expect(readVerdict(m, 'd1'), JSON.stringify(m)).toBeNull();
    }
  });

  it('reads the world session off either message the world sends', () => {
    expect(readWorldEpoch({ type: 'world', epoch: 'w7' })).toBe('w7');
    expect(readWorldEpoch({ type: 'verdict', to: 'd1', disposition: 'refused', epoch: 'w7' })).toBe('w7');
    expect(readWorldEpoch({ type: 'emote', epoch: 'w7' })).toBeNull();
    expect(readWorldEpoch({ type: 'world' })).toBeNull();
  });

  it('reads a hello, which is what the world answers', () => {
    expect(readHello({ type: 'hello', from: 'd1' })).toEqual({ from: 'd1' });
    expect(readHello({ type: 'emote', from: 'd1', emote: 'happy' })).toBeNull();
    expect(readHello({ type: 'hello' })).toBeNull();
  });
});
