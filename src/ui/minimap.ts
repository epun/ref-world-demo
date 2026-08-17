/**
 * World-view minimap (user ask: "in the world view include a mini map in the
 * bottom right hand corner").
 *
 * TASTE §4: UI is icons, hairline rules, thin borders — no filled panels.
 * The map field itself follows the phone precedent (screens/alive.ts): a
 * SURFACE.ground fill inside a deterministic hand-wavering border reads as
 * image, not chrome, and that shipped as on-taste. Everything on it is a
 * hairline mark:
 *
 * - prop marks: sparse tiny WORLD.neutral dots, subsampled from the scatter
 *   so the map stays quiet (density is the design, TASTE §2.3);
 * - creatures: small CHARACTER.body dots — the world view has no "self",
 *   every creature is an inhabitant; eggs are WORLD.light circles with an
 *   ink hairline (unhatched reads lighter, like the shell);
 * - camera: a hairline diamond on the current look-target plus a subtle
 *   frustum wedge rotated by the rig azimuth, so panning and rotating stay
 *   legible on the map. Values are read live — the camera already springs,
 *   smoothing here would double-lag it.
 *
 * Clicking the map slides the camera to that world point through
 * cameraRig.frameAt (a t.primary reframe — never a snap). The whole canvas
 * micro-sways on the ambient drift floor: nothing fully arrests (TASTE §3).
 *
 * Pure helpers (mapping, partitioning, subsampling) live at module top with
 * no DOM use so test/ui can cover them in node; the border loop and
 * world→map projection are REUSED from src/phone/minimap.ts (also pure).
 */

import { Vector3 } from 'three';
import { sampleDrift } from '../motion/ambient';
import {
  mapBorderInset,
  mapMarkScale,
  wavyBorderPoints,
  worldToMap,
  type BorderPoint,
  type MapFrame,
} from '../phone/minimap';
import { CHARACTER, SURFACE, WORLD } from '../taste/tokens';

// ── pure helpers ─────────────────────────────────────────────────────────────

/** Fixed half-extent of the mapped world square — the scattered region plus
 * a little breathing room, so wanderers at the fringe stay on the map. */
export const WORLD_MAP_EXTENT = 130;

/** Inverse of worldToMap: canvas px → world x/z under the same uniform,
 * centered mapping. Lets a click land where the map says it will. */
export function mapToWorld(
  px: number,
  py: number,
  extent: number,
  frame: MapFrame,
): { x: number; z: number } {
  const safeExtent = extent > 0 ? extent : 1;
  const usable = Math.min(frame.w, frame.h) - frame.inset * 2;
  const scale = Math.max(0, usable) / (2 * safeExtent);
  if (scale === 0) return { x: 0, z: 0 };
  return { x: (px - frame.w / 2) / scale, z: (py - frame.h / 2) / scale };
}

/** Every `stride`th item, deterministically (index-based, no randomness):
 * the same scatter subsamples to the same quiet field on every device. */
export function subsample<T>(items: readonly T[], stride: number): T[] {
  const step = Math.max(1, Math.floor(stride));
  const out: T[] = [];
  for (let i = 0; i < items.length; i += step) out.push(items[i]!);
  return out;
}

export interface Inhabitant {
  x: number;
  z: number;
  r: number;
  /** Lifecycle kind; absent (older manager payloads) reads as a character. */
  kind?: 'egg' | 'character';
}

/** Split manager.positions() output into egg and character marks. */
export function partitionInhabitants(items: readonly Inhabitant[]): {
  characters: Inhabitant[];
  eggs: Inhabitant[];
} {
  const characters: Inhabitant[] = [];
  const eggs: Inhabitant[] = [];
  for (const item of items) {
    if (item.kind === 'egg') eggs.push(item);
    else characters.push(item);
  }
  return { characters, eggs };
}

/**
 * The camera's ground look-target from its pose: intersect the view ray with
 * the y=0 plane. Pure — the rig's internal target spring stays private, and
 * this reads the same point the frame actually looks at (drift included).
 */
export function groundLookTarget(
  position: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
): { x: number; z: number } | null {
  if (Math.abs(direction.y) < 1e-6) return null;
  const t = -position.y / direction.y;
  if (t < 0) return null;
  return { x: position.x + direction.x * t, z: position.z + direction.z * t };
}

// ── canvas inset ─────────────────────────────────────────────────────────────

