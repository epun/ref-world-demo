/**
 * The placement seed (ghost panel control): the same rules growing a
 * different world.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  computePlacements,
  SCATTER_SEED,
  scatterSeed,
  setScatterSeed,
} from '../../src/world/scatter';

const key = (): string =>
  computePlacements()
    .map((p) => `${p.kind}:${p.x.toFixed(3)},${p.z.toFixed(3)}`)
    .join('|');

afterEach(() => setScatterSeed(SCATTER_SEED));

describe('placement seed', () => {
  it('ships unchanged — a session that never touches the control is the old world', () => {
    expect(scatterSeed()).toBe(SCATTER_SEED);
  });

  it('is deterministic: the same seed always grows the same world', () => {
    setScatterSeed(42);
    const a = key();
    setScatterSeed(9);
    setScatterSeed(42);
    expect(key()).toBe(a);
  });

  it('re-rolls: a different seed moves the placements', () => {
    setScatterSeed(SCATTER_SEED);
    const shipped = key();
    setScatterSeed(SCATTER_SEED + 37);
    expect(key()).not.toBe(shipped);
  });

  it('still produces a populated world at other seeds', () => {
    for (const seed of [1, 23, 88, 200]) {
      setScatterSeed(seed);
      const placements = computePlacements();
      expect(placements.length).toBeGreaterThan(20);
      // The landing field stays open paper at every seed (the clearing).
      const nearOrigin = placements.filter((p) => Math.hypot(p.x, p.z) < 6);
      expect(nearOrigin).toHaveLength(0);
    }
  });

  it('floors a fractional seed — a seed is an identity, not a magnitude', () => {
    setScatterSeed(12.9);
    expect(scatterSeed()).toBe(12);
  });
});
