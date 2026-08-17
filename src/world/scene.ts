/**
 * World assembly (PLAN §7): renderer, scene, camera rig, ground, lighting,
 * flat shadow pass, grain pass, and the render loop.
 */

import { Color, Scene, WebGLRenderer } from 'three';
import { SURFACE } from '../taste/tokens';
import { CameraRig } from './camera';
import { GrainPass } from './grain';
import { createGround } from './ground';
import { createLighting } from './lighting';
import { FlatShadows } from './shadows';

export type FrameCallback = (dt: number, nowMs: number) => void;

export interface WorldHandles {
  scene: Scene;
  cameraRig: CameraRig;
  shadows: FlatShadows;
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
  const grain = new GrainPass();

  scene.add(createGround(), createLighting(), shadows.group);

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    cameraRig.resize(width, height);
    grain.setSize(width, height, pixelRatio);
  };
  window.addEventListener('resize', resize);
  resize();

  const frameCallbacks: FrameCallback[] = [];
  let last = performance.now();

  const loop = (nowMs: number): void => {
    // Clamp dt so a background tab doesn't come back with a lurch.
    const dt = Math.min(nowMs - last, 100);
    last = nowMs;

    cameraRig.update(dt, nowMs);
    for (const callback of frameCallbacks) callback(dt, nowMs);
    grain.render(renderer, scene, cameraRig.camera, nowMs);

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  return {
    scene,
    cameraRig,
    shadows,
    onFrame: (callback: FrameCallback): void => {
      frameCallbacks.push(callback);
    },
  };
}
