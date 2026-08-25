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
import {
  announceEpochRetained,
  connectWorldFeed,
  PERSONALITIES,
  type IncomingDrawing,
} from './net/drawFeed';
import { createIngestGate } from './moderation/gate';
import { EMOTE_NAMES, isRoomCode, roomCode, type EmoteName } from './net/protocol';
import {
  createSessionRecorder,
  expectedCreatures,
  parseSessionLog,
  readSessionLog,
  recordCreatures,
  recordGate,
  replayNow,
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
 * How often a public world asks the server what it missed.
 *
 * Not a live channel — mqtt is that, and it is instant. This is the
 * backstop for the two cases mqtt cannot cover: drawings made while this
 * page was closed, and drawings made while its socket was down. Twenty
 * seconds is slow enough to be free and fast enough that a person who just
 * drew sees their creature before they put the phone away.
 */
const PUBLIC_POLL_MS = 20000;

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
/*
 * The operator line. A recovery that reports nothing is indistinguishable
 * from a recovery that did not run — which is exactly how an evening was
 * spent pressing a key that was working and saying so to nobody.
 *
 * Mark set stays legal: type and a hairline rule, no filled panel, no card,
 * no shadow. It slides, like everything else.
 */
.world-say {
  position: fixed;
  left: 50%;
  bottom: 4vmin;
  z-index: 20;
  transform: translate(-50%, 8px);
  padding-top: 0.6em;
  border-top: 1px solid ${WORLD.ink};
  color: ${WORLD.ink};
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  text-align: center;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.world-say.visible {
  opacity: 1;
  transform: translate(-50%, 0);
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
        saveSession();
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
  const gateRecorder = recordGate(session, { hatchMs: HATCH_TIMER_MS, source: 'phone' });
  const gate = createIngestGate<WorldDrawing>({
    observer: {
      ...gateRecorder,
      // Autosave hangs HERE, not on the network callback it used to hang on.
      // The gate is the one seam every drawing passes through — the phone
      // feed, the local overlay, the dev fallbacks — so a save wired to the
      // mqtt handler silently missed every drawing that did not arrive over
      // mqtt, and could be bypassed by any future ingest path. Wired to the
      // seam, it cannot be.
      decision(entry) {
        gateRecorder.decision(entry);
        saveSession();
      },
    },
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
    /**
     * RESTORE, not replay (recovery, 2026-08-21).
     *
     * A replay re-runs a session at the pace it was recorded — the right
     * thing for watching a session back, and the wrong thing for getting a
     * refreshed projection its population back, where a log spanning an
     * hour would trickle creatures in over an hour. Restore walks the same
     * log with `replayNow`: every spawn, hatch, emote and removal applied
     * at once, so the world lands in the state the log ends in.
     *
     * Same driver, same decisions, same ids — the pipeline is pure in
     * (strokes, id), so these are the identical creatures, not lookalikes.
     * Returns how many are standing, or null when the log will not parse.
     */
    restore: (input: string | SessionLog | unknown): number | null => {
      const log =
        typeof input === 'string' ? parseSessionLog(input) : readSessionLog(input);
      if (!log) return null;
      replayHandle?.stop();
      replayHandle = null;
      creatures.clearAll();
      replayNow(log, replayDriver);
      return expectedCreatures(log).length;
    },
    driver: replayDriver,
  };
  (window as Window & { __refworldSession?: unknown }).__refworldSession = sessionApi;

  /**
   * Autosave the session log to localStorage (recovery, 2026-08-20).
   *
   * The recorder was memory-only, so a refresh of the projection took the
   * whole population with it — the one failure the log most needed to
   * survive was the one that erased it. It is written after every drawing
   * now, which is the event that actually matters and is rare enough that
   * the cost is nothing.
   *
   * The previous session's log survives under its own epoch key, so a
   * refresh leaves the old one recoverable rather than immediately
   * overwriting it with an empty new one.
   */
  const SESSION_SAVE_PREFIX = 'refworld:session:';
  // NOT under SESSION_SAVE_PREFIX. It used to be `refworld:session:latest`,
  // which the scan below then read as a saved log and handed to JSON.parse —
  // an epoch is not json, the parse threw, and the throw took every real
  // entry after it out of the list with it. A pointer and the things it
  // points at do not share a namespace.
  const SESSION_LATEST_KEY = 'refworld:session-latest';
  /**
   * Why an autosave failed, or null while it is fine. Read by the panel and
   * by `__refworldSaveState`.
   *
   * The bare `catch {}` this replaces cost a real evening. The autosave was
   * failing on the projection and NOTHING said so — not the panel, not the
   * console, not the `r` key, which simply found no log and did nothing.
   * There was no way to learn that the one safeguard was off, and the first
   * anyone knew was a lost session. A recovery mechanism that can fail in
   * silence is not a recovery mechanism.
   */
  let saveError: string | null = null;
  let saveCount = 0;
  const saveSession = (): void => {
    const write = (): void => {
      localStorage.setItem(SESSION_SAVE_PREFIX + epoch, sessionApi.json());
      localStorage.setItem(SESSION_LATEST_KEY, epoch);
    };
    try {
      write();
      saveError = null;
      saveCount++;
      return;
    } catch (err) {
      // Almost always quota: a log carries every stroke of every drawing,
      // and localStorage is a few megabytes per origin. An old session's log
      // is worth less than this one's, so drop the oldest and try again
      // rather than failing the save that matters.
      const others = listSessions().filter((entry) => entry.epoch !== epoch);
      const oldest = others[others.length - 1];
      if (oldest) {
        try {
          localStorage.removeItem(SESSION_SAVE_PREFIX + oldest.epoch);
          write();
          saveError = null;
          saveCount++;
          return;
        } catch {
          /* fall through to reporting */
        }
      }
      saveError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      // Loud, once per distinct failure. The operator cannot fix what they
      // cannot see, and the panel readout below shows the same line.
      console.warn('[refworld] session autosave FAILED —', saveError);
    }
  };
  /** Is the safeguard actually on? One call, for the console and the panel. */
  (window as Window & { __refworldSaveState?: unknown }).__refworldSaveState = () => ({
    saves: saveCount,
    error: saveError,
    epoch,
    keys: Object.keys(localStorage).filter((k) => k.startsWith('refworld:')),
  });
  /** Every autosaved session, newest first, for the panel and the console. */
  (window as Window & { __refworldSessions?: unknown }).__refworldSessions = (): {
    epoch: string;
    events: number;
    json: string;
  }[] => {
    const out: { epoch: string; events: number; json: string }[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key === null || !key.startsWith(SESSION_SAVE_PREFIX)) continue;
        const json = localStorage.getItem(key);
        if (json === null) continue;
        // Per-entry, so one unreadable row cannot take the rest of the
        // list with it — the whole point of a recovery list is that it
        // still works when something in the store is wrong.
        let events = 0;
        try {
          const parsed: unknown = JSON.parse(json);
          if (!Array.isArray((parsed as { events?: unknown }).events)) continue;
          events = (parsed as { events: unknown[] }).events.length;
        } catch {
          continue;
        }
        out.push({ epoch: key.slice(SESSION_SAVE_PREFIX.length), events, json });
      }
    } catch {
      /* unreadable store — report what we managed to read */
    }
    return out.sort((a, b) => b.events - a.events);
  };
  const listSessions = (): { epoch: string; events: number; json: string }[] =>
    (
      window as Window & {
        __refworldSessions?: () => { epoch: string; events: number; json: string }[];
      }
    ).__refworldSessions?.() ?? [];

  /**
   * Bring back the last population WITHOUT the handsets (recovery, 2026-08-21).
   *
   * The recall on `r` asks every phone to re-publish, which needs the phones
   * to be awake, in earshot and still holding their drawing. This path needs
   * none of them: the projection wrote its own log to localStorage after
   * every drawing and every hatch, so the fullest log from a PREVIOUS epoch
   * is the population, and restoring it is a local operation.
   *
   * Fullest, not newest: a refresh mints a new epoch and immediately starts
   * an empty log, so "most recent" is reliably the one with nothing in it.
   * Returns the number of creatures restored — 0 when there is nothing to
   * restore, which is not a failure.
   */
  const restoreLastSession = (): number => {
    const mine = listSessions().filter((s) => s.epoch !== epoch && s.events > 0);
    const best = mine[0];
    if (!best) return 0;
    return sessionApi.restore(best.json) ?? 0;
  };
  (window as Window & { __refworldRestore?: unknown }).__refworldRestore =
    restoreLastSession;

  /**
   * `?restore=/some/log.json` — open a world straight onto a saved session.
   *
   * The panel's file picker needs the log on the machine running the
   * projection, which is the wrong shape for "here is the room we lost, go
   * and look at it": that wants a LINK. This is the same restore, addressed
   * by url.
   *
   * SAME-ORIGIN ONLY, and deliberately: a url that could name any host would
   * let a link hand this world a population from somewhere else entirely.
   * A leading slash, no scheme, no `//`.
   */
  const restoreParam = params.get('restore');
  if (restoreParam !== null && /^\/[\w./-]*$/.test(restoreParam) && !restoreParam.includes('//')) {
    void fetch(restoreParam)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => {
        const n = sessionApi.restore(text);
        say(
          n === null
            ? 'that file is not a session log this build reads'
            : `restored ${n} creature${n === 1 ? '' : 's'}`,
        );
      })
      .catch((err: unknown) => {
        say(`could not load ${restoreParam} — ${err instanceof Error ? err.message : 'failed'}`);
      });
  }

  /**
   * A PUBLIC world: `?world=public`.
   *
   * The installation world is ephemeral on purpose — drawings live in the
   * browser showing them, which is right for a room you can see and wrong
   * for a link anyone can open. With `?world=` this page also has a
   * history: it asks the server for every drawing admitted so far and
   * rebuilds them, then keeps the live mqtt feed for whatever arrives while
   * it is open.
   *
   * TWO CHANNELS, on purpose. mqtt is the live one and is instant; the api
   * is the durable one and is the only thing that survives nobody watching.
   * The poll below is the seam between them: it catches drawings that
   * arrived while this page was closed, or while its socket was down, and
   * it spawns them THROUGH THE GATE rather than restoring — a restore
   * clears the world, which would be a strange thing to do to a room every
   * twenty seconds.
   */
  const publicWorld = (params.get('world') ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  if (publicWorld.length > 0) {
    const endpoint = `/api/drawings?world=${encodeURIComponent(publicWorld)}`;

    /** Spawn a log's drawings, skipping anything already standing.
     * Returns the ids it actually admitted. */
    const absorb = (log: SessionLog): string[] => {
      const ids: string[] = [];
      for (const event of log.events) {
        if (event.k !== 'drawing') continue;
        if (creatures.has(event.id)) continue;
        const entry = gate.offer({
          id: event.id,
          name: event.name,
          personality: null,
          strokes: event.strokes,
          hatchMs: event.hatchMs,
          source: 'phone',
        });
        if (entry.disposition === 'admitted') ids.push(event.id);
      }
      return ids;
    };

    /**
     * The world's EXISTING POPULATION, shipped with the world.
     *
     * The creatures recovered from the designers-and-machines room are not
     * submissions — nobody is offering them and nobody is deciding on them.
     * They are what is already standing in this field, the way trees are.
     * So they load from a static asset rather than the store: no database
     * to reach, nothing to seed, nothing an operator has to run, and the
     * link works before any of that exists.
     *
     * It also means they cannot be moderated away or rate-limited, which is
     * right for an exhibit and would be wrong for a submission. Live
     * drawings layer on top and are governed normally.
     */
    const seedUrl = '/recovered/session.json';
    const loadSeed = async (): Promise<number> => {
      try {
        const res = await fetch(seedUrl, { cache: 'force-cache' });
        if (!res.ok) return 0;
        const log = readSessionLog(await res.json());
        if (!log) return 0;
        const ids = absorb(log);
        // Hatched AT ONCE, not through hatchAll(). The stagger exists so a
        // roomful of eggs opens one at a time and everybody gets their
        // moment — lovely for a live room, and wrong here twice over: these
        // creatures are already residents rather than arrivals, and at
        // 456ms apart a population of sixty-eight would take half a minute
        // to finish appearing to somebody who just opened a link.
        for (const id of ids) creatures.hatch(id);
        return ids.length;
      } catch {
        // An empty field is a worse landing than a slow one, but a missing
        // seed must not stop the live world from loading.
        return 0;
      }
    };

    const pull = async (first: boolean): Promise<void> => {
      let log: SessionLog | null = null;
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        log = readSessionLog(await res.json());
      } catch (err) {
        if (first) say(`could not reach the world — ${err instanceof Error ? err.message : 'failed'}`);
        return;
      }
      if (!log) return;
      // Additive, never a restore: anything already standing is left alone,
      // which is what lets this run every twenty seconds without disturbing
      // a world somebody is looking at.
      const added = absorb(log).length;
      if (added > 0) {
        // Public creatures arrive already grown: nobody is watching an egg
        // that hatched an hour ago on somebody else's screen.
        creatures.hatchAll();
        saveSession();
      }
      if (first) {
        say(
          added > 0
            ? `${added} creature${added === 1 ? '' : 's'} joined ${publicWorld}`
            : `${publicWorld} — draw the first new one`,
        );
      }
    };

    // The residents first, then whoever has joined since. In that order on
    // purpose: the seed is local and instant, the live pull is a network
    // round trip, and a person arriving should never see an empty field
    // while a request is in flight.
    void loadSeed().then(() => pull(true));
    window.setInterval(() => void pull(false), PUBLIC_POLL_MS);
  }

  /**
   * Say one line to the operator, on the projection.
   *
   * Used only by the recovery controls, and used by ALL of them: the whole
   * failure mode being closed here is a key that works, does its job, and
   * leaves the room unable to tell it apart from a key that is not wired.
   */
  let sayTimer = 0;
  const say = (line: string): void => {
    let el = document.querySelector<HTMLDivElement>('.world-say');
    if (!el) {
      el = document.createElement('div');
      el.className = 'world-say';
      // Announced, so this reaches an operator who is not looking at the
      // projection when they press the key.
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = line;
    requestAnimationFrame(() => el?.classList.add('visible'));
    window.clearTimeout(sayTimer);
    sayTimer = window.setTimeout(() => {
      el?.classList.remove('visible');
    }, MOTION.ambientMs);
  };

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
        restoreSession: (json) => sessionApi.restore(json),
        restoreLastSession: () => {
          const n = restoreLastSession();
          if (n > 0) saveSession();
          return n;
        },
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
  /**
   * Call every handset's drawing back (recovery, 2026-08-20).
   *
   * The session log lives in memory, so a refresh of the projection loses
   * the population. Every handset still holds its own drawing in
   * localStorage, and src/shape/ + src/inflate/ are pure — so re-publishing
   * those strokes under the same id rebuilds the IDENTICAL creatures, not
   * approximations. This asks them all to do that at once.
   *
   * Safe to press twice: the manager replaces a slot with the same id
   * rather than adding one, so a duplicate re-send is a no-op.
   */
  const recallDrawings = (): boolean => {
    if (!feed) return false;
    feed.publishToPhones({ type: 'recall', epoch });
    return true;
  };

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
    // Re-announce on every (re)connect, not only once at boot. The publish
    // below happens as soon as the feed object exists, which can be before
    // the socket is actually up; and a broker that drops us must be told
    // again, because a retained message lives on the broker and a new one
    // has never heard of this world.
    onStatus: (state) => {
      if (state === 'on') announceEpochRetained(feed, epoch);
    },
    onDrawing: (d) => {
      const entry = gate.offer({ ...d, hatchMs: HATCH_TIMER_MS, source: 'phone' });
      // (the autosave runs on the gate's own observer, above — every ingest
      // path is covered by it, so there is nothing to do here)
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
    // Say which world this is, RETAINED, the moment the feed is up. Every
    // handset that connects from here on is told immediately — including one
    // that wakes an hour from now — so a phone holding a drawing from a
    // previous session re-homes it without anyone pressing anything
    // (src/phone/main.ts, docs/SESSION.md §4a).
    announceEpochRetained(handle, epoch);
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
    // shift+R — rebuild the population after the projection was refreshed.
    //
    // SHIFTED, and that is not a style choice: the ghost panel binds plain
    // `r` to its transform gizmo's rotate mode, so with the panel open the
    // recovery key never reached this handler at all, and with it closed the
    // two bindings were one keystroke apart on the same key. A control you
    // reach for in a bad moment cannot be ambiguous.
    //
    // TWO sources, tried in the order that asks least of the room:
    //
    //   1. this machine's own autosaved log — instant, offline, needs
    //      nobody to be holding a phone;
    //   2. a recall to every handset, for anything the log missed (a
    //      drawing that arrived after the last save, a session logged on a
    //      different machine).
    //
    // Both are idempotent in the creature id, so running both is safe: the
    // manager replaces a slot with the same id rather than adding one.
    if (
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      (event.key === 'R' || event.key === 'r') &&
      !overlayOpen
    ) {
      const restored = restoreLastSession();
      const recalled = recallDrawings();
      if (restored > 0) saveSession();
      // Always says something. "nothing to restore" is a result, and the
      // operator needs it more than they need the happy path.
      const parts: string[] = [];
      parts.push(
        restored > 0
          ? `restored ${restored} from this machine`
          : 'nothing autosaved here to restore',
      );
      parts.push(recalled ? 'recall sent to the phones' : 'no connection — recall not sent');
      say(parts.join(' · '));
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
