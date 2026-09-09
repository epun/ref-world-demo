/**
 * The stick: steering your own creature, from the world view on a phone.
 *
 * Everything else a handset can do to its creature is a MOMENT — draw it,
 * emote at it, watch where it went. This is the first continuous one, and
 * continuous input has two problems the moments never had.
 *
 * ── one: the screen is not the ground ────────────────────────────────────
 * The camera is isometric and it ORBITS (the presentation tour drifts it,
 * and a person can drag it). So there is no fixed answer to "which way is
 * up" in world terms — push away from yourself and the creature has to walk
 * away from you at whatever azimuth the camera happens to be at that
 * instant. `stickToWorld` does that rotation, and it is the whole reason
 * this is a module with tests rather than four lines in the tray.
 *
 * ── two: your creature is usually not yours to move ──────────────────────
 * In a shared world one page simulates and everybody else watches it
 * (src/net/worldsync.ts). A phone looking at the projection's world is a
 * VIEWER: its creatures are placed by the host's poses, and anything this
 * page does to them locally is overwritten within 200ms. So the stick does
 * not move a creature. It states an INTENT, and the intent is published to
 * whoever is hosting — which is also what makes the movement visible on the
 * projection and on everybody else's phone, rather than only in the hand
 * holding it. See `drive` in src/creatures/manager.ts for the other end.
 *
 * ── the mark ─────────────────────────────────────────────────────────────
 * A wavering ring and a smaller wavering ring inside it (TASTE §4: border
 * and icon, never a filled panel, never a card, never a shadow). The knob
 * is drawn, not filled with near-black — near-black belongs to characters
 * only, and a control that reads as dark as a creature would compete with
 * the thing it is steering. Both rings are wavy for the same reason every
 * other border here is: no engineered geometry, and a true circle is the
 * most engineered shape there is.
 */

import { hash01 } from '../phone/seed';
import { wavyBorderPath, type BorderPoint } from '../phone/minimap';
import { MOTION, WORLD } from '../taste/tokens';

/** Diameter of the well, in viewport width. Thumb-sized, not hand-sized. */
export const STICK_SIZE_VW = 22;
/** Smallest the well is allowed to get on a narrow handset, CSS px. */
export const STICK_MIN_PX = 84;
/** Largest, so it never becomes a dinner plate on a tablet. */
export const STICK_MAX_PX = 132;
/** The knob, as a fraction of the well's radius. */
export const KNOB_RATIO = 0.38;

/**
 * Below this fraction of the radius the stick reads as centred.
 *
 * Not jitter rejection — a thumb resting on glass is steadier than that.
 * It is that the CENTRE of a joystick has to be a reachable state: without
 * a deadzone the only way to stop is to lift, and "let go to stop" makes
 * every small correction a re-grab. A tenth of the travel costs nothing in
 * range and turns the middle into somewhere you can actually be.
 */
export const DEADZONE = 0.1;

/** How far the knob may leave the centre, as a fraction of the radius. */
export const KNOB_TRAVEL = 0.5;

export interface StickVector {
  /** Screen right, −1..1. */
  x: number;
  /** Screen DOWN, −1..1 — the direction y grows in a browser. */
  y: number;
  /** 0 at rest, 1 at the rim. Already deadzoned and clamped. */
  mag: number;
}

export const STICK_REST: StickVector = { x: 0, y: 0, mag: 0 };

/**
 * Where the thumb is, as a direction and a strength.
 *
 * Clamped to the unit disc rather than the square: dragging into a corner
 * must not be faster than dragging along an axis, which is the oldest bug
 * in this control and the one people feel without being able to name.
 *
 * The deadzone is removed by RESCALING what is left, not by subtracting —
 * so the first millimetre outside it is still a slow walk. Subtracting
 * would make the creature jump straight to a tenth of full speed the
 * instant the stick left the middle, which is a hard cut in velocity and
 * the motion law forbids those at confidence 1.00.
 */
