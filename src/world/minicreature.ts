/**
 * Your creature, alive in the mini device's screen.
 *
 * The tray's device is a miniature of the real one, and until now its
 * screen was blank artwork — a picture of a device rather than a small
 * device (user report, 2026-08-25: *"we should show that same kind of mini
 * view of the character in 3D in the device on the left-hand corner"*). A
 * dark well where the creature should be reads as an object that is off,
 * which is exactly backwards: it is the one thing on this screen that is
 * yours and it is the thing you tap to go to it.
 *
 * It is the SAME picture the companion shows, built the same way
 * (src/phone/screens/alive.ts): the identical pure pipeline run locally on
 * the same strokes under the same identity, a head-on orthographic camera
 * so the silhouette is the drawing, the world's lighting recipe, and the
 * world's own post chain — ink then grain — over the top. Not a
 * simplification of the portrait; the portrait, small. That is what makes
 * tapping it GROW into the companion read as one object getting closer
 * rather than two screens swapping.
 *
 * Head-on and not isometric, for the same reason the companion is: this is
 * a portrait of a drawing, and the drawing was made face-on.
 *
 * ⚠️ A second WebGL context, alongside the world's. It is kept small (the
 * well is ~46 css px across) and it stops rendering the moment it is not
 * on screen; `dispose()` releases the context rather than leaking it,
 * because a handset that has opened and closed the world view a dozen
 * times must not be holding a dozen contexts.
 */

import { Box3, Color, OrthographicCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { createCharacter, type Character } from '../character/character';
import type { EmoteName } from '../net/protocol';
import type { StrokeList } from '../shape/types';
import { SURFACE } from '../taste/tokens';
import { GrainPass } from './grain';
import { InkPass } from './ink';
import { createLighting } from './lighting';

/**
 * Breathing room around the creature inside the well, as a share of its
 * measured half-extent. The companion frames generously; a thumbnail that
 * fills its frame edge to edge reads as cropped, so this keeps the same
 * proportion of air at a twentieth of the size.
 */
const FRAME_AIR = 1.22;

/** Never ask for more backing store than this — it is a thumbnail. */
const MAX_PIXEL_RATIO = 2;

export interface MiniCreatureOptions {
  /** The person's own strokes, as stored on this handset. */
  strokes: StrokeList;
  /** Their drawing id, so the creature is identical to the world's. */
  identity: string;
}

export interface MiniCreatureHandle {
  /** The canvas, for the caller to place inside the device's well. */
  canvas: HTMLCanvasElement;
  /**
   * Stop drawing without losing anything — for when the companion panel
   * covers the tray. The creature, its mesh and the gl context all stay;
   * only the frames stop, which is the whole cost of a thumbnail nobody
   * can currently see.
   */
  setPaused(paused: boolean): void;
  /** Play an emote on the portrait, mirroring what the world will show. */
  emote(name: EmoteName): void;
  /** Stop drawing and release the GL context. */
  dispose(): void;
}

/**
 * Build the portrait. Returns null for a drawing the pipeline cannot make
 * a creature from — the tray then shows the device with an empty screen,
 * which is honest, rather than a broken canvas.
 */
export function mountMiniCreature(options: MiniCreatureOptions): MiniCreatureHandle | null {
  const character: Character | null = createCharacter(options.strokes, 1, {
    // No speech bubble at this size — a bubble over a 46px creature is a
    // smudge. The emote reads in the body, as it does on the companion.
    bubble: false,
    identity: options.identity,
  });
  if (!character) return null;

  const canvas = document.createElement('canvas');
  canvas.className = 'tray-device-screen';

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));

  const scene = new Scene();
  // The quantizer grades a rendered frame, not a cut-out, so it needs
  // paper behind the subject — the same value the well is painted, so the
  // canvas reads as the screen rather than a card sitting on it.
  scene.background = new Color(SURFACE.ground);
  scene.add(createLighting().group, character.group);
  const ink = new InkPass();
  const grain = new GrainPass();

  // Frame from the creature's MEASURED bounds, not an assumed height: the
  // mesh is normalized to a standard height but a wide drawing is much
  // wider than tall, and a fixed frustum crops it.
  const bounds = new Box3().setFromObject(character.group);
  const size = bounds.getSize(new Vector3());
  const centre = bounds.getCenter(new Vector3());
  // What the creature needs, per axis, with its air.
  const needX = (size.x / 2) * FRAME_AIR;
  const needY = (size.y / 2) * FRAME_AIR;
  const camera = new OrthographicCamera(-needX, needX, needY, -needY, 0.1, 100);
  camera.position.set(centre.x, centre.y, 12);
  camera.lookAt(centre.x, centre.y, 0);

  let sizedPx = 0;
  /**
   * Square backing store from the well's rendered width, and the post
   * chain sized to match — an ink or grain buffer at a different size
   * than the frame it grades is the effect at the wrong scale, which at
   * this size is the difference between grain and noise.
   *
   * Idempotent, so a settled frame never touches the drawing buffer:
   * setSize clears it, and clearing it mid-frame is a flash.
   */
  const sizeToWell = (): void => {
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    const key = w * 10000 + h;
    if (key === sizedPx) return;
    sizedPx = key;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    renderer.setSize(w, h, false);
    ink.setSize(w, h, dpr);
    grain.setSize(w, h, dpr);

    // The well is TALLER than it is wide (3:4), so a square frustum here
    // would squash the drawing sideways — and the silhouette being the
    // drawing is the one thing this portrait exists to preserve. Fit the
    // creature inside the well's real aspect: grow whichever axis has room
    // to spare, never crop the other.
    const aspect = w / h;
    const halfY = Math.max(needY, needX / aspect);
    const halfX = halfY * aspect;
    camera.left = -halfX;
    camera.right = halfX;
    camera.top = halfY;
    camera.bottom = -halfY;
    camera.updateProjectionMatrix();
  };

  let raf = 0;
  let last = 0;
  let alive = true;
  let paused = false;
  const frame = (now: number): void => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (paused) return;
    const dt = last === 0 ? 16 : Math.min(now - last, 100);
    last = now;
    sizeToWell();
    if (sizedPx <= 1) return; // not laid out yet
    character.update(dt, now);
    grain.compose(renderer, ink.render(renderer, scene, camera, now), now);
  };
  raf = requestAnimationFrame(frame);
  // On the element that actually changed, not window.resize: this catches
  // an orientation change and the tray's own settle. The loop sizes too,
  // and both are idempotent, so they never fight.
  const observer = new ResizeObserver(sizeToWell);
  observer.observe(canvas);

  return {
    canvas,
    setPaused(next: boolean): void {
      if (next === paused) return;
      paused = next;
      // Coming back: forget the gap. `last` is what dt is measured from,
      // so a stale one hands the first live frame however long the panel
      // was open and the drift floor jumps.
      if (!paused) last = 0;
    },
    emote(name: EmoteName): void {
      character.emote(name);
    },
    dispose(): void {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      ink.dispose();
      character.dispose();
      // Release the context rather than waiting for gc — a handset that
      // has toggled between world and companion repeatedly must not be
      // holding a stack of live contexts.
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
