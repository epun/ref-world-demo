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
 * - the INSET — one wavering hairline CIRCLE whose diameter is the row's own
 *   width, with a live render of your creature and its pile inside it. The
 *   drawing is not this module's: `rect()` publishes where the circle is and
 *   `src/world/portrait.ts` renders the creature's own subtree into that rect
 *   after the frame has composed, scissored to it. This module owns the MARK
 *   — the ring, the size and the slide — and knows nothing about a camera;
 *   the paper the picture stands on is cleared in GL, because the DOM is in
 *   front of the canvas and a fill up here would cover the picture.
 *
 *   IT IS A COLUMN, not a stack (2026-09-17, measured at 390x844 on the
 *   hints delegate's own shot): the picture was BEHIND the row, so the number
 *   sat on the creature and the row's hairline rule cut straight across the
 *   circle — two marks reading as one. So the circle takes the top of the
 *   corner and the number and its rule hang under it, clear of it by
 *   `INSET_GAP_PX`. The offset is written in JS from `rowOffsetPx` rather
 *   than left to flow, because the circle's size is a spring and the row has
 *   to follow it without a step; `rect()` and that one number are what keep
 *   the two boxes from ever overlapping again (pinned in test/ui/size.test.ts).
 *
 * It is the same ring generator as the icon beside the number and the same
 * hairline the join code, the minimap and the leaderboard stand in
 * (TASTE §9a) — one hand drew all of them. No filled panel, no card, no
 * background and no shadow: the corner is a layout, not a surface.
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
import { mapBorderInset, mapMarkScale, wavyBorderPath, wavyBorderPoints } from '../phone/minimap';
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
 * Where the icon's growth stops, in metres of diameter. **[D]**
 *
 * A ring that tracked the ball all the way up would be a chart, not an icon,
 * and the mark set is *small, self-contained icon marks* (TASTE §4). Twenty
 * metres is a ball that has eaten a building — past that the NUMBER carries
 * the news and the ring just says "big".
 */
export const ICON_CAP_M = 20;

/**
 * How small the ring starts, as a fraction of its capped size. **[D]** Not
 * zero and not near it: an icon that begins as a dot has to pop to become a
 * ring, and entrances slide.
 */
export const ICON_MIN_SCALE = 0.34;

/**
 * The ring's scale for a ball this many metres across, in
 * [`ICON_MIN_SCALE`, 1].
 *
 * Square root of the ratio rather than the ratio: the ring is a picture of a
 * circle, so its AREA is what the eye reads as size, and area on a linear
 * radius runs away within a few pickups. Monotonic and capped, so the mark
 * only ever grows and only ever to one size.
 */
export function iconScale(metres: number): number {
  const m = Number.isFinite(metres) && metres > 0 ? metres : 0;
  const t = Math.min(1, Math.sqrt(m / ICON_CAP_M));
  return ICON_MIN_SCALE + (1 - ICON_MIN_SCALE) * t;
}

/**
 * THE READOUT BOX'S OWN FRAME, as svg path data — the project's wavering loop
 * at that size, drawn by the same hand as the join code, the minimap, the
 * leaderboard and the hint labels (`mapBorderInset(mapMarkScale(min))`, the
 * identical expression all four use, so every hairline sits the same distance
 * inside its own edge). PURE and deterministic per size, so the same box is
 * the same hand on every device.
 */
export function rowFramePath(w: number, h: number, seed = SIZE_SEED + 5): string {
  if (!(w > 2) || !(h > 2)) return '';
  const inset = mapBorderInset(mapMarkScale(Math.min(w, h)));
  return wavyBorderPath(wavyBorderPoints(Math.round(w), Math.round(h), inset, seed));
}

// ── the corner ───────────────────────────────────────────────────────────────

/** The icon's box on screen, css px — its capped size, not its current one. */
const ICON_PX = 26;
/** The ring's user-space box. Fixed, so the wavering is computed once. */
const ICON_BOX = 100;
/** Ring radius in that box, leaving the waver room inside the viewBox. */
const ICON_R = ICON_BOX / 2 - 6;
/** Stroke weight on screen, css px — a hairline, like every other border. */
const ICON_STROKE_PX = 1.25;
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
 * [D] The inset's own box in its viewBox — the same 0..100 space the icon's
 * ring is generated in, so both circles are drawn by one hand at one scale
 * and the CSS size is the only thing that differs.
 */
const INSET_BOX = 100;
/** Ring radius in that box, leaving the waver room inside the viewBox. */
const INSET_R = INSET_BOX / 2 - 4;
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
 * [D] Air between the circle and the box under it, css px.
 *
 * The one number that keeps the number and its frame off the picture. About
 * the row's own padding — enough that the two read as two marks, and not so
 * much that they stop being one corner.
 */
export const INSET_GAP_PX = 10;

/**
 * Where the readout's box begins, css px below the corner's own top. PURE.
 *
 * The circle owns the top of the corner and the box hangs under it, LEFT
 * EDGES ALIGNED (the ask): the offset is the circle's whole diameter plus the
 * gap, so the box's frame begins below the bottom of the circle. That is the
 * whole of the no-overlap rule and it is one expression, which is what
 * test/ui/size.test.ts pins.
 */
export function rowOffsetPx(): number {
  return INSET_PX + INSET_GAP_PX;
}

/**
 * [D] The readout's own padding inside its frame, css px — the hint label's
 * (`LABEL_PAD_PX`, src/ui/hints.ts), because these are the same mark: type on
 * paper inside one wavering hairline.
 */
const ROW_PAD_PX = 7;

/** The hairline, css px — the project's one border weight (TASTE §9a). */
const HAIRLINE_PX = 1.25;

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
 * The inset's ring — the top of the corner, out of the flow at its own
 * top-left, at one fixed size, with the readout's box below it (see the
 * header: stacked, the number sat on the creature and the row's rule cut
 * straight across the circle).
 *
 * NO FILL. The paper inside the circle is cleared in WebGL by the render pass
 * (src/world/portrait.ts): this element is in front of the canvas, so a fill
 * here would hide the very thing it frames. Nothing else comes with it —
 * still no shadow, still no radius, still no second fill (TASTE §9a).
 */
