/**
 * The device (docs/DEVICE.md) — the hand-drawn handheld the mobile stage
 * lives inside.
 *
 * User ruling, 2026-08-18: *"i want to wrap the mobile interface in the same
 * style as our illustrated world it should look like a hand drawn tomogatchi
 * but it should retain all the functionality that we already built. it should
 * be black and white like the illustrated world."*
 *
 * This module is a FRAME and nothing else. It owns no state, no flow, no
 * timing — the stage (states.ts) and the three screens are untouched by it.
 * What it provides:
 *
 *   .device        the page, in SURFACE.ground paper, centring the box
 *   .device-box    the shell's own 100×168 box, sized `contain` so the
 *                  hand-drawn line weight never stretches (DEVICE §3)
 *   .device-shell  public/device/shell.svg, the artwork, as an <img>
 *   .device-well   the screen well — the stage mounts in here
 *   .device-keys   the six fixed keys, in two rows (DEVICE §2, §3)
 *
 * MOTION (DEVICE §1a): the SHELL never animates. A physical object does not
 * breathe, and a Tamagotchi whose case breathed would read as wrong. The
 * keys are controls rather than shell, so they may cross-fade with the
 * state they belong to — the case around them does not move a pixel. The
 * stage inside the well keeps the world's motion law in full, ambient floor
 * included.
 *
 * COLOUR (DEVICE §1b/§1c): black and white. The ui brief's `#9cd3d4` and
 * its `#161615` ground are both dropped — the darkest thing on this
 * surface is still the creature. Depth is value only: the well
 * (SURFACE.ground) is one step darker than the body (SURFACE.canvas), both
 * of which live in the artwork; the page behind is SURFACE.ground too, so
 * the device reads as an object drawn on the world's paper.
 *
 * THE RINGS ARE DOM, NOT ARTWORK (DEVICE §3). They used to be drawn into
 * shell.svg, which meant they could never be hidden — and the egg state has
 * to hide the keys completely rather than dim them ("when the egg is visible
 * on the tamagotchi, let's hide the buttons"). So each key draws its own
 * ring, at the artwork's own weight, inside its own <button>. That also
 * retires the alignment question permanently: a key cannot be offset from a
 * ring it draws itself.
 *
 * GEOMETRY (DEVICE §3) is binding — public/draw/index.html positions
 * against the same numbers, so they may not be edited on one side only.
 */

import { MOTION, SURFACE, WORLD } from '../taste/tokens';

// ── Binding geometry (DEVICE §3) ────────────────────────────────────────────
// Straight off public/device/shell.svg's viewBox, expressed as shares of
// the device box so both pages can place against them without knowing the
// rendered size.

/** shell.svg's viewBox. The box is sized `contain` to this ratio. */
export const DEVICE_VIEWBOX = { width: 100, height: 168 } as const;

/**
 * Air above and below the device, on top of the safe-area insets.
 *
 * User report: the top key row collided with the browser's own controls.
 * The insets alone do not cover it — ios reports no top inset in a normal
 * browser tab, and the url bar still overlays the layout viewport — so the
 * device is given its own margin and sits a little low in the band, which
 * is also where a handheld naturally rests in the hand.
 */
/** How far a key slides on the way in. Entrances slide (TASTE §2.1). */
const KEY_ENTER_TRAVEL_PX = 6;
/** Stagger between keys, derived from the token scale like the stage's own
 * satellite stagger (PHONE-STAGE §3): t.tertiary / 4. */
const KEY_STAGGER_MS = MOTION.tertiaryMs / 4;

export const DEVICE_TOP_AIR_PX = 42;
export const DEVICE_BOTTOM_AIR_PX = 10;

/**
 * The screen is a 3d object, not a document.
 *
 * User report: dragging to rotate highlighted the whole well like a text
 * selection, because the creature's name sits in the brow and a drag over
 * type is a selection gesture to the browser. Nothing inside the well is
 * selectable text — it is a display showing an object you turn — so the
 * selection and the ios callout are both off, and the drag reads as a drag.
 */
const NO_SELECT = `
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
`;

/**
 * Screen well, usable inner area: viewBox x 15..85, y 38..124.
 *
 * PORTRAIT, not square (DEVICE §3, user ruling "you can make it slightly
 * taller if we need more space"). The device grew from 100×150 to 100×168
 * for one reason: with a square well the alive core fills it edge to edge
 * and the brow has nowhere to go but on top of the drawing. 70 wide by 86
 * tall leaves a band above and below the largest core.
 */
