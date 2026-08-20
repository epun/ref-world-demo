/**
 * World entry point.
 *
 * The world hosts many creatures (GENERATOR.md): every drawing — from the
 * local overlay (press d) or streamed in from phones over the draw-to-3d
 * MQTT feed — becomes an egg that paints itself, wobbles, cracks, and
 * hatches (press h to hatch all early). Phones draw at /draw/?room=xxxx
 * (the vendored kit UI); a mobile visitor to this page is routed there.
 *
 * TASTE discipline: the overlay ENTERS AND EXITS BY SLIDING (translateY over
 * t.secondary on the settle curve — never popping, hard cuts are forbidden at
 * confidence 1.00). The egg slides down from slightly above the ground; the
 * hatch shell slides apart and the character rises on ζ≥1 springs. The corner
 * control is icon + hairline border only, no filled button. All colors come
 * from src/taste/tokens.ts; all durations from MOTION tokens.
 */

import { Vector3 } from 'three';
import { installHoverNames } from './creatures/hover';
import { createCreatureManager } from './creatures/manager';
import { connectWorldFeed, PERSONALITIES, type IncomingDrawing } from './net/drawFeed';
import { createIngestGate } from './moderation/gate';
import { EMOTE_NAMES, isRoomCode, roomCode, type EmoteName } from './net/protocol';
import {
  createSessionRecorder,
  parseSessionLog,
  readSessionLog,
  recordCreatures,
  recordGate,
  replaySession,
  type DrawingSource,
  type ReplayDriver,
  type ReplayHandle,
  type SessionLog,
} from './session';
import { MAX_POPULATION, WANDER_SPEED_DEFAULT } from './creatures/manager';
import { mountDrawScreen } from './draw/ui';
import { MOTION, SURFACE, WORLD } from './taste/tokens';
import { installJoinQr, QR_SIZE_CSS } from './ui/joinqr';
import { installWorldMinimap } from './ui/minimap';
import { start } from './world/scene';
import { createTour } from './world/tour';

/** Hatch timer — dev pacing; a live demo wants ~90s (PLAN §13). */
export const HATCH_TIMER_MS = 20000;

/**
 * What this world offers its gate: the feed's drawing, the hatch delay it is
 * admitted with, and where it came in from. `source` exists only so the
 * session log can say whether a creature came from a phone, the local pad, or
 * a fixture (src/session/).
 */
type WorldDrawing = IncomingDrawing & { hatchMs: number; source: DrawingSource };

// ── draw overlay chrome ──────────────────────────────────────────────────────
// TASTE §4: icons, hairline rules, thin borders — and nothing else. The
// overlay slides on translateY; the settle curve is the drift-compatible
// CSS stand-in for the ζ≥1 spring (no bounce by construction).

