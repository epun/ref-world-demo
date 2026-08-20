/**
 * State ② wait (PLAN §6.2): the egg, volumetric — the SAME module the world
 * renders (src/egg/egg.ts), not a flat stand-in: seeded organic shell,
 * paint-on reveal from the stroke list, clearcoat sheen under the world
 * lighting recipe, continuous wobble ramping toward hatch.
 *
 * It mounts into the STAGE's slots (docs/PHONE-STAGE.md §2), not into a
 * full-bleed root of its own: the egg is the core — the same object the
 * pad was — and every other slot is empty.
 *
 * User ruling, 2026-08-20: *"let's remove the count down and the hatch
 * button. i want to set the hatch timing on my end."* So the brow carries
 * no countdown line and all three of the device's keys are unassigned here
 * (docs/DEVICE.md §2) — disabled, never removed, because the case is a
 * solid object and its controls do not come and go. The TIMING signal is
 * untouched: `hatchInMs` still drives hatchProgress, which is what ramps
 * the shell's wobble and teases the cracks in. Only the text and the
 * control went; the thing they were reading is still running.
 *
 * The egg is built with `entrance: false` (src/egg/egg.ts). The world's
 * egg slides down into frame from ENTRANCE_DROP above the ground, which is
 * right in a wide frame and wrong in a portrait: this camera is fitted to
 * the egg's SETTLED bounds, so the slide would begin outside the frustum
 * and the shell would be cut off on arrival (user report). Here the egg is
 * at rest from its first frame and the entrance is the stage's core
 * cross-fade, which is already an entrance and already on the settle
 * curve. Nothing is frozen — the ambient drift floor still runs under it.
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

import { Color, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { createEgg, EGG_HEIGHT } from '../../egg/egg';
import type { StrokeList } from '../../shape/types';
import { WORLD, SURFACE } from '../../taste/tokens';
import { GrainPass } from '../../world/grain';
import { InkPass } from '../../world/ink';
import { createLighting } from '../../world/lighting';
import { createKeyRow } from '../device';
import type { Screen, StageSlots } from '../states';

// ── Pure helpers (unit-tested in test/phone) ────────────────────────────────

/**
 * Hatch progress 0→1 as the timer advances — the same mapping the world
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
  /** ms until the hatch deadline, or null when unknown. Drives the shell's
   * wobble ramp and the late crack teaser — it is a VISUAL signal here, not
   * a control. */
  hatchInMs: number | null;
  /** Fired once, when the deadline the world gave us runs out. The session
   * sends hatch; the transition to alive happens when the world (or the
   * local session) confirms with a state message — never on this call. It
   * is no longer reachable by tapping: the timing is the world's to set. */
  onHatch(): void;
}

export interface WaitScreenHandle extends Screen {
  /** Re-arm the hatch deadline from a fresh StateMsg. */
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

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* The egg fills the core slot — the stage owns the measure (--core-side),
   so nothing here declares a size that could disagree with it. */
.wait-egg {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}
`;
  document.head.appendChild(style);
}

export function mountWaitScreen(
  slots: StageSlots,
  options: WaitScreenOptions,
): WaitScreenHandle {
  ensureStyle();

  const canvas = document.createElement('canvas');
  canvas.className = 'wait-egg';
  canvas.setAttribute('aria-label', 'your egg');

  // All three keys unassigned here (DEVICE §2): disabled, never removed.
  const keys = createKeyRow([null, null, null]);

  // The egg is the only occupant. Brow and corner stay empty — a state of
  // a slot, never a removal.
  slots.core.appendChild(canvas);
  slots.tools.appendChild(keys.el);

  // ── The 3D egg: same module, same lighting recipe as the world ────────────
  // One WebGL context per mount — created here, disposed in destroy(), never
  // recreated mid-slide.
  const egg = createEgg(options.strokes, { entrance: false });
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearAlpha(0); // the screen's ground shows through

  const scene = new Scene();
  // The egg renders through the WORLD's post chain (user ask): toon bands,
  // wobbled contour lines, hatching, paper grain — the same InkPass and
  // GrainPass the projection runs, so the egg in your hand is the egg on
  // the wall. The quantizer needs paper behind the subject (it grades a
  // rendered frame, not an alpha cut-out), so the scene carries the
  // screen's own ground value and the canvas reads as part of the page.
  scene.background = new Color(SURFACE.ground);
  scene.add(createLighting().group, egg.group);
  const ink = new InkPass();
  const grain = new GrainPass();

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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ink.setSize(w, h, dpr);
    grain.setSize(w, h, dpr);
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
  let raf = 0;
  let last = mountedAt;

  const fireHatch = (): void => {
    if (fired) return;
    fired = true;
    options.onHatch();
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - last, 100);
    last = now;

    // The deadline the world gave us. No text and no control read it any
    // more — it drives the shell.
    const remaining = deadline === null ? null : deadline - now;
    if (remaining !== null && remaining <= 0) fireHatch();

    // The world's mapping: wobble ramps with progress, cracks tease in late.
    const p = hatchProgress(remaining, initialMs);
    egg.setHatchProgress(p);
    egg.crack(crackTeaser(p));

    egg.update(dt, now);
    grain.compose(renderer, ink.render(renderer, scene, camera, now), now);
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
      // The world re-armed the timer: arm the deadline again too.
      if (ms > 0 && fired) fired = false;
    },
    destroy(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      egg.dispose();
      ink.dispose();
      renderer.dispose();
      canvas.remove();
      keys.el.remove();
    },
  };
}
