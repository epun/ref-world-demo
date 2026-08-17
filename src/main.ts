/**
 * World entry point.
 *
 * The world hosts many creatures (GENERATOR.md): every drawing — from the
 * local overlay (press d) or streamed in from phones over the draw-to-3d
 * MQTT feed — becomes an egg that paints itself, wobbles, cracks, and
 * hatches (press h to hatch all early). Phones draw at /draw/?room=xxxx
 * (the vendored kit UI); a mobile visitor to this page is routed there.
 * The test blob holds the frame only until the first egg exists.
 *
 * TASTE discipline: the overlay ENTERS AND EXITS BY SLIDING (translateY over
 * t.secondary on the settle curve — never popping, hard cuts are forbidden at
 * confidence 1.00). The egg slides down from slightly above the ground; the
 * hatch shell slides apart and the character rises on ζ≥1 springs. The corner
 * control is icon + hairline border only, no filled button. All colors come
 * from src/taste/tokens.ts; all durations from MOTION tokens.
 */

import { IcosahedronGeometry, Mesh, MeshPhysicalMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { installHoverNames } from './creatures/hover';
import { createCreatureManager } from './creatures/manager';
import { connectWorldFeed } from './net/drawFeed';
import { EMOTE_NAMES, isRoomCode, roomCode } from './net/protocol';
import { mountDrawScreen } from './draw/ui';
import { sampleDrift } from './motion/ambient';
import { CHARACTER, MOTION, SURFACE, WORLD } from './taste/tokens';
import { start, type WorldHandles } from './world/scene';

/** Hatch timer — dev pacing; a live demo wants ~90s (PLAN §13). */
export const HATCH_TIMER_MS = 20000;

const BLOB_RADIUS = 1.8;
const BLOB_NOISE = 0.09;
const BLOB_SEED = 7.31;

/** Smooth deterministic scalar field — a few low-frequency lobes, so the
 * displaced sphere reads as a hand-formed potato, never a primitive. */
function organicNoise(x: number, y: number, z: number): number {
  return (
    Math.sin(x * 1.7 + y * 1.1 + 0.9) * 0.5 +
    Math.sin(y * 1.9 + z * 1.3 + 2.1) * 0.3 +
    Math.sin(z * 1.5 + x * 2.1 + 4.2) * 0.2
  );
}

function createBlobGeometry(): BufferGeometry {
  // mergeVertices welds the icosahedron's duplicated verts so
  // computeVertexNormals yields smooth shading — no facets, no hard edges.
  const geometry = mergeVertices(new IcosahedronGeometry(BLOB_RADIUS, 4));
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const scale = 1 + BLOB_NOISE * organicNoise(x, y, z);
    position.setXYZ(i, x * scale, y * scale, z * scale);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

interface TestBlob {
  update(nowMs: number): void;
  dispose(): void;
}

/** The P0 placeholder: the one near-black object on screen (TASTE §1) until
 * the first egg replaces it. */
function createTestBlob(world: WorldHandles): TestBlob {
  const geometry = createBlobGeometry();
  const material = new MeshPhysicalMaterial({
    color: CHARACTER.body,
    roughness: 0.35,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.15,
  });
  const blob = new Mesh(geometry, material);
  const restY = -(geometry.boundingBox?.min.y ?? -BLOB_RADIUS);
  blob.position.set(0, restY, 0);
  world.scene.add(blob);
  const shadow = world.shadows.addShadow('test-blob', BLOB_RADIUS * 0.85);

  return {
    update(nowMs: number): void {
      // Ambient drift only — no idle bob, no loops that read as bounce.
      const drift = sampleDrift(nowMs, BLOB_SEED, BLOB_RADIUS * 2);
      blob.position.set(drift.x, restY, drift.y);
      blob.rotation.y = drift.rot;
      shadow.setPosition(blob.position.x, blob.position.z);
    },
    dispose(): void {
      world.scene.remove(blob);
      world.shadows.removeShadow('test-blob');
      geometry.dispose();
      material.dispose();
    },
  };
}

// ── draw overlay chrome ──────────────────────────────────────────────────────
// TASTE §4: icons, hairline rules, thin borders — and nothing else. The
// overlay slides on translateY; the settle curve is the drift-compatible
// CSS stand-in for the ζ≥1 spring (no bounce by construction).

const OVERLAY_STYLE_ID = 'world-overlay-style';

// Stroke-only pencil mark in a 24-unit box — bowed curves and round joins,
// nothing rectilinear (shared law, TASTE §3).
const ICON_DRAW = [
  'M5.6 18.4c.3-1.3.7-2.6 1.3-3.8 2.9-3.3 5.9-6.4 9.1-9.3.9.7 1.8 1.5 2.5 2.4-2.7 3.4-5.6 6.6-8.8 9.5-1.3.5-2.7.9-4.1 1.2',
  'M13.9 7.4c1.1.8 2.1 1.7 3 2.7',
].join(' ');

function ensureOverlayStyle(): void {
  if (document.getElementById(OVERLAY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = OVERLAY_STYLE_ID;
  style.textContent = `
.draw-overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: ${SURFACE.canvas};
  transform: translateY(103%);
  transition: transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.draw-overlay.open {
  transform: translateY(0);
}
.draw-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 5vmin;
  text-align: center;
  color: ${WORLD.ink};
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
  pointer-events: none;
}
.draw-hint.visible {
  opacity: 1;
  transform: translateY(0);
}
.egg-hint {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 4vmin;
  z-index: 4;
  text-align: center;
  color: ${WORLD.ink};
  font: 400 13px/1.4 ui-sans-serif, system-ui, sans-serif;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
  pointer-events: none;
}
.egg-hint.visible {
  opacity: 1;
  transform: translateY(0);
}
.join-line {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 4;
  color: ${WORLD.ink};
  font: 400 13px/1.4 ui-sans-serif, system-ui, sans-serif;
  opacity: 0.85;
  pointer-events: none;
}
.draw-open {
  position: fixed;
  left: 24px;
  bottom: 24px;
  z-index: 5;
  width: 48px;
  height: 48px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: ${WORLD.ink};
  border: 1px solid ${WORLD.ink};
  border-radius: 50%;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.draw-open:active {
  transform: scale(0.96);
}
.draw-open svg {
  width: 22px;
  height: 22px;
  display: block;
}
`;
  document.head.appendChild(style);
}

/** The persistent corner control: hairline-bordered stroke-only icon mark. */
function createOpenControl(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'draw-open';
  button.setAttribute('aria-label', 'draw');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_DRAW);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}

function main(): void {
  const canvas = document.getElementById('world');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('missing #world canvas');
  }

  const world = start(canvas);

  // ── room ──────────────────────────────────────────────────────────────────
  // The room pairs this world with phones drawing at /draw/?room=xxxx via the
  // vendored draw-to-3d feed. ?room= wins; otherwise mint one (randomness at
  // the edge, per protocol.ts).
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get('room') ?? '').toLowerCase();
  const room = isRoomCode(fromUrl) ? fromUrl : roomCode(Math.random);

  // A phone opening the world link goes to the drawing UI for this room —
  // the mobile view IS the kit's draw page (user decision).
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse && Math.min(window.innerWidth, window.innerHeight) < 620) {
    location.replace(`/draw/?room=${room}`);
    return;
  }

  // The test blob holds the frame only until the first egg spawns.
  let testBlob: TestBlob | null = createTestBlob(world);

  const creatures = createCreatureManager(world);
  installHoverNames(canvas, world.cameraRig.camera, creatures);

  ensureOverlayStyle();

  const eggHint = document.createElement('div');
  eggHint.className = 'egg-hint';
  eggHint.textContent = 'press h to hatch';

  // Join line: restrained lowercase type, bottom-right (sparse type is the
  // taste's one allowance; the image still leads).
  const joinLine = document.createElement('div');
  joinLine.className = 'join-line';
  joinLine.textContent = `draw at ${location.host}/draw/?room=${room}`;

  function firstSpawnHousekeeping(): void {
    if (testBlob) {
      testBlob.dispose();
      testBlob = null;
    }
    eggHint.textContent = 'press h to hatch';
    eggHint.classList.add('visible');
  }

  world.onFrame((dt, nowMs) => {
    testBlob?.update(nowMs);
    creatures.update(dt, nowMs);
  });

  // ── ghost panel on shift+d ────────────────────────────────────────────────
  // The panel ships in EVERY build (user decision — the generator brief's
  // presentation controls exist for live demos on the deployed link). It
  // stays a lazy chunk: in dev builds it mounts at boot; in production it
  // loads on the first shift+d, costing nothing until the presenter asks.
  let panelRequested = false;
  const mountPanel = (showOnMount: boolean): void => {
    if (panelRequested) return;
    panelRequested = true;
    let fallbackIndex = 0;
    void import('./dev').then((m) =>
      m.initDevPanel({
        scene: world.scene,
        camera: world.cameraRig.camera,
        renderer: world.renderer,
        onFrame: world.onFrame,
        creatures,
        ink: world.ink,
        scatter: world.scatter,
        // Weather handle from a parallel workstream — forwarded as-is and
        // feature-detected inside the panel, so this compiles either way.
        environment: (world as { environment?: unknown }).environment,
        spawnFallback: (n) => {
          for (let i = 0; i < n; i++) {
            const strokes = m.FALLBACK_DRAWINGS[fallbackIndex % m.FALLBACK_DRAWINGS.length];
            if (!strokes) continue;
            const ok = creatures.spawn(`dev-fallback-${fallbackIndex++}`, strokes, {
              hatchMs: m.FALLBACK_HATCH_MS,
            });
            if (ok) firstSpawnHousekeeping();
          }
        },
      }, { showOnMount }),
    );
  };
  if (__IS_DEV__) mountPanel(false);
  window.addEventListener('keydown', (event) => {
    if (event.shiftKey && (event.key === 'D' || event.key === 'd')) mountPanel(true);
  });

  // ── phones: the draw-to-3d feed ───────────────────────────────────────────
  void connectWorldFeed({
    room,
    onDrawing: (d) => {
      const ok = creatures.spawn(d.id, d.strokes, {
        name: d.name,
        personality: d.personality,
        hatchMs: HATCH_TIMER_MS,
      });
      if (ok) firstSpawnHousekeeping();
    },
    onStatus: (_state, text) => {
      // Reflect feed state quietly in the join line; never a toast.
      joinLine.textContent = `draw at ${location.host}/draw/?room=${room}` + (text === 'live' ? '' : ` — ${text}`);
    },
  });

  // ── overlay (local, same-device drawing) ──────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'draw-overlay';

  const hint = document.createElement('div');
  hint.className = 'draw-hint';
  hint.textContent = 'draw a solid shape — it becomes a creature';

  const openControl = createOpenControl();
  document.body.append(overlay, openControl, eggHint, joinLine);

  let overlayOpen = false;
  const openOverlay = (): void => {
    overlayOpen = true;
    overlay.classList.add('open');
  };
  const closeOverlay = (): void => {
    overlayOpen = false;
    overlay.classList.remove('open');
    hint.classList.remove('visible');
  };

  let localCount = 0;

  openControl.addEventListener('click', openOverlay);
  window.addEventListener('keydown', (event) => {
    // Shifted presses belong to the dev surface (ghost panel toggles on
    // shift+d); plain d keeps the draw overlay.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key === 'd') {
      if (overlayOpen) closeOverlay();
      else openOverlay();
      return;
    }
    // Manual hatch — every ready egg, identical sequence to the timer.
    if (event.key === 'h' && !overlayOpen) {
      creatures.hatchAll();
      eggHint.textContent = 'press 1-7 to emote';
    }
    // Dev emote keys on the most recent character (PLAN §6.3).
    if (!overlayOpen && event.key >= '1' && event.key <= '7') {
      const name = EMOTE_NAMES[Number(event.key) - 1];
      const character = creatures.latestCharacter();
      if (name && character) character.emote(name);
    }
  });

  const drawScreen = mountDrawScreen(overlay, {
    onDone: (strokes) => {
      const ok = creatures.spawn(`local-${localCount++}`, strokes, {
        hatchMs: HATCH_TIMER_MS,
      });
      if (!ok) {
        // No usable ink — keep the overlay open with one small lowercase line.
        hint.classList.add('visible');
        return;
      }
      hint.classList.remove('visible');
      firstSpawnHousekeeping();
      drawScreen.capture.clear();
      closeOverlay();
    },
  });
  // Hint sits above the draw screen root; append after mounting.
  overlay.appendChild(hint);
}

main();
