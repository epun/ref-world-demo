/**
 * State ② wait (PLAN §6.2): the egg as a 2D mark, painting itself with the
 * drawing; a lowercase countdown line; one hairline icon control (hatch now).
 *
 * No Three.js here — the egg is an ellipse in the palette's light role with
 * the stroke list replayed inside it via renderStrokesPartial over
 * MOTION.primaryMs, the same paint-on read as the world egg (PLAN §4). The
 * offscreen ground (SURFACE.canvas) and the egg fill (WORLD.light) are the
 * same value, so the composite reads as paint on shell, not a decal.
 *
 * A gentle wobble (seeded sine pair, deterministic) runs continuously and
 * never stops — the ambient floor, plus a slow amplitude ramp as the hatch
 * approaches so the phone telegraphs what the world is about to do.
 */

import { renderStrokesPartial } from '../../draw/render';
import type { StrokeList } from '../../shape/types';
import { MOTION, SURFACE, WORLD } from '../../taste/tokens';
import { hash01, strokeSeed } from '../seed';
import type { Screen } from '../states';

// ── Pure helpers (unit-tested in test/phone) ────────────────────────────────

/** The countdown line, lowercase (TASTE §5). */
export function countdownLabel(remainingMs: number | null): string {
  if (remainingMs === null) return 'the egg is warming';
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return s > 0 ? `hatches in ${s}s` : 'hatching';
}

/**
 * Continuous egg wobble, radians. Two incommensurate seeded sines — a rock
 * that drifts and never repeats crisply, and never stops. Deterministic per
 * seed, paced by t.ambient.
 */
export function eggWobble(nowMs: number, seed: number): number {
  const base = (Math.PI * 2 * nowMs) / MOTION.ambientMs;
  const p1 = hash01(seed * 12.97) * Math.PI * 2;
  const p2 = hash01(seed * 31.41) * Math.PI * 2;
  return 0.03 * Math.sin(base * 0.42 + p1) + 0.017 * Math.sin(base * 0.19 + p2);
}

// ── Screen ──────────────────────────────────────────────────────────────────

export interface WaitScreenOptions {
  strokes: StrokeList;
  /** ms until auto-hatch, or null when unknown. */
  hatchInMs: number | null;
  /** Fired once — countdown end or manual tap. The session sends hatch;
   * the transition to alive happens when the world (or local session)
   * confirms with a state message. */
  onHatch(): void;
}

export interface WaitScreenHandle extends Screen {
  /** Re-arm the countdown from a fresh StateMsg. */
  setHatchIn(ms: number): void;
}

const STYLE_ID = 'wait-screen-style';
const OFFSCREEN_SIZE = 512;

// Stroke-only crack squiggle inside an egg outline — soft curves, no
// rectilinear geometry (icon mark, TASTE §4).
const ICON_HATCH = [
  'M12 4.4c3.3 0 5.9 3.3 5.9 7.3s-2.6 7.7-5.9 7.7-5.9-3.7-5.9-7.7 2.6-7.3 5.9-7.3',
  'M8.3 11.4c1.2.7 2.3.5 3.3-.5 1 .9 2.2 1.2 3.5.6',
].join(' ');

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.wait-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6vmin;
  width: 100%;
  height: 100%;
  background: ${SURFACE.ground};
}
.wait-egg {
  width: min(52vmin, 320px);
  aspect-ratio: 0.8;
  display: block;
}
.wait-countdown {
  color: ${WORLD.ink};
  font-family: "helvetica neue", helvetica, arial, sans-serif;
  font-weight: 400;
  font-size: 15px;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}