export const DEVICE_WELL = {
  leftPct: 15,
  topPct: (38 / 168) * 100,
  widthPct: 70,
  heightPct: (86 / 168) * 100,
} as const;

/**
 * The six keys, in two rows (DEVICE §3). Centres at viewBox x 30.5 / 50 /
 * 70 on the row lines y 24.6 (top — the band the `ref` word mark vacated)
 * and y 145 (bottom — where the three keys already were), diameter 14.4.
 *
 * The x measures and the diameter are shares of the box's WIDTH; the row
 * lines are shares of its HEIGHT. A physical device has fixed controls, so
 * these never change: what changes is what a key means, and whether it is
 * there at all.
 */
export const DEVICE_KEYS = {
  centresPct: [30.5, 50, 70] as const,
  rowTopPct: {
    top: (24.6 / 168) * 100,
    bottom: (145 / 168) * 100,
  },
  diameterPct: 14.4,
  /** The ring's own stroke, in viewBox units — the artwork's weight. */
  ringStroke: 1.5,
} as const;

/** How many keys the case has, per row and in total. It is a physical object. */
export const KEYS_PER_ROW = 3;
export const KEY_ROW_NAMES = ['top', 'bottom'] as const;
export type KeyRowName = (typeof KEY_ROW_NAMES)[number];
export const KEY_COUNT = KEYS_PER_ROW * KEY_ROW_NAMES.length;

/**
 * The states the CASE knows about, and which of its two rows each one shows
 * (DEVICE §2). This is the phone flow plus `sign` (DEVICE §2a), which is a
 * state of the /draw/ document's stage rather than of the companion's
 * machine — the companion never mounts it, but the case is the same object
 * on both sides of the seam, so the contract for its keys lives here where
 * both halves can read it.
 *
 *   draw   hidden            · undo · clear · done
 *   sign   hidden            · hidden
 *   wait   hidden            · hidden      (the egg shows NO keys at all)
 *   alive  wave·happy·surprised · dance·sleepy·sad
 */
export type DeviceState = 'draw' | 'sign' | 'wait' | 'alive';

export const DEVICE_KEY_ROWS: Record<DeviceState, Record<KeyRowName, boolean>> = {
  draw: { top: false, bottom: true },
  sign: { top: false, bottom: false },
  wait: { top: false, bottom: false },
  alive: { top: true, bottom: true },
};

const STYLE_ID = 'device-style';

/** The artwork. Read from public/ so both pages paint the identical shell. */
const SHELL_SRC = '/device/shell.svg';

function pct(value: number): string {
  return `${value.toFixed(4)}%`;
}

/**
 * The ring's own viewBox side. The key box is `diameterPct` of the device
 * box wide; the ring svg is drawn one stroke wider than that in each
 * direction so the 1.5-unit stroke is never clipped, and is scaled by the
 * same factor — which makes one ring unit exactly one device viewBox unit,
 * so `ringStroke` really is the artwork's weight and not an approximation.
 */
const RING_BOX = DEVICE_KEYS.diameterPct + DEVICE_KEYS.ringStroke;
const RING_SCALE_PCT = (RING_BOX / DEVICE_KEYS.diameterPct) * 100;
/** Half the overhang, so the ring can be placed by offset rather than by a
 * transform — see .device-key-ring. */