/**
 * Corner inset size (square), scaled to the browser window (user ask): a
 * fraction of the smaller viewport axis, clamped so it stays a glance on a
 * huge display and stays legible on a small one. The draw loop re-reads the
 * element's box every frame and re-derives the mark scale from it, so the
 * map redraws correctly at any size with no resize listener.
 *
 * The floor is deliberately low. At 132px the clamp engaged below a ~776px
 * viewport — i.e. for most resized desktop windows — so shrinking the
 * window stopped shrinking the map (user report). 96px keeps the vmin term
 * live down to a ~565px viewport, and marks (mapMarkScale, floored at 0.5
 * ≈ 120px) stay legible a little past it.
 */
const MAP_SIZE_MIN_PX = 96;
const MAP_SIZE_MAX_PX = 264;
/** Share of the smaller viewport axis (vmin). */
const MAP_SIZE_VMIN = 17;
const MAP_SIZE_CSS = `clamp(${MAP_SIZE_MIN_PX}px, ${MAP_SIZE_VMIN}vmin, ${MAP_SIZE_MAX_PX}px)`;
/** Draw cadence — the map is a glance, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;
/** Prop subsampling stride: every ~5th mark keeps the field quiet. */
const PROP_STRIDE = 5;
/** Stable seed for the border waver and the ambient sway channel. */
const MAP_SEED = 129.4;
/** Half-angle of the frustum wedge, radians — a hint, not a measurement. */
const WEDGE_HALF_ANGLE = 0.42;

const STYLE_ID = 'world-minimap-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.world-minimap {
  position: fixed;
  right: calc(env(safe-area-inset-right, 0px) + 20px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 20px);
  z-index: 5;
  width: ${MAP_SIZE_CSS};
  height: ${MAP_SIZE_CSS};
  display: block;
  cursor: pointer;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
