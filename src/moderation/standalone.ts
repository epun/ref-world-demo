/**
 * The screen, as a plain global for the vendored draw pad.
 *
 * `public/draw/index.html` is a vendored plain-html page: it cannot import
 * a module from `src/`, and duplicating the detector into it would be two
 * screens drifting apart. So the real one is built as its own tiny entry
 * and hangs itself on `window.__refworldScreen`, and the pad calls that
 * before it publishes.
 *
 * It screens the KIT's wire strokes through the same conversion the world
 * uses on ingest (feedDrawingToStrokes), so the pad and the world are
 * looking at exactly the same thing — a drawing refused here would have
 * been refused there.
 *
 * This is a courtesy, not a control. Anyone can publish to the room's
 * topic without ever loading this page, so the world's gate stays the
 * authority; refusing here only spares the person the round trip and
 * keeps the drawing on their own handset.
 */

import { feedDrawingToStrokes } from '../net/drawFeed';
import type { FeedStroke } from '../net/vendor/draw-feed';
import { screenDrawing, type ScreenResult } from './screen';

export interface StandaloneScreen {
  (strokes: FeedStroke[]): ScreenResult;
}

const screen: StandaloneScreen = (strokes) =>
  screenDrawing(feedDrawingToStrokes({ strokes }));

(globalThis as { __refworldScreen?: StandaloneScreen }).__refworldScreen = screen;

export { screen };
