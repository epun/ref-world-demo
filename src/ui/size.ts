/**
 * The ball's size, top-left of the world view.
 *
 * > User ask, 2026-09-16, with a frame of *Katamari Damacy* showing its own
 * > `34cm5mm` readout: *"for the mobile ui on the world view i want to show
 * > ball diameter in the top left hand side."*
 *
 * It is the one number this game gives a person about their own run, and the
 * reference puts it in the top-left corner — so that is where it goes, in the
 * one corner of the phone's world view that nothing else is using (the
 * minimap is bottom-right and the stick is dead centre of the tray, see
 * src/world/tray.ts).
 *
 * THE MARKS, and there are three (TASTE §4 — `icon` + `ruleLine` + `border`,
 * the world brief's #1 defining signal at confidence 1.00):
 *
 * - the NUMBER, set in the world view's own type — the same face and size as
 *   `.world-say` and `.draw-hint` in src/main.ts, because this is another
 *   line of the world's own chrome and a second face here would be a second
 *   voice. Lowercase throughout: `cm`, `mm` and `m` already are, and the
 *   taste has no uppercase anywhere (TASTE §5);
 * - a HAIRLINE RULE under it — the brief's *"reserve a single hairline rule
 *   to divide the frame"*, the same border-bottom mark the tray's hint and
 *   the operator line already carry;
 * - an ICON: a ring, drawn by the same hand as every other border in this
 *   world (`wavyRingPoints` + `wavyBorderPath`, shared with the stick), that
 *   GROWS WITH THE BALL and stops growing at a cap. A picture of the thing
 *   the number is about, which is what an icon mark is for.
 *
 * …and since 2026-09-17 a fourth mark, which is a PICTURE rather than a
 * number (user ask: *"in the top left hand corner we should show a live view
 * of the character and the objects it collects. the 3d view of the character
 * and the object ball should not scale beyond the radius measurement ui div
 * in the top left"*):
 *
 * - the INSET — a live render of your creature and the mass on it, in a disc,
 *   with the NUMBER CURVING AROUND IT. The drawing is not this module's:
 *   `rect()` publishes where the disc is and `src/world/portrait.ts` renders
 *   the creature's own subtree into that rect after the frame has composed,
 *   scissored to it. This module owns the MARKS and knows nothing about a
 *   camera; the paper the picture stands on is cleared in GL, because the DOM
 *   is in front of the canvas and a fill up here would cover the picture.
 *
 *   THREE RINGS, FROM THE INSIDE OUT (user mock, 2026-09-17 — which replaced
 *   the paper box this corner carried for an afternoon, and the hairline rule
 *   before that; both had the number sitting ON the picture):
 *
 *     1. the DISC, `INSET_PX` across, which is the 3d view and nothing else;
 *     2. the BAND around it, `BAND_PX` wide: white at `BAND_ALPHA` with both
 *        its edges FEATHERED — a radial gradient rather than a ring, so it
 *        fades into the picture on the inside and into the world on the
 *        outside and has no edge of its own. It is what makes the number
 *        legible over a meadow;
 *     3. and the number ON that band, on a circular text path along the
 *        lower-right, then the project's own wavering hairline outermost.
 *
 *   THE GLYPHS ARE UPRIGHT, which is a property of the path's DIRECTION and
 *   the one thing the mock got wrong (*"with the text readable and flipped
 *   the correct way"*): text is laid along the path with its up-vector on the
 *   travel direction's left, so an arc drawn clockwise on the lower half puts
 *   the letters' feet outward and reads upside down. `ringTextPath` sweeps
 *   COUNTER-CLOCKWISE, from below the centre round to its right, so the
 *   letters stand up and read left to right.
 *
 * The outline is the same generator as the stick's ring and the same hairline
 * the join code, the minimap and the leaderboard stand in (TASTE §9a) — one
 * hand drew all of them — and the band's 40% white is the recorded
 * paper-card ruling in the same section. No card, no shadow, no radius.
 *
 * THE MOTION. The displayed diameter is not the true one — it is a ζ ≥ 1
 * spring chasing it over `MOTION.primaryMs` (src/motion/spring.ts, where
 * underdamped is unrepresentable), so the number ROLLS UP as the ball grows
 * and can never overshoot past the size the ball actually is. The ring reads
 * off the same spring, so the two can never disagree. The readout SLIDES in
 * the first time there is a ball to measure — never a pop, never a
 * `scale: 0 → 1` (TASTE §2.1, confidence 1.00) — and shows nothing at all
 * before that: a creature in its shell has no ball, and `0cm 0mm` in the
 * corner would be a number about nothing. Underneath it all the ambient
 * drift floor runs, forever, like everything else on screen (TASTE §3).
 *
 * THIS MODULE IS KATAMARI-ONLY (2026-09-15 user ruling, src/world/game.ts).
 * There is no ball in a world without the game, so `src/main.ts` reaches it
 * through a DYNAMIC import behind `game === 'katamari'` — the same discipline
 * the object library is loaded under (src/world/katamari/source.ts): the
 * public world and meridian never pull this chunk at all.
 *
 * Pure helpers (the metre conversion, the format, the icon curve) live at the
 * top with no DOM in them, so test/ui can cover the thing that is actually
 * easy to get wrong — the rounding at the two unit boundaries — in node.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { Spring } from '../motion/spring';
import { sampleDrift } from '../motion/ambient';
import { wavyBorderPath } from '../phone/minimap';
import { wavyRingPoints } from '../world/joystick';
import { WORLD_SCALE } from '../world/katamari/rules';

// ── pure helpers ─────────────────────────────────────────────────────────────

/**
 * World units → metres.
 *
 * `WORLD_SCALE` is the ONE factor between the object library's real metres
 * and this world's units (src/world/katamari/rules.ts: 0.94 is what puts a
 * 1.7 m adult at 1.6 units), and it is defined there as metres → units. So
 * the way back is a division by it and not a second constant: a readout that
 * carried its own number could drift from the props it is standing next to,
 * and then the ball would be measured on a different ruler than the world.
 */