.wait-hatch {
  width: 52px;
  height: 52px;
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
  transition: opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.wait-hatch:disabled {
  opacity: 0.3;
  cursor: default;
  pointer-events: none;
}
.wait-hatch svg {
  width: 24px;
  height: 24px;
  display: block;
}
`;
  document.head.appendChild(style);
}

export function mountWaitScreen(
  container: HTMLElement,
  options: WaitScreenOptions,
): WaitScreenHandle {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'wait-screen';

  const canvas = document.createElement('canvas');
  canvas.className = 'wait-egg';
  canvas.setAttribute('aria-label', 'your egg');

  const countdown = document.createElement('div');
  countdown.className = 'wait-countdown';

  const hatchButton = document.createElement('button');
  hatchButton.type = 'button';
  hatchButton.className = 'wait-hatch';
  hatchButton.setAttribute('aria-label', 'hatch now');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_HATCH);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  hatchButton.appendChild(svg);

  root.append(canvas, countdown, hatchButton);
  container.appendChild(root);

  const ctx = canvas.getContext('2d');
  const offscreen = document.createElement('canvas');
  offscreen.width = OFFSCREEN_SIZE;
  offscreen.height = OFFSCREEN_SIZE;
  const offCtx = offscreen.getContext('2d');

  const seed = strokeSeed(options.strokes);
  const mountedAt = performance.now();
  let deadline = options.hatchInMs === null ? null : mountedAt + options.hatchInMs;
  let initialMs = options.hatchInMs;
  let fired = false;
  let lastLabel = '';
  let lastPaintT = -1;
  let raf = 0;

  const fireHatch = (): void => {
    if (fired) return;
    fired = true;
    hatchButton.disabled = true;
    options.onHatch();
  };

  hatchButton.addEventListener('click', fireHatch);

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);

    // Countdown line + auto-hatch.
    const remaining = deadline === null ? null : deadline - now;
    const label = fired ? countdownLabel(0) : countdownLabel(remaining);
    if (label !== lastLabel) {
      lastLabel = label;
      countdown.textContent = label;
    }
    if (remaining !== null && remaining <= 0) fireHatch();

    // Paint-on progress over t.primary — the same reveal the world plays.
    const paintT = Math.min(1, (now - mountedAt) / MOTION.primaryMs);
    if (offCtx && paintT !== lastPaintT) {
      renderStrokesPartial(offCtx, options.strokes, OFFSCREEN_SIZE, paintT);
      lastPaintT = paintT;
    }

    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    // Wobble ramps up as the hatch approaches (PLAN §4: the world
    // telegraphs what's coming; the phone echoes it).
    let urgency = 0;
    if (remaining !== null && initialMs !== null && initialMs > 0) {
      urgency = Math.min(1, Math.max(0, 1 - remaining / initialMs));
    }
    const rot = eggWobble(now, seed) * (1 + 0.9 * urgency);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Pivot at the egg's base so it rocks like a shell on the ground.
    ctx.save();
    ctx.translate(w / 2, h * 0.96);
    ctx.rotate(rot);

    const rx = w * 0.42;
    const ry = h * 0.44;
    const cy = -(ry + h * 0.03);

    const eggPath = (): void => {
      ctx.beginPath();
      ctx.ellipse(0, cy, rx, ry, 0, 0, Math.PI * 2);
    };

    eggPath();
    ctx.fillStyle = WORLD.light;
    ctx.fill();

    // The drawing, clipped to the shell. Offscreen ground and shell fill
    // share the same value, so only the ink reads — paint on shell.
    ctx.save();
    eggPath();
    ctx.clip();
    const s = rx * 1.9;
    ctx.drawImage(offscreen, -s / 2, cy - s / 2, s, s);
    ctx.restore();

    eggPath();
    ctx.strokeStyle = WORLD.ink;
    ctx.lineWidth = 1.25;
    ctx.stroke();

    ctx.restore();
  };
  raf = requestAnimationFrame(frame);

  return {
    setHatchIn(ms: number): void {
      deadline = performance.now() + ms;
      if (initialMs === null || ms > initialMs) initialMs = ms;
      if (ms > 0 && fired) {
        // The world re-armed the timer; let the control work again.
        fired = false;
        hatchButton.disabled = false;
      }
    },
    destroy(): void {
      cancelAnimationFrame(raf);
      root.remove();
    },
  };
}
