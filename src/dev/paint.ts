/**
 * `refworld.paint` — sculpt the terrain by hand, in the dev surface only
 * (PLAN §7 "painted terrain (dev)", PLAN §10 for the panel itself).
 *
 * Meridian's geography is authored and fixed (src/world/landscape.ts); this
 * is the one way a person adds to it. The brush engine is EnvPaint's,
 * imported through its portable entry points (`envpaint/core` for the
 * layers, the brush and the undo stack, `envpaint/ui` for the tool strip) —
 * see envpaint docs/port-meridian.md, of which this file is step 3, height
 * tools only.
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
 * THE BRUSH KIT (2026-09-09, user ask: *"in the collection we should have
 * brushes for trees, rocks, grass, flowers, rivers, clouds, ponds, etc."*).
 * Seven planting brushes stand beside the four height tools, each writing
 * its own weight layer whose buffer IS the painted map's (src/world/painted.ts
 * `planting`), read by scatter's per-cell roll through `setPaintedPlanting`.
 * A planting stroke rebuilds the SCATTER ONLY — the ground has not moved, and
 * re-cutting 103k vertices for a stroke that plants grass is the difference
 * between a live tool and a slideshow (see REBUILD_MIN_MS).
 *
 * Water brushes (ponds, rivers) are deliberately NOT here: another branch
 * owns them.
 *
 * WHAT IS NOT HERE YET (envpaint docs/port-meridian.md §5): water levels and
 * basins (step 4), and — of step 6 — "save map" and the build-time bake. The `paint` SESSION EVENT of
 * that step is now wired: one event per dab, through each tool's `onStamp`
 * (docs/SESSION.md §paint), plus one for the tap that clears the map. There
 * is no "save map" action to record; when there is one, it records here.
 */

