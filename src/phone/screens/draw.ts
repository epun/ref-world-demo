/**
 * State ① draw (PLAN §6.1) — the pad, mounted into the stage's slots
 * (docs/PHONE-STAGE.md §2) rather than owning a full-bleed root of its own.
 *
 *   core   the drawing pad — the first face of the one object
 *   tools  undo · clear · done
 *   brow   empty (a state of the slot, not a removal)
 *
 * The pad's interior keeps SURFACE.canvas so there is still a figure/ground
 * separation; the page around it is the stage's one paper.
 */

import { mountDrawScreen } from '../../draw/ui';
import type { StrokeList } from '../../shape/types';
import type { Screen, StageSlots } from '../states';

export interface DrawOptions {
  /** Receives a defensive copy of the final stroke list. */
  onDone(strokes: StrokeList): void;
}

export function mountDraw(slots: StageSlots, options: DrawOptions): Screen {
  const handle = mountDrawScreen(slots.core, {
    hosts: { canvas: slots.core, controls: slots.tools },
    onDone: (strokes) => options.onDone(strokes),
  });
  return {
    destroy(): void {
      handle.destroy();
    },
  };
}
