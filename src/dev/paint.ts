/**
 * `refworld.paint` — sculpt the terrain by hand, in the dev surface only
 * (PLAN §7 "painted terrain (dev)", PLAN §10 for the panel itself).
 *
 * Meridian's geography is authored and fixed (src/world/landscape.ts); this
 * is the one way a person adds to it. The brush engine is EnvPaint's,
 * imported through its portable entry points (`envpaint/core` for the
 * layers, the brush and the undo stack, `envpaint/ui` for the tool strip) —
 * see envpaint docs/port-meridian.md, of which this file is steps 3 and 4:
 * the height tools, and water.
 *
 * WHY THIS FILE IS THE ONLY ONE THAT KNOWS ABOUT ENVPAINT: a stamp writes
 * into a plain float array, and src/world/painted.ts hands that same array's
 * samples to src/world/landscape.ts through `setPaintedHeight`. Nothing
 * downstream of the array imports a brush. This module is reached by a
 * dynamic import from initDevPanel, after its no-DOM bail, so `src/dev` stays
 * importable from node and the demo build never loads the engine at all.
 *
 * THE PAINT LAYER'S BUFFER *IS* THE MAP'S. `createPaintedMap` adopts
 * `layer.data` rather than copying it, so a stamp is visible to the next
 * height sample with nothing in between — no upload, no sync step, no second
 * copy to keep in step. What a rebuild is for is the MESH: the ground field
 * has to re-displace, the scatter re-seat and the water re-level, which is
 * exactly `WorldHandles.setTerrain({})`.
 *
 * HOW A WATER STROKE FLOWS, and why it ends somewhere else than a height
 * one. The pond tool writes an absolute surface LEVEL into a second layer
 * whose buffer is `PaintedMap.water`, exactly as the height tools write the
 * first. That layer is a field of numbers and nothing more: what it MEANS —
 * where one body ends and the next begins, where its shoreline runs — is
 * src/world/painted-water.ts's `deriveWater`, and it is re-derived after
 * every change. The result goes three places in one breath:
 *
 *   layer → deriveWater(map) → setPaintedWater(field)   (the geography: the
 *                                                        basin, the reeds'
 *                                                        shore, the colliders)
 *                            → water.setPainted(field)  (the drawing: fill,
 *                                                        ink shoreline, ripples)
 *                            → rebuildLandscape()
 *
 * …and the rebuild is the LANDSCAPE one (ground → scatter.refreshLandscape →
 * water levels), not the terrain one a height stroke ends with [D]. A height
 * stroke moves ground that things already stand on, and re-seating them is
 * `refreshTerrain`. A pond changes WHAT GROWS WHERE: `place()` refuses water,
 * so every tree inside the new shore has to go, and the reed walk has a new
 * shoreline to line. That is a re-roll of the placement, which is exactly
 * what `refreshLandscape` is — and `setLandscape(landscape())`, the mode
 * re-applied unchanged, is the handle that does all three in order.
 *
 * EVERY DAB IS RECORDED. The `paint` session event of step 6 is wired: one
 * event per dab, through each tool's `onStamp` (docs/SESSION.md §paint),
 * plus one for the tap that clears the map. A water dab carries its stroke's
 * LEVEL as well [D] — a replay must lay the same plane, and re-deriving one
 * from `bankHeight` at replay time would read a bank that later strokes may
 * have moved. `PaintProbe.applyPaint` is the seam a replay comes back
 * through, and a replayed water dab travels the same layer → derive →
 * rebuild path a live one does.
 *
 * THE BRUSH KIT (2026-09-09, user ask: *"in the collection we should have
 * brushes for trees, rocks, grass, flowers, rivers, clouds, ponds, etc."*).
 * Seven planting brushes stand beside the height tools and the water ones,
 * each writing its own weight layer whose buffer IS the painted map's
 * (src/world/painted.ts `planting`), read by scatter's per-cell roll through
 * `setPaintedPlanting`.
 *
 * THREE STROKES, THREE REBUILDS [D]. A height stroke moves ground things
 * already stand on: `rebuildTerrain`. A water stroke changes what grows
 * where: the landscape re-cut above. A PLANTING stroke moves no vertex and
 * no water level at all — it only changes what the roll answers — so it
 * re-rolls the scatter and nothing else (`rebuildScatter`, measured ~31-39ms
 * against ~65-78ms for the terrain one on the plain field). The strongest
 * kind a coalesced burst contains is the one the burst pays for.
 *
 * WHAT IS NOT HERE YET (envpaint docs/port-meridian.md §5): of step 6, "save
 * map" and the build-time bake. There is no "save map" action to record;
 * when there is one, it records here.
 */

import type { Camera, Object3D, Scene, WebGLRenderer } from 'three';
import { Raycaster, Vector2, Vector3 } from 'three';
import type { GhostFolder, GhostPanelUi } from 'ghost-panel';
import type { BrushHit, EdgeShape, StampMode, StampOp, Tool } from 'envpaint/core';
import {
  bankHeight,
  Brush,
  History,
  isTyping,
  PaintLayer,
  PaintLayers,
  writeLevelDisc,
  DRY as WATER_DRY,
} from 'envpaint/core';
import { createToolStrip, type ToolStrip } from 'envpaint/ui';
import { SURFACE } from '../taste/tokens';
import {
  paintedWater,
  setPaintedHeight,
  setPaintedPlanting,
  setPaintedWater,
  TERRAIN,
} from '../world/landscape';
import {
  clearPaintedMap,
  createPaintedMap,
  paintedRange,
  paintedSampler,
  plantingSampler,
  sampleHeight,
  samplePlanting,
  DRY,
  PAINTED_RES,
  PAINTED_SIZE,
  PLANT_BRUSHES,
  PLANTING_RES,
  type PlantBrush,
} from '../world/painted';
import {
  clampRadius,
  HEIGHT_LAYER,
  HEIGHT_TOOL_IDS,
  invertStampMode,
  isPlantTool,
  layerForTool,
  RADIUS_DEFAULT,
  RADIUS_MAX,
  RADIUS_MIN,
  steppedRadius,
} from './paint-tools';
import { deriveWater, type PaintedWaterField } from '../world/painted-water';
import type { PaintEvent, SessionRecorder } from '../session';
import type { DevSkillMeta } from './skills-meta';

/** The absolute water surface level in world units, `DRY` where none — the
 * layer the pond and drain tools write. Its buffer is `PaintedMap.water`. */
const WATER_LAYER = 'water';

/**
 * The ground reference `writeLevelDisc` measures its depth cap against: a
 * full-length field of zeros, allocated once.
 *
 * [D] It is not a depth reference at all here, and the zeros are not a lie
 * about the terrain. `writeLevelDisc` caps each texel's level at `ground[i] +
 * maxDepth * (…)`; with the default `maxDepth = Infinity` that cap is `0 +
 * Infinity` and can never bind, so the level a stroke writes is exactly the
 * one it asked for. The array still has to EXIST and be full length, because
 * an out-of-range read would make the cap `undefined + Infinity` — NaN — and
 * `target < NaN` is false, so every texel would silently keep its old value
 * and the brush would appear to paint nothing at all.
 *
 * The basin under a painted pond is not cut here in the first place: the
 * geography cuts it from the level, on the fly, with the authored shore-ramp
 * maths (src/world/landscape.ts `terrainHeight`). This module writes a
 * waterline; the ground answers for it.
 */