const OVERLAY_STYLE_ID = 'world-overlay-style';


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
`;
  document.head.appendChild(style);
}

function main(): void {
  const canvas = document.getElementById('world');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('missing #world canvas');
  }

  const world = start(canvas);

  // ── room ──────────────────────────────────────────────────────────────────
  // The room pairs this world with phones drawing at /draw/?room=xxxx via the
  // vendored draw-to-3d feed. ?room= wins; otherwise mint one (randomness at
  // the edge, per protocol.ts).
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get('room') ?? '').toLowerCase();
  const room = isRoomCode(fromUrl) ? fromUrl : roomCode(Math.random);

  // A phone opening the world link goes to the drawing UI for this room —
  // the mobile view IS the kit's draw page (user decision).
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse && Math.min(window.innerWidth, window.innerHeight) < 620) {
    location.replace(`/draw/?room=${room}`);
    return;
  }

  // A minted room is written back into this page's own address. Nothing is
  // drawn on screen any more (user ask), so the address bar is where the
  // code lives: shareable, and a reload keeps the same room instead of
  // stranding the phones already drawing into it.
  if (!isRoomCode(fromUrl)) {
    params.set('room', room);
    history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
  }

  // ── world session ────────────────────────────────────────────────────────
  // A world page load is a NEW world: nothing survives a refresh, so every
  // creature drawn into the previous session is gone. The session id says
  // which world is running; it travels in the join code and in every reply
  // to a phone, so a handset holding a creature this world never knew is
  // let in to draw again instead of being locked out forever (user ask).
  const epoch = 'w' + Math.floor(Math.random() * 0xffffffff).toString(36);

  // ── session recorder (src/session/, docs/SESSION.md) ──────────────────────
  // Ships in EVERY build, not just dev: a live event is exactly when you want
  // the log. It records inputs and decisions — stroke lists, ids, moderation
  // verdicts, operator taps — at ms offsets from now, and nothing per frame,
  // because generation is deterministic in (strokes, id) and replay re-derives
  // the rest. Only the panel button that downloads it is dev-gated.
  const session = createSessionRecorder({
    epoch,
    room,
    // The one wall clock in the whole format. Everything else is an offset.
    startedAt: new Date().toISOString(),
    config: {
      hatchMs: HATCH_TIMER_MS,
      maxPopulation: MAX_POPULATION,
      wanderSpeed: WANDER_SPEED_DEFAULT,
      // Generation-affecting: the ground paper the session ran under, and
      // the character construction path (src/character/character.ts reads
      // this global override).
      ground: SURFACE.ground,
      construction:
        (globalThis as { __refworldConstruction?: unknown }).__refworldConstruction ===
        'blendshell'
          ? 'blendshell'
          : 'inflate',
      worldScale: 1,
    },
    now: () => performance.now(),
  });

  // The world calls the hatch, so the world announces it: the handset plays
  // its own hatch off this edge instead of running an independent timer,
  // which is what made the creature appear on the projection and, seconds
  // later and unrelated, on the phone (user report).
  const recorder = recordCreatures(session);
  const creatures = createCreatureManager(world, {
    observer: {
      ...recorder,
      hatch(id, cause) {
        recorder.hatch(id, cause);
        feed?.publishToPhones({ type: 'hatched', to: id, epoch });
      },
    },
  });
  installHoverNames(canvas, world.cameraRig.camera, creatures);

  // ── moderation gate (src/moderation/) ─────────────────────────────────────
  // EVERY drawing enters the world through this one call — the phone feed
  // below and the local overlay both offer here, never spawning directly.
  // A refusal is silent ON THE PROJECTION — never reward the drawing with
  // attention on the shared screen. The drawer IS told, privately, on their
  // own handset (user ask), and the operator sees it in the panel readout.
  const gate = createIngestGate<WorldDrawing>({
    observer: recordGate(session, { hatchMs: HATCH_TIMER_MS, source: 'phone' }),
    spawn: (d) =>
      creatures.spawn(d.id, d.strokes, {
        ...(d.name !== null ? { name: d.name } : {}),
        ...(d.personality !== null ? { personality: d.personality } : {}),
        hatchMs: d.hatchMs,
      }),
    clear: (id) => creatures.clear(id),
    live: (id) => creatures.has(id),
  });
  // Tiny always-on probe, same family as __refworldCreatures in the manager:
  // the moderation smoke reads decisions and drives hold/block from outside
  // the panel. Read-only handles to what the panel already exposes.
  (window as Window & { __refworldModeration?: unknown }).__refworldModeration = gate;

  // ── replay (src/session/replay.ts) ────────────────────────────────────────
  // The driver side of a recorded session: the pure replay walks the log and
  // calls these, so a log recorded on one machine re-drives this world with
  // the same ids and the same strokes at the same offsets. Spawns go STRAIGHT
  // to the manager, never back through the screen — the recorded verdict is
  // the decision, and re-screening could rule differently on a newer build.
  const replayDriver: ReplayDriver = {
    spawn: (d) =>
      creatures.spawn(d.id, d.strokes, {
        ...(d.name !== null ? { name: d.name } : {}),
        ...(d.personality !== null && (PERSONALITIES as readonly string[]).includes(d.personality)
          ? { personality: d.personality as (typeof PERSONALITIES)[number] }
          : {}),
        hatchMs: d.hatchMs,
      }),
    hatch: (id) => creatures.hatch(id),
    emote: (id, emote) => {
      if ((EMOTE_NAMES as readonly string[]).includes(emote)) {
        creatures.emote(id, emote as EmoteName, 'phone');
      }
    },
    remove: (id) => creatures.clear(id),
    // The operator state a replayed world should stand in: hold mode and the
    // block list. Removals are driven by replay itself, above.
    operator: (action, id, on) => {
      if (action === 'hold') gate.setHoldAll(on === true);
      else if (action === 'block' && id !== null) gate.block(id);
    },
    // World controls an operator moved. Only the handles this page owns —
    // anything it cannot drive is skipped rather than faked.
    world: (field, value) => {
      const env = (world as unknown as { environment?: Record<string, unknown> })
        .environment;
      const call = (name: string, arg: unknown): void => {
        const fn = env?.[name];
        if (typeof fn === 'function') (fn as (v: unknown) => void).call(env, arg);
      };
      if (field === 'weather' && typeof value === 'string') call('setWeather', value);
      else if (field === 'timeOfDay' && typeof value === 'number') call('setTimeOfDay', value);
      else if (field === 'intensity' && typeof value === 'number') call('setIntensity', value);
      else if (field === 'wind') call('setWindOverride', value);
      else if (field === 'background' && typeof value === 'string') {
        world.setBackgroundColor(value);
      } else if (field === 'grain' && typeof value === 'number') {
        world.grain.setAmplitude(value);
      } else if (field === 'density' && typeof value === 'number') {
        world.scatter.setDensity(value);
      } else if (field === 'wanderSpeed' && typeof value === 'number') {
        creatures.setWanderSpeed(value);
      }
    },
  };

  /**
   * Always-on session handle (same family as __refworldCreatures): read the
   * log, export it, or replay one into this world. Not dev-gated — the
   * recorder ships, and this is the code entry point the docs point at.
   */
  let replayHandle: ReplayHandle | null = null;
  const sessionApi = {
    recorder: session,
    log: () => session.snapshot(),
    json: () => session.toJson(),
    count: () => session.count(),
    replay: (input: string | SessionLog | unknown, options?: { speed?: number }) => {
      const log =
        typeof input === 'string' ? parseSessionLog(input) : readSessionLog(input);
      if (!log) return null;
      replayHandle?.stop();
      // A replay starts from an empty world, exactly as the recorded session
      // did — otherwise the population guard sees a different history.
      creatures.clearAll();
      replayHandle = replaySession(log, replayDriver, {
        ...(options?.speed !== undefined ? { speed: options.speed } : {}),
      });
      return replayHandle;
    },
    stopReplay: () => replayHandle?.stop(),
    driver: replayDriver,
  };
  (window as Window & { __refworldSession?: unknown }).__refworldSession = sessionApi;

  // ── presentation tour (GENERATOR §scale+camera, PLAN §7.1) ────────────────
  // Autonomous drift between clusters, lone wanderers, and wide scenic beats.
  // Manual is the default; 't' toggles; the ghost panel has a mode select.
  const tour = createTour({
    cameraRig: world.cameraRig,
    positions: () => creatures.positions(),
  });
  // Any camera input interrupts the tour instantly. Capture phase, no
  // preventDefault — scene.ts's own pan/orbit/zoom handlers run untouched.
  canvas.addEventListener('pointerdown', () => tour.notifyUserInput(), { capture: true });
  canvas.addEventListener('wheel', () => tour.notifyUserInput(), {
    capture: true,
    passive: true,
  });

  // The two corners: the world minimap bottom-right, and the join code —
  // a qr of this room's drawing url — mirroring it bottom-left at the same
  // size (user ask). Together with the pencil control above the code, that
  // is the whole of the world's persistent chrome.
  installWorldMinimap({
    manager: creatures,
    cameraRig: world.cameraRig,
    scatter: world.scatter,
    mount: document.body,
  });

  installJoinQr({
    url: `${location.origin}/draw/?room=${room}&w=${epoch}`,
    mount: document.body,
  });

  ensureOverlayStyle();

  // No on-screen join line and no key hints (user ask): the frame is the
  // world, nothing else. The room still travels — it is written into this
  // page's own address below — and the ghost panel carries the controls.

  world.onFrame((dt, nowMs) => {
    creatures.update(dt, nowMs);
    tour.update(dt, nowMs);
  });

  // ── ghost panel on shift+d ────────────────────────────────────────────────
  // The panel ships in EVERY build (user decision — the generator brief's
  // presentation controls exist for live demos on the deployed link). It
  // stays a lazy chunk: in dev builds it mounts at boot; in production it
  // loads on the first shift+d, costing nothing until the presenter asks.
  let panelRequested = false;
  const mountPanel = (showOnMount: boolean): void => {
    if (panelRequested) return;
    panelRequested = true;
    let fallbackIndex = 0;
    void import('./dev').then((m) =>
      m.initDevPanel({
        scene: world.scene,
        camera: world.cameraRig.camera,
        renderer: world.renderer,
        onFrame: world.onFrame,
        creatures,
        tour,
        ink: world.ink,
        scatter: world.scatter,
        // Grain amplitude handle (QA audit D5): the panel slider and the
        // grain gate both ride the pass's single full-frame uniform.
        setGrainAmplitude: (v) => world.grain.setAmplitude(v),
        getGrainAmplitude: () => world.grain.getAmplitude(),
        // Paper color grade (shader style section): background + ground.
        setBackgroundColor: (c) => world.setBackgroundColor(c),
        // Outliner selection focus — the minimap's click-to-pan spring.
        focusAt: (x, z) => world.cameraRig.frameAt(new Vector3(x, 0, z)),
        // Weather handle from a parallel workstream — forwarded as-is and
        // feature-detected inside the panel, so this compiles either way.
        environment: (world as { environment?: unknown }).environment,
        // The operator layer reads and acts through the same gate the
        // feed goes through (src/moderation/gate.ts).
        moderation: gate,
        // The session log: the panel adds a readout and a download button.
        // The RECORDER itself is not dev-gated (it runs above); only this ui
        // for it is (src/session/, docs/SESSION.md).
        session,
        replaySession: (json) => sessionApi.replay(json) !== null,
        spawnFallback: (n) => {
          for (let i = 0; i < n; i++) {
            const strokes = m.FALLBACK_DRAWINGS[fallbackIndex % m.FALLBACK_DRAWINGS.length];
            if (!strokes) continue;
            // Through the gate like everything else, so the operator list
            // shows every creature standing in the world — not just the
            // ones a phone sent.
            gate.offer({
              id: `dev-fallback-${fallbackIndex++}`,
              name: null,
              personality: null,
              strokes,
              hatchMs: m.FALLBACK_HATCH_MS,
              source: 'dev',
            });
          }
        },
      }, { showOnMount }),
    );
  };
  if (__IS_DEV__) mountPanel(false);
  window.addEventListener('keydown', (event) => {
    if (event.shiftKey && (event.key === 'D' || event.key === 'd')) mountPanel(true);
  });

  // ── phones: the draw-to-3d feed ───────────────────────────────────────────
  // The world answers phones on the kit's down topic: a verdict for the
  // drawer who asked, and the session id it belongs to.
  let feed: Awaited<ReturnType<typeof connectWorldFeed>> = null;
  const tellPhone = (to: string, entry: { disposition: string; reason: string | null }): void => {
    feed?.publishToPhones({
      type: 'verdict',
      to,
      disposition: entry.disposition,
      // The screen's own wording is diagnostic, for the operator readout —
      // the phone shows the guideline line, not this.
      reason: entry.reason,
      epoch,
    });
  };

  void connectWorldFeed({
    room,
    onDrawing: (d) => {
      const entry = gate.offer({ ...d, hatchMs: HATCH_TIMER_MS, source: 'phone' });
      // Tell the drawer, on their own handset, when their drawing will
      // never appear (user ask). Still nothing on the projection: the
      // refusal is private to the person who made it.
      if (entry.disposition !== 'admitted') tellPhone(d.id, entry);
    },
    // A phone tapped its emote wheel. The drawer id it sends is the id the
    // world spawned it under, so the emote lands on THAT creature — and on
    // nobody else's (src/net/phoneLink.ts).
    onEmote: ({ from, emote }) => {
      creatures.emote(from, emote);
    },
    // A phone announced itself: answer with what happened to its drawing,
    // and with this world's session so a handset from a previous world
    // learns its creature is gone.
    onHello: ({ from }) => {
      const seen = gate.log().find((e) => e.id === from);
      if (seen && seen.disposition !== 'admitted') tellPhone(from, seen);
      else feed?.publishToPhones({ type: 'world', epoch });
    },
  }).then((handle) => {
    feed = handle;
  });

  // ── overlay (local, same-device drawing) ──────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'draw-overlay';

  const hint = document.createElement('div');
  hint.className = 'draw-hint';
  hint.textContent = 'draw a solid shape — it becomes a creature';

  // No pencil control on the projection (user ruling, 2026-08-20: "in the
  // 3d world let's remove the pencil button on the map"). The world is the
  // shared view — the audience draws on their own handsets, so a button
  // inviting a tap on a wall nobody can reach was a mark with no purpose.
  // The overlay is unchanged and still opens on `d` for local use.
  document.body.append(overlay);

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

  let localCount = 0;

  window.addEventListener('keydown', (event) => {
    // Shift+h — the hatch-all moment (GENERATOR set piece): pull wide over
    // the population, burst every shell at once, hold, then resume.
    if (
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      (event.key === 'H' || event.key === 'h') &&
      !overlayOpen
    ) {
      tour.hatchAllMoment(() => creatures.hatchAll());
      return;
    }
    // Other shifted presses belong to the dev surface (ghost panel toggles
    // on shift+d); plain d keeps the draw overlay.
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key === 'd') {
      if (overlayOpen) closeOverlay();
      else openOverlay();
      return;
    }
    // Camera tour toggle. Manual stays the default on load.
    if (event.key === 't' && !overlayOpen) {
      tour.setMode(tour.mode() === 'tour' ? 'manual' : 'tour');
      return;
    }
    // Manual hatch — every ready egg, identical sequence to the timer.
    if (event.key === 'h' && !overlayOpen) {
      creatures.hatchAll();
    }
    // Dev emote keys on the most recent character (PLAN §6.3).
    if (!overlayOpen && event.key >= '1' && event.key <= '7') {
      const name = EMOTE_NAMES[Number(event.key) - 1];
      // By id, not by character handle: the manager is the seam the session
      // log listens on, and it needs to know WHICH creature emoted.
      const id = creatures.latestId();
      if (name && id) creatures.emote(id, name, 'key');
    }
  });

  const drawScreen = mountDrawScreen(overlay, {
    onDone: (strokes) => {
      // Same gate as the phones: the local pad is not a bypass.
      const entry = gate.offer({
        id: `local-${localCount++}`,
        name: null,
        personality: null,
        strokes,
        hatchMs: HATCH_TIMER_MS,
        source: 'local',
      });
      // A refused or held drawing closes the overlay exactly like an
      // admitted one — the drawer is told nothing either way.
      const ok = entry.disposition !== 'unusable';
      if (!ok) {
        // No usable ink — keep the overlay open with one small lowercase line.
        hint.classList.add('visible');
        return;
      }
      hint.classList.remove('visible');
      drawScreen.capture.clear();
      closeOverlay();
    },
  });
  // Hint sits above the draw screen root; append after mounting.
  overlay.appendChild(hint);
}

main();
