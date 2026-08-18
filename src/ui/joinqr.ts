/**
 * The join code — a QR of the room's drawing url, bottom-left, mirroring
 * the minimap in the opposite corner at the same size (user ask). It is the
 * standing invitation to draw, replacing the join line that used to print
 * the url as type.
 *
 * Taste: the frame is the minimap's own hand — a wavy hairline border on
 * the paper value, drifting on the same ambient floor, so the two corners
 * read as a pair. The modules themselves stay crisp ink squares snapped to
 * device pixels: a wobbled module is an unscannable module, and this mark
 * has a job. It is drawn once per size change, not per frame.
 *
 * Clicking it grows the code to the middle of the frame at QR_EXPANDED_VMIN
 * of the smaller viewport axis, so a room full of phones can scan it at
 * once; clicking again (or escape, or a click anywhere else) sends it back
 * to its corner. Both directions SLIDE on the settle curve over t.secondary
 * — never a cut, never a pop — and the canvas redraws at every intermediate
 * size, so the code stays crisp the whole way rather than scaling up as a
 * blurred bitmap.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { mapBorderInset, mapMarkScale, wavyBorderPoints, type BorderPoint } from '../phone/minimap';
import { encodeQr } from './qr';

/** Quiet zone in modules — four is the specified minimum. */
const QUIET_MODULES = 4;
/** Stable seed for this corner's border waver — not the map's. */
const QR_SEED = 57.3;

/** Expanded size, as a share of the smaller viewport axis (user ask: the
 * code takes 60% of the view so it can be scanned from across a room). */
export const QR_EXPANDED_VMIN = 60;

/** Corner inset — the minimap's, so the two corners stay mirrored. */
const QR_INSET_PX = 20;

const STYLE_ID = 'join-qr-style';

/**
 * Size is the minimap's own expression (src/ui/minimap.ts), so the corners
 * stay a matched pair at every window size.
 */
