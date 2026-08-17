/**
 * World entry point.
 *
 * P0 world + P1 draw loop + P2 egg lifecycle (PLAN §4): press d (or the
 * hairline pencil control) to slide the draw overlay over the world, draw,
 * hit done — an egg slides into the world and visibly paints itself with the
 * drawing, wobbles harder as its hatch timer runs down, cracks, and hatches
 * into the puffed glossy character (press h to hatch early). The test blob
 * holds the frame only until the first egg exists, then is disposed. One
 * creature per device: a new drawing replaces the previous egg or character.
 *
 * TASTE discipline: the overlay ENTERS AND EXITS BY SLIDING (translateY over
 * t.secondary on the settle curve — never popping, hard cuts are forbidden at
 * confidence 1.00). The egg slides down from slightly above the ground; the
 * hatch shell slides apart and the character rises on ζ≥1 springs. The corner
 * control is icon + hairline border only, no filled button. All colors come
 * from src/taste/tokens.ts; all durations from MOTION tokens.
 */

import { IcosahedronGeometry, Mesh, MeshPhysicalMaterial, Vector3 } from 'three';
import type { BufferGeometry, Group } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCharacter, type Character } from './character/character';
import { EMOTE_NAMES } from './net/protocol';
import { mountDrawScreen } from './draw/ui';
import { createEgg, type Egg } from './egg/egg';
import { startHatch, type HatchHandle } from './egg/hatch';
import { sampleDrift } from './motion/ambient';
import { CHARACTER, MOTION, SURFACE, WORLD } from './taste/tokens';
import { start, type WorldHandles } from './world/scene';
import type { ShadowHandle } from './world/shadows';

/** Hatch timer — dev pacing; a live demo wants ~90s (PLAN §13). */
export const HATCH_TIMER_MS = 20000;

/** Where eggs land: a spot near the world origin (PLAN §4). */
const EGG_SPOT = { x: 2.2, z: -1.4 } as const;

/** Egg shadow sits a touch inside the shell footprint — smaller than the
 * character's, like the stamp under the test blob. */
const EGG_SHADOW_FIT = 0.85;

/** Pre-hatch crack teaser: hairlines appear late in the timer, then the
 * hatch sequence springs the same uniform the rest of the way. */
