/**
 * Phone entry (PLAN §6): the persistent companion screen.
 *
 * ONE STAGE, updated — ① draw, ② wait, ③ alive are three occupancies of
 * the same surface, never three screens sliding past each other
 * (docs/PHONE-STAGE.md). The stage (states.ts) is fed by one NetLike session
 * (session.ts): the room client when ?room=xxxx resolves, the same-device
 * flow otherwise. The latest pose/roster/name are cached here so the alive
 * screen mounts already warm.
 */

import type { PoseMsg, RosterMsg } from '../net/protocol';
import { feedStrokeToStroke } from '../net/drawFeed';
import { createPhoneLink } from '../net/phoneLink';
import type { StrokeList } from '../shape/types';
import { MOTION, SURFACE, WORLD } from '../taste/tokens';
import { mountAliveScreen, type AliveScreenHandle } from './screens/alive';
import { mountDraw } from './screens/draw';
import { mountWaitScreen, type WaitScreenHandle } from './screens/wait';
import { hatchPulse } from './haptics';
import { resolveName } from '../creatures/naming';
import {
  clearSubmission,
  drawerId,
  isStale,
  readSubmission,
  writeSubmission,
} from './identity';
import { createSession } from './session';
import { mountWorldLink } from './worldlink';
import { SPIN_REST, type SpinState } from './spin';
import {
  createMachine,
  type Entrance,
  type PhoneState,
  type ScreenMount,
} from './states';

document.documentElement.style.height = '100%';
document.body.style.height = '100%';
document.body.style.margin = '0';
// One paper for the whole mobile flow (PHONE-STAGE §2) — the same value
// phone.html paints inline before any script, and the same value /draw/
// paints, so the navigation between them has nothing to flash to.
document.body.style.background = SURFACE.ground;

/**
 * The guideline notice — shown on the drawer's OWN handset when the world
 * refuses their drawing (user ask). It never appears on the projection:
 * the shared screen must not reward the attempt, but the person deserves
 * to know their egg is never going to hatch rather than being left to
 * wait on it.
 *
 * It slides up over the companion on the settle curve, and its one action
 * forgets this handset's submission so they can draw something else.
 *
 * It slides up inside the device's SCREEN, not over the whole page
 * (docs/DEVICE.md): a notice that covered the case would read as a
 * different surface arriving, which is the cut PHONE-STAGE §5 keeps these
 * modals clear of. Everything else about it is unchanged — same trigger,
 * same copy, same action, same settle curve over t.secondary, and the
 * stage stays visible behind it until it is fully up.
 */
function showGuidelineNotice(onDrawAgain: () => void): void {
  if (document.querySelector('.guideline-notice')) return;
  const style = document.createElement('style');
  style.textContent = `
.guideline-notice {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5cqw;
  padding: 8cqw;
  text-align: center;
  background: ${SURFACE.ground};
  color: ${WORLD.ink};
  font-family: "helvetica neue", helvetica, arial, sans-serif;
  transform: translateY(103%);
  transition: transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.guideline-notice.open { transform: translateY(0); }
.guideline-notice p {
  margin: 0;
  font-size: clamp(12px, 6.2cqw, 17px);
  line-height: 1.45;
  max-width: 22em;
}
.guideline-notice .sub {
  font-size: clamp(10px, 5.1cqw, 14px);
  color: ${WORLD.neutral};
}
.guideline-notice button {
  font: inherit;
  font-size: clamp(11px, 5.8cqw, 16px);
  padding: 4cqw 7cqw;
  border-radius: 13px;
  border: 1px solid ${WORLD.ink};
  background: transparent;
  color: ${WORLD.ink};
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
}
.guideline-notice button:active { transform: scale(0.97); }
`;
  document.head.appendChild(style);

  const notice = document.createElement('section');
  notice.className = 'guideline-notice';
  const line = document.createElement('p');
  line.textContent = 'sorry — this goes against our content guidelines.';
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = 'it was not added to the world.';
  const again = document.createElement('button');
  again.type = 'button';
  again.textContent = 'draw something else';
  again.addEventListener('click', onDrawAgain);
  notice.append(line, sub, again);
  // Inside the screen. The stage is the query container the measures above
  // resolve against, and it clips — so the sheet slides up the display,
  // exactly as it always slid up the page. Falls back to the body if the
  // stage is not mounted (it always is by the time a verdict can arrive).
  (document.querySelector('.stage') ?? document.body).appendChild(notice);
  requestAnimationFrame(() => notice.classList.add('open'));
}

