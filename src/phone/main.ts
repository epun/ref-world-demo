/**
 * Phone entry (PLAN §6): the persistent companion screen.
 *
 * Three states sliding between each other — ① draw, ② wait, ③ alive —
 * driven by the state machine (states.ts) and fed by one NetLike session
 * (session.ts): the room client when ?room=xxxx resolves, the same-device
 * flow otherwise. The latest pose/roster/name are cached here so the alive
 * screen mounts already warm.
 */

import type { PoseMsg, RosterMsg } from '../net/protocol';
import { feedStrokeToStroke } from '../net/drawFeed';
import { createEmoteUplink } from '../net/emoteUplink';
import type { StrokeList } from '../shape/types';
import { SURFACE } from '../taste/tokens';
import { mountAliveScreen, type AliveScreenHandle } from './screens/alive';
import { mountDraw } from './screens/draw';
import { mountWaitScreen, type WaitScreenHandle } from './screens/wait';
import { drawerId, readSubmission } from './identity';
import { createSession } from './session';
import { createMachine } from './states';

document.documentElement.style.height = '100%';
document.body.style.height = '100%';
document.body.style.margin = '0';
document.body.style.background = SURFACE.canvas;

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
}

function readHandoff(): Handoff | null {
  try {
    const raw = sessionStorage.getItem('refworld:handoff');
    if (!raw) return null;
    sessionStorage.removeItem('refworld:handoff'); // one-shot
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as { id?: unknown; strokes?: unknown; ts?: unknown };
    if (!Array.isArray(rec.strokes)) return null;
    // Stale stashes (an old tab restored much later) go back to drawing.
    if (typeof rec.ts === 'number' && Date.now() - rec.ts > 10 * 60 * 1000) return null;
    const out: StrokeList = [];
    for (const fs of rec.strokes) {
      const stroke = feedStrokeToStroke(fs as { pts: [number, number][]; width?: number });
      if (stroke) out.push(stroke);
    }
    if (out.length === 0) return null;
    return { strokes: out, id: typeof rec.id === 'string' && rec.id ? rec.id : null };
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
  // The uplink is what carries a tap to the world; null with no mqtt on the
  // page (or no room), and every call site tolerates that.
  const uplink = room.length > 0 ? createEmoteUplink(room, me) : null;

  let strokes: StrokeList = [];
  /** Publish id from the draw-page handoff — the creature's identity. */
  let identity: string | null = null;
  let waitHandle: WaitScreenHandle | null = null;
  let aliveHandle: AliveScreenHandle | null = null;
  let hatchInMs: number | null = null;
  let lastPose: PoseMsg | null = null;
  let lastRoster: RosterMsg | null = null;
  let lastName: string | null = null;

  const root = document.createElement('div');
  document.body.appendChild(root);

  const machine = createMachine(root, {
    draw: (section) =>
      mountDraw(section, {
        onDone(done): void {
          strokes = done;
          session.sendDrawing(done);
          machine.goTo('wait');
        },
      }),
    wait: (section) => {
      const handle = mountWaitScreen(section, {
        strokes,
        hatchInMs,
        onHatch: () => session.sendHatch(),
      });
      waitHandle = handle;
      return {
        destroy(): void {
          if (waitHandle === handle) waitHandle = null;
          handle.destroy();
        },
      };
    },
    alive: (section) => {
      const handle = mountAliveScreen(section, {
        strokes,
        // Same identity the world spawned under → the identical creature.
        ...(identity !== null ? { identity } : {}),
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
          handle.destroy();
        },
      };
    },
  });

  // Kit-page handoff: open on the egg, not the draw pad. The MQTT publish
  // already happened on the draw page; driving the LOCAL session here only
  // starts its egg timer, so the wait screen counts down and hatching
  // advances to the alive screen — the character in the ui (user ask).
  // (The local session never reaches the MQTT feed, so no duplicate egg.)
  const handedOff = readHandoff();
  if (handedOff) {
    strokes = handedOff.strokes;
    identity = handedOff.id;
    hatchInMs = 20000;
    session.sendDrawing(handedOff.strokes);
    machine.goTo('wait');
  } else if (room.length > 0) {
    // No fresh handoff, but this handset already drew in this room: restore
    // ITS creature rather than offering a second pad (user ruling — one
    // drawing, one creature). Reloading the companion must not mint a new
    // inhabitant, and the emote wheel must keep addressing the old one.
    const previous = stored;
    if (previous) {
      const restored: StrokeList = [];
      for (const fs of previous.strokes) {
        const stroke = feedStrokeToStroke(fs as { pts: [number, number][]; width?: number });
        if (stroke) restored.push(stroke);
      }
      if (restored.length > 0) {
        strokes = restored;
        identity = previous.id;
        hatchInMs = 0; // it hatched long ago in the world; skip the wait
        session.sendDrawing(restored);
        machine.goTo('alive');
      }
    }
  }

  session.onState((msg) => {
    if (msg.phase === 'egg') {
      hatchInMs = msg.hatchInMs ?? null;
      if (hatchInMs !== null) waitHandle?.setHatchIn(hatchInMs);
    }
    // The transition to alive happens when the world (or the local session)
    // confirms — never on the tap itself (PLAN §6.2).
    if (msg.phase === 'alive' && machine.state !== 'alive' && strokes.length > 0) {
      machine.goTo('alive');
    }
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
    lastName = msg.name;
    aliveHandle?.setName(msg.name);
  });
}

void boot();