const CRACK_TEASER = 0.3;

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

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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

  // The test blob holds the frame only until the first egg spawns.
  let testBlob: TestBlob | null = createTestBlob(world);

  // ── creature lifecycle state (PLAN §4) ────────────────────────────────────
  let egg: Egg | null = null;
  let eggShadow: ShadowHandle | null = null;
  let eggBornMs = 0;
  /** Built at draw-done (validates the strokes), spawned at the burst. */
  let pendingCharacter: Character | null = null;
  let hatch: HatchHandle | null = null;
  let character: Character | null = null;
  /** The hatch wrapper that owns the entrance; main owns it after onBurst. */
  let characterRoot: Group | null = null;
  let characterShadow: ShadowHandle | null = null;

  ensureOverlayStyle();

  const eggHint = document.createElement('div');
  eggHint.className = 'egg-hint';
  eggHint.textContent = 'press h to hatch';

  function beginHatch(): void {
    if (!egg || hatch || !pendingCharacter) return;
    const next = pendingCharacter;
    const hatchingEgg = egg;
    eggHint.classList.remove('visible');
    hatch = startHatch(world.scene, hatchingEgg, next, {
      onBurst: (root) => {
        character = next;
        pendingCharacter = null;
        characterRoot = root;
        // The hint line moves on with the lifecycle: hatched → emote keys.
        eggHint.textContent = 'press 1-7 to emote';
        eggHint.classList.add('visible');
        // The character's shadow appears with the character; the egg's
        // smaller stamp retires with the shell.
        characterShadow = world.shadows.addShadow('character', next.radius);
        world.shadows.removeShadow('egg');
        eggShadow = null;
        egg = null; // the hatch owns the egg's disposal from here
        world.cameraRig.frameAt(root.position);
      },
      onDone: () => {
        hatch = null;
      },
    });
  }

  /** Replace-previous behavior: one creature per device, at any stage. */
  function clearCreature(): void {
    if (hatch) {
      hatch.dispose();
      hatch = null;
    }
    if (egg) {
      world.scene.remove(egg.group);
      egg.dispose();
      egg = null;
    }
    world.shadows.removeShadow('egg');
    eggShadow = null;
    if (characterRoot) {
      world.scene.remove(characterRoot);
      characterRoot = null;
    }
    if (character) {
      character.dispose();
      character = null;
    }
    if (pendingCharacter) {
      pendingCharacter.dispose();
      pendingCharacter = null;
    }
    world.shadows.removeShadow('character');
    characterShadow = null;
    eggHint.classList.remove('visible');
  }

  world.onFrame((dt, nowMs) => {
    testBlob?.update(nowMs);

    if (egg) {
      egg.update(dt, nowMs);
      eggShadow?.setPosition(egg.group.position.x, egg.group.position.z);
      if (!hatch) {
        const p = Math.min(1, (nowMs - eggBornMs) / HATCH_TIMER_MS);
        egg.setHatchProgress(p);
        // Hairline cracks tease in late; the hatch sequence springs the
        // same uniform the rest of the way — one continuous scrub.
        egg.crack(CRACK_TEASER * smoothstep(0.62, 1, p));
        if (p >= 1) beginHatch();
      }
    }

    hatch?.update(dt, nowMs);

    if (character) {
      character.update(dt, nowMs);
      if (characterRoot && characterShadow) {
        characterShadow.setPosition(
          characterRoot.position.x + character.group.position.x,
          characterRoot.position.z + character.group.position.z,
        );
      }
    }
  });

  // ── overlay ───────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'draw-overlay';

  const hint = document.createElement('div');
  hint.className = 'draw-hint';
  hint.textContent = 'draw a solid shape — it becomes a creature';

  const openControl = createOpenControl();
  document.body.append(overlay, openControl, eggHint);

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
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'd') {
      if (overlayOpen) closeOverlay();
      else openOverlay();
      return;
    }
    // Manual hatch — runs the identical sequence as the timer (PLAN §4).
    if (event.key === 'h' && !overlayOpen) beginHatch();
    // Dev emote keys: 1–7 map onto the protocol's EMOTE_NAMES (PLAN §6.3).
    if (!overlayOpen && character && event.key >= '1' && event.key <= '7') {
      const name = EMOTE_NAMES[Number(event.key) - 1];
      if (name) character.emote(name);
    }
  });

  const drawScreen = mountDrawScreen(overlay, {
    onDone: (strokes) => {
      // Validate the ink by building the character now; it stays offstage
      // until the shell bursts (deterministic — same strokes, same mesh).
      const next = createCharacter(strokes);
      if (!next) {
        // No usable ink — keep the overlay open with one small lowercase line.
        hint.classList.add('visible');
        return;
      }
      hint.classList.remove('visible');

      // First egg retires the test blob for good.
      if (testBlob) {
        testBlob.dispose();
        testBlob = null;
      }
      // One creature per device: replace egg or character, at any stage.
      clearCreature();

      pendingCharacter = next;
      egg = createEgg(strokes, { x: EGG_SPOT.x, z: EGG_SPOT.z });
      eggBornMs = performance.now();
      world.scene.add(egg.group);
      eggShadow = world.shadows.addShadow('egg', egg.radius * EGG_SHADOW_FIT);
      eggShadow.setPosition(EGG_SPOT.x, EGG_SPOT.z);
      world.cameraRig.frameAt(new Vector3(EGG_SPOT.x, 0, EGG_SPOT.z));
      eggHint.textContent = 'press h to hatch';
      eggHint.classList.add('visible');

      drawScreen.capture.clear();
      closeOverlay();
    },
  });
  // Hint sits above the draw screen root; append after mounting.
  overlay.appendChild(hint);
}

main();