const FLAT_GROUND = new Float32Array(PAINTED_RES * PAINTED_RES);

/**
 * [D] Shortest gap between two terrain rebuilds during a stroke, ms — ~8 a
 * second, the throttle the port plan asked for.
 *
 * A rebuild is `setTerrain({})`: re-displace 103k ground vertices through
 * `terrainHeight`, re-normal them, re-seat every scattered instance, re-level
 * every water body. Measured in a headless chromium on this branch it runs
 * ~250-330ms, so one per stamp is not a slow stroke, it is no stroke at all
 * — the pointer would be a rebuild behind at all times. At 8 a second the
 * hill grows in visible increments while the stamps keep landing at full
 * rate, and `strokeend` always rebuilds once more, so what is on screen when
 * the pointer lifts is exactly what is in the map.
 *
 * A trailing timer, not a leading one, for the same reason the terrain dials
 * have one (src/dev/index.ts): the last stamp of a burst must land.
 */
const REBUILD_MIN_MS = 125;

/**
 * [D] The strength a fresh panel opens on — EnvPaint's own panel reads 0.28
 * (2026-09-10, user ask), and the radius beside it is `RADIUS_DEFAULT`.
 */
const STRENGTH_DEFAULT = 0.28;

/**
 * [D] What one unit of brush strength is worth to a PLANTING layer, ×7.
 *
 * This is the bug behind "the brush tools aren't working". A height dab
 * writes WORLD UNITS — 0.07 of a unit a dab is a hill you watch grow — but a
 * planting dab writes a WEIGHT in [0,1] that `scatter.ts` multiplies by a
 * per-kind seed of its own (PAINT_SEED grove tree = 0.3). At the engine's
 * own scale a whole pass left ~0.13 weight, so the strongest thing the trees
 * brush could ask for was 0.13 × 0.3 ≈ a 4% chance per cell — over a 3 u
 * radius, which is half a scatter cell, that is a stroke that plants
 * nothing and looks like a dead tool.
 *
 * ×7 puts one pass at ~0.6-1.0, which is what the label promises: paint
 * trees, get a stand. The layers are still clamped to [0,1] as they are
 * stamped (`clampPlantLayer`), so this buys saturation, never overflow, and
 * `strengthScale` is EnvPaint's own tool field — the scaled strength is what
 * lands in `op.strength`, so a RECORDED dab carries it and a replay needs to
 * know nothing about this number.
 */
const PLANT_STRENGTH_SCALE = 7;

/** Hotkeys 1-6, in strip order: the four height tools, then pond and drain.
 * The seven PLANTING brushes get none — 7 more digits would take the whole
 * keyboard row off the operator, and 5-7 already emote — so the strip is
 * what selects them (2026-09-09, user ask). */
const TOOL_KEYS = ['1', '2', '3', '4', '5', '6'] as const;

/** The radius keys. EnvPaint binds these itself, but its handler clamps at
 * 12 units — past that the keys would simply stop working in a 400-unit
 * world — so this module intercepts them and steps through its own range. */
const RADIUS_KEYS = { down: '[', up: ']' } as const;

/** What the paint skill needs from the world. Structural, like every other
 * handle in src/dev/, so this module never imports src/world/scene.ts. */
export interface PaintHandles {
  scene: Scene;
  camera: Camera;
  /** The brush binds its pointer listeners to `renderer.domElement`. */
  renderer: WebGLRenderer;
  /** Ground height at (x, z) — the Surface seam, for the cursor's resting
   * place. Nothing here derives a height of its own. */
  sampleHeight(x: number, z: number): number;
  /** Rebuild ground → scatter → water: `WorldHandles.setTerrain({})`. */
  rebuildTerrain(): void;
  /**
   * Re-roll and rebuild the SCATTER alone (`WorldHandles.refreshScatter`) —
   * what a planting stroke needs and all it needs. Optional: without it a
   * planting stroke falls back to the full terrain rebuild, which is correct
   * but ~10× the cost.
   */
  rebuildScatter?(): void;
  /**
   * Re-cut the world for a placement that has CHANGED, not just moved:
   * ground → `scatter.refreshLandscape()` → water levels. What a water stroke
   * ends with, for the reason the header gives — a pond decides what grows
   * where, and re-seating the existing trees is not enough.
   */
  rebuildLandscape(): void;
  /** Hand the painted water field to the renderer (`water.setPainted`). The
   * geography gets its own copy through `setPaintedWater` in landscape.ts;
   * this is the drawing half. */
  setPaintedWater(field: PaintedWaterField | null): void;
  /** The terrain dials in force (`WorldHandles.terrain()`). A pond chooses
   * its level with `basinDrop` at the dials the painter is looking at. */
  terrain(): { elevation: number; tierStep: number; relief: number };
  /** Register per-frame work (the undo stack's dirty-rect sweep). */
  onFrame(callback: (dt: number, nowMs: number) => void): void;
  /** Park the world's own one-pointer drag while a stroke owns the pointer
   * (`WorldHandles.setSoloDrag`). Optional: without it painting still works,
   * it just orbits the camera at the same time. */
  setSoloDrag?(enabled: boolean): void;
  /** The presentation tour. Painting takes the camera off it — a stroke
   * cannot land where the ground is sliding out from under it. */
  tour?: { setMode(mode: 'manual' | 'tour'): void; mode(): 'manual' | 'tour' };
  /**
   * The world's session recorder, narrowed to the one method this skill
   * uses (src/session/, docs/SESSION.md). Absent in a build with no
   * recorder wired, and then the brush simply paints unrecorded — a dev
   * tool must never fail because the log is missing.
   */
  session?: Pick<SessionRecorder, 'paint'>;
}

/** Live handles the headless paint smoke drives (scratch/paint-smoke.mjs),
 * in the same spirit as `__refworldWater` and friends in src/world/scene.ts.
 * Dev-only: this whole module is behind initDevPanel's dynamic import. */
export interface PaintProbe {
  brush: unknown;
  /** Turn painting on or off, exactly as the panel checkbox does. */
  setPainting(on: boolean): void;
  /** The painted offset at a world point. */
  sampleAt(x: number, z: number): number;
  /** One brush's planting weight at a world point, [0,1]. */
  plantingAt(brush: PlantBrush, x: number, z: number): number;
  /** Lowest and highest painted offset in the map. */
  range(): { min: number; max: number };
  /** The painted LEVEL in the texel covering a world point — the layer as it
   * stands, `DRY` where nothing is painted. Not bilinear: this is the array,
   * for a smoke that wants to know what the brush wrote. */
  waterAt(x: number, z: number): number;
  /** Signed distance to the nearest painted shore of the INSTALLED field,
   * positive in water; `-Infinity` when no field is installed. */
  shoreAt(x: number, z: number): number;
  /** How many painted bodies the world is currently holding. */
  bodies(): number;
  /** Force the world to re-cut itself now. */
  rebuild(): void;
  /**
   * Re-apply one recorded `paint` event — the replay seam
   * (src/main.ts `replayDriver.paint`, docs/SESSION.md §4). Dabs land
   * through the same layer stamp a live one does and rebuild on the same
   * throttle, so a replayed stroke grows the hill the way the stroke did.
   */
  applyPaint(event: PaintEvent): void;
  /**
   * Re-apply MANY recorded dabs and re-cut the ground once.
   *
   * Not a convenience wrapper: `applyPaint` rebuilds on the stroke throttle,
   * and a rebuild is ~300ms of re-displacing 103k vertices. The throttle
   * measures from the START of a rebuild, so a tight loop of stamps clears
   * the 125ms gap every single time and pays for a full re-cut per dab —
   * a phone loading a stored scene of five hundred dabs would sit there for
   * two minutes. The scene layer (src/main.ts) arrives in batches by nature,
   * so it stamps a batch and re-cuts once.
   */
  applyPaintBatch(events: readonly PaintEvent[]): void;
}

