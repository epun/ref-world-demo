/**
 * Ghost Panel dev surface (PLAN §10) — mounted only when `__IS_DEV__` is
 * true, via a dynamic import from src/main.ts, so the whole module (and the
 * ghost-panel package behind it) tree-shakes out of the demo build.
 *
 * Layout: ghost-panel's inspector is hard-locked to the RIGHT edge (its
 * legacy `side` option is intentionally ignored — see node_modules/
 * ghost-panel/index.js "Locked layout"), which is exactly where the
 * environment variables were asked to live. The left scene panel lists
 * the right-hand inspector is the only panel.
 *
 * Toggle: ghost-panel's own convention, shift+d, bound via
 * `ui.bindToggleKey('D', { shift: true })`. The world's plain-`d` draw
 * overlay key ignores shifted presses (src/main.ts) so the two never fight.
 *
 * This module must stay importable from node (vitest): every ghost-panel
 * import is lazy inside initDevPanel, and initDevPanel bails to null when
 * there is no DOM.
 */

import type { Camera, Object3D, Scene, WebGLRenderer } from 'three';
import type { CreatureManager } from '../creatures/manager';
import type { GateEntry, ModerationConsole } from '../moderation/gate';
import type { InkParams } from '../world/ink';
import { EMOTE_NAMES } from '../net/protocol';
import { springRegistry } from '../motion/spring';
import {
  achromaticGate,
  auditDampingGate,
  densityGate,
  grainGate,
  markSetGate,
  valueHistogramGate,
  type MarkSample,
} from '../taste/gates';
import { WIND_OVERRIDE_MAX } from '../world/environment';
import { WANDER_SPEED_DEFAULT } from '../creatures/manager';
import { DEFAULT_KIND_DENSITY, SCATTER_SEED, SCATTER_STEP } from '../world/scatter';
import { GRAIN, MOTION, SURFACE } from '../taste/tokens';
import { countByKind } from '../session';
import type { SessionRecorder } from '../session';
import { FALLBACK_DRAWINGS, FALLBACK_HATCH_MS } from './fixtures';
import { DEV_SKILLS_META } from './skills-meta';

export { FALLBACK_DRAWINGS, FALLBACK_HATCH_MS } from './fixtures';
export { DEV_SKILLS_META } from './skills-meta';

/** Ink tuning surface — matches InkPass's public get/set pair. */
export interface DevInkApi {
  setParams(next: Partial<InkParams>): void;
  getParams(): InkParams;
}

/** Scatter tuning surface — matches src/world/scatter.ts's Scatter handle. */
export interface DevScatterApi {
  setDensity(mult: number): void;
  /** Re-roll placement from a new seed — the same rules, a different world. */
  setSeed?(seed: number): void;
  setKindDensity?(kind: string, mult: number): void;
  setKindScale?(kind: string, mult: number): void;
  setExclusions(points: { x: number; z: number; r: number }[]): void;
  /** Live prop placements (non-tick) — the density probe samples these. */
  positions?(): { x: number; z: number; r: number }[];
  /** Color grade: tint prop albedos (hue 0–1, saturation 0–1) keeping each
   * material's token lightness. Saturation 0 restores the exact greys. */
  setTint?(hue: number, saturation: number): void;
  group?: Object3D;
}

/** Presentation-tour surface — matches src/world/tour.ts's Tour handle.
 * Structural (not the Tour type itself) so this module keeps importing from
 * node without pulling world modules in. */
export interface DevTourApi {
  setMode(mode: 'manual' | 'tour'): void;
  mode(): 'manual' | 'tour';
  setDwellRange(minMs: number, maxMs: number): void;
  hatchAllMoment(hatchAll: () => void): void;
}

/** Weather names the environment workstream ships (src/world/environment.ts). */
export const WEATHER_NAMES = ['clear', 'overcast', 'fog', 'rain', 'snow'] as const;

/** Environment/weather surface — another workstream lands it on WorldHandles
 * as `environment`; the panel wires it defensively and no-ops when absent. */
export interface DevEnvironmentApi {
  setWeather(name: string): void;
  setTimeOfDay(t: number): void;
  setIntensity(v: number): void;
  /** Wind override (src/world/environment.ts): number pins the wind, null
   * hands it back to the weather presets. Optional — feature-detected. */
  setWindOverride?(v: number | null): void;
  state?: unknown;
}

/** Feature-detect the environment handle — accepts unknown so main.ts can
 * forward whatever WorldHandles carries (or nothing) without caring whether
 * the environment workstream has landed yet. */
export function readEnvironmentApi(candidate: unknown): DevEnvironmentApi | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const rec = candidate as Record<string, unknown>;
  if (
    typeof rec['setWeather'] === 'function' &&
    typeof rec['setTimeOfDay'] === 'function' &&
    typeof rec['setIntensity'] === 'function'
  ) {
    return candidate as DevEnvironmentApi;
  }
  return null;
}

