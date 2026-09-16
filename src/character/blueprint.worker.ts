/**
 * The pure creature pipeline, on a worker thread.
 *
 * This file is the WHOLE worker: it takes a stroke list and the dials, calls
 * the one pure function (`src/character/blueprint.ts`), and posts the result
 * back with its buffers transferred. There is deliberately no logic here — a
 * decision taken in a worker is a decision the main thread cannot reproduce,
 * and the determinism this pipeline guarantees (same strokes → identical
 * mesh, PLAN §1) is the reason the phone and the world can draw the same
 * creature without one of them streaming video to the other.
 *
 * It imports `blueprint.ts` and nothing else. No Three.js — a three import
 * here would pull the renderer into the worker chunk, and none of it would be
 * used.
 */

import {
  blueprintTransferables,
  buildBlueprint,
  type BlueprintDials,
  type CreatureBlueprint,
} from './blueprint';
import type { StrokeList } from '../shape/types';

/** One job: a request id to match the answer to, the strokes, the dials. */
export interface BlueprintRequest {
  id: number;
  strokes: StrokeList;
  dials: BlueprintDials;
}

/** The answer. `blueprint` is null for a drawing with no usable ink, which is
 * the same null `createCharacter` returns. `error` is a thrown pipeline, kept
 * as a message so the caller can fall back rather than lose the creature. */
export interface BlueprintReply {
  id: number;
  blueprint: CreatureBlueprint | null;
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((event: { data: BlueprintRequest }) => void) | null;
  postMessage(message: BlueprintReply, transfer?: ArrayBuffer[]): void;
};

scope.onmessage = (event): void => {
  const { id, strokes, dials } = event.data;
  try {
    const blueprint = buildBlueprint(strokes, dials);
    scope.postMessage(
      { id, blueprint },
      blueprint === null ? [] : blueprintTransferables(blueprint),
    );
  } catch (error) {
    scope.postMessage({ id, blueprint: null, error: String(error) });
  }
};
