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
import type { StrokeList } from '../shape/types';
import { SURFACE } from '../taste/tokens';
import { mountAliveScreen, type AliveScreenHandle } from './screens/alive';
import { mountDraw } from './screens/draw';
import { mountWaitScreen, type WaitScreenHandle } from './screens/wait';
import { createSession } from './session';
import { createMachine } from './states';

document.documentElement.style.height = '100%';
document.body.style.height = '100%';
document.body.style.margin = '0';
document.body.style.background = SURFACE.canvas;

async function boot(): Promise<void> {
  const session = await createSession();

  let strokes: StrokeList = [];
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
        onEmote: (emote) => session.sendEmote(emote),
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
