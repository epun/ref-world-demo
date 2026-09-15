/**
 * Adapters from the world's existing seams to the recorder.
 *
 * Still pure. These are structural: they describe the shape the ingest gate
 * (src/moderation/gate.ts) and the creature manager (src/creatures/manager.ts)
 * hand their observers, without importing either — so neither of those modules
 * has to know a session log exists, and this directory keeps its node-only
 * dependency set.
 *
 * ORDERING NOTE. The gate stamps its ruling when its spawn call RETURNS (that
 * is the only moment it knows `admitted` from `unusable`), while the manager
 * emits the egg from inside that call. So an admitted drawing reads
 * `egg` then `drawing` at the same offset. Both carry the same id, replay
 * treats `egg` as informational, and offsets stay monotonic — it is an
 * artefact of the call order, not a lost event.
 */

import type { StrokeList } from '../shape/types';
import type { DrawingSource, EmoteSource, HatchCause, OperatorAction, RetireCause } from './events';
import type { SessionRecorder } from './recorder';

/** The drawing payload a gate entry carries, as far as the log cares. */
export interface RecordableDrawing {
  strokes: StrokeList;
  hatchMs?: number;
  personality?: string | null;
  source?: DrawingSource;
}

/** One gate ruling. Structurally a `GateEntry<T>` from src/moderation/gate.ts. */
export interface RecordableEntry {
  id: string;
  name: string | null;
  drawing: RecordableDrawing;
  disposition: string;
  verdict: string;
  reason: string | null;
  confidence: number;
}

/** What src/moderation/gate.ts hands its observer. */
export interface GateObserverShape {
  decision(entry: RecordableEntry): void;
  operator(action: OperatorAction, id: string | null, on?: boolean): void;
}

/** What src/creatures/manager.ts hands its observer. */
export interface CreatureObserverShape {
  egg(id: string, x: number, z: number): void;
  hatch(id: string, cause: HatchCause): void;
  retire(id: string, cause: RetireCause): void;
  emote(id: string, emote: string, source: EmoteSource): void;
}

export interface GateRecorderOptions {
  /** Hatch delay to record when the offered drawing carries none. */
  hatchMs?: number;
  /** Source to record when the offered drawing carries none. */
  source?: DrawingSource;
}

/**
 * Record every gate ruling and every operator tap. Wire as the gate's
 * `observer`; the gate calls it once per decision, never per frame.
 */
export function recordGate(
  recorder: SessionRecorder,
  options: GateRecorderOptions = {},
): GateObserverShape {
  return {
    decision(entry: RecordableEntry): void {
      recorder.drawing({
        id: entry.id,
        name: entry.name,
        personality: entry.drawing.personality ?? null,
        source: entry.drawing.source ?? options.source ?? 'phone',
        strokes: entry.drawing.strokes,
        hatchMs: entry.drawing.hatchMs ?? options.hatchMs ?? 0,
        disposition: entry.disposition,
        verdict: entry.verdict,
        reason: entry.reason,
        confidence: entry.confidence,
      });
    },
    operator(action: OperatorAction, id: string | null, on?: boolean): void {
      recorder.operator(action, id, on);
    },
  };
}

/** Record the creature lifecycle. Wire as the manager's `observer`. */
export function recordCreatures(recorder: SessionRecorder): CreatureObserverShape {
  return {
    egg: (id, x, z) => recorder.egg(id, x, z),
    hatch: (id, cause) => recorder.hatch(id, cause),
    retire: (id, cause) => recorder.retire(id, cause),
    emote: (id, emote, source) => recorder.emote(id, emote, source),
  };
}