export interface DevHandles {
  scene: Scene;
  camera: Camera;
  renderer?: WebGLRenderer;
  /** Register per-frame work; runs before render (src/world/scene.ts). */
  onFrame(callback: (dt: number, nowMs: number) => void): void;
  creatures: CreatureManager;
  /** Presentation tour (src/world/tour.ts) — camera mode, dwell length,
   * and the hatch-all moment. Controls appear only when provided. */
  tour?: DevTourApi;
  ink?: DevInkApi;
  scatter?: DevScatterApi;
  /** WorldHandles.environment when the weather workstream has landed —
   * passed through as unknown and feature-detected here. */
  environment?: unknown;
  setGrainAmplitude?(v: number): void;
  /** Live grain amplitude readback, for the grain gate (QA audit D6). */
  getGrainAmplitude?(): number;
  /** Color grade for the paper field (scene background + ground disc):
   * a css color string from the panel's picker. */
  setBackgroundColor?(color: string): void;
  /** Slide the camera's look-target to a ground point (the minimap's
   * click-to-pan spring) — selection focus rides the same rail. */
  focusAt?(x: number, z: number): void;
  /** Spawn n deterministic fixture drawings. Defaults to an internal
   * implementation over FALLBACK_DRAWINGS when absent. */
  spawnFallback?(n: number): void;
  /** The world's ingest gate (src/moderation/gate.ts). The moderation
   * folder appears only when this is wired; without it the panel says so
   * rather than pretending there is a screen. */
  moderation?: ModerationConsole;
  /**
   * The world's session recorder (src/session/). NOTE the asymmetry: the
   * recorder itself ships in every build — a live event is exactly when you
   * want the log — and only this ui for it is dev-gated. The panel reads it,
   * writes world-control changes into it, and downloads it.
   */
  session?: SessionRecorder;
  /** Replay a session log json into this world (src/main.ts). Returns false
   * when the text is not a log this build understands. */
  replaySession?(json: string): boolean;
  /** RESTORE a session log json — the whole log applied at once, so the
   * world lands in the state it ends in. The recovery path; a replay is for
   * watching a session back. Returns the creature count, or null on a log
   * this build cannot read. */
  restoreSession?(json: string): number | null;
  /** Restore the fullest autosaved log from a PREVIOUS epoch on this
   * machine — the `r` key's own path. Returns how many came back. */
  restoreLastSession?(): number;
}

/** Offscreen readback resolution for the pixel gates. */
const READBACK_SIZE = 256;

/**
 * [D] Density-probe sampling unit: a two-iso-step neighborhood. Scatter
 * clusters seed per grid cell, so a 2-step tile is the local composition
 * unit — the fraction of tiles holding at least one prop is the plan-view
 * stand-in for the brief's composition density. Measured against the shipped
 * world: 0.400 occupancy vs the 0.39 target, so the metric reads the design
 * where it stands (raw footprint area, by contrast, reads ~0.03 and would
 * measure colliders, not composition).
 */
const DENSITY_TILE_UNITS = SCATTER_STEP * 2;

/** Per-tile occupancy samples over the scattered region's bounding square. */
function densityCoverageSamples(props: { x: number; z: number }[]): number[] {
  let extent = DENSITY_TILE_UNITS;
  for (const p of props) {
    extent = Math.max(extent, Math.abs(p.x), Math.abs(p.z));
  }
  const n = Math.max(1, Math.ceil((2 * extent) / DENSITY_TILE_UNITS));
  const samples = new Array<number>(n * n).fill(0);
  for (const p of props) {
    const ix = Math.min(n - 1, Math.max(0, Math.floor((p.x + extent) / DENSITY_TILE_UNITS)));
    const iz = Math.min(n - 1, Math.max(0, Math.floor((p.z + extent) / DENSITY_TILE_UNITS)));
    samples[ix * n + iz] = 1;
  }
  return samples;
}

/**
 * App ui elements the mark-set lint samples (TASTE §4: icon + ruleLine +
 * border only). The minimap carries the recorded torn-paper ruling from the
 * qa audit (p8) — reported as an exemption, never a violation.
 */
const MARK_LINT_TARGETS: { selector: string; name: string; exemptReason?: string }[] = [
  { selector: '.draw-open', name: 'draw control' },
  { selector: '.draw-hint', name: 'draw hint' },
  {
    selector: '.join-qr',
    name: 'join code',
    exemptReason: 'qr modules are a machine-read mark, not ui chrome',
  },
  { selector: '.hover-name', name: 'hover name' },
  {
    selector: '.world-minimap',
    name: 'minimap',
    exemptReason: 'torn-paper scrap ruling — deliberate ground fill, qa audit p8',
  },
];

/** Read computed styles off the live ui: an opaque background is a filled
 * panel, any box shadow is an unrepresented mark. */
function sampleUiMarks(): MarkSample[] {
  const out: MarkSample[] = [];
  for (const target of MARK_LINT_TARGETS) {
    const el = document.querySelector(target.selector);
    if (!(el instanceof Element)) continue;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const filled =
      bg !== '' && bg !== 'transparent' && !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/.test(bg);
    const shadowed = cs.boxShadow !== '' && cs.boxShadow !== 'none';
    out.push({
      name: target.name,
      filled,
      shadowed,
      ...(target.exemptReason !== undefined ? { exemptReason: target.exemptReason } : {}),
    });
  }
  return out;
}

// ── moderation list rendering ────────────────────────────────────────────────
// The operator rows are raw dom (ghost-panel has no list control): a label
// plus small actions. TASTE §4 holds here as everywhere — hairline borders
// and text, no filled panels, no shadows, no uppercase.

interface ModerationAction {
  label: string;
  onClick(): void;
}

function moderationRow(label: string, actions: ModerationAction[]): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:3px 0;font:400 11px/1.3 ui-sans-serif,system-ui,sans-serif;';
  const text = document.createElement('span');
  text.textContent = label;
  text.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.85;';
  row.appendChild(text);
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.style.cssText =
      'background:transparent;color:inherit;border:1px solid currentColor;border-radius:9px;padding:1px 7px;font:inherit;cursor:pointer;opacity:0.75;';
    button.addEventListener('click', action.onClick);
    row.appendChild(button);
  }
  return row;
}

interface ModerationList {
  element: HTMLElement;
  render(rows: { label: string; actions: ModerationAction[] }[]): void;
}

function createModerationList(title: string, emptyText: string): ModerationList {
  const element = document.createElement('div');
  element.style.cssText = 'margin:4px 0 8px;';
  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.cssText =
    'font:400 10px/1.4 ui-sans-serif,system-ui,sans-serif;opacity:0.55;border-bottom:1px solid currentColor;padding-bottom:2px;';
  const body = document.createElement('div');
  element.append(heading, body);
  return {
    element,
    render(rows): void {
      body.textContent = '';
      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = emptyText;
        empty.style.cssText =
          'padding:3px 0;font:400 11px/1.3 ui-sans-serif,system-ui,sans-serif;opacity:0.45;';
        body.appendChild(empty);
        return;
      }
      for (const row of rows) body.appendChild(moderationRow(row.label, row.actions));
    },
  };
}

