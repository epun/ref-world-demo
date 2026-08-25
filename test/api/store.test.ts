/**
 * The public world's server half.
 *
 * Three rules live here and nowhere else, so they are pinned here:
 *
 *   1. the moderator gate FAILS CLOSED — an unset or short secret refuses,
 *      because the alternative is an endpoint that opens itself the moment
 *      someone forgets an environment variable;
 *   2. a world id from a url is a name, not a key expression;
 *   3. with no store configured every call is a quiet no-op, so the
 *      deployment behaves exactly as it does today rather than erroring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deviceDrawing,
  hasStore,
  isModerator,
  readDrawings,
  worldKey,
} from '../../api/_store';

const ENV_KEYS = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'MODERATOR_SECRET',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the moderator gate', () => {
  it('refuses when no secret is set', () => {
    expect(isModerator('anything')).toBe(false);
    expect(isModerator(undefined)).toBe(false);
  });

  it('refuses a secret too short to be one', () => {
    // A one-character secret is a typo, not a policy. Refusing short
    // secrets outright means a misconfiguration cannot become an opening.
    process.env['MODERATOR_SECRET'] = 'short';
    expect(isModerator('short')).toBe(false);
  });

  it('accepts the right secret and rejects the wrong one', () => {
    process.env['MODERATOR_SECRET'] = 'a-long-enough-secret';
    expect(isModerator('a-long-enough-secret')).toBe(true);
    expect(isModerator('a-long-enough-secreT')).toBe(false);
    expect(isModerator('')).toBe(false);
    expect(isModerator(undefined)).toBe(false);
  });

  it('reads the first value when a header arrives repeated', () => {
    process.env['MODERATOR_SECRET'] = 'a-long-enough-secret';
    expect(isModerator(['a-long-enough-secret', 'junk'])).toBe(true);
  });
});

describe('a world id is a name', () => {
  it('keeps ordinary names', () => {
    expect(worldKey('public')).toBe('public');
    expect(worldKey('ref-2026')).toBe('ref-2026');
  });

  it('strips anything that is not one, and never yields an empty key', () => {
    expect(worldKey('Public World!')).toBe('publicworld');
    expect(worldKey('../../etc')).toBe('etc');
    expect(worldKey('refworld:*')).toBe('refworld');
    expect(worldKey('')).toBe('public');
    expect(worldKey(null)).toBe('public');
    expect(worldKey(undefined)).toBe('public');
  });

  it('bounds the length', () => {
    expect(worldKey('a'.repeat(200)).length).toBe(24);
  });
});

describe('with no store configured', () => {
  it('reports itself absent rather than throwing', () => {
    expect(hasStore()).toBe(false);
  });

  it('reads empty and claims nothing', async () => {
    await expect(readDrawings('public')).resolves.toEqual([]);
    await expect(deviceDrawing('public', 'phone-a')).resolves.toBeNull();
  });
});
