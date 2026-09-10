/**
 * World assembly (PLAN §7): renderer, scene, camera rig, ground, lighting,
 * flat shadow pass, prop scatter, ink pass, grain pass, and the render loop.
 *
 * Post chain: scene → ink composite (toon bands + wobbly contours + hatch)
 * → grain (the final paper layer). GENERATOR §ink rendering pass.
 */

import { Color, Scene, WebGLRenderer, type Texture } from 'three';
import { SURFACE } from '../taste/tokens';
import { CameraRig } from './camera';
import { createEnvironment, type Environment } from './environment';
import { GrainPass } from './grain';
import { createGround } from './ground';
import { InkPass } from './ink';
import { createLighting } from './lighting';
import { createScatter, type Scatter } from './scatter';
import { FlatShadows } from './shadows';
import {
  landscapeMode,
  setLandscapeMode,
  setTerrainParams,
  terrainParams,
  type TerrainParams,
} from './landscape';
import { ROLLING_SURFACE, type Surface } from './surface';
import { createWater, type Water } from './water';

export type FrameCallback = (dt: number, nowMs: number) => void;

/**
 * Frame-time ceiling for the sim step (QA audit D3). Real elapsed time is
 * integrated up to here — down to ~4 fps the world stays wall-clock true —
 * and only a longer gap (tab return, debugger pause) is clamped so the
 * catch-up never lands as a lurch. Springs are unconditionally stable at
 * this step size (ζ ≥ 1 + internal 16ms substepping in src/motion/spring.ts).
 */
export const DT_CLAMP_MS = 250;