const RING_INSET_PCT = (RING_SCALE_PCT - 100) / 2;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  const half = DEVICE_KEYS.diameterPct / 2;
  const keyPlacement = DEVICE_KEYS.centresPct
    .map((centre, index) => `.device-key[data-key='${index}'] { left: ${pct(centre)}; }`)
    .join('\n');
  const rowPlacement = KEY_ROW_NAMES.map(
    (row) => `.device-key-row[data-row='${row}'] { top: ${pct(DEVICE_KEYS.rowTopPct[row])}; }`,
  ).join('\n');
  style.textContent = `
/*
 * The page. One paper (PHONE-STAGE §2) — the same SURFACE.ground the draw
 * page and phone.html paint inline before any script, so the seam between
 * the two documents still has nothing to flash to.
 */
.device {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  /* 100dvh, not 100% of a fixed inset: on ios the layout viewport runs
     UNDER safari's url bar, so a full-height fixed layer is taller than
     what the person can actually see and the case's top row ends up
     behind the browser chrome (user report). dvh is the visible band.
     The percentage is the fallback for engines without dvh. */
  height: 100%;
  height: 100dvh;
  /* Clear of the notch at the top and the home indicator at the bottom,
     plus a little air so the top key row never sits against the browser
     ui — the device is an object lying on the paper, not a full-bleed
     skin, and it needs room above it to read that way. */
  box-sizing: border-box;
  padding: calc(env(safe-area-inset-top, 0px) + ${DEVICE_TOP_AIR_PX}px) 0
    calc(env(safe-area-inset-bottom, 0px) + ${DEVICE_BOTTOM_AIR_PX}px);
  display: grid;
  place-items: center;
  overflow: hidden;
  background: ${SURFACE.ground};
  /* The box measures against this element, not the viewport: container
     units are exact where vh/dvh disagree with a fixed inset on mobile.
     Padding shrinks the container box, so 100cqh already excludes it. */
  container-type: size;
}
/*
 * Sized to contain, centred (DEVICE §3): the shell never distorts and the
 * hand-drawn line weight never stretches. Extra viewport height becomes
 * paper above and below — the device is an object drawn on the world's
 * ground, not a full-bleed skin.
 */
.device-box {
  position: relative;
  width: min(100cqw, calc(100cqh * ${DEVICE_VIEWBOX.width} / ${DEVICE_VIEWBOX.height}));
  aspect-ratio: ${DEVICE_VIEWBOX.width} / ${DEVICE_VIEWBOX.height};
}
/* The artwork. Static by ruling (DEVICE §1a) — no transition, no
   animation, no transform is declared on it anywhere in this file. */
.device-shell {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}
/* The screen well. The stage mounts in here and owns everything inside. */
.device-well {${NO_SELECT}
  position: absolute;
  left: ${pct(DEVICE_WELL.leftPct)};
  top: ${pct(DEVICE_WELL.topPct)};
  width: ${pct(DEVICE_WELL.widthPct)};
  height: ${pct(DEVICE_WELL.heightPct)};
  overflow: hidden;
}
/*
 * The key field spans the whole box, because the two row lines are shares
 * of the box's HEIGHT (DEVICE §3) and a percentage top has to resolve
 * against something that is that tall. It is transparent and inert — only
 * the keys themselves take a pointer — so it covers the screen without
 * taking anything from it.
 */
.device-keys {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.device-keys .device-key-set {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
/*
 * A row is a zero-height line on its drawn centre: the keys hang off it by
 * half their own diameter, and a percentage margin resolves against the
 * box WIDTH, which is the axis the diameter is quoted in.
 */
.device-key-row {
  position: absolute;
  left: 0;
  width: 100%;
  height: 0;
}
${rowPlacement}
/*
 * A HIDDEN row (DEVICE §2 — draw's top row, and both rows on sign and on
 * the egg). Opacity + pointer-events + aria-hidden, never display: the case
 * is a solid object and a removal would relayout it. Hidden, not dimmed —
 * an unavailable key still dims to 0.3 below, but the egg shows no keys at
 * all by ruling.
 */
.device-key-row[data-hidden='true'] {
  opacity: 0;
  pointer-events: none;
}
/*
 * The keys ARRIVE (user ruling, 2026-08-20: *"when the transition happens
 * between the egg and the creature the buttons should animate onto the
 * device nicely not just flash on"*).
 *
 * The egg shows no keys at all, so the six emotes are new elements the
 * moment the creature appears — and a row mounted at full opacity is a
 * hard cut, which TASTE §2.1 forbids at confidence 1.00. They slide up and
 * fade, staggered in reading order by the same STAGGER the stage uses for
 * its satellites, so the case fills in rather than switching on.
 *
 * An animation, not a transition, because the key's own transition is
 * spoken for by the press and disabled states — a delay on that would lag
 * the feedback on a tap.
 */
@keyframes device-key-in {
  from { opacity: 0; transform: translateY(${KEY_ENTER_TRAVEL_PX}px); }
  to   { opacity: 1; transform: none; }
}
.device-key-set[data-enter='true'] .device-key {
  animation: device-key-in ${MOTION.secondaryMs}ms ${MOTION.settleCurve} both;
  animation-delay: calc(var(--key-i, 0) * ${KEY_STAGGER_MS}ms);
}
/* A settled mount (a restore) shows no entrance: replaying one for a state
 * the person was already looking at reads as a glitch (PHONE-STAGE §4). */
.device-key-set[data-enter='false'] .device-key { animation: none; }
/*
 * A key is the real interactive element AND the ring it sits in — the
 * artwork draws no rings any more (DEVICE §3). No css border and no css
 * background: the ring is one stroked circle in the ink value at the
 * artwork's own weight, and the face inside it is the well's value, so the
 * key reads recessed by value alone exactly as the drawn ones did.
 */
.device-key {
  position: absolute;
  top: 0;
  width: ${pct(DEVICE_KEYS.diameterPct)};
  aspect-ratio: 1;
  margin-top: ${pct(-half)};
  margin-left: ${pct(-half)};
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: ${WORLD.ink};
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
${keyPlacement}
.device-key:active { transform: scale(0.96); }
/*
 * Unavailable, not gone (DEVICE §2): an unassigned or inactive key dims to
 * 0.3 and is never removed — removing one would relayout the device, and
 * the device is a solid object.
 *
 * What dims is the MARK, not the ring. The ring is a feature of the CASE —
 * it used to be printed on it, and the case does not change — while the
 * assignment is what is or is not on offer. public/draw/index.html reads
 * the doc the same way, so a key that is present but unavailable looks
 * identical on both sides of the seam.
 */
.device-key:disabled {
  cursor: default;
  pointer-events: none;
}
.device-key:disabled .device-key-mark {
  opacity: 0.3;
}
/*
 * The ring. One unit here is one device viewBox unit (see RING_BOX), so
 * the stroke is the artwork's 1.5 and not an approximation of it.
 *
 * Placed by OFFSET, not by translate(-50%,-50%): a transform here puts the
 * ring on its own composited layer, and a composited layer is rasterized at
 * the compositor's raster scale rather than at the svg's own resolution —
 * which flattened the circle into a visible polygon on any page with a live
 * webgl context (measured in chromium at dpr 3, alive state). Same
 * geometry, no layer, a true curve.
 */
.device-key-ring {
  position: absolute;
  left: ${(-RING_INSET_PCT).toFixed(4)}%;
  top: ${(-RING_INSET_PCT).toFixed(4)}%;
  width: ${RING_SCALE_PCT.toFixed(4)}%;
  height: ${RING_SCALE_PCT.toFixed(4)}%;
  fill: ${SURFACE.ground};
  stroke: currentColor;
  stroke-width: ${DEVICE_KEYS.ringStroke};
  transition:
    stroke-width ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    fill ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
  /*
   * An svg clips to its viewBox by default. The circle is r 7.2 centred at
   * 7.95 in a 15.9 box, so there is exactly 0.75 of margin — which the
   * resting 1.5 stroke fills to the pixel, because a stroke straddles its
   * path. The pressed state thickens it to 2.4, which needs 1.2, so it
   * painted straight out of the box and was sliced flat at the four
   * extremes: a round key read as a squared-off one for as long as it was
   * held (user report — "the corner radius gets cut off as the shape
   * scales"). The geometry is untouched, so the key still lands on DEVICE
   * §3's documented centre and still matches public/draw/index.html across
   * the seam, which carries the identical fix (e2b5a9a).
   */
  overflow: visible;
}
/*
 * Two legible states, carried over from the emote wheel the keys replaced.
 * DEFAULT: the hairline ring, face in the well's value. PRESSED (while
 * held, and held on briefly after the tap so the send is acknowledged): the
 * ring thickens to a drawn-over line, the face lifts to the body's light
 * value so the key reads pushed, and the mark settles a touch smaller. All
 * on the settle curve over t.tertiary — no bounce, no cut, and an emoji
 * mark never changes colour.
 */
.device-key-acked .device-key-ring,
.device-key:not(:disabled):active .device-key-ring {
  stroke-width: ${(DEVICE_KEYS.ringStroke * 1.6).toFixed(2)};
  fill: ${SURFACE.canvas};
}
.device-key-mark {
  position: relative;
  width: 46%;
  height: 46%;
  display: block;
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
/* An emoji mark reads at the same share of the ring the wheel gave it. */
.device-key-mark[data-mark='emoji'] {
  width: 54%;
  height: 54%;
}
.device-key-acked .device-key-mark,
.device-key:not(:disabled):active .device-key-mark {
  transform: scale(0.92);
}
.device-key-glyph {
  /* Native emoji color — the taste's carve-out (TASTE §6). No fill
     override, so the glyph paints with its own palette, not the ink. */
  font-family:
    "apple color emoji", "segoe ui emoji", "noto color emoji", sans-serif;
  user-select: none;
}
`;
  document.head.appendChild(style);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** What a key means in the state currently on screen. */