export function metresOf(units: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  return units / WORLD_SCALE;
}

/**
 * A length, the way the game says it.
 *
 * Three bands, and the unit pair is what makes a growing ball legible:
 *
 * - under a metre — `34cm 5mm`, because a centimetre is a visible step when
 *   the whole ball is a handful of them;
 * - a metre and over — `1m 23cm`, for the same reason one band up;
 * - over a hundred metres — `123m` alone: a centimetre on a ball the size of
 *   a town is noise, and a number that never stops changing in its last
 *   digit reads as broken rather than as precise.
 *
 * The rounding is done in the SMALLEST unit of the band and then carried up,
 * so `0.9999 m` reads `1m 0cm` rather than `99cm 10mm` — a unit that has
 * rolled over has to take the band with it.
 *
 * All lowercase. `cm`, `mm` and `m` already are, and this is the one place a
 * capital could sneak into the world view (TASTE §5, confidence 1.00).
 */
export function formatLength(metres: number): string {
  const m = Number.isFinite(metres) && metres > 0 ? metres : 0;
  if (m >= 100) return `${Math.round(m)}m`;
  if (m >= 1) {
    const cm = Math.round(m * 100);
    // Carried past the top of the band by the rounding itself.
    if (cm >= 100 * 100) return `${cm / 100}m`;
    return `${Math.floor(cm / 100)}m ${cm % 100}cm`;
  }
  const mm = Math.round(m * 1000);
  // …and past the top of this one, which is where `99cm 10mm` used to live.
  if (mm >= 1000) return `1m 0cm`;
  return `${Math.floor(mm / 10)}cm ${mm % 10}mm`;
}

