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
import { SCATTER_STEP } from '../world/scatter';
import { GRAIN } from '../taste/tokens';
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
  setKindDensity?(kind: string, mult: number): void;
  setKindScale?(kind: string, mult: number): void;
  setExclusions(points: { x: number; z: number; r: number }[]): void;
  /** Live prop placements (non-tick) — the density probe samples these. */
  positions?(): { x: number; z: number; r: number }[];
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
  /** Spawn n deterministic fixture drawings. Defaults to an internal
   * implementation over FALLBACK_DRAWINGS when absent. */
  spawnFallback?(n: number): void;
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
  { selector: '.join-line', name: 'join line' },
  { selector: '.egg-hint', name: 'egg hint' },
  { selector: '.draw-hint', name: 'draw hint' },
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

  const ui = createGhostPanel({
    title: 'ref world',
    scene: handles.scene,
    camera: handles.camera,
    ...(handles.renderer ? { renderer: handles.renderer } : {}),
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

  // Ghost Panel's own toggle convention: shift+d (README "Press Shift+D").
  ui.bindToggleKey('D', { shift: true });
  if (options.showOnMount) ui.show();

  const { creatures } = handles;

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
        value: 1,
        id: 'wander-speed',
        onChange: (v) => creatures.setWanderSpeed(v),
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
            value: 1,
            onChange: (v) => {
              kd('tree', v);
              kd('conifer', v);
            },
          });
          folder.addSlider('tree scale', {
            min: 0.5,
            max: 1.8,
            value: 1,
            onChange: (v) => {
              ks('tree', v);
              ks('conifer', v);
            },
          });
          folder.addSlider('rock density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => kd('rock', v),
          });
          folder.addSlider('rock scale', {
            min: 0.4,
            max: 1.8,
            value: 1,
            onChange: (v) => ks('rock', v),
          });
          folder.addSlider('building density', {
            min: 0,
            max: 4,
            value: 1,
            onChange: (v) => kd('building', v),
          });
          folder.addSlider('bush density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => kd('bush', v),
          });
          folder.addSlider('stump density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => kd('stump', v),
          });
          folder.addSlider('palm density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => kd('palm', v),
          });
          folder.addSlider('cactus density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => kd('cactus', v),
          });
          folder.addSlider('monolith density', {
            min: 0,
            max: 2.5,
            value: 1,
            onChange: (v) => kd('monolith', v),
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
            },
          });
          folder.addSlider('grass density', {
            min: 0,
            max: 3,
            value: 1,
            onChange: (v) => kd('tick', v),
          });
          folder.addSlider('grass scale', {
            min: 0.5,
            max: 2,
            value: 1,
            onChange: (v) => ks('tick', v),
          });
        }
        folder.addSlider('scatter density', {
          min: 0.3,
          max: 2,
          step: 0.05,
          value: 1,
          id: 'scatter-density',
          onChange: (v) => scatter.setDensity(v),
        });
      }
      const setGrain = handles.setGrainAmplitude;
      if (setGrain) {
        folder.addSlider('grain amplitude', {
          min: 0,
          max: 0.12,
          step: 0.002,
          value: GRAIN.amplitude,
          id: 'grain-amplitude',
          onChange: (v) => setGrain(v),
        });
      }
      const ink = handles.ink;
      if (ink) {
        const params = ink.getParams();
        folder.addSlider('ink edge threshold', {
          min: 0.0002,
          max: 0.004,
          step: 0.0001,
          value: params.edgeThreshold,
          id: 'ink-edge-threshold',
          onChange: (v) => ink.setParams({ edgeThreshold: v }),
        });
        folder.addSlider('ink line width', {
          min: 0.5,
          max: 6,
          step: 0.1,
          value: params.lineWidth,
          id: 'ink-line-width',
          onChange: (v) => ink.setParams({ lineWidth: v }),
        });
        folder.addSlider('ink wobble', {
          min: 0,
          max: 8,
          step: 0.1,
          value: params.wobble,
          id: 'ink-wobble',
          onChange: (v) => ink.setParams({ wobble: v }),
        });
        folder.addSlider('ink hatch strength', {
          min: 0,
          max: 1,
          step: 0.05,
          value: params.hatchStrength,
          id: 'ink-hatch-strength',
          onChange: (v) => ink.setParams({ hatchStrength: v }),
        });
      }
      if (!scatter && !setGrain && !ink) {
        folder.addInfo('no environment handles were provided', 'env-empty');
      }
      return { folder };
    },
    teardown: (panelUi) => panelUi.panel.removeFolder('environment'),
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
        onChange: (name) => env.setWeather(name),
      });
      folder.addSlider('time of day', {
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.5,
        id: 'time-of-day',
        onChange: (t) => env.setTimeOfDay(t),
      });
      folder.addSlider('intensity', {
        min: 0,
        max: 1,
        step: 0.05,
        value: 0.5,
        id: 'weather-intensity',
        onChange: (v) => env.setIntensity(v),
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
          onChange: (v) => env.setWindOverride?.(v),
        });
        folder.addButton('wind auto (release override)', () => env.setWindOverride?.(null));
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
            onClick: () => creatures.latestCharacter()?.emote(name),
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
