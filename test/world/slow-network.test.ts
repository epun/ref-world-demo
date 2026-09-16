/**
 * THE SLOW LINK — what a page may stop paying for, and what it may not.
 *
 * > User ask, 2026-09-16: *"we need to be able to run this on a slow network
 * > on people's devices."*
 *
 * Measured first (`scratch/slow-network.mjs`, at 1.5 Mbit/s down / 150 ms):
 * 5.5 MB over the wire on the phone's world view, of which 4.06 MB was the
 * object library, 0.76 MB was rapier — on a PHONE, because a phone alone in
 * a room hosts — and 0.60 MB the app. The library was fully attached at
 * 50.4 seconds.
 *
 * The levers taken are ORDER and CACHING, never content (2026-09-16 user
 * ruling: *"load everything"*) — so no page anywhere loads fewer models than
 * any other, and what this file pins is the two rules that are pure
 * arithmetic:
 *
 *   `physicsExpectedFor` — who may load rapier at all, and the one flag that
 *                          gives it back to the phones;
 *   `modelUrl`           — the content hash that makes a one-year `immutable`
 *                          cache safe.
 *
 * The behavioural half — a phone host with no rigid bodies, still picking
 * things up — is `test/creatures/phone-host.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { PHONE_RUNS_RAPIER, physicsExpectedFor } from '../../src/world/device';
import { KATAMARI_CATALOG } from '../../src/world/katamari/catalog';
import { modelUrl } from '../../src/world/katamari/models';

describe('who loads rapier', () => {
  it('nobody, in a world without the game — whatever the screen is', () => {
    expect(physicsExpectedFor('none', 'projection')).toBe(false);
    expect(physicsExpectedFor('none', 'phone')).toBe(false);
  });

  it('a projection on the katamari world, and not a handset', () => {
    expect(physicsExpectedFor('katamari', 'projection')).toBe(true);
    // The whole point: 760 kb compressed, paid by every phone testing alone.
    expect(physicsExpectedFor('katamari', 'phone')).toBe(false);
  });

  it('is ONE flag, so the phones can be given it back', () => {
    // The user asked for this to be reversible (2026-09-16): nothing else in
    // the codebase branches on the tier for physics, so flipping this
    // constant restores exactly what shipped before.
    expect(PHONE_RUNS_RAPIER).toBe(false);
    expect(physicsExpectedFor('katamari', 'phone')).toBe(PHONE_RUNS_RAPIER);
    // …and it still cannot reach a world without the game.
    expect(physicsExpectedFor('none', 'projection')).toBe(false);
  });
});

describe('the models are cached by content', () => {
  it('carries a content hash on every published row', () => {
    // `--verify` checks the hash against the file; this checks that the
    // generated table has one at all, which is what makes the url movable.
    for (const row of KATAMARI_CATALOG) {
      expect(row.hash, `${row.id} ${row.file}`).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('puts it in the url, so a re-curation can never serve a stale model', () => {
    const row = KATAMARI_CATALOG[0]!;
    expect(modelUrl('/katamari', row)).toBe(`/katamari/models/${row.file}?v=${row.hash}`);
    // A row with no hash asks for the bare path and is simply cached less
    // aggressively than it could be.
    const { hash: _dropped, ...bare } = row;
    expect(modelUrl('/katamari', bare)).toBe(`/katamari/models/${row.file}`);
  });

  it('gives two different models two different urls', () => {
    const urls = new Set(KATAMARI_CATALOG.map((r) => modelUrl('/katamari', r)));
    expect(urls.size).toBe(KATAMARI_CATALOG.length);
  });
});