/**
 * THE ARC THE NUMBER IS WRITTEN ON, as svg path data. PURE.
 *
 * A circular path of radius `r` about the box's centre, from `fromDeg` to
 * `toDeg` measured clockwise from three o'clock in SVG's own coordinates
 * (y down) — and the DIRECTION is the whole point of it, not a detail:
 *
 * SVG lays text along a path with each glyph's up-vector on the LEFT of the
 * travel direction. On the lower half of a circle, travelling clockwise (the
 * direction a naive arc takes) puts that left-hand side on the OUTSIDE, so
 * the letters hang feet-outward and read upside down — which is exactly what
 * the user's mock showed and exactly what they asked to have flipped
 * (*"with the text readable and flipped the correct way"*). So this runs
 * COUNTER-CLOCKWISE: from below the centre round to its right, which puts the
 * up-vector on the inside, stands the letters up, and reads left to right.
 *
 * One `A` command, sweep flag 0 (counter-clockwise in a y-down space) and
 * large-arc 0, because a readout is never more than a quarter of the ring.
 */
export function ringTextPath(r: number, fromDeg = 100, toDeg = 8, cx = 50, cy = 50): string {
  if (!(r > 0)) return '';
  const at = (deg: number): { x: number; y: number } => {
    const a = (deg * Math.PI) / 180;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  };
  const start = at(fromDeg);
  const end = at(toDeg);
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${r.toFixed(3)} ${r.toFixed(
    3,
  )} 0 0 0 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
}

// ── the corner ───────────────────────────────────────────────────────────────

/** The mark's user-space box. Fixed, so the wavering is computed once. */
const INSET_BOX = 100;
/** Stable seed for the ring's waver and the corner's drift channel. */
const SIZE_SEED = 58.2;
/**
 * Nominal scale the drift amplitude is a fraction of, px. The minimap uses
 * its own 140; this corner is about the same span, and `MOTION` owns the
 * fraction either way.
 */
const DRIFT_SCALE = 140;
/** Draw cadence — a number that rolls, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;

/**
 * [D] THE CIRCLE'S DIAMETER, css px — one number, and it no longer follows
 * the row.
 *
 * > User direction, 2026-09-17, with two phone screenshots of a 52 m ball:
 * > *"move the size of the ball BELOW the actual visual representation so
 * > that it's not overlapped. Put it in a rectangular container with a black
 * > outline and white fill, in the style of ref world. It should sit on the
 * > left-hand side, just below the circle."*
 *
 * The picture and the number are two marks in a column now, so the circle has
 * no reason to be measured off the type — and a diameter that grew with the
 * number moved the whole corner every time a digit landed. 104 px is a
 * quarter of the narrowest phone this world is drawn on (390) plus a little:
 * big enough to read a creature and its pile in, small enough to leave the
 * corner a corner.
 */
export const INSET_PX = 104;

/**
 * [D] How wide the band around the disc is, css px — the ring the number is
 * written on. Wide enough for the type at `RING_TEXT_PX` with air on both
 * sides of it, and it is the whole of the difference between the picture and
 * the mark: `INSET_PX + 2 × BAND_PX` is the corner's own box.
 */
export const BAND_PX = 16;

/** The mark's whole box, css px — the disc plus the band on both sides. */
export function ringBoxPx(): number {
  return INSET_PX + 2 * BAND_PX;
}

/**
 * [D] The band's white, and it is a FEATHERED 40% rather than a fill (user
 * mock, 2026-09-17: *"white fill at 40% opacity with a slight feathered
 * blur"*) — the recorded paper-card ruling (TASTE §9a) at the softest it has
 * ever been drawn.
 */
export const BAND_ALPHA = 0.4;

/**
 * [D] How much of the band each edge's feather eats, as a fraction of the
 * band's width. A fifth in from the picture and a fifth in from the outline,
 * so the 40% only reaches full strength across the middle three fifths and
 * neither edge is a line.
 */
export const BAND_FEATHER = 0.2;

/** The hairline, css px — the project's one border weight (TASTE §9a). */
const HAIRLINE_PX = 1.25;

/** [D] The number's type size on the band, css px. */
const RING_TEXT_PX = 11;

/**
 * The band's two radii and the number's own, in the viewBox's 0..100 space.
 *
 * `BAND_OUT_R` leaves the wavering hairline room to waver inside the box;
 * `BAND_IN_R` is where the disc ends, which is the same fraction of the box
 * that `INSET_PX` is of `ringBoxPx()`; and the type's baseline sits a little
 * outside the disc so its ascenders stay inside the outline.
 */
