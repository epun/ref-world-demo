/**
 * A world can start over, and a handset has to notice without losing
 * anything.
 *
 * User ask, 2026-09-09/10: *"if we reset the URL we should also reset the
 * characters that are within that room"* … *"let's clear out any existing
 * characters right now so we start clean"*. Refusing the rehearsal creatures
 * one at a time does not do it — a refusal releases the device claim and
 * every handset HEALS its drawing straight back in on the next visit, which
 * is the same behaviour that makes a real session survive a redeploy. So the
 * world steps to a new generation and the handsets step down.
 *
 * Two rules are pinned here and they pull against each other, which is the
 * whole reason they are both tests:
 *
 *   1. an OLDER drawing stops being offered — no heal, no re-publish;
 *   2. the drawing itself is never touched (CLAUDE.md, and
 *      test/session/recovery.test.ts pins the two paths that used to
 *      destroy it). Step down is a decision about OFFERING, not about
 *      storage.
 */

import { describe, expect, it } from 'vitest';
import {
  epochFor,
  generationOf,
  generationVerdict,
  type Submission,
} from '../../src/phone/identity';
import { healStore, logGeneration } from '../../src/phone/heal';

const drawing = (epoch: string | null): Submission => ({
  id: 'd-phone',
  name: 'moss',
  strokes: [{ pts: [{ x: 1, y: 1 }] }],
  ts: Date.now(),
  epoch,
});

describe('generationOf', () => {
  it('reads the suffix a public world announces', () => {
    expect(generationOf('w-meridian-g0')).toBe(0);
    expect(generationOf('w-meridian-g1')).toBe(1);
    expect(generationOf('w-meridian-g42')).toBe(42);
  });

  it('reads an epoch with no generation as generation 0', () => {
    // The legacy public epoch, an installation room's random one, a record
    // written before any of this existed, and nothing at all. All the same
    // answer: a world that has never been reset.
    expect(generationOf('w-meridian')).toBe(0);
    expect(generationOf('w1a2b3c')).toBe(0);
    expect(generationOf('')).toBe(0);
    expect(generationOf(null)).toBe(0);
    expect(generationOf(undefined)).toBe(0);
  });

  it('is not fooled by something that merely contains a g', () => {
    expect(generationOf('w-g-world')).toBe(0);
    expect(generationOf('w-meridian-g')).toBe(0);
    expect(generationOf('w-meridian-gx1')).toBe(0);
    // Mid-string, not the suffix: this is a world NAMED like an epoch.
    expect(generationOf('w-meridian-g2-draft')).toBe(0);
  });

  it('round-trips what the world builds', () => {
    expect(epochFor('meridian', 3)).toBe('w-meridian-g3');
    expect(generationOf(epochFor('meridian', 3))).toBe(3);
    // A world that has never been reset still says so explicitly, so the
    // epoch on the wire always has the same shape.
    expect(epochFor('meridian', 0)).toBe('w-meridian-g0');
  });
});

describe('what a handset does about the world it is hearing from', () => {
  it('stays put in the same generation — the heal path is untouched', () => {
    expect(generationVerdict(drawing('w-meridian-g1'), 'w-meridian-g1')).toBe('stay');
  });

  it('treats a legacy epoch as generation 0, so a first reset reaches it', () => {
    expect(generationVerdict(drawing('w-meridian'), 'w-meridian-g0')).toBe('stay');
    expect(generationVerdict(drawing('w-meridian'), 'w-meridian-g1')).toBe('step-down');
    expect(generationVerdict(drawing(null), 'w-meridian-g1')).toBe('step-down');
  });

  it('steps down for a newer generation', () => {
    expect(generationVerdict(drawing('w-meridian-g1'), 'w-meridian-g2')).toBe('step-down');
  });

  it('never steps down for an OLDER announcement', () => {
    // A retained message from a projection somebody left open on a previous
    // build is behind, not authoritative. Acting on it would take away a
    // creature that is standing in the world right now.
    expect(generationVerdict(drawing('w-meridian-g2'), 'w-meridian-g1')).toBe('stay');
  });

  it('says nothing when there is nothing to say', () => {
    expect(generationVerdict(null, 'w-meridian-g9')).toBe('stay');
    expect(generationVerdict(drawing('w-meridian-g0'), null)).toBe('stay');
    expect(generationVerdict(drawing('w-meridian-g0'), '')).toBe('stay');
  });
});

describe('the log header carries the generation', () => {
  it('reads it, and reads its absence as absence', () => {
    expect(logGeneration({ config: { generation: 4 } })).toBe(4);
    expect(logGeneration({ config: { generation: 0 } })).toBe(0);
    expect(logGeneration({ config: {} })).toBeNull();
    expect(logGeneration({ config: { generation: 'two' } })).toBeNull();
    expect(logGeneration(null)).toBeNull();
    expect(logGeneration('<!doctype html>')).toBeNull();
  });
});

describe('the heal refuses to undo a reset', () => {
  const log = (generation: number, ids: string[]): unknown => ({
    schema: 'refworld.session',
    version: 1,
    epoch: 'public-meridian',
    room: 'abcd',
    startedAt: new Date(0).toISOString(),
    config: { store: 'live', generation },
    events: ids.map((id) => ({ t: 0, k: 'drawing', id, strokes: [] })),
  });

  const fetchFor = (body: unknown, calls: string[]): typeof globalThis.fetch =>
    (async (input: unknown, init?: { method?: string }) => {
      calls.push(init?.method ?? 'GET');
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

  it('heals as it always did inside the same generation', async () => {
    const calls: string[] = [];
    const outcome = await healStore(
      'meridian',
      { id: 'd-phone', name: null, strokes: [1], epoch: 'w-meridian-g1' },
      { fetch: fetchFor(log(1, []), calls) },
    );
    expect(outcome).toBe('healed');
    expect(calls).toEqual(['GET', 'POST']);
  });

  it('does not post a drawing from an older generation', async () => {
    // The reset released this device's claim, so the POST would SUCCEED —
    // which is exactly why the check has to be here and not on the server.
    const calls: string[] = [];
    const outcome = await healStore(
      'meridian',
      { id: 'd-phone', name: null, strokes: [1], epoch: 'w-meridian-g0' },
      { fetch: fetchFor(log(1, []), calls) },
    );
    expect(outcome).toBe('old-generation');
    expect(calls).toEqual(['GET']);
  });

  it('is unaffected by a deployment that says nothing about generations', async () => {
    const calls: string[] = [];
    const body = log(0, []) as { config: Record<string, unknown> };
    delete body.config['generation'];
    const outcome = await healStore(
      'meridian',
      { id: 'd-phone', name: null, strokes: [1], epoch: 'w-meridian' },
      { fetch: fetchFor(body, calls) },
    );
    expect(outcome).toBe('healed');
  });
});
