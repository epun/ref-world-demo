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
 *   .device-box    the shell's own 100×150 box, sized `contain` so the
 *                  hand-drawn line weight never stretches (DEVICE §3)
 *   .device-shell  public/device/shell.svg, the artwork, as an <img>
 *   .device-well   the screen well — the stage mounts in here
 *   .device-keys   the three fixed keys, over the drawn rings
 *
 * MOTION (DEVICE §1a): nothing in here animates, ever. A physical object
 * does not breathe, and a Tamagotchi whose case breathed would read as
 * wrong. The stage inside the well keeps the world's motion law in full,
 * ambient floor included — the shell simply is not part of it. No
 * transition, no animation, no transform is declared on the body, the
 * bezel, the drawn buttons or the motifs.
 *
 * COLOUR (DEVICE §1b/§1c): black and white. The ui brief's `#9cd3d4` and
 * its `#161615` ground are both dropped — the darkest thing on this
 * surface is still the creature. Depth is value only: the well
 * (SURFACE.ground) is one step darker than the body (SURFACE.canvas), both
 * of which live in the artwork; the page behind is SURFACE.ground too, so
 * the device reads as an object drawn on the world's paper.
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
 * The three keys. Centres at viewBox x 30.5 / 50 / 70 on the row line
 * y 145, diameter 14.4 — all as shares of the box's WIDTH except the row
 * line, which is a share of its height. The artwork draws its rings at
 * exactly these centres, so the keys land on them with zero offset.
 */
export const DEVICE_KEYS = {
  centresPct: [30.5, 50, 70] as const,
  rowTopPct: (145 / 168) * 100,
  diameterPct: 14.4,
} as const;

/** How many keys the case has. Fixed: it is a physical object. */
export const KEY_COUNT = 3;

const STYLE_ID = 'device-style';

/** The artwork. Read from public/ so both pages paint the identical shell. */
const SHELL_SRC = '/device/shell.svg';

function pct(value: number): string {
  return `${value.toFixed(4)}%`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  const half = DEVICE_KEYS.diameterPct / 2;
  const keyPlacement = DEVICE_KEYS.centresPct.map(
    (centre, index) => `.device-key[data-key='${index}'] { left: ${pct(centre)}; }`,
  ).join('\n');
  style.textContent = `
/*
 * The page. One paper (PHONE-STAGE §2) — the same SURFACE.ground the draw
 * page and phone.html paint inline before any script, so the seam between
 * the two documents still has nothing to flash to.
 */
.device {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: ${SURFACE.ground};
  /* The box measures against this element, not the viewport: container
     units are exact where vh/dvh disagree with a fixed inset on mobile. */
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
.device-well {
  position: absolute;
  left: ${pct(DEVICE_WELL.leftPct)};
  top: ${pct(DEVICE_WELL.topPct)};
  width: ${pct(DEVICE_WELL.widthPct)};
  height: ${pct(DEVICE_WELL.heightPct)};
  overflow: hidden;
}
/*
 * The key row. A zero-height line on the drawn row centre: the keys hang
 * off it by half their own diameter, and a percentage margin resolves
 * against the box WIDTH, which is the axis the diameter is quoted in.
 */
.device-keys {
  position: absolute;
  left: 0;
  width: 100%;
  top: ${pct(DEVICE_KEYS.rowTopPct)};
  height: 0;
}
.device-key-row {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 0;
}
/*
 * A key is the real interactive element sitting on top of a drawn ring.
 * The ring is artwork (it is in the svg and never changes); the key
 * carries the hit area, the accessible name and the mark. No border of
 * its own — a second ring on top of the drawn one would read as a filled
 * ui control, which TASTE §4 has no mark for.
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
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
${keyPlacement}
.device-key:active { transform: scale(0.96); }
/* The existing disabled treatment, unchanged (DEVICE §2): an unassigned or
   inactive key dims, it is never removed — removing one would relayout the
   device, and the device is a solid object. */
.device-key:disabled {
  opacity: 0.3;
  cursor: default;
  pointer-events: none;
}
.device-key svg {
  width: 46%;
  height: 46%;
  display: block;
}
`;
  document.head.appendChild(style);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** What a key means in the state currently on screen. */
export interface KeyAssignment {
  /** Accessible name. Lowercase, always (TASTE §5). */
  label: string;
  /** Icon path data in a 24-unit box. Stroke-only, soft curves. */
  icon: string;
  /** Optional press handler; callers may also wire the button directly. */
  onPress?: () => void;
}

/** Three keys, left to right. `null` is an unassigned key — disabled. */
export type KeySpec = readonly [
  KeyAssignment | null,
  KeyAssignment | null,
  KeyAssignment | null,
];

export interface KeyRow {
  /** Mount this into the stage's tools slot. */
  el: HTMLElement;
  /** Always three, always present, left to right. */
  buttons: readonly [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];
}

function makeKey(assignment: KeyAssignment | null, index: number): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'device-key';
  button.dataset['key'] = String(index);
  if (assignment === null) {
    // Unassigned: disabled, not removed (DEVICE §2). It carries no mark, so
    // the drawn ring behind it is all that shows — and the drawn ring is
    // shell, which never changes (DEVICE §1a). Nothing to announce.
    button.disabled = true;
    button.setAttribute('aria-hidden', 'true');
    button.tabIndex = -1;
    return button;
  }
  button.setAttribute('aria-label', assignment.label);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', assignment.icon);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  button.appendChild(svg);
  if (assignment.onPress) button.addEventListener('click', assignment.onPress);
  return button;
}

/**
 * The three keys for one state. The case always has three; what changes is
 * what they mean (DEVICE §2) — draw: undo · clear · done; wait: hatch on
 * the middle key alone; alive: all three idle. The emote wheel stays in the
 * core: seven emotes do not map to three keys, and the wheel is screen
 * content, not a control on the case.
 */
export function createKeyRow(spec: KeySpec): KeyRow {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'device-key-row';
  const buttons = spec.map((assignment, index) => makeKey(assignment, index));
  for (const button of buttons) el.appendChild(button);
  return {
    el,
    buttons: buttons as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement],
  };
}

export interface DeviceChrome {
  /** The device box — the shell's own 100×150 area. */
  box: HTMLElement;
  /** The screen well. The stage mounts in here. */
  well: HTMLElement;
  /** The key row line. The tools slot mounts in here. */
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
