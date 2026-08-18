/**
 * One handset, one creature: the identity that makes it true, and the
 * wire/storage shapes the vendored draw page mirrors inline.
 */

import { describe, expect, it } from 'vitest';
import {
  DRAWER_KEY,
  drawerId,
  readSubmission,
  submissionKey,
  writeSubmission,
  type StorageLike,
} from '../../src/phone/identity';
import { readEmoteMessage } from '../../src/net/emoteUplink';
import { isEmoteName } from '../../src/net/drawFeed';
import { EMOTE_NAMES } from '../../src/net/protocol';

function memoryStore(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
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
