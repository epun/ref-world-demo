/**
 * The draw screen (PLAN §6.1): a square canvas on the light ground with
 * three controls — undo, clear, done.
 *
 * TASTE §4 discipline: the UI is built from the measured mark set only —
 * icon, ruleLine, border. Controls are stroke-only icon marks inside
 * hairline-bordered circles; no filled buttons, no cards, no drop shadows.
 * Icon paths are drawn with subtle curvature and round caps/joins so
 * nothing on screen is a hard-cornered rectilinear form (shared law,
 * TASTE §3). All text (aria-labels) is lowercase (TASTE §5).
 *
 * Colors come exclusively from src/taste/tokens.ts. Button state motion
 * uses the tertiary token with the drift-settle curve — no bounce.
 */

import type { StrokeList } from '../shape/types';
import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import { DrawCapture, type DrawCaptureOptions } from './capture';
import { renderStrokes } from './render';

export interface DrawScreenOptions {
  /** Invoked with a defensive copy of the final stroke list. */
  onDone: (strokes: StrokeList) => void;
  /** Forwarded to DrawCapture. */
  baseWidth?: number;
  /**
   * Split mount (docs/PHONE-STAGE.md §2): the phone stage owns the layout,
   * so the pad goes into its core slot and the control row into its tools
   * slot. The pad then fills whatever box it is handed instead of setting
   * its own measure. Omitted — the world's draw overlay — keeps the single
   * self-laid-out root.
   */
  hosts?: {
    canvas: HTMLElement;
    controls?: HTMLElement;
  };
  /**
   * Controls supplied by the host, already placed (docs/DEVICE.md §2: the
   * device's three keys are fixed features of the case, so they are built
   * and positioned by the device, not by this screen). When present the
   * screen wires these three instead of building a row of its own — the
   * behaviour is identical either way: undo, clear, done, all three
   * disabled while the pad is empty.
   */
  controls?: {
    undo: HTMLButtonElement;
    clear: HTMLButtonElement;
    done: HTMLButtonElement;
  };
}

export interface DrawScreenHandle {
  /** The live capture, e.g. for getTimedStrokes() before teardown. */
  capture: DrawCapture;
  /** Detach capture, disconnect observers, remove the DOM. */
  destroy(): void;
}

const STYLE_ID = 'draw-screen-style';

// Stroke-only, softly curved icon paths in a 24-unit box. Every corner is a
// round join or a bowed curve — no rectilinear geometry.
const ICON_UNDO = [
  'M7.1 9.3c1.5-2.8 4.4-4.5 7.5-3.9 3.3.7 5.6 3.7 5.3 7.1-.3 3.3-3.1 5.9-6.5 5.9-2 0-3.8-.9-4.9-2.3',
  'M6.9 4.7c0 1.7.1 3.2.3 4.6 1.5-.1 3-.3 4.5-.5',
].join(' ');
const ICON_CLEAR = [
  'M7.3 7.5c3.4 2.8 6.4 5.9 9.3 9.2',
  'M16.7 7.3c-3.3 2.9-6.4 6-9.3 9.3',
].join(' ');
const ICON_DONE = 'M5.8 12.9c1.5 1.7 2.9 3.4 4.1 5.1 2.3-4.1 5.2-7.8 8.5-11.1';

/**
 * The three marks, exported so a host that supplies its OWN control
 * elements (the device's fixed keys — docs/DEVICE.md §2) puts the same
 * icons on them. The marks are the contract; the button chrome around
 * them is the host's.
 */
