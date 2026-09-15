/**
 * Break-apart chunk tests — pure: the builders run headless and the chunk
 * geometry is inspected as data. No WebGL, no DOM.
 *
 * Two things are being pinned here. First the chunks themselves: every
 * breakable kind comes apart into the authored number of pieces, staged,
 * sitting inside the prop they came from, and identical on a second build
 * (a fragment that flies off differently on two handsets is a desync you
 * can see). Second, and easier to break by accident: the WHOLE prop is
 * unchanged. The arch builders were refactored to hand their parts back
 * before the merge, and the merged geometry has to stay identical to the
 * float — the snapshot below was captured from the code BEFORE that
 * refactor.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChunkGeometries,
  CHUNK_KINDS,
  type Chunk,
  type ChunkKind,
} from '../../src/world/chunks';
import { buildPropGeometries, type PropKind } from '../../src/world/props';

/** How many pieces each kind comes apart into — an exact count, or a
 * range for the buildings (a family's chunks are its own parts grouped,
 * and the count varies with how many groups the family has). */
const EXPECTED_COUNT: Record<ChunkKind, [number, number]> = {
  monolith: [4, 4],
  mountain: [5, 5],
  rock: [3, 3],
  building: [3, 6],
  waterTower: [3, 3],
  picnicTable: [3, 3],
  tree: [2, 2],
  conifer: [2, 2],
  palm: [2, 2],
};

/** The stages a kind's chunks must cover. Rock and monolith shatter at
 * once; the trees are crown-then-trunk; everything else collapses in three
 * stages. */
const EXPECTED_STAGES: Record<ChunkKind, number[]> = {
  monolith: [2],
  mountain: [0, 1, 2],
  rock: [2],
  building: [0, 1, 2],
  waterTower: [0, 1, 2],
  picnicTable: [0, 1, 2],
  tree: [0, 2],
  conifer: [0, 2],
  palm: [0, 2],
};

const CHUNKS = buildChunkGeometries();
const PROPS = buildPropGeometries();

function positions(chunk: Chunk): Float32Array {
  return chunk.geometry.getAttribute('position').array as Float32Array;
}

describe('chunk coverage', () => {
  it('covers every breakable kind', () => {
    expect([...CHUNKS.keys()].sort()).toEqual([...CHUNK_KINDS].sort());
  });

  for (const kind of CHUNK_KINDS) {
    it(`${kind} breaks every variant into the authored pieces`, () => {
      const variants = CHUNKS.get(kind)!;
      const props = PROPS.get(kind as PropKind)!;
      expect(variants.length).toBe(props.length);
      const [lo, hi] = EXPECTED_COUNT[kind];
      for (const chunks of variants) {
        expect(chunks.length).toBeGreaterThanOrEqual(lo);
        expect(chunks.length).toBeLessThanOrEqual(hi);
      }
    });

    it(`${kind} stages its collapse`, () => {
      for (const chunks of CHUNKS.get(kind)!) {
        const stages = [...new Set(chunks.map((c) => c.stage))].sort();
        expect(stages).toEqual(EXPECTED_STAGES[kind]);
      }
    });

    it(`${kind} chunks are real geometry with normals`, () => {
      for (const chunks of CHUNKS.get(kind)!) {
        for (const chunk of chunks) {
          expect(positions(chunk).length).toBeGreaterThan(0);
          const normal = chunk.geometry.getAttribute('normal');
          expect(normal).toBeTruthy();
          expect(normal.count).toBe(chunk.geometry.getAttribute('position').count);
          expect(chunk.radius).toBeGreaterThan(0);
          expect(chunk.geometry.boundingBox).toBeTruthy();
          // Re-centred on its own origin: the box centre is (0,0,0).
          const box = chunk.geometry.boundingBox!;
          for (const axis of ['x', 'y', 'z'] as const) {
            expect(Math.abs(box.min[axis] + box.max[axis]) / 2).toBeLessThan(1e-4);
          }
        }
      }
    });

    it(`${kind} chunks sit inside the prop they came from`, () => {
      const variants = CHUNKS.get(kind)!;
      const props = PROPS.get(kind as PropKind)!;
      variants.forEach((chunks, i) => {
        const geometry = props[i]!.geometry;
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!;
        const pad = 0.1;
        for (const chunk of chunks) {
          for (const axis of ['x', 'y', 'z'] as const) {
            const span = Math.max(box.max[axis] - box.min[axis], 1e-6);
            expect(chunk.offset[axis]).toBeGreaterThanOrEqual(box.min[axis] - span * pad);
            expect(chunk.offset[axis]).toBeLessThanOrEqual(box.max[axis] + span * pad);
          }
        }
      });
    });
  }

  it('the lumps are smaller than the prop, and roughly fill it', () => {
    for (const kind of ['monolith', 'mountain', 'rock'] as const) {
      const props = PROPS.get(kind)!;
      CHUNKS.get(kind)!.forEach((chunks, i) => {
        const height = props[i]!.height;
        for (const chunk of chunks) {
          const box = chunk.geometry.boundingBox!;
          const lumpH = box.max.y - box.min.y;
          // 0.45–0.6 of the parent, with the seeded jitter inside that band.
          expect(lumpH / height).toBeGreaterThan(0.44);
          expect(lumpH / height).toBeLessThan(0.61);
        }
      });
    }
  });

  it('a tree splits into a crown over a trunk', () => {
    for (const kind of ['tree', 'conifer'] as const) {
      for (const chunks of CHUNKS.get(kind)!) {
        const crown = chunks.find((c) => c.stage === 0)!;
        const trunk = chunks.find((c) => c.stage === 2)!;
        expect(crown.offset.y).toBeGreaterThan(trunk.offset.y);
        // The crown is the mass; the trunk is the stick under it.
        expect(positions(crown).length).toBeGreaterThan(positions(trunk).length);
      }
    }
  });
});