export interface WorldHandles {
  scene: Scene;
  cameraRig: CameraRig;
  /**
   * The ground under everything (PLAN §7.2). The one seam every consumer
   * samples for a height or an up-normal — the ground mesh, the scatter, the
   * shadow stamps and every walker — so that the flat map can become a sphere
   * planet without a caller changing.
   */
  surface: Surface;
  /** The renderer, for dev-panel pixel readbacks. */
  renderer: WebGLRenderer;
  shadows: FlatShadows;
  /** Prop scatter: exclusions come from the creature coordinator. */
  scatter: Scatter;
  /**
   * Ponds and the lake: flat fills, drawn shorelines, drifting ripple marks.
   * Built once from the authored geography (src/world/landscape.ts) — the
   * seed re-rolls props, never the map. Only the live terrain dials move it,
   * and only in y (setTerrain below).
   *
   * PLUS the bodies a person paints, which are the other way round: rebuilt
   * on demand by the dev paint skill (src/dev/paint.ts) through
   * `water.setPainted`, into `water.paintedGroup` — a second group added to
   * the scene beside the authored one, and one the landscape switch never
   * hides. Their levels are absolute, so no terrain dial moves them.
   */
  water: Water;
  /** Ink pass tuning surface for the dev panel. */
  ink: InkPass;
  /** Grain pass amplitude handle (dev panel slider + grain gate). */
  grain: GrainPass;
  /** Time-of-day + weather engine (spring-glided; drives lights + ink). */
  environment: Environment;
  /**
   * Dev color grade for the paper field: set the scene background and the
   * ground to a css color (e.g. a picker's hex string). Night dimming
   * keeps scaling the chosen color, so time of day still reads. Passing the
   * ground token restores the shipped achromatic look exactly.
   */
  setBackgroundColor(color: string): void;
  /**
   * Move the live terrain dials and rebuild the world under them
   * (src/world/landscape.ts `TerrainParams`): how much elevation, how far
   * apart the tiers sit, how wide the relief is spread.
   *
   * Three systems have to be told, in this order — the ground re-displaces
   * its field, the scatter re-seats every instance and stamp on it, and the
   * water re-seats each body's sheets on its new level.
   *
   * Creatures, eggs and their shadow stamps re-sample the Surface every
   * frame, so they follow on their own. ONE exception, and it is acceptable
   * for a dev dial: an egg's `baseY` is fixed when it is placed, so an egg
   * already incubating stays at the height the ground had under it until it
   * hatches.
   */
  setTerrain(next: Partial<TerrainParams>): void;
  /** The dials the world is currently shaped by. */
  terrain(): TerrainParams;
  /**
   * Show or hide the authored map (src/world/landscape.ts `LandscapeMode`).
   *
   * The world OPENS plain — a flat field of scattered props on flat paper,
   * the way it looked before the map existed — and this is the switch that
   * brings the geography in: the forest, the range, the lake and its island,
   * the ponds, the reeds and every foot of elevation under them (2026-09-09,
   * user ask: the environment gets sculpted live in front of an audience, so
   * the room has to be able to start from nothing).
   *
   * Four systems have to be told, in this order — the ground re-displaces its
   * field, the scatter RE-ROLLS its placement (unlike a terrain dial: the map
   * decides which kinds grow where, so the world under the new mode is a
   * different placement from the same seed), the water re-seats its sheets on
   * their new levels, and then it shows or hides them. That is a superset of
   * what `setTerrain` does, so a PAINTED map (src/world/painted.ts) comes
   * through the switch intact: the sampler stays installed, every one of
   * these three re-reads `terrainHeight`, and the painted hills stand in
   * either mode — which is the point of opening flat and sculpting live.
   *
   * Creatures, eggs and their shadow stamps re-sample the Surface every frame,
   * so they settle onto the new ground on their own — with the same one
   * exception as `setTerrain`: an egg's `baseY` is fixed when it is placed, so
   * an egg already incubating stays at the height the ground had under it
   * until it hatches.
   */
  setLandscape(on: boolean): void;
  /**
   * Re-roll and rebuild the SCATTER alone, on the ground exactly as it
   * stands (2026-09-09, user ask: the environment brush kit).
   *
   * A planting stroke changes what grows, never where the ground is — so it
   * needs the scatter's own re-roll and none of the rest of `setTerrain`.
   * The ground field, the water levels and every shadow stamp on them are
   * untouched, which is the whole reason this exists as a separate handle:
   * one is ~20-30ms, the other ~250-330ms, and the brush is meant to be
   * usable while an audience watches.
   */
  refreshScatter(): void;
  /**
   * Hand the ground the `path` brush's live weight texture, or `null` to
   * stop drawing a trail (`Ground.setPaintedPath`). The dev paint skill's
   * half of the dirt trail: the ground inks it, the scatter refuses to grow
   * on it, and both read the one painted layer.
   */
  setPaintedPath(texture: Texture | null): void;
  /** Slide the camera back to the world's default view (`CameraRig.resetView`)
   * — the tool strip's home button. Never a cut: the rig retargets. */
  resetView(): void;
  /** True when the authored map is the world on screen. */
  landscape(): boolean;
  /**
   * Hand the ONE-pointer drag to something else, or take it back.
   *
   * The view controls below own a plain drag: it orbits, and shift+drag
   * pans. A dev tool that draws on the ground (src/dev/paint.ts) needs the
   * same gesture, and both listeners sit on the same canvas — neither can
   * out-order the other, so the world has to let go rather than the tool
   * shout louder. False parks the orbit; the pointer is still tracked, so
   * handing it back mid-drag resumes from where the pointer is instead of
   * lurching (TASTE §2.1: no cuts).
   *
   * Two-finger pinch/twist and the wheel keep working either way — a tool
   * that owns one pointer has no claim on the operator's zoom.
   */
  setSoloDrag(enabled: boolean): void;
  /** Register per-frame work (entity drift, gaits, …). Runs before render. */
  onFrame(callback: FrameCallback): void;
  /**
   * Stop drawing without tearing anything down.
   *
   * For when something opaque covers the whole viewport (the companion
   * panel on a handset). The scene, the creatures and the gl context all
   * stay exactly as they are, so coming back is instant — the point is to
   * stop paying for frames nobody can see, and to leave the main thread
   * free for whatever is on top.
   */
  setPaused(paused: boolean): void;
}

