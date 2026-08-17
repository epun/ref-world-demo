/**
 * Phone entry — placeholder wiring for state ① draw (PLAN §6.1).
 * States ② wait and ③ alive land later; for now, done hands the stroke
 * list to the console. Replace onDone with the wait-state transition.
 */

import { mountDrawScreen } from '../draw/ui';
import { SURFACE } from '../taste/tokens';

document.documentElement.style.height = '100%';
document.body.style.height = '100%';
document.body.style.margin = '0';
document.body.style.background = SURFACE.canvas;

mountDrawScreen(document.body, {
  onDone(strokes) {
    // placeholder — state ② (wait) takes the stroke list from here.
    console.log('drawing complete', strokes);
  },
});
