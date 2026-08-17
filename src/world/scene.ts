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
import { createEnvironment, type Environment } from './environment';
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
  /** Time-of-day + weather engine (spring-glided; drives lights + ink). */
  environment: Environment;
  /** Register per-frame work (entity drift, gaits, …). Runs before render. */
  onFrame(callback: FrameCallback): void;
}

export function start(canvas: HTMLCanvasElement): WorldHandles {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);

  const scene = new Scene();
  // Beyond the ground disc the frame is still the ground value — one field.
  // The environment engine dips its value at night (never its hue), so the
  // token stays the base and the live background is a scaled copy.
  const backgroundBase = new Color(SURFACE.ground);
  const background = backgroundBase.clone();
  scene.background = background;

  const cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
  const shadows = new FlatShadows();
  const ink = new InkPass();
  const grain = new GrainPass();
  const scatter = createScatter();
  const lighting = createLighting();

  scene.add(createGround(), lighting.group, shadows.group, scatter.group);

  // Time-of-day + weather. All its setters glide through ζ≥1 springs; the
  // per-frame update pushes sun direction, light balance, exposure, fog and
  // streak amounts into the lights and the ink composite.
  const environment = createEnvironment({
    lighting,
    ink,
    setBackground: (lumaScale: number): void => {
      background.copy(backgroundBase).multiplyScalar(lumaScale);
    },
  });
  // Tiny always-on handle for smokes and the ghost panel's feature-detect —
  // deliberately not dev-gated: it carries no dev-only code.
  (window as Window & { __refworldEnv?: Environment }).__refworldEnv = environment;
  // Same deal for the physics smoke: live prop colliders (hard/soft circles).
  (
    window as Window & { __refworldColliders?: () => ReturnType<Scatter['colliders']> }
  ).__refworldColliders = () => scatter.colliders();

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

  // ── view controls (user-specified scheme) ────────────────────────────────
  // Click and hold rotates. Trackpad pinch zooms (macOS delivers pinch as a
  // ctrl-modified wheel event). Two-finger scroll / mouse wheel pans. On
  // touch, one finger rotates (matching click-hold) and two fingers
  // pinch-zoom and twist-rotate. All 1:1 and interruptible; wheel deltas
  // drive spring retargets so motion drifts in, never snaps.
  const pointers = new Map<number, { x: number; y: number }>();
  canvas.style.touchAction = 'none';
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      // Click and hold → rotate.
      cameraRig.rotateBy(event.clientX - prev.x);
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
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch (macOS reports pinch as ctrl+wheel) → zoom.
        cameraRig.zoomBy(Math.exp(-event.deltaY * 0.01));
      } else {
        // Two-finger scroll / wheel → normal panning.
        cameraRig.panBy(-event.deltaX, -event.deltaY, window.innerHeight);
      }
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
    environment.update(dt, nowMs);
    // Sun-driven shadow stamps: one shared ellipse + one flat value per
    // frame for every stamp (scatter throttles its instanced re-lay).
    const sun = environment.sun;
    shadows.setSun(sun.azimuth, sun.altitude, sun.presence);
    scatter.setSun(sun.azimuth, sun.altitude, sun.presence);
    // Weather-driven vertex wind: the environment's spring-glided strength
    // into the scatter's shared wind uniforms (three value writes).
    scatter.setWind(environment.state.wind, nowMs);
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
    environment,
    onFrame: (callback: FrameCallback): void => {
      frameCallbacks.push(callback);
    },
  };
}
