/**
 * State ③ alive (PLAN §6.3): your character on your phone.
 *
 * - PORTRAIT: the identical pure pipeline (createCharacter) run locally on
 *   the stroke list — no geometry crosses the wire. Head-on orthographic
 *   camera, so the silhouette matches the drawing; world lighting recipe;
 *   ambient drift keeps it alive; generous negative space around it. The
 *   creature is ALONE in the screen now (user ruling, 2026-08-18) — the
 *   ring of emote buttons that used to orbit it is gone, so the portrait
 *   takes the screen instead of sitting at the wheel's old 52% inset.
 * - EMOTES: six keys on the CASE, not a wheel in the screen (DEVICE §2)
 *   — *"instead of having the emotes around the actual character on the
 *   screen, we should have one row of buttons at the top … another row of
 *   three buttons at the bottom. it looks like we have seven emotes, so we
 *   would need three, and I think it's okay to get rid of the angry
 *   emote."* Six, not seven: `angry` leaves the phone's set and stays in
 *   EMOTE_NAMES, because the world still uses it for autonomous behaviour —
 *   this is the phone's button set, not the protocol.
 *
 *   They carry the same BUBBLE_EMOJI glyphs the wheel carried, in native
 *   colour, with the wheel's pressed/default treatment preserved on the
 *   key (device.ts). A tap publishes to the world AND plays
 *   `character.emote()` on the local portrait (user ask, 2026-08-20: the
 *   creature shows the same emote on mobile as it does in the world). It
 *   plays locally on the tap rather than waiting for the world to echo:
 *   the portrait is the identical pure pipeline, so it needs nothing from
 *   the wire, and a round trip through the broker would put visible lag on
 *   the person's own tap. An emote the WORLD reports for this creature is
 *   mirrored too — but the echo of the tap that just played is not
 *   double-played (see nextPoseEmote below).
 * - NO MINIMAP (user ruling, 2026-08-18: *"let's also get rid of the mini
 *   map on mobile for now"*). The `corner` slot stays in the DOM and stays
 *   empty — empty is a state of a slot, never a removal — and
 *   src/phone/minimap.ts stays where it is: the world view still draws
 *   from it (src/ui/minimap.ts, src/ui/joinqr.ts). This is a presentation
 *   decision on one surface, not a deletion.
 *
 * No dividing rule in this layout: one object in a field has no two
 * regions to divide. TASTE §4 *reserves* a single hairline rule — it does
 * not demand one be shown.
 *
 * It mounts into the STAGE's slots (docs/PHONE-STAGE.md §2): the portrait
 * is the core — the third face of the one object the pad and the egg were —
 * the creature's name is the brow, the corner is empty, and the six keys
 * are the tools slot, which sits on the case.
 */