export interface KeyBase {
  /** Accessible name. Lowercase, always (TASTE §5). */
  label: string;
  /** Optional press handler; callers may also wire the button directly. */
  onPress?: () => void;
}

export interface KeyIcon extends KeyBase {
  /** Icon path data in a 24-unit box. Stroke-only, soft curves. */
  icon: string;
}

export interface KeyEmoji extends KeyBase {
  /** A single emoji glyph, painted in its own colour (TASTE §6). */
  emoji: string;
}

export type KeyAssignment = KeyIcon | KeyEmoji;

/** One row of three, left to right. `null` is an unassigned key — disabled. */
export type KeyRowSpec = readonly [
  KeyAssignment | null,
  KeyAssignment | null,
  KeyAssignment | null,
];

/**
 * The whole case, both rows (DEVICE §2). A `null` ROW is hidden outright —
 * no ring, nothing to press; a `null` KEY inside a visible row keeps its
 * ring and dims.
 */
export interface KeySpec {
  top: KeyRowSpec | null;
  bottom: KeyRowSpec | null;
}

export type KeyTriple = readonly [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];

export interface KeyRow {
  /** Mount this into the stage's tools slot. */
  el: HTMLElement;
  /** The top row, left to right. Always three, always in the DOM. */
  top: KeyTriple;
  /** The bottom row, left to right. Always three, always in the DOM. */
  bottom: KeyTriple;
  /** All six, top row first. */
  buttons: readonly HTMLButtonElement[];
}

