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
 * WHAT IS NOT HERE YET (envpaint docs/port-meridian.md §5): water levels and
 * basins (step 4), forest / mountain / clearing weights (step 5), and the
 * `paint` session event, "save map" and the build-time bake (step 6). One
 * marked hook comment below says where the session event goes.
 */

import type { Camera, Object3D, Scene, WebGLRenderer } from 'three';
import { Raycaster, Vector2, Vector3 } from 'three';
import type { GhostFolder, GhostPanelUi } from 'ghost-panel';
import type { BrushHit, StampOp, Tool } from 'envpaint/core';
import { Brush, History, PaintLayer, PaintLayers } from 'envpaint/core';
import { createToolStrip, type ToolStrip } from 'envpaint/ui';
import { SURFACE } from '../taste/tokens';
import { setPaintedHeight } from '../world/landscape';
import {
  clearPaintedMap,
  createPaintedMap,
  paintedRange,
  paintedSampler,
  sampleHeight,
  PAINTED_RES,
  PAINTED_SIZE,
} from '../world/painted';
import type { DevSkillMeta } from './skills-meta';

/** The one layer this step paints: a terrain offset in world units. */
const HEIGHT_LAYER = 'height';

/**
 * [D] Brush radius range in world units, 0.5–40.
 *
 * NOT EnvPaint's own: its `Brush.setRadius` clamps to 0.3–12, sized for a
 * 48-unit world, and Meridian's field is 400 across. A dab that can only
 * ever be a twelfth of the forest is not a landscape tool, so the panel
 * writes `settings.radius` (a public field) and calls `flashRadius`, which
 * is what `setRadius` does either side of the clamp. Reported upstream in
 * the port notes rather than worked around silently.
 */
const RADIUS_MIN = 0.5;
const RADIUS_MAX = 40;
const RADIUS_DEFAULT = 12;

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

/** Hotkeys 1-4, in strip order. */
const TOOL_KEYS = ['1', '2', '3', '4'] as const;

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
  /** Register per-frame work (the undo stack's dirty-rect sweep). */
  onFrame(callback: (dt: number, nowMs: number) => void): void;
  /** Park the world's own one-pointer drag while a stroke owns the pointer
   * (`WorldHandles.setSoloDrag`). Optional: without it painting still works,
   * it just orbits the camera at the same time. */
  setSoloDrag?(enabled: boolean): void;
  /** The presentation tour. Painting takes the camera off it — a stroke
   * cannot land where the ground is sliding out from under it. */
  tour?: { setMode(mode: 'manual' | 'tour'): void; mode(): 'manual' | 'tour' };
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
  /** Lowest and highest painted offset in the map. */
  range(): { min: number; max: number };
  /** Force the world to re-cut itself now. */
  rebuild(): void;
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
  const map = createPaintedMap(PAINTED_RES, PAINTED_SIZE, layer.data as Float32Array);
  // From here on the world's heights carry whatever is in that array. With an
  // unpainted map that is the authored world exactly (test/world/painted.test.ts).
  setPaintedHeight(paintedSampler(map));

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
      // The world's own gestures keep working when painting is off, and
      // shift+drag stays the world's pan even when it is on — a modifier
      // that means "camera" in one mode and "paint" in another is the kind
      // of ambiguity the shift+r note in src/main.ts argues against.
      canPaint: (event: PointerEvent): boolean => painting && !event.shiftKey,
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
    brush.settings.radius = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, r));
    brush.flashRadius();
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
  const tools: Tool[] = [
    { id: 'raise', label: 'raise', key: TOOL_KEYS[0], mode: 'raise', eraseMode: 'lower' },
    { id: 'lower', label: 'lower', key: TOOL_KEYS[1], mode: 'lower', eraseMode: 'raise' },
    {
      id: 'flatten',
      label: 'flatten',
      key: TOOL_KEYS[2],
      mode: 'flatten',
      altMode: 'smooth',
      eraseMode: 'smooth',
      onStamp: (_ctx: unknown, op: StampOp): void => {
        layer.stamp(op.mode === 'flatten' ? { ...op, flattenTo } : op);
      },
    },
    { id: 'smooth', label: 'smooth', key: TOOL_KEYS[3], mode: 'smooth', eraseMode: 'smooth' },
  ];
  for (const tool of tools) {
    brush.registerTool({ ...tool, layer: HEIGHT_LAYER, color: SURFACE.ink });
  }
  brush.setTool('raise');

  // ── the rebuild, throttled ────────────────────────────────────────────────
  let lastRebuildMs = 0;
  let pendingRebuild = 0;

  const rebuildNow = (): void => {
    if (pendingRebuild) {
      window.clearTimeout(pendingRebuild);
      pendingRebuild = 0;
    }
    lastRebuildMs = performance.now();
    handles.rebuildTerrain();
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

  brush.on('strokestart', (payload) => {
    const hit = payload.hit;
    if (hit) flattenTo = sampleHeight(map, hit.x, hit.z);
    rebuildSoon();
  });
  brush.on('stroke', () => {
    // ── session hook (envpaint docs/port-meridian.md §5 step 6) ─────────────
    // ONE `paint` event per stamp goes here, not per batch: a stroke replays
    // exactly because every dab carries its own seed
    // ({ k: 'paint', tool, u, v, radius, strength, hardness, mode, dir,
    //   edgeNoise, edgeScale, spatter, aspect, seed }). It needs the per-dab
    // op, which `stroke` does not carry — the Brush emits once per batch of
    // dabs — so landing it means an `onStamp` on every tool, or an upstream
    // event. Deliberately not wired in this PR (docs/PLAN.md §7).
    rebuildSoon();
  });
  brush.on('strokeend', () => {
    // Always one final rebuild, whatever the throttle was doing: what is on
    // screen when the pointer lifts is what is in the map.
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
    if (!painting || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const index = TOOL_KEYS.indexOf(event.key as (typeof TOOL_KEYS)[number]);
    if (index < 0) return;
    const tool = tools[index];
    if (!tool) return;
    brush.setTool(tool.id);
    strip?.sync();
    event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKeyCapture, true);
  disposers.push(() => window.removeEventListener('keydown', onKeyCapture, true));

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
    tooltip: 'drag on the ground to sculpt; the world keeps shift+drag and the wheel',
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
  folder.addButton('clear map', () => {
    clearPaintedMap(map);
    layer.markDirtyRect(0, 0, PAINTED_RES - 1, PAINTED_RES - 1);
    history.clear();
    rebuildNow();
  });
  folder.addInfo('', 'paint-range');
  refreshReadout();

  // ── the smoke handle ──────────────────────────────────────────────────────
  const probe: PaintProbe = {
    brush,
    setPainting: (on: boolean): void => {
      folder.get('paint-on')?.setValue?.(on);
      setPainting(on);
    },
    sampleAt: (x: number, z: number): number => sampleHeight(map, x, z),
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
      layers.dispose();
      handles.rebuildTerrain();
    },
  };
}
