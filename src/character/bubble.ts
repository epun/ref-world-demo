/**
 * Speech bubble (emote status) — the primary legible emote signal at world
 * scale. The body deformation choreography stays; this floats a hand-drawn
 * bubble above the head with the emote's emoji inside.
 *
 * Visual language (TASTE §4, §6): the bubble is an icon mark built from a
 * hairline outline (WORLD.ink) around a light paper fill (WORLD.light) — a
 * wobbly organic ellipse with a small curved tail, never a constructed
 * rounded-rect. The outline waver is seeded per character and deterministic,
 * so the same drawing grows the same bubble on every device. The emoji is
 * rendered as text into the same canvas in its native color — an explicit
 * user carve-out from the black-and-white ruling (TASTE §6 note). To keep
 * that color true on screen, the sprite lives on OVERLAY_LAYER: the ink
 * composite (toon quantize, exposure ramp, fog/weather washes) never touches
 * it — the ink pass draws it on top of the composed frame, under the grain.
 * The toGrayscaleLuma helper stays exported for the achromatic gate's
 * bookkeeping and any future flip back to a fully monochrome bubble.
 *
 * Motion (TASTE §2.1): the bubble SLIDES up from the head over
 * MOTION.secondaryMs on ζ≥1 springs (position + scale 0.75→1 — never from
 * zero), holds for 2×MOTION.primaryMs, then completes its gesture by
 * drifting up and fading out over MOTION.primaryMs. No bounce, no cut. A
 * new show() mid-flight retargets the same springs — interruptible by
 * construction. A whisper of ambient sway keeps it off the stillness probe.
 *
 * Billboard: a THREE.Sprite, so the bubble always faces the iso camera.
 *
 * Pure parts (BUBBLE_EMOJI, bubbleOutlinePoints, toGrayscaleLuma) are
 * exported for node tests; nothing at module scope touches the DOM, and the
 * canvas is created lazily inside createBubble.
 */

import { CanvasTexture, SRGBColorSpace, Sprite, SpriteMaterial } from 'three';
import { Spring } from '../motion/spring';
import type { EmoteName } from '../net/protocol';
import { MOTION, WORLD } from '../taste/tokens';
import { OVERLAY_LAYER } from '../world/layers';

// ── pure data + helpers (node-safe, tested) ─────────────────────────────────

/**
 * The emoji for each emote. Typed against EmoteName so a protocol change
 * breaks the build here, not silently at runtime.
 */
export const BUBBLE_EMOJI: Record<EmoteName, string> = {
  happy: '😊',
  sad: '😢',
  sleepy: '😴',
  angry: '😠',
  surprised: '😲',
  dance: '🎶',
  wave: '👋',
} as const;

export interface OutlinePoint {
  x: number;
  y: number;
}

/** Cheap deterministic hash → [0, 1). Same recipe as motion/ambient. */
function hash(n: number): number {
  const x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

/** Ellipse center/radii in normalized [0,1]² canvas space (tail sits below). */
const OUTLINE_CX = 0.5;
const OUTLINE_CY = 0.42;
const OUTLINE_RX = 0.42;
const OUTLINE_RY = 0.33;
/** Radial waver amplitude — enough to read hand-drawn, not enough to lump. */
const OUTLINE_WAVER = 0.022;

/**
 * The bubble outline: a wobbly organic ellipse as a closed point loop in
 * normalized [0,1]² coordinates. Pure and deterministic — the waver is
 * derived from the seed alone, so a given character always draws the same
 * bubble.
 */
export function bubbleOutlinePoints(seed: number, count = 26): OutlinePoint[] {
  const points: OutlinePoint[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const waver = (hash(seed * 13.37 + i * 7.91) - 0.5) * 2 * OUTLINE_WAVER;
    points.push({
      x: OUTLINE_CX + Math.cos(a) * (OUTLINE_RX + waver),
      y: OUTLINE_CY + Math.sin(a) * (OUTLINE_RY + waver),
    });
  }
  return points;
}

/**
 * Per-pixel luma conversion (Rec. 709), RGBA in → RGBA out, alpha kept.
 * Pure array-in/array-out so it runs (and tests) without a canvas; the
 * bubble pipes its getImageData buffer through here.
 */
export function toGrayscaleLuma(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const luma = Math.round(
      0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!,
    );
    out[i] = luma;
    out[i + 1] = luma;
    out[i + 2] = luma;
    out[i + 3] = data[i + 3]!;
  }
  return out;
}

