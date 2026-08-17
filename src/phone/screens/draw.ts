/**
 * State ① draw (PLAN §6.1) — a thin wrapper turning the existing draw
 * screen (src/draw/ui.ts) into a machine-mountable Screen. The stroke list
 * is handed onward on done; the wait state takes it from there.
 */

import { mountDrawScreen } from '../../draw/ui';
import type { StrokeList } from '../../shape/types';
import type { Screen } from '../states';

export interface DrawOptions {
  /** Receives a defensive copy of the final stroke list. */
  onDone(strokes: StrokeList): void;
}

export function mountDraw(section: HTMLElement, options: DrawOptions): Screen {
  const handle = mountDrawScreen(section, {
    onDone: (strokes) => options.onDone(strokes),
  });
  return {
    destroy(): void {
      handle.destroy();
    },
  };
}
