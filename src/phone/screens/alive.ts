/**
 * State ③ alive (PLAN §6.3): your character on your phone.
 *
 * - PORTRAIT: the identical pure pipeline (createCharacter) run locally on
 *   the stroke list — no geometry crosses the wire. Head-on orthographic
 *   camera, so the silhouette matches the drawing; world lighting recipe;
 *   ambient drift keeps it alive; generous negative space around it.
 * - EMOTE WHEEL: seven wordless stroke-only icon marks in a ring around the
 *   portrait, hairline circular borders, ≥44px hit areas. A tap thickens the
 *   tapped ring briefly on the tertiary token — acknowledgement without a
 *   bounce.
 * - MINIMAP: top-down canvas — ground field inside a deterministic
 *   hand-wavering border, peers as neutral dots (clusters read bigger), you
 *   as the near-black dot with the accent ring: the single accent element on
 *   this screen (TASTE §6). Pose updates settle through ζ≥1 springs so the
 *   marker never jitters or snaps.
 *
 * One hairline rule divides the portrait region from the minimap region —
 * TASTE §4's "reserve a single hairline rule to divide the frame".
 */

import { OrthographicCamera, Scene, WebGLRenderer } from 'three';
import { CHARACTER_HEIGHT, createCharacter, type Character } from '../../character/character';
import { sampleDrift } from '../../motion/ambient';
import { Spring } from '../../motion/spring';
import {
  EMOTE_NAMES,
  type EmoteName,
  type PoseMsg,
  type RosterMsg,
} from '../../net/protocol';
import type { StrokeList } from '../../shape/types';
import { CHARACTER, MOTION, SURFACE, WORLD } from '../../taste/tokens';
import { createLighting } from '../../world/lighting';
import {
  MAP_INSET,
  nearestAngleTarget,
  peerDotRadius,
  wavyBorderPoints,
  worldToMap,
  type BorderPoint,
  type MapFrame,
} from '../minimap';
import { strokeSeed } from '../seed';
import { LOCAL_EXTENT } from '../session';
import type { Screen } from '../states';

// ── Emote icon marks ────────────────────────────────────────────────────────
// Stroke-only paths in a 24-unit box, all soft curves and round joins —
// faces and gestures reduced to marks, wordless (TASTE §4, §5).

const EMOTE_ICONS: Record<EmoteName, string> = {
  // upturned crescent pair — closed, content eyes
  happy: 'M5.6 12.2c1.1 2 3.4 2 4.5 0 M13.9 12.2c1.1 2 3.4 2 4.5 0',
  // downturned pair plus one small tear curve
  sad: 'M5.6 13.8c1.1-2 3.4-2 4.5 0 M13.9 13.8c1.1-2 3.4-2 4.5 0 M18.6 16.2c.5 1.3.3 2.3-.6 2.9',
  // drooping lids low in the box, a soft z-curl floating above
  sleepy:
    'M4.8 14.6c1.4.9 3 .9 4.4 0 M11.2 14.6c1.4.9 3 .9 4.4 0 M15.2 5.1c1.4-.4 2.8-.4 4.2-.1-1.5 1.3-2.8 2.8-3.9 4.4 1.4.3 2.8.3 4.1-.1',
  // inward-slanting brow strokes over two short pressed marks
  angry:
    'M6 9.4c1.6.6 3 1.4 4.2 2.5 M18 9.4c-1.6.6-3 1.4-4.2 2.5 M7.9 15.3c.7.4 1.5.6 2.3.7 M16.1 15.3c-.7.4-1.5.6-2.3.7',
  // two wide round eyes and a small open mouth
  surprised: 'M8 8.15a2.05 2.05 0 1 0 .01 0 M16 8.15a2.05 2.05 0 1 0 .01 0 M12 14.7a1.5 1.9 0 1 0 .01 0',
  // tilted figure squiggle over a ground swing
  dance:
    'M10.4 4.9c2.9-1.1 4.9.3 4.4 2.4-.5 2-3.1 2.5-4.4 4.3-1.3 1.8-.1 3.6 2 3.5 1.9-.1 3.2-1.4 3.9-3 M6.9 18.8c3.2 1.1 6.6 1 9.8-.2',
  // a bowed arm with a curled hand, two radiating arcs beside it
  wave: 'M8.9 19.1c-.5-3.6-.2-7.2.9-10.7.4-1.2 1.5-1.8 2.5-1.3 M14.3 8.6c1.1 1.1 1.9 2.4 2.3 3.9 M17.2 6.6c1.4 1.4 2.4 3.1 2.9 5.1',
};