export function start(canvas: HTMLCanvasElement): WorldHandles {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);

  const scene = new Scene();
  // Beyond the ground the frame is still the ground value — one field.
  // The environment engine dips its value at night (never its hue), so the
  // token stays the base and the live background is a scaled copy.
  const backgroundBase = new Color(SURFACE.ground);
  const background = backgroundBase.clone();
  scene.background = background;
  // Paper color (dev color grade): setBackgroundColor swaps backgroundBase
  // (and the ground's one material) wholesale; the night dimming below keeps
  // scaling whatever base is current, so time of day still reads under a grade.
  let backgroundLumaScale = 1;

  const cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
  const shadows = new FlatShadows();
  const ink = new InkPass();
  const grain = new GrainPass();
  // The world's terrain. Everything below is seated on THIS and nothing else
  // derives a height of its own (src/world/surface.ts).
  const surface = ROLLING_SURFACE;
  const scatter = createScatter({ surface });
  const lighting = createLighting();

  const ground = createGround(surface);
  // Water sits directly on its basin's paper, under the ticks, the prop stamps
  // and the creature shadows — so a creature walking the shore still casts
  // across it.
  const water = createWater();
  // `water.paintedGroup` is a SIBLING of `water.group` on purpose: the
  // landscape mode hides the authored water by hiding that group, and painted
  // water has to stand in the plain world (src/world/water.ts `paintedGroup`).
  scene.add(
    ground.group,
    water.group,
    water.paintedGroup,
    lighting.group,
    shadows.group,
    scatter.group,
  );

  // Time-of-day + weather. All its setters glide through ζ≥1 springs; the
  // per-frame update pushes sun direction, light balance, exposure, fog and
  // streak amounts into the lights and the ink composite.
  const environment = createEnvironment({
    lighting,
    ink,
    setBackground: (lumaScale: number): void => {
      backgroundLumaScale = lumaScale;
      background.copy(backgroundBase).multiplyScalar(lumaScale);
    },
  });
  // Tiny always-on handle for smokes and the ghost panel's feature-detect —
  // deliberately not dev-gated: it carries no dev-only code.
  (window as Window & { __refworldEnv?: Environment }).__refworldEnv = environment;
  // Same deal for the physics smoke: live prop colliders (hard/soft circles).
  (
    window as Window & { __refworldColliders?: () => ReturnType<Scatter['colliders']> }
  ).__refworldColliders = () => scatter.colliders();
  // And the scatter handle itself, for density/variation smokes.
  (window as Window & { __refworldScatter?: Scatter }).__refworldScatter = scatter;
  // The live camera, for framing/focus smokes.
  (window as Window & { __refworldCamera?: unknown }).__refworldCamera = cameraRig.camera;
  // And the water, for the shoreline/ripple smokes and the stillness probe.
  (window as Window & { __refworldWater?: Water }).__refworldWater = water;

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    cameraRig.resize(width, height);
    ink.setSize(width, height, pixelRatio);
    grain.setSize(width, height, pixelRatio);
  };
  window.addEventListener('resize', resize);
  resize();

  // ── view controls (user-specified scheme) ────────────────────────────────
  // Plain click-drag orbits BOTH axes with the cellshader reference feel
  // (OrbitControls mapping + damping); shift+drag pans. Trackpad pinch
  // zooms (macOS delivers pinch as ctrl+wheel); two-finger scroll / wheel
  // zooms too. On touch, one finger orbits and two fingers pinch-zoom and
  // twist-rotate. Wheel deltas drive spring retargets so motion drifts.
  const pointers = new Map<number, { x: number; y: number }>();
  canvas.style.touchAction = 'none';
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  let panning = false;
  /**
   * Whether a ONE-pointer drag still turns the camera — see setSoloDrag.
   * Two-finger pinch/twist and the wheel are untouched by it, so a tool that
   * owns the single pointer never costs the operator their zoom.
   */
  let soloDrag = true;
  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Shift+drag pans; plain drag orbits (user scheme, cellshader feel).
    panning = event.shiftKey;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      // The pointer's position is remembered whether or not the camera acts
      // on it: a drag handed back mid-stroke must not arrive as one huge
      // delta, which is a cut, and there are none of those (TASTE §2.1).
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (soloDrag) {
        if (panning) cameraRig.panBy(dx, dy, window.innerHeight);
        else cameraRig.rotateBy(dx, dy, window.innerHeight);
      }
    } else if (pointers.size === 2) {
      // Pinch: zoom by distance ratio; twist: rotate by angle delta.
      const entries = [...pointers.entries()];
      const other = entries.find(([id]) => id !== event.pointerId);
      if (other) {
        const [, o] = other;
        const beforeD = Math.hypot(prev.x - o.x, prev.y - o.y);
        const beforeA = Math.atan2(prev.y - o.y, prev.x - o.x);
        const afterD = Math.hypot(event.clientX - o.x, event.clientY - o.y);
        const afterA = Math.atan2(event.clientY - o.y, event.clientX - o.x);
        if (beforeD > 12) cameraRig.zoomDirect(afterD / beforeD);
        cameraRig.rotateBy(((afterA - beforeA) * 180) / Math.PI, 0, window.innerHeight);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
    }
  });
  const releasePointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) panning = false;
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      // The wheel zooms (user scheme). Trackpad pinch arrives as ctrl+wheel
      // with finer deltas, so it gets a stronger factor to feel 1:1.
      const k = event.ctrlKey || event.metaKey ? 0.01 : 0.0016;
      cameraRig.zoomBy(Math.exp(-event.deltaY * k));
    },
    { passive: false },
  );

  const frameCallbacks: FrameCallback[] = [];
  let last = performance.now();
  /** Nothing visible is on screen — see setPaused. */
  let paused = false;

  const loop = (nowMs: number): void => {
    // Integrate real elapsed time up to DT_CLAMP_MS so low fps never turns
    // into slow motion (QA audit D3): every spring is ζ≥1 and substeps at
    // 16ms internally, so a 250ms step settles without overshoot. Beyond the
    // clamp (a background tab returning) the frame is capped — a lurch guard,
    // not a pacing mechanism.
    const dt = Math.min(nowMs - last, DT_CLAMP_MS);
    last = nowMs;

    // Covered by something opaque and full-screen (the companion panel):
    // keep the scene and every built creature exactly as they are, and
    // stop spending a phone's battery and main thread drawing what nobody
    // can see. The clock is NOT advanced past the pause, so the world does
    // not lurch forward on the frame it comes back.
    if (paused) {
      requestAnimationFrame(loop);
      return;
    }

    cameraRig.update(dt, nowMs);
    environment.update(dt, nowMs);
    // The ripple drift: one uniform write, a sine of wall-clock time. Nothing
    // on the water ever fully arrests (TASTE §2.1).
    water.update(nowMs);
    // And the ground's own drawn tier lines, whose pen wobble drifts on the
    // ambient beat — the same deal, one uniform write.
    ground.update(nowMs);
    // Sun-driven shadow stamps: one shared ellipse + one flat value per
    // frame for every stamp (scatter throttles its instanced re-lay).
    const sun = environment.sun;
    shadows.setSun(sun.azimuth, sun.altitude, sun.presence);
    scatter.setSun(sun.azimuth, sun.altitude, sun.presence);
    // Weather-driven vertex wind: the environment's spring-glided strength
    // into the scatter's shared wind uniforms (three value writes).
    scatter.setWind(environment.state.wind, nowMs);
    for (const callback of frameCallbacks) callback(dt, nowMs);
    const composed = ink.render(renderer, scene, cameraRig.camera, nowMs);
    grain.compose(renderer, composed, nowMs);

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  return {
    scene,
    cameraRig,
    surface,
    renderer,
    shadows,
    scatter,
    water,
    ink,
    grain,
    environment,
    setBackgroundColor: (color: string): void => {
      backgroundBase.set(color);
      background.copy(backgroundBase).multiplyScalar(backgroundLumaScale);
      // One material for both ground meshes: the field and the far ring can
      // never drift apart under a grade.
      ground.material.color.copy(backgroundBase);
    },
    setTerrain: (next: Partial<TerrainParams>): void => {
      setTerrainParams(next);
      ground.rebuild();
      scatter.refreshTerrain();
      water.refreshLevels();
    },
    terrain: (): TerrainParams => terrainParams(),
    setLandscape: (on: boolean): void => {
      setLandscapeMode(on ? 'landscape' : 'plain');
      ground.rebuild();
      scatter.refreshLandscape();
      // The levels move with the mode — a basin sits under the plain's zero —
      // so the sheets are re-seated before they are shown.
      water.refreshLevels();
      water.setVisible(on);
    },
    refreshScatter: (): void => {
      scatter.refreshLandscape();
    },
    resetView: (): void => {
      cameraRig.resetView();
    },
    setPaintedPath: (texture: Texture | null): void => {
      ground.setPaintedPath(texture);
    },
    landscape: (): boolean => landscapeMode() === 'landscape',
    setSoloDrag: (enabled: boolean): void => {
      soloDrag = enabled;
    },
    onFrame: (callback: FrameCallback): void => {
      frameCallbacks.push(callback);
    },
    setPaused: (next: boolean): void => {
      if (next === paused) return;
      paused = next;
      // Resuming: forget how long we were away. `last` is what dt is
      // measured from, so leaving it stale would hand the first live frame
      // a dt of however many seconds the panel was open — every creature
      // would jump. The clamp would cap it, but a clamped jump is still a
      // jump, and nothing here is allowed to move discontinuously.
      if (!paused) last = performance.now();
    },
  };
}
