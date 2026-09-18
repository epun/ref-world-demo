/**
 * Debris (src/world/debris.ts) — the VIEWER's half, which is the half every
 * page runs.
 *
 * No rapier here on purpose. A viewer holds no physics world at all
 * (docs/PLAN.md §7.6), so `physics`/`bodies` return null and what is left is
 * exactly what this module owes every page: one mesh per fragment, seated
 * where its chunk sat in the prop, with a lifetime and a cap over it. The
 * host's bodies are pinned where the bodies live (test/world/rocks.test.ts).
 *
 * The two bounds are the assertions worth reading twice, because they are the
 * brief's own: *"debris has LIFETIMES… never grows without bound"*, and
 * nothing in this project may pop — an expired fragment SINKS out of the
 * world over `MOTION.primaryMs` (TASTE §2.1, confidence 1.00).
 */

import { BoxGeometry, Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { MOTION } from '../../src/taste/tokens';
import { createDebris } from '../../src/world/debris';
import type { Chunk, ChunkKind } from '../../src/world/chunks';
import { DEBRIS_CAP } from '../../src/world/device';
import type { LooseMeshes, LooseRotation } from '../../src/world/loose';
import type { Surface } from '../../src/world/surface';

const flat: Surface = {
  sampleHeight: () => 0,
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
};

/** Five chunks, offset along +x so each has an outward direction of its own. */
function chunkSet(): Map<ChunkKind, Chunk[][]> {
  const chunks: Chunk[] = [0, 1, 2, 3, 4].map((i) => ({
    geometry: new BoxGeometry(1, 1, 1),
    offset: { x: i + 1, y: 0.5 + i, z: 0 },
    radius: 0.5,
    stage: (i < 2 ? 0 : 2) as 0 | 2,
  }));
  const out = new Map<ChunkKind, Chunk[][]>();
  out.set('building', [chunks]);
  out.set('rock', [chunks]);
  return out;
}

/** A `LooseMeshes` that records what was shown and where it was put. */
function stubLoose(): {
  api: LooseMeshes;
  shown: string[];
  removed: string[];
  at: Map<string, Object3D>;
} {
  const shown: string[] = [];
  const removed: string[] = [];
  const at = new Map<string, Object3D>();
  return {
    shown,
    removed,
    at,
    api: {
      retryMissing(): void {
        /* the real one hands late-arriving geometry over; the stub has none */
      },
      show(item: string): Object3D {
        const existing = at.get(item);
        if (existing) return existing;
        shown.push(item);
        const object = new Object3D();
        at.set(item, object);
        return object;
      },
      move(item: string, x: number, y: number, z: number, q: LooseRotation): void {
        const object = at.get(item);
        if (!object) return;
        object.position.set(x, y, z);
        object.quaternion.set(q.x, q.y, q.z, q.w);
      },
      remove(item: string): void {
        removed.push(item);
        at.delete(item);
      },
      get(item: string): Object3D | undefined {
        return at.get(item);
      },
      dispose(): void {},
    },
  };
}

function viewerDebris(tier: 'projection' | 'phone' = 'projection'): {
  debris: ReturnType<typeof createDebris>;
  loose: ReturnType<typeof stubLoose>;
} {
  const loose = stubLoose();
  const debris = createDebris({
    physics: () => null,
    bodies: () => null,
    loose: loose.api,
    surface: flat,
    chunks: chunkSet,
    tier,
  });
  return { debris, loose };
}

const PARENT = {
  key: 'building:0:12.00:-6.00',
  kind: 'building' as const,
  variant: 0,
  scale: 2,
  x: 12,
  z: -6,
  rotY: 0,
};

describe('spawning fragments', () => {
  it('draws one mesh per chunk, under the chunk item id the wire uses', () => {
    const { debris, loose } = viewerDebris();
    const items = debris.spawnFragments(PARENT, [0, 1, 2], { impact: 10 });
    expect(items.length).toBe(3);
    expect(loose.shown).toEqual([
      'building:0:12.00:-6.00#0',
      'building:0:12.00:-6.00#1',
      'building:0:12.00:-6.00#2',
    ]);
    expect(debris.count()).toBe(3);
    expect(debris.has('building:0:12.00:-6.00#1')).toBe(true);
  });

  it('seats each fragment where its chunk sat in the prop, at the instance scale', () => {
    const { debris, loose } = viewerDebris();
    debris.spawnFragments(PARENT, [0], {});
    const object = loose.at.get('building:0:12.00:-6.00#0')!;
    // Offset (1, 0.5, 0) at scale 2, with no yaw, off the parent's place —
    // and the height comes from the Surface seam under the prop.
    expect(object.position.x).toBeCloseTo(12 + 2, 6);
    expect(object.position.y).toBeCloseTo(1, 6);
    expect(object.position.z).toBeCloseTo(-6, 6);
  });

  it('turns the seat by the placement yaw', () => {
    const { debris, loose } = viewerDebris();
    debris.spawnFragments({ ...PARENT, rotY: Math.PI / 2 }, [0], {});
    const object = loose.at.get('building:0:12.00:-6.00#0')!;
    // A quarter turn takes +x onto -z (the scatter's own convention).
    expect(object.position.x).toBeCloseTo(12, 5);
    expect(object.position.z).toBeCloseTo(-6 - 2, 5);
  });

  it('is idempotent per fragment — the same chunk is never drawn twice', () => {
    const { debris, loose } = viewerDebris();
    debris.spawnFragments(PARENT, [0, 0, 1], {});
    expect(loose.shown.length).toBe(2);
    expect(debris.count()).toBe(2);
  });

  it('spawns nothing for a chunk that does not exist', () => {
    const { debris, loose } = viewerDebris();
    expect(debris.spawnFragments(PARENT, [99], {})).toEqual([]);
    expect(
      debris.spawnChunk({ ...PARENT, kind: 'bush' }, 0, 0, 0, 0, { x: 0, y: 0, z: 0, w: 1 }),
    ).toBeNull();
    expect(loose.shown).toEqual([]);
  });
});

describe('the two bounds', () => {
  it('sinks an expired fragment out of the world instead of removing it', () => {
    const { debris, loose } = viewerDebris();
    // A `rock` parent, because a building's chunks are the brief's
    // "important" debris and never expire.
    const parent = { ...PARENT, kind: 'rock' as const, key: 'rock:0:1.00:1.00' };
    debris.spawnFragments(parent, [0], {});
    debris.update(16, 1000);
    const object = loose.at.get('rock:0:1.00:1.00#0')!;
    const startY = object.position.y;
    const lifetime = MOTION.ambientMs * 2;
    // Past its lifetime: the sink begins, and the piece is still there.
    debris.update(16, 1000 + lifetime + 1);
    expect(loose.removed).toEqual([]);
    debris.update(16, 1000 + lifetime + MOTION.primaryMs / 2);
    expect(object.position.y).toBeLessThan(startY);
    // …and it never comes back up on the way out (no rebound, TASTE §2.1).
    const mid = object.position.y;
    debris.update(16, 1000 + lifetime + MOTION.primaryMs * 0.75);
    expect(object.position.y).toBeLessThanOrEqual(mid);
    // Only at the end of the slide is it disposed.
    debris.update(16, 1000 + lifetime + MOTION.primaryMs + 1);
    expect(loose.removed).toEqual(['rock:0:1.00:1.00#0']);
    expect(debris.count()).toBe(0);
  });

  it('never expires an important fragment — a broken building stays broken', () => {
    const { debris, loose } = viewerDebris();
    debris.spawnFragments(PARENT, [0], {});
    debris.update(16, 1000);
    debris.update(16, 1000 + MOTION.ambientMs * 1000);
    expect(loose.removed).toEqual([]);
    expect(debris.count()).toBe(1);
  });

  it('holds the device cap, oldest first', () => {
    const { debris } = viewerDebris('phone');
    const cap = DEBRIS_CAP.phone;
    expect(cap).toBeLessThan(DEBRIS_CAP.projection);
    // More parents than the cap, one fragment each, with a frame between so
    // every piece has a birth of its own.
    for (let i = 0; i < cap + 8; i++) {
      debris.update(16, 1000 + i * 16);
      debris.spawnFragments({ ...PARENT, key: `building:0:${i}.00:0.00` }, [0], {});
    }
    debris.update(16, 2000 + cap * 16);
    expect(debris.count()).toBeLessThanOrEqual(cap);
  });

  it('disposes everything it is holding', () => {
    const { debris, loose } = viewerDebris();
    debris.spawnFragments(PARENT, [0, 1, 2, 3], {});
    debris.dispose();
    expect(debris.count()).toBe(0);
    expect(loose.removed.length).toBe(4);
  });
});
