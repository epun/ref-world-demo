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
 * No filled panel, no card, no background and no shadow: the corner is a
 * layout, not a surface.
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
/* The drift layer. Nothing fully arrests (TASTE §3), and the transform here
   is written per frame — which is why it is its own element: the slide below
   owns a transform of its own and two of them cannot share one. */
.world-size-drift { display: block; }
/*
 * The slide. Out of the way and transparent until there is a ball, then it
 * comes down into place over t.secondary on the drift-settle curve — the
 * css-side equivalent of the ζ≥1 spring, so no bounce by construction.
 */
.world-size-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding-bottom: 0.45em;
  border-bottom: 1px solid ${WORLD.ink};
  color: ${WORLD.ink};
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.world-size-row.in {
  opacity: 1;
  transform: translateY(0);
}
/* The ring sits on the type's own baseline block, at its capped size; what
   grows is the path inside it. */
.world-size-icon {
  display: block;
  width: ${ICON_PX}px;
  height: ${ICON_PX}px;
  align-self: center;
  flex: none;
  overflow: visible;
}
.world-size-ring {
  fill: none;
  stroke: ${WORLD.ink};
}
/* Tabular figures, so a rolling number does not shuffle the line it is on. */
.world-size-value {
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
  const row = document.createElement('div');
  row.className = 'world-size-row';

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

  row.append(svg, value);
  drift.appendChild(row);
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
        row.classList.add('in');
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
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      eased.dispose();
      el.remove();
    },
  };
}
