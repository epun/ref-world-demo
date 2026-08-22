/**
 * The handset heals the world after a restart.
 *
 * This is the recovery that has to work without anybody doing anything, and
 * the one whose absence cost a real session (2026-08-20): the projection was
 * refreshed, every handset was told the world had changed, and the code's
 * answer was to send people to a blank pad and DELETE their drawing — the one
 * copy that survives a restart, destroyed by the code that noticed the
 * restart.
 *
 * The pieces under test here are the transport-level ones, because they are
 * what decides whether the message arrives at all:
 *
 *   - the epoch announce is RETAINED, so a phone that connects later still
 *     hears it. A live-only announce reaches exactly the handsets that were
 *     awake at the instant of the restart, which at a restart is the wrong
 *     set;
 *   - `isStale` recognises the new world, and only a KNOWN mismatch counts;
 *   - a resent drawing goes out in the kit's own wire shape, so the world
 *     ingests it exactly as it ingested the original publish.
 */

import { describe, expect, it, vi } from 'vitest';
import { announceEpochRetained, normalizeDrawing } from '../../src/net/drawFeed';
import { createPhoneLink, readRecall, readWorldEpoch } from '../../src/net/phoneLink';
import { isStale, type Submission } from '../../src/phone/identity';

/** A stroke in the kit's wire shape, as a handset stores it. */
const wireStrokes = [
  { color: '#000', width: 8, pts: [[0.2, 0.3] as [number, number], [0.8, 0.7] as [number, number]] },
];

function fakeFeed() {
  const sent: { topic: string; payload: string; opts: Record<string, unknown> }[] = [];
  return {
    sent,
    feed: {
      client: {
        publish(topic: string, payload: string, opts: Record<string, unknown>) {
          sent.push({ topic, payload, opts });
        },
      },
      topic: 'drawto3d/v1/demo',
      upTopic: 'drawto3d/v1/demo/up',
      setAccepting: () => true,
      publishToPhones: () => {},
      destroy: () => {},
    },
  };
}

describe('the world announces which session it is', () => {
  it('publishes the epoch RETAINED, so a phone that connects later still hears it', () => {
    const { sent, feed } = fakeFeed();
    expect(announceEpochRetained(feed, 'newworld')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe('drawto3d/v1/demo/up');
    expect(sent[0]!.opts['retain']).toBe(true);
    expect(JSON.parse(sent[0]!.payload)).toEqual({ type: 'world', epoch: 'newworld' });
  });

  it('is what a phone reads as the world epoch', () => {
    const { sent, feed } = fakeFeed();
    announceEpochRetained(feed, 'newworld');
    expect(readWorldEpoch(JSON.parse(sent[0]!.payload))).toBe('newworld');
  });

  it('never throws the world over a transport that cannot publish', () => {
    expect(announceEpochRetained(null, 'newworld')).toBe(false);
    const broken = {
      client: {
        publish() {
          throw new Error('socket closed');
        },
      },
      topic: 't',
      upTopic: 't/up',
      setAccepting: () => true,
      publishToPhones: () => {},
      destroy: () => {},
    };
    expect(announceEpochRetained(broken, 'newworld')).toBe(false);
  });

  it('says nothing when there is no epoch to say', () => {
    const { sent, feed } = fakeFeed();
    expect(announceEpochRetained(feed, '')).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe('a handset recognises a world it did not draw into', () => {
  const mine: Submission = {
    id: 'phone-a',
    name: 'ada',
    strokes: wireStrokes,
    ts: 1000,
    epoch: 'oldworld',
  };

  it('is stale against a different epoch', () => {
    expect(isStale(mine, 'newworld')).toBe(true);
  });

  it('is NOT stale against the world it drew into', () => {
    expect(isStale(mine, 'oldworld')).toBe(false);
  });

  it('is NOT stale when no world has been heard from', () => {
    // A phone out of earshot must never lose its creature by accident.
    expect(isStale(mine, null)).toBe(false);
    expect(isStale(mine, '')).toBe(false);
  });
});

describe('the resend', () => {
  /** A minimal mqtt double: records publishes, replays subscriptions. */
  function fakeMqtt() {
    const published: { topic: string; payload: string }[] = [];
    type Payload = { toString(): string };
    let handler: ((topic: string, payload: Payload) => void) | null = null;
    const client = {
      publish(topic: string, payload: string) {
        published.push({ topic, payload });
      },
      subscribe() {},
      on(event: string, fn: (topic: string, payload: Payload) => void) {
        if (event === 'message') handler = fn;
      },
      end() {},
    };
    return {
      published,
      deliver(topic: string, obj: unknown) {
        // A Buffer, not a bare Uint8Array: mqtt.js hands the page a Buffer,
        // and `Uint8Array.prototype.toString()` returns "123,34,116…" — the
        // byte list — rather than the decoded text. A double that gets this
        // wrong tests the parse failure path and calls it a bug in the code.
        handler?.(topic, Buffer.from(JSON.stringify(obj), 'utf8'));
      },
      mqtt: { connect: () => client },
    };
  }

  it('goes out in the kit wire shape the world already ingests', () => {
    const bus = fakeMqtt();
    const link = createPhoneLink('demo', 'phone-a', { mqtt: bus.mqtt });
    expect(link).not.toBeNull();
    link!.resend({ id: 'phone-a', name: 'ada', strokes: wireStrokes });

    const drawing = bus.published.find((p) => p.topic === 'drawto3d/v1/demo');
    expect(drawing).toBeDefined();
    const msg = JSON.parse(drawing!.payload);
    expect(msg.id).toBe('phone-a');
    expect(msg.name).toBe('ada');

    // The decisive assertion: the world's own ingest accepts it, under the
    // same id. Anything less and the creature comes back as a stranger.
    const normalized = normalizeDrawing(msg);
    expect(normalized).not.toBeNull();
    expect(normalized!.id).toBe('phone-a');
    expect(normalized!.name).toBe('ada');
    expect(normalized!.strokes.length).toBe(1);
  });

  it('sends an unsigned drawing with an empty name, so the world names it', () => {
    const bus = fakeMqtt();
    const link = createPhoneLink('demo', 'phone-b', { mqtt: bus.mqtt });
    link!.resend({ id: 'phone-b', name: null, strokes: wireStrokes });
    const msg = JSON.parse(
      bus.published.find((p) => p.topic === 'drawto3d/v1/demo')!.payload,
    );
    expect(msg.name).toBe('');
    expect(normalizeDrawing(msg)!.name).toBeNull();
  });

  it('answers a recall that arrives before the screen registered a handler', () => {
    // A recall lands during boot more often than not — the world broadcasts
    // it the moment an operator presses r, and a handset that was mid-load
    // must not be the one that gets away.
    const bus = fakeMqtt();
    const link = createPhoneLink('demo', 'phone-a', { mqtt: bus.mqtt });
    bus.deliver('drawto3d/v1/demo/up', { type: 'recall', epoch: 'newworld' });
    const answered = vi.fn();
    link!.onRecall(answered);
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it('reads a recall message and nothing else as one', () => {
    expect(readRecall({ type: 'recall', epoch: 'x' })).toBe(true);
    expect(readRecall({ type: 'world', epoch: 'x' })).toBe(false);
    expect(readRecall(null)).toBe(false);
  });
});
