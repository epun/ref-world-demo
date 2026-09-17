/**
 * `?fresh=1` — the ONE LOAD that starts the room empty (src/world/load.ts).
 *
 * The property this file exists to protect is the one it asserts first: a
 * load WITHOUT the flag restores and heals exactly as it always has, on
 * every world. Demo day depends on that (user ask, 2026-09-17: *"on the
 * actual demo day we want to make sure that the world saves and is
 * stored"*), and the flag is a testing convenience that must not be able to
 * change it.
 *
 * Then the three things the fresh load has to get right:
 *
 *   - with the secret it asks the moderator endpoint for a reset, exactly as
 *     the panel's `reset world` does, so the world's GENERATION steps and
 *     every handset that drew is sent back to the pad;
 *   - without the secret it cannot bump anything, and comes up empty anyway;
 *   - a drawing is never deleted either way — the handset keeps it, which is
 *     the rule test/session/recovery.test.ts guards from the other side.
 */

import { describe, expect, it } from 'vitest';
import { generationVerdict, type Submission } from '../../src/phone/identity';
import {
  moderateEndpoint,
  planLoad,
  readFreshLoad,
  startFresh,
  type LoadPlan,
} from '../../src/world/load';

/** The shipped plan, spelled out rather than imported: it is the thing under
 * protection, so a change to it should have to be written down twice. */
const RESTORE: LoadPlan = {
  reset: false,
  absorbStore: true,
  applyStoredScene: true,
  note: null,
};

describe('readFreshLoad — only an asked-for empty room is an empty room', () => {
  it('reads the two spellings the flag has', () => {
    expect(readFreshLoad('?fresh=1')).toBe(true);
    expect(readFreshLoad('?fresh=on')).toBe(true);
    expect(readFreshLoad('?room=abcd&fresh=1&world=valiocon')).toBe(true);
  });

  it('reads anything else as the load that heals itself', () => {
    // A misread value here empties a room, so every value but the two is
    // the shipped load — including the ones that look like an intention.
    for (const search of [
      '',
      '?room=abcd',
      '?fresh=0',
      '?fresh=off',
      '?fresh',
      '?fresh=true',
      '?fresh=yes',
      '?fresh=2',
      '?freshen=1',
      '?FRESH=1',
    ]) {
      expect(readFreshLoad(search)).toBe(false);
    }
  });
});

describe('planLoad — a load without the flag is exactly the load that shipped', () => {
  it('restores and heals on every world, with or without a secret', () => {
    for (const hasSecret of [false, true]) {
      for (const handheld of [false, true]) {
        expect(
          planLoad({ fresh: false, isPublic: true, handheld, hasSecret }),
        ).toEqual(RESTORE);
        expect(
          planLoad({ fresh: false, isPublic: false, handheld, hasSecret }),
        ).toEqual(RESTORE);
      }
    }
  });

  it('a HANDSET never empties the room, even asking for it', () => {
    // A phone in a room is a VIEWER (CLAUDE.md, 2026-09-17): it has to see
    // the live creatures the host is simulating. A phone that reset the
    // world by opening the world view — including the phone that is alone
    // on the link and therefore hosting — would be the worst possible
    // reading of this ask.
    expect(
      planLoad({ fresh: true, isPublic: true, handheld: true, hasSecret: true }),
    ).toEqual(RESTORE);
  });

  it('an installation room has no store, no generation and nothing to reset', () => {
    expect(
      planLoad({ fresh: true, isPublic: false, handheld: false, hasSecret: true }),
    ).toEqual(RESTORE);
  });

  it('a projection with the secret resets, and restores neither drawings nor scene', () => {
    expect(
      planLoad({ fresh: true, isPublic: true, handheld: false, hasSecret: true }),
    ).toEqual({ reset: true, absorbStore: false, applyStoredScene: false, note: null });
  });

  it('a projection with no secret still comes up empty, and says so', () => {
    const plan = planLoad({
      fresh: true,
      isPublic: true,
      handheld: false,
      hasSecret: false,
    });
    expect(plan.reset).toBe(false);
    expect(plan.absorbStore).toBe(false);
    expect(plan.applyStoredScene).toBe(false);
    // The operator has to hear it: the store still holds the last run, so
    // the phones keep their companions and the pad still refuses them.
    expect(plan.note).toMatch(/no secret/);
    expect(plan.note).not.toMatch(/[A-Z]/);
  });
});

