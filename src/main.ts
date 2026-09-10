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
import {
  EMOTE_NAMES,
  isRoomCode,
  joinUrl,
  roomCode,
  roomForWorld,
  type EmoteName,
} from './net/protocol';
import { readKeepId } from './phone/keeplink';
import {
  DRIVE_INTERVAL_MS,
  DRIVE_STALE_MS,
  HOST_HEARTBEAT_MS,
  POSE_INTERVAL_MS,
  ROLE_SETTLE_MS,
  ROSTER_REPEAT_MS,
  eggsOpenedByHost,
  electHost,
  makeHostId,
  packPoses,
  pruneClaims,
  readWorldSyncMessage,
  unpackPoses,
} from './net/worldsync';
import {
  MAX_SCENE_EVENTS,
  createSessionRecorder,
  expectedCreatures,
  isSceneEvent,
  parseSessionLog,
  readSceneBatch,
  readSessionLog,
  recordCreatures,
  recordGate,
  replayNow,
  replaySession,
  type DrawingSource,
  type PaintEvent,
  type ReplayDriver,
  type ReplayHandle,
  type SceneEvent,
  type SessionLog,
} from './session';
import { createSceneOutbox, type SceneOutbox } from './net/sceneoutbox';
import type { SceneMessage } from './net/worldsync';
import type { DevSceneApi, DevSceneControls } from './dev';
import { TERRAIN_DEFAULTS } from './world/landscape';
import { MAX_POPULATION, WANDER_SPEED_DEFAULT } from './creatures/manager';
import { mountDrawScreen } from './draw/ui';
import { MOTION, SURFACE, WORLD } from './taste/tokens';
import { createPhoneLink } from './net/phoneLink';
import { epochFor, readSubmission } from './phone/identity';
import { mountWorldTray } from './world/tray';
import { createFollow } from './world/follow';
import { createCompanionPanel } from './world/companionpanel';
import { feedDrawingToStrokes } from './net/drawFeed';
import type { StrokeList } from './shape/types';
import { installJoinQr, QR_SIZE_CSS } from './ui/joinqr';
import { installWorldMinimap } from './ui/minimap';
import {
  mountJoystick,
  stickToWorld,
  STICK_REST,
  WORLD_REST,
  type WorldVector,
} from './world/joystick';
import { residentsFrom } from './world/residents';
import { readHatchMode } from './world/hatchmode';
import { storeNote } from './world/storeline';
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
 * How long a new creature spends as an egg in a PUBLIC world.
 *
 * The room's twenty seconds is paced for an audience watching a shared
 * screen together, with an operator holding the moment. Alone on a phone,
 * twenty seconds of watching an egg is just waiting — long enough to put
 * the phone away and miss the hatch you came for. Seven is long enough to
 * feel like something is happening to it and short enough to stay for.
 */
const PUBLIC_HATCH_MS = 7000;

/**
 * What this world offers its gate: the feed's drawing, the hatch delay it is
 * admitted with, and where it came in from. `source` exists only so the
 * session log can say whether a creature came from a phone, the local pad, or
 * a fixture (src/session/).
 */