.world-size-inset {
  position: absolute;
  left: 0;
  top: 0;
  width: ${INSET_PX}px;
  height: ${INSET_PX}px;
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
/* The drift layer. Nothing fully arrests (TASTE §3), and the transform here
   is written per frame — which is why it is its own element: the slide below
   owns a transform of its own and two of them cannot share one.

   It also carries the column: the box begins one whole circle plus the gap
   below the corner's top (rowOffsetPx), left edge aligned with the
   circle's, which is the layout the ask names. */
.world-size-drift {
  display: block;
  margin-top: ${rowOffsetPx()}px;
}
/*
 * The slide. Out of the way and transparent until there is a ball, then it
 * comes down into place over t.secondary on the drift-settle curve — the
 * css-side equivalent of the ζ≥1 spring, so no bounce by construction.
 */
.world-size-row {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  box-sizing: border-box;
  padding: ${ROW_PAD_PX}px ${ROW_PAD_PX + 4}px;
  color: var(--rw-ink, ${WORLD.ink});
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
/*
 * THE READOUT'S PAPER BOX (user direction, 2026-09-17: *"a rectangular
 * container with a black outline and white fill, in the style of ref world"*).
 *
 * The same mark the join code, the minimap, the leaderboard and the hint
 * labels stand in — type on light paper inside ONE wavering hairline drawn
 * by the same hand (wavyBorderPoints + wavyBorderPath, mapBorderInset,
 * 1.25) and nothing else: no shadow, no radius, no second fill (TASTE §9a,
 * the recorded paper-card ruling). The frame is behind the type and sized to
 * the box, so what grows with the number is the box and not the mark's hand.
 */
.world-size-frame {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}
.world-size-paper {
  fill: var(--rw-light, ${WORLD.light});
  stroke: var(--rw-ink, ${WORLD.ink});
  stroke-width: ${HAIRLINE_PX};
  stroke-linejoin: round;
}
.world-size-row.in {
  opacity: 1;
  transform: translateY(0);
}
/* The ring sits on the type's own baseline block, at its capped size; what
   grows is the path inside it. */
.world-size-icon {
  position: relative;
  display: block;
  width: ${ICON_PX}px;
  height: ${ICON_PX}px;
  align-self: center;
  flex: none;
  overflow: visible;
}
.world-size-ring {
  fill: none;
  stroke: var(--rw-ink, ${WORLD.ink});
}
/* Tabular figures, so a rolling number does not shuffle the line it is on.
   position: relative so the type is over its own paper. */
.world-size-value {
  position: relative;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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

  /*
   * THE INSET, first — an earlier sibling paints behind the row (see the
   * stylesheet), and the number has to read over the picture.
   */
  const inset = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  inset.setAttribute('class', 'world-size-inset');
  inset.setAttribute('viewBox', `0 0 ${INSET_BOX} ${INSET_BOX}`);
  // One fixed diameter (`INSET_PX`), set once: the circle no longer follows
  // the row's width, so nothing about the picture moves when a digit lands.
  inset.setAttribute('width', String(INSET_PX));
  inset.setAttribute('height', String(INSET_PX));
  inset.setAttribute('aria-hidden', 'true');
  const insetRing = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  insetRing.setAttribute('class', 'world-size-inset-ring');
  // Generated ONCE, at the viewBox's own radius: what changes with the
  // circle's size is the css box around it, never the geometry — the same
  // arrangement the icon's ring is under, so neither one re-draws itself
  // thirty times a second.
  insetRing.setAttribute(
    'd',
    wavyBorderPath(wavyRingPoints(INSET_BOX / 2, INSET_BOX / 2, INSET_R, SIZE_SEED + 11)),
  );
  // A hairline stays a hairline: the stroke is in viewBox units, so it is
  // divided back out by the box-to-pixel scale — one write, because the box
  // is one size now.
  insetRing.setAttribute('stroke-width', ((HAIRLINE_PX * INSET_BOX) / INSET_PX).toFixed(3));
  inset.appendChild(insetRing);

  const drift = document.createElement('div');
  drift.className = 'world-size-drift';
  const row = document.createElement('div');
  row.className = 'world-size-row';

  /*
   * THE BOX'S PAPER, behind the type — the recorded paper-card mark (TASTE
   * §9a). Redrawn only when the box's measured size changes, which is what
   * `frameAt` below guards: a wavering path regenerated thirty times a second
   * would be a different hand every frame.
   */
  const box = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  box.setAttribute('class', 'world-size-frame');
  box.setAttribute('aria-hidden', 'true');
  const paper = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  paper.setAttribute('class', 'world-size-paper');
  box.appendChild(paper);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'world-size-icon');
  svg.setAttribute('viewBox', `0 0 ${ICON_BOX} ${ICON_BOX}`);
  svg.setAttribute('aria-hidden', 'true');
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ring.setAttribute('class', 'world-size-ring');
  // One wavering ring, generated once at the capped radius: what changes per
  // frame is the transform around it, never the geometry, so the hand that
  // drew it does not re-draw itself every thirtieth of a second.
  ring.setAttribute(
    'd',
    wavyBorderPath(wavyRingPoints(ICON_BOX / 2, ICON_BOX / 2, ICON_R, SIZE_SEED)),
  );
  svg.appendChild(ring);

  const value = document.createElement('span');
  value.className = 'world-size-value';

  row.append(box, svg, value);
  drift.appendChild(row);
  el.append(inset, drift);
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
  /** The box size the wavering frame was last drawn at — `WxH`. */
  let frameAt = '';
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
        row.classList.add('in');
      }
    }

    eased.update(dt);

    // Under everything, forever: the corner drifts imperceptibly even with a
    // ball that has not changed size in a minute (TASTE §3).
    const d = sampleDrift(now, SIZE_SEED, DRIFT_SCALE);
    drift.style.transform = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;

    if (!shown) return;

    /*
     * THE BOX'S FRAME, at the box's real size. Measured off the live row —
     * the one element that knows what the type and the icon came out to — and
     * redrawn only when that size actually changes, so a number rolling
     * through the same width keeps the same hand (the hint labels' own
     * arrangement, src/ui/hints.ts).
     */
    const w = Math.round(row.offsetWidth);
    const h = Math.round(row.offsetHeight);
    if (w > 2 && h > 2) {
      const key = `${w}x${h}`;
      if (key !== frameAt) {
        frameAt = key;
        box.setAttribute('viewBox', `0 0 ${w} ${h}`);
        paper.setAttribute('d', rowFramePath(w, h));
      }
    }
    if (!inset.classList.contains('in')) inset.classList.add('in');

    const metres = metresOf(eased.value);
    const next = formatLength(metres);
    if (next !== text) {
      text = next;
      value.textContent = next;
    }

    // The ring, at the eased size. `stroke-width` is divided back out by the
    // scale so the hairline stays a hairline at every size — a mark that
    // thickened as it grew would stop being the same mark.
    const s = iconScale(metres);
    const c = ICON_BOX / 2;
    ring.setAttribute('transform', `translate(${c} ${c}) scale(${s.toFixed(4)}) translate(${-c} ${-c})`);
    ring.setAttribute(
      'stroke-width',
      ((ICON_STROKE_PX * ICON_BOX) / (ICON_PX * s)).toFixed(3),
    );
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
      return { x: box.left, y: box.top, w: box.width, h: box.height };
    },
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      eased.dispose();
      el.remove();
    },
  };
}