/** A fetch that records what it was asked and answers with a status. */
function recordingFetch(status = 200): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('startFresh — the reset the load performs', () => {
  it('sends nothing at all on a load that is not fresh', async () => {
    const { fetch, calls } = recordingFetch();
    const out = await startFresh({ plan: RESTORE, world: 'valiocon', secret: 's', fetch });
    expect(calls).toEqual([]);
    expect(out).toEqual({
      requested: false,
      bumped: false,
      absorbStore: true,
      note: null,
    });
  });

  it('sends nothing when there is no secret, and still comes up empty', async () => {
    const plan = planLoad({
      fresh: true,
      isPublic: true,
      handheld: false,
      hasSecret: false,
    });
    const { fetch, calls } = recordingFetch();
    const out = await startFresh({ plan, world: 'valiocon', secret: '', fetch });
    // No secret, no request: the store cannot be bumped by a page that has
    // no right to, and asking would only be a 404 on the wall.
    expect(calls).toEqual([]);
    expect(out.requested).toBe(false);
    expect(out.bumped).toBe(false);
    expect(out.absorbStore).toBe(false);
    expect(out.note).toBe(plan.note);
  });

  it('asks the moderator endpoint for the same reset the panel asks for', async () => {
    const plan = planLoad({
      fresh: true,
      isPublic: true,
      handheld: false,
      hasSecret: true,
    });
    const { fetch, calls } = recordingFetch(200);
    const out = await startFresh({
      plan,
      world: 'valiocon',
      secret: 'a-long-secret',
      fetch,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(moderateEndpoint('valiocon'));
    expect(calls[0]?.init?.method).toBe('POST');
    expect(
      (calls[0]?.init?.headers as Record<string, string> | undefined)?.['x-moderator'],
    ).toBe('a-long-secret');
    // `{"reset": true}` is the one body api/moderate.ts bumps the generation
    // on (api/_store.ts `resetWorld`).
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ reset: true });
    expect(out.bumped).toBe(true);
    // The store is empty now, so the poll may stand up what arrives next.
    expect(out.absorbStore).toBe(true);
    expect(out.note).not.toMatch(/[A-Z]/);
  });

  it('every failure still comes up empty, and says which failure it was', async () => {
    const plan = planLoad({
      fresh: true,
      isPublic: true,
      handheld: false,
      hasSecret: true,
    });
    for (const [status, expected] of [
      [404, /wrong secret/],
      [503, /no store/],
      [500, /500/],
    ] as const) {
      const { fetch } = recordingFetch(status);
      const out = await startFresh({ plan, world: 'valiocon', secret: 's', fetch });
      expect(out.requested).toBe(true);
      expect(out.bumped).toBe(false);
      // The whole point: a reset that did not land leaves the store holding
      // the last run, which is exactly what this load must not show.
      expect(out.absorbStore).toBe(false);
      expect(out.note).toMatch(expected);
      expect(out.note).not.toMatch(/[A-Z]/);
    }
  });

  it('a network that is not there is a failure like any other', async () => {
    const plan = planLoad({
      fresh: true,
      isPublic: true,
      handheld: false,
      hasSecret: true,
    });
    const fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof globalThis.fetch;
    const out = await startFresh({ plan, world: 'valiocon', secret: 's', fetch });
    expect(out.bumped).toBe(false);
    expect(out.absorbStore).toBe(false);
    expect(out.note).toMatch(/unreachable/);
  });
});

/**
 * WHAT HAPPENS TO THE PHONES — the reason the reset goes through the store
 * rather than being a local switch.
 *
 * The generation rides in the world's epoch, and the handset compares it
 * against the one its drawing was admitted under (src/phone/identity.ts).
 * So a fresh load with the secret sends every phone that drew last run back
 * to the pad, KEEPING its drawing; a fresh load without the secret cannot,
 * and the phones carry on as if nothing happened.
 */
describe('the handsets, after a fresh load', () => {
  const drew = (epoch: string): Submission => ({
    id: 'd1',
    name: null,
    strokes: [[[0, 0]]],
    ts: Date.now(),
    epoch,
  });

  it('a bumped generation steps the phones down — the drawing is kept, never deleted', () => {
    // `step-down` is the verdict that sends the person to the pad with
    // their record intact (CLAUDE.md: never delete a handset's drawing;
    // test/session/recovery.test.ts guards the same rule).
    expect(generationVerdict(drew('w-valiocon-g0'), 'w-valiocon-g1')).toBe('step-down');
    expect(generationVerdict(drew('w-valiocon-g4'), 'w-valiocon-g5')).toBe('step-down');
  });

  it('an unbumped generation leaves every phone exactly where it was', () => {
    // Which is why the no-secret load says so on the projection: the room
    // is empty on this screen and nowhere else.
    expect(generationVerdict(drew('w-valiocon-g2'), 'w-valiocon-g2')).toBe('stay');
  });
});