export const QR_SIZE_CSS = 'clamp(96px, 17vmin, 264px)';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.join-qr {
  position: fixed;
  left: calc(env(safe-area-inset-left, 0px) + ${QR_INSET_PX}px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + ${QR_INSET_PX}px);
  z-index: 5;
  width: ${QR_SIZE_CSS};
  height: ${QR_SIZE_CSS};
  display: block;
  opacity: 0;
  cursor: pointer;
  transform: translate(0px, 0px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    width ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    height ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
  -webkit-tap-highlight-color: transparent;
}
.join-qr.visible {
  opacity: 1;
}
/*
 * Expanded: the box grows in place and TRANSLATES to the middle. The
 * anchor stays the bottom-left corner, so the offset is the distance from
 * that corner to the centred position — no percentage-to-pixel
 * interpolation, and no scale transform (which would blur the modules).
 */
.join-qr.expanded {
  z-index: 6;
  width: ${QR_EXPANDED_VMIN}vmin;
  height: ${QR_EXPANDED_VMIN}vmin;
  transform: translate(
    calc((100vw - ${QR_EXPANDED_VMIN}vmin) / 2 - env(safe-area-inset-left, 0px) - ${QR_INSET_PX}px),
    calc(-1 * ((100vh - ${QR_EXPANDED_VMIN}vmin) / 2 - env(safe-area-inset-bottom, 0px) - ${QR_INSET_PX}px))
  );
}
`;
  document.head.appendChild(style);
}

/** Closed loop with quadratic midpoint smoothing — the map's own hand. */
function traceLoop(ctx: CanvasRenderingContext2D, points: BorderPoint[]): void {
  const n = points.length;
  if (n < 3) return;
  const last = points[n - 1]!;
  const first = points[0]!;
  ctx.beginPath();
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < n; i++) {
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
  }
  ctx.closePath();
}

export interface JoinQrOptions {
  /** The url a phone should open — the room's drawing page. */
  url: string;
  mount: HTMLElement;
}

export interface JoinQrHandle {
  /** true while the code is enlarged in the middle of the frame. */
  isExpanded(): boolean;
  /** Drive the expand from elsewhere (tests, a future panel button). */
  setExpanded(open: boolean): void;
  dispose(): void;
}

/**
 * Mount the join code. Returns a handle even when the url cannot be encoded
 * (far past this module's ceiling) — in that case nothing is shown rather
 * than a broken mark.
 */
export function installJoinQr(opts: JoinQrOptions): JoinQrHandle {
  ensureStyle();
  const matrix = encodeQr(opts.url);
  const canvas = document.createElement('canvas');
  canvas.className = 'join-qr';
  canvas.setAttribute('role', 'button');
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('aria-label', 'draw with your phone — click to enlarge');
  opts.mount.appendChild(canvas);
  if (!matrix) {
    return {
      isExpanded: () => false,
      setExpanded: () => {},
      dispose: () => canvas.remove(),
    };
  }

  const ctx = canvas.getContext('2d');
  const modules = matrix.length;

  const draw = (): void => {
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const scale = mapMarkScale(Math.min(w, h));
    const inset = mapBorderInset(scale);

    // Field: the light role, not the ground — the code needs its contrast,
    // and this corner reads as a card of paper laid on the world.
    const border = wavyBorderPoints(w, h, inset, QR_SEED);
    traceLoop(ctx, border);
    ctx.fillStyle = WORLD.light;
    ctx.fill();
    traceLoop(ctx, border);
    ctx.strokeStyle = WORLD.ink;
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Modules: fit the code plus its quiet zone inside the border, then
    // snap every edge to a device pixel so no module blurs into its
    // neighbour (the difference between scannable and not).
    const span = Math.min(w, h) - inset * 2 - 4;
    const step = span / (modules + QUIET_MODULES * 2);
    const originX = (w - step * modules) / 2;
    const originY = (h - step * modules) / 2;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;

    ctx.fillStyle = WORLD.ink;
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (!matrix[r]![c]) continue;
        const x0 = snap(originX + c * step);
        const y0 = snap(originY + r * step);
        const x1 = snap(originX + (c + 1) * step);
        const y1 = snap(originY + (r + 1) * step);
        ctx.fillRect(x0, y0, Math.max(1 / dpr, x1 - x0), Math.max(1 / dpr, y1 - y0));
      }
    }
    canvas.classList.add('visible');
  };

  draw();
  // Redraw on size changes only — the code is static, so there is no frame
  // loop here (the minimap's is the only one this corner needs). During the
  // expand the observer fires per frame, which is exactly what keeps the
  // modules crisp instead of stretched.
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw()) : null;
  observer?.observe(canvas);
  const onResize = (): void => draw();
  window.addEventListener('resize', onResize);

  // ── expand to the middle of the frame (user ask) ─────────────────────────
  const setExpanded = (open: boolean): void => {
    canvas.classList.toggle('expanded', open);
    canvas.setAttribute(
      'aria-label',
      open ? 'draw with your phone — click to shrink' : 'draw with your phone — click to enlarge',
    );
    // The css transition drives the size; this redraw covers the browsers
    // that batch the first resize notification.
    draw();
  };
  const toggle = (): void => setExpanded(!canvas.classList.contains('expanded'));

  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  };
  // Escape, or a press anywhere else, returns it to the corner. Capture
  // phase and never prevented, so the world's own orbit and pan handlers
  // read the same press untouched.
  const onDocKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setExpanded(false);
  };
  const onDocPointerDown = (event: PointerEvent): void => {
    if (event.target === canvas) return;
    if (canvas.classList.contains('expanded')) setExpanded(false);
  };
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('keydown', onKeyDown);
  window.addEventListener('keydown', onDocKey);
  window.addEventListener('pointerdown', onDocPointerDown, { capture: true });

  return {
    isExpanded: () => canvas.classList.contains('expanded'),
    setExpanded,
    dispose(): void {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onDocKey);
      window.removeEventListener('pointerdown', onDocPointerDown, { capture: true });
      canvas.remove();
    },
  };
}
