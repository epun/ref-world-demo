/**
 * World entry point.
 *
 * Starts the P0 world with the test blob, and adds the P1 same-device draw
 * loop: press d (or the hairline pencil control in the corner) to slide a
 * draw overlay over the world, draw, hit done — the drawing runs the pure
 * pipeline (analyze → inflate) and stands in the world as a puffed, glossy
 * character. The test blob holds the frame only until the first character
 * exists, then is disposed. One character per device for now; a new drawing
 * replaces the old one (until the egg lands, PLAN §4).
 *
 * TASTE discipline: the overlay ENTERS AND EXITS BY SLIDING (translateY over
 * t.secondary on the settle curve — never popping, hard cuts are forbidden at
 * confidence 1.00). The corner control is icon + hairline border only, no
 * filled button. All colors come from src/taste/tokens.ts.
 */

import { IcosahedronGeometry, Mesh, MeshPhysicalMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCharacter, type Character } from './character/character';
import { mountDrawScreen } from './draw/ui';
import { sampleDrift } from './motion/ambient';
import { CHARACTER, MOTION, SURFACE, WORLD } from './taste/tokens';
import { start, type WorldHandles } from './world/scene';
import type { ShadowHandle } from './world/shadows';

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
 * the first drawn character replaces it. */
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

  // The test blob holds the frame only until the first character is drawn.
  let testBlob: TestBlob | null = createTestBlob(world);
  let character: Character | null = null;
  let characterShadow: ShadowHandle | null = null;

  world.onFrame((dt, nowMs) => {
    testBlob?.update(nowMs);
    if (character) {
      character.update(dt, nowMs);
      characterShadow?.setPosition(character.group.position.x, character.group.position.z);
    }
  });

  // ── overlay ───────────────────────────────────────────────────────────────
  ensureOverlayStyle();

  const overlay = document.createElement('div');
  overlay.className = 'draw-overlay';

  const hint = document.createElement('div');
  hint.className = 'draw-hint';
  hint.textContent = 'draw a solid shape — it becomes a creature';

  const openControl = createOpenControl();
  document.body.append(overlay, openControl);

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

  openControl.addEventListener('click', openOverlay);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'd' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (overlayOpen) closeOverlay();
    else openOverlay();
  });

  const drawScreen = mountDrawScreen(overlay, {
    onDone: (strokes) => {
      const next = createCharacter(strokes);
      if (!next) {
        // No usable ink — keep the overlay open with one small lowercase line.
        hint.classList.add('visible');
        return;
      }
      hint.classList.remove('visible');

      // First character retires the test blob for good.
      if (testBlob) {
        testBlob.dispose();
        testBlob = null;
      }
      // One character per device until the egg lands: replace the previous.
      if (character) {
        world.scene.remove(character.group);
        character.dispose();
      }

      character = next;
      world.scene.add(next.group);
      // addShadow replaces the stamp under the same id, so redraws swap clean.
      characterShadow = world.shadows.addShadow('character', next.radius);
      world.cameraRig.frameAt(next.group.position);

      drawScreen.capture.clear();
      closeOverlay();
    },
  });
  // Hint sits above the draw screen root; append after mounting.
  overlay.appendChild(hint);
}

main();