/** Emote buttons sit on this radius, as % of the wheel container. */
const WHEEL_RADIUS_PCT = 42;
const BUTTON_SIZE_PX = 52; // ≥44px hit area

// ── Screen ──────────────────────────────────────────────────────────────────

export interface AliveScreenOptions {
  strokes: StrokeList;
  onEmote(emote: EmoteName): void;
}

export interface AliveScreenHandle extends Screen {
  setPose(msg: PoseMsg): void;
  setRoster(msg: RosterMsg): void;
  setName(name: string): void;
}

const STYLE_ID = 'alive-screen-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.alive-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4vmin;
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  padding: 5vmin 0;
  background: ${SURFACE.canvas};
}
.alive-wheel {
  position: relative;
  width: min(78vmin, 460px);
  aspect-ratio: 1;
}
.alive-portrait {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 52%;
  aspect-ratio: 1;
  display: block;
}
.alive-emote {
  position: absolute;
  width: ${BUTTON_SIZE_PX}px;
  height: ${BUTTON_SIZE_PX}px;
  padding: 0;
  background: transparent;
  border: none;
  color: ${WORLD.ink};
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.alive-emote svg {
  width: 100%;
  height: 100%;
  display: block;
}
.alive-emote-ring {
  transition: stroke-width ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.alive-emote-acked .alive-emote-ring {
  stroke-width: 2.4;
}
.alive-name {
  color: ${WORLD.ink};
  font-family: "helvetica neue", helvetica, arial, sans-serif;
  font-weight: 400;
  font-size: 14px;
  letter-spacing: 0.02em;
  min-height: 1.2em;
}
.alive-rule {
  width: min(64vmin, 400px);
  height: 0;
  border-top: 1px solid ${WORLD.ink};
}
.alive-map {
  width: min(64vmin, 400px);
  aspect-ratio: 1.4;
  display: block;
}
`;
  document.head.appendChild(style);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function emoteButton(
  name: EmoteName,
  index: number,
  count: number,
  onEmote: (emote: EmoteName) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'alive-emote';
  button.setAttribute('aria-label', name);

  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
  const dx = Math.cos(angle) * WHEEL_RADIUS_PCT;
  const dy = Math.sin(angle) * WHEEL_RADIUS_PCT;
  const half = BUTTON_SIZE_PX / 2;
  button.style.left = `calc(50% + ${dx.toFixed(2)}% - ${half}px)`;
  button.style.top = `calc(50% + ${dy.toFixed(2)}% - ${half}px)`;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.setAttribute('aria-hidden', 'true');

  // Hairline circular border, part of the icon so the acknowledgement can
  // thicken the stroke without shifting layout.
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('class', 'alive-emote-ring');
  ring.setAttribute('cx', '26');
  ring.setAttribute('cy', '26');
  ring.setAttribute('r', '25');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '1');

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('transform', 'translate(14 14)');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', EMOTE_ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  group.appendChild(path);

  svg.append(ring, group);
  button.appendChild(svg);

  button.addEventListener('click', () => {
    onEmote(name);
    button.classList.add('alive-emote-acked');
    window.setTimeout(
      () => button.classList.remove('alive-emote-acked'),
      MOTION.tertiaryMs,
    );
  });

  return button;
}

/** Closed loop through the points with quadratic midpoint smoothing —
 * corners round off, the waver reads hand-drawn. */
function traceLoop(ctx: CanvasRenderingContext2D, points: BorderPoint[]): void {
  const n = points.length;
  if (n < 3) return;
  const last = points[n - 1];
  const first = points[0];
  if (!last || !first) return;
  ctx.beginPath();
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const next = points[(i + 1) % n];
    if (!p || !next) break;
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  ctx.closePath();
}

export function mountAliveScreen(
  container: HTMLElement,
  options: AliveScreenOptions,
): AliveScreenHandle {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'alive-screen';

  // ── DOM: wheel (portrait inside), name, rule, map ─────────────────────────
  const wheel = document.createElement('div');
  wheel.className = 'alive-wheel';

  const portraitCanvas = document.createElement('canvas');
  portraitCanvas.className = 'alive-portrait';
  portraitCanvas.setAttribute('aria-label', 'your character');
  wheel.appendChild(portraitCanvas);

  EMOTE_NAMES.forEach((name, index) => {
    wheel.appendChild(emoteButton(name, index, EMOTE_NAMES.length, options.onEmote));
  });

  const nameLine = document.createElement('div');
  nameLine.className = 'alive-name';

  const rule = document.createElement('div');
  rule.className = 'alive-rule';

  const mapCanvas = document.createElement('canvas');
  mapCanvas.className = 'alive-map';
  mapCanvas.setAttribute('aria-label', 'minimap');

  root.append(wheel, nameLine, rule, mapCanvas);
  container.appendChild(root);

  // ── Portrait: the local deterministic pipeline (PLAN §6.3) ────────────────
  let character: Character | null = null;
  let renderer: WebGLRenderer | null = null;
  let scene: Scene | null = null;
  let camera: OrthographicCamera | null = null;

  character = createCharacter(options.strokes);
  if (character) {
    renderer = new WebGLRenderer({ canvas: portraitCanvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    scene = new Scene();
    scene.add(createLighting(), character.group);

    // Head-on, NOT isometric: straight down the z axis so the silhouette is
    // the drawing (PLAN §1 invariant). Generous negative space in frame.
    const half = CHARACTER_HEIGHT * 0.72;
    camera = new OrthographicCamera(-half, half, half, -half, 0.1, 100);
    camera.position.set(0, CHARACTER_HEIGHT / 2, 12);
    camera.lookAt(0, CHARACTER_HEIGHT / 2, 0);
  } else {
    // Degenerate drawing survived to here: hold the space, skip the render.
    portraitCanvas.style.display = 'none';
  }

  const sizePortrait = (): void => {
    if (!renderer) return;
    const rect = portraitCanvas.getBoundingClientRect();
    const size = Math.max(1, Math.round(rect.width));
    renderer.setSize(size, size, false);
  };
  sizePortrait();
  window.addEventListener('resize', sizePortrait);

  // ── Minimap state ─────────────────────────────────────────────────────────
  const mapCtx = mapCanvas.getContext('2d');
  const mapSeed = strokeSeed(options.strokes) + 3.7;

  // Drift-settle interpolation between ~10Hz pose updates: the marker never
  // jitters or snaps (PLAN §6.3), and ζ≥1 means it never overshoots.
  const springX = new Spring(0, { settleMs: MOTION.secondaryMs });
  const springZ = new Spring(0, { settleMs: MOTION.secondaryMs });
  const springH = new Spring(0, { settleMs: MOTION.secondaryMs });
  let hasPose = false;
  let roster: RosterMsg | null = null;

  const drawMap = (dt: number, now: number): void => {
    if (!mapCtx) return;
    const rect = mapCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (mapCanvas.width !== bw || mapCanvas.height !== bh) {
      mapCanvas.width = bw;
      mapCanvas.height = bh;
    }

    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mapCtx.clearRect(0, 0, w, h);

    // The ambient floor: the whole map drifts imperceptibly, forever.
    const drift = sampleDrift(now, mapSeed, 140);
    mapCtx.translate(drift.x, drift.y);

    const border = wavyBorderPoints(w, h, MAP_INSET, mapSeed);
    const extent = roster ? roster.extent : LOCAL_EXTENT;
    const frame: MapFrame = { w, h, inset: MAP_INSET + 5 };

    // Ground field inside the border — the mid-toned world value.
    traceLoop(mapCtx, border);
    mapCtx.fillStyle = SURFACE.ground;
    mapCtx.fill();

    mapCtx.save();
    traceLoop(mapCtx, border);
    mapCtx.clip();

    // Peers: neutral-dark marks, clusters read bigger. Scatter marks are
    // omitted for now — the world sends none yet.
    if (roster) {
      mapCtx.fillStyle = WORLD.neutralDark;
      for (const entry of roster.peers) {
        const at = worldToMap(entry.x, entry.z, extent, frame);
        mapCtx.beginPath();
        mapCtx.arc(at.px, at.py, peerDotRadius(entry.n), 0, Math.PI * 2);
        mapCtx.fill();
      }
    }

    // You: near-black dot + the accent ring — the single accent element on
    // this screen (TASTE §6; nothing else here may use it).
    if (hasPose) {
      const x = springX.update(dt);
      const z = springZ.update(dt);
      const heading = springH.update(dt);
      const at = worldToMap(x, z, extent, frame);

      mapCtx.fillStyle = CHARACTER.body;
      mapCtx.beginPath();
      mapCtx.arc(at.px, at.py, 3.2, 0, Math.PI * 2);
      mapCtx.fill();

      // Heading tick, just outside the ring.
      mapCtx.strokeStyle = CHARACTER.body;
      mapCtx.lineWidth = 1.4;
      mapCtx.lineCap = 'round';
      mapCtx.beginPath();
      mapCtx.moveTo(at.px + Math.cos(heading) * 7.5, at.py + Math.sin(heading) * 7.5);
      mapCtx.lineTo(at.px + Math.cos(heading) * 11, at.py + Math.sin(heading) * 11);
      mapCtx.stroke();

      mapCtx.strokeStyle = CHARACTER.accent;
      mapCtx.lineWidth = 1.4;
      mapCtx.beginPath();
      mapCtx.arc(at.px, at.py, 6, 0, Math.PI * 2);
      mapCtx.stroke();
    }

    mapCtx.restore();

    // The hairline border itself, over the clipped field.
    traceLoop(mapCtx, border);
    mapCtx.strokeStyle = WORLD.ink;
    mapCtx.lineWidth = 1.25;
    mapCtx.stroke();
  };

  // ── One loop drives portrait drift and the minimap ────────────────────────
  let raf = 0;
  let last = performance.now();
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - last, 100);
    last = now;

    if (character && renderer && scene && camera) {
      character.update(dt, now);
      renderer.render(scene, camera);
    }
    drawMap(dt, now);
  };
  raf = requestAnimationFrame(frame);

  return {
    setPose(msg: PoseMsg): void {
      if (!hasPose) {
        hasPose = true;
        springX.reset(msg.x);
        springZ.reset(msg.z);
        springH.reset(msg.heading);
        return;
      }
      springX.retarget(msg.x);
      springZ.retarget(msg.z);
      springH.retarget(nearestAngleTarget(springH.value, msg.heading));
    },
    setRoster(msg: RosterMsg): void {
      roster = msg;
    },
    setName(name: string): void {
      nameLine.textContent = name.toLowerCase();
    },
    destroy(): void {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', sizePortrait);
      springX.dispose();
      springZ.dispose();
      springH.dispose();
      character?.dispose();
      renderer?.dispose();
      root.remove();
    },
  };
}