const BAND_OUT_R = INSET_BOX / 2 - 2;
const BAND_IN_R = (INSET_BOX / 2) * (INSET_PX / ringBoxPx());
const RING_TEXT_R = BAND_IN_R + 2.2;

/** One id per mounted readout, so two on a page cannot collide. */
let markIds = 0;
function nextMarkId(): number {
  markIds += 1;
  return markIds;
}

const STYLE_ID = 'world-size-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.world-size {
  position: fixed;
  left: calc(env(safe-area-inset-left, 0px) + 4vw);
  top: calc(env(safe-area-inset-top, 0px) + 4vw);
  z-index: 5;
  pointer-events: none;
}
/*
 * The mark: a disc of world, a feathered white band around it, the number on
 * that band, and the project's wavering hairline outermost (user mock,
 * 2026-09-17). Out of the flow at the corner's own top-left, at one fixed
 * size, with nothing under it and nothing over the picture.
 *
 * NO FILL ON THE DISC. The paper inside it is the WORLD — the render pass
 * (src/world/portrait.ts) draws the creature into that rect, and this element
 * is in front of the canvas, so a fill here would hide the very thing it
 * frames. The band's white is the recorded paper-card ruling (TASTE §9a) and
 * it is 40% with both edges feathered, so it has no edge of its own: no card,
 * no shadow, no radius.
 */
.world-size-inset {
  position: absolute;
  left: 0;
  top: 0;
  width: ${ringBoxPx()}px;
  height: ${ringBoxPx()}px;
  display: block;
  opacity: 0;
  transition: opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
  overflow: visible;
}
.world-size-inset.in {
  opacity: 1;
}
.world-size-inset-ring {
  fill: none;
  stroke: var(--rw-ink, ${WORLD.ink});
}
/* The band's white — the theme's light role, which on the ghibli style is
   that world's own paper. Each stop's opacity is written per stop; this is
   the one colour they share. */
.world-size-stop {
  stop-color: var(--rw-light, ${WORLD.light});
}
/* The arc is a path for the type to sit on and is never drawn itself. */
.world-size-arc {
  fill: none;
  stroke: none;
}
/* The drift layer. Nothing fully arrests (TASTE §3), and the transform here
   is written per frame — which is why it is its own element. */
.world-size-drift { display: block; }
/* Tabular figures, so a rolling number does not shuffle the letters it is
   curving through. Lowercase, in the world view's own face, on the band. */