describe('chunk determinism', () => {
  it('two builds are byte-identical', () => {
    const again = buildChunkGeometries();
    for (const kind of CHUNK_KINDS) {
      const a = CHUNKS.get(kind)!;
      const b = again.get(kind)!;
      expect(b.length).toBe(a.length);
      a.forEach((chunks, i) => {
        const other = b[i]!;
        expect(other.length).toBe(chunks.length);
        chunks.forEach((chunk, k) => {
          const twin = other[k]!;
          expect(twin.stage).toBe(chunk.stage);
          expect(twin.radius).toBe(chunk.radius);
          expect(twin.offset).toEqual(chunk.offset);
          expect(Array.from(positions(twin))).toEqual(Array.from(positions(chunk)));
        });
      });
    }
  });

  it('uses no unseeded randomness', () => {
    const source = readFileSync(join(process.cwd(), 'src/world/chunks.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/performance\.now/);
  });

  it('builds inside the init budget', () => {
    // Informational: the budget is ~150ms in node, and the number moves
    // with the machine — the assertion is loose on purpose, the printed
    // line is the thing to watch.
    const t0 = Date.now();
    buildChunkGeometries();
    const ms = Date.now() - t0;
    console.log(`buildChunkGeometries(): ${ms}ms`);
    expect(ms).toBeLessThan(1500);
  });
});

/**
 * Captured from `buildPropGeometries()` BEFORE the arch builders were
 * refactored to return their parts: the position array's length and an
 * FNV-1a hash of its first 300 floats, per variant. The refactor must not
 * move a single float of the whole prop.
 */
const WHOLE_PROP_SNAPSHOT: Partial<Record<PropKind, { count: number; hash: string }[]>> = {
  building: [
    { count: 56016, hash: '94f77221' },
    { count: 16308, hash: '4d215e64' },
    { count: 27378, hash: '0052cb7b' },
    { count: 43884, hash: 'd130a97a' },
    { count: 9792, hash: '11e394c2' },
    { count: 9288, hash: 'cf9a68f2' },
    { count: 7776, hash: 'd887710b' },
    { count: 7812, hash: '9acb928f' },
    { count: 9900, hash: '5cc40696' },
  ],
  waterTower: [
    { count: 10008, hash: '8aedc6bc' },
    { count: 10008, hash: '299df5c5' },
  ],
  picnicTable: [
    { count: 9396, hash: 'f7fdfbd0' },
    { count: 9396, hash: 'd535e1e6' },
  ],
  palm: [
    { count: 4752, hash: '51857aef' },
    { count: 4536, hash: 'ce4bb7da' },
    { count: 4968, hash: '2f46494f' },
  ],
};

/** FNV-1a over the first `n` floats, little-endian. */
function hashFloats(values: Float32Array, n: number): string {
  let h = 0x811c9dc5;
  const view = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < Math.min(n, values.length); i++) {
    view.setFloat32(0, values[i]!, true);
    for (let b = 0; b < 4; b++) {
      h ^= view.getUint8(b);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

describe('the whole prop is unchanged by the parts refactor', () => {
  for (const [kind, expected] of Object.entries(WHOLE_PROP_SNAPSHOT)) {
    it(`${kind} builds the same geometry it always did`, () => {
      const variants = PROPS.get(kind as PropKind)!;
      expect(variants.length).toBe(expected!.length);
      variants.forEach((variant, i) => {
        const array = variant.geometry.getAttribute('position').array as Float32Array;
        expect({ count: array.length, hash: hashFloats(array, 300) }).toEqual(expected![i]);
      });
    });
  }
});