export const DRAW_ICONS = {
  undo: ICON_UNDO,
  clear: ICON_CLEAR,
  done: ICON_DONE,
} as const;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.draw-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7vmin;
  width: 100%;
  height: 100%;
  background: ${SURFACE.canvas};
}
.draw-canvas {
  width: min(76vmin, 480px);
  aspect-ratio: 1;
  display: block;
  background: ${SURFACE.canvas};
  border: 1px solid ${WORLD.ink};
  border-radius: 3.5%;
  cursor: crosshair;
}
.draw-controls {
  display: flex;
  align-items: center;
  gap: 7vmin;
}
.draw-control {
  width: 48px;
  height: 48px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: ${WORLD.ink};
  border: 1px solid ${WORLD.ink};
  border-radius: 50%;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.draw-control:active {
  transform: scale(0.96);
}
.draw-control:disabled {
  opacity: 0.3;
  cursor: default;
  pointer-events: none;
}
.draw-control svg {
  width: 22px;
  height: 22px;
  display: block;
}
/*
 * Split mount: the stage's core slot is already the pad's measure, so the
 * pad fills it rather than declaring one of its own.
 *
 * And it draws NO enclosure of its own (docs/DEVICE.md §3, user ruling:
 * "we shouldn't see the borders of the drawing pad because it should be
 * the tamagotchi screen"). No background, no border, no corner radius —
 * the bezel in the artwork is the only frame and the well's own value is
 * the only ground. A pad carrying its own card reads as a card sitting ON
 * the screen instead of BEING the screen. The world's own draw overlay
 * (the single-mount path above) keeps its card: that surface has no bezel
 * to belong to.
 */
.draw-canvas-fill {
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
  background: transparent;
  border: none;
  border-radius: 0;
}
`;
  document.head.appendChild(style);
}

function iconButton(label: string, pathData: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'draw-control';
  button.setAttribute('aria-label', label);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}

/**
 * Mount the draw screen into a container (the container should have a
 * height; the screen fills it).
 */
export function mountDrawScreen(
  container: HTMLElement,
  options: DrawScreenOptions,
): DrawScreenHandle {
  ensureStyle();

  const hosts = options.hosts;

  const canvas = document.createElement('canvas');
  canvas.className = hosts ? 'draw-canvas draw-canvas-fill' : 'draw-canvas';
  canvas.setAttribute('aria-label', 'drawing canvas');

  // Supplied controls belong to the host and are already in the document;
  // otherwise the screen builds its own hairline row.
  const supplied = options.controls;
  const controls = supplied ? null : document.createElement('div');
  const undoButton = supplied ? supplied.undo : iconButton('undo', ICON_UNDO);
  const clearButton = supplied ? supplied.clear : iconButton('clear', ICON_CLEAR);
  const doneButton = supplied ? supplied.done : iconButton('done', ICON_DONE);
  if (controls) {
    controls.className = 'draw-controls';
    controls.append(undoButton, clearButton, doneButton);
  }

  // Split mount puts each part in the slot that owns it; the single mount
  // keeps the self-laid-out root the world overlay expects.
  let root: HTMLElement | null = null;
  if (hosts) {
    hosts.canvas.appendChild(canvas);
    if (controls && hosts.controls) hosts.controls.appendChild(controls);
  } else {
    root = document.createElement('div');
    root.className = 'draw-screen';
    root.append(canvas);
    if (controls) root.appendChild(controls);
    container.appendChild(root);
  }

  const ctx = canvas.getContext('2d');

  /**
   * Paint the pad.
   *
   * `renderStrokes` lays its own SURFACE.canvas ground under the ink — the
   * light role the pad has always carried, and the ground the EGG's paint-on
   * stamp needs (src/egg/egg.ts shares that renderer, so it is not ours to
   * change). Inside the device that ground is wrong: the pad must draw no
   * enclosure and no field of its own, because it IS the tamagotchi screen
   * (docs/DEVICE.md §3, user ruling "we shouldn't see the borders of the
   * drawing pad").
   *
   * So the ground is brought down to the well's own value with one `darken`
   * pass. Per channel it keeps the minimum, and SURFACE.ground is darker
   * than SURFACE.canvas everywhere, so the field lands on exactly
   * SURFACE.ground while the near-black ink is untouched — and the
   * anti-aliased edge of every stroke stays a clean ramp from the ink to
   * the screen's value instead of picking up a light fringe. No readback,
   * no second canvas, and the shared renderer keeps its contract.
   */
  const render = (strokes: StrokeList): void => {
    if (ctx) {
      renderStrokes(ctx, strokes, canvas.width);
      if (hosts) {
        ctx.save();
        ctx.globalCompositeOperation = 'darken';
        ctx.fillStyle = SURFACE.ground;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
    }
    const empty = strokes.length === 0;
    undoButton.disabled = empty;
    clearButton.disabled = empty;
    doneButton.disabled = empty;
  };

  const captureOptions: DrawCaptureOptions = {
    onChange: render,
    ...(options.baseWidth !== undefined ? { baseWidth: options.baseWidth } : {}),
  };
  const capture = new DrawCapture(captureOptions);
  capture.attach(canvas);

  // Keep the square backing store matched to CSS size × devicePixelRatio.
  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const size = Math.max(1, Math.round(rect.width * dpr));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    render(capture.getStrokes());
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  undoButton.addEventListener('click', () => capture.undo());
  clearButton.addEventListener('click', () => capture.clear());
  doneButton.addEventListener('click', () => {
    const strokes = capture.getStrokes();
    if (strokes.length > 0) options.onDone(strokes);
  });

  return {
    capture,
    destroy(): void {
      capture.detach();
      observer.disconnect();
      if (root) root.remove();
      else {
        canvas.remove();
        // Supplied controls are the host's to remove — this screen only
        // stops driving them.
        controls?.remove();
      }
    },
  };
}