.world-size-value {
  text-anchor: middle;
  font: 400 ${RING_TEXT_PX}px/1 ui-sans-serif, system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  fill: var(--rw-ink, ${WORLD.ink});
  stroke: none;
  letter-spacing: 0.02em;
}
`;
  document.head.appendChild(style);
}

export interface BallSizeOptions {
  /**
   * How wide YOUR ball is right now, in world units
   * (`CreatureManager.ballDiameter`).
   *
   * A function, not a number: the ball grows on every frame a pickup lands
   * on it, and this reads it per frame off the manager rather than being
   * told about it — the same arrangement the minimap's `self` is under. 0
   * means there is nothing to measure yet (still a shell, or a world without
   * the game), and the corner stays empty.
   */
  diameter(): number;
  mount: HTMLElement;
}

export interface BallSizeHandle {
  /** The corner's root, for a caller that owns where it hangs. */
  el: HTMLElement;
  /**
   * WHERE THE LIVE VIEW GOES — the inset circle's box in css pixels from the
   * top-left of the page, or null while there is nothing to show (2026-09-17).
   *
   * This is the whole contract with the render pass: the picture is drawn
   * into this rect and scissored to it, so *"the 3d view … should not scale
   * beyond the radius measurement ui div"* is a property of the rect rather
   * than a hope about a camera. Square, because the mark is a circle.
   *
   * Measured from the live element rather than computed, so the safe-area
   * insets and the 4vw corner are read from the one place that knows them —
   * the stylesheet.
   */
  rect(): { x: number; y: number; w: number; h: number } | null;
  /** What the corner says right now — '' while it is still showing nothing. */
  text(): string;
  /** Has it slid in yet? */
  shown(): boolean;
  dispose(): void;
}

/**
 * Mount the readout. Knows what a diameter is and nothing else — it never
 * touches the scene, the manager or the camera.
 */
export function installBallSize(opts: BallSizeOptions): BallSizeHandle {
  ensureStyle();

  const el = document.createElement('div');
  el.className = 'world-size';
  // Findable, and it says what it is rather than reading out a bare number.
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'your ball');

  const drift = document.createElement('div');
  drift.className = 'world-size-drift';

  /*
   * THE MARK, one svg: the feathered band, the wavering outline, and the
   * number on an arc between them. The disc in the middle is not drawn at all
   * — it is the world, with the portrait pass scissored into it.
   */
  const inset = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  inset.setAttribute('class', 'world-size-inset');
  inset.setAttribute('viewBox', `0 0 ${INSET_BOX} ${INSET_BOX}`);
  inset.setAttribute('width', String(ringBoxPx()));
  inset.setAttribute('height', String(ringBoxPx()));
  inset.setAttribute('aria-hidden', 'true');

  /*
   * Two ids, because a gradient and a text path can only be referenced by
   * one — and a counter, because two handsets' readouts on one page (a test,
   * or a projection with a tray) must not collide.
   */
  const uid = `rw-size-${nextMarkId()}`;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
  grad.setAttribute('id', `${uid}-band`);
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('cx', String(INSET_BOX / 2));
  grad.setAttribute('cy', String(INSET_BOX / 2));
  grad.setAttribute('r', String(BAND_OUT_R));
  /*
   * THE FEATHER, as four stops: nothing at the picture's edge, full white
   * across the middle of the band, nothing again at the outline. A blur
   * filter would do it too and would cost a full-size offscreen pass on a
   * phone for a mark this small (TASTE §2.3 — and a hard ring is what the
   * mock says not to draw).
   */
  const feather = (BAND_OUT_R - BAND_IN_R) * BAND_FEATHER;
  const stops: [number, number][] = [
    [BAND_IN_R, 0],
    [BAND_IN_R + feather, BAND_ALPHA],
    [BAND_OUT_R - feather, BAND_ALPHA],
    [BAND_OUT_R, 0],
  ];
  for (const [at, alpha] of stops) {
    const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop.setAttribute('class', 'world-size-stop');
    stop.setAttribute('offset', (at / BAND_OUT_R).toFixed(4));
    // The COLOUR comes from the sheet, so it is the theme's `light` role and
    // not a hex literal in a module (TASTE §7, the achromatic gate) — what
    // varies per stop is only how much of it there is.
    stop.setAttribute('stop-opacity', alpha.toFixed(3));
    grad.appendChild(stop);
  }
  defs.appendChild(grad);

  // The arc the number is written on, and nothing draws it.
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arc.setAttribute('id', `${uid}-arc`);
  arc.setAttribute('class', 'world-size-arc');
  arc.setAttribute('d', ringTextPath(RING_TEXT_R));
  defs.appendChild(arc);
  inset.appendChild(defs);

  const band = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  band.setAttribute('class', 'world-size-band');
  band.setAttribute('cx', String(INSET_BOX / 2));
  band.setAttribute('cy', String(INSET_BOX / 2));
  band.setAttribute('r', String(BAND_OUT_R));
  band.setAttribute('fill', `url(#${uid}-band)`);
  inset.appendChild(band);

  const insetRing = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  insetRing.setAttribute('class', 'world-size-inset-ring');
  /*
   * The outline: generated ONCE at the viewBox's own radius by the same hand
   * as the stick's ring and the join code's frame (TASTE §9a). A hairline
   * stays a hairline — the stroke is in viewBox units, so it is divided back
   * out by the box-to-pixel scale.
   */
  insetRing.setAttribute(
    'd',
    wavyBorderPath(wavyRingPoints(INSET_BOX / 2, INSET_BOX / 2, BAND_OUT_R, SIZE_SEED + 11)),
  );
  insetRing.setAttribute('stroke-width', ((HAIRLINE_PX * INSET_BOX) / ringBoxPx()).toFixed(3));
  inset.appendChild(insetRing);

  // …and the number, curving along that arc with its glyphs upright.
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('class', 'world-size-value');
  const value = document.createElementNS('http://www.w3.org/2000/svg', 'textPath');
  value.setAttribute('href', `#${uid}-arc`);
  /*
   * CENTRED ON THE ARC, not started at its end: the mock puts the number on
   * the lower-RIGHT of the ring, and a string anchored at the path's start
   * grows away from there as the ball does (`34cm 5mm` → `15m 16cm`). Half
   * way along the arc with `text-anchor: middle` keeps the reading centred on
   * that diagonal at every length.
   */
  value.setAttribute('startOffset', '50%');
  // `xlink:href` beside it, because Safari still reads that one on textPath.
  value.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${uid}-arc`);
  label.appendChild(value);
  inset.appendChild(label);

  drift.appendChild(inset);
  el.appendChild(drift);
  opts.mount.appendChild(el);

  /*
   * The number's own motion. One ζ ≥ 1 spring over `MOTION.primaryMs`, on
   * the DIAMETER rather than on the text — the ring reads the same value, so
   * a mark and a number that are about the same ball cannot fall out of step.
   *
   * It starts at 0 and is retargeted, never reset: the first ball rolls the
   * number up from nothing as the row slides in, which is one entrance
   * instead of a slide with a number already in it.
   */
  const eased = new Spring(0, { settleMs: MOTION.primaryMs });
  let shown = false;
  let text = '';
  let last = 0;

  const paint = (now: number): void => {
    const dt = last === 0 ? DRAW_INTERVAL_MS : Math.max(0, now - last);
    last = now;

    const target = opts.diameter();
    /*
     * Nothing to measure: no ball yet (a shell), or a world with no game at
     * all. The corner stays as it is — and if it has already slid in, it
     * keeps the last size it knew rather than falling back to zero, because
     * a creature that is being retired is not a creature that shrank.
     */
    if (target > 0) {
      eased.retarget(target);
      if (!shown) {
        shown = true;
        inset.classList.add('in');
      }
    }

    eased.update(dt);

    // Under everything, forever: the corner drifts imperceptibly even with a
    // ball that has not changed size in a minute (TASTE §3).
    const d = sampleDrift(now, SIZE_SEED, DRIFT_SCALE);
    drift.style.transform = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;

    if (!shown) return;

    const metres = metresOf(eased.value);
    const next = formatLength(metres);
    if (next !== text) {
      text = next;
      value.textContent = next;
    }
  };

  // ── ~30fps loop: own rAF, skipping frames — the minimap's arrangement ─────
  let raf = 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    paint(now);
  };
  const start = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    if (raf === 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else {
      // A tab that was away for a minute must not hand the spring that whole
      // minute as one step — the number would jump to the ball's new size,
      // and a jump is a cut (TASTE §2.1).
      last = 0;
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  return {
    el,
    text: () => text,
    shown: () => shown,
    rect(): { x: number; y: number; w: number; h: number } | null {
      // Nothing to frame yet — a creature in its shell has no ball and the
      // corner is empty, so there is no picture either.
      if (!shown) return null;
      const box = inset.getBoundingClientRect();
      if (!(box.width > 1) || !(box.height > 1)) return null;
      /*
       * THE DISC, not the mark: the svg is the disc plus the band on all four
       * sides, and what the render pass is handed has to be the picture alone
       * or the creature would be drawn under the number and under the
       * outline. One inset, both axes.
       */
      return {
        x: box.left + BAND_PX,
        y: box.top + BAND_PX,
        w: Math.max(0, box.width - 2 * BAND_PX),
        h: Math.max(0, box.height - 2 * BAND_PX),
      };
    },
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      eased.dispose();
      el.remove();
    },
  };
}
