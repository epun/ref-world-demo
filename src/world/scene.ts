/**
 * World assembly (PLAN §7): renderer, scene, camera rig, ground, lighting,
 * flat shadow pass, prop scatter, ink pass, grain pass, and the render loop.
 *
 * Post chain: scene → ink composite (toon bands + wobbly contours + hatch)
 * → grain (the final paper layer). GENERATOR §ink rendering pass.
 */

import { Color, Scene, Vector3, WebGLRenderer, type Texture } from 'three';
import { GHIBLI, SURFACE, WORLD } from '../taste/tokens';
import { CameraRig } from './camera';
import { createEnvironment, type Environment } from './environment';
import { GrainPass } from './grain';
import { createGround, FIELD_SIZE } from './ground';
import { createPhysicsWorld, type PhysicsWorld } from '../physics/world';
import { deviceTier, type DeviceTier } from './device';
import { createPropBodies, type PropBodies } from './rocks';
import { INK_DEFAULTS, InkPass } from './ink';
import {
  createFlowerField,
  FLOWER_COUNT_PHONE,
  FLOWER_COUNT_PROJECTION,
  FLOWER_SPAN_PHONE,
  FLOWER_SPAN_PROJECTION,
} from './ghibli/flowers';
import {
  createGrassField,
  GRASS_COUNT_PHONE,
  GRASS_COUNT_PROJECTION,
  GRASS_SPAN_PHONE,
  GRASS_SPAN_PROJECTION,
} from './ghibli/grass';
import { applyGhibliPost } from './ghibli/post';
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
import { sanitizeStyle, type WorldStyle } from './style';
import { ROLLING_SURFACE, type Surface } from './surface';
import { setToonEnabled, setToonSun } from './toon';
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
  /** …and the fire driver's scorch texture (`Ground.setPaintedScorch`): the
   * drawing half of a burn, exactly as `setPaintedPath` is the drawing half
   * of a trail. The placement half needs no handle — scatter reads the fire
   * field through the sampler seam already installed. */
  setPaintedScorch(texture: Texture | null): void;
  /**
   * Hand over the painted PLANTING layers the ghibli elements read as live
   * buffers — the `grass` and `flowers` weights and the comb's direction
   * layer (src/dev/paint.ts owns them; the buffers are the painted map's, so
   * they are shared and never copied).
   *
   * What they do: the blade field grows thick where somebody painted grass
   * and leans where they combed it, the bloom field blooms where they painted
   * flowers, and the ground goes lush under the grass weight. Inert on `ink`
   * — the shipped look grows its meadow as instanced ink marks through the
   * placement roll instead, which needs no texture at all — but the layers
   * are REMEMBERED, so a style switch later picks them up.
   */
  setPaintedLayers(layers: {
    grass?: Texture | null;
    flowers?: Texture | null;
    comb?: Texture | null;
  }): void;
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
  /**
   * The rigid-body world (src/physics/world.ts), or null on a page that is
   * not simulating — which is MOST pages (see `enablePhysics`).
   *
   * Every consumer has to tolerate null and either poll or use
   * `onPhysicsReady`, and a consumer that finds null must not assume it is
   * merely early: on a viewer it stays null for the life of the page.
   */
  /**
   * What kind of screen this is (src/world/device.ts).
   *
   * Read ONCE, here, when the renderer is built — the pixel-ratio cap needs
   * it and so does the debris ceiling (`DEBRIS_CAP`), and two inline media
   * queries is how those two answers get to disagree. Exposed rather than
   * re-queried by the caller for exactly that reason.
   */
  readonly tier: DeviceTier;
  physics(): PhysicsWorld | null;
  /** Loose rocks, fixed prop bodies and the tree recoil
   * (src/world/rocks.ts). Null until, and unless, physics is enabled. */
  bodies(): PropBodies | null;
  /**
   * Load rapier and build the bodies. Idempotent — call it as often as you
   * like; the first call owns the promise and the rest await it.
   *
   * ONLY THE PAGE THAT SIMULATES CALLS THIS (docs/PLAN.md §7.6). Most people
   * watch the world from a phone, each running its own copy of this page
   * (docs/SESSION.md §6), and until the katamari rules landed all of them
   * downloaded a wasm payload and stepped a rigid-body world whose answers
   * they then threw away, because the host's events are the truth. A viewer
   * now runs no physics at all: the host decides what is stuck, loose and
   * settled, and every decision travels as a scene event.
   *
   * `src/main.ts` calls it when the election says this page is hosting, and
   * at startup on a page that is pinned as host (`?host=1`, the moderator
   * secret, the dev build, or an installation room with nobody to elect
   * against).
   */
  enablePhysics(): Promise<void>;
  /** Fires once when the physics world exists — immediately if it already
   * does, and NEVER on a page that never enables it. What a later layer
   * (creature bodies, katamari pickups) hangs its own setup on. */
  onPhysicsReady(callback: (physics: PhysicsWorld, bodies: PropBodies) => void): void;
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
  /**
   * Switch the whole frame between the two looks (docs/TASTE.md §9).
   *
   * ONE place, deliberately: the background, the ground's paper and its mark
   * ink, the three light colours, the cel lighting switch, the ink composite,
   * the prop palette, both shadow palettes and the water all move together,
   * because a frame half in one look and half in the other is not a style —
   * it is a bug nobody can name. `setStyle('ink')` restores every one of them
   * to the shipped tokens exactly, so this is reversible in a demo.
   */
  setStyle(style: WorldStyle): void;
  /** The look this world is rendering in. */
  style(): WorldStyle;
}