/** How an entry reads in the operator lists: who drew it, and why it is
 * here. Ids are long, so only the tail is shown when there is no name. */
function moderationLabel(entry: GateEntry): string {
  const who = entry.name ?? entry.id.slice(-6);
  if (entry.verdict === 'allow') return who;
  const reason = entry.reason ?? entry.verdict;
  return `${who} — ${reason}`;
}

/** Longest list length the panel draws: an operator scans, never scrolls. */
const MODERATION_ROWS = 12;

/** How many fallback creatures one button press spawns. */
const FALLBACK_SPAWN_COUNT = 3;

/**
 * Mount the ghost-panel dev surface. Resolves to a disposer, or null when
 * there is no DOM (node) — in which case nothing was imported or mounted.
 */
export interface DevPanelOptions {
  /** Show the panel immediately on mount (production first-press flow, where
   * the shift+d that loaded the chunk should also reveal it). */
  showOnMount?: boolean;
}

export async function initDevPanel(
  handles: DevHandles,
  options: DevPanelOptions = {},
): Promise<{ dispose(): void } | null> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;

  // Lazy: the only ghost-panel touchpoint in the repo.
  const { createGhostPanel } = await import('ghost-panel');

  // Forward handle for callbacks captured by createGhostPanel's options —
  // assigned right after creation, used only from user-driven events.
  let uiRef: import('ghost-panel').GhostPanelUi | null = null;

  // Creature roots are the ONLY gizmo-movable objects (user ask): the
  // environment rows are controllers, not transforms.
  const isCreatureRoot = (obj: unknown): obj is Object3D =>
    !!obj &&
    typeof obj === 'object' &&
    typeof (obj as { name?: unknown }).name === 'string' &&
    (obj as { name: string }).name.startsWith('creature ');

  const ui = createGhostPanel({
    title: 'ref world',
    scene: handles.scene,
    camera: handles.camera,
    ...(handles.renderer ? { renderer: handles.renderer } : {}),
    // The gizmo appears ONLY when the panel is open and the click landed on
    // a creature (user ask) — never on environment rows, never while the
    // panel is hidden and the world is just being watched.
    beforeGizmoAttach: (obj) =>
      isCreatureRoot(obj) && (uiRef?.isVisible() ?? false) ? undefined : false,
    // Gizmo drag ↔ behavior handshake: while dragging, the manager holds
    // the creature (agent bypassed, neighbors part around it); on release
    // the new spot is committed back to its behavior.
    onDraggingChanged: (dragging) => {
      const om = uiRef?.objectManager;
      const active = om?.activeName ? om.objects[om.activeName]?.object : undefined;
      if (!isCreatureRoot(active)) return;
      if (dragging) handles.creatures.beginManualMove(active);
      else handles.creatures.endManualMove(active);
    },
    // One panel only, docked right (the inspector's locked side).
    // Left outliner ON (user ask): creatures appear in the scene panel by
    // their named roots; the right panel keeps the refworld skills.
    scenePanel: true,
    scenePanelTitle: 'scene',
    materialsPanel: false,
    // The world renders through a custom post chain and has no renderer
    // handle here — skip scene auto-scan and workflow auto-detection so the
    // panel carries exactly the refworld skills and nothing speculative.
    autoRegister: false,
    workflow: [],
    // Hidden until shift+d.
    visible: false,
  });

  uiRef = ui;
  // Selection/gizmo probe for the panel smokes (dev-only, like the panel
  // itself — this whole module tree-shakes out of a non-dev build).
  (window as Window & { __refworldOm?: unknown }).__refworldOm = ui.objectManager;

  // Ghost Panel's own toggle convention: shift+d (README "Press Shift+D").
  ui.bindToggleKey('D', { shift: true });
  if (options.showOnMount) ui.show();

  // Hiding the panel drops the selection with it, so the gizmo can never
  // linger over a world nobody is inspecting (user ask). hide() and
  // toggle() are separate routes in ghost-panel (toggle drives the panel
  // directly), so both are wrapped; the outliner sync below carries a
  // backstop for any route neither covers.
  const dropSelection = (): void => ui.objectManager?.deselect();
  const rawHide = ui.hide.bind(ui);
  ui.hide = (): void => {
    dropSelection();
    rawHide();
  };
  const rawToggle = ui.toggle.bind(ui);
  ui.toggle = (): void => {
    if (ui.isVisible()) dropSelection();
    rawToggle();
  };

  // ── scene outliner sync (user ask): creatures AND environment objects ─────
  // appear as named rows. The panel mounts with autoRegister off, and a
  // mount-time scan would miss everything dynamic anyway (creatures spawn
  // later, the scatter rebuilds on every density change) — so a low-cadence
  // sync walks the scene for named meshes/groups, registers new ones, and
  // drops rows whose object has left the scene graph. objectManager.remove
  // detaches an attached object, so it only ever runs for nodes that are
  // already detached; cameras are exempt (the rig camera is not a scene
  // child, and its row hosts the look-through control).
  const om = ui.objectManager;
  if (om) {
    const inScene = (node: Object3D): boolean => {
      let p: Object3D = node;
      while (p.parent) p = p.parent;
      return p === (handles.scene as Object3D);
    };
    const syncOutliner = (): void => {
      for (const name of om.getNames()) {
        const obj = om.objects[name]?.object as
          | (Object3D & { isCamera?: boolean })
          | undefined;
        if (!obj?.isObject3D || obj.isCamera) continue;
        if (!inScene(obj)) om.remove(name);
      }
      const known = new Set(
        Object.values(om.objects)
          .map((e) => e?.object)
          .filter(Boolean),
      );
      const names = new Set(om.getNames());
      (handles.scene as Object3D).traverse((node) => {
        if (known.has(node)) return;
        const label = node.name.trim();
        if (!label) return;
        const flags = node as { isMesh?: boolean; isGroup?: boolean };
        if (!flags.isMesh && !flags.isGroup) return;
        // Never surface gizmo/helper internals. TransformControls' own axis
        // meshes are named x/y/z/xy/xyz/start/end, so once the gizmo
        // attached they flooded the outliner (visible in a user's panel
        // export). Same filter ghost-panel's own scan uses: helper types,
        // transform controls, and the __duiIgnore opt-out — checked up the
        // whole ancestor chain, since only the root carries the marker.
        for (let p: Object3D | null = node; p; p = p.parent) {
          const tag = p as Object3D & {
            isTransformControls?: boolean;
            userData?: { __duiIgnore?: unknown };
          };
          if (tag.isTransformControls || tag.userData?.__duiIgnore) return;
          if (/Helper$/.test(p.type)) return;
        }
        // Descendants of a registered node stay collapsed under it — no
        // sub-part spam from creature roots.
        for (let p = node.parent; p; p = p.parent) if (known.has(p)) return;
        let unique = label;
        for (let i = 2; names.has(unique); i++) unique = `${label} ${i}`;
        om.register(unique, node);
        known.add(node);
        names.add(unique);
      });
    };
    let outlinerClockMs = 0;
    handles.onFrame((dt) => {
      // Backstop for the hide/toggle wraps: a hidden panel never holds a
      // selection, so no gizmo can survive into the plain world view.
      if (!ui.isVisible() && om.activeName) om.deselect();
      outlinerClockMs += dt;
      if (outlinerClockMs < 1000) return;
      outlinerClockMs = 0;
      syncOutliner();
    });
    syncOutliner();

    // ── selection behavior (user ask) ────────────────────────────────────
    // Environment rows are CONTROLLERS: clicking `trees` opens the tree
    // variables in the right panel (expand + scroll + a brief hairline
    // flash on the matching sliders). Creature rows are INDIVIDUALS:
    // clicking one slides the camera to it, and the transform gizmo —
    // permitted only on creature roots — makes it movable by hand.
    const ENV_ROW_SLIDERS: Record<string, readonly string[]> = {
      trees: ['tree density', 'tree scale'],
      conifers: ['tree density', 'tree scale'],
      rocks: ['rock density', 'rock scale'],
      buildings: ['building density'],
      bushes: ['bush density'],
      stumps: ['stump density'],
      palms: ['palm density'],
      cacti: ['cactus density'],
      monoliths: ['monolith density'],
      'picnic tables': ['structure density'],
      'water towers': ['structure density'],
      grass: ['grass density', 'grass scale'],
    };
    const flashTimers = new Map<HTMLElement, number>();
    const flash = (el: HTMLElement): void => {
      el.style.outline = '1px solid currentcolor';
      el.style.outlineOffset = '2px';
      const prior = flashTimers.get(el);
      if (prior !== undefined) window.clearTimeout(prior);
      flashTimers.set(
        el,
        window.setTimeout(() => {
          el.style.outline = '';
          el.style.outlineOffset = '';
          flashTimers.delete(el);
        }, MOTION.primaryMs),
      );
    };
    let lastActive: string | null = null;
    om.on('change', (activeName) => {
      // Gizmo drags re-fire 'change' with the same primary — react only to
      // actual selection changes.
      if (activeName === lastActive) return;
      lastActive = activeName;
      if (!activeName) return;
      const obj = om.objects[activeName]?.object;
      if (isCreatureRoot(obj)) {
        handles.focusAt?.(obj.position.x, obj.position.z);
        return;
      }
      const sliders = ENV_ROW_SLIDERS[activeName];
      if (!sliders) return;
      const envFolder = ui.getFolder('environment');
      if (!envFolder) return;
      envFolder.expand();
      let first = true;
      for (const label of sliders) {
        const handle = envFolder.get(label);
        if (!handle) continue;
        if (first) {
          handle.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
          first = false;
        }
        flash(handle.element);
      }
    });
  }

  const { creatures } = handles;

  // The session recorder (src/session/). Every world-control handler below
  // writes one sample through this; the recorder coalesces a slider drag into
  // a single event, so a log never grows per pointermove.
  const session = handles.session;

  let fallbackIndex = 0;
  const spawnFallback =
    handles.spawnFallback ??
    ((n: number): void => {
      for (let i = 0; i < n; i++) {
        const strokes = FALLBACK_DRAWINGS[fallbackIndex % FALLBACK_DRAWINGS.length];
        if (!strokes) continue;
        creatures.spawn(`dev-fallback-${fallbackIndex++}`, strokes, {
          hatchMs: FALLBACK_HATCH_MS,
        });
      }
    });

  // ── frame readback for the pixel gates ────────────────────────────────────
  // The renderer's buffer is not preserved between frames, so the readback
  // waits for the next animation frame: our one-shot rAF is queued after the
  // world loop's (registered at the end of the previous frame), which means
  // drawImage runs right after the frame was drawn, while the buffer is
  // still valid.

  function frameCanvas(): HTMLCanvasElement | null {
    if (handles.renderer) return handles.renderer.domElement;
    const world = document.getElementById('world');
    if (world instanceof HTMLCanvasElement) return world;
    return document.querySelector('canvas');
  }

  function readFramePixels(): Promise<Uint8ClampedArray> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        const source = frameCanvas();
        if (!source) {
          resolve(new Uint8ClampedArray(0));
          return;
        }
        const off = document.createElement('canvas');
        off.width = READBACK_SIZE;
        off.height = READBACK_SIZE;
        const ctx = off.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(new Uint8ClampedArray(0));
          return;
        }
        ctx.drawImage(source, 0, 0, READBACK_SIZE, READBACK_SIZE);
        resolve(ctx.getImageData(0, 0, READBACK_SIZE, READBACK_SIZE).data);
      });
    });
  }

  const meta = new Map(DEV_SKILLS_META.map((m) => [m.id, m]));
  function metaOf(id: string): { id: string; name: string; category: string; description: string } {
    const m = meta.get(id);
    if (!m) throw new Error(`unknown dev skill id: ${id}`);
    return m;
  }

  // ── refworld.demo — presentation controls (docs/GENERATOR.md) ─────────────

  ui.skills.register({
    ...metaOf('refworld.demo'),
    apply: (panelUi) => {
      const folder = panelUi.addFolder('demo');
      folder.addButton('spawn fallback creatures', () => spawnFallback(FALLBACK_SPAWN_COUNT));
      folder.addButton('hatch all', () => creatures.hatchAll());
      folder.addButtonRow([
        { label: 'pause ai', onClick: () => creatures.pauseAi(true) },
        { label: 'resume ai', onClick: () => creatures.pauseAi(false) },
      ]);
      folder.addButton('clear creatures', () => creatures.clearAll());
      folder.addButton('reset world', () => {
        creatures.clearAll();
        handles.scatter?.setExclusions([]);
        handles.scatter?.setDensity(1);
      });
      folder.addSlider('wander speed', {
        min: 0.2,
        max: 3,
        step: 0.05,
        value: WANDER_SPEED_DEFAULT,
        id: 'wander-speed',
        onChange: (v) => {
          creatures.setWanderSpeed(v);
          session?.world('wanderSpeed', v);
        },
      });
      folder.addCheckbox('pause hatch timers', {
        value: false,
        id: 'pause-hatch-timers',
        onChange: (v) => creatures.pauseTimers(v),
      });
      // ── camera — the presentation tour (folded into demo, same brief) ────
      const tour = handles.tour;
      if (tour) {
        folder.addSelect('camera mode', {
          options: ['manual', 'tour'],
          value: tour.mode(),
          id: 'camera-mode',
          onChange: (v) => tour.setMode(v === 'tour' ? 'tour' : 'manual'),
        });
        // Dwell length in seconds: value is the shortest dwell, 2x the
        // longest — the default 6 mirrors the tour's 6-12s range.
        folder.addSlider('dwell length', {
          min: 4,
          max: 20,
          step: 1,
          value: 6,
          suffix: 's',
          id: 'tour-dwell',
          onChange: (v) => tour.setDwellRange(v * 1000, v * 2000),
        });
        folder.addButton('hatch-all moment', () =>
          tour.hatchAllMoment(() => creatures.hatchAll()),
        );
      }
      return { folder };
    },
    teardown: (panelUi) => panelUi.panel.removeFolder('demo'),
  });

  // ── refworld.moderation — the operator layer (docs/MODERATION.md) ────────
  // The automatic screen refuses one stereotyped mark and holds another;
  // everything else a public installation needs is a person with one tap.
  // These rows are that person's hands: take a creature off the projection,
  // block the handset that sent it, or put every arrival behind approval
  // for the length of a live event.

  ui.skills.register({
    ...metaOf('refworld.moderation'),
    apply: (panelUi) => {
      // Collapsed on open (user ask): the queue is an exception handler, not
      // a control you reach for — it earns its space only when something is
      // actually held, and an expanded operator queue pushes the controls
      // people DO use every session further down the panel.
      const folder = panelUi.addFolder('moderation', { collapsed: true });
      const gate = handles.moderation;
      if (!gate) {
        folder.addInfo('no ingest gate in this world build', 'moderation-missing');
        return { folder };
      }

      folder.addInfo('', 'moderation-readout');
      folder.addCheckbox('hold arrivals', {
        value: gate.holdAll(),
        id: 'moderation-hold',
        tooltip: 'queue every new drawing until a person approves it',
        onChange: (on) => gate.setHoldAll(on),
      });

      const waiting = createModerationList('waiting for approval', 'nothing waiting');
      folder.addRaw(waiting.element);
      folder.addButtonRow([
        { label: 'approve all', onClick: () => gate.approveAll() },
        { label: 'discard all', onClick: () => gate.discardAll() },
      ]);

      const live = createModerationList('in the world', 'no arrivals yet');
      folder.addRaw(live.element);
      folder.addButton('unblock every drawer', () => {
        for (const id of gate.blocked()) gate.unblock(id);
      });

      const render = (): void => {
        const pending = gate.pending();
        const admitted = gate.admitted();
        const last = gate.log()[0];
        folder
          .get('moderation-readout')
          ?.setText?.(
            [
              `in the world ${admitted.length}`,
              `waiting ${pending.length}`,
              `blocked ${gate.blocked().length}`,
              last
                ? `last: ${moderationLabel(last)} — ${last.disposition}`
                : 'nothing has arrived yet',
            ].join(' · '),
          );
        waiting.render(
          pending.slice(0, MODERATION_ROWS).map((entry) => ({
            label: moderationLabel(entry),
            actions: [
              { label: 'approve', onClick: () => gate.approve(entry.id) },
              { label: 'discard', onClick: () => gate.discard(entry.id) },
              { label: 'block', onClick: () => gate.block(entry.id) },
            ],
          })),
        );
        live.render(
          admitted.slice(0, MODERATION_ROWS).map((entry) => ({
            label: moderationLabel(entry),
            actions: [
              // One tap takes the thing off the projection.
              { label: 'remove', onClick: () => gate.remove(entry.id) },
              { label: 'block', onClick: () => gate.block(entry.id) },
            ],
          })),
        );
      };
      render();
      const unsubscribe = gate.onChange(render);
      // A creature can also leave by the population guard or a clear-all,
      // which the gate never hears about; a low-cadence repaint keeps the
      // list honest without polling every frame.
      let clockMs = 0;
      handles.onFrame((dt) => {
        clockMs += dt;
        if (clockMs < 1000) return;
        clockMs = 0;
        render();
      });
      return { folder, unsubscribe };
    },
    teardown: (panelUi, handle) => {
      (handle as { unsubscribe?: () => void } | undefined)?.unsubscribe?.();
      panelUi.panel.removeFolder('moderation');
    },
  });

  // ── refworld.session — the recorded session log (docs/SESSION.md) ─────────
  // The RECORDER is not dev-gated: it runs in every build, wired at the gate
  // and the creature manager (src/main.ts). Only this readout and the
  // download/replay buttons live here.

  ui.skills.register({
    ...metaOf('refworld.session'),
    apply: (panelUi) => {
      const folder = panelUi.addFolder('session');
      const recorder = handles.session;
      if (!recorder) {
        folder.addInfo('no session recorder in this world build', 'session-missing');
        return { folder };
      }

      folder.addInfo('', 'session-readout');
      const render = (): void => {
        const counts = countByKind(recorder.snapshot());
        const seconds = Math.round(recorder.durationMs() / 1000);
        folder.get('session-readout')?.setText?.(
          [
            `${recorder.count()} events`,
            `${seconds}s`,
            `drawings ${counts['drawing'] ?? 0}`,
            `hatches ${counts['hatch'] ?? 0}`,
            `emotes ${counts['emote'] ?? 0}`,
            `operator ${counts['operator'] ?? 0}`,
            ...(recorder.overflowed() ? ['log full — later events dropped'] : []),
          ].join(' · '),
        );
      };
      render();

      folder.addButton('download session log', () => {
        const blob = new Blob([recorder.toJson()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        // Lowercase everywhere (TASTE §5), and the epoch keeps two sessions
        // from overwriting each other in a downloads folder.
        anchor.download = `session-${recorder.snapshot().epoch}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      });

      // RECOVERY, first: after a refresh of the projection this is the
      // button that matters, and it must not be below a replay control that
      // looks like it does the same thing. A replay re-runs a session at
      // the pace it was recorded — press it on an hour-long log and the
      // world stays empty for minutes while the panel says it is working.
      // Restore applies the whole log at once.
      const restoreLast = handles.restoreLastSession;
      if (restoreLast) {
        folder.addButton('restore last session', () => {
          const n = restoreLast();
          folder
            .get('session-readout')
            ?.setText?.(
              n > 0
                ? `restored ${n} creature${n === 1 ? '' : 's'} from the last session`
                : 'nothing autosaved on this machine to restore',
            );
        });
      }

      const restoreLog = handles.restoreSession;
      if (restoreLog) {
        folder.addButton('restore from a log file', () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json,.json';
          input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              const n = restoreLog(text);
              folder
                .get('session-readout')
                ?.setText?.(
                  n === null
                    ? 'not a session log this build reads'
                    : `restored ${n} creature${n === 1 ? '' : 's'}`,
                );
            });
          });
          input.click();
        });
      }

      const replayLog = handles.replaySession;
      if (replayLog) {
        folder.addButton('replay a session log (at its recorded pace)', () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json,.json';
          input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              const ok = replayLog(text);
              folder
                .get('session-readout')
                ?.setText?.(ok ? 'replaying…' : 'not a session log this build reads');
            });
          });
          input.click();
        });
      }

      // Low cadence, like the moderation list: the log changes only on
      // discrete events, so once a second is plenty and costs nothing.
      let clockMs = 0;
      handles.onFrame((dt) => {
        clockMs += dt;
        if (clockMs < 1000) return;
        clockMs = 0;
        render();
      });
      return { folder };
    },
    teardown: (panelUi) => panelUi.panel.removeFolder('session'),
  });

  // ── refworld.environment — the right-hand environment variables ───────────

  ui.skills.register({
    ...metaOf('refworld.environment'),
    apply: (panelUi) => {
      const folder = panelUi.addFolder('environment');
      const scatter = handles.scatter;
      if (scatter) {
        // Trees and grass as independent properties (user ask). 'tree'
        // covers deciduous; conifers ride their own kind but follow the
        // tree slider here so 'trees' means the forest as a whole.
        if (scatter.setKindDensity && scatter.setKindScale) {
          const kd = scatter.setKindDensity.bind(scatter);
          const ks = scatter.setKindScale.bind(scatter);
          folder.addSlider('tree density', {
            min: 0,
            max: 2.5,
            value: DEFAULT_KIND_DENSITY.tree ?? 1,
            onChange: (v) => {
              kd('tree', v);
              kd('conifer', v);
              session?.world('kindDensity', v, 'tree');
            },
          });
          folder.addSlider('tree scale', {
            min: 0.5,
            max: 1.8,
            value: 1,
            onChange: (v) => {
              ks('tree', v);
              ks('conifer', v);
              session?.world('kindScale', v, 'tree');
            },
          });
          folder.addSlider('rock density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => {
              kd('rock', v);
              session?.world('kindDensity', v, 'rock');
            },
          });
          folder.addSlider('rock scale', {
            min: 0.4,
            max: 1.8,
            value: 1,
            onChange: (v) => {
              ks('rock', v);
              session?.world('kindScale', v, 'rock');
            },
          });
          folder.addSlider('building density', {
            min: 0,
            max: 4,
            value: 1,
            onChange: (v) => {
              kd('building', v);
              session?.world('kindDensity', v, 'building');
            },
          });
          folder.addSlider('bush density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => {
              kd('bush', v);
              session?.world('kindDensity', v, 'bush');
            },
          });
          folder.addSlider('stump density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => {
              kd('stump', v);
              session?.world('kindDensity', v, 'stump');
            },
          });
          folder.addSlider('palm density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => {
              kd('palm', v);
              session?.world('kindDensity', v, 'palm');
            },
          });
          folder.addSlider('cactus density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => {
              kd('cactus', v);
              session?.world('kindDensity', v, 'cactus');
            },
          });
          folder.addSlider('monolith density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => {
              kd('monolith', v);
              session?.world('kindDensity', v, 'monolith');
            },
          });
          // Picnic tables + water towers grouped: the built small-structure
          // pair, both rare — zeroing this leaves only nature standing.
          folder.addSlider('structure density', {
            min: 0,
            max: 4,
            value: 1,
            onChange: (v) => {
              kd('picnicTable', v);
              kd('waterTower', v);
              session?.world('kindDensity', v, 'structure');
            },
          });
          folder.addSlider('grass density', {
            min: 0,
            max: 3,
            value: 1,
            onChange: (v) => {
              kd('tick', v);
              session?.world('kindDensity', v, 'grass');
            },
          });
          folder.addSlider('grass scale', {
            min: 0.5,
            max: 2,
            value: 1,
            onChange: (v) => {
              ks('tick', v);
              session?.world('kindScale', v, 'grass');
            },
          });
        }
        // Placement seed (user ask). Placement is a pure function of
        // (cell, seed, density), so moving this re-rolls every cluster —
        // the same rules growing a different world. Stepped by 1 and
        // integer-valued: a seed is an identity, not a magnitude, and 7.35
        // would be a different world from 7.36 with no way to say which
        // you meant.
        if (scatter.setSeed) {
          const setSeed = scatter.setSeed.bind(scatter);
          folder.addSlider('placement seed', {
            min: 1,
            max: 200,
            step: 1,
            value: SCATTER_SEED,
            id: 'scatter-seed',
            onChange: (v) => {
              const seed = Math.round(v);
              setSeed(seed);
              session?.world('seed', seed);
            },
          });
        }
        folder.addSlider('scatter density', {
          min: 0.3,
          max: 2,
          step: 0.05,
          value: 1,
          id: 'scatter-density',
          onChange: (v) => {
            scatter.setDensity(v);
            session?.world('density', v);
          },
        });
      }

      // Shader style properties in their own section (user ask): the render
      // look — grain, the ink pass, and the color grade — separated from the
      // environment's density and scale variables.
      const setGrain = handles.setGrainAmplitude;
      const ink = handles.ink;
      const setBackgroundColor = handles.setBackgroundColor;
      const setObjectTint = scatter?.setTint?.bind(scatter);
      const style = panelUi.addFolder('shader style');
      if (setGrain) {
        style.addSlider('grain amplitude', {
          min: 0,
          max: 0.12,
          step: 0.002,
          value: GRAIN.amplitude,
          id: 'grain-amplitude',
          onChange: (v) => {
            setGrain(v);
            session?.world('grain', v);
          },
        });
      }
      if (ink) {
        const params = ink.getParams();
        style.addSlider('ink edge threshold', {
          min: 0.0002,
          max: 0.004,
          step: 0.0001,
          value: params.edgeThreshold,
          id: 'ink-edge-threshold',
          onChange: (v) => {
            ink.setParams({ edgeThreshold: v });
            session?.world('inkEdgeThreshold', v);
          },
        });
        style.addSlider('ink line width', {
          min: 0.5,
          max: 6,
          step: 0.1,
          value: params.lineWidth,
          id: 'ink-line-width',
          onChange: (v) => {
            ink.setParams({ lineWidth: v });
            session?.world('inkLineWidth', v);
          },
        });
        style.addSlider('ink wobble', {
          min: 0,
          max: 8,
          step: 0.1,
          value: params.wobble,
          id: 'ink-wobble',
          onChange: (v) => {
            ink.setParams({ wobble: v });
            session?.world('inkWobble', v);
          },
        });
        style.addSlider('ink hatch strength', {
          min: 0,
          max: 1,
          step: 0.05,
          value: params.hatchStrength,
          id: 'ink-hatch-strength',
          onChange: (v) => {
            ink.setParams({ hatchStrength: v });
            session?.world('inkHatchStrength', v);
          },
        });
      }
      // Color grade (user ask): hue + saturation dials for the object
      // shaders and the paper field. Lightness is pinned to the tokens, so
      // the measured value structure (and the toon bands) never move —
      // saturation 0 is exactly the shipped achromatic look. No hex enters:
      // colors are derived via setHSL around the token lightness.
      if (setObjectTint) {
        let objectHue = 0;
        let objectSat = 0;
        style.addSlider('object hue', {
          min: 0,
          max: 1,
          step: 0.01,
          value: 0,
          id: 'object-hue',
          onChange: (v) => {
            objectHue = v;
            setObjectTint(objectHue, objectSat);
            session?.world('objectHue', v);
          },
        });
        style.addSlider('object saturation', {
          min: 0,
          max: 1,
          step: 0.01,
          value: 0,
          id: 'object-saturation',
          onChange: (v) => {
            objectSat = v;
            setObjectTint(objectHue, objectSat);
            session?.world('objectSaturation', v);
          },
        });
      }
      // Background color: a real picker (swatch + popover + hex field).
      // Starts on the ground token; picking it again restores the shipped
      // achromatic look exactly.
      if (setBackgroundColor) {
        style.addColor('background color', {
          value: SURFACE.ground,
          id: 'background-color',
          onChange: (c) => {
            setBackgroundColor(c);
            session?.world('background', c);
          },
        });
      }

      if (!scatter && !setGrain && !ink) {
        folder.addInfo('no environment handles were provided', 'env-empty');
      }
      return { folder };
    },
    teardown: (panelUi) => {
      panelUi.panel.removeFolder('environment');
      panelUi.panel.removeFolder('shader style');
    },
  });

  // ── refworld.weather — environment/weather controls (defensive) ───────────

  ui.skills.register({
    ...metaOf('refworld.weather'),
    apply: (panelUi) => {
      const folder = panelUi.addFolder('weather');
      const env = readEnvironmentApi(handles.environment);
      if (!env) {
        folder.addInfo('no environment handle in this world build yet', 'weather-missing');
        return { folder };
      }
      folder.addSelect('weather', {
        options: [...WEATHER_NAMES],
        value: WEATHER_NAMES[0],
        id: 'weather-name',
        onChange: (name) => {
          env.setWeather(name);
          session?.world('weather', name);
        },
      });
      folder.addSlider('time of day', {
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.5,
        id: 'time-of-day',
        onChange: (t) => {
          env.setTimeOfDay(t);
          session?.world('timeOfDay', t);
        },
      });
      folder.addSlider('intensity', {
        min: 0,
        max: 1,
        step: 0.05,
        value: 0.5,
        id: 'weather-intensity',
        onChange: (v) => {
          env.setIntensity(v);
          session?.world('intensity', v);
        },
      });
      // Wind override (QA audit D5) — feature-detected like the rest: the
      // slider pins the wind through weather changes; auto hands it back to
      // the presets (null). Both glide on the environment's ζ≥1 springs.
      if (typeof env.setWindOverride === 'function') {
        folder.addSlider('wind override', {
          min: 0,
          max: WIND_OVERRIDE_MAX,
          step: 0.05,
          value: 0.3,
          id: 'wind-override',
          onChange: (v) => {
            env.setWindOverride?.(v);
            session?.world('wind', v);
          },
        });
        folder.addButton('wind auto (release override)', () => {
          env.setWindOverride?.(null);
          session?.world('wind', null);
        });
      }
      return { folder };
    },
    teardown: (panelUi) => panelUi.panel.removeFolder('weather'),
  });

  // ── refworld.character — emotes on the latest hatched character ───────────

  ui.skills.register({
    ...metaOf('refworld.character'),
    apply: (panelUi) => {
      const folder = panelUi.addFolder('character');
      folder.addInfo('emotes target the most recently hatched character', 'character-hint');
      const rows: (typeof EMOTE_NAMES)[number][][] = [
        EMOTE_NAMES.slice(0, 4),
        EMOTE_NAMES.slice(4),
      ];
      for (const row of rows) {
        folder.addButtonRow(
          row.map((name) => ({
            label: name,
            onClick: () => {
              const id = creatures.latestId();
              if (id) creatures.emote(id, name, 'panel');
            },
          })),
        );
      }
      return { folder };
    },
    teardown: (panelUi) => panelUi.panel.removeFolder('character'),
  });

  // ── refworld.taste — the verification gates from TASTE §7 ─────────────────

  ui.skills.register({
    ...metaOf('refworld.taste'),
    apply: (panelUi) => {
      const folder = panelUi.addFolder('taste');
      folder.addInfo('press a gate — results print below', 'gate-readout');
      folder.addInfo('', 'stillness-note');

      const setReadout = (text: string): void => {
        folder.get('gate-readout')?.setText?.(text);
      };
      const refreshStillness = (): void => {
        folder
          .get('stillness-note')
          ?.setText?.(
            `stillness: ${springRegistry.size} spring(s) registered — idle elements keep drifting on the ambient floor, nothing fully arrests`,
          );
      };
      refreshStillness();

      folder.addButton('damping audit', () => {
        const result = auditDampingGate();
        setReadout(`damping audit — ${result.pass ? 'pass' : 'fail'}: ${result.detail}`);
        refreshStillness();
      });
      folder.addButton('achromatic', () => {
        void readFramePixels().then((pixels) => {
          const result = achromaticGate(pixels);
          setReadout(`achromatic — ${result.pass ? 'pass' : 'fail'}: ${result.detail}`);
          refreshStillness();
        });
      });
      folder.addButton('value histogram', () => {
        void readFramePixels().then((pixels) => {
          const result = valueHistogramGate(pixels);
          setReadout(`value histogram — ${result.pass ? 'pass' : 'fail'}: ${result.detail}`);
          refreshStillness();
        });
      });
      // ── density probe (TASTE §7, QA audit D6): live scatter placements
      // sampled as 2-step-tile occupancy against DENSITY.global.
      folder.addButton('density probe', () => {
        const props = handles.scatter?.positions?.();
        if (!props || props.length === 0) {
          setReadout('density probe — no scatter positions in this world build');
          return;
        }
        const result = densityGate(densityCoverageSamples(props));
        setReadout(`density probe — ${result.pass ? 'pass' : 'fail'}: ${result.detail}`);
        refreshStillness();
      });
      // ── mark-set lint (TASTE §4/§7, QA audit D6): computed styles of the
      // live app ui against the icon/ruleLine/border mark set. color + type
      // (hex outside tokens, uppercase) are covered at build time by
      // gate:static; this button lints what only a running dom shows —
      // fills and shadows.
      folder.addButton('mark-set lint', () => {
        const result = markSetGate(sampleUiMarks());
        setReadout(`mark-set lint — ${result.pass ? 'pass' : 'fail'}: ${result.detail}`);
        refreshStillness();
      });
      // ── grain check (TASTE §2.7/§7, QA audit D6): live amplitude off the
      // grain pass handle; uniformity is structural (one full-frame uniform).
      folder.addButton('grain check', () => {
        const get = handles.getGrainAmplitude;
        if (!get) {
          setReadout('grain check — no grain handle in this world build');
          return;
        }
        const result = grainGate(get());
        setReadout(`grain check — ${result.pass ? 'pass' : 'fail'}: ${result.detail}`);
        refreshStillness();
      });
      return { folder, refreshStillness };
    },
    teardown: (panelUi) => panelUi.panel.removeFolder('taste'),
  });

  // Mount every refworld skill now — registration alone only catalogs them.
  for (const m of DEV_SKILLS_META) {
    await ui.skills.apply(m.id);
  }

  // Keep control readouts in sync with live scene state.
  let disposed = false;
  handles.onFrame(() => {
    if (!disposed) ui.update();
  });

  return {
    dispose(): void {
      disposed = true;
      for (const m of DEV_SKILLS_META) {
        ui.skills.remove(m.id);
        ui.skills.registry.unregister(m.id);
      }
      ui.dispose();
    },
  };
}
