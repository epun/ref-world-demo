/**
 * Wreck bookkeeping (src/world/wreck.ts) — pure, so pinned directly.
 *
 * The two properties that the event format depends on are the ones worth
 * reading twice: `advance` is MONOTONIC (a stage can only move forward) and
 * IDEMPOTENT (arriving at stage 3 in one step frees exactly what arriving in
 * three steps freed, and nothing twice). A `crack` carries an absolute stage
 * and `compactScene` keeps only the last one per item, so a phone that joins
 * late hears "stage 3" alone and has to land where the projection did.
 */

import { BoxGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  advance,
  createWreck,
  fragmentSpread,
  freedAtStage,
  intact,
  type WreckState,
} from '../../src/world/wreck';
import type { Chunk } from '../../src/world/chunks';

/** Chunks with the authored stages a real family has: a section that goes
 * first, a couple that follow, and a foot that only goes in the collapse. */
function chunks(): Chunk[] {
  const stages: (0 | 1 | 2)[] = [0, 0, 1, 2, 2];
  return stages.map((stage, i) => ({
    geometry: new BoxGeometry(1, 1, 1),
    offset: { x: i, y: i * 0.5, z: -i },
    radius: 0.5,
    stage,
  }));
}

function wreck(): WreckState {
  return createWreck({
    key: 'building:0:10.00:-4.00',
    kind: 'building',
    variant: 0,
    scale: 2,
    x: 10,
    z: -4,
    rotY: 0.3,
  });
}

describe('freedAtStage', () => {
  it('frees nothing at stage 1 — a crack is a mark on a standing building', () => {
    expect(freedAtStage(chunks(), 0)).toEqual([]);
    expect(freedAtStage(chunks(), 1)).toEqual([]);
  });

  it('frees the authored first section at stage 2, whatever order it is listed in', () => {
    expect(freedAtStage(chunks(), 2)).toEqual([0, 1]);
  });

  it('frees everything at stage 3 — rubble has to mean rubble', () => {
    expect(freedAtStage(chunks(), 3)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('advance', () => {
  it('opens intact and frees nothing', () => {
    const state = wreck();
    expect(state.stage).toBe(0);
    expect(state.removed.size).toBe(0);
    const change = advance(state, 1, chunks());
    expect(change.freed).toEqual([]);
    expect(change.standing).toEqual([0, 1, 2, 3, 4]);
    expect(state.stage).toBe(1);
  });

  it('frees each chunk exactly once across the three stages', () => {
    const state = wreck();
    const set = chunks();
    expect(advance(state, 1, set).freed).toEqual([]);
    expect(advance(state, 2, set).freed).toEqual([0, 1]);
    // Asked again for the stage it is already in: nothing more has gone.
    expect(advance(state, 2, set).freed).toEqual([]);
    expect(advance(state, 3, set).freed).toEqual([2, 3, 4]);
    expect(advance(state, 3, set).freed).toEqual([]);
    expect(state.removed.size).toBe(set.length);
  });

  it('lands a page that heard only stage 3 exactly where a page that heard all three did', () => {
    const stepped = wreck();
    const set = chunks();
    const all: number[] = [];
    for (const stage of [1, 2, 3] as const) all.push(...advance(stepped, stage, set).freed);
    const jumped = wreck();
    const once = advance(jumped, 3, set).freed;
    expect([...once].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    expect(jumped.stage).toBe(stepped.stage);
    expect([...jumped.removed].sort()).toEqual([...stepped.removed].sort());
  });

  it('never goes backwards — a stale event cannot rebuild a collapsed building', () => {
    const state = wreck();
    const set = chunks();
    advance(state, 3, set);
    const change = advance(state, 1, set);
    expect(state.stage).toBe(3);
    expect(change.freed).toEqual([]);
    expect(change.standing).toEqual([]);
  });

  it('knows when there is nothing left standing', () => {
    const state = wreck();
    const set = chunks();
    expect(intact(state, set)).toBe(true);
    advance(state, 2, set);
    expect(intact(state, set)).toBe(true);
    advance(state, 3, set);
    expect(intact(state, set)).toBe(false);
  });
});

describe('fragmentSpread', () => {
  it('is deterministic in the key and the index — a collapse throws the same twice', () => {
    for (let i = 0; i < 6; i++) {
      expect(fragmentSpread('monolith:1:3.00:9.00', i)).toEqual(
        fragmentSpread('monolith:1:3.00:9.00', i),
      );
    }
  });

  it('is a unit direction, and a different one per index and per placement', () => {
    const seen = new Set<string>();
    for (const key of ['monolith:1:3.00:9.00', 'building:0:-8.00:0.00']) {
      for (let i = 0; i < 5; i++) {
        const spread = fragmentSpread(key, i);
        expect(Math.hypot(spread.x, spread.z)).toBeCloseTo(1, 6);
        seen.add(`${spread.x.toFixed(6)}:${spread.z.toFixed(6)}`);
      }
    }
    expect(seen.size).toBe(10);
  });
});
