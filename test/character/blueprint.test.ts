/**
 * THE BLUEPRINT SEAM (src/character/blueprint.ts) — the pure half of building
 * a creature, lifted out so a worker can run it.
 *
 * The contract this file exists to pin is the one PLAN §1 calls load-bearing:
 * SAME STROKES → IDENTICAL MESH. A creature built from a blueprint has to be
 * bit-for-bit the creature `createCharacter` builds on its own, or the phone's
 * portrait and the world's creature are two different animals and the whole
 * reason the phone renders locally is gone.
 *
 * So: the blueprint is deterministic, it is identical across "threads" (the
 * worker runs the same module — its entry point is checked to hold no logic
 * of its own), a character built from it matches the inline build vertex for
 * vertex, and the pool answers the same thing with workers and without.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, type Object3D } from 'three';
import {
  blueprintTransferables,
  buildBlueprint,
  currentDials,
  type CreatureBlueprint,
} from '../../src/character/blueprint';
import { createCharacter } from '../../src/character/character';
import { identitySeedOf, setBodyOvoid, bodyOvoid } from '../../src/character/interpret';
import { createBlueprintPool, poolSize, MAX_WORKERS } from '../../src/character/blueprintPool';
import type { StrokeList } from '../../src/shape/types';
import { circleBlob, snowman } from '../fixtures/strokes';

const DIALS = { fidelity: 1, identitySeed: undefined, ovoid: bodyOvoid() };

function bodyOf(object: Object3D): Mesh {
  const mesh = object.children.find((o): o is Mesh => o instanceof Mesh);
  if (!mesh) throw new Error('no body mesh');
  return mesh;
}

function attr(mesh: Mesh, name: string): Float32Array {
  const a = mesh.geometry.getAttribute(name);
  return new Float32Array(a.array as ArrayLike<number>);
}

describe('buildBlueprint', () => {
  it('is deterministic — twice over the same strokes is the same mesh', () => {
    const a = buildBlueprint(snowman, DIALS)!;
    const b = buildBlueprint(snowman, DIALS)!;
    expect(a.mesh.positions).toEqual(b.mesh.positions);
    expect(a.mesh.normals).toEqual(b.mesh.normals);
    expect(a.mesh.indices).toEqual(b.mesh.indices);
    expect(a.interpreted.analysis.archetype).toBe(b.interpreted.analysis.archetype);
  });

  it('answers null for a drawing with no usable ink', () => {
    expect(buildBlueprint([], DIALS)).toBeNull();
  });

  it('takes the identity salt as an ARGUMENT, so two ids differ', () => {
    const one = buildBlueprint(snowman, { ...DIALS, identitySeed: identitySeedOf('alice') })!;
    const two = buildBlueprint(snowman, { ...DIALS, identitySeed: identitySeedOf('bob') })!;
    expect(one.mesh.positions).not.toEqual(two.mesh.positions);
    // …and the same id reproduces exactly.
    const again = buildBlueprint(snowman, { ...DIALS, identitySeed: identitySeedOf('alice') })!;
    expect(again.mesh.positions).toEqual(one.mesh.positions);
  });

  it('takes the ovoid dial as an ARGUMENT and never reads the module override', () => {
    // The dial a worker would have no way of knowing about. `currentDials` is
    // the one reader; `buildBlueprint` must honour what it is handed, so a
    // worker's copy of the module cannot disagree with this thread's.
    const plain = buildBlueprint(circleBlob, { ...DIALS, ovoid: 0 })!;
    setBodyOvoid(1);
    try {
      const sameArgs = buildBlueprint(circleBlob, { ...DIALS, ovoid: 0 })!;
      expect(sameArgs.mesh.positions).toEqual(plain.mesh.positions);
      // And `currentDials` is what picks the override up, on this thread.
      expect(currentDials(1, undefined).ovoid).toBe(1);
      const pulled = buildBlueprint(circleBlob, currentDials(1, undefined))!;
      expect(pulled.mesh.positions).not.toEqual(plain.mesh.positions);
    } finally {
      setBodyOvoid(null);
    }
  });

  it('names every buffer it holds as transferable, once each', () => {
    const blueprint = buildBlueprint(snowman, DIALS)!;
    const buffers = blueprintTransferables(blueprint);
    expect(buffers.length).toBeGreaterThan(0);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(buffers).toContain(blueprint.mesh.positions.buffer);
    expect(buffers).toContain(blueprint.mesh.indices.buffer);
    expect(buffers).toContain(blueprint.interpreted.analysis.mask.data.buffer);
  });
});

describe('createCharacter through a blueprint', () => {
  it('builds the identical body, vertex for vertex', () => {
    for (const [name, strokes] of [
      ['snowman', snowman],
      ['blob', circleBlob],
    ] as [string, StrokeList][]) {
      const inline = createCharacter(strokes, 1, { identity: name, markingSize: 64 })!;
      const blueprint = buildBlueprint(strokes, currentDials(1, identitySeedOf(name)))!;
      const handed = createCharacter(strokes, 1, {
        identity: name,
        markingSize: 64,
        blueprint,
      })!;
      const a = bodyOf(inline.group);
      const b = bodyOf(handed.group);
      expect(attr(b, 'position')).toEqual(attr(a, 'position'));
      expect(attr(b, 'normal')).toEqual(attr(a, 'normal'));
      expect(b.scale.x).toBe(a.scale.x);
      expect(b.position.y).toBe(a.position.y);
      // The things read off the interpretation, not the mesh: the colourway
      // (off the motifs) and the archetype (which picks the gait).
      expect(handed.palette.name).toBe(inline.palette.name);
      expect(handed.analysis.archetype).toBe(inline.analysis.archetype);
      expect(handed.radius).toBe(inline.radius);
      inline.dispose();
      handed.dispose();
    }
  });

  it('is still null for a drawing the pipeline refuses', () => {
    expect(createCharacter([], 1, {})).toBeNull();
  });
});

describe('the blueprint pool', () => {
  it('leaves a core for the renderer, and never takes more than four', () => {
    expect(poolSize(1)).toBe(0);
    expect(poolSize(2)).toBe(1);
    expect(poolSize(5)).toBe(4);
    expect(poolSize(32)).toBe(MAX_WORKERS);
    expect(poolSize(undefined)).toBe(0);
  });

  it('builds on this thread when there are no workers, with the same answer', async () => {
    const pool = createBlueprintPool({ concurrency: 1 });
    expect(pool.workers()).toBe(0);
    const built = await pool.build(snowman, currentDials(1, identitySeedOf('x')));
    const here = buildBlueprint(snowman, currentDials(1, identitySeedOf('x')))!;
    expect(built!.mesh.positions).toEqual(here.mesh.positions);
    pool.dispose();
  });

  it('runs a stub worker for every job, round robin', async () => {
    // The worker's own entry point is a message handler around
    // `buildBlueprint` and nothing else, so a stub that calls the same
    // function is the same worker — what is under test here is the pool's
    // queueing, not the pipeline.
    const seen: number[] = [];
    let made = 0;
    const pool = createBlueprintPool({
      concurrency: 3,
      factory: () => {
        const which = made++;
        const worker = {
          onmessage: null as ((e: MessageEvent) => void) | null,
          onerror: null as (() => void) | null,
          postMessage(request: { id: number; strokes: StrokeList; dials: typeof DIALS }): void {
            seen.push(which);
            const blueprint = buildBlueprint(request.strokes, request.dials);
            queueMicrotask(() => {
              worker.onmessage?.({ data: { id: request.id, blueprint } } as MessageEvent);
            });
          },
          terminate(): void {},
        };
        return worker as unknown as Worker;
      },
    });
    expect(pool.workers()).toBe(2);
    const dials = currentDials(1, identitySeedOf('y'));
    const results = await Promise.all([
      pool.build(snowman, dials),
      pool.build(snowman, dials),
      pool.build(snowman, dials),
    ]);
    expect(seen).toEqual([0, 1, 0]);
    const here = buildBlueprint(snowman, dials)!;
    for (const r of results as CreatureBlueprint[]) {
      expect(r.mesh.positions).toEqual(here.mesh.positions);
    }
    pool.dispose();
  });

  it('falls back to this thread when a worker cannot be made at all', async () => {
    const pool = createBlueprintPool({
      concurrency: 8,
      factory: () => {
        throw new Error('no workers here');
      },
    });
    expect(pool.workers()).toBe(0);
    expect(await pool.build(snowman, DIALS)).not.toBeNull();
    pool.dispose();
  });

  it('rebuilds here when a worker answers nothing', async () => {
    // A crashed worker's jobs resolve null; a creature must not be lost to
    // that, so the pool re-asks on this thread.
    const pool = createBlueprintPool({
      concurrency: 2,
      factory: () => {
        const worker = {
          onmessage: null as ((e: MessageEvent) => void) | null,
          onerror: null as (() => void) | null,
          postMessage(request: { id: number }): void {
            queueMicrotask(() => {
              worker.onmessage?.({ data: { id: request.id, blueprint: null } } as MessageEvent);
            });
          },
          terminate(): void {},
        };
        return worker as unknown as Worker;
      },
    });
    const built = await pool.build(snowman, DIALS);
    expect(built).not.toBeNull();
    pool.dispose();
  });
});