type WorldDrawing = IncomingDrawing & {
  hatchMs: number;
  source: DrawingSource;
  /** Already standing when this page opened — spawn grown, with no egg. */
  grown?: boolean;
  /**
   * Part of the world rather than a submission: exempt from the population
   * guard's eviction order (SpawnOptions.resident).
   *
   * Deliberately separate from `grown`, which they share. Everything the
   * store held before this page opened is grown as well, and those are
   * people's drawings — evictable like any other. Only the seed is the
   * world itself.
   */
  resident?: boolean;
};

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
  /**
   * The world's NAME — read ONCE, here, and used for everything downstream:
   * the room, the store, the epoch, the redirect, the qr.
   *
   * Two sources, in this order:
   *   1. `?world=` — the query form, and still the one that wins;
   *   2. `<meta name="refworld:world">` — the page declaring its own world.
   *
   * The meta tag is how a client's own DEPLOYMENT names itself. A client
   * world is not a path on the public site — it is this same repo built and
   * deployed under its own hostname, and the build injects the tag (and the
   * matching unfurl card) into index.html from worlds.json. See
   * scripts/world-build.mjs. So the link a client is handed is an address,
   * not the public site with a setting stuck on the end of it.
   *
   * Nothing about the world itself moves: the name is the same, so the
   * derived room, the store partition and the drawings are the same ones
   * `/?world=<name>` reaches on the public site. Only the address differs.
   *
   * Sanitised identically whichever way it arrived (lowercase, [a-z0-9-],
   * up to 24 — docs/PUBLIC.md §urls), so an injected tag cannot name a
   * world a query string could not. The public build injects nothing, so it
   * behaves exactly as it did.
   *
   * Read before anything else for one reason: the mobile redirect below has
   * to carry it. A shared link is opened on a phone far more often than on
   * a laptop, and a phone that lands on `/draw/?room=…` with no world
   * publishes over mqtt and stores NOTHING. Their creature would appear on
   * any projection that happened to be open, then vanish with it, and
   * nothing anywhere would say a word about it. Dropping the world here was
   * silent data loss on the most travelled path in the whole thing.
   */
  const sanitizeWorld = (raw: string): string =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 24);
  const queryWorld = sanitizeWorld(params.get('world') ?? '');
  const pageWorld = queryWorld
    ? ''
    : sanitizeWorld(
        document.querySelector<HTMLMetaElement>('meta[name="refworld:world"]')?.content ?? '',
      );
  const worldName = queryWorld || pageWorld;
  const isPublic = worldName.length > 0;
  /** true when THIS page is the world's address, so the qr can encode it. */
  const declaredByPage = pageWorld.length > 0;
  /**
   * And whether this world opens with a population — the same build-time
   * injection, the same read-it-once. An absent tag is `shipped`, which is
   * what keeps the public page's html untouched. See src/world/residents.ts.
   */
  const residents = residentsFrom(
    document.querySelector<HTMLMetaElement>('meta[name="refworld:residents"]')?.content ?? null,
  );
  /**
   * And who opens the eggs here — the clock, or the person at the keyboard
   * (user ask, 2026-09-10: *"in the demo let's pause the hatching until I
   * press h on the keyboard"*).
   *
   * Read once, here, beside the world's own name and for the same reason:
   * everything downstream — the manager's timer, what the roster carries,
   * what a first pull spawns, what the handsets are told about a countdown
   * — has to be answering the same question. `?hatch=manual|timer` on the
   * address overrides the baked tag, for a preview or a rehearsal without a
   * deploy. See src/world/hatchmode.ts.
   */
  const hatchMode = readHatchMode(
    params.get('hatch'),
    document.querySelector<HTMLMetaElement>('meta[name="refworld:hatch"]')?.content ?? null,
  );
  /**
   * What the handsets are told about that (src/net/phoneLink.ts).
   *
   * The wait screen draws a countdown off a number, and a countdown that
   * runs out while the egg sits there is the page telling somebody
   * something untrue about their own creature. `0` says there is no clock
   * here, and the forecast goes rather than lying.
   *
   * Only a named world says anything. An installation handset's flow is
   * the one this project shipped with and is not this ask's to change.
   */
  const phoneHatchMs = isPublic ? (hatchMode === 'timer' ? PUBLIC_HATCH_MS : 0) : undefined;

  /*
   * A named world always meets in the same room; only an unnamed one mints
   * a fresh code. Without this every visitor to the public link got a
   * private mqtt topic — see roomForWorld().
   *
   * An explicit `?room=` still wins, so a projection can be pinned to a
   * room of its own inside a public world if that is ever wanted.
   */
  const room = isRoomCode(fromUrl)
    ? fromUrl
    : worldName
      ? roomForWorld(worldName)
      : roomCode(Math.random);

  const worldParam = isPublic ? `&world=${encodeURIComponent(worldName)}` : '';

  /**
   * A phone opening the world link goes to the drawing UI for this room —
   * the mobile view IS the kit's draw page (user decision).
   *
   * UNLESS it asked for the world. `?view=world` is a person on a handset
   * who has already drawn and wants to see the place their creature lives:
   * the shared world is the whole point of having added to it, and until
   * now it was the one thing the people who built it could not look at.
   */
  /*
   * A KEEP LINK goes straight to the device (src/phone/keepsake.ts).
   *
   * Somebody following one is asking for one creature, not for the world
   * and not for a drawing pad. So it is routed before anything else here,
   * and on EVERY device rather than only a handheld: a link that opened a
   * creature on a phone and a landscape of strangers on a laptop would be
   * two different links wearing one address.
   *
   * The room travels with it because the companion needs one to emote
   * over, and in a named world it is derived rather than remembered — so
   * a link that has been sitting in somebody's messages for a month still
   * arrives in the right room.
   */
  const keepLinkId = readKeepId(params);
  if (keepLinkId !== null && isPublic) {
    location.replace(
      `/phone.html?room=${room}&world=${encodeURIComponent(worldName)}&keep=${encodeURIComponent(keepLinkId)}`,
    );
    return;
  }

  const wantsWorldView = params.get('view') === 'world';
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 620;
  const handheld = coarse && small;
  if (handheld && !wantsWorldView) {
    location.replace(`/draw/?room=${room}${worldParam}`);
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

  /**
   * The operator's secret, taken off the address once and kept on the device.
   *
   * 2026-09-09, the demo plan: the operator opens the projection, sculpts the
   * world in front of the room, and what they sculpt has to be KEPT — which
   * means writing to `/api/scene`, which is the moderator's endpoint
   * (docs/PUBLIC.md §the scene). A projection has no login and nowhere to
   * type, so it arrives as `?mod=<secret>`.
   *
   * And leaves again immediately. The url on the projection is the url people
   * photograph off the wall and the one an operator copies to send round; a
   * share link carrying the secret would hand the room's whole world to
   * whoever read it over somebody's shoulder. So it is stored, stripped from
   * the address with `replaceState`, and never printed — not in a readout,
   * not in an error, not in the `scene` line, which says only whether writing
   * worked.
   */
  const MODERATOR_KEY = 'refworld:moderator';
  const readModeratorSecret = (): string => {
    const given = params.get('mod') ?? '';
    if (given) {
      try {
        localStorage.setItem(MODERATOR_KEY, given);
      } catch {
        // A browser with storage off still gets this session's secret — it
        // is in the closure below either way.
      }
      params.delete('mod');
      history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
      return given;
    }
    try {
      return localStorage.getItem(MODERATOR_KEY) ?? '';
    } catch {
      return '';
    }
  };
  const moderatorSecret = readModeratorSecret();

  // ── the landscape mode ────────────────────────────────────────────────────
  /*
   * The world OPENS PLAIN (src/world/landscape.ts): a flat field of scattered
   * props on flat paper, with the authored map — forest, range, lake, island,
   * ponds, reeds, elevation — switched on live from the ghost panel in front
   * of the audience (2026-09-09, user ask).
   *
   * The panel is dev chrome and tree-shakes out of the demo build, so the
   * mode also has to be reachable from the ADDRESS: `?landscape=1` (or
   * `landscape=on`) opens the world with the map already revealed, which is
   * the only way to get it on a deployed link. Read here, next to `?world=`,
   * and applied before a single creature spawns — the eggs land on the ground
   * the world is going to keep.
   */
  const landscapeParam = (params.get('landscape') ?? '').toLowerCase();
  const wantsLandscape = landscapeParam === '1' || landscapeParam === 'on';
  if (wantsLandscape) world.setLandscape(true);
  /**
   * …and the panel's own toggle writes the same parameter back, the way the
   * minted room is written back above: a reload during a demo keeps the world
   * the operator had built up instead of dropping it back to the flat field.
   */
  const writeLandscapeParam = (on: boolean): void => {
    if (on) params.set('landscape', '1');
    else params.delete('landscape');
    history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
  };

  // ── world session ────────────────────────────────────────────────────────
  // A world page load is a NEW world: nothing survives a refresh, so every
  // creature drawn into the previous session is gone. The session id says
  // which world is running; it travels in the join code and in every reply
  // to a phone, so a handset holding a creature this world never knew is
  // let in to draw again instead of being locked out forever (user ask).
  /*
   * A PUBLIC world's session id is the world, not the page.
   *
   * A random one per load is right for an installation: a refresh really
   * is a new world, and a handset holding a creature the new world never
   * knew has to be let in to draw again. But a public world is persistent
   * — its drawings live in the store, not in this tab — and every viewer
   * announces this id to the handsets in the room, RETAINED. With one id
   * per page, two viewers meant phones being told the world had changed
   * every time either of them announced, and drawings going stale that
   * were not.
   *
   * Derived from the world's name, so every viewer of it, on every device,
   * across every reload, announces the same thing.
   */
  const epoch = isPublic
    ? `w-${worldName}`
    : 'w' + Math.floor(Math.random() * 0xffffffff).toString(36);

  /*
   * WHAT THE HANDSETS ARE TOLD THIS WORLD IS (user ask, 2026-09-09: *"if we
   * reset the URL we should also reset the characters that are within that
   * room"*).
   *
   * `epoch` above is this page's own — the session log's id, the autosave
   * key, a local fact. What goes ON THE WIRE carries the world's GENERATION
   * too: `w-<world>-g<n>`, where n counts up every time a moderator resets
   * the world (api/_store.ts `resetWorld`). That suffix is the whole
   * mechanism — a handset compares the generation its drawing was admitted
   * under against the one being announced, and a drawing from an older one
   * stops being offered (src/phone/identity.ts `generationVerdict`).
   *
   * NULL UNTIL THE WORLD HAS READ ITS OWN GENERATION. The number lives in
   * the store and arrives on the first pull, so announcing before then would
   * mean announcing an epoch this page is about to take back — every phone
   * in the room told the world changed, twice, at boot. Silence is the
   * honest state: a handset that has heard no epoch behaves exactly as it
   * does when no world is running, which is to leave its drawing alone.
   *
   * An installation world has no store and no generation to read, so it is
   * known from the start and nothing about it changes.
   */
  let publishedEpoch: string | null = isPublic ? null : epoch;
  /** The epoch to put on a wire message, or '' when there is nothing honest
   * to say yet. `announceEpochRetained` already treats '' as "do not". */
  const wireEpoch = (): string => publishedEpoch ?? '';

  // ── session recorder (src/session/, docs/SESSION.md) ──────────────────────
  // Ships in EVERY build, not just dev: a live event is exactly when you want
  // the log. It records inputs and decisions — stroke lists, ids, moderation
  // verdicts, operator taps — at ms offsets from now, and nothing per frame,
  // because generation is deterministic in (strokes, id) and replay re-derives
  // the rest. Only the panel button that downloads it is dev-gated.
  /**
   * Are we APPLYING a scene change from somewhere else right now?
   *
   * The scene layer both records and broadcasts through the same seam, so a
   * remote change written into this page's log would go straight back out
   * again and round the room forever. This says "this one came from
   * outside" and is held for exactly the synchronous call that records it
   * (see `recordScene`) — never across an await, or the operator's own
   * strokes during a load would be swallowed with it.
   */
  let applyingScene = false;
  /** Set below, and only in a public world — see the scene section. */
  let sceneOutbox: SceneOutbox | null = null;

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
    /**
     * THE SCENE LAYER'S ONE TAP (docs/SESSION.md §6).
     *
     * Every landscape switch, terrain dial and dab of the brush already
     * passes through the recorder — the log has been the canonical record of
     * them since the panel was wired. So the thing that makes them reach the
     * other screens hangs HERE, on the seam they all already cross, rather
     * than on each control: a sculpting route that did not reach the room
     * would be a hand on the world nobody else saw, which is the same
     * argument that put the autosave on the gate's observer.
     */
    onEvent: (event) => {
      if (applyingScene) return;
      if (!isSceneEvent(event)) return;
      sceneOutbox?.push(event);
    },
  });

  // The world calls the hatch, so the world announces it: the handset plays
  // its own hatch off this edge instead of running an independent timer,
  // which is what made the creature appear on the projection and, seconds
  // later and unrelated, on the phone (user report).
  // A public world hatches on a timer: in a room an operator presses `h`
  // and the whole clutch opens together, which is the moment everybody came
  // for. On a link there is no operator and nobody to wait for, and an egg
  // that never hatches is a person who drew something and got nothing.
  //
  // UNLESS the world says otherwise (user ask, 2026-09-10: *"in the demo
  // let's pause the hatching until I press h on the keyboard"*). A world
  // with somebody standing in front of it is a room again, link or not:
  // `hatch: manual` in worlds.json takes the clock away and hands the
  // moment back to the operator (src/world/hatchmode.ts).
  /**
   * Send one hatch to every other screen. Wired by `startWorldSync`.
   *
   * NOT queued while there is no socket, unlike a scene batch. A hatch is a
   * moment: publishing a backlog of them the instant a broker came back
   * would break a clutch of shells open at once, seconds after the room
   * watched them open, which is a worse lie than the one it fixes. The
   * late-joiner's copy comes from the roster's `eggs` instead — a state,
   * which is the right shape for catching up (src/net/worldsync.ts).
   */
  let publishHatch: (who: string) => void = () => {};

  const recorder = recordCreatures(session);
  const creatures = createCreatureManager(world, {
    autoHatch: isPublic && hatchMode === 'timer',
    observer: {
      ...recorder,
      /**
       * A shell opened HERE — and every other screen has to open it too.
       *
       * The one seam every hatch crosses, whichever opened it: the `h` key,
       * `shift+h`, the panel's button, the egg's own timer. So the two
       * things a hatch owes the rest of the world hang here rather than on
       * each of those — the same argument as the gate's autosave.
       *
       * Both are the HOST's to send. A viewer only ever hatches because it
       * was told to (see startWorldSync), and a viewer that answered back
       * would tell the drawer's phone twice and put the hatch round the
       * room again forever.
       */
      hatch(id, cause) {
        recorder.hatch(id, cause);
        if (isHostNow()) {
          feed?.publishToPhones({ type: 'hatched', to: id, epoch: wireEpoch() });
          publishHatch(id);
        }
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
        ...(d.grown === true ? { grown: true } : {}),
        ...(d.resident === true ? { resident: true } : {}),
      }),
    clear: (id) => creatures.clear(id),
    live: (id) => creatures.has(id),
  });
  // Tiny always-on probe, same family as __refworldCreatures in the manager:
  // the moderation smoke reads decisions and drives hold/block from outside
  // the panel. Read-only handles to what the panel already exposes.
  (window as Window & { __refworldModeration?: unknown }).__refworldModeration = gate;

  /**
   * STEERING, and the record of it (docs/SESSION.md §drive).
   *
   * The one seam every drive goes through on the page that simulates —
   * this handset's own stick, a viewer's intent arriving over the wire, and
   * the expiry that lets go for a phone that stopped talking. Same argument
   * as the gate: a route that steered a creature without passing here would
   * be a hand on the world that the log never saw, and there would be no way
   * to tell from the recording that anybody touched it.
   *
   * The recorder does the thinning (quantised heading and magnitude, one
   * event per creature per MOTION.tertiaryMs, the release exempt and
   * recorded once), so this stays a straight pass-through and no caller has
   * to know how often is too often.
   */
  const applyDrive = (id: string, vec: WorldVector | null): void => {
    const push = vec && vec.mag > 0 ? vec : null;
    creatures.drive(id, push);
    session.drive(id, push);
  };

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
    // Steering, replayed. NOT through applyDrive: that seam records, and a
    // replay re-driving the log back into the log would grow it every time
    // it was watched.
    drive: (id, vec) => {
      creatures.drive(id, vec);
    },
    /*
     * A dab of terrain, replayed.
     *
     * Only when the paint skill is mounted — the brush is dev-gated and
     * arrives by dynamic import, so a demo build has nowhere to put a
     * stamp and the events pass through unread. Same rule as the world
     * controls below: what this page cannot drive is skipped, never faked.
     */
    paint: (event) => {
      const probe = (window as Window & { __refworldPaint?: { applyPaint?(e: unknown): void } })
        .__refworldPaint;
      probe?.applyPaint?.(event);
    },
    // The operator state a replayed world should stand in: hold mode and the
    // block list. Removals are driven by replay itself, above.
    operator: (action, id, on) => {
      if (action === 'hold') gate.setHoldAll(on === true);
      else if (action === 'block' && id !== null) gate.block(id);
    },
    // World controls an operator moved. Only the handles this page owns —
    // anything it cannot drive is skipped rather than faked.
    world: (field, value, kind) => {
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
      } else if (field === 'landscape') {
        // The map on or off. Recorded as 1/0 by the panel; a boolean is
        // accepted too, so a hand-written log reads the way it looks.
        world.setLandscape(value === 1 || value === true);
      } else if (field === 'terrain' && typeof value === 'number') {
        // One event per dial, the dial's name in `kind` — the same shape as
        // kindDensity/kindScale (docs/SESSION.md §world). Anything else in
        // `kind` is skipped rather than faked.
        if (kind === 'elevation' || kind === 'tierStep' || kind === 'relief') {
          world.setTerrain({ [kind]: value });
        }
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
   * What a frame actually costs. Same family as the probes above.
   *
   * Draw calls are the number that decides whether a room of three hundred
   * creatures runs, and it is invisible from the outside — a world that
   * looks identical can be spending twice as much to draw itself. This is
   * how a load test says something other than "it felt alright".
   */
  (window as Window & { __refworldRender?: unknown }).__refworldRender =
    async (): Promise<unknown> => {
      const info = world.renderer.info;
      /*
       * A FRAME here is several render passes — the ink pass, then grain
       * composing over it — and `info.render` resets on every one of them.
       * Read it after the fact and you get the last pass alone, which for
       * this pipeline is one fullscreen triangle and reads as a world that
       * costs nothing to draw.
       *
       * So: stop the auto-reset, clear, let exactly one frame go by, read
       * the accumulated total, and put the renderer back as it was found.
       */
      info.autoReset = false;
      info.reset();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const drawCalls = info.render.calls;
      const triangles = info.render.triangles;
      info.autoReset = true;
      info.reset();

      let objects = 0;
      let meshes = 0;
      /*
       * Triangles BY WHAT DREW THEM. A total says a frame is expensive; it
       * does not say whether that is thirty creatures or one field of
       * grass, and those have opposite fixes.
       */
      const byOwner: Record<string, { tris: number; meshes: number }> = {};
      world.scene.traverse((o) => {
        objects++;
        const mesh = o as unknown as {
          isMesh?: boolean;
          isInstancedMesh?: boolean;
          count?: number;
          name?: string;
          geometry?: { index?: { count: number }; attributes?: { position?: { count: number } } };
          parent?: { name?: string } | null;
        };
        if (!mesh.isMesh) return;
        meshes++;
        const g = mesh.geometry;
        const verts = g?.index?.count ?? g?.attributes?.position?.count ?? 0;
        const instances = mesh.isInstancedMesh ? (mesh.count ?? 1) : 1;
        // Walk UP to whatever named thing owns this mesh. A creature's
        // meshes sit two levels under its named root, so stopping at the
        // immediate parent files every one of them under "unnamed" — which
        // is the bucket you least want to be the biggest.
        let owner = mesh.name ?? '';
        let up = mesh.parent as { name?: string; parent?: unknown } | null | undefined;
        while (!owner && up) {
          owner = up.name ?? '';
          up = up.parent as { name?: string; parent?: unknown } | null | undefined;
        }
        const key = owner.startsWith('creature ')
          ? 'creatures'
          : owner.startsWith('egg ')
            ? 'eggs'
            : owner.replace(/ \(\d+\)$/, '') || 'unnamed';
        const bucket = (byOwner[key] ??= { tris: 0, meshes: 0 });
        bucket.tris += Math.floor(verts / 3) * instances;
        bucket.meshes += instances;
      });
      // One creature, mesh by mesh — a per-creature total says they are
      // expensive, not WHICH part of one is.
      const oneCreature: { name: string; tris: number; verts: number }[] = [];
      let sample: { children?: unknown[] } | null = null;
      world.scene.traverse((o) => {
        const named = o as { name?: string };
        if (!sample && named.name?.startsWith('creature ')) {
          sample = o as unknown as { children?: unknown[] };
          (o as unknown as { traverse(cb: (c: unknown) => void): void }).traverse((c) => {
            const m = c as {
              isMesh?: boolean;
              name?: string;
              geometry?: {
                index?: { count: number };
                attributes?: { position?: { count: number } };
              };
            };
            if (!m.isMesh) return;
            const verts = m.geometry?.attributes?.position?.count ?? 0;
            const idx = m.geometry?.index?.count ?? verts;
            oneCreature.push({ name: m.name || '(unnamed part)', tris: Math.floor(idx / 3), verts });
          });
        }
      });

      const sorted = Object.entries(byOwner).sort((a, b) => b[1].tris - a[1].tris);
      const sceneTris = sorted.reduce((n, [, v]) => n + v.tris, 0);
      return {
        creatures: creatures.count(),
        drawCalls,
        triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        objects,
        meshes,
        sceneTris,
        // Everything, not a top-n: the bucket you are not shown is the one
        // that turns out to be the problem.
        byOwner: sorted,
        oneCreature: oneCreature.sort((a, b) => b.tris - a.tris),
      };
    };

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
  // ── the scene: shared and stored (docs/SESSION.md §6) ─────────────────────
  /*
   * 2026-09-09, the demo plan: *"update the url without resetting the scene
   * and losing everyone's eggs… then I'll start painting and manipulating the
   * scene"* — and every phone in the room is looking at THIS SAME PAGE, each
   * running its own copy of it.
   *
   * The drawings already survived both of those. The world they stand in did
   * not: the landscape switch, the three terrain dials and every dab of the
   * brush lived in the page that made them, so a phone watching the world saw
   * the flat plain the world ships as, and a redeploy threw the evening's
   * sculpting away while the creatures came back grown.
   *
   * NO SECOND MECHANISM. Those changes are already session events with a
   * replay driver that applies them; this ships that same subset over the
   * sync topic and into `refworld:<world>:scene`, and every page applies a
   * foreign one through the SAME driver. Nothing here can move the ground in
   * a way a recorded log could not.
   */

  /** The world's own scene endpoint. */
  const sceneEndpoint = `/api/scene?world=${encodeURIComponent(worldName)}`;

  /**
   * [D] Dabs stamped between yields when a stored scene is being laid down.
   *
   * Same argument as `absorb` below, for the other expensive thing a page
   * does on arrival: a batch of stamps is cheap but the ground re-cut that
   * follows one is ~300ms, and a phone that froze for the length of somebody
   * else's afternoon of painting is a broken page, not a slow one. Fifty at a
   * time reads as the terrain rising in increments, which is a better landing
   * than a blank world that suddenly has hills.
   */
  const SCENE_STAMPS_PER_FRAME = 50;

  /** Publish on the sync topic. Set by `startWorldSync` once it has a client
   * and an id; anything sent before then waits here rather than being lost —
   * a stroke made in the first second of a demo is still a stroke. */
  let publishScene: ((message: Omit<SceneMessage, 'id'>) => void) | null = null;
  const sceneBacklog: Omit<SceneMessage, 'id'>[] = [];
  const sendScene = (message: Omit<SceneMessage, 'id'>): void => {
    if (publishScene) publishScene(message);
    else sceneBacklog.push(message);
  };

  let sceneSeq = 0;
  let sceneCount = 0;
  /** What the store said last, in the words the readout uses. */
  let sceneStored = 'not stored (no secret)';
  /** The panel's widgets, once it has mounted and handed them over. */
  let sceneControls: DevSceneControls | null = null;

  const sceneStatus = (): string =>
    `scene · ${sceneCount} event${sceneCount === 1 ? '' : 's'} · ${sceneStored}`;
  const refreshScene = (): void => sceneControls?.status(sceneStatus());

  /** The brush, if this build has one mounted. Reached by name, never by
   * import: src/dev/ tree-shakes out of the demo build, and a page with no
   * brush skips the dabs rather than faking them (same rule as
   * `replayDriver.paint`). */
  type PaintProbeLike = {
    applyPaint?(event: PaintEvent): void;
    applyPaintBatch?(events: readonly PaintEvent[]): void;
  };
  const paintProbe = (): PaintProbeLike | undefined =>
    (window as Window & { __refworldPaint?: PaintProbeLike }).__refworldPaint;

  /** Dabs that arrived before the brush did — the paint skill is a dynamic
   * import behind the panel, so on every page there is a second or two where
   * a stored dab has nowhere to land. */
  let paintPending: PaintEvent[] = [];

  const applyPaintSlices = async (events: readonly PaintEvent[]): Promise<void> => {
    const probe = paintProbe();
    if (!probe) {
      paintPending.push(...events);
      return;
    }
    for (let i = 0; i < events.length; i += SCENE_STAMPS_PER_FRAME) {
      const slice = events.slice(i, i + SCENE_STAMPS_PER_FRAME);
      // One re-cut per slice, not per dab: `applyPaint` rebuilds on the
      // stroke throttle, which a tight loop of stamps clears every time
      // (src/dev/paint.ts `applyPaintBatch`).
      if (probe.applyPaintBatch) probe.applyPaintBatch(slice);
      else for (const event of slice) probe.applyPaint?.(event);
      if (i + SCENE_STAMPS_PER_FRAME < events.length) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
  };

  /** The brush turned up: lay down whatever was waiting for it. The event is
   * dispatched by src/dev/paint.ts (`PAINT_READY_EVENT`), named here as a
   * string for the same reason the probe is — this file must not import the
   * dev surface. */
  window.addEventListener('refworld:paint-ready', () => {
    if (paintPending.length === 0) return;
    const queued = paintPending;
    paintPending = [];
    void applyPaintSlices(queued);
  });

  /** Move the panel's own widgets to match a change this page did not make.
   * Setting a ghost-panel control's value does not fire its `onChange`, so
   * this cannot loop back onto the wire. */
  const reflectScene = (event: SceneEvent): void => {
    if (event.k !== 'world' || !sceneControls) return;
    if (event.field === 'landscape') {
      sceneControls.landscape(event.value === 1 || event.value === true);
      return;
    }
    if (event.field === 'terrain' && typeof event.value === 'number' && event.kind) {
      sceneControls.terrain(event.kind, event.value);
    }
  };

  /** Apply a run of scene events IN ORDER — a flatten depends on the ground
   * it is flattening, and a landscape switch decides what a dab lands on, so
   * the paint runs are batched but never floated past a world event. */
  const applySceneEvents = async (events: readonly SceneEvent[]): Promise<void> => {
    let run: PaintEvent[] = [];
    for (const event of events) {
      if (event.k === 'paint') {
        run.push(event);
        continue;
      }
      if (run.length > 0) {
        await applyPaintSlices(run);
        run = [];
      }
      replayDriver.world?.(event.field, event.value, event.kind);
      reflectScene(event);
    }
    if (run.length > 0) await applyPaintSlices(run);
  };

  /**
   * Write one event from elsewhere into THIS page's log.
   *
   * Only on the page that simulates, so a room with two screens open does not
   * log the room's sculpting twice — the same rule `keep` follows. The guard
   * is what stops the recorder's tap sending it straight back out.
   */
  const recordScene = (event: SceneEvent): void => {
    applyingScene = true;
    try {
      if (event.k === 'world') session.world(event.field, event.value, event.kind);
      else session.paint(event);
    } finally {
      applyingScene = false;
    }
  };

  /** Put this page's ground back to the world as it ships. The local half of
   * a reset, so a `reset` off the wire and the panel's own button do exactly
   * the same thing. */
  const clearSceneHere = (): void => {
    world.setLandscape(false);
    writeLandscapeParam(false);
    world.setTerrain({ ...TERRAIN_DEFAULTS });
    paintPending = [];
    const probe = paintProbe();
    const cleared: PaintEvent = { k: 'paint', t: 0, tool: 'clear' };
    if (probe?.applyPaintBatch) probe.applyPaintBatch([cleared]);
    else probe?.applyPaint?.(cleared);
    sceneControls?.landscape(false);
    sceneControls?.terrain('elevation', TERRAIN_DEFAULTS.elevation);
    sceneControls?.terrain('tierStep', TERRAIN_DEFAULTS.tierStep);
    sceneControls?.terrain('relief', TERRAIN_DEFAULTS.relief);
  };

  /** A scene message off the sync topic. Acted on by every page, host or
   * viewer — this is the ground each of them is drawing for itself. */
  const receiveScene = (message: { events: SceneEvent[]; reset?: true }): void => {
    if (message.reset === true) {
      clearSceneHere();
      sceneCount = 0;
      refreshScene();
      return;
    }
    if (message.events.length === 0) return;
    // The log on the page that simulates carries the WHOLE room's sculpting,
    // so a downloaded session plays back the world people actually watched
    // rather than only the half this screen made.
    if (isHostNow()) for (const event of message.events) recordScene(event);
    sceneCount += message.events.length;
    refreshScene();
    void applySceneEvents(message.events);
  };

  /**
   * Keep a batch. Fire-and-forget, and deliberately AFTER the broadcast: the
   * room seeing the ground move is the thing that must not wait on a
   * database, and a store that is missing or refusing costs the readout a
   * line, never the demo a stroke.
   */
  const storeScene = async (body: { events?: SceneEvent[]; reset?: true }): Promise<void> => {
    if (!moderatorSecret) {
      sceneStored = 'not stored (no secret)';
      refreshScene();
      return;
    }
    try {
      const res = await fetch(sceneEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-moderator': moderatorSecret },
        body: JSON.stringify(body),
        // The last flush of a demo happens as the page is going away.
        keepalive: true,
      });
      sceneStored = res.ok
        ? 'stored'
        : res.status === 404
          ? 'not stored (404: wrong secret)'
          : res.status === 503
            ? 'no store on this deployment'
            : `not stored (${res.status})`;
    } catch {
      sceneStored = 'not stored (unreachable)';
    }
    refreshScene();
  };

  /**
   * The scene this world already has, ONCE, on arrival.
   *
   * Not recorded. It is history — it happened before this page opened — and
   * writing it into this session's log would both re-broadcast a world back
   * at the room and make every viewer's download a copy of everyone else's.
   * Exactly the rule the grown drawings follow.
   */
  const loadScene = async (): Promise<void> => {
    let events: SceneEvent[] = [];
    try {
      const res = await fetch(sceneEndpoint, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { events?: unknown; store?: unknown };
      // The stored list may be far longer than one wire batch — that cap is
      // about what a broker will carry, not about what a world may have.
      events = readSceneBatch(body.events, MAX_SCENE_EVENTS);
      if (body.store === 'none') sceneStored = 'no store on this deployment';
    } catch {
      // A world with no scene, or a store that cannot be reached, is a world
      // that opens on the plain. That is what it opens on anyway.
      return;
    }
    sceneCount = events.length;
    refreshScene();
    await applySceneEvents(events);
  };

  if (isPublic) {
    sceneOutbox = createSceneOutbox({
      // From the tokens, never a literal: one tertiary beat is the shortest
      // interval this project treats as a movement anybody perceives, so it
      // is also the shortest at which "the ground changed" is worth a packet.
      delayMs: MOTION.tertiaryMs,
      send: (batch) => {
        sendScene({ t: 'scene', seq: sceneSeq++, events: batch });
        sceneCount += batch.length;
        refreshScene();
        void storeScene({ events: batch });
      },
    });
    // The stroke somebody was in the middle of when they closed the laptop.
    window.addEventListener('pagehide', () => sceneOutbox?.flush());
    void loadScene();
  }

  /** The panel's half of all this (src/dev/index.ts `scene` folder). Only in
   * a public world: an installation room is one projection with nobody to
   * agree with, and a reset button that reset nothing would be a control that
   * lies. */
  const sceneSync: DevSceneApi = {
    status: sceneStatus,
    /*
     * START THE WORLD OVER (user ask, 2026-09-09/10: *"if we reset the URL
     * we should also reset the characters that are within that room"* …
     * *"let's clear out any existing characters right now so we start
     * clean"*).
     *
     * `reset scene` puts the GROUND back; this puts the POPULATION back —
     * the drawings, the device claims that would refuse those people a
     * second creature, and the scene with them. It is the moderator's
     * endpoint, so it needs the secret the projection was opened with
     * (`?mod=`), and it says so rather than failing quietly.
     *
     * Then it reloads, because the generation is read on load: the page
     * that asked for the reset is also a page full of creatures that no
     * longer exist anywhere, and the shortest honest way to stop showing
     * them is to open the world again.
     */
    resetWorld: () => {
      if (!moderatorSecret) {
        sceneStored = 'world not reset (no secret — open with ?mod=)';
        refreshScene();
        return;
      }
      sceneStored = 'resetting the world…';
      refreshScene();
      void (async () => {
        try {
          const res = await fetch(`/api/moderate?world=${encodeURIComponent(worldName)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-moderator': moderatorSecret },
            body: JSON.stringify({ reset: true }),
          });
          if (!res.ok) {
            sceneStored =
              res.status === 404
                ? 'world not reset (404: wrong secret)'
                : res.status === 503
                  ? 'no store on this deployment'
                  : `world not reset (${res.status})`;
            refreshScene();
            return;
          }
          location.reload();
        } catch {
          sceneStored = 'world not reset (unreachable)';
          refreshScene();
        }
      })();
    },
    reset: () => {
      clearSceneHere();
      sceneCount = 0;
      refreshScene();
      sendScene({ t: 'scene', seq: sceneSeq++, events: [], reset: true });
      void storeScene({ reset: true });
    },
    bind: (controls) => {
      sceneControls = controls;
      refreshScene();
    },
  };

  if (isPublic) {
    const endpoint = `/api/drawings?world=${encodeURIComponent(worldName)}`;

    /**
     * Spawn a log's drawings, A FEW PER FRAME.
     *
     * Building a creature is the whole pure pipeline — rasterise, distance
     * transform, marching squares, simplify, smooth, medial axis, inflate —
     * and it runs on the main thread because it has to be deterministic and
     * shared with the phone. One creature is nothing. Sixty-eight in a loop
     * measured as an 8.5 SECOND FROZEN TAB: not a slow page, a broken one,
     * with no first paint, no scroll, no cursor.
     *
     * Yielding between slices costs a little total time and buys the only
     * thing that matters here — the world is on screen and interactive
     * while its population arrives. It reads as the field filling up, which
     * is a better landing than a blank page that suddenly has everything.
     *
     * Skips anything already standing, so it stays additive and the poll
     * can call it every twenty seconds without disturbing the world.
     */
    const SPAWN_PER_FRAME = 3;
    const absorb = async (
      log: SessionLog,
      grown: boolean,
      resident = false,
    ): Promise<string[]> => {
      const ids: string[] = [];
      let sinceYield = 0;
      for (const event of log.events) {
        if (event.k !== 'drawing') continue;
        if (creatures.has(event.id)) continue;
        const entry = gate.offer({
          id: event.id,
          name: event.name,
          personality: null,
          strokes: event.strokes,
          hatchMs: PUBLIC_HATCH_MS,
          source: 'phone',
          ...(grown ? { grown: true } : {}),
          ...(resident ? { resident: true } : {}),
        });
        if (entry.disposition === 'admitted') ids.push(event.id);
        if (++sinceYield >= SPAWN_PER_FRAME) {
          sinceYield = 0;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
      return ids;
    };

    /**
     * The PUBLIC world's existing population, shipped with the world.
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
     *
     * They belong to the public world and to nothing else. A client's world
     * is `residents: none` (worlds.json) and never runs this: it opens
     * clean and fills only with what its own people draw. Twenty-three
     * strangers standing in a client's field are not a welcome, they are
     * clutter with no story attached — and the first drawing arriving into
     * an empty field is the entire proposition being demonstrated.
     */
    /*
     * A VERSIONED url, because `public/` is served verbatim.
     *
     * Vite fingerprints what it bundles; it does not touch `public/`, so
     * this asset keeps one address forever and a browser's copy of it is
     * whatever it fetched the first time. The population went 68 → 30 → 23
     * while people were watching, and everyone who had already opened the
     * link kept seeing the number they first loaded — no amount of
     * redeploying the file could reach them.
     *
     * Bump this whenever `public/recovered/session.json` changes. A new
     * query string is a new cache key, so a stale entry is not revalidated,
     * it is not consulted at all.
     */
    const SEED_VERSION = '23';
    const seedUrl = `/recovered/session.json?v=${SEED_VERSION}`;
    const loadSeed = async (): Promise<number> => {
      try {
        /*
         * `no-cache`, NOT `force-cache`.
         *
         * force-cache means "use any stored copy whatever its age, and do
         * not revalidate" — it ignores the response's own cache headers.
         * It was here to make the landing fast, and it did, but it also
         * made the seed UNUPDATABLE: a browser that had ever loaded an
         * older one kept serving it from disk forever. The seed went
         * 68 → 30 → 23 and returning visitors still saw the first number
         * they ever fetched (user report, 2026-08-27).
         *
         * no-cache still uses the cache — it just asks first. Vercel sends
         * an etag with `max-age=0, must-revalidate`, so an unchanged seed
         * costs one conditional request and comes back 304 with no body.
         * Nearly free, and correct.
         */
        const res = await fetch(seedUrl, { cache: 'no-cache' });
        if (!res.ok) return 0;
        const log = readSessionLog(await res.json());
        if (!log) return 0;
        // GROWN. No egg, no shell, no hatch — they have been standing here
        // since long before this visitor opened the link.
        // grown AND resident: this is the world, not a queue of offers.
        return (await absorb(log, true, true)).length;
      } catch {
        // An empty field is a worse landing than a slow one, but a missing
        // seed must not stop the live world from loading.
        return 0;
      }
    };

    /**
     * READ THE WORLD'S GENERATION OFF THE LOG IT JUST PULLED.
     *
     * This is the only thing that ever sets `publishedEpoch` in a public
     * world, and it hangs on the pull rather than on a request of its own
     * for two reasons: the page is already making this request, and the
     * announcement can then be ordered honestly behind it — nothing is said
     * about which world this is until this page knows.
     *
     * It runs on EVERY pull, not only the first. A reset performed from
     * another screen while this one is open lands here on the next poll, and
     * the room's handsets are told within one interval instead of at the
     * next refresh.
     */
    const learnGeneration = (config: SessionLog['config']): void => {
      const raw = config?.['generation'];
      const generation =
        typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
      const next = epochFor(worldName, generation);
      if (next === publishedEpoch) return;
      const had = publishedEpoch;
      publishedEpoch = next;
      // Retained, so a handset that connects an hour from now is told too.
      if (isHostNow()) announceEpochRetained(feed, next, phoneHatchMs);
      // Only a CHANGE is worth a line. The first read is this page learning
      // its own name, which is not news; a second one means somebody reset
      // the world while this screen was standing open, and the operator
      // should know why the phones in the room are about to be sent back to
      // the pad. Reload to see the world as it now is.
      if (had !== null) say(`the world was reset — generation ${generation}, reload to see it`);
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
      learnGeneration(log.config);
      // Additive, never a restore: anything already standing is left alone,
      // which is what lets this run every twenty seconds without disturbing
      // a world somebody is looking at.
      // The FIRST pull is history — everything the store already held was
      // there before this page opened, so it is grown like the seed. Every
      // pull after it is news: somebody drew that in the last twenty
      // seconds, and an arrival gets its egg and its hatch.
      //
      // EXCEPT in a manual world, where nothing has hatched yet by
      // definition (user ask, 2026-09-10). There the store's contents are
      // eggs waiting on the operator, and standing them up grown would be
      // this page deciding the moment `h` exists to decide — on the
      // projection, and on every phone whose world view pulled the same
      // list. They spawn as eggs; the host's roster then says which of them
      // it has already opened, and this page opens exactly those.
      const added = (await absorb(log, first && hatchMode === 'timer')).length;
      if (added > 0) saveSession();
      /*
       * NOTHING IS ANNOUNCED ON ARRIVAL (user ask, 2026-09-09).
       *
       * The first pull used to say how many creatures had joined, or invite
       * the first drawing. Both were chatter over a world that shows you the
       * same thing by simply being there — the creatures arrive on screen,
       * which is the announcement.
       *
       * ONE exception, and it is not chatter: a deployment with no store
       * behind it. Every drawing sent to that world is dropped and the field
       * stays empty however many people draw into it, and an empty world is
       * exactly what a quiet one looks like. The api has always reported
       * which it is (api/drawings.ts, `config.store`) and nobody read it;
       * src/world/storeline.ts turns that into the one line worth saying,
       * and says nothing at all on a world that is working.
       */
      if (first) {
        const note = storeNote(log.config, worldName);
        if (note !== null) say(note);
      }
    };

    // The residents first, then whoever has joined since. In that order on
    // purpose: the seed is local and instant, the live pull is a network
    // round trip, and a person arriving should never see an empty field
    // while a request is in flight.
    //
    // A world with no residents skips it outright rather than loading and
    // discarding: an empty field is what that world is FOR, so there is
    // nothing to cover up and no reason to spend the request.
    if (residents === 'none') void pull(true);
    else void loadSeed().then(() => pull(true));
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
  /**
   * On a handset these do not float in their own corners — they sit in the
   * tray along the bottom (src/world/tray.ts): whatever is yours in the
   * left corner, the minimap in the right. Same two components, given a
   * place instead of a corner each.
   */
  /** This handset's own drawing, if it made one. */
  const mySubmission = handheld && room.length > 0 ? readSubmission(room) : null;
  /** Which creature on this screen is this handset's, if any. */
  const myDrawerId = mySubmission?.id ?? '';
  /**
   * Their drawing, as the shape pipeline wants it. Stored in the kit's WIRE
   * form, which is what the world and the companion both parse it from —
   * same conversion here, so all three build the identical creature.
   */
  const myStrokes: StrokeList = mySubmission
    ? feedDrawingToStrokes({ strokes: mySubmission.strokes as never })
    : [];

  /**
   * The companion, over this world, in this document.
   *
   * NOT a navigation. The world behind it keeps its gl context, its scene
   * and all sixty-eight built creatures, so coming back is instant instead
   * of a full rebuild — which is what it was, measured at three documents
   * and two full rebuilds for one round trip (user report, 2026-08-25).
   *
   * No `from=world`: the case inside must NOT slide, because the frame it
   * sits in is the thing sliding. Two objects moving for one gesture reads
   * as a stutter.
   */
  const companion = handheld
    ? createCompanionPanel(document.body, {
        href: `/phone.html?room=${room}${worldParam}`,
        onVisibilityChange: (visible) => {
          // Nothing of the world is visible under an opaque full-screen
          // panel. Stop drawing it: the phone gets its battery back and,
          // more to the point, the panel gets the main thread it needs to
          // boot and to slide smoothly.
          world.setPaused(visible);
          // The thumbnail is under the panel too, and it is a whole second
          // gl context drawing a creature nobody can see.
          tray?.setPortraitPaused(visible);
        },
      })
    : null;

  // Boot the companion quietly, once the thread is free, so the first tap
  // is only a slide. Only when there is a creature to open onto — a person
  // who has not drawn has no device in the tray to tap.
  if (companion && myDrawerId.length > 0) companion.prewarm();

  const tray = handheld
    ? mountWorldTray(document.body, {
        // Read once, at mount: a person who draws from here leaves the page
        // to do it and comes back to a fresh mount, so there is no state to
        // keep in sync — the next load asks again and is right again.
        hasCreature: myDrawerId.length > 0,
        openCompanion: () => companion?.open(),
        // The same strokes under the same id the world built from, so the
        // creature in the mini screen IS the one standing in the world —
        // the pipeline is deterministic, so this needs nothing from the wire.
        ...(myStrokes.length > 0 && mySubmission
          ? { strokes: myStrokes, identity: mySubmission.id }
          : {}),
        emote: (name) => {
          // Locally first, so the reaction is instant on the screen the
          // person is holding, then out over the wire for every other
          // projection. Same order the companion uses.
          const mine = room.length > 0 ? readSubmission(room) : null;
          const id = mine?.id ?? '';
          if (!id) return false;
          const played = creatures.emote(id, name, 'phone');
          uplink?.send(name);
          return played;
        },
      })
    : null;

  /*
   * Does the camera ride this handset's own creature? (user ask, 2026-09-09)
   *
   * Only where there is one to ride: a projection frames the whole room and
   * a handset that has not drawn has nothing of its own in there. The rule
   * itself — on by default, the map's tap suspends it, the stick resumes it
   * — is in src/world/follow.ts, with no scene in it, so it can be argued
   * with in a test rather than in a demo.
   */
  const follow = createFollow({ enabled: Boolean(tray?.middle) && myDrawerId.length > 0 });

  installWorldMinimap({
    manager: creatures,
    cameraRig: world.cameraRig,
    scatter: world.scatter,
    // A tap on the map is "show me over there". Let go of the creature
    // until they ask for it back by walking.
    onFocus: () => follow.suspend(),
    /*
     * Where YOU are (user ask, 2026-09-09: *"the mini map should show you
     * where your character is in relation to the world"*).
     *
     * The same condition as the stick and the follow camera: a handset,
     * with a creature of its own. A projection passes nothing — a wall
     * has no self — and the map draws exactly as it always did.
     *
     * A function, not a point: the creature walks, and the map reads it
     * per frame off the manager rather than being told about it.
     */
    ...(tray?.middle && myDrawerId.length > 0
      ? { self: (): { x: number; z: number } | null => creatures.positionOf(myDrawerId) }
      : {}),
    mount: tray ? tray.right : document.body,
  });

  /*
   * The stick, between the device and the map (user ask, 2026-09-08).
   *
   * Only on a handset looking at the world, and only for somebody who has
   * a creature: the corners already follow that rule — the device stands
   * where the join code was once you have drawn — and a stick that steers
   * nothing would be the one control here that does not mean anything.
   *
   * It holds the raw SCREEN vector and nothing else. Mapping it onto the
   * ground happens in `worldDrive` below, on read, because the camera
   * orbits continuously: a direction fixed when the thumb landed stops
   * agreeing with the picture while the thumb is still down, and the
   * creature curves away from the way it is being asked to go.
   */
  let stickVec = STICK_REST;
  const stick =
    tray?.middle && myDrawerId.length > 0
      ? mountJoystick({
          onChange: (v) => {
            stickVec = v;
            // Walking IS the ask to be followed again — the only way this
            // view has of saying "come with me". Orbiting never does this:
            // turning the camera around your creature is looking at it.
            if (v.mag > 0) follow.resume();
          },
        })
      : null;
  if (stick && tray?.middle) tray.middle.appendChild(stick.el);

  /** The stick as a direction on the ground, under the camera right now. */
  const worldDrive = (): WorldVector =>
    stick ? stickToWorld(stickVec, world.cameraRig.azimuth) : WORLD_REST;

  /*
   * What the qr encodes.
   *
   * In a NAMED world: the world's own link, the same one that gets shared
   * anywhere else. The room is derived from the world name (roomForWorld),
   * so nothing is lost by leaving it out, and a phone opening it is
   * redirected to the pad with the world still attached — the identical
   * destination, reached by the identical path as every other visitor. The
   * point is that there is only ONE address for this place. A qr that
   * encoded a deep link meant the projection was handing out a url nobody
   * else had, so a scan and a shared link could drift apart, and the one
   * printed on the wall was the one nobody could check.
   *
   * In an UNNAMED world the deep link is the only option and stays: the
   * room was minted at random and cannot be derived from anything in the
   * address, so dropping it would strand the scan in a different room.
   *
   * And when the world has a DEPLOYMENT of its own — this document declared
   * it in `<meta name="refworld:world">`, so the address in the bar is
   * already the world's own hostname — the qr encodes this page's path
   * instead, which on such a deployment is simply `/`. That is the address
   * on the card and the one the client was sent; a qr pointing at
   * `/?world=<name>` would send them to a different host for the same
   * place, which is the exact thing this rule exists to prevent. `?world=`
   * on its own does not get that treatment: the query IS the address there.
   *
   * Either way the url must carry the world, or a scan lands on a pad that
   * publishes over mqtt and stores nothing — the creature shows on the
   * projection while that tab is open and is then gone forever, with
   * nothing anywhere saying so.
   *
   * Not built at all when the tray does not want one — see TrayHandle.
   */
  if (!tray || tray.showsJoinCode) {
    installJoinQr({
      url: joinUrl(location.origin, {
        world: isPublic ? worldName : null,
        room,
        epoch,
        ...(declaredByPage ? { page: location.pathname } : {}),
      }),
      mount: tray ? tray.left : document.body,
    });
  }

  // (the way back to your own creature is the tray's device — tap it)

  ensureOverlayStyle();

  // No on-screen join line and no key hints (user ask): the frame is the
  // world, nothing else. The room still travels — it is written into this
  // page's own address below — and the ghost panel carries the controls.

  world.onFrame((dt, nowMs) => {
    creatures.update(dt, nowMs);
    /*
     * The handset camera goes where its creature goes.
     *
     * Retargeted every frame rather than on arrival: `frameAt` retargets a
     * ζ≥1 spring that carries its own position and velocity across, so a
     * target that moves a little each frame produces one continuous glide
     * and never a step. A creature standing still hands the spring the same
     * point over and over, it settles, and the camera is left resting on
     * the ambient drift floor — which is the settle this taste asks for
     * (TASTE §2.1), not a stop.
     *
     * It moves the LOOK TARGET only. Azimuth and elevation are untouched,
     * so a one-finger drag keeps orbiting around the creature the whole
     * time it is being followed, and a pinch keeps zooming.
     */
    if (follow.active()) {
      const at = creatures.positionOf(myDrawerId);
      if (at) world.cameraRig.frameAt(at);
    }
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
        // The live terrain dials (src/world/landscape.ts): each one rebuilds
        // the ground field, re-seats the scatter and re-levels the water.
        setTerrain: (next) => world.setTerrain(next),
        terrain: () => world.terrain(),
        // The cheap half of the same seam: a planting stroke re-rolls the
        // scatter and leaves the ground alone (the environment brush kit).
        refreshScatter: () => world.refreshScatter(),
        // The strip's home button: the default view, slid into, never cut.
        resetView: () => world.resetView(),
        // The landscape mode (src/world/landscape.ts): reveal or hide the
        // authored map. Written back into the address as well as applied, so
        // a reload keeps the world the operator is standing in.
        setLandscape: (on) => {
          world.setLandscape(on);
          writeLandscapeParam(on);
        },
        landscape: () => world.landscape(),
        // Painted water, to the renderer (src/world/water.ts): the fills, the
        // drawn shorelines and the ripple marks of the bodies somebody paints.
        // The GEOGRAPHY's copy is installed inside the paint skill itself
        // (landscape.ts `setPaintedWater`), which is why only this half needs
        // a handle — the world draws what the geography already answers for.
        setPaintedWater: (field) => world.water.setPainted(field),
        // The paint skill draws on the ground with a plain drag, which is
        // the same gesture the view controls orbit with; the world lets go
        // of it while a stroke is live (src/world/scene.ts setSoloDrag).
        setSoloDrag: (enabled) => world.setSoloDrag(enabled),
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
        // The shared scene's readout and its reset (docs/SESSION.md §6).
        // Only where there is one — see `sceneSync`.
        ...(isPublic ? { sceneSync } : {}),
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
   * Is this page the one that speaks for the world?
   *
   * True until an election says otherwise, and an election only happens in
   * a public world — an installation room is one projection and always its
   * own authority. Everything the world says TO HANDSETS goes through this:
   * verdicts, recalls, and the retained world announcement. Every open
   * viewer used to send all three, so two laptops on the live link meant
   * phones receiving two of everything, from two different simulations.
   */
  let isHostNow = (): boolean => true;
  /**
   * The phone's transport, on the world page.
   *
   * Only on a handset, and only for one thing: a person looking at the
   * world from their phone is ALSO a drawer, and the tray lets them react
   * with their own creature. The world page has always been a receiver of
   * emotes; this is the one case where it is a sender too, because the
   * person holding it owns one of the creatures on screen.
   */
  const uplink = myDrawerId ? createPhoneLink(room, myDrawerId) : null;
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
    if (!feed || !isHostNow()) return false;
    feed.publishToPhones({ type: 'recall', epoch: wireEpoch() });
    return true;
  };

  const tellPhone = (to: string, entry: { disposition: string; reason: string | null }): void => {
    if (!isHostNow()) return;
    feed?.publishToPhones({
      type: 'verdict',
      to,
      disposition: entry.disposition,
      // The screen's own wording is diagnostic, for the operator readout —
      // the phone shows the guideline line, not this.
      reason: entry.reason,
      epoch: wireEpoch(),
    });
  };

  /**
   * Which broker to talk to.
   *
   * Overridable because the default is a free public one, and a room that
   * matters should not depend on it — a self-hosted broker is a url swap,
   * not a code change. It is also the only way to exercise two clients
   * against each other in a test, since the public broker is unreachable
   * from a sandbox.
   *
   * Validated to a websocket scheme: this value opens a socket, and an
   * unchecked one out of the query string is somewhere to point a page at
   * a host of somebody else's choosing.
   */
  const brokerParam = params.get('broker') ?? '';
  const brokerOverride = /^wss?:\/\//.test(brokerParam) ? brokerParam : '';

  void connectWorldFeed({
    room,
    ...(brokerOverride ? { broker: brokerOverride } : {}),
    // Re-announce on every (re)connect, not only once at boot. The publish
    // below happens as soon as the feed object exists, which can be before
    // the socket is actually up; and a broker that drops us must be told
    // again, because a retained message lives on the broker and a new one
    // has never heard of this world.
    onStatus: (state) => {
      if (state === 'on' && isHostNow()) announceEpochRetained(feed, wireEpoch(), phoneHatchMs);
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
    /*
     * A phone saved its creature (docs/SESSION.md §keep).
     *
     * Nothing happens in the world — the save already happened on the
     * handset — and that is exactly why it has to be recorded: "somebody
     * wanted to take this home" is what a session is judged on afterwards,
     * and no other event says it. Recorded on the page that SIMULATES, like
     * a drive, so a room with two screens open does not log it twice.
     */
    onKeep: ({ from, action }) => {
      if (isHostNow()) session.keep(from, action, 'phone');
    },
    // A phone announced itself: answer with what happened to its drawing,
    // and with this world's session so a handset from a previous world
    // learns its creature is gone.
    onHello: ({ from }) => {
      const seen = gate.log().find((e) => e.id === from);
      if (seen && seen.disposition !== 'admitted') tellPhone(from, seen);
      else if (isHostNow())
        feed?.publishToPhones({
          type: 'world',
          epoch: wireEpoch(),
          ...(phoneHatchMs === undefined ? {} : { hatchMs: phoneHatchMs }),
        });
    },
  }).then((handle) => {
    feed = handle;
    // Say which world this is, RETAINED, the moment the feed is up. Every
    // handset that connects from here on is told immediately — including one
    // that wakes an hour from now — so a phone holding a drawing from a
    // previous session re-homes it without anyone pressing anything
    // (src/phone/main.ts, docs/SESSION.md §4a).
    if (isHostNow()) announceEpochRetained(handle, wireEpoch(), phoneHatchMs);
    startWorldSync(handle);
  });

  /**
   * One world, many screens (src/net/worldsync.ts).
   *
   * Every page used to run its own simulation, so two people on the same
   * link watched two different worlds. Now one page simulates and the rest
   * follow it, and which one is decided by an election nobody administers:
   * smallest live id wins.
   *
   * Only for a PUBLIC world. An installation room is one projection with
   * phones attached — there is no second screen to disagree with, and
   * putting an election in front of it would be a way for a stray tab to
   * take the room's world away from it.
   */
  function startWorldSync(handle: Awaited<ReturnType<typeof connectWorldFeed>>): void {
    if (!handle || !isPublic) return;
    const client = (handle as unknown as {
      client?: {
        publish?(topic: string, payload: string, opts?: Record<string, unknown>): void;
        subscribe?(topic: string): void;
        on?(event: string, cb: (topic: string, payload: unknown) => void): void;
      };
    }).client;
    if (!client?.publish || !client.subscribe || !client.on) return;

    const syncTopic = `${handle.topic}/world`;
    const me = makeHostId(params.get('host') === '1');
    /*
     * The scene layer gets its transport (docs/SESSION.md §6).
     *
     * It exists long before this does — a person can switch the landscape on
     * in the first second — so batches queue in `sceneBacklog` until here and
     * then go out in order. The page's own id is stamped on at this end
     * rather than carried through the outbox, because the id is a property of
     * the socket, not of the sculpting.
     */
    publishScene = (message): void => {
      client.publish?.(syncTopic, JSON.stringify({ ...message, id: me }), { qos: 0 });
    };
    for (const queued of sceneBacklog.splice(0)) publishScene(queued);
    /*
     * And the hatch gets its transport (docs/SESSION.md §6).
     *
     * Straight out on the same topic through the same client the poses use,
     * because it is the same thing: the host describing its world. The
     * manager's observer is what calls this, so no route into a hatch has
     * to remember to broadcast one.
     */
    publishHatch = (who: string): void => {
      client.publish?.(syncTopic, JSON.stringify({ t: 'hatch', id: me, who }), { qos: 0 });
    };
    /** Every claim heard, by id. Pruned, so it cannot grow unbounded. */
    const claims = new Map<string, number>();
    let hosting = true;
    /**
     * Who this page currently believes is simulating.
     *
     * Only a hatch reads it. Poses and rosters get their "is this the host"
     * check for free — they are handled after the claim bookkeeping and
     * behind `if (hosting) return`, so on a viewer the loser of an election
     * is simply the page that also stopped publishing them. A hatch is
     * handled BEFORE that (it must not enter its sender into the election),
     * so it has to ask the question itself.
     */
    let hostId = me;
    let rosterRev = 0;
    let roster: string[] = [];
    let rosterSentAt = 0;
    /** Rosters the host has told us about, so a pose frame can be trusted. */
    const knownRosters = new Map<number, string[]>();
    /**
     * When each steered creature was last heard from, on the host.
     *
     * The release is one qos-0 packet, and the whole point of qos 0 is that
     * it may not arrive. With nothing watching, a dropped release leaves a
     * creature walking in a straight line for as long as the world is open,
     * while the person who was steering it has pocketed their phone. So a
     * drive EXPIRES.
     */
    const driveHeard = new Map<string, number>();

    /*
     * Subscribe on CONNECT, not just once now.
     *
     * `startWorldSync` runs as soon as the feed object exists, which is
     * before the socket is necessarily up — and a subscribe sent into a
     * socket that is not there is simply lost. It has to be re-sent on
     * every reconnect too: the session is clean, so the broker forgets
     * what this client was listening to the moment it drops. (The vendored
     * feed subscribes inside its own connect handler for exactly this
     * reason — src/net/vendor/draw-feed.js.)
     *
     * Both: now in case we are already connected, and on every connect
     * after. Subscribing twice is harmless.
     */
    const subscribe = (): void => client.subscribe?.(syncTopic);
    subscribe();
    client.on('connect', () => subscribe());
    client.on('message', (topic, payload) => {
      if (topic !== syncTopic) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(payload));
      } catch {
        return;
      }
      const msg = readWorldSyncMessage(parsed);
      if (!msg || msg.id === me) return;

      if (msg.t === 'host') {
        claims.set(msg.id, Date.now());
        return;
      }

      /*
       * A DRIVE travels the other way (src/net/worldsync.ts).
       *
       * Every other message on this topic is the host describing the
       * world; this one is a viewer asking for something in it. So it is
       * handled before the claim bookkeeping below, and it deliberately
       * does NOT count as a claim — a phone with a stick is not a
       * candidate to simulate anything, and letting its id into the
       * election would let a handset win it.
       *
       * Only the page that is simulating acts on it. On every other page
       * this creature is placed by the host's poses, so a locally applied
       * drive would be overwritten within a frame or two and, worse, would
       * look right for exactly that long.
       */
      if (msg.t === 'drive') {
        if (!hosting) return;
        driveHeard.set(msg.who, Date.now());
        // Through applyDrive, so the intent is recorded where it is
        // APPLIED — on the one page that simulates — rather than on each
        // viewer that happens to overhear the packet.
        applyDrive(msg.who, { x: msg.x, z: msg.z, mag: msg.mag });
        return;
      }

      /*
       * A SCENE change travels sideways too (docs/SESSION.md §6).
       *
       * Handled here, next to `drive` and before the claim bookkeeping, for
       * the same two reasons: it is not the host describing the world, so it
       * must not put its sender into the election; and unlike a drive it is
       * acted on by EVERY page rather than only the one simulating — the
       * ground is the one thing each page is drawing for itself, so a viewer
       * that ignored it would follow the host's poses over a plain that no
       * longer exists.
       */
      if (msg.t === 'scene') {
        receiveScene(msg);
        return;
      }

      /*
       * A HATCH, from the page that is simulating (2026-09-10).
       *
       * Handled here, beside `drive` and `scene`, so hearing one never
       * enters its sender into the election — a page that can open an egg
       * is not thereby a candidate to simulate the world. But unlike those
       * two it is honoured ONLY from the host: the hatch is the host's
       * decision, and a viewer that took one from any id on the topic would
       * hand the moment to whoever spoke last.
       *
       * The host itself ignores it. Its own eggs open through the manager,
       * and a hatch coming back at the page that sent it is either an echo
       * or another page reaching into this world's decisions.
       *
       * `creatures.hatch(who)` is the manager's ordinary forced hatch — the
       * same staggered sequence, the same shell, the same recorded event.
       * Nothing about a viewer's hatch is a different animation.
       */
      if (msg.t === 'hatch') {
        if (hosting || msg.id !== hostId) return;
        creatures.hatch(msg.who);
        return;
      }

      // Anything else is the host describing the world. Hearing it is also
      // proof that page is alive, so it counts as a claim — otherwise a
      // host that is busy publishing poses could be voted out for not
      // heartbeating often enough.
      claims.set(msg.id, Date.now());
      // A page hearing a smaller id must stand down NOW, not at its next
      // heartbeat: until it does, two pages are both publishing poses.
      settleRole();
      if (hosting) return;

      if (msg.t === 'roster') {
        knownRosters.set(msg.rev, msg.ids);
        /*
         * Agree with the host about the eggs, too (2026-09-10).
         *
         * A `hatch` travels once, at qos 0, and a page that opened after it
         * never heard it at all. Without this a viewer holds an egg for a
         * creature the rest of the room is watching walk about — and in a
         * manual world, where the first pull spawns everything as eggs,
         * that is every late joiner's whole screen.
         *
         * State rather than a replayed moment: the roster already says
         * which ids are alive and now says which are still eggs, so a
         * viewer only has to open the ones the host has already opened.
         * Anything the host still calls an egg stays an egg — including in
         * a timer world, where this simply makes a viewer's clock agree
         * with the host's instead of running beside it.
         */
        for (const id of eggsOpenedByHost(creatures.eggIds(), msg.ids, msg.eggs)) {
          creatures.hatch(id);
        }
        // Two is enough to cover a pose frame that crosses a roster change.
        if (knownRosters.size > 2) {
          const oldest = Math.min(...knownRosters.keys());
          knownRosters.delete(oldest);
        }
        return;
      }
      const against = knownRosters.get(msg.rev);
      // No roster for this revision yet: drop the frame rather than apply
      // it to the wrong creatures. The host repeats the roster every couple
      // of seconds, so this resolves itself.
      if (!against) return;
      creatures.followPoses(unpackPoses(msg.p, against));
    });

    /**
     * Work out the role. Cheap, and deliberately NOT tied to the heartbeat.
     *
     * Demotion has to be prompt: two pages both believing they are the host
     * is the state this whole thing exists to prevent, and if the only
     * moment a page can notice it has lost is when it next publishes, that
     * window is a whole heartbeat wide — wider still in a background tab,
     * where the browser throttles timers. Recomputing often and publishing
     * rarely costs nothing and closes it.
     */
    const settleRole = (): void => {
      const now = Date.now();
      pruneClaims(claims, now);
      hostId = electHost(me, claims, now);
      const shouldHost = hostId === me;
      if (shouldHost === hosting) return;
      hosting = shouldHost;
      // A viewer runs no agents: its creatures are placed by the host's
      // poses, and a local simulation underneath would fight them.
      creatures.pauseAi(!hosting);
      // BOTH directions. Becoming a viewer has to forget the positions this
      // page simulated as host just as much as becoming a host has to
      // forget the last host's — either stale answer, eased into, drags the
      // whole cast across the field.
      creatures.clearFollow();
      if (hosting) {
        // Taking over. The roster this world publishes is its own, so it
        // starts from a revision no viewer can already be holding — and
        // whatever the previous host last said about our creatures is now
        // just a stale opinion, so it goes.
        rosterRev = Math.floor(now / 1000);
        roster = [];
        creatures.clearFollow();
      }
    };

    const beat = (): void => {
      settleRole();
      client.publish?.(syncTopic, JSON.stringify({ t: 'host', id: me, at: Date.now() }), { qos: 0 });
    };
    beat();
    window.setInterval(beat, HOST_HEARTBEAT_MS);
    window.setInterval(settleRole, ROLE_SETTLE_MS);

    window.setInterval(() => {
      if (!hosting) return;
      const live = creatures.liveIds();
      const now = Date.now();
      const changed = live.length !== roster.length || live.some((id, i) => id !== roster[i]);
      if (changed || now - rosterSentAt > ROSTER_REPEAT_MS) {
        if (changed) rosterRev++;
        roster = live;
        rosterSentAt = now;
        client.publish?.(
          syncTopic,
          // The standing eggs ride with it: a viewer that missed a `hatch`
          // — or was not open when it went past — reconciles against this
          // rather than waiting for a moment that has already happened.
          // Always sent, empty included: absent means "this host does not
          // talk about eggs" and a viewer changes nothing on it.
          JSON.stringify({
            t: 'roster',
            id: me,
            rev: rosterRev,
            ids: roster,
            eggs: creatures.eggIds(),
          }),
          { qos: 0 },
        );
      }
      if (roster.length === 0) return;
      client.publish?.(
        syncTopic,
        JSON.stringify({ t: 'poses', id: me, rev: rosterRev, p: packPoses(creatures.poses(), roster) }),
        { qos: 0 },
      );
    }, POSE_INTERVAL_MS);

    /*
     * Let go of anything nobody is still asking for.
     *
     * The dropped-release backstop. A stick that is genuinely held repeats
     * at DRIVE_HZ, so a creature whose last intent is older than
     * DRIVE_STALE_MS has either been released or lost its phone — and both
     * of those mean the same thing: hand it back to its own agent.
     */
    window.setInterval(() => {
      if (!hosting) {
        driveHeard.clear();
        return;
      }
      const now = Date.now();
      for (const [who, at] of driveHeard) {
        if (now - at <= DRIVE_STALE_MS) continue;
        driveHeard.delete(who);
        // A release the log has to carry as much as a deliberate one: the
        // creature stops here, and a replay that never let go would walk it
        // into the sea.
        applyDrive(who, null);
      }
    }, DRIVE_STALE_MS);

    /*
     * This handset's own stick, going out.
     *
     * On a timer rather than on every pointermove: a thumb generates
     * events at the display's rate and most of them say almost the same
     * thing, which is a lot of packets for a public broker to carry in
     * order to keep saying "still pushing left".
     *
     * A HOST sends nothing and applies its own stick directly — there is
     * nobody to ask. Everyone else publishes, including the frame that
     * says the stick is back at rest, which is what normally ends a drive.
     * The expiry above is only the backstop for when that packet is lost.
     *
     * Not armed at all without a stick, which is every projection and
     * every desktop that opened the link.
     */
    if (stick && myDrawerId.length > 0) {
      let lastDriveSent = 0;
      let lastDriveMag = 0;
      window.setInterval(() => {
        const v = worldDrive();
        if (hosting) {
          applyDrive(myDrawerId, v);
          return;
        }
        const now = Date.now();
        const holding = v.mag > 0;
        // Repeat while held, so the host's expiry never fires under a live
        // thumb; send the release once, then fall silent.
        if (!holding && lastDriveMag === 0) return;
        if (holding && now - lastDriveSent < DRIVE_INTERVAL_MS) return;
        lastDriveSent = now;
        lastDriveMag = v.mag;
        client.publish?.(
          syncTopic,
          JSON.stringify({
            t: 'drive',
            id: me,
            who: myDrawerId,
            x: Number(v.x.toFixed(3)),
            z: Number(v.z.toFixed(3)),
            mag: Number(v.mag.toFixed(3)),
          }),
          { qos: 0 },
        );
      }, DRIVE_INTERVAL_MS);
    }

    // Only the host speaks to the handsets. Every open viewer used to, so
    // two laptops on the live link meant phones receiving two interleaved
    // simulations (see worldsync.ts).
    isHostNow = () => hosting;

    // Same idiom as __refworldSession above: a readout of what this page
    // thinks its role is, which is the only way to see an election from
    // outside.
    (window as unknown as Record<string, unknown>)['__refworldSync'] = () => {
      const now = Date.now();
      return {
        me,
        hosting,
        winner: electHost(me, claims, now),
        rosterRev,
        roster: roster.length,
        // Age of each claim, so a page that looks wrong can be told apart
        // from a page whose peer simply went quiet.
        claims: [...claims].map(([id, at]) => `${id}:${now - at}ms`),
        knownRosters: [...knownRosters.keys()],
      };
    };
  }

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