/**
 * Handoff from the kit draw page (public/draw/): after send it stashes the
 * drawing and navigates here, and the companion opens straight onto the
 * wait screen — the 3D egg painted with the drawing. The drawing was
 * already published over MQTT by the draw page, so it is NOT resent (a
 * resend would spawn a duplicate egg in the world under a new id).
 */
interface Handoff {
  strokes: StrokeList;
  /** The publish id — the same identity the world spawns under, so the
   * alive-screen portrait renders the identical creature. */
  id: string | null;
  /** What the person signed, or null if they skipped. The draw page has
   * already published under it; the companion needs it so the brow shows
   * the name they chose rather than one the session invented. */
  name: string | null;
}

function readHandoff(): Handoff | null {
  try {
    const raw = sessionStorage.getItem('refworld:handoff');
    if (!raw) return null;
    sessionStorage.removeItem('refworld:handoff'); // one-shot
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as { id?: unknown; strokes?: unknown; ts?: unknown; name?: unknown };
    if (!Array.isArray(rec.strokes)) return null;
    // Stale stashes (an old tab restored much later) go back to drawing.
    if (typeof rec.ts === 'number' && Date.now() - rec.ts > 10 * 60 * 1000) return null;
    const out: StrokeList = [];
    for (const fs of rec.strokes) {
      const stroke = feedStrokeToStroke(fs as { pts: [number, number][]; width?: number });
      if (stroke) out.push(stroke);
    }
    if (out.length === 0) return null;
    return {
      strokes: out,
      id: typeof rec.id === 'string' && rec.id ? rec.id : null,
      name: typeof rec.name === 'string' && rec.name ? rec.name : null,
    };
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const session = await createSession();

  // The room this handset joined, and who it is. The drawer id is stable
  // per device, so the creature it addresses is always its own — and only
  // ever one (src/phone/identity.ts).
  const room = (new URLSearchParams(location.search).get('room') ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  // The id the world knows this creature by. Normally the handset's stable
  // drawer id (the draw page publishes under it), but a creature submitted
  // before that id existed lives under the id in its own record — so the
  // handoff / stored submission wins when present. Addressing the wrong id
  // is indistinguishable from a dead uplink: the tap simply does nothing.
  const stored = room.length > 0 ? readSubmission(room) : null;
  const me = stored?.id ?? drawerId();
  // The link carries a tap to the world and brings back what the world says
  // about this handset; null with no mqtt on the page (or no room), and
  // every call site tolerates that.
  const uplink = room.length > 0 ? createPhoneLink(room, me) : null;

  let strokes: StrokeList = [];
  /** Publish id from the draw-page handoff — the creature's identity. */
  let identity: string | null = null;
  let waitHandle: WaitScreenHandle | null = null;
  let aliveHandle: AliveScreenHandle | null = null;
  let hatchInMs: number | null = null;
  let lastPose: PoseMsg | null = null;
  let lastRoster: RosterMsg | null = null;
  /**
   * The creature's name, as THIS handset knows it.
   *
   * User ruling: *"the creature name should be replaced by the user name if
   * they signed"*. It was not, because SameDeviceSession emits
   * `localName(seed)` — a name of its own invention — and that is what the
   * brow showed. The signature never reached it.
   *
   * So the phone resolves it the same way the world does
   * (src/creatures/naming.ts): the signed name if there is one, otherwise a
   * name derived from the identity id. Both sides run the same pure
   * function on the same id, so the phone and the projection always agree —
   * without the world having to send anything down.
   */
  let signedName: string | null = null;
  let lastName: string | null = null;
  /**
   * Where the person has turned the object, and how fast it is still
   * turning (user ruling, 2026-08-20). It lives HERE rather than in a
   * screen because it has to survive the swap between them: the egg the
   * wait screen turned and the creature the alive screen mounts are the
   * one object the whole way down (PHONE-STAGE §2), and an object that
   * snapped back to front — or simply stopped — at the seam would be both
   * a jump and an abrupt stop.
   */
  let spin: SpinState = SPIN_REST;

  const root = document.createElement('div');
  document.body.appendChild(root);

  // Where the flow opens, and how it arrives. Decided BEFORE the stage is
  // built: a state the person is already looking at must not play an
  // entrance, and the seam must not play one for the stage itself.
  const handedOff = readHandoff();
  // Resolved here because it needs the handoff: the signed name arrives with
  // it, and `me` is the identity both sides derive the fallback from.
  signedName = (stored?.name ?? handedOff?.name ?? null) || null;
  lastName = resolveName(signedName, me);
  const acrossSeam = new URLSearchParams(location.search).get('handoff') === '1';
  let initialState: PhoneState = 'draw';
  let entrance: Entrance = 'settled';

  if (handedOff) {
    // Kit-page handoff: open on the egg, not the draw pad. The MQTT publish
    // already happened on the draw page; driving the LOCAL session here only
    // starts its egg timer, so the wait screen counts down and hatching
    // advances to the alive state — the character in the ui (user ask).
    // (The local session never reaches the MQTT feed, so no duplicate egg.)
    strokes = handedOff.strokes;
    identity = handedOff.id;
    hatchInMs = 20000;
    initialState = 'wait';
    // ?handoff=1 is the draw page saying it left the core at the wait
    // measure with its content already faded out; here the egg fades UP
    // into that same box (PHONE-STAGE §4). The stash is one-shot, so a
    // later reload cannot replay this.
    entrance = acrossSeam ? 'seam' : 'settled';
  } else if (room.length > 0 && stored) {
    // No fresh handoff, but this handset already drew in this room: restore
    // ITS creature rather than offering a second pad (user ruling — one
    // drawing, one creature). Reloading the companion must not mint a new
    // inhabitant, and the emote wheel must keep addressing the old one.
    const restored: StrokeList = [];
    for (const fs of stored.strokes) {
      const stroke = feedStrokeToStroke(fs as { pts: [number, number][]; width?: number });
      if (stroke) restored.push(stroke);
    }
    if (restored.length > 0) {
      strokes = restored;
      identity = stored.id;
      hatchInMs = 0; // it hatched long ago in the world; skip the wait
      initialState = 'alive';
      // A plain restore replays nothing: an entrance for a state the person
      // was already looking at reads as a glitch (PHONE-STAGE §4).
      entrance = 'settled';
    }
  }

  const mounts: Record<PhoneState, ScreenMount> = {
    draw: (slots) =>
      mountDraw(slots, {
        onDone(done): void {
          strokes = done;
          session.sendDrawing(done);
          machine.goTo('wait');
        },
      }),
    wait: (slots) => {
      const handle = mountWaitScreen(slots, {
        strokes,
        // The same id the world spawns under and the alive portrait
        // mounts: the creature this screen reveals at the hatch and the
        // creature that portrait draws are then the identical mesh, which
        // is what makes the swap between them a dissolve.
        ...(identity !== null ? { identity } : {}),
        hatchInMs,
        initialSpin: spin,
        onHatch: () => session.sendHatch(),
      });
      waitHandle = handle;
      return {
        destroy(): void {
          if (waitHandle === handle) waitHandle = null;
          spin = handle.spin();
          handle.destroy();
        },
      };
    },
    alive: (slots) => {
      const handle = mountAliveScreen(slots, {
        strokes,
        // Same identity the world spawned under → the identical creature.
        ...(identity !== null ? { identity } : {}),
        initialSpin: spin,
        onEmote: (emote) => {
          // Two paths, deliberately: the session keeps the local echo (and
          // will carry the relay when one is deployed), while the uplink is
          // what reaches the world today — the phone publishes on the room's
          // own mqtt topic, the transport the drawings already prove works.
          session.sendEmote(emote);
          uplink?.send(emote);
        },
      });
      if (lastPose) handle.setPose(lastPose);
      if (lastRoster) handle.setRoster(lastRoster);
      if (lastName !== null) handle.setName(lastName);
      aliveHandle = handle;
      return {
        destroy(): void {
          if (aliveHandle === handle) aliveHandle = null;
          spin = handle.spin();
          handle.destroy();
        },
      };
    },
  };

  const machine = createMachine(root, mounts, initialState, { entrance });

  /**
   * The way out to the shared world, when there is one.
   *
   * Only for a PUBLIC world: an installation handset has no shared place to
   * go — its world lives on a projection in the same room, which the person
   * is already looking at. A control that leads nowhere is worse than no
   * control, so `mountWorldLink` returns null and nothing is mounted.
   */
  const publicWorld = (new URLSearchParams(location.search).get('world') ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 24);
  mountWorldLink(document.body, {
    room,
    world: publicWorld,
    device: document.querySelector<HTMLElement>('.device'),
  });

  // The stage is mounted; feed the session whatever the flow opened with,
  // so the egg timer and the local echo agree with what is on screen. The
  // drawing itself already reached the world over mqtt from the draw page
  // — this only drives the LOCAL session, so no duplicate egg.
  if (strokes.length > 0) session.sendDrawing(strokes);

  // ── what the world says back ─────────────────────────────────────────────
  const drawAgain = (): void => {
    if (room.length > 0) clearSubmission(room);
    location.href = `/draw/?room=${room}`;
  };
  // Once the person is being told something, nothing else navigates out
  // from under them — the staleness check below would otherwise redirect on
  // the very message that carries the refusal.
  let told = false;
  /** The world this handset last heard from, for a resend to address. */
  let lastWorldEpoch: string | null = null;
  /**
   * How stale a drawing may be and still re-home itself into a restarted
   * world.
   *
   * Was six hours, which read as generous until a session was lost at night
   * and the recovery was attempted the next day — the window itself refused
   * the very drawings it existed to save. Two days is the honest bound: it
   * spans an install that runs over an evening and a morning, and a drawing
   * older than that really does belong to a different event.
   *
   * `?recover=1` bypasses it entirely (public/draw/), for the case where
   * someone is deliberately asking a room to hand its drawings back.
   */
  const REHOME_WINDOW_MS = 48 * 60 * 60 * 1000;
  // The world opened this drawer's egg — play the hatch NOW, on the same
  // edge, rather than waiting for the local session's own timer to come
  // round. Guarded like the state path: only from the egg, and only when
  // this handset actually has a drawing in flight.
  // The world lost its population and is asking for it back. This handset
  // still has its own drawing; re-publishing the same strokes under the
  // same id rebuilds the identical creature (src/shape/ and src/inflate/
  // are pure — PLAN §6.3). Nothing is re-drawn and nothing is invented.
  /**
   * Hand this handset's drawing back to the world, under the same id.
   *
   * `epoch` is the world it is going into — the record adopts it, so the
   * staleness check does not fire again a second later and bounce the
   * person off a creature that now exists. Returns whether anything was
   * sent.
   */
  const resendMine = (epoch: string | null): boolean => {
    if (room.length === 0) return false;
    const mine = readSubmission(room);
    if (!mine) return false;
    uplink?.resend({ id: mine.id, name: mine.name, strokes: mine.strokes });
    if (epoch !== null && epoch.length > 0) {
      writeSubmission(room, { ...mine, epoch });
    }
    return true;
  };
  uplink?.onRecall(() => {
    // The recall carries no epoch of its own; the last `world` message did,
    // and that is the world asking.
    resendMine(lastWorldEpoch);
  });
  uplink?.onHatched(() => {
    if (machine.state !== 'alive' && strokes.length > 0) hatch();
  });
  uplink?.onVerdict((verdict) => {
    // 'held' means an operator has it — the drawer is not told off for a
    // drawing that may yet be approved; they keep waiting. Anything else
    // that is not an admission means it will never appear.
    if (verdict.disposition === 'held' || verdict.disposition === 'admitted') return;
    told = true;
    showGuidelineNotice(drawAgain);
  });
  uplink?.onWorldEpoch((worldEpoch) => {
    lastWorldEpoch = worldEpoch;
    if (room.length === 0 || told) return;
    const mine = readSubmission(room);
    if (!isStale(mine, worldEpoch)) return;
    // The world running now is not the one this drawing went into. That
    // used to mean one thing — the creature is gone, send the person back
    // to a blank pad — and the record was deleted on the way out. It was
    // the single most destructive line in the project: the ONE copy of a
    // drawing that survives a projection restart, thrown away by the code
    // that noticed the restart (recovery, 2026-08-20).
    //
    // Now the handset heals it instead. The pipeline is pure in
    // (strokes, id), so re-publishing the same strokes under the same id
    // rebuilds the IDENTICAL creature in the new world — no recall needed,
    // no operator, nobody has to touch anything. The person keeps watching
    // their companion and never learns the projection blinked.
    if (mine && Date.now() - mine.ts < REHOME_WINDOW_MS && resendMine(worldEpoch)) {
      return;
    }
    // Beyond the window this really is a new session on a later day, and a
    // drawing from yesterday should not walk into it. The record still is
    // not deleted — a recall can still ask for it — but the person is free
    // to draw again.
    location.replace(`/draw/?room=${room}&w=${worldEpoch}`);
  });

  /**
   * The hatch, played rather than cut to.
   *
   * User report, 2026-08-20: *"on hatch the egg should break apart and the
   * creature should appear. right now it glitches on the screen from the
   * egg and flashes on."* It did, because this used to be one line —
   * `machine.goTo('alive')` — and a goTo cross-fades the core between two
   * scenes: an egg dissolving into a character is not a hatch, it is two
   * pictures.
   *
   * So the world's confirmation now starts the REAL sequence in the screen
   * that already holds the egg (screens/wait.ts → src/egg/hatch.ts, the
   * same module the projection runs), and the swap waits for it. By the
   * time the stage cross-fades, the wait screen is showing the creature the
   * alive screen is about to mount — same strokes, same identity, same pure
   * pipeline, framed to the same pixels — so the cross-fade has almost
   * nothing left to fade.
   */
  let hatching = false;
  const hatch = (): void => {
    if (hatching || machine.state === 'alive') return;
    hatching = true;
    const handle = waitHandle;
    if (!handle) {
      machine.goTo('alive');
      return;
    }
    void handle
      .playHatch({
        // The haptic belongs to the CRACK, not to the screen change. It
        // used to fire on the transition, which was a different moment and
        // happened to be the only one this flow had. Silent on handsets
        // without the vibration api (every iPhone); the visual reveal is
        // unchanged either way.
        onCrack: () => hatchPulse(),
      })
      .then(() => machine.goTo('alive'));
  };

  session.onState((msg) => {
    if (msg.phase === 'egg') {
      hatchInMs = msg.hatchInMs ?? null;
      if (hatchInMs !== null) waitHandle?.setHatchIn(hatchInMs);
    }
    // The transition to alive happens when the world (or the local session)
    // confirms — never on the tap itself (PLAN §6.2).
    if (msg.phase === 'alive' && machine.state !== 'alive' && strokes.length > 0) hatch();
  });
  session.onPose((msg) => {
    lastPose = msg;
    aliveHandle?.setPose(msg);
  });
  session.onRoster((msg) => {
    lastRoster = msg;
    aliveHandle?.setRoster(msg);
  });
  session.onName((msg) => {
    // A signed name is the person's own and outranks anything the session
    // invents; the fallback is already the world's generated name, so there
    // is nothing a session-supplied one can improve on.
    if (signedName) return;
    lastName = msg.name;
    aliveHandle?.setName(msg.name);
  });
}

void boot();