function makeRing(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'device-key-ring');
  svg.setAttribute('viewBox', `0 0 ${RING_BOX} ${RING_BOX}`);
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS(SVG_NS, 'circle');
  const c = RING_BOX / 2;
  circle.setAttribute('cx', String(c));
  circle.setAttribute('cy', String(c));
  circle.setAttribute('r', String(DEVICE_KEYS.diameterPct / 2));
  svg.appendChild(circle);
  return svg;
}

function makeMark(assignment: KeyAssignment): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'device-key-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if ('emoji' in assignment) {
    svg.setAttribute('data-mark', 'emoji');
    const glyph = document.createElementNS(SVG_NS, 'text');
    glyph.setAttribute('class', 'device-key-glyph');
    glyph.setAttribute('x', '12');
    glyph.setAttribute('y', '12');
    glyph.setAttribute('text-anchor', 'middle');
    glyph.setAttribute('dominant-baseline', 'central');
    glyph.setAttribute('font-size', '21');
    glyph.textContent = assignment.emoji;
    svg.appendChild(glyph);
    return svg;
  }
  svg.setAttribute('data-mark', 'icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', assignment.icon);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function makeKey(
  assignment: KeyAssignment | null,
  column: number,
  hidden: boolean,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'device-key';
  // The column indexes the CENTRE: both rows sit on the same three x
  // measures (DEVICE §3), so the placement rule is shared.
  button.dataset['key'] = String(column);
  // The ring is the key's own now (DEVICE §3) — but a hidden row draws
  // none, so the case is bare wherever the state says it is.
  if (!hidden) button.appendChild(makeRing());

  if (hidden || assignment === null) {
    // Hidden (the whole row is off) or unassigned (present, unavailable —
    // dimmed by :disabled). Either way it is disabled, never removed
    // (DEVICE §2), and carries nothing to announce.
    button.disabled = true;
    button.setAttribute('aria-hidden', 'true');
    button.tabIndex = -1;
    return button;
  }

  button.setAttribute('aria-label', assignment.label);
  button.appendChild(makeMark(assignment));

  // The acknowledgement (carried over from the wheel): the ring thickens
  // and the face lifts for one t.tertiary after the tap, so a press that
  // sends something is legible without a bounce.
  button.addEventListener('click', () => {
    assignment.onPress?.();
    button.classList.add('device-key-acked');
    window.setTimeout(() => button.classList.remove('device-key-acked'), MOTION.tertiaryMs);
  });
  return button;
}