import { Box3, OrthographicCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { BUBBLE_EMOJI } from '../../character/bubble';
import { CHARACTER_HEIGHT, createCharacter, type Character } from '../../character/character';
import type { EmoteName, PoseMsg, RosterMsg } from '../../net/protocol';
import type { StrokeList } from '../../shape/types';
import { WORLD } from '../../taste/tokens';
import { createLighting } from '../../world/lighting';
import { createKeyRow, type KeyRowSpec } from '../device';
import { createSpin, type SpinHandle, type SpinState } from '../spin';
import { wellElement, type Screen, type StageSlots } from '../states';

// ── The phone's emote set (DEVICE §2) ───────────────────────────────────────

/**
 * Six emotes on six keys, in the order the case reads them: the top row
 * left to right, then the bottom row. Six and not seven — `angry` is
 * dropped from the PHONE's set by ruling and stays in `EMOTE_NAMES`,
 * because the world still uses it for autonomous behaviour. Typed as
 * EmoteName, so dropping one from the protocol breaks the build here
 * rather than silently sending an emote nothing understands.
 */
export const PHONE_EMOTE_KEYS: Record<'top' | 'bottom', readonly EmoteName[]> = {
  top: ['wave', 'happy', 'surprised'],
  bottom: ['dance', 'sleepy', 'sad'],
};

/** Every emote the phone can send, in key order. */
export const PHONE_EMOTES: readonly EmoteName[] = [
  ...PHONE_EMOTE_KEYS.top,
  ...PHONE_EMOTE_KEYS.bottom,
];

/**
 * De-dupe for emotes arriving on the pose stream (unit-tested in
 * test/phone).
 *
 * An emote rides on `PoseMsg.emote` as a transient MARKER, not as an event:
 * it repeats on every pose frame while it is fresh (SameDeviceSession holds
 * it for EMOTE_ECHO_MS at ~10Hz, and the world reports the same way). So a
 * pose emote is a NEW event only when it differs from the marker last seen.
 *
 * That is also what stops the person's own tap playing twice. The tap plays
 * locally at once — waiting for the wire would put a broker round trip of
 * lag on their own press — and records itself as the marker, so its echo
 * arrives already seen. When the marker clears, the same emote can fire
 * again later.
 */
export function nextPoseEmote(
  incoming: EmoteName | undefined,
  marker: EmoteName | null,
): { play: EmoteName | null; marker: EmoteName | null } {
  if (incoming === undefined) return { play: null, marker: null };
  if (incoming === marker) return { play: null, marker };
  return { play: incoming, marker: incoming };
}

// ── Screen ──────────────────────────────────────────────────────────────────

export interface AliveScreenOptions {
  strokes: StrokeList;
  /**
   * The drawing's publish id — the same identity the world spawns the
   * creature under. Passing it keeps the portrait pixel-identical to the
   * world creature (the identity salts the synthesis jitter). Absent (the
   * local same-device flow) the portrait seeds from the strokes alone.
   */
  identity?: string;
  /**
   * Yaw + throw handed over by the screen before this one (user ruling,
   * 2026-08-20 — the object turns by hand). Carried across the swap rather
   * than reset: the creature standing at the end of the hatch and the
   * creature this portrait mounts are the same mesh, so if one of them were
   * facing a different way the dissolve between them would be a jump — and
   * an object that stopped turning at the seam would be the abrupt stop the
   * motion law forbids outright.
   */
  initialSpin?: SpinState;
  onEmote(emote: EmoteName): void;
}

export interface AliveScreenHandle extends Screen {
  setPose(msg: PoseMsg): void;
  setRoster(msg: RosterMsg): void;
  setName(name: string): void;
  /** Where the person left the creature turned, and how fast it is still
   * turning. */
  spin(): SpinState;
}

const STYLE_ID = 'alive-screen-style';

/**
 * [D] The portrait's share of the core.
 *
 * With the wheel gone the core is the creature's alone, so the portrait
 * takes the screen instead of sitting at the wheel's old 52% inset. It is
 * not 100%: the alive core is exactly as wide as the well (CORE_SIDE.alive
 * = 100cqw), so a full-width portrait would touch the bezel on both sides
 * and the creature would read as jammed into the frame rather than living
 * in it. 88% leaves a real margin on all four sides at every handset size
 * — measured in the browser, not asserted — and the character's own camera
 * padding (PORTRAIT_FIT) keeps air around the silhouette inside that.
 *
 * Exported because the WAIT screen has to reach it: the creature standing
 * at the end of the hatch and the creature this portrait mounts are the
 * same mesh, and the swap between them is only a dissolve if they are also
 * the same PICTURE. That means the wait screen sizing its own camera
 * against this box, from this number, rather than against a copy of it.
 */
export const PORTRAIT_SHARE = 0.88;

/**
 * [D] Breathing room around the silhouette: the ortho half-extent is the
 * creature's larger measured extent times this. Shared with the wait
 * screen's reframe for the same reason PORTRAIT_SHARE is.
 */
export const PORTRAIT_FIT = 0.72;

/**
 * The portrait's half-extent — fit the LARGER extent plus breathing room,
 * never an assumed height: the mesh is normalized to CHARACTER_HEIGHT but a
 * wide drawing can be much wider than tall, and a fixed frustum crops it
 * (user-reported). The canvas is square, so one half-extent serves both
 * axes.
 */
export function portraitHalfExtent(sizeX: number, sizeY: number): number {
  return Math.max(sizeX, sizeY, CHARACTER_HEIGHT) * PORTRAIT_FIT;
}

/** World units per css pixel this portrait renders at, in a canvas that
 * many pixels across. The measure the wait screen's camera solves for. */
export function portraitUnitsPerPixel(halfExtent: number, portraitPx: number): number {
  return (2 * halfExtent) / Math.max(1, portraitPx);
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* The portrait fills the core slot alone — the stage owns the measure
   (--core-side), so nothing here declares a size that could disagree. */
.alive-stage {
  position: relative;
  width: 100%;
  height: 100%;
}
.alive-portrait {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: ${PORTRAIT_SHARE * 100}%;
  aspect-ratio: 1;
  display: block;
  touch-action: none;
}
/*
 * Centred in the brow band, as it always was. The well is PORTRAIT
 * (DEVICE §3) — 70 wide by 86 tall — so even the alive core, which is as
 * wide as the well, leaves a band above it that the portrait never reaches.
 * That band is what the taller device was cut for. Ellipsis and the size
 * clamp are the only additions: the screen is narrower than the viewport
 * used to be, and a long creature name must trim rather than run into the
 * bezel.
 */
.alive-name {
  max-width: 92cqw;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: ${WORLD.ink};
  font-family: "helvetica neue", helvetica, arial, sans-serif;
  font-weight: 400;
  font-size: clamp(11px, 5cqw, 14px);
  letter-spacing: 0.02em;
  min-height: 1.2em;
}
`;
  document.head.appendChild(style);
}

/** One row of three emote keys, carrying the wheel's own glyphs. */
function emoteRow(
  names: readonly EmoteName[],
  onEmote: (emote: EmoteName) => void,
): KeyRowSpec {
  const key = (index: number): { label: string; emoji: string; onPress: () => void } | null => {
    const name = names[index];
    if (name === undefined) return null;
    return {
      label: name,
      // The same glyph set the world paints into the speech bubble, so the
      // key and the bubble it triggers always agree (TASTE §6 carve-out).
      emoji: BUBBLE_EMOJI[name],
      onPress: (): void => onEmote(name),
    };
  };
  return [key(0), key(1), key(2)];
}

export function mountAliveScreen(
  slots: StageSlots,
  options: AliveScreenOptions,
): AliveScreenHandle {
  ensureStyle();

  /**
   * The portrait's emote state. `character.emote()` is the same call the
   * world's creature takes, so the two play the identical deformation and
   * eye expression from the identical mesh — parity is a wiring job, not a
   * re-implementation. `marker` is the de-dupe state (see nextPoseEmote).
   */
  let character: Character | null = null;
  let marker: EmoteName | null = null;
  const playEmote = (emote: EmoteName): void => {
    marker = emote;
    character?.emote(emote);
  };

  // ── DOM: portrait → core, name → brow, six emote keys → tools ─────────────
  const field = document.createElement('div');
  field.className = 'alive-stage';

  const portraitCanvas = document.createElement('canvas');
  portraitCanvas.className = 'alive-portrait';
  portraitCanvas.setAttribute('aria-label', 'your character');
  field.appendChild(portraitCanvas);

  const nameLine = document.createElement('div');
  nameLine.className = 'alive-name';

  const tap = (emote: EmoteName): void => {
    // Both, in this order: the person's own creature reacts in their hand
    // on the same frame as the tap, and the world hears about it.
    playEmote(emote);
    options.onEmote(emote);
  };
  const keys = createKeyRow({
    top: emoteRow(PHONE_EMOTE_KEYS.top, tap),
    bottom: emoteRow(PHONE_EMOTE_KEYS.bottom, tap),
  });

  slots.core.appendChild(field);
  slots.brow.appendChild(nameLine);
  slots.tools.appendChild(keys.el);

  // ── Turning the creature by hand (user ruling, 2026-08-20) ────────────────
  // *"on the mobile view a user should be able to rotate the egg and their
  // character."* — and it matters more than it sounds: the drawing lives on
  // the creature's BACK now (a knockout on the local −z face), and this
  // camera is head-on, so turning it round is the only way the person can
  // ever find their own drawing on it.
  //
  // Read on the WELL, not on the portrait canvas: the whole display turns
  // the creature. The emote keys live on the CASE now (DEVICE §3 — their
  // rows sit at y 24.6 and 145, outside the well's y 38..124), so the well
  // is free and a drag can never be a key press.
  const spin: SpinHandle = createSpin({
    surface: wellElement(field) ?? field,
    width: () => {
      const well = wellElement(field);
      return well ? well.getBoundingClientRect().width : field.getBoundingClientRect().width;
    },
    ...(options.initialSpin ? { initial: options.initialSpin } : {}),
  });
  // The corner stays EMPTY (user ruling — no minimap on mobile for now).
  // Empty is a state of a slot, never a removal.

  // ── Portrait: the local deterministic pipeline (PLAN §6.3) ────────────────
  let renderer: WebGLRenderer | null = null;
  let scene: Scene | null = null;
  let camera: OrthographicCamera | null = null;

  // Same identity as the world's slot → the identical creature (parity).
  character = createCharacter(
    options.strokes,
    1,
    options.identity === undefined ? {} : { identity: options.identity },
  );
  if (character) {
    renderer = new WebGLRenderer({ canvas: portraitCanvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    scene = new Scene();
    scene.add(createLighting().group, character.group);

    // Head-on, NOT isometric: straight down the z axis so the silhouette is
    // the drawing (PLAN §1 invariant). Frame from the character's measured
    // bounds, not an assumed height — the mesh is normalized to a height of
    // CHARACTER_HEIGHT but a wide drawing can be much wider than tall, and a
    // fixed frustum crops it (user-reported). Fit the larger extent plus
    // breathing room; the canvas is square so one half-extent serves both.
    const bounds = new Box3().setFromObject(character.group);
    const size = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    const half = portraitHalfExtent(size.x, size.y);
    camera = new OrthographicCamera(-half, half, half, -half, 0.1, 100);
    camera.position.set(center.x, center.y, 12);
    camera.lookAt(center.x, center.y, 0);
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
  // ResizeObserver, not window.resize: catches orientation changes and any
  // layout-driven size shift, on the element that actually changed.
  const portraitObserver = new ResizeObserver(sizePortrait);
  portraitObserver.observe(portraitCanvas);

  // ── The portrait's loop ───────────────────────────────────────────────────
  // Paused while document.hidden (battery); resumes without a dt lurch. The
  // character's own ambient drift runs inside update(), so nothing on this
  // screen ever fully arrests (TASTE §2.1).
  let raf = 0;
  let last = performance.now();
  /** The creature's own facing, captured on its first frame — see below. */
  let facing: number | null = null;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - last, 100);
    last = now;

    const yaw = spin.update(dt);
    if (character && renderer && scene && camera) {
      character.update(dt, now);
      // Yaw is the person's alone (user ruling, 2026-08-20: *"the egg and
      // the character should not ambiently spin. It should be
      // user-driven."*). The drift floor's third term is a rotation
      // (sampleDrift().rot, ±0.17°) and character.update() writes it onto
      // rotation.y every frame; the facing is pinned at what the creature
      // was built with instead, and the drag is added to it. With no input
      // the angle is bit-identical frame to frame.
      //
      // The floor itself is NOT removed: drift.x/drift.y still move the
      // creature every frame, which is the ambient motion TASTE §2.1
      // requires at confidence 1.00 and what the stillness probe reads.
      if (facing === null) facing = character.group.rotation.y;
      character.group.rotation.y = facing + yaw;
      renderer.render(scene, camera);
    }
  };
  const start = (): void => {
    if (raf !== 0) return;
    last = performance.now();
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

  return {
    setPose(msg: PoseMsg): void {
      // Mirror what the world says this creature is doing, without
      // re-playing the echo of the tap that already played locally. The
      // pose's position and heading drove the minimap, which this screen no
      // longer shows — the emote marker is what is still read.
      const next = nextPoseEmote(msg.emote, marker);
      marker = next.marker;
      if (next.play !== null) character?.emote(next.play);
    },
    setRoster(_msg: RosterMsg): void {
      // The roster fed the minimap only. It is still delivered (main.ts
      // caches it and the session keeps sending) so nothing upstream has to
      // know this screen stopped drawing a map — bringing the map back is a
      // mount, not a rewire.
    },
    setName(name: string): void {
      nameLine.textContent = name.toLowerCase();
    },
    spin(): SpinState {
      return spin.state();
    },
    destroy(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      portraitObserver.disconnect();
      spin.destroy();
      character?.dispose();
      renderer?.dispose();
      field.remove();
      nameLine.remove();
      keys.el.remove();
    },
  };
}