`;
  document.head.appendChild(style);
}

/** Closed loop with quadratic midpoint smoothing — same hand as the phone
 * map (screens/alive.ts): corners round off, the waver reads hand-drawn. */
function traceLoop(ctx: CanvasRenderingContext2D, points: BorderPoint[]): void {
  const n = points.length;
  if (n < 3) return;
  const last = points[n - 1]!;
  const first = points[0]!;
  ctx.beginPath();
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const next = points[(i + 1) % n]!;
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  ctx.closePath();
}

export interface WorldMinimapOptions {
  manager: {
    positions(): Inhabitant[];
  };
  cameraRig: {
    readonly azimuth: number;
    frameAt(point: Vector3): void;
    readonly camera: {
      position: { x: number; y: number; z: number };
      getWorldDirection(target: Vector3): Vector3;
    };
  };
  scatter?: {
    positions(): { x: number; z: number }[];
  };
  mount: HTMLElement;
}

export interface WorldMinimapHandle {
  dispose(): void;
}

export function installWorldMinimap(opts: WorldMinimapOptions): WorldMinimapHandle {
  ensureStyle();

  const canvas = document.createElement('canvas');
  canvas.className = 'world-minimap';
  canvas.setAttribute('aria-label', 'world map');
  opts.mount.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const viewDir = new Vector3();

  // Prop marks change only on scatter rebuilds; sample per draw is cheap
  // enough (subsampled array build), but cache between frames anyway keyed
  // by source length so a static world does no per-frame filtering.
  let propCache: { x: number; z: number }[] = [];
  let propCacheLen = -1;
  const propMarks = (): { x: number; z: number }[] => {
    const source = opts.scatter?.positions() ?? [];
    if (source.length !== propCacheLen) {
      propCache = subsample(source, PROP_STRIDE);
      propCacheLen = source.length;
    }
    return propCache;
  };

  const frameFor = (w: number, h: number, inset: number, scale: number): MapFrame => ({
    w,
    h,
    inset: inset + 5 * scale,
  });

  const draw = (now: number): void => {
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const scale = mapMarkScale(Math.min(w, h));
    const inset = mapBorderInset(scale);

    // The ambient floor: the whole map drifts imperceptibly, forever.
    const drift = sampleDrift(now, MAP_SEED, 140 * scale);
    ctx.translate(drift.x, drift.y);

    const border = wavyBorderPoints(w, h, inset, MAP_SEED);
    const frame = frameFor(w, h, inset, scale);

    // Map field — the phone precedent: ground value inside the border.
    traceLoop(ctx, border);
    ctx.fillStyle = SURFACE.ground;
    ctx.fill();

    ctx.save();
    traceLoop(ctx, border);
    ctx.clip();

    // Prop marks: sparse neutral dots, the terrain at a glance.
    ctx.fillStyle = WORLD.neutral;
    for (const p of propMarks()) {
      const at = worldToMap(p.x, p.z, WORLD_MAP_EXTENT, frame);
      ctx.beginPath();
      ctx.arc(at.px, at.py, 1.1 * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    const { characters, eggs } = partitionInhabitants(opts.manager.positions());

    // Eggs: light shell circles with an ink hairline.
    ctx.fillStyle = WORLD.light;
    ctx.strokeStyle = WORLD.ink;
    ctx.lineWidth = 1;
    for (const egg of eggs) {
      const at = worldToMap(egg.x, egg.z, WORLD_MAP_EXTENT, frame);
      ctx.beginPath();
      ctx.arc(at.px, at.py, 2.6 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Characters: the near-black marks — inhabitants, no "self" here.
    ctx.fillStyle = CHARACTER.body;
    for (const c of characters) {
      const at = worldToMap(c.x, c.z, WORLD_MAP_EXTENT, frame);
      ctx.beginPath();
      ctx.arc(at.px, at.py, 2.2 * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    // Camera indicator: hairline diamond on the look-target + a subtle
    // frustum wedge opening the way the camera looks (rotates with azimuth).
    // Live reads — the rig's own springs already carry the motion.
    const camPos = opts.cameraRig.camera.position;
    opts.cameraRig.camera.getWorldDirection(viewDir);
    const look = groundLookTarget(camPos, viewDir);
    if (look) {
      const at = worldToMap(look.x, look.z, WORLD_MAP_EXTENT, frame);
      const az = opts.cameraRig.azimuth;
      // Ground view direction: from the camera toward the target is
      // (-sin az, -cos az) in world x/z; map is north-up (x→px, z→py).
      const va = Math.atan2(-Math.cos(az), -Math.sin(az));

      ctx.strokeStyle = WORLD.ink;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';

      // Wedge: two hairline rays from just outside the diamond.
      const r0 = 7 * scale;
      const r1 = 16 * scale;
      ctx.beginPath();
      for (const side of [-1, 1]) {
        const a = va + side * WEDGE_HALF_ANGLE;
        ctx.moveTo(at.px + Math.cos(a) * r0, at.py + Math.sin(a) * r0);
        ctx.lineTo(at.px + Math.cos(a) * r1, at.py + Math.sin(a) * r1);
      }
      ctx.stroke();

      // Diamond, drawn as a soft-cornered loop (nothing rectilinear reads
      // hard at this size; the rotated square stays an icon mark).
      const d = 4.4 * scale;
      ctx.beginPath();
      ctx.moveTo(at.px, at.py - d);
      ctx.lineTo(at.px + d, at.py);
      ctx.lineTo(at.px, at.py + d);
      ctx.lineTo(at.px - d, at.py);
      ctx.closePath();
      ctx.stroke();
    }

    ctx.restore();

    // The hairline border itself, over the clipped field.
    traceLoop(ctx, border);
    ctx.strokeStyle = WORLD.ink;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  };

  // ── ~30fps loop: own rAF, skipping frames ─────────────────────────────────
  let raf = 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    draw(now);
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
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  // ── click → pan the camera there ──────────────────────────────────────────
  // The reframe slides on the rig's t.primary springs — cheap and delightful,
  // never a snap. Pointer events stay on the map; nothing bleeds through to
  // the world canvas underneath.
  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const scale = mapMarkScale(Math.min(w, h));
    const inset = mapBorderInset(scale);
    const at = mapToWorld(
      event.clientX - rect.left,
      event.clientY - rect.top,
      WORLD_MAP_EXTENT,
      frameFor(w, h, inset, scale),
    );
    // Clamp to the mapped region so a border click stays on the ground.
    const x = Math.max(-WORLD_MAP_EXTENT, Math.min(WORLD_MAP_EXTENT, at.x));
    const z = Math.max(-WORLD_MAP_EXTENT, Math.min(WORLD_MAP_EXTENT, at.z));
    opts.cameraRig.frameAt(new Vector3(x, 0, z));
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('click', onClick);

  return {
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('click', onClick);
      canvas.remove();
    },
  };
}
