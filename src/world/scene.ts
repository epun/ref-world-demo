/**
 * World assembly (PLAN §7): renderer, scene, camera rig, ground, lighting,
 * flat shadow pass, prop scatter, ink pass, grain pass, and the render loop.
 *
 * Post chain: scene → ink composite (toon bands + wobbly contours + hatch)
 * → grain (the final paper layer). GENERATOR §ink rendering pass.
 */

import { Color, Scene, WebGLRenderer } from 'three';
import { SURFACE } from '../taste/tokens';
import { CameraRig } from './camera';
import { GrainPass } from './grain';
import { createGround } from './ground';
import { InkPass } from './ink';
import { createLighting } from './lighting';
import { createScatter, type Scatter } from './scatter';
import { FlatShadows } from './shadows';

export type FrameCallback = (dt: number, nowMs: number) => void;

export interface WorldHandles {
  scene: Scene;
  cameraRig: CameraRig;
  /** The renderer, for dev-panel pixel readbacks. */
  renderer: WebGLRenderer;
  shadows: FlatShadows;
  /** Prop scatter: exclusions come from the creature coordinator. */
  scatter: Scatter;
  /** Ink pass tuning surface for the dev panel. */
  ink: InkPass;
  /** Register per-frame work (entity drift, gaits, …). Runs before render. */
  onFrame(callback: FrameCallback): void;
}

export function start(canvas: HTMLCanvasElement): WorldHandles {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);

  const scene = new Scene();
  // Beyond the ground disc the frame is still the ground value — one field.
  scene.background = new Color(SURFACE.ground);

  const cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
  const shadows = new FlatShadows();
  const ink = new InkPass();
  const grain = new GrainPass();
  const scatter = createScatter();

  scene.add(createGround(), createLighting(), shadows.group, scatter.group);

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    cameraRig.resize(width, height);
    ink.setSize(width, height, pixelRatio);
    grain.setSize(width, height, pixelRatio);
  };
  window.addEventListener('resize', resize);
  resize();

  // ── panning: drag the isometric view ─────────────────────────────────────
  // Direct manipulation on the world canvas; the rig converts pixels to
  // ground-plane units. Interruptible and 1:1 — reframes (frameAt) still
  // slide on the springs, and the ambient drift floor runs regardless.
  let panPointer = -1;
  let panLastX = 0;
  let panLastY = 0;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    panPointer = event.pointerId;
    panLastX = event.clientX;
    panLastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== panPointer) return;
    cameraRig.panBy(event.clientX - panLastX, event.clientY - panLastY, window.innerHeight);
    panLastX = event.clientX;
    panLastY = event.clientY;
  });
  const endPan = (event: PointerEvent): void => {
    if (event.pointerId === panPointer) panPointer = -1;
  };
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);

  const frameCallbacks: FrameCallback[] = [];
  let last = performance.now();

  const loop = (nowMs: number): void => {
    // Clamp dt so a background tab doesn't come back with a lurch.
    const dt = Math.min(nowMs - last, 100);
    last = nowMs;

    cameraRig.update(dt, nowMs);
    scatter.update(nowMs);
    for (const callback of frameCallbacks) callback(dt, nowMs);
    const composed = ink.render(renderer, scene, cameraRig.camera, nowMs);
    grain.compose(renderer, composed, nowMs);

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  return {
    scene,
    cameraRig,
    renderer,
    shadows,
    scatter,
    ink,
    onFrame: (callback: FrameCallback): void => {
      frameCallbacks.push(callback);
    },
  };
}
