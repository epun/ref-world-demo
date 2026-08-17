/**
 * State ② wait (PLAN §6.2): the egg, volumetric — the SAME module the world
 * renders (src/egg/egg.ts), not a flat stand-in: seeded organic shell,
 * paint-on reveal from the stroke list, clearcoat sheen under the world
 * lighting recipe, continuous wobble ramping toward hatch. Below it, a
 * lowercase countdown line and one hairline icon control (hatch now).
 *
 * The camera is NOT the iso rig — a simple perspective camera pulled to a
 * slight three-quarter, looking gently down, so the shell reads as a body
 * with a lit side and a turned side. The egg's painted front faces the
 * world's 45° diagonal (FACE_CAMERA_Y in egg.ts); the camera sits a little
 * off that diagonal so the mark stays readable while the form stays 3D.
 *
 * Mobile discipline: one WebGL context per mount, devicePixelRatio capped
 * at 2, ResizeObserver drives the backing store, and the loop pauses while
 * document.hidden. Renderer and egg dispose on unmount.
 */

import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { createEgg, EGG_HEIGHT } from '../../egg/egg';
import type { StrokeList } from '../../shape/types';
import { MOTION, WORLD, SURFACE } from '../../taste/tokens';
import { createLighting } from '../../world/lighting';
import type { Screen } from '../states';

// ── Pure helpers (unit-tested in test/phone) ────────────────────────────────

/** The countdown line, lowercase (TASTE §5). */
export function countdownLabel(remainingMs: number | null): string {
  if (remainingMs === null) return 'the egg is warming';
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return s > 0 ? `hatches in ${s}s` : 'hatching';
}

/**
 * Hatch progress 0→1 as the countdown advances — the same mapping the world
 * uses (src/main.ts: elapsed / total). The phone holds a deadline and the
 * timer's initial span, so progress is 1 - remaining/initial, clamped.
 * Unknown timer → 0: the egg rests at its base wobble.
 */
export function hatchProgress(
  remainingMs: number | null,
  initialMs: number | null,
): number {
  if (remainingMs === null || initialMs === null || initialMs <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remainingMs / initialMs));
}

/** Teaser ceiling for the pre-hatch cracks — mirrors the world's value. */
export const CRACK_TEASER = 0.3;

/**
 * Hairline cracks tease in late, exactly as the world scrubs them:
 * CRACK_TEASER · smoothstep(0.62, 1, p). Zero until the final stretch,
 * drifting up to the teaser ceiling — never a step.
 */
export function crackTeaser(p: number): number {
  const t = Math.min(1, Math.max(0, (p - 0.62) / (1 - 0.62)));
  return CRACK_TEASER * t * t * (3 - 2 * t);
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

/** Camera: slight three-quarter off the painted front (which faces the
 * world's 45° diagonal), tipped gently down so the shell reads volumetric. */
const CAMERA_FOV = 28;
const CAMERA_AZIMUTH = Math.PI / 4 + 0.22;
const CAMERA_ELEVATION = 0.3;
const CAMERA_DISTANCE = 7.6;
const LOOK_Y = EGG_HEIGHT * 0.5;

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
  gap: 5vmin;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding-top: env(safe-area-inset-top, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 2vmin);
  padding-left: env(safe-area-inset-left, 0px);
  background: ${SURFACE.ground};
}
.wait-egg {
  width: min(60vmin, 380px);
  aspect-ratio: 0.85;
  display: block;
  touch-action: none;
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
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.wait-hatch:disabled {
  opacity: 0.3;
  cursor: default;
  pointer-events: none;
}
.wait-hatch:active {
  opacity: 0.55;
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

  // ── The 3D egg: same module, same lighting recipe as the world ────────────
  // One WebGL context per mount — created here, disposed in destroy(), never
  // recreated mid-slide.
  const egg = createEgg(options.strokes);
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearAlpha(0); // the screen's ground shows through

  const scene = new Scene();
  scene.add(createLighting().group, egg.group);

  const camera = new PerspectiveCamera(CAMERA_FOV, 0.85, 0.1, 100);
  camera.position.set(
    Math.sin(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION) * CAMERA_DISTANCE,
    LOOK_Y + Math.sin(CAMERA_ELEVATION) * CAMERA_DISTANCE,
    Math.cos(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION) * CAMERA_DISTANCE,
  );
  camera.lookAt(0, LOOK_Y, 0);

  const size = (): void => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  size();
  const observer = new ResizeObserver(size);
  observer.observe(canvas);

  // ── Countdown + loop ──────────────────────────────────────────────────────
  const mountedAt = performance.now();
  let deadline = options.hatchInMs === null ? null : mountedAt + options.hatchInMs;
  let initialMs = options.hatchInMs;
  let fired = false;
  let lastLabel = '';
  let raf = 0;
  let last = mountedAt;

  const fireHatch = (): void => {
    if (fired) return;
    fired = true;
    hatchButton.disabled = true;
    options.onHatch();
  };

  hatchButton.addEventListener('click', fireHatch);

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - last, 100);
    last = now;

    // Countdown line + auto-hatch.
    const remaining = deadline === null ? null : deadline - now;
    const label = fired ? countdownLabel(0) : countdownLabel(remaining);
    if (label !== lastLabel) {
      lastLabel = label;
      countdown.textContent = label;
    }
    if (remaining !== null && remaining <= 0) fireHatch();

    // The world's mapping: wobble ramps with progress, cracks tease in late.
    const p = hatchProgress(remaining, initialMs);
    egg.setHatchProgress(p);
    egg.crack(crackTeaser(p));

    egg.update(dt, now);
    renderer.render(scene, camera);
  };

  // Pause the loop while hidden (battery); resume without a dt lurch.
  const running = (): boolean => raf !== 0;
  const start = (): void => {
    if (running()) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    if (!running()) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

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
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      egg.dispose();
      renderer.dispose();
      root.remove();
    },
  };
}
