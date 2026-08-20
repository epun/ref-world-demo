/**
 * State ② wait (PLAN §6.2): the egg, volumetric — the SAME module the world
 * renders (src/egg/egg.ts), not a flat stand-in: seeded organic shell,
 * paint-on reveal from the stroke list, clearcoat sheen under the world
 * lighting recipe, continuous wobble ramping toward hatch.
 *
 * And the HATCH itself. User report, 2026-08-20: *"on hatch the egg should
 * break apart and the creature should appear. right now it glitches on the
 * screen from the egg and flashes on."* They were right, and the cause was
 * structural: `wait` and `alive` were two screens with two scenes, one
 * holding an egg and one holding a character, and the stage cross-faded
 * between them. Nothing broke — one image dissolved into a different image,
 * which under the ink+grain chain reads as a flash.
 *
 * This screen already owns a scene with the egg in it, so this is the
 * screen that hatches. `playHatch()` runs `src/egg/hatch.ts` — the same
 * `startHatch` the world drives from src/creatures/manager.ts, driven the
 * same way — in this scene: the shell splits into three slice geometries
 * that inherit the egg's exact pose mid-wobble, slide apart and drift down
 * while fading over t.primary, and the character rises from the egg
 * position on ζ≥1 springs (from 0.6, never from zero). main.ts holds the
 * swap to `alive` until that has actually played.
 *
 * The swap at the END is then a cross-fade between two pictures of the SAME
 * creature: src/shape and src/inflate are pure, and this screen builds the
 * character from the same strokes and the same identity id the alive screen
 * will, so both are the identical generated mesh. The camera is what makes
 * them the same PICTURE — see the reframe below.
 *
 * It mounts into the STAGE's slots (docs/PHONE-STAGE.md §2), not into a
 * full-bleed root of its own: the egg is the core — the same object the
 * pad was — and every other slot is empty.
 *
 * User ruling, 2026-08-20: *"let's remove the count down and the hatch
 * button. i want to set the hatch timing on my end."* — and, 2026-08-18,
 * *"when the egg is visible on the tamagotchi, let's hide the buttons"*. So
 * the brow carries no countdown line and BOTH of the device's key rows are
 * hidden here (docs/DEVICE.md §2): hidden, not dimmed, and never removed,
 * because the case is a solid object and its controls do not come and go.
 * The egg is the only thing on the device. The TIMING signal is
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
 * at 2, the canvas's own box drives the backing store, and the loop pauses
 * while document.hidden. Renderer, egg and character dispose on unmount.
 */

