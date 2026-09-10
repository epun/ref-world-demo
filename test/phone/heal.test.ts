/**
 * The handset healing the store.
 *
 * The report it exists for (2026-09-09): *"I previously drew a character, it
 * shows in the mobile (companion) view, but it does not load in the map view
 * on web or mobile."* In a NAMED world the world's epoch is `w-<world>`
 * forever, so a handset's record can never go stale — the pad refuses a
 * second drawing and the companion restores a creature the store has never
 * had, permanently.
 *
 * Everything dangerous here is in the failure cases, so that is what most of
 * this is: a store that cannot be read must never be mistaken for a store
 * that lost the drawing.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { healEndpoint, healStore, storeHas } from '../../src/phone/heal';

const log = (ids: string[]): unknown => ({
  schema: 'refworld.session',
  version: 1,
  epoch: 'public-meridian',
  room: 'meridian',
  startedAt: new Date(0).toISOString(),
  config: { store: 'live' },
  events: ids.flatMap((id) => [
    { t: 0, k: 'drawing', id, name: null, strokes: [], hatchMs: 20000 },
    { t: 1, k: 'hatch', id, cause: 'forced' },
  ]),
});

describe('storeHas', () => {
  it('finds a drawing the log carries', () => {
    expect(storeHas(log(['a', 'b']), 'b')).toBe('yes');
  });

  it('reports a readable log without the id as missing', () => {
    expect(storeHas(log(['a', 'b']), 'c')).toBe('no');
    expect(storeHas(log([]), 'c')).toBe('no');
  });

  it('only ever matches a DRAWING event', () => {
    // A hatch carries the same id. Matching it would read a world that had
    // lost the drawing but kept the hatch as a world that still has it.
    const partial = {
      schema: 'refworld.session',
      events: [{ t: 1, k: 'hatch', id: 'a', cause: 'forced' }],
    };
    expect(storeHas(partial, 'a')).toBe('no');
  });

  it('calls anything that is not a session log unreadable', () => {
    // An error page, a captive portal, a proxy's html, a truncated body.
    for (const body of [null, undefined, '', 'not json', 0, [], {}, { events: [] }]) {
      expect(storeHas(body, 'a')).toBe('unreadable');
    }
    expect(storeHas({ schema: 'refworld.session' }, 'a')).toBe('unreadable');
    expect(storeHas({ schema: 'something.else', events: [] }, 'a')).toBe('unreadable');
  });

  it('an empty id is unreadable, never missing', () => {
    expect(storeHas(log(['a']), '')).toBe('unreadable');
  });
});

const mine = { id: 'd1', name: 'ren', strokes: [{ pts: [[0, 0]], width: 8 }] };

/** A fetch that answers the GET with `body` and records what was posted. */
function fakeFetch(
  get: { ok: boolean; body?: unknown },
  post?: { status: number },
): { fetch: typeof globalThis.fetch; posts: { url: string; body: unknown }[] } {
  const posts: { url: string; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: unknown, init?: Record<string, unknown>) => {
    if (init && init['method'] === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init['body'])) });
      const status = post?.status ?? 201;
      return { ok: status < 400, status } as unknown as Response;
    }
    return {
      ok: get.ok,
      status: get.ok ? 200 : 503,
      json: async () => get.body,
    } as unknown as Response;
  });
  return { fetch: fetchFn as unknown as typeof globalThis.fetch, posts };
}