export function stickVector(
  centreX: number,
  centreY: number,
  pointerX: number,
  pointerY: number,
  radius: number,
): StickVector {
  if (!(radius > 0)) return STICK_REST;
  const dx = (pointerX - centreX) / radius;
  const dy = (pointerY - centreY) / radius;
  const raw = Math.hypot(dx, dy);
  if (raw <= DEADZONE) return STICK_REST;
  // Unit direction, then the rescaled strength. Dividing by `raw` before
  // clamping is what makes the disc a disc.
  const ux = dx / raw;
  const uy = dy / raw;
  const mag = Math.min(1, (raw - DEADZONE) / (1 - DEADZONE));
  return { x: ux * mag, y: uy * mag, mag };
}

export interface WorldVector {
  x: number;
  z: number;
  mag: number;
}

export const WORLD_REST: WorldVector = { x: 0, z: 0, mag: 0 };

/**
 * The stick's direction on the GROUND, under the camera as it stands.
 *
 * The camera looks along its azimuth from elevation; on the ground plane
 * that reduces to a rotation, so "screen up" is the horizontal direction
 * pointing away from the viewer and "screen right" is ninety degrees off
 * it. Screen y grows DOWNWARD, so away-from-the-viewer is −y — the sign
 * that is wrong in every first attempt at this, including mine.
 *
 * Matches the camera rig's own convention (src/world/camera.ts): at
 * azimuth `a` the camera sits at (sin a, ·, cos a) looking at the origin,
 * so the vector from camera to target — away from the viewer — is
 * (−sin a, −cos a) in world xz.
 *
 * Read the azimuth EVERY frame the stick is held, never once when it is
 * grabbed. The tour drifts the camera continuously, so a mapping fixed at
 * grab time slowly stops agreeing with the picture while a thumb is still
 * down, and the creature curves away from the direction being asked for.
 */
export function stickToWorld(v: StickVector, azimuth: number): WorldVector {
  if (v.mag <= 0) return WORLD_REST;
  const sin = Math.sin(azimuth);
  const cos = Math.cos(azimuth);
  // away-from-viewer = (−sin, −cos); screen-right = (cos, −sin).
  const away = -v.y;
  const right = v.x;
  return {
    x: away * -sin + right * cos,
    z: away * -cos + right * -sin,
    mag: v.mag,
  };
}

/** Waver of the stick's rings, CSS px — the same hand as every border. */
export const RING_WAVER = 1.4;

/**
 * A ring as a wavering closed loop.
 *
 * `wavyBorderPoints` only makes rectangles, and a rounded rectangle is not
 * a circle however hard it is smoothed. Same idea, same deterministic
 * seeded hash, same midpoint smoothing on the way out — just swept round
 * an angle instead of along four edges.
 */
