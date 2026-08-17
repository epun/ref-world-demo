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

  // ── view controls: pan, rotate, zoom ─────────────────────────────────────
  // Direct manipulation on the world canvas; the rig converts pixels to
  // ground-plane units. All 1:1 and interruptible — reframes (frameAt) still
  // slide on the springs, wheel zoom drifts in on its spring, and the ambient
  // floor runs regardless. Desktop: drag pans, shift-drag or right-drag
  // rotates, wheel zooms. Touch: one finger pans, two fingers pinch-zoom and
  // twist-rotate.
  const pointers = new Map<number, { x: number; y: number }>();
  let rotating = false;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    rotating = event.shiftKey || event.button === 2;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      if (rotating) cameraRig.rotateBy(dx);
      else cameraRig.panBy(dx, dy, window.innerHeight);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    } else if (pointers.size === 2) {
      // Pinch: zoom by distance ratio; twist: rotate by angle delta.
      const entries = [...pointers.entries()];
      const other = entries.find(([id]) => id !== event.pointerId);
      if (other) {
        const [, o] = other;
        const beforeD = Math.hypot(prev.x - o.x, prev.y - o.y);
        const beforeA = Math.atan2(prev.y - o.y, prev.x - o.x);
        const afterD = Math.hypot(event.clientX - o.x, event.clientY - o.y);
        const afterA = Math.atan2(event.clientY - o.y, event.clientX - o.x);
        if (beforeD > 12) cameraRig.zoomDirect(afterD / beforeD);
        cameraRig.rotateBy(((afterA - beforeA) * 180) / Math.PI);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
    }
  });
  const releasePointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) rotating = false;
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      cameraRig.zoomBy(Math.exp(-event.deltaY * 0.0016));
    },
    { passive: false },
  );

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
