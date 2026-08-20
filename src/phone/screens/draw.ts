/**
 * State ① draw (PLAN §6.1) — the pad, mounted into the stage's slots
 * (docs/PHONE-STAGE.md §2) rather than owning a full-bleed root of its own.
 *
 *   core   the drawing pad — the first face of the one object
 *   tools  the case's BOTTOM key row: undo · clear · done (DEVICE §2).
 *          The top row is HIDDEN here — the drawing has no third pair of
 *          controls, and a hidden row draws no ring at all.
 *   brow   empty (a state of the slot, not a removal)
 *
 * The pad's interior keeps SURFACE.canvas so there is still a figure/ground
 * separation; the screen well around it is the stage's one paper.
 *
 * The controls are built HERE, as device keys, and handed to the draw
 * screen to wire. Nothing about their behaviour changes: undo, clear and
 * done, all three disabled while the pad is empty. What changed is where
 * they live — a physical device's controls are on the case.
 */

import { DRAW_ICONS, mountDrawScreen } from '../../draw/ui';
import type { StrokeList } from '../../shape/types';
import { createKeyRow } from '../device';
import type { Screen, StageSlots } from '../states';

export interface DrawOptions {
  /** Receives a defensive copy of the final stroke list. */
  onDone(strokes: StrokeList): void;
}

export function mountDraw(slots: StageSlots, options: DrawOptions): Screen {
  const keys = createKeyRow({
    top: null,
    bottom: [
      { label: 'undo', icon: DRAW_ICONS.undo },
      { label: 'clear', icon: DRAW_ICONS.clear },
      { label: 'done', icon: DRAW_ICONS.done },
    ],
  });
  slots.tools.appendChild(keys.el);

  const handle = mountDrawScreen(slots.core, {
    hosts: { canvas: slots.core },
    controls: {
      undo: keys.bottom[0],
      clear: keys.bottom[1],
      done: keys.bottom[2],
    },
    onDone: (strokes) => options.onDone(strokes),
  });
  return {
    destroy(): void {
      handle.destroy();
      keys.el.remove();
    },
  };
}
