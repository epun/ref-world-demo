/**
 * The one line a deployment with no store says about itself.
 *
 * The failure it exists for happened for real (user report, 2026-09-09): a
 * client world whose kv integration was never connected answered every
 * submission with 503 and every read with an empty list, so the pad walked
 * people to their egg, the world view opened on an empty field, and nothing
 * anywhere said a word. api/drawings.ts has reported which it is since the
 * beginning — `config.store` — and nobody read it.
 */

import { describe, expect, it } from 'vitest';
import { storeNote } from '../../src/world/storeline';

describe('storeNote', () => {
  it('says so when the api reports no store', () => {
    const line = storeNote({ store: 'none' }, 'meridian');
    expect(line).toBe('meridian has no store — nothing drawn here is being kept');
  });

  it('is silent on a live store — the normal world says nothing about itself', () => {
    expect(storeNote({ store: 'live' }, 'meridian')).toBeNull();
  });

  it('is silent when the log carries no store key at all', () => {
    // An older log, a replayed session, a hand-written fixture. A world is
    // only ever accused of losing drawings when it has said so itself.
    expect(storeNote({ hatchMs: 20000, public: true }, 'meridian')).toBeNull();
    expect(storeNote({}, 'meridian')).toBeNull();
    expect(storeNote(null, 'meridian')).toBeNull();
    expect(storeNote(undefined, 'meridian')).toBeNull();
  });

  it('names the world, and has a name for the world with no name', () => {
    expect(storeNote({ store: 'none' }, 'public')).toMatch(/^public /);
    expect(storeNote({ store: 'none' }, '')).toBe(
      'this world has no store — nothing drawn here is being kept',
    );
  });

  it('never shouts — no uppercase type anywhere in this world (TASTE §5)', () => {
    for (const world of ['meridian', 'public', '']) {
      const line = storeNote({ store: 'none' }, world);
      expect(line).not.toBeNull();
      expect(line).toBe(line!.toLowerCase());
    }
  });
});