import { Box3, Color, Group, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { createCharacter, type Character } from '../../character/character';
import { createEgg, EGG_HEIGHT } from '../../egg/egg';
import { startHatch, type HatchHandle } from '../../egg/hatch';
import { Spring } from '../../motion/spring';
import type { StrokeList } from '../../shape/types';
import { MOTION, SURFACE } from '../../taste/tokens';
import { GrainPass } from '../../world/grain';
import { InkPass } from '../../world/ink';
import { createLighting } from '../../world/lighting';
import { createKeyRow, NO_KEYS } from '../device';
import { createSpin, type SpinHandle, type SpinState } from '../spin';
import { CORE_SHARE, wellElement, type Screen, type StageSlots } from '../states';
import { PORTRAIT_SHARE, portraitHalfExtent, portraitUnitsPerPixel } from './alive';

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

// ── Framing (pure) ──────────────────────────────────────────────────────────

/**
 * Where the camera is, said in the terms the reframe interpolates: a look
 * point and a direction to stand off it. Blending these rather than two
 * world positions keeps the path an arc around the subject instead of a
 * chord through it.
 */
export interface Framing {
  /** Radians around +y from the +z axis. */
  azimuth: number;
  /** Radians above the horizon. */
  elevation: number;
  lookX: number;
  lookY: number;
  distance: number;
}

/** Camera: slight three-quarter off the painted front (which faces the
 * world's 45° diagonal), tipped gently down so the shell reads volumetric. */
export const CAMERA_FOV = 28;

/** The opening shot: the egg, three-quartered, at rest in the core. */
export const EGG_FRAMING: Framing = {
  azimuth: Math.PI / 4 + 0.22,
  elevation: 0.3,
  lookX: 0,
  lookY: EGG_HEIGHT * 0.5,
  distance: 7.6,
};

/** Straight lerp of every term. `t` comes from a ζ≥1 spring, so the path
 * eases in, never overshoots and never arrests. */
export function blendFraming(t: number, from: Framing, to: Framing): Framing {
  const k = Math.min(1, Math.max(0, t));
  const mix = (a: number, b: number): number => a + (b - a) * k;
  return {
    azimuth: mix(from.azimuth, to.azimuth),
    elevation: mix(from.elevation, to.elevation),
    lookX: mix(from.lookX, to.lookX),
    lookY: mix(from.lookY, to.lookY),
    distance: mix(from.distance, to.distance),
  };
}

/**
 * The distance at which a perspective camera of `fovDeg` shows exactly
 * `unitsPerPx` world units per pixel across a canvas `canvasPx` tall, at
 * the look plane.
 *
 * This is what makes the final cross-fade a dissolve rather than a jump.
 * The alive portrait frames the creature with an orthographic camera fitted
 * to its measured bounds, in a canvas that is PORTRAIT_SHARE of the alive
 * core; this screen's canvas is the whole core and the core GROWS during
 * the swap (CORE_SHARE.wait → CORE_SHARE.alive). Solving for units-per-
 * PIXEL rather than for a share of the frame makes the creature's rendered
 * size independent of both — it holds the same pixels on the same spot
 * while the box travels around it, and lands exactly where the portrait
 * fading in on top of it is drawing the same creature.
 */
export function fitDistance(unitsPerPx: number, canvasPx: number, fovDeg: number): number {
  return (unitsPerPx * canvasPx) / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

// ── Screen ──────────────────────────────────────────────────────────────────

export interface WaitScreenOptions {
  strokes: StrokeList;
  /**
   * The drawing's publish id — the same identity the world spawns the
   * creature under, and the same one the alive screen is given. Passing it
   * is what makes the creature this screen reveals at the hatch and the
   * creature the portrait mounts afterwards the identical mesh.
   */
  identity?: string;
  /** ms until the hatch deadline, or null when unknown. Drives the shell's
   * wobble ramp and the late crack teaser — it is a VISUAL signal here, not
   * a control. */
  hatchInMs: number | null;
  /** Yaw + throw carried in from the previous screen (user rotation). */
  initialSpin?: SpinState;
  /** Fired once, when the deadline the world gave us runs out. The session
   * sends hatch; the world (or the local session) confirms with a state
   * message, and THAT is what starts playHatch. */
  onHatch(): void;
}

export interface PlayHatchOptions {
  /**
   * The shell has broken open. The hatch haptic belongs here — at the
   * crack, not at the screen change, which is a different moment and used
   * to be the only one this screen had.
   */
  onCrack?(): void;
}

export interface WaitScreenHandle extends Screen {
  /** Re-arm the hatch deadline from a fresh StateMsg. */
  setHatchIn(ms: number): void;
  /**
   * Break the egg open in THIS scene and stand the creature up in it.
   * Resolves when the sequence has played (or at once when there is nothing
   * to play — a degenerate drawing, or a hatch already run). The caller
   * holds the swap to `alive` until then.
   */
  playHatch(options?: PlayHatchOptions): Promise<void>;
  /** Where the person left the object turned, and how fast it is still
   * turning — handed to the next screen so the seam does not stop it. */
  spin(): SpinState;
}

const STYLE_ID = 'wait-screen-style';

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

  // NO keys at all here, by ruling (DEVICE §2): *"when the egg is visible
  // on the tamagotchi, let's hide the buttons"*. Hidden, not dimmed — and
  // hidden is opacity + pointer-events + aria-hidden, never display, since
  // the case is a solid object and a removal would relayout it. The rings
  // are the keys' own now (DEVICE §3), so a hidden row leaves the case
  // genuinely bare rather than showing six empty circles.
  const keys = createKeyRow(NO_KEYS);

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

  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);

  // ── Sizing ───────────────────────────────────────────────────────────────
  // The canvas's box is read every frame, not only on a ResizeObserver
  // callback: during the swap to alive the core's side travels for
  // t.secondary and the camera has to follow it on the same frame the box
  // moves, or the creature would breathe against the portrait fading in on
  // top of it.
  let canvasPx = 1;
  let sizedW = 0;
  let sizedH = 0;
  const size = (): void => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    canvasPx = h;
    if (w === sizedW && h === sizedH) return;
    sizedW = w;
    sizedH = h;
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

  /**
   * The pixel side the alive portrait's canvas will have. The well is the
   * `cqw` base both measures are shares of, so reading it is what lets this
   * screen compute the OTHER screen's box instead of guessing at it. With
   * no stage above us (a headless mount) fall back to this screen's own
   * share, which is exact until the swap starts.
   */
  const portraitPx = (): number => {
    const well = wellElement(canvas);
    const wellPx = well ? well.getBoundingClientRect().width : canvasPx / CORE_SHARE.wait;
    return wellPx * CORE_SHARE.alive * PORTRAIT_SHARE;
  };

  // ── Hatch state ──────────────────────────────────────────────────────────
  /**
   * egg     — the timer drives the shell: wobble ramp, crack teaser.
   * crack   — startHatch owns the shell; the egg is still whole and still
   *           being updated, exactly as the world updates it.
   * exit    — the shell is off and flying; the creature is rising.
   * settled — the creature stands, under the ambient floor alone.
   */
  let phase: 'egg' | 'crack' | 'exit' | 'settled' = 'egg';
  /**
   * Each object's own facing, captured on its first frame.
   *
   * User ruling, 2026-08-20: *"the egg and the character should not
   * ambiently spin. It should be user-driven."* The drift floor's third
   * term is a rotation (`sampleDrift().rot`, ±MOTION.ambientAmplitude —
   * ±0.17°), and egg.update()/character.update() write it straight onto
   * rotation.y every frame. Small, but it is yaw the person did not ask
   * for, and yaw is now theirs alone: the facing is PINNED at what the
   * object was built with and the drag is added to it, so with no input
   * the angle is bit-identical frame to frame.
   *
   * The other two ambient terms are untouched. The POSITIONAL drift
   * (drift.x/drift.y) still runs on both objects — that is TASTE §2.1's
   * floor at confidence 1.00 and it is what the stillness probe reads —
   * and so does the egg's wobble, which rocks it about x and z. A rock is
   * the egg being alive and it is what telegraphs the hatch; it never
   * turns the shell about its vertical axis, so the painted mark stays
   * where the person left it.
   */
  let eggFacing: number | null = null;
  let charFacing: number | null = null;
  let hatch: HatchHandle | null = null;
  let hatched: Character | null = null;
  /** The wrapper startHatch owns the rise on. Handed over at the burst. */
  let charRoot: Group | null = null;
  let charFraming: Omit<Framing, 'distance'> | null = null;
  let charHalfExtent = 0;
  /** The reframe: egg framing → creature framing, over t.primary. */
  let reframe: Spring | null = null;
  let hatchDone: (() => void) | null = null;

  // ── Turning the object by hand (user ruling, 2026-08-20) ─────────────────
  // Read on the WELL, not on the canvas: the whole display turns the
  // object. New gestures are HELD while the hatch plays — the shell pieces
  // and the rising creature are choreographed against the egg's pose and a
  // fresh drag mid-sequence would tear them apart. A throw already in
  // flight is never cut short: it keeps decaying onto the egg, and onto the
  // creature once the shell is off, so nothing abruptly stops.
  const spin: SpinHandle = createSpin({
    surface: wellElement(canvas) ?? canvas,
    width: () => {
      const well = wellElement(canvas);
      return well ? well.getBoundingClientRect().width : canvasPx;
    },
    ...(options.initialSpin ? { initial: options.initialSpin } : {}),
    held: () => phase !== 'egg' && phase !== 'settled',
  });

  const framingNow = (): Framing => {
    if (!charFraming || !reframe) return EGG_FRAMING;
    const to: Framing = {
      ...charFraming,
      distance: fitDistance(
        portraitUnitsPerPixel(charHalfExtent, portraitPx()),
        canvasPx,
        CAMERA_FOV,
      ),
    };
    return blendFraming(reframe.value, EGG_FRAMING, to);
  };

  /**
   * Keep the creature's feet ON the shell's contact point while it rises.
   *
   * startHatch starts the rise at RISE_FROM, BELOW the ground — right in
   * the world, where the ground plane hides everything under it, so what
   * the room sees is a creature coming up out of the earth. This scene has
   * no ground: the egg rests on paper. Measured, the world's version put
   * the creature's lower body on screen in the single frame the shell
   * broke — the largest one-frame change in the whole sequence, and the
   * one thing left in it that read as a pop.
   *
   * So the rise is re-anchored, not removed. The root's own downward
   * offset is cancelled in the character's local space, which leaves the
   * creature's base planted at the contact point and its scale still
   * travelling 0.6 → 1 on the sequence's own ζ≥1 spring: its head slides
   * up from inside the shell (2.1 units tall, well under the egg's 2.6) to
   * standing height. It is fully behind the shell on the frame it appears
   * and is revealed by the shell leaving, which is what a hatch is. Same
   * precedent as `entrance: false` on the egg (src/egg/egg.ts): the world's
   * motion is right in a wide frame and wrong in a portrait.
   *
   * If startHatch ever takes a rise-origin option the way createEgg takes
   * `entrance`, this comes out and the option goes in.
   */
  const groundLift = (): number => {
    if (!charRoot) return 0;
    const below = -charRoot.position.y;
    if (below <= 0) return 0;
    return below / (charRoot.scale.y || 1);
  };

  const applyCamera = (): void => {
    const f = framingNow();
    const cosEl = Math.cos(f.elevation);
    camera.position.set(
      f.lookX + Math.sin(f.azimuth) * cosEl * f.distance,
      f.lookY + Math.sin(f.elevation) * f.distance,
      Math.cos(f.azimuth) * cosEl * f.distance,
    );
    camera.lookAt(f.lookX, f.lookY, 0);
  };
  applyCamera();

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

  /** One step of the world's own loop, on this scene. */
  const step = (dt: number, now: number): void => {
    size();
    const yaw = spin.update(dt);

    if (phase === 'egg') {
      // The deadline the world gave us. No text and no control read it any
      // more — it drives the shell.
      const remaining = deadline === null ? null : deadline - now;
      // The deadline drives the SHELL, never the hatch (user, for the demo:
      // "eggs should only hatch when I press h"). This was the third clock
      // running — after the world's AUTO_HATCH and the local session's
      // LOCAL_AUTO_HATCH, this one still opened the egg when the countdown
      // it was given ran out, which is why the handset kept hatching on its
      // own. Only the world's `hatched` message opens an egg now; the
      // countdown is left to ramp the wobble and tease the cracks, which is
      // the whole reason the signal is still here.
      // The world's mapping: wobble ramps with progress, cracks tease late.
      const p = hatchProgress(remaining, initialMs);
      egg.setHatchProgress(p);
      egg.crack(crackTeaser(p));
      egg.update(dt, now);
      if (eggFacing === null) eggFacing = egg.group.rotation.y;
      egg.group.rotation.y = eggFacing + yaw;
    } else if (phase === 'crack') {
      // Exactly the world's order (src/creatures/manager.ts): the egg is
      // still updated while it exists, and the hatch drives the crack.
      egg.update(dt, now);
      if (eggFacing === null) eggFacing = egg.group.rotation.y;
      egg.group.rotation.y = eggFacing + yaw;
      hatch?.update(dt, now);
    } else {
      hatch?.update(dt, now);
      if (hatched) {
        hatched.update(dt, now);
        if (charFacing === null) charFacing = hatched.group.rotation.y;
        hatched.group.rotation.y = charFacing + yaw;
      }
    }
    // After the branch, not inside it: the shell breaks DURING a crack
    // frame's hatch.update(), so the creature exists and is already parented
    // low on the very frame the pieces appear. Re-anchoring it there too is
    // the difference between the shell hiding it and it arriving under the
    // shell in one frame.
    if (hatched) hatched.group.position.y += groundLift();

    reframe?.update(dt);
    applyCamera();
    grain.compose(renderer, ink.render(renderer, scene, camera, now), now);
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - last, 100);
    last = now;
    step(dt, now);
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
      if (phase !== 'egg') return; // the shell is already coming off
      deadline = performance.now() + ms;
      if (initialMs === null || ms > initialMs) initialMs = ms;
      // The world re-armed the timer: arm the deadline again too.
      if (ms > 0 && fired) fired = false;
    },

    playHatch(playOptions: PlayHatchOptions = {}): Promise<void> {
      if (phase !== 'egg') return Promise.resolve();
      // Same identity as the world's slot and as the alive portrait → the
      // identical creature, so the swap at the end is a cross-fade between
      // two pictures of one mesh.
      const character = createCharacter(options.strokes, 1, {
        // Same options the alive screen uses, bubble included — the two
        // must build the SAME mesh or the handover stops being a cross-fade
        // between one creature and itself.
        bubble: false,
        ...(options.identity === undefined ? {} : { identity: options.identity }),
      });
      // A degenerate drawing has no creature to reveal. Nothing to play:
      // resolve and let the caller swap as it always did.
      if (!character) return Promise.resolve();

      // Measure the creature the way the portrait will, from the same
      // helper, BEFORE the hatch parents it — the two framings have to be
      // computed from the same numbers or they cannot converge.
      const bounds = new Box3().setFromObject(character.group);
      const boundsSize = bounds.getSize(new Vector3());
      const centre = bounds.getCenter(new Vector3());
      charHalfExtent = portraitHalfExtent(boundsSize.x, boundsSize.y);
      // Head-on, as the portrait is: straight down the z axis, so the
      // silhouette is the drawing (PLAN §1) and the creature the person
      // sees standing here is the creature the portrait mounts.
      charFraming = { azimuth: 0, elevation: 0, lookX: centre.x, lookY: centre.y };

      hatched = character;
      phase = 'crack';
      reframe = new Spring(0, { settleMs: MOTION.primaryMs });

      return new Promise<void>((resolve) => {
        hatchDone = resolve;
        hatch = startHatch(scene, egg, character, {
          onBurst: (root) => {
            phase = 'exit';
            charRoot = root;
            // The frame follows the creature out of the shell — a slide on
            // a ζ≥1 spring over t.primary, the same span the shell pieces
            // and the rise take, so it is one move and not three.
            reframe?.retarget(1);
            playOptions.onCrack?.();
          },
          onDone: () => {
            phase = 'settled';
            hatch = null;
            hatchDone = null;
            resolve();
          },
        });
      });
    },

    spin(): SpinState {
      return spin.state();
    },

    destroy(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      spin.destroy();
      // A screen torn down mid-hatch must not leave the caller awaiting a
      // sequence that can no longer play.
      hatchDone?.();
      hatchDone = null;
      hatch?.dispose();
      hatch = null;
      charRoot = null;
      reframe?.dispose();
      hatched?.dispose();
      egg.dispose();
      ink.dispose();
      renderer.dispose();
      canvas.remove();
      keys.el.remove();
    },
  };
}