// ── the bubble ──────────────────────────────────────────────────────────────

/** Canvas resolution — crisp at world scale without wasting texture memory. */
const CANVAS_PX = 192;

/** Bubble size in world units (square sprite). */
const BUBBLE_SIZE = 1.1;

/**
 * [D] Screen-space legibility floor (QA audit D4): the bubble is the primary
 * legible emote signal, and proportional-to-the-creature made it a ~14px
 * speck at the default framing. The sprite never renders under this many CSS
 * pixels tall — the floor only ever raises the world-proportional size,
 * never shrinks it, and the entrance/exit springs run untouched.
 */
const MIN_SCREEN_PX = 44;

/** Gap between the character's bounding-box top and the bubble's bottom. */
const HEAD_MARGIN = 0.3;

/** How far below rest the entrance slide starts (world units). */
const ENTER_DROP = 0.45;

/** How far past rest the exit drifts upward (world units). */
const EXIT_DRIFT = 0.55;

/** Entrance scale floor — never from zero (TASTE §2.1). */
const ENTER_SCALE = 0.75;

/** Hairline outline width on the canvas, in canvas pixels. */
const OUTLINE_PX = 3;

type BubblePhase = 'hidden' | 'enter' | 'hold' | 'exit';

export interface BubbleOptions {
  /** Deterministic per-character seed (drives the outline waver). */
  seed: number;
  /** World-space y of the character's bounding-box top (group-local). */
  anchorY: number;
}

export interface Bubble {
  /** Add to the character group. Billboards toward the camera on its own. */
  object: Sprite;
  /** Show (or retarget to) the bubble for an emote. */
  show(emote: EmoteName): void;
  /** Advance springs and the hold/exit timeline. Call once per frame. */
  update(dt: number, nowMs: number): void;
  /**
   * Current world-units-per-screen-pixel (ortho frustum height / viewport
   * height / camera zoom), fed by the owner whenever it can compute it.
   * Drives the screen-space legibility floor; 0 (the default) disables the
   * floor and keeps the pure world-proportional size (headless callers).
   */
  setWorldUnitsPerPixel(v: number): void;
  /** Release GPU resources and unregister the springs. */
  dispose(): void;
}

/**
 * Create the speech bubble for one character. The canvas, texture, and
 * sprite are created here (not at module scope) so importing this module in
 * node — for the pure helpers — never touches the DOM.
 */