export function wavyRingPoints(
  cx: number,
  cy: number,
  radius: number,
  seed: number,
  count = 28,
): BorderPoint[] {
  const points: BorderPoint[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const off = (hash01(i * 12.9898 + seed * 78.233) - 0.5) * 2 * RING_WAVER;
    const r = radius + off;
    points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return points;
}

export interface JoystickOptions {
  /**
   * The thumb moved, or let go. Called with the raw screen vector — the
   * caller maps it through the camera, because the caller is the one that
   * knows where the camera is this frame.
   */
  onChange(v: StickVector): void;
}

export interface JoystickHandle {
  el: HTMLElement;
  /** What the stick reads right now. */
  value(): StickVector;
  destroy(): void;
}

const STYLE_ID = 'world-joystick-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.world-stick {
  justify-self: center;
  width: clamp(${STICK_MIN_PX}px, ${STICK_SIZE_VW}vw, ${STICK_MAX_PX}px);
  aspect-ratio: 1;
  position: relative;
  /* The thumb owns this element completely: no scroll, no pinch, no
     double-tap zoom, and no 300ms wait to find out. */
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  /* Faint until touched — it is a control over somebody's world, and the
     world is the thing worth looking at. */
  opacity: 0.55;
  transition: opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.world-stick[data-held='true'] {
  opacity: 1;
}
.world-stick svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.stick-ring,
.stick-knob {
  fill: none;
  stroke: ${WORLD.ink};
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.stick-ring { stroke-width: 1.25; }
.stick-knob { stroke-width: 1.75; }
/* The knob follows the thumb directly while held — a transition here would
   put the control behind the finger, which reads as lag rather than as
   easing. It eases only on the way back to the middle, which IS a motion
   the creature makes too. */
.stick-knob { transition: none; }
.world-stick[data-held='false'] .stick-knob {
  transition: transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
`;
  document.head.appendChild(style);
}

/** Deterministic per-page, so the rings do not re-waver on every render. */
const RING_SEED = 31;
const KNOB_SEED = 74;

/**
 * Mount the stick. Owns its own pointer capture and nothing else — it does
 * not know what a creature is, and it never touches the scene.
 */
export function mountJoystick(options: JoystickOptions): JoystickHandle {
  ensureStyle();

  const el = document.createElement('div');
  el.className = 'world-stick';
  el.dataset['held'] = 'false';
  // A control, and one a screen reader should be able to find even though
  // it cannot be operated without a pointer.
  el.setAttribute('role', 'application');
  el.setAttribute('aria-label', 'move your creature');

  // A fixed 100-unit box scaled by css, so the wavy geometry is computed
  // once and never re-measured on resize.
  const BOX = 100;
  const R = BOX / 2 - 3;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${BOX} ${BOX}`);
  svg.setAttribute('aria-hidden', 'true');

  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ring.setAttribute('class', 'stick-ring');
  ring.setAttribute('d', wavyBorderPath(wavyRingPoints(BOX / 2, BOX / 2, R, RING_SEED)));

  const knob = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  knob.setAttribute('class', 'stick-knob');
  knob.setAttribute(
    'd',
    wavyBorderPath(wavyRingPoints(BOX / 2, BOX / 2, R * KNOB_RATIO, KNOB_SEED, 20)),
  );

  svg.append(ring, knob);
  el.appendChild(svg);

  let value: StickVector = STICK_REST;
  let pointer: number | null = null;

  const paint = (): void => {
    // Half the radius of travel: the knob stays inside its well at full
    // deflection, so the control never looks broken at the limit.
    const tx = value.x * R * KNOB_TRAVEL;
    const ty = value.y * R * KNOB_TRAVEL;
    knob.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)})`);
  };

  const emit = (next: StickVector): void => {
    value = next;
    paint();
    options.onChange(next);
  };

  /** The well's centre and radius, in client coordinates, right now. */
  const geometry = (): { cx: number; cy: number; r: number } => {
    const box = el.getBoundingClientRect();
    return {
      cx: box.left + box.width / 2,
      cy: box.top + box.height / 2,
      r: box.width / 2,
    };
  };

  const read = (event: PointerEvent): void => {
    const g = geometry();
    emit(stickVector(g.cx, g.cy, event.clientX, event.clientY, g.r));
  };

  const down = (event: PointerEvent): void => {
    if (pointer !== null) return;
    pointer = event.pointerId;
    el.dataset['held'] = 'true';
    // Capture, so a thumb that slides off the well keeps steering instead
    // of silently letting go — which on a small control is most of them.
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* a browser that will not capture still gets the window listeners */
    }
    // The world beneath must not pan when the stick is what was grabbed.
    event.preventDefault();
    event.stopPropagation();
    read(event);
  };

  const move = (event: PointerEvent): void => {
    if (pointer !== event.pointerId) return;
    event.preventDefault();
    read(event);
  };

  const up = (event: PointerEvent): void => {
    if (pointer !== event.pointerId) return;
    pointer = null;
    el.dataset['held'] = 'false';
    try {
      el.releasePointerCapture(event.pointerId);
    } catch {
      /* already gone */
    }
    // Back to rest, and the creature's own agent takes it from there.
    emit(STICK_REST);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  // Cancel matters more than up on a handset: a call, the app switcher, or
  // a gesture the system claims all end a touch this way, and a stick left
  // held would walk somebody's creature off on its own.
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);

  paint();

  return {
    el,
    value: () => value,
    destroy(): void {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      el.remove();
    },
  };
}
