import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetLike, SessionStatus } from '../../src/phone/session';
import { RELAY_ONLINE_TIMEOUT_MS, withOfflineFailover } from '../../src/phone/session';
import type { StrokeList } from '../../src/shape/types';

const drawing: StrokeList = [{ pts: [[0.4, 0.4, 1], [0.6, 0.6, 1]], w: 0.045 }];

/** A relay stand-in that never connects and records what it was sent. */
function deadRelay(): NetLike & { sent: string[]; disposed: boolean } {
  const self = {
    sent: [] as string[],
    disposed: false,
    sendDrawing: (): void => {
      self.sent.push('drawing');
    },
    sendEmote: (): void => {
      self.sent.push('emote');
    },
    sendHatch: (): void => {
      self.sent.push('hatch');
    },
    onState: (): void => {},
    onPose: (): void => {},
    onRoster: (): void => {},
    onName: (): void => {},
    status: (): SessionStatus => 'connecting',
    dispose: (): void => {
      self.disposed = true;
    },
  };
  return self;
}

describe('withOfflineFailover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('swaps to same-device when the relay never comes online, replaying the drawing', () => {
    const relay = deadRelay();
    const session = withOfflineFailover(relay);
    session.sendDrawing(drawing);

    const phases: string[] = [];
    session.onState((m) => phases.push(m.phase));

    // Before the timeout: still the relay, no local egg.
    expect(phases).toEqual([]);

    vi.advanceTimersByTime(RELAY_ONLINE_TIMEOUT_MS + 10);

    // The dead relay is disposed and the local session took over with the
    // drawing replayed — the egg phase fires and its timer is running.
    expect(relay.disposed).toBe(true);
    expect(phases[0]).toBe('egg');

    // The local timer no longer opens the egg on its own (LOCAL_AUTO_HATCH,
    // src/phone/session.ts): the hatch is the world's call, so a handset
    // left alone waits rather than hatching on a clock of its own.
    vi.advanceTimersByTime(21000);
    expect(phases).not.toContain('alive');

    // An explicit hatch still works — that is the path the world's
    // `hatched` message drives.
    session.sendHatch();
    expect(phases).toContain('alive');
  });

  it('keeps an online relay and never swaps', () => {
    const relay = deadRelay();
    relay.status = (): SessionStatus => 'online';
    const session = withOfflineFailover(relay);
    session.sendDrawing(drawing);
    vi.advanceTimersByTime(RELAY_ONLINE_TIMEOUT_MS + 10);
    expect(relay.disposed).toBe(false);
    expect(relay.sent).toContain('drawing');
  });

  it('replays a pre-swap hatch request into the local session', () => {
    const relay = deadRelay();
    const session = withOfflineFailover(relay);
    session.sendDrawing(drawing);
    session.sendHatch(); // tapped "hatch now" while the relay was dead

    const phases: string[] = [];
    session.onState((m) => phases.push(m.phase));
    vi.advanceTimersByTime(RELAY_ONLINE_TIMEOUT_MS + 10);
    // sendHatch on SameDeviceSession from the egg phase goes straight to
    // alive — the tap is honored even though it happened pre-swap.
    expect(phases).toContain('alive');
  });
});