import type { Camera, Object3D, Scene, WebGLRenderer } from 'three';
import { Raycaster, Vector2, Vector3 } from 'three';
import type { GhostFolder, GhostPanelUi } from 'ghost-panel';
import type { BrushHit, StampMode, StampOp, Tool } from 'envpaint/core';
import { Brush, History, isTyping, PaintLayer, PaintLayers } from 'envpaint/core';
import { createToolStrip, type ToolStrip } from 'envpaint/ui';
import { SURFACE } from '../taste/tokens';
import { setPaintedHeight, setPaintedPlanting } from '../world/landscape';
import {
  clearPaintedMap,
  createPaintedMap,
  paintedRange,
  paintedSampler,
  plantingSampler,
  sampleHeight,
  samplePlanting,
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
import type { PaintEvent, SessionRecorder } from '../session';
import type { DevSkillMeta } from './skills-meta';

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

/** Hotkeys 1-4, in strip order — the HEIGHT tools only. 5-7 stay emotes and
 * the planting brushes are selected from the strip: seven more digits would
 * take the whole keyboard row off the operator (2026-09-09, user ask). */
const TOOL_KEYS = ['1', '2', '3', '4'] as const;

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
  /** Force the world to re-cut itself now. */
  rebuild(): void;
  /**
   * Re-apply one recorded `paint` event — the replay seam
   * (src/main.ts `replayDriver.paint`, docs/SESSION.md §4). Dabs land
   * through the same layer stamp a live one does and rebuild on the same
   * throttle, so a replayed stroke grows the hill the way the stroke did.
   */
  applyPaint(event: PaintEvent): void;
}

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

  // ── the map, and the layer that shares its buffer ─────────────────────────
  const layers = new PaintLayers();
  const layer = layers.add(
    new PaintLayer(HEIGHT_LAYER, {
      channels: 1,
      float: true,
      initial: 0,
      res: PAINTED_RES,
    }),
  );
  // One float layer per planting brush, at the planting resolution. Their
  // buffers become the map's, exactly as the height layer's does — a dab is
  // visible to the next placement roll with no upload and no copy.
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
    layer.data as Float32Array,
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
  // All four write the one height layer. The edge shape is EnvPaint's own
  // default (SHAPE_DEFAULTS: edgeNoise 0.35, edgeScale 3, spatter 0.25) and
  // stays that way — TASTE §2.5 has no clean discs on this map, and a brush
  // whose rim is a circle draws one every stamp.
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

  const recordStamp = (tool: string, op: StampOp): void => {
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
   * A tool that records its dab and then stamps it. `flatten` also carries
   * the target the stroke is levelling toward — see the note below.
   *
   * SHIFT INVERTS (2026-09-09, user ask): raise ↔ lower, add ↔ erase, and
   * smooth / flatten untouched — the inversion is applied HERE, before the
   * recording, so the session event says what the dab actually did rather
   * than which tool was selected. A replayed or synced stamp then lands the
   * same result without knowing anything about a modifier key.
   */
  const recorded = (id: string, rest: Omit<Tool, 'id' | 'label' | 'onStamp'>): Tool => ({
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
  ];
  for (const tool of tools) {
    brush.registerTool({ ...tool, layer: HEIGHT_LAYER, color: SURFACE.ink });
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
    brush.registerTool({ ...tool, layer: tool.id, color: SURFACE.ink });
  }
  brush.setTool(HEIGHT_TOOL_IDS[0]);

  // ── the rebuild, throttled ────────────────────────────────────────────────
  let lastRebuildMs = 0;
  let pendingRebuild = 0;
  /**
   * Whether anything since the last rebuild moved the GROUND.
   *
   * A planting stroke moves no vertex: it only changes what scatter rolls,
   * so it needs `refreshScatter` (re-roll + re-instance, ~20-30ms) and not
   * `setTerrain({})` (re-displace 103k vertices, re-normal, re-seat, re-level
   * water — ~250-330ms measured). The flag is sticky rather than per-dab
   * because the throttle coalesces a burst: if ANY dab in the burst was a
   * height dab, the burst owes a full rebuild (2026-09-09, user ask).
   */
  let terrainDirty = false;

  const rebuildNow = (): void => {
    if (pendingRebuild) {
      window.clearTimeout(pendingRebuild);
      pendingRebuild = 0;
    }
    lastRebuildMs = performance.now();
    const scatterOnly = handles.rebuildScatter;
    if (terrainDirty || !scatterOnly) handles.rebuildTerrain();
    else scatterOnly();
    terrainDirty = false;
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

  /** Mark what this stroke's tool touches, then rebuild on the throttle. */
  const noteTool = (): void => {
    if (!isPlantTool(brush.tool ?? '')) terrainDirty = true;
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
    // Always one final rebuild, whatever the throttle was doing: what is on
    // screen when the pointer lifts is what is in the map.
    noteTool();
    rebuildNow();
  });

  // History wants each layer's dirty rect before anything clears it, and
  // `commitAll` is what clears it — so the sweep and the commit ride together
  // on the world's frame, exactly as EnvPaint's own app runs them. Both are
  // no-ops on a frame where nothing was painted.
  handles.onFrame(() => {
    for (const l of layers.all()) {
      if (l.dirtyRect) history.noteDirty(l, l.dirtyRect);
    }
    layers.commitAll();
  });

  // ── the tool strip ────────────────────────────────────────────────────────
  // EnvPaint's own, built on ghost-panel's Toolbar so the chrome matches the
  // panel. It is created when painting turns on and disposed when it turns
  // off: a strip of tools for a brush that cannot paint is a control that
  // lies. NOTE: `envpaint/ui` does not export the stylesheet that carries its
  // `.ep-strip` rules (they live in a module outside the package's exports
  // map), so the strip renders with ghost-panel's plain toolbar chrome and
  // the four height modes share EnvPaint's fallback icon — reported upstream.
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
  // painting is on it selects the tool and swallows the key. 5-7 still emote,
  // and every other brush hotkey ([ ] x) is left alone.
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
    folder
      .get('paint-range')
      ?.setText?.(
        min === 0 && max === 0
          ? 'nothing painted — the map is the authored one'
          : `painted height ${min.toFixed(2)} to ${max.toFixed(2)} u over ${PAINTED_SIZE} u at ${PAINTED_RES} texels`,
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
  const clearMap = (): void => {
    // `clearPaintedMap` zeroes the height AND every planting layer — they
    // share their buffers with the map, so this is one call, not eight.
    clearPaintedMap(map);
    layer.markDirtyRect(0, 0, PAINTED_RES - 1, PAINTED_RES - 1);
    for (const l of Object.values(plantLayers)) {
      l.markDirtyRect(0, 0, PLANTING_RES - 1, PLANTING_RES - 1);
    }
    history.clear();
    terrainDirty = true;
    rebuildNow();
  };
  folder.addButton('clear map', () => {
    // An action, so it is in the record: without it a replay would keep
    // every dab of a map somebody threw away.
    handles.session?.paint({ tool: 'clear' });
    clearMap();
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
   * Unrecorded on purpose: a replayed stamp does not push onto the undo
   * stack. Ctrl+z is for the hand that is painting, and a log playing back
   * is not one.
   */
  const applyPaint = (event: PaintEvent): void => {
    if (event.tool === 'clear') {
      clearMap();
      return;
    }
    if (event.x === undefined || event.z === undefined || event.r === undefined) return;
    const { u, v } = uvOf(event.x, event.z);
    if (event.mode === 'flatten' && event.flattenTo !== undefined) flattenTo = event.flattenTo;
    // Routed by tool id through the SAME table the live brush stamps
    // through, so a replayed or synced dab lands in the layer it was
    // recorded from, with the recorded rim seed and the recorded MODE — an
    // inverted (shift-held) dab replays inverted without the key.
    stampInto(event.tool, {
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
    });
    if (!isPlantTool(event.tool)) terrainDirty = true;
    rebuildSoon();
  };

  const probe: PaintProbe = {
    brush,
    applyPaint,
    setPainting: (on: boolean): void => {
      folder.get('paint-on')?.setValue?.(on);
      setPainting(on);
    },
    sampleAt: (x: number, z: number): number => sampleHeight(map, x, z),
    plantingAt: (brushId: PlantBrush, x: number, z: number): number =>
      samplePlanting(map, brushId, x, z),
    range: (): { min: number; max: number } => paintedRange(map),
    rebuild: rebuildNow,
  };
  const scope = window as Window & { __refworldPaint?: PaintProbe };
  scope.__refworldPaint = probe;
  disposers.push(() => {
    delete scope.__refworldPaint;
  });

  return {
    folder,
    dispose(): void {
      for (const fn of disposers.reverse()) fn();
      // The world goes back to the one it was authored as, and is re-cut so
      // the mesh says so too.
      setPaintedHeight(null);
      setPaintedPlanting(null);
      layers.dispose();
      handles.rebuildTerrain();
    },
  };
}