describe('healStore', () => {
  it('posts the drawing back when the store does not have it', async () => {
    const { fetch, posts } = fakeFetch({ ok: true, body: log(['someone-else']) });
    await expect(healStore('meridian', mine, { fetch })).resolves.toBe('healed');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(healEndpoint('meridian'));
    // The same wire shape the pad's own submit posts — id, name, strokes.
    expect(posts[0]!.body).toEqual({ id: 'd1', name: 'ren', strokes: mine.strokes });
  });

  it('writes nothing when the store already has it', async () => {
    const { fetch, posts } = fakeFetch({ ok: true, body: log(['d1']) });
    await expect(healStore('meridian', mine, { fetch })).resolves.toBe('already-there');
    expect(posts).toHaveLength(0);
  });

  it('writes nothing when the store cannot be read', async () => {
    // The whole point. An unreachable or unreadable store is not a store
    // that lost the drawing, and guessing costs a duplicate submission.
    for (const get of [
      { ok: false },
      { ok: true, body: null },
      { ok: true, body: '<!doctype html>' },
      { ok: true, body: { events: [] } },
    ]) {
      const { fetch, posts } = fakeFetch(get);
      await expect(healStore('meridian', mine, { fetch })).resolves.toBe('unreachable');
      expect(posts).toHaveLength(0);
    }
  });

  it('writes nothing when the network throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      healStore('meridian', mine, { fetch: fetchFn as unknown as typeof globalThis.fetch }),
    ).resolves.toBe('unreachable');
  });

  it('leaves a claimed device alone — 409 is the store saying hands off', async () => {
    // Including a drawing a moderator has refused: it is stored and simply
    // not in the log. Re-posting must not undo that, and 409 is how it does
    // not.
    const { fetch } = fakeFetch({ ok: true, body: log([]) }, { status: 409 });
    await expect(healStore('meridian', mine, { fetch })).resolves.toBe('claimed');
  });

  it('treats a store that refuses the write as unreachable', async () => {
    const { fetch } = fakeFetch({ ok: true, body: log([]) }, { status: 503 });
    await expect(healStore('meridian', mine, { fetch })).resolves.toBe('unreachable');
  });

  it('does nothing at all without a named world or a drawing', async () => {
    const { fetch, posts } = fakeFetch({ ok: true, body: log([]) });
    await expect(healStore('', mine, { fetch })).resolves.toBe('nothing-to-do');
    await expect(healStore('meridian', null, { fetch })).resolves.toBe('nothing-to-do');
    await expect(
      healStore('meridian', { id: 'd1', name: null, strokes: [] }, { fetch }),
    ).resolves.toBe('nothing-to-do');
    await expect(
      healStore('meridian', { id: '', name: null, strokes: mine.strokes }, { fetch }),
    ).resolves.toBe('nothing-to-do');
    expect(posts).toHaveLength(0);
  });

  it('reads past any cache — a stale copy would say missing when it is not', async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: Record<string, unknown>) => {
      calls.push(init ?? {});
      return { ok: true, status: 200, json: async () => log(['d1']) } as unknown as Response;
    });
    await healStore('meridian', mine, { fetch: fetchFn as unknown as typeof globalThis.fetch });
    expect(calls[0]!['cache']).toBe('no-store');
  });
});

// ── the two copies of the rule ──────────────────────────────────────────────

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the pad heals too — it is the page a returning handset lands on', () => {
  const pad = code(read('public/draw/index.html'));

  it('asks the store before it hands the person over', () => {
    expect(pad).toMatch(/function healThenGo/);
    // Two answers, not one: hand over, or — when the world has been reset
    // since this drawing was admitted — hand the pad back instead of
    // healing a creature into the world that just cleared it (2026-09-09).
    expect(pad).toMatch(/healThenGo\(goToCompanion, stepDownToPad\)/);
    // The old unconditional hand-off is gone from that path.
    expect(pad).not.toMatch(/if \(clear\) clear\.disabled = true;\s*goToCompanion\(\);/);
  });

  it('only posts on a readable log that is missing this id', () => {
    expect(pad).toMatch(/function storeHasDrawing/);
    expect(pad).toMatch(/storeHasDrawing\(body, rec\.id\) !== 'no'/);
    expect(pad).toMatch(/'unreadable'/);
  });

  it('never frees the pad and never deletes the record on the way through', () => {
    const heal = pad.slice(pad.indexOf('function healThenGo'), pad.indexOf('function enforceSingleDrawing'));
    expect(heal).not.toMatch(/removeItem/);
    expect(heal).not.toMatch(/setItem/);
    expect(heal).not.toMatch(/dataset\.spent = 'false'/);
  });

  it('is silent — a database being tidied is not news for the person', () => {
    const heal = pad.slice(pad.indexOf('function healThenGo'), pad.indexOf('function enforceSingleDrawing'));
    expect(heal).not.toMatch(/showToast|setStatus/);
  });

  it('does not wait forever — the companion heals what a slow store did not', () => {
    const heal = pad.slice(pad.indexOf('function healThenGo'), pad.indexOf('function enforceSingleDrawing'));
    expect(heal).toMatch(/setTimeout\(go, MOTION\.primaryMs\)/);
  });

  it('a second call still hands the person over — only the write is once', () => {
    // enforceSingleDrawing runs again on every bfcache restore and every
    // return to the tab. A guard that swallowed the navigation would strand
    // somebody on a frozen pad.
    const heal = pad.slice(pad.indexOf('function healThenGo'), pad.indexOf('function enforceSingleDrawing'));
    expect(heal).toMatch(/if \(healing\) \{ then\(\); return; \}/);
  });

  it('posts under the same id and the same wire shape as a fresh send', () => {
    expect(pad).toMatch(/id: rec\.id, name: rec\.name \|\| '', strokes: rec\.strokes/);
  });
});

describe('the companion heals on the page that stays put', () => {
  const phone = code(read('src/phone/main.ts'));

  it('calls healStore with the world and this handset s own record', () => {
    expect(phone).toMatch(/healStore\(publicWorld, \{/);
    expect(phone).toMatch(/void healStore/);
  });

  it('does not wait on it — nothing on screen depends on a database', () => {
    expect(phone).not.toMatch(/await healStore/);
  });
});