function makeRow(name: KeyRowName, spec: KeyRowSpec | null): {
  el: HTMLElement;
  buttons: KeyTriple;
} {
  const el = document.createElement('div');
  el.className = 'device-key-row';
  el.dataset['row'] = name;
  const hidden = spec === null;
  if (hidden) {
    // Hidden means opacity + pointer-events + aria-hidden, never display
    // (DEVICE §2/§3): a removal would relayout the case.
    el.dataset['hidden'] = 'true';
    el.setAttribute('aria-hidden', 'true');
  }
  const order = name === 'top' ? 0 : 3;
  const triple: KeyTriple = [
    makeKey(spec === null ? null : spec[0], 0, hidden),
    makeKey(spec === null ? null : spec[1], 1, hidden),
    makeKey(spec === null ? null : spec[2], 2, hidden),
  ];
  // Reading order across BOTH rows, so the six fill in as one gesture
  // rather than two rows racing each other.
  triple.forEach((b, i) => b.style.setProperty('--key-i', String(order + i)));
  for (const button of triple) el.appendChild(button);
  return { el, buttons: triple };
}

/**
 * The six keys for one state. The case always has six, in two fixed rows;
 * what changes is what they mean and whether they are there at all
 * (DEVICE §2) — draw: undo · clear · done on the bottom row alone; sign and
 * the egg: nothing at all; alive: the six emotes, three over three, so the
 * creature is alone in the screen and the controls are on the case, which
 * is what a handheld actually looks like.
 */
export function createKeyRow(spec: KeySpec): KeyRow {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'device-key-set';
  // Entering by default; a settled mount clears it (see states.ts).
  el.dataset['enter'] = 'true';
  const top = makeRow('top', spec.top);
  const bottom = makeRow('bottom', spec.bottom);
  el.append(top.el, bottom.el);
  return {
    el,
    top: top.buttons,
    bottom: bottom.buttons,
    buttons: [...top.buttons, ...bottom.buttons],
  };
}

/** Both rows hidden — sign and the egg (DEVICE §2). */
export const NO_KEYS: KeySpec = { top: null, bottom: null };

export interface DeviceChrome {
  /** The device box — the shell's own 100×168 area. */
  box: HTMLElement;
  /** The screen well. The stage mounts in here. */
  well: HTMLElement;
  /** The key field. The tools slot mounts in here. */
  keys: HTMLElement;
  destroy(): void;
}

/**
 * Build the device and hand back the two places the stage plugs into. The
 * caller owns everything that goes inside; this function owns nothing but
 * the frame.
 */
export function mountDevice(root: HTMLElement): DeviceChrome {
  ensureStyle();

  // ADOPT the case the document already painted, if there is one.
  //
  // phone.html carries the shell as markup now (see its head note): this
  // module cannot run until the whole phone bundle has parsed and boot()'s
  // `await createSession()` has resolved, and building the case only then
  // left the person looking at bare paper for the best part of a second
  // across the /draw/ seam — measured at ~960ms, the single largest
  // frame-to-frame change anywhere in the flow. Adopting it means the
  // markup's first paint IS the device, and this function only takes
  // ownership of it. Building one from scratch stays the path for any host
  // that does not paint it up front (the tests, and any future entry point).
  const adopted = document.querySelector<HTMLElement>('.device');
  const adoptedBox = adopted?.querySelector<HTMLElement>('.device-box') ?? null;
  const adoptedWell = adopted?.querySelector<HTMLElement>('.device-well') ?? null;
  const adoptedKeys = adopted?.querySelector<HTMLElement>('.device-keys') ?? null;
  if (adopted && adoptedBox && adoptedWell && adoptedKeys) {
    // Moved under the caller's root so the tree is the same shape either
    // way. A move is not a reload: the shell is the identical <img> node
    // with its artwork already decoded, and the whole case is fixed-position,
    // so no pixel changes on the frame it happens.
    root.appendChild(adopted);
    return {
      box: adoptedBox,
      well: adoptedWell,
      keys: adoptedKeys,
      destroy(): void {
        adopted.remove();
      },
    };
  }

  const device = document.createElement('div');
  device.className = 'device';

  const box = document.createElement('div');
  box.className = 'device-box';

  const shell = document.createElement('img');
  shell.className = 'device-shell';
  shell.src = SHELL_SRC;
  // Decorative: the artwork carries no information the screen does not.
  shell.alt = '';
  shell.setAttribute('aria-hidden', 'true');
  shell.draggable = false;

  const well = document.createElement('div');
  well.className = 'device-well';

  const keys = document.createElement('div');
  keys.className = 'device-keys';

  box.append(shell, well, keys);
  device.appendChild(box);
  root.appendChild(device);

  return {
    box,
    well,
    keys,
    destroy(): void {
      device.remove();
    },
  };
}