export function createBubble(options: BubbleOptions): Bubble {
  const { seed, anchorY } = options;
  const restY = anchorY + HEAD_MARGIN + BUBBLE_SIZE / 2;

  // Canvas + texture are created lazily on the first show(): createCharacter
  // runs headless in node tests, and a hidden bubble needs no texture yet.
  let ctx: CanvasRenderingContext2D | null = null;
  let texture: CanvasTexture | null = null;

  const material = new SpriteMaterial({
    transparent: true,
    depthWrite: false,
    // The bubble is a status signal: it reads over the body and props even
    // when the creature stands behind something (renderOrder draws it last).
    depthTest: false,
    opacity: 0,
  });
  // The world's ink pass re-renders the scene with a MeshNormalMaterial
  // override for edge detection. An overridden sprite loses its billboard
  // (the quad renders flat in world space) and the edge pass inks a false
  // tilted square. Opting out keeps the sprite's own material in that pass…
  material.allowOverride = false;
  const sprite = new Sprite(material);
  // …and this hook zeroes its opacity there, so the bubble contributes
  // nothing at all to the normal buffer: no false edges, only the beauty
  // render carries it (visibleOpacity is restored for the beauty pass).
  let visibleOpacity = 0;
  sprite.onBeforeRender = (_renderer, scene) => {
    material.opacity = scene?.overrideMaterial ? 0 : visibleOpacity;
  };
  // Ink exemption (TASTE §6 emoji carve-out): the sprite lives ONLY on the
  // overlay layer, so the beauty/normal renders (camera layer 0) skip it —
  // no quantize, no exposure ramp, no fog wash, and by construction no false
  // edges either (the override guards above stay as belt-and-braces). The
  // ink pass draws this layer on top of its composite, before the grain.
  sprite.layers.set(OVERLAY_LAYER);
  sprite.scale.set(BUBBLE_SIZE * ENTER_SCALE, BUBBLE_SIZE * ENTER_SCALE, 1);
  sprite.position.set(0, restY - ENTER_DROP, 0);
  sprite.visible = false;
  // Draw above the body so the light fill never z-fights the head.
  sprite.renderOrder = 2;

  /** Paint the bubble chrome (ink on paper) + the emoji in native color. */
  function draw(emoji: string): void {
    // DOM guard: headless (node) callers get a working state machine with no
    // texture — nothing here may throw without a document.
    if (!ctx && typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_PX;
      canvas.height = CANVAS_PX;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        texture = new CanvasTexture(canvas);
        // The canvas holds sRGB pixels. Declaring that here makes the
        // sample→linear→final-encode round trip exact, so the emoji lands on
        // screen at its true color — untagged, the pixels would be treated
        // as linear and the grain pass's sRGB encode would wash them bright.
        texture.colorSpace = SRGBColorSpace;
        material.map = texture;
        material.needsUpdate = true;
      }
    }
    if (!ctx || !texture) return;
    const s = CANVAS_PX;
    ctx.clearRect(0, 0, s, s);

    ctx.lineWidth = OUTLINE_PX;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = WORLD.ink;
    ctx.fillStyle = WORLD.light;

    // Tail first: a small curved wedge from under the ellipse toward the
    // head; the ellipse fill then covers the junction so it reads as one
    // hand-drawn mark.
    ctx.beginPath();
    ctx.moveTo(0.46 * s, 0.68 * s);
    ctx.quadraticCurveTo(0.44 * s, 0.86 * s, 0.38 * s, 0.96 * s);
    ctx.quadraticCurveTo(0.5 * s, 0.9 * s, 0.58 * s, 0.7 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // The wobbly body: smooth closed curve through the seeded waver points
    // (quadratics through segment midpoints — no polygon corners).
    const pts = bubbleOutlinePoints(seed).map((p) => ({ x: p.x * s, y: p.y * s }));
    const last = pts[pts.length - 1]!;
    const first = pts[0]!;
    ctx.beginPath();
    ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const n = pts[(i + 1) % pts.length]!;
      ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // The emoji, centered in the ellipse. Color emoji glyphs ignore
    // fillStyle; monochrome fallback fonts (headless/test environments)
    // render with it — ink, so the mark stays legible either way.
    ctx.fillStyle = WORLD.ink;
    ctx.font = `${Math.round(s * 0.42)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, OUTLINE_CX * s, (OUTLINE_CY + 0.02) * s);

    // Emoji stay in COLOR — an explicit user carve-out from the
    // black-and-white ruling (TASTE §6 note): the bubble chrome is ink on
    // paper, but the emoji inside renders with its native palette. The
    // toGrayscaleLuma helper remains exported for the achromatic gate's
    // bookkeeping and any future flip back.
    texture.needsUpdate = true;
  }

  // One ζ≥1 spring per animated property. Entrance slide + scale settle at
  // the secondary token; opacity settles at the primary so the exit fade
  // completes over MOTION.primaryMs.
  const y = new Spring(restY - ENTER_DROP, { settleMs: MOTION.secondaryMs });
  const scale = new Spring(ENTER_SCALE, { settleMs: MOTION.secondaryMs });
  const opacity = new Spring(0, { settleMs: MOTION.primaryMs });

  let phase: BubblePhase = 'hidden';
  let phaseMs = 0;
  let shownEmoji = '';
  /** Legibility floor in world units — MIN_SCREEN_PX at the current zoom. */
  let minWorldSize = 0;

  return {
    object: sprite,

    show(emote: EmoteName): void {
      const emoji = BUBBLE_EMOJI[emote];
      // Mid-exit the bubble is already at its least visible, so swapping the
      // texture now IS the low point of the gesture; while fully shown a
      // straight swap of the icon mark reads fine. Either way: immediately.
      if (emoji !== shownEmoji) {
        draw(emoji);
        shownEmoji = emoji;
      }
      if (phase === 'hidden') {
        // No gesture in flight — start the entrance from its slide origin.
        y.reset(restY - ENTER_DROP);
        scale.reset(ENTER_SCALE);
        opacity.reset(0);
        sprite.visible = true;
      }
      // Retarget (never snap): a show() mid-hold or mid-exit carries the
      // springs' position and velocity into the new entrance.
      y.retarget(restY);
      scale.retarget(1);
      opacity.retarget(1);
      phase = 'enter';
      phaseMs = 0;
    },

    update(dt: number, nowMs: number): void {
      if (phase === 'hidden') return;
      phaseMs += dt;

      if (phase === 'enter' && phaseMs >= MOTION.secondaryMs) {
        phase = 'hold';
        phaseMs = 0;
      } else if (phase === 'hold' && phaseMs >= 2 * MOTION.primaryMs) {
        // Exit: drift up and fade — the gesture completes, never cuts.
        phase = 'exit';
        phaseMs = 0;
        y.retarget(restY + EXIT_DRIFT);
        opacity.retarget(0);
      } else if (phase === 'exit' && phaseMs >= MOTION.primaryMs && opacity.value < 0.01) {
        phase = 'hidden';
        sprite.visible = false;
        // Leave the scene graph entirely so the character's measured bounds
        // return to exactly the body's (show() re-attaches via the owner).
        sprite.removeFromParent();
        return;
      }

      // Ambient floor: a whisper of sway so the bubble never fully arrests.
      const sway =
        Math.sin((nowMs / MOTION.ambientMs) * Math.PI * 2 + seed) *
        MOTION.ambientAmplitude *
        BUBBLE_SIZE;

      // Screen-space floor (QA audit D4): clamp ABOVE the spring-driven
      // world-proportional size, never below it. The spring still advances
      // every frame, so entrance/exit motion carries straight through when
      // the floor is not binding, and position/opacity keep sliding when it
      // is — the gesture never cuts.
      const k = Math.max(scale.update(dt) * BUBBLE_SIZE, minWorldSize);
      sprite.scale.set(k, k, 1);
      // When the floor grows the bubble past its proportional size, lift it
      // by the extra half-height so the tail keeps the same gap above the
      // head instead of swallowing the (intentionally tiny) creature.
      const lift = Math.max(0, (k - BUBBLE_SIZE) / 2);
      sprite.position.y = y.update(dt) + sway + lift;
      visibleOpacity = opacity.update(dt);
      material.opacity = visibleOpacity;
    },

    setWorldUnitsPerPixel(v: number): void {
      minWorldSize = v > 0 && Number.isFinite(v) ? MIN_SCREEN_PX * v : 0;
    },

    dispose(): void {
      texture?.dispose();
      material.dispose();
      y.dispose();
      scale.dispose();
      opacity.dispose();
    },
  };
}