export interface WorldOptions {
  /**
   * The look this world opens in (src/world/style.ts). Defaults to `ink` —
   * the shipped one, and the only one the taste describes — so a caller that
   * says nothing gets the frame this project has always drawn.
   */
  style?: WorldStyle;
}

export function start(canvas: HTMLCanvasElement, opts: WorldOptions = {}): WorldHandles {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  /*
   * Pixel ratio cap. The frame is four full-resolution passes (colour,
   * normals, ink composite, grain — docs/QA-AUDIT.md D1), so every pixel
   * costs four, and a handset's world view was rendering the whole cast at
   * DPR 2 on a phone GPU. The crowd reference demo caps its ratio at 1.0
   * outright; here a projection keeps 2 (the ink lines are the picture),
   * and a coarse-pointer device — a phone looking at the world — caps at
   * 1.5, which is 44% fewer pixels per pass for a line the eye cannot
   * separate at arm's length. **[D]**
   */
  /*
   * ONE read of what kind of screen this is (src/world/device.ts). The cap
   * below and the debris ceiling the destruction task needs are the same
   * question asked twice, and they used to be two inline media queries.
   */
  const tier = deviceTier(
    typeof window.matchMedia === 'function'
      ? (query) => window.matchMedia(query).matches
      : () => false,
  );
  const pixelRatio = Math.min(window.devicePixelRatio, tier === 'phone' ? 1.5 : 2);
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

  /**
   * The rigid-body world, loaded off the critical path (PLAN §7.6) and only
   * on the page that simulates.
   *
   * Until `enablePhysics` is called — and forever, on a viewer — the world
   * runs EXACTLY as it did before physics existed: the loop's physics block
   * is skipped, rocks are the scatter's instance matrices and the creature
   * layer resolves against `scatter.colliders()` as always. The terrain
   * collider inside is sampled from the Surface seam and nothing else
   * derives a height (see src/physics/world.ts).
   *
   * It used to load unconditionally here, which meant every phone watching
   * the room downloaded the wasm and stepped a simulation it was then told
   * to ignore. `deviceTier` says most of the audience is on one.
   */
  let physics: PhysicsWorld | null = null;
  let bodies: PropBodies | null = null;
  /** The last scatter rebuild the bodies were reconciled against. */
  let seenVersion = -1;
  const physicsReady: ((p: PhysicsWorld, b: PropBodies) => void)[] = [];
  /** The one in-flight load, so N calls are one download. */
  let physicsLoad: Promise<void> | null = null;
  const enablePhysics = (): Promise<void> => {
    if (physicsLoad) return physicsLoad;
    physicsLoad = createPhysicsWorld(surface, FIELD_SIZE).then((p) => {
      physics = p;
      bodies = createPropBodies({
        physics: p,
        scatter,
        surface,
        wind: scatter.windField(),
      });
      seenVersion = scatter.rebuildVersion();
      for (const callback of physicsReady) callback(p, bodies);
      physicsReady.length = 0;
    });
    return physicsLoad;
  };

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
  // The renderer itself, for the frame-cost probes (draw calls, triangles).
  (window as Window & { __refworldRenderer?: WebGLRenderer }).__refworldRenderer = renderer;
  // The rigid-body world, for the physics smokes. Returns null until the
  // wasm chunk has loaded — a smoke has to wait for it.
  (
    window as Window & { __refworldPhysics?: () => PhysicsWorld | null }
  ).__refworldPhysics = () => physics;

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

  /** Scratch for the per-frame cel sun direction — one allocation, ever. */
  const toonSunDir = new Vector3();

  // ── the ghibli element fields (docs/ghibli-port.md §1–§2) ────────────────
  /**
   * The GPU blade field and the bloom field, built on the FIRST switch to the
   * ghibli style and never before it. They are the meadow on that style —
   * which is why the scatter hides its tick / grass / flower ink marks there
   * — and they are 150 000 and 40 000 instances on a projection, so a world
   * on `ink` must not lay a single one of them out.
   *
   * Hidden rather than removed when the style switches back: an invisible
   * mesh costs nothing per frame and the ink frame stays identical, while a
   * switch back to ghibli is instant rather than another quarter-million
   * blades' worth of layout.
   */
  let grass: ReturnType<typeof createGrassField> | null = null;
  let flowers: ReturnType<typeof createFlowerField> | null = null;
  /** The painted planting layers handed over so far (`setPaintedLayers`) —
   * remembered, so a field built after the brush mounted still gets them. */
  const paintedLayers: { grass: Texture | null; flowers: Texture | null; comb: Texture | null } = {
    grass: null,
    flowers: null,
    comb: null,
  };
  /**
   * The blade field's window slides with the camera (src/world/ghibli/grass.ts
   * — the density has to be envpaint's where the eye is, and the tier's budget
   * only covers a patch), and every slide re-bakes 150 000 ground heights.
   * Straight off the Surface seam that is 651ms, measured — so the seam is
   * sampled on a GRID over the window and each blade reads a bilinear tap of
   * it: ~9 400 samples for the same window, at a step under half a unit, which
   * still puts a blade beside a terrace lip on the lip rather than in it.
   *
   * Still the Surface seam and nothing else: this is a cache of its answers,
   * exactly as the region bake is (src/world/ghibli/region.ts). Nothing here
   * derives a height.
   */
  const GRID_SAMPLES = 97;
  /** [D] How far the look-target may drift before the window is re-seated.
   * The window is 44 units wide, so six keeps the dense patch under the eye
   * and a pan re-lays the field a handful of times rather than every frame. */
  const WINDOW_QUANTUM = 6;
  const windowGrid = new Float32Array(GRID_SAMPLES * GRID_SAMPLES);
  let gridX0 = 0;
  let gridZ0 = 0;
  let gridStep = 1;
  let gridReady = false;
  const bakeWindowGrid = (cx: number, cz: number, span: number): void => {
    gridStep = span / (GRID_SAMPLES - 1);
    gridX0 = cx - span / 2;
    gridZ0 = cz - span / 2;
    for (let iz = 0; iz < GRID_SAMPLES; iz++) {
      const z = gridZ0 + iz * gridStep;
      for (let ix = 0; ix < GRID_SAMPLES; ix++) {
        windowGrid[iz * GRID_SAMPLES + ix] = surface.sampleHeight(gridX0 + ix * gridStep, z);
      }
    }
    gridReady = true;
  };
  const windowHeightAt = (x: number, z: number): number => {
    if (!gridReady) return surface.sampleHeight(x, z);
    const fx = (x - gridX0) / gridStep;
    const fz = (z - gridZ0) / gridStep;
    // Outside the window every blade is faded out entirely, so the seam's own
    // answer is both correct and rare.
    if (fx < 0 || fz < 0 || fx > GRID_SAMPLES - 1 || fz > GRID_SAMPLES - 1) {
      return surface.sampleHeight(x, z);
    }
    const ix = Math.min(GRID_SAMPLES - 2, Math.floor(fx));
    const iz = Math.min(GRID_SAMPLES - 2, Math.floor(fz));
    const tx = fx - ix;
    const tz = fz - iz;
    const row = iz * GRID_SAMPLES + ix;
    const h00 = windowGrid[row]!;
    const h10 = windowGrid[row + 1]!;
    const h01 = windowGrid[row + GRID_SAMPLES]!;
    const h11 = windowGrid[row + GRID_SAMPLES + 1]!;
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  };

  const fieldSpan = tier === 'phone' ? GRASS_SPAN_PHONE : GRASS_SPAN_PROJECTION;
  const ensureFields = (): void => {
    if (grass && flowers) return;
    const phone = tier === 'phone';
    const look = cameraRig.lookAtPoint();
    bakeWindowGrid(look.x, look.z, fieldSpan);
    grass ??= createGrassField({
      count: phone ? GRASS_COUNT_PHONE : GRASS_COUNT_PROJECTION,
      span: fieldSpan,
      heightAt: windowHeightAt,
      region: ground.region(),
      // FULL by default (2026-09-15, user direction): the ghibli meadow is
      // envpaint's `fillMeadow` — grass everywhere the map says meadow,
      // thinning on the beach and the mountain and none in the sea — rather
      // than only where somebody has painted.
      baseDensity: 1,
      layers: { grass: paintedLayers.grass, comb: paintedLayers.comb },
    });
    flowers ??= createFlowerField({
      count: phone ? FLOWER_COUNT_PHONE : FLOWER_COUNT_PROJECTION,
      span: phone ? FLOWER_SPAN_PHONE : FLOWER_SPAN_PROJECTION,
      heightAt: windowHeightAt,
      region: ground.region(),
      // A bloom wants meadow under it (`uNeedGrass`), so it reads the grass
      // weight as well as its own.
      layers: { flowers: paintedLayers.flowers, grass: paintedLayers.grass },
    });
    grass.setCenter(look.x, look.z, windowHeightAt);
    flowers.setCenter(look.x, look.z, windowHeightAt);
    scene.add(grass.mesh, flowers.mesh);
  };
  /** Slide the window onto the look-target, re-baking the height grid under
   * it — the once-in-a-while call, keyed on the camera having actually gone
   * somewhere (see `WINDOW_QUANTUM`). */
  const reseatFields = (x: number, z: number): void => {
    if (!grass || !flowers) return;
    bakeWindowGrid(x, z, fieldSpan);
    grass.setCenter(x, z, windowHeightAt);
    flowers.setCenter(x, z, windowHeightAt);
  };
  /** Re-bake every blade's and bloom's ground height. Runs wherever
   * `ground.rebuild()` does — the ground moved, so the field standing on it
   * did too. */
  const rebuildFields = (): void => {
    if (grass) {
      // The ground moved under the window, so its height grid is stale before
      // a single blade is re-seated.
      const at = grass.center();
      bakeWindowGrid(at.x, at.z, fieldSpan);
    }
    grass?.rebuild(windowHeightAt);
    flowers?.rebuild(windowHeightAt);
    // `ground.rebuild()` re-bakes the region texture IN PLACE, so both fields
    // are already holding the new one — but a field built before the first
    // bake is holding null, so this is also where it arrives.
    const region = ground.region();
    grass?.setRegion(region);
    flowers?.setRegion(region);
  };

  // ── the look ──────────────────────────────────────────────────────────────
  /** The ghibli stamp value: the meadow under its own cool shadow tint, the
   * one flat tone a cel shadow takes on that paper. Computed once. */
  const ghibliStamp = new Color(GHIBLI.meadow).multiply(new Color(...GHIBLI.shadowTint));
  let currentStyle: WorldStyle = 'ink';
  const applyStyle = (style: WorldStyle): void => {
    currentStyle = style;
    const ghibli = style === 'ghibli';
    // The paper, and the sky beyond it — still ONE field, still dipped in
    // value (never hue) at night by the environment engine, which keeps
    // scaling whatever base is current.
    backgroundBase.set(ghibli ? GHIBLI.background : SURFACE.ground);
    background.copy(backgroundBase).multiplyScalar(backgroundLumaScale);
    ground.material.color.set(ghibli ? GHIBLI.meadow : SURFACE.ground);
    ground.setInk(ghibli ? GHIBLI.dirtEdge : SURFACE.ink);
    // Light COLOURS only: environment.ts drives intensities and the key's
    // position and never touches these, so they stick for the whole session.
    lighting.key.color.set(ghibli ? GHIBLI.sun : WORLD.light);
    lighting.fill.color.set(ghibli ? GHIBLI.sky : WORLD.light);
    lighting.fill.groundColor.set(ghibli ? GHIBLI.hemiGround : WORLD.neutralMid);
    setToonEnabled(ghibli);
    ink.setStyle(style);
    // envpaint's pencil line over the cel materials: three dials, applied
    // AFTER `ink.setStyle` (which owns the quantize switch and the ink
    // colour). `ink` puts the shipped line back from the one copy of it.
    if (ghibli) applyGhibliPost(ink);
    else ink.setParams({ ...INK_DEFAULTS });
    scatter.setStyle(style);
    // The ground wears envpaint's terrain shader on this style, and bakes the
    // geography texture the fields below read — so it goes FIRST.
    ground.setStyle(style);
    if (ghibli) {
      ensureFields();
      rebuildFields();
      grass?.setLayers({ grass: paintedLayers.grass, comb: paintedLayers.comb });
      flowers?.setLayers({ flowers: paintedLayers.flowers, grass: paintedLayers.grass });
      ground.setPaintedGrass(paintedLayers.grass);
    }
    if (grass) grass.mesh.visible = ghibli;
    if (flowers) flowers.mesh.visible = ghibli;
    // Both stamp passes lerp paper → shadow as the sun's presence rises, so
    // both need the pair that belongs to the paper now underneath them. The
    // stamps stay one flat value cut sharp either way (TASTE §2.4).
    if (ghibli) {
      shadows.setPalette(GHIBLI.meadow, ghibliStamp);
      scatter.setShadowPalette(GHIBLI.meadow, ghibliStamp);
    } else {
      shadows.setPalette(SURFACE.ground, SURFACE.shadow);
      scatter.setShadowPalette(SURFACE.ground, SURFACE.shadow);
    }
    water.setStyle(style);
  };
  applyStyle(sanitizeStyle(opts.style));

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
    // The cel terminator follows the SAME key the stamps and the hatch do:
    // environment.update has just moved `lighting.key.position` along the sun
    // arc, so its normalized world position is the direction toward the sun.
    // Two colour copies and a normalize — no recompile, and inert while the
    // ink style has the toon switch at 0.
    setToonSun(
      toonSunDir.copy(lighting.key.position),
      lighting.key.color,
      lighting.fill.color,
    );
    shadows.setSun(sun.azimuth, sun.altitude, sun.presence);
    scatter.setSun(sun.azimuth, sun.altitude, sun.presence);
    // Weather-driven vertex wind: the environment's spring-glided strength
    // into the scatter's shared wind uniforms (three value writes).
    scatter.setWind(environment.state.wind, nowMs);
    // …and the same field into every ghibli element that owns its own copy of
    // the wind uniforms: the blades, the blooms and the water surfaces. One
    // weather in the frame, never two (src/world/wind.ts). All no-ops until
    // the ghibli style has been switched on once.
    if (currentStyle === 'ghibli') {
      const field = scatter.windField();
      grass?.setWind(field, nowMs);
      flowers?.setWind(field, nowMs);
      // envpaint's distance collapse: zoomed out a blade is a pixel wide, so
      // the field flattens toward one painted green rather than speckling.
      const halfHeight =
        (cameraRig.camera.top - cameraRig.camera.bottom) / 2 / Math.max(0.01, cameraRig.camera.zoom);
      grass?.setZoom(halfHeight);
      flowers?.setZoom(halfHeight);
      // …and the window follows the eye, on its quantum.
      if (grass) {
        const look = cameraRig.lookAtPoint();
        const at = grass.center();
        if (Math.hypot(look.x - at.x, look.z - at.z) > WINDOW_QUANTUM) {
          reseatFields(look.x, look.z);
        }
      }
    }
    water.setWind(scatter.windField(), nowMs);
    for (const callback of frameCallbacks) callback(dt, nowMs);
    // AFTER the frame callbacks (creatures step in there, and a creature
    // pushing a stone has to be resolved in the same frame it moved) and
    // BEFORE the render, so a rock's body transform is in its instance
    // matrix by the time the matrix is drawn.
    if (bodies) {
      const version = scatter.rebuildVersion();
      if (version !== seenVersion) {
        seenVersion = version;
        bodies.sync();
      }
      bodies.update(dt, nowMs);
    }
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
      rebuildFields();
      scatter.refreshTerrain();
      water.refreshLevels();
      // The ground moved under every body: the heightfield collider is
      // resampled from the seam, throttled, on a later step.
      physics?.requestTerrainRebuild();
    },
    terrain: (): TerrainParams => terrainParams(),
    setLandscape: (on: boolean): void => {
      setLandscapeMode(on ? 'landscape' : 'plain');
      // The coast moved, so the geography bake did too — `ground.rebuild()`
      // re-bakes it in place and `rebuildFields` re-seats every blade on the
      // new ground.
      ground.rebuild();
      rebuildFields();
      scatter.refreshLandscape();
      // The levels move with the mode — a basin sits under the plain's zero —
      // so the sheets are re-seated before they are shown.
      water.refreshLevels();
      water.setVisible(on);
      physics?.requestTerrainRebuild();
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
    setPaintedScorch: (texture: Texture | null): void => {
      ground.setPaintedScorch(texture);
    },
    setPaintedLayers: (layers: {
      grass?: Texture | null;
      flowers?: Texture | null;
      comb?: Texture | null;
    }): void => {
      // The buffers are the painted map's own — shared, never copied — so
      // this is handed over once and every later dab is visible with nothing
      // in between (src/world/painted.ts).
      if ('grass' in layers) paintedLayers.grass = layers.grass ?? null;
      if ('flowers' in layers) paintedLayers.flowers = layers.flowers ?? null;
      if ('comb' in layers) paintedLayers.comb = layers.comb ?? null;
      grass?.setLayers({ grass: paintedLayers.grass, comb: paintedLayers.comb });
      flowers?.setLayers({ flowers: paintedLayers.flowers, grass: paintedLayers.grass });
      ground.setPaintedGrass(paintedLayers.grass);
    },
    landscape: (): boolean => landscapeMode() === 'landscape',
    setSoloDrag: (enabled: boolean): void => {
      soloDrag = enabled;
    },
    tier,
    physics: (): PhysicsWorld | null => physics,
    bodies: (): PropBodies | null => bodies,
    enablePhysics,
    onPhysicsReady: (callback: (p: PhysicsWorld, b: PropBodies) => void): void => {
      if (physics && bodies) callback(physics, bodies);
      else physicsReady.push(callback);
    },
    onFrame: (callback: FrameCallback): void => {
      frameCallbacks.push(callback);
    },
    setStyle: (style: WorldStyle): void => {
      applyStyle(sanitizeStyle(style));
    },
    style: (): WorldStyle => currentStyle,
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