/**
 * Fired on `window` the moment the probe above is installed.
 *
 * The paint skill arrives by dynamic import behind the ghost panel, so on any
 * page there is a window — a second or two — where a stored or broadcast dab
 * has nowhere to land. The scene loader queues those and waits for this
 * rather than polling or dropping them, so painting shows up on a phone whose
 * owner never opens the panel (2026-09-09, the demo plan).
 */
export const PAINT_READY_EVENT = 'refworld:paint-ready';

/**
 * Register `refworld.paint` on a ghost panel.
 *
 * Everything is built in `apply` and torn down in `teardown`, like the other
 * refworld skills, so removing the skill really does put the world back: the
 * painted sampler is uninstalled, the map goes with it, and the terrain is
 * rebuilt one last time as the authored one.
 */
export function registerPaintSkill(
  ui: GhostPanelUi,
  meta: DevSkillMeta,
  handles: PaintHandles,
): void {
  ui.skills.register({
    ...meta,
    apply: (panelUi) => applyPaintSkill(panelUi, handles),
    teardown: (panelUi, handle) => {
      (handle as { dispose?(): void } | undefined)?.dispose?.();
      panelUi.panel.removeFolder('paint');
    },
  });
}

interface PaintSkillHandle {
  folder: GhostFolder;
  dispose(): void;
}

