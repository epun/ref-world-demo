/**
 * THE PURE HALF OF BUILDING A CREATURE, as one value — so it can be built
 * somewhere other than the main thread.
 *
 * WHY THIS EXISTS. `createCharacter` is two jobs bolted together. The first
 * is the pipeline PLAN §1 calls load-bearing: rasterise the strokes, distance
 * transform, marching squares, simplify, smooth, medial axis, interpret,
 * inflate. It touches no DOM and no Three.js, it is seeded, and the same
 * strokes give the same mesh on every device — which is the whole reason a
 * phone can draw its own creature instead of watching a video of one. The
 * second job is Three.js: geometry, materials, the deform/marking/eye shader
 * chain, the stalk, the springs.
 *
 * Only the first job is expensive, and only the first job can leave this
 * thread. Measured on the deployed katamari world: 200 creatures rebuilt on a
 * refresh cost **57 seconds** of main-thread time, mean 286ms each, and
 * `distanceTransform` / `inflate` / `thinSkeleton` / `fillHoles` were the top
 * four entries in the profile under it. Pacing that over frames keeps the tab
 * alive and does not make it any shorter; a worker does
 * (`src/character/blueprint.worker.ts`).
 *
 * SO THIS MODULE IS THE SEAM, and it is deliberately nothing else: one
 * function, no state, no clock, no `Math.random`, and imports from
 * `src/shape/` and `src/inflate/` only. Put a three.js import in here and the
 * worker chunk pulls the whole renderer in with it.
 *
 * DETERMINISM IS THE CONTRACT. Every dial the pipeline reads is an ARGUMENT,
 * never module state — `fidelity`, the identity salt and `ovoid` (which is a
 * dev-panel override living in `interpret.ts`, so a worker that read its own
 * copy would quietly build a different body from the main thread's). The
 * caller reads them once and hands them over. `test/character/blueprint.test.ts`
 * pins the whole of it: a blueprint built here and a character built from it
 * are bit-for-bit what `createCharacter` builds on its own.
 */

import { inflate } from '../inflate/inflate';
import type { InflatedMesh } from '../inflate/types';
import type { StrokeList } from '../shape/types';
import { bodyOvoid, interpretDrawing, type InterpretedDrawing } from './interpret';

/**
 * Everything the Three.js half of `createCharacter` needs and cannot compute
 * cheaply: the interpretation (the silhouette, its analysis, the motifs the
 * colourway is read off) and the inflated mesh.
 *
 * Structured-cloneable by construction — plain objects and typed arrays — so
 * it crosses a worker boundary as it stands. `transferables` names the buffers
 * that may travel by reference rather than by copy.
 */
export interface CreatureBlueprint {
  interpreted: InterpretedDrawing;
  mesh: InflatedMesh;
}

/**
 * The dials the pipeline reads. All of them, explicitly: see the header on
 * why none of these may be defaulted inside a worker.
 */
export interface BlueprintDials {
  /** GENERATOR §1's interpretation dial. 1 is the shipped default. */
  fidelity: number;
  /** The identity salt, or undefined for the stroke seed alone. */
  identitySeed: number | undefined;
  /** `interpret.ts`'s `bodyOvoid()` — a dev override, read by the caller. */
  ovoid: number;
}

/** The dials as they stand on THIS thread right now. The one place that reads
 * the module-level override, so a worker never does. */
export function currentDials(fidelity: number, identitySeed: number | undefined): BlueprintDials {
  return { fidelity, identitySeed, ovoid: bodyOvoid() };
}

/**
 * Interpret and inflate. Null when the drawing carries no usable ink (the
 * same answer `createCharacter` gives, for the same reason) or when the
 * inflation produced no triangles.
 */
export function buildBlueprint(
  strokes: StrokeList,
  dials: BlueprintDials,
): CreatureBlueprint | null {
  const interpreted = interpretDrawing(
    strokes,
    dials.fidelity,
    { ovoid: dials.ovoid },
    dials.identitySeed,
  );
  if (!interpreted) return null;
  const mesh = inflate(interpreted.analysis);
  if (mesh.indices.length === 0) return null;
  return { interpreted, mesh };
}

/**
 * The buffers in a blueprint, for `postMessage`'s transfer list: handing them
 * over by reference instead of copying is the difference between a message
 * and a memcpy of a 512² mask per creature.
 *
 * Every one of these is dead in the worker the moment it has posted, which is
 * exactly when a transfer is safe.
 */
export function blueprintTransferables(blueprint: CreatureBlueprint): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const add = (view: { buffer: ArrayBufferLike } | undefined): void => {
    const buffer = view?.buffer;
    // A view onto a SharedArrayBuffer is not transferable, and a buffer
    // already in the list must not be listed twice.
    if (buffer instanceof ArrayBuffer && !out.includes(buffer)) out.push(buffer);
  };
  add(blueprint.mesh.positions);
  add(blueprint.mesh.normals);
  add(blueprint.mesh.indices);
  for (const analysis of [blueprint.interpreted.analysis, blueprint.interpreted.source]) {
    add(analysis.mask.data);
    add(analysis.distance.data);
  }
  return out;
}
