/**
 * A few workers, a queue, and a main-thread fallback — the thing the load
 * path actually calls.
 *
 * WHAT IT IS FOR. A refreshed projection rebuilds every creature in the room
 * from its drawing (docs/RUNBOOK.md: the world heals itself), and at two
 * hundred creatures that measured **57 seconds** of main-thread time: the tab
 * was not slow, it was gone, and every phone watching it was frozen with it.
 * The expensive half is pure (`src/character/blueprint.ts`), so it goes to a
 * worker and the main thread keeps drawing the world while the field fills up.
 *
 * WHAT IT IS NOT. It is not a speed-up of one creature — one blueprint costs
 * what it costs, and a worker makes it marginally slower (the message, the
 * transfer). It is a way to spend a MACHINE on two hundred of them instead of
 * one thread, and to keep the frame loop out of it either way.
 *
 * SIZED SMALL, ON PURPOSE. `hardwareConcurrency − 1`, capped at
 * `MAX_WORKERS`: the main thread still has a world to draw at sixty frames a
 * second, and taking every core away from it to build creatures faster is the
 * wrong trade. A phone reports 4-8 and means far less than that.
 *
 * ALWAYS WORKS. No `Worker`, a blocked construction (a CSP, a file:// page, a
 * browser that will not take a module worker), a worker that fails to boot or
 * throws mid-pipeline — every one of them falls back to building on this
 * thread, which is exactly what the page did before this file existed. The
 * fallback is the shipped behaviour, not an error path.
 */

import {
  buildBlueprint,
  type BlueprintDials,
  type CreatureBlueprint,
} from './blueprint';
import type { StrokeList } from '../shape/types';

/** [D] Never more than this many workers, whatever the machine claims. Four
 * pure pipelines saturate the memory bandwidth this work is actually bound
 * by, and the fifth would be taking a core off the renderer. */
export const MAX_WORKERS = 4;

/** One job in flight. */
interface Pending {
  resolve(blueprint: CreatureBlueprint | null): void;
}

export interface BlueprintPool {
  /**
   * Build one blueprint. Resolves with null for a drawing with no usable ink
   * — the same null `createCharacter` gives — whether the work happened on a
   * worker or here.
   */
  build(strokes: StrokeList, dials: BlueprintDials): Promise<CreatureBlueprint | null>;
  /** How many workers are actually running (0 = the fallback). For the dev
   * readout and for tests. */
  workers(): number;
  /** Stop every worker. The page is going away. */
  dispose(): void;
}

/** How a worker gets made. Injected so a test can watch it, and so the one
 * `new Worker(new URL(...))` — which is what vite rewrites into a chunk —
 * lives at exactly one place. */
export type WorkerFactory = () => Worker;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./blueprint.worker.ts', import.meta.url), { type: 'module' });

/**
 * How many workers to ask for. Exported because the number is a judgement and
 * a test should be able to state it rather than discover it.
 */
export function poolSize(concurrency: number | undefined): number {
  const cores = typeof concurrency === 'number' && concurrency > 0 ? concurrency : 1;
  return Math.max(0, Math.min(MAX_WORKERS, cores - 1));
}

export interface PoolOptions {
  /** Defaults to `navigator.hardwareConcurrency`. */
  concurrency?: number;
  /** Defaults to a module worker built from `./blueprint.worker.ts`. */
  factory?: WorkerFactory;
}

export function createBlueprintPool(options: PoolOptions = {}): BlueprintPool {
  const concurrency =
    options.concurrency ??
    (typeof navigator === 'object' && navigator !== null
      ? (navigator as { hardwareConcurrency?: number }).hardwareConcurrency
      : undefined);
  /*
   * No `Worker` in this environment (node, an old browser) means no pool —
   * unless a factory was HANDED IN, which is a caller saying "this is how you
   * make one" and is how the tests stand a stub up.
   */
  const want =
    options.factory === undefined && typeof Worker === 'undefined' ? 0 : poolSize(concurrency);
  const factory = options.factory ?? defaultFactory;

  const pool: Worker[] = [];
  /** Which worker takes the next job — round robin, so a slow drawing does
   * not park everything behind it. */
  let next = 0;
  let serial = 0;
  const pending = new Map<number, Pending>();

  /** Build here, and answer in a microtask so a caller cannot tell the
   * difference between this and a worker. */
  const here = (strokes: StrokeList, dials: BlueprintDials): Promise<CreatureBlueprint | null> =>
    Promise.resolve().then(() => buildBlueprint(strokes, dials));

  for (let i = 0; i < want; i++) {
    let worker: Worker;
    try {
      worker = factory();
    } catch {
      // A page that cannot make a worker builds on this thread. Nothing is
      // logged: this is a supported configuration, not a fault.
      break;
    }
    worker.onmessage = (event: MessageEvent): void => {
      const reply = event.data as { id: number; blueprint: CreatureBlueprint | null };
      const waiting = pending.get(reply.id);
      if (!waiting) return;
      pending.delete(reply.id);
      waiting.resolve(reply.blueprint);
    };
    worker.onerror = (): void => {
      /*
       * A worker that has died takes its queue with it. Every job waiting on
       * it is rebuilt HERE rather than dropped — a creature that does not
       * appear because a worker crashed is a person's drawing lost, and this
       * whole file is an optimisation.
       */
      const orphans = [...pending.entries()];
      pending.clear();
      for (const [, waiting] of orphans) waiting.resolve(null);
      const at = pool.indexOf(worker);
      if (at >= 0) pool.splice(at, 1);
    };
    pool.push(worker);
  }

  return {
    build(strokes, dials): Promise<CreatureBlueprint | null> {
      if (pool.length === 0) return here(strokes, dials);
      const worker = pool[next % pool.length]!;
      next++;
      const id = ++serial;
      return new Promise<CreatureBlueprint | null>((resolve) => {
        pending.set(id, { resolve });
        try {
          worker.postMessage({ id, strokes, dials });
        } catch {
          // The message did not even leave (a stroke list that will not
          // clone, a worker already gone). Build it here.
          pending.delete(id);
          void here(strokes, dials).then(resolve);
        }
      }).then((blueprint) => {
        /*
         * A worker that answered null may mean "no usable ink" — or it may
         * mean it crashed and `onerror` resolved the job for it. The pipeline
         * is pure and cheap to repeat relative to losing a creature, so a
         * null from a worker is re-asked HERE, and this thread's answer is
         * the one the caller gets. A drawing with no ink answers null twice
         * and costs one wasted pipeline, once, on the page's worst input.
         */
        return blueprint ?? here(strokes, dials);
      });
    },
    workers: (): number => pool.length,
    dispose(): void {
      for (const worker of pool) worker.terminate();
      pool.length = 0;
      pending.clear();
    },
  };
}