function applyPaintSkill(panelUi: GhostPanelUi, handles: PaintHandles): PaintSkillHandle {
  /** Everything this skill installs on the world, unwound in reverse on
   * teardown — the panel can remove a skill and put the world back. */
  const disposers: (() => void)[] = [];

  // The one duplicated constant in the port, checked where the duplication
  // is: src/world/painted.ts re-declares `DRY` rather than importing it, so
  // that the pure world code pulls in no brush engine, and this module — the
  // only one that sees both — is where the two are made to agree. A drift
  // would be silent everywhere else: the level layer is EnvPaint's buffer, so
  // a texel it drained would read as a surface 1000 units under the map.
  if (WATER_DRY !== DRY) {
    throw new Error(`painted water: envpaint DRY is ${WATER_DRY}, the world's is ${DRY}`);
  }

  // ── the map, and the two layers that share its buffers ────────────────────
  const layers = new PaintLayers();
  const heightLayer = layers.add(
    new PaintLayer(HEIGHT_LAYER, {
      channels: 1,
      float: true,
      initial: 0,
      res: PAINTED_RES,
    }),
  );
  // Same shape, same resolution, one channel of absolute world height — and
  // `initial: DRY`, so an unpainted map is DRY everywhere rather than flooded
  // at height 0 (the layer fills itself at construction).
  const waterLayer = layers.add(
    new PaintLayer(WATER_LAYER, {
      channels: 1,
      float: true,
      initial: DRY,
      res: PAINTED_RES,
    }),
  );
  // One float layer per planting brush, at the planting resolution. Their
  // buffers become the map's, exactly as the height and water layers' do — a
  // dab is visible to the next placement roll with no upload and no copy.
  const plantLayers = {} as Record<PlantBrush, PaintLayer>;
  const plantData: Partial<Record<PlantBrush, Float32Array>> = {};
  for (const brush of PLANT_BRUSHES) {
    const l = layers.add(
      new PaintLayer(brush, { channels: 1, float: true, initial: 0, res: PLANTING_RES }),
    );
    plantLayers[brush] = l;
    plantData[brush] = l.data as Float32Array;
  }
  const map = createPaintedMap(
    PAINTED_RES,
    PAINTED_SIZE,
    heightLayer.data as Float32Array,
    waterLayer.data as Float32Array,
    plantData,
    PLANTING_RES,
  );
  // From here on the world's heights carry whatever is in that array. With an
  // unpainted map that is the authored world exactly (test/world/painted.test.ts).
  setPaintedHeight(paintedSampler(map));
  // …and the scatter's per-cell roll carries whatever is in the planting
  // ones. All zero until somebody paints, which is the shipped world exactly
  // (test/world/scatter-planting.test.ts).
  setPaintedPlanting(plantingSampler(map));

  // ── undo ──────────────────────────────────────────────────────────────────
  // EnvPaint's History wraps each stroke in one entry and, once handed the
  // panel, pushes those entries onto ghost-panel's own stack — so ctrl+z in
  // the world undoes a stroke through the same keybinding that undoes a
  // gizmo drag, and there are never two stacks answering the same key.
  const history = new History({ layers, elements: new Map() });
  history.attachUI(panelUi);
  disposers.push(() => history.dispose());

  // ── picking, and where a pointer-less preview sits ────────────────────────
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const eye = new Vector3();
  const forward = new Vector3();

  /** The ground group scene.ts added (src/world/ground.ts names it). */
  const groundGroup = (): Object3D | undefined => handles.scene.getObjectByName('ground');

  const uvOf = (x: number, z: number): { u: number; v: number } => ({
    u: x / PAINTED_SIZE + 0.5,
    v: z / PAINTED_SIZE + 0.5,
  });

  /**
   * The painted LEVEL in the texel covering (x, z), `DRY` off the map.
   *
   * NEAREST, not bilinear, and deliberately so: there is no such thing as
   * "half a water level". Between a wet texel and a dry one a bilinear read
   * would return some number 500 units under the map, which is neither a
   * surface nor a sentinel. What is continuous across a shoreline is the
   * distance field (`PaintedWaterField.shore`), and that is what the world
   * reads; this is the array, for the probe.
   */
  const levelAt = (x: number, z: number): number => {
    const { u, v } = uvOf(x, z);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return DRY;
    const tx = Math.min(PAINTED_RES - 1, Math.floor(u * PAINTED_RES));
    const ty = Math.min(PAINTED_RES - 1, Math.floor(v * PAINTED_RES));
    return map.water[ty * PAINTED_RES + tx] ?? DRY;
  };

  /**
   * Pointer → ground hit, by raycast against the displaced field itself
   * rather than against the y = 0 plane: on a terraced map the two are
   * several units apart on a riser, and a brush that lands where the plane
   * says would drift downhill of the cursor at every zoom.
   */
  const pick = (event: PointerEvent): BrushHit | null => {
    const ground = groundGroup();
    if (!ground) return null;
    const canvas = handles.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, handles.camera);
    const hit = raycaster.intersectObject(ground, true)[0];
    if (!hit) return null;
    const p = hit.point;
    return { x: p.x, y: p.y, z: p.z, ...uvOf(p.x, p.z) };
  };

  /**
   * Where the radius preview sits when the pointer is not over the ground:
   * the camera's look target, which for a rig that always looks at the world
   * is where its forward ray meets the ground plane — then lifted onto the
   * Surface, because nothing here derives a height of its own.
   */
  const centre = (): { x: number; y: number; z: number } | null => {
    handles.camera.getWorldPosition(eye);
    handles.camera.getWorldDirection(forward);
    if (forward.y >= -1e-6) return null;
    const t = -eye.y / forward.y;
    if (!Number.isFinite(t) || t <= 0) return null;
    const x = eye.x + forward.x * t;
    const z = eye.z + forward.z * t;
    return { x, y: handles.sampleHeight(x, z), z };
  };

  // ── the brush ─────────────────────────────────────────────────────────────
  let painting = false;

  const brush = new Brush(
    {
      renderer: handles.renderer,
      scene: handles.scene,
      camera: handles.camera,
      layers,
      history,
    },
    {
      // Meridian's field, not EnvPaint's 48: one texel is 0.78 units.
      worldSize: PAINTED_SIZE,
      pick,
      centre,
      // The world's own gestures keep working when painting is off. With it
      // on, three things still reach the camera instead of the ground
      // (2026-09-09, user ask — shift is now the INVERT modifier, so the
      // camera escape had to move off it):
      //
      //   space+drag        EnvPaint's own convention, and the only one that
      //                     works with a trackpad and no second button.
      //   secondary button  right / middle drag.
      //   two fingers       already true, and not through this predicate:
      //                     the world's pinch/twist path ignores soloDrag
      //                     entirely (src/world/scene.ts), so a second
      //                     finger has always reached the camera. The
      //                     `isPrimary` test below keeps the second finger
      //                     from also painting on its way there.
      canPaint: (event: PointerEvent): boolean =>
        painting && !spaceHeld && event.button === 0 && event.isPrimary,
    },
  );
  // Off until the checkbox says otherwise: `enabled: false` also stops the
  // per-pointermove raycast against 205k triangles, which is the reason this
  // flag and `canPaint` are BOTH wired rather than either alone.
  brush.enabled = false;
  brush.settings.radius = RADIUS_DEFAULT;
  // EnvPaint ships 0.26 and a radius of 1.0; the user's own panel reads 0.28
  // and 3.0, and those are the numbers this world opens on. The `strength`
  // slider below reads this field for its opening value, so the two cannot
  // disagree about what a fresh brush is.
  brush.settings.strength = STRENGTH_DEFAULT;
  disposers.push(() => brush.dispose());

  /** The radius, past EnvPaint's own 0.3-12 clamp — see RADIUS_MAX. */
  const setRadius = (r: number): void => {
    brush.settings.radius = clampRadius(r);
    brush.flashRadius();
  };

  /** One press of `[` / `]`: step the radius through THIS world's range and
   * put the panel's slider where the keys left it, so the two controls can
   * never disagree about what the brush is. */
  const stepRadius = (direction: -1 | 1): void => {
    const next = steppedRadius(brush.settings.radius, direction);
    setRadius(next);
    folder?.get('paint-radius')?.setValue?.(next);
  };

  // ── tools ─────────────────────────────────────────────────────────────────
  // Four on the height layer, two on the water one. The edge shape is
  // EnvPaint's own default (SHAPE_DEFAULTS: edgeNoise 0.35, edgeScale 3,
  // spatter 0.25) and stays that way — TASTE §2.5 has no clean discs on this
  // map, and a brush whose rim is a circle draws one every stamp.
  //
  // `flatten` carries an onStamp [D]: the engine's flatten pulls a texel
  // toward `op.flattenTo`, which the Brush does not set, so it would default
  // to 0 — "flatten" would mean "erase back to the authored land". The
  // target is instead the painted height under the first hit of the stroke,
  // which is what the label promises: level this ground to where I started.
  let flattenTo = 0;

  /**
   * ── session hook (envpaint docs/port-meridian.md §5 step 6) ──────────────
   *
   * ONE `paint` event per STAMP, which is why every tool carries an
   * `onStamp` now: the Brush emits `stroke` once per batch of dabs, so the
   * stroke event never knew where the dabs were — the per-dab op does, and
   * `onStamp` is the only place it is handed out.
   *
   * The dab is recorded in WORLD units (x, z, r), the space `egg` already
   * records in, converted from the brush's uv here at the seam rather than
   * leaving a second coordinate system in the log. `mode` rather than the
   * tool alone, because a tool erases with ctrl and smooths with alt and
   * the label would not say what the dab did. `seed` because every dab
   * randomises its own rim, and a replayed stroke with a different rim is a
   * different stroke.
   *
   * `level` is the water tools' one extra field [D]: a pond dab fills to a
   * plane the stroke chose from the bank around its first dab, and by the
   * time a log is replayed that bank may have been painted over. Recording
   * the number is four bytes a dab against a pond that comes back at the
   * wrong height.
   *
   * NOT recorded: the four rim-shape settings (edgeNoise, edgeScale,
   * spatter, aspect). They are brush state, identical across every dab of a
   * stroke, and a replay reads them off the brush it is stamping through
   * (`applyPaint` below) — four numbers a dab, thousands of dabs, to say
   * the same thing the panel already says.
   */
  /**
   * Shift, live. Tracked on the window rather than read off the pointer
   * event because `onStamp` is handed an op, not an event — and updated from
   * pointer events too, so a key pressed while the window was unfocused
   * cannot leave the flag stale mid-stroke.
   */
  let shiftHeld = false;
  /** Space, live — the camera escape while painting is on (see canPaint). */
  let spaceHeld = false;

  const recordStamp = (tool: string, op: StampOp, level?: number): void => {
    handles.session?.paint({
      tool,
      x: (op.u - 0.5) * PAINTED_SIZE,
      z: (op.v - 0.5) * PAINTED_SIZE,
      r: op.radius * PAINTED_SIZE,
      ...(op.strength === undefined ? {} : { strength: op.strength }),
      ...(op.hardness === undefined ? {} : { hardness: op.hardness }),
      ...(op.mode === undefined ? {} : { mode: op.mode }),
      ...(op.seed === undefined ? {} : { seed: op.seed }),
      ...(op.mode === 'flatten' ? { flattenTo } : {}),
      ...(level === undefined ? {} : { level }),
    });
  };

  /**
   * Planting weights live in [0,1] and the layers are float (unclamped, like
   * the height one), so the clamp is ours to apply — over the layer's dirty
   * rect, which is a superset of what this dab touched and is cleared by the
   * frame's `commitAll`. Without it a held brush would drive a weight to 4
   * and the roll would saturate, which is a probability nobody can paint
   * back down.
   */
  const clampPlantLayer = (l: PaintLayer): void => {
    const rect = l.dirtyRect;
    if (!rect) return;
    const data = l.data as Float32Array;
    for (let y = rect.y0; y <= rect.y1; y++) {
      const row = y * l.res;
      for (let x = rect.x0; x <= rect.x1; x++) {
        const i = row + x;
        const v = data[i]!;
        if (v < 0) data[i] = 0;
        else if (v > 1) data[i] = 1;
      }
    }
  };

  /** Stamp one dab into the layer a tool id owns, clamping the planting
   * layers as it goes. The ONE place a tool id turns into a layer, shared by
   * the live brush and by `applyPaint` — a replayed stamp must land where
   * the live one did (docs/SESSION.md §4). */
  const stampInto = (tool: string, op: StampOp): void => {
    const layerId = layerForTool(tool);
    if (!layerId) return;
    const target = layers.get(layerId);
    if (!target) return;
    target.stamp(op.mode === 'flatten' ? { ...op, flattenTo } : op);
    if (isPlantTool(tool)) clampPlantLayer(target);
  };

  /**
   * A height or planting tool that records its dab and then stamps it.
   * `flatten` also carries the target the stroke is levelling toward — see
   * the note above. The layer is on the descriptor rather than added at
   * registration, because the water tools below write a different one.
   *
   * SHIFT INVERTS (2026-09-09, user ask): raise ↔ lower, add ↔ erase, and
   * smooth / flatten untouched — the inversion is applied HERE, before the
   * recording, so the session event says what the dab actually did rather
   * than which tool was selected. A replayed or synced stamp then lands the
   * same result without knowing anything about a modifier key.
   */
  const recorded = (id: string, rest: Omit<Tool, 'id' | 'label' | 'onStamp'>): Tool => ({
    layer: HEIGHT_LAYER,
    ...rest,
    id,
    label: id,
    onStamp: (_ctx: unknown, op: StampOp): void => {
      const mode = shiftHeld
        ? (invertStampMode(op.mode ?? rest.mode ?? 'add') as StampMode)
        : op.mode;
      const dab: StampOp =
        mode === undefined || mode === op.mode ? op : { ...op, mode: mode as StampMode };
      recordStamp(id, dab);
      stampInto(id, dab);
    },
  });

  /**
   * The surface height every dab of the CURRENT pond stroke fills to, or null
   * between strokes.
   *
   * One number a stroke, never one a dab: a body of water is a PLANE (the
   * contract's third convention), and a level read fresh under each dab would
   * paint a sheet that tilts with the ground it crossed. `deriveWater` would
   * level it back to the lowest dab afterwards, so the visible result of
   * getting this wrong is a pond that quietly sinks as you draw it.
   */
  let strokeLevel: number | null = null;

  /**
   * The level a pond stroke starting at `hit` fills to.
   *
   * Two cases, and they are the same rule. Start INSIDE water that is already
   * painted and the stroke is an extension of that body, so it takes the
   * body's own plane — otherwise widening a pond by a brush width would paint
   * a second, higher sheet against its bank and `deriveWater` would merge the
   * two down to the lower one, undoing the older body's level.
   *
   * Start on dry land and the stroke chooses its level the way an AUTHORED
   * body chooses its own (`waterLevel` in landscape.ts): the ground it stands
   * on, `basinDrop` under it. The ground is `bankHeight`'s mean over a ring at
   * the brush radius rather than the single sample under the pointer — the
   * ring is untouched bank, and a stroke that has already cut a basin under
   * itself would otherwise ratchet its own level down dab after dab. And
   * `basinDrop` rides the `elevation` dial because the AUTHORED drop does:
   * somebody painting a pond next to the lake wants it to sit as deep as the
   * lake does at the dials in front of them. The level itself is then
   * absolute — no dial ever multiplies it again.
   */
  const strokeLevelAt = (hit: BrushHit): number => {
    const field = paintedWater();
    if (field && field.shore(hit.x, hit.z) > 0) return field.level(hit.x, hit.z);
    return (
      bankHeight(handles.sampleHeight, hit.x, hit.z, brush.settings.radius) -
      TERRAIN.basinDrop * handles.terrain().elevation
    );
  };

  /**
   * One dab of water: fill to the stroke's level, or drain to `DRY`.
   *
   * [D] `spatter: 0`, alone among the shape fields — the rim keeps its edge
   * noise, so no painted pond is a clean disc (TASTE §2.5), but the droplets
   * spatter throws are culled texel by texel by `deriveWater` (they land under
   * `MIN_BODY_TEXELS` and go straight back to `DRY`). A brush whose specks
   * vanish the instant the stroke is derived reads as the tool fighting
   * itself; better not to throw them.
   *
   * [D] The level is read here, at the first dab, and not on `strokestart`:
   * the Brush stamps once and THEN emits `strokestart` (envpaint
   * src/core/Brush.js `pointerdown`), so a level chosen in that handler would
   * miss the dab that opened the pond — and the last stroke's level would
   * write it instead.
   *
   * `record` is the tool id to log the dab under, or null on a REPLAY: a
   * replayed dab is already in the log it came out of, and recording it
   * again would double every stroke each time a session was played back.
   */
  const stampWater = (
    op: StampOp,
    hit: BrushHit,
    drain: boolean,
    record: string | null,
  ): void => {
    if (!drain && strokeLevel === null) strokeLevel = strokeLevelAt(hit);
    // After the level is chosen, so the event carries the plane this dab
    // actually filled to. A drain has no level to carry.
    if (record !== null) recordStamp(record, op, drain ? undefined : (strokeLevel ?? undefined));
    // The dab's own edge shape, field by field rather than spread [D]: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as
    // an absent key, and `makeFalloff` reads absent keys as its own defaults
    // (edgeScale 3, aspect 1, seed 0) — writing `undefined` through would be
    // a type error over a shape the engine already knows how to complete.
    const shape: EdgeShape = { spatter: 0 };
    if (op.edgeNoise !== undefined) shape.edgeNoise = op.edgeNoise;
    if (op.edgeScale !== undefined) shape.edgeScale = op.edgeScale;
    if (op.aspect !== undefined) shape.aspect = op.aspect;
    if (op.seed !== undefined) shape.seed = op.seed;
    if (op.dir !== undefined) shape.dir = op.dir;
    const rect = writeLevelDisc({
      level: waterLayer.data as Float32Array,
      ground: FLAT_GROUND,
      res: PAINTED_RES,
      u: op.u,
      v: op.v,
      radius: op.radius,
      ...(op.hardness === undefined ? {} : { hardness: op.hardness }),
      op: drain ? 'drain' : 'fill',
      target: strokeLevel ?? 0,
      shape,
    });
    // `writeLevelDisc` writes the array directly rather than going through
    // `layer.stamp`, so nothing has marked it: the rect it returns is what
    // tells the undo sweep and the rebuild below that water moved.
    if (rect) waterLayer.markDirtyRect(rect.x0, rect.y0, rect.x1, rect.y1);
  };

  const tools: Tool[] = [
    recorded(HEIGHT_TOOL_IDS[0], { key: TOOL_KEYS[0], mode: 'raise', eraseMode: 'lower' }),
    recorded(HEIGHT_TOOL_IDS[1], { key: TOOL_KEYS[1], mode: 'lower', eraseMode: 'raise' }),
    recorded(HEIGHT_TOOL_IDS[2], {
      key: TOOL_KEYS[2],
      mode: 'flatten',
      altMode: 'smooth',
      eraseMode: 'smooth',
    }),
    recorded(HEIGHT_TOOL_IDS[3], { key: TOOL_KEYS[3], mode: 'smooth', eraseMode: 'smooth' }),
    {
      // `mode: 'set'` because a level is a value and not an increment — the
      // engine's stamp modes are for byte layers, and this tool writes the
      // layer itself through `writeLevelDisc` anyway. Ctrl/cmd-drag erases,
      // which for water is a drain: the modifier means the same thing on
      // every tool in the strip.
      id: 'pond',
      label: 'pond',
      key: TOOL_KEYS[4],
      layer: WATER_LAYER,
      mode: 'set',
      eraseMode: 'erase',
      onStamp: (_ctx: unknown, op: StampOp, hit: BrushHit): void => {
        stampWater(op, hit, op.mode === 'erase', 'pond');
      },
    },
    {
      id: 'drain',
      label: 'drain',
      key: TOOL_KEYS[5],
      layer: WATER_LAYER,
      mode: 'erase',
      eraseMode: 'erase',
      onStamp: (_ctx: unknown, op: StampOp, hit: BrushHit): void => {
        stampWater(op, hit, true, 'drain');
      },
    },
  ];
  for (const tool of tools) {
    brush.registerTool({ color: SURFACE.ink, ...tool });
  }
  // ── the planting brushes ─────────────────────────────────────────────────
  // One tool per brush, each writing its own weight layer: stamp adds, ctrl
  // (or shift, which inverts) erases. No hotkey — the strip selects them.
  // Labels stay lowercase like every other string in this product (TASTE §5).
  const plantTools: Tool[] = PLANT_BRUSHES.map((id) =>
    recorded(id, { mode: 'add', eraseMode: 'erase' }),
  );
  for (const tool of plantTools) {
    // The layer a planting tool writes is named for the tool (paint-tools).
    brush.registerTool({
      ...tool,
      layer: tool.id,
      color: SURFACE.ink,
      // A weight in [0,1], not world units — see PLANT_STRENGTH_SCALE.
      strengthScale: PLANT_STRENGTH_SCALE,
    });
  }
  brush.setTool(HEIGHT_TOOL_IDS[0]);

  // ── the rebuild, throttled ────────────────────────────────────────────────
  let lastRebuildMs = 0;
  let pendingRebuild = 0;
  /**
   * What has moved since the last rebuild, one flag per rebuild kind. Sticky
   * rather than per-dab because the throttle coalesces a burst: the burst
   * pays for the STRONGEST kind any dab in it needed (see `rebuildNow`).
   */
  let terrainDirty = false;
  let plantingDirty = false;
  /** Set by the per-frame sweep when the water layer moved, cleared by the
   * derive that answers for it. A flag and not a read of `dirtyRect`, because
   * `commitAll` clears that rect on the frame it was set. */
  let waterDirty = false;

  const rebuildNow = (): void => {
    if (pendingRebuild) {
      window.clearTimeout(pendingRebuild);
      pendingRebuild = 0;
    }
    lastRebuildMs = performance.now();
    if (waterDirty || waterLayer.dirtyRect) {
      waterDirty = false;
      // The whole water path in four lines: what the layer means, then the
      // geography, then the drawing, then the world.
      //
      // `deriveWater` MUTATES `map.water` — it culls spatter back to `DRY`,
      // fills pinholes, and levels every texel of a body to that body's own
      // plane. That is deliberate (the layer a person paints and the layer the
      // world reads are one array, so the tidying has to be visible in the
      // paint), and it is safe for undo: History took its "before" of the
      // stroke's rect when the stroke began, and takes its "after" AFTER this
      // runs — the Brush emits `strokeend`, which rebuilds, and only then
      // calls `history.end()`. So an undo puts back the paint as it was, and
      // the derive that follows the undo tidies it again from there.
      const field = deriveWater(map);
      setPaintedWater(field);
      handles.setPaintedWater(field);
      handles.rebuildLandscape();
    } else if (terrainDirty || !handles.rebuildScatter) {
      handles.rebuildTerrain();
      // A burst can hold both kinds. The terrain rebuild re-SEATS the scatter
      // but never re-rolls it (`refreshTerrain`), so a planting dab in the
      // same burst still needs its own re-roll on top.
      if (plantingDirty) handles.rebuildScatter?.();
    } else {
      // Planting alone: no vertex moved and no level changed, so the ground
      // and the water sheets are left exactly where they are.
      handles.rebuildScatter();
    }
    terrainDirty = false;
    plantingDirty = false;
    refreshReadout();
  };

  const rebuildSoon = (): void => {
    const since = performance.now() - lastRebuildMs;
    if (since >= REBUILD_MIN_MS) {
      rebuildNow();
      return;
    }
    if (pendingRebuild) return;
    pendingRebuild = window.setTimeout(() => {
      pendingRebuild = 0;
      rebuildNow();
    }, REBUILD_MIN_MS - since);
  };
  disposers.push(() => {
    if (pendingRebuild) window.clearTimeout(pendingRebuild);
  });

  /**
   * Mark what this stroke's tool touches, then rebuild on the throttle.
   *
   * BOTH flags are real: a planting stroke has to raise `plantingDirty` the
   * same way a replayed dab does (`stampPaint`), or a burst that also moved
   * the ground takes the terrain path — which RE-SEATS the scatter without
   * re-ROLLING it — and the trees the brush just planted never appear.
   */
  const noteTool = (): void => {
    if (isPlantTool(brush.tool ?? '')) plantingDirty = true;
    else terrainDirty = true;
  };

  brush.on('strokestart', (payload) => {
    const hit = payload.hit;
    if (hit) flattenTo = sampleHeight(map, hit.x, hit.z);
    noteTool();
    rebuildSoon();
  });
  brush.on('stroke', () => {
    // The session event is NOT here: `stroke` fires once per batch of dabs
    // and carries no op, so it cannot say where anything landed. It is on
    // each tool's `onStamp` instead — see `recordStamp` above.
    noteTool();
    rebuildSoon();
  });
  brush.on('strokeend', () => {
    // The next pond stroke picks its own level (see `strokeLevel`).
    strokeLevel = null;
    // Always one final rebuild, whatever the throttle was doing: what is on
    // screen when the pointer lifts is what is in the map.
    noteTool();
    rebuildNow();
  });

  // History wants each layer's dirty rect before anything clears it, and
  // `commitAll` is what clears it — so the sweep and the commit ride together
  // on the world's frame, exactly as EnvPaint's own app runs them. All of it
  // is a no-op on a frame where nothing was painted.
  handles.onFrame(() => {
    for (const l of layers.all()) {
      if (l.dirtyRect) history.noteDirty(l, l.dirtyRect);
    }
    // A dirty rect is the ONE signal that says the layers changed, whoever
    // changed them — and that is why the rebuild is asked for here rather
    // than only from the brush's own stroke events. An UNDO writes the
    // recorded rect straight back into `layer.data` and calls
    // `markDirtyRect` (envpaint src/core/History.js), emitting no stroke at
    // all; before this, an undone height stroke stayed on screen until the
    // next stroke happened to rebuild over it. Both layers are read, so both
    // are fixed, and water carries a flag as well because it needs a derive
    // and not just a re-cut.
    if (waterLayer.dirtyRect) {
      waterDirty = true;
      rebuildSoon();
    }
    if (heightLayer.dirtyRect) rebuildSoon();
    layers.commitAll();
  });

  // ── the tool strip ────────────────────────────────────────────────────────
  // EnvPaint's own, built on ghost-panel's Toolbar so the chrome matches the
  // panel. It is created when painting turns on and disposed when it turns
  // off: a strip of tools for a brush that cannot paint is a control that
  // lies. NOTE: `envpaint/ui` does not export the stylesheet that carries its
  // `.ep-strip` rules (they live in a module outside the package's exports
  // map), so the strip renders with ghost-panel's plain toolbar chrome and
  // all six modes share EnvPaint's fallback icon — reported upstream.
  let strip: ToolStrip | null = null;
  const mountStrip = (): void => {
    if (strip) return;
    strip = createToolStrip(brush);
  };
  const unmountStrip = (): void => {
    strip?.dispose();
    strip = null;
  };
  disposers.push(unmountStrip);

  // ── the digits ────────────────────────────────────────────────────────────
  // 1-7 already emote the most recent character (src/main.ts, PLAN §6.3) and
  // the Brush binds its tool hotkeys on window as well, so with painting on
  // one press would do both. This capture-phase listener runs before either
  // — window is the outermost node, and neither of them captures — so while
  // painting is on 1-6 select a tool and swallow the key. 7 still emotes, and
  // every other brush hotkey ([ ] x) is left alone.
  const onKeyCapture = (event: KeyboardEvent): void => {
    if (!painting) return;
    shiftHeld = event.shiftKey;
    // A panel text field owns the keyboard while it is focused — the same
    // guard EnvPaint's own handler uses.
    if (isTyping(event.target)) return;
    // ── the radius keys ────────────────────────────────────────────────────
    // Intercepted BEFORE EnvPaint's own window handler, which clamps at 12
    // units and would stop responding over most of this world's range.
    // Auto-repeat is welcome here (holding a bracket ramps the radius), so
    // this branch deliberately runs before the `repeat` bail below.
    if (event.key === RADIUS_KEYS.down || event.key === RADIUS_KEYS.up) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      stepRadius(event.key === RADIUS_KEYS.up ? 1 : -1);
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    // Space is the camera escape while painting is on: swallowed so the page
    // does not scroll, and the world's own one-pointer drag is handed back
    // for as long as it is held.
    if (event.key === ' ') {
      if (!spaceHeld) {
        spaceHeld = true;
        handles.setSoloDrag?.(true);
      }
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const index = TOOL_KEYS.indexOf(event.key as (typeof TOOL_KEYS)[number]);
    if (index < 0) return;
    const tool = tools[index];
    if (!tool) return;
    brush.setTool(tool.id);
    strip?.sync();
    event.stopImmediatePropagation();
  };
  const onKeyUpCapture = (event: KeyboardEvent): void => {
    shiftHeld = event.shiftKey;
    if (event.key === ' ' && spaceHeld) {
      spaceHeld = false;
      // Back to the tool owning the pointer — unless painting went off while
      // the key was down, in which case the world keeps its drag.
      handles.setSoloDrag?.(!painting);
    }
  };
  /** The window can lose focus mid-chord (alt-tab with shift down); a stale
   * modifier would invert every dab of the next stroke. */
  const onBlur = (): void => {
    shiftHeld = false;
    if (spaceHeld) {
      spaceHeld = false;
      handles.setSoloDrag?.(!painting);
    }
  };
  window.addEventListener('keydown', onKeyCapture, true);
  window.addEventListener('keyup', onKeyUpCapture, true);
  window.addEventListener('blur', onBlur);
  disposers.push(() => {
    window.removeEventListener('keydown', onKeyCapture, true);
    window.removeEventListener('keyup', onKeyUpCapture, true);
    window.removeEventListener('blur', onBlur);
  });

  // ── the secondary-button escape ──────────────────────────────────────────
  // A right / middle drag turns the camera even while a tool owns the plain
  // pointer: the world's one-pointer drag is handed back for the length of
  // that drag and taken again on release. `canPaint` already refuses any
  // button but the primary, so no dab lands under it.
  const canvasEl = handles.renderer.domElement;
  let secondaryDrag = false;
  const onPointerDownCapture = (event: PointerEvent): void => {
    shiftHeld = event.shiftKey;
    if (!painting || event.button === 0 || secondaryDrag) return;
    secondaryDrag = true;
    handles.setSoloDrag?.(true);
  };
  const onPointerMoveCapture = (event: PointerEvent): void => {
    shiftHeld = event.shiftKey;
  };
  const endSecondary = (): void => {
    if (!secondaryDrag) return;
    secondaryDrag = false;
    handles.setSoloDrag?.(!(painting && !spaceHeld));
  };
  canvasEl.addEventListener('pointerdown', onPointerDownCapture, true);
  canvasEl.addEventListener('pointermove', onPointerMoveCapture, true);
  window.addEventListener('pointerup', endSecondary, true);
  window.addEventListener('pointercancel', endSecondary, true);
  disposers.push(() => {
    canvasEl.removeEventListener('pointerdown', onPointerDownCapture, true);
    canvasEl.removeEventListener('pointermove', onPointerMoveCapture, true);
    window.removeEventListener('pointerup', endSecondary, true);
    window.removeEventListener('pointercancel', endSecondary, true);
  });

  // ── the toggle ────────────────────────────────────────────────────────────
  const setPainting = (on: boolean): void => {
    painting = on;
    brush.enabled = on;
    // The world lets go of the one-pointer drag rather than the brush
    // shouting over it: both listen on the same canvas and neither can
    // out-order the other (src/world/scene.ts setSoloDrag).
    handles.setSoloDrag?.(!on);
    if (on) {
      // A stroke cannot land on ground that is sliding out from under it.
      if (handles.tour?.mode() === 'tour') handles.tour.setMode('manual');
      mountStrip();
      brush.flashRadius();
    } else {
      unmountStrip();
    }
  };
  disposers.push(() => {
    painting = false;
    handles.setSoloDrag?.(true);
  });

  // ── the panel folder ──────────────────────────────────────────────────────
  const folder = panelUi.addFolder('paint');
  const refreshReadout = (): void => {
    const { min, max } = paintedRange(map);
    const count = paintedWater()?.bodies.length ?? 0;
    // The bodies the WORLD is holding, not the texels the layer holds: what
    // the panel should say is how many sheets of water came out of the last
    // derive, spatter culled and pinholes filled.
    const water =
      count === 0 ? 'no painted water' : `${count} painted ${count === 1 ? 'body' : 'bodies'}`;
    const height =
      min === 0 && max === 0
        ? 'no painted height'
        : `painted height ${min.toFixed(2)} to ${max.toFixed(2)} u`;
    const nothing = min === 0 && max === 0 && count === 0;
    folder
      .get('paint-range')
      ?.setText?.(
        nothing
          ? 'nothing painted — the map is the authored one'
          : `${height} over ${PAINTED_SIZE} u at ${PAINTED_RES} texels · ${water}`,
      );
  };

  folder.addCheckbox('painting', {
    value: false,
    id: 'paint-on',
    tooltip: 'drag to sculpt · shift inverts · space+drag orbits · [ ] radius',
    onChange: setPainting,
  });
  folder.addSlider('radius', {
    min: RADIUS_MIN,
    max: RADIUS_MAX,
    step: 0.5,
    value: RADIUS_DEFAULT,
    suffix: 'u',
    id: 'paint-radius',
    onChange: setRadius,
  });
  folder.addSlider('strength', {
    min: 0.02,
    max: 1,
    step: 0.02,
    value: brush.settings.strength,
    id: 'paint-strength',
    onChange: (v) => {
      brush.settings.strength = v;
    },
  });
  folder.addSlider('hardness', {
    min: 0,
    max: 1,
    step: 0.05,
    value: brush.settings.hardness,
    id: 'paint-hardness',
    onChange: (v) => {
      brush.settings.hardness = v;
    },
  });
  folder.addSlider('edge noise', {
    min: 0,
    max: 1,
    step: 0.05,
    value: brush.settings.edgeNoise,
    id: 'paint-edge-noise',
    onChange: (v) => brush.setShape({ edgeNoise: v }),
  });
  folder.addSlider('spatter', {
    min: 0,
    max: 1,
    step: 0.05,
    value: brush.settings.spatter,
    id: 'paint-spatter',
    onChange: (v) => brush.setShape({ spatter: v }),
  });
  /** Both layers: `clearPaintedMap` puts the height back to 0 and the level
   * back to `DRY`, and the two rects are what tell the undo sweep and the
   * texture upload that it happened. The button records the tap; a replay
   * calls this straight, because the tap it is replaying is already logged.
   * The REBUILD is the caller's, so a clear arriving in the middle of a
   * synced batch does not re-cut the ground on its own — but the water flag
   * is raised here, so whichever rebuild follows takes the water path and
   * derives the field to null rather than leaving the last pond installed
   * over an empty layer. */
  const clearMap = (): void => {
    // `clearPaintedMap` zeroes the height AND every planting layer — they
    // share their buffers with the map, so this is one call, not eight.
    clearPaintedMap(map);
    heightLayer.markDirtyRect(0, 0, PAINTED_RES - 1, PAINTED_RES - 1);
    waterLayer.markDirtyRect(0, 0, PAINTED_RES - 1, PAINTED_RES - 1);
    for (const l of Object.values(plantLayers)) {
      l.markDirtyRect(0, 0, PLANTING_RES - 1, PLANTING_RES - 1);
    }
    history.clear();
    waterDirty = true;
    terrainDirty = true;
    plantingDirty = true;
  };
  folder.addButton('clear map', () => {
    // An action, so it is in the record: without it a replay would keep
    // every dab of a map somebody threw away.
    handles.session?.paint({ tool: 'clear' });
    clearMap();
    rebuildNow();
  });
  folder.addInfo('', 'paint-range');
  refreshReadout();

  // ── the smoke handle ──────────────────────────────────────────────────────
  /**
   * Replay one recorded dab (docs/SESSION.md §4).
   *
   * Straight to the layer, like a live stamp, and through the SAME rebuild
   * throttle — a replayed stroke has to grow the hill in increments the way
   * the stroke did, and a rebuild per dab would be ~300ms of re-cutting per
   * event. The rim settings come off the brush as it stands (see
   * `recordStamp`); the recorded seed makes the rim itself the same.
   *
   * A WATER dab goes through `stampWater`, so it travels the same road a
   * live one does — dirty rect, derive, `rebuildLandscape` — rather than
   * being written into the level array by a second code path that would
   * have to be kept in step. It lays its RECORDED plane: `strokeLevel` is
   * set from the event around the call and put back afterwards, so a
   * replayed dab neither re-reads a bank that later strokes have moved nor
   * disturbs a live stroke that happens to be in flight. A dab with no level
   * — a drain, or a log written before the field existed — falls through to
   * the bank rule, which is the best guess available.
   *
   * Unrecorded on purpose: a replayed stamp does not push onto the undo
   * stack. Ctrl+z is for the hand that is painting, and a log playing back
   * is not one.
   */
  /** One recorded dab into the layer, and nothing else — no rebuild, no undo
   * entry. The two entry points below decide when the ground is re-cut. */
  const stampPaint = (event: PaintEvent): void => {
    if (event.tool === 'clear') {
      clearMap();
      return;
    }
    if (event.x === undefined || event.z === undefined || event.r === undefined) return;
    const { u, v } = uvOf(event.x, event.z);
    const op: StampOp = {
      u,
      v,
      radius: event.r / PAINTED_SIZE,
      ...(event.strength === undefined ? {} : { strength: event.strength }),
      ...(event.hardness === undefined ? {} : { hardness: event.hardness }),
      ...(event.mode === undefined ? {} : { mode: event.mode as StampMode }),
      ...(event.seed === undefined ? {} : { seed: event.seed }),
      edgeNoise: brush.settings.edgeNoise,
      edgeScale: brush.settings.edgeScale,
      spatter: brush.settings.spatter,
      aspect: brush.settings.aspect,
    };
    if (event.tool === 'pond' || event.tool === 'drain') {
      const held = strokeLevel;
      strokeLevel = event.level ?? null;
      // `mode` says what the dab did, so a ctrl-dragged pond replays as the
      // drain it was; the tool id is the fallback for an event without one.
      const drain = event.mode === 'erase' || event.tool === 'drain';
      stampWater(op, { x: event.x, y: 0, z: event.z, u, v }, drain, null);
      strokeLevel = held;
      waterDirty = true;
      return;
    }
    if (event.mode === 'flatten' && event.flattenTo !== undefined) flattenTo = event.flattenTo;
    // Routed by tool id through the SAME table the live brush stamps
    // through, so a replayed or synced dab lands in the layer it was
    // recorded from, with the recorded rim seed and the recorded MODE — an
    // inverted (shift-held) dab replays inverted without the key.
    stampInto(event.tool, op);
    if (isPlantTool(event.tool)) plantingDirty = true;
    else terrainDirty = true;
  };

  const applyPaint = (event: PaintEvent): void => {
    stampPaint(event);
    rebuildSoon();
  };

  const applyPaintBatch = (events: readonly PaintEvent[]): void => {
    for (const event of events) stampPaint(event);
    // ONE re-cut for the batch, and `Now` rather than `Soon`: a batch is
    // already a whole gesture's worth of ground, so what is on screen when it
    // lands is what is in the map — the same rule `strokeend` keeps.
    rebuildNow();
  };

  const probe: PaintProbe = {
    brush,
    applyPaint,
    applyPaintBatch,
    setPainting: (on: boolean): void => {
      folder.get('paint-on')?.setValue?.(on);
      setPainting(on);
    },
    sampleAt: (x: number, z: number): number => sampleHeight(map, x, z),
    plantingAt: (brushId: PlantBrush, x: number, z: number): number =>
      samplePlanting(map, brushId, x, z),
    range: (): { min: number; max: number } => paintedRange(map),
    waterAt: (x: number, z: number): number => levelAt(x, z),
    shoreAt: (x: number, z: number): number => paintedWater()?.shore(x, z) ?? -Infinity,
    bodies: (): number => paintedWater()?.bodies.length ?? 0,
    rebuild: rebuildNow,
  };
  const scope = window as Window & { __refworldPaint?: PaintProbe };
  scope.__refworldPaint = probe;
  // Announced rather than polled: the scene layer holds dabs that arrived
  // before this skill did, and it has to be told the moment there is
  // somewhere to put them (see PAINT_READY_EVENT).
  window.dispatchEvent(new CustomEvent(PAINT_READY_EVENT));
  disposers.push(() => {
    delete scope.__refworldPaint;
  });

  return {
    folder,
    dispose(): void {
      for (const fn of disposers.reverse()) fn();
      // The world goes back to the one it was authored as, and is re-cut so
      // the mesh says so too. Both hands come off: the offset sampler, and
      // the water field on the geography AND on the renderer.
      setPaintedHeight(null);
      setPaintedPlanting(null);
      setPaintedWater(null);
      handles.setPaintedWater(null);
      layers.dispose();
      // The LANDSCAPE rebuild, for the reason the header gives: the trees a
      // pond displaced and the reeds it grew have to come back too, and
      // re-seating what is standing would leave both where the water was.
      handles.rebuildLandscape();
    },
  };
}
