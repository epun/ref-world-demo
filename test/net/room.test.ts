import { describe, it, expect, beforeEach } from 'vitest';
import {
  RoomHub,
  CLOSE_WORLD_TAKEN,
  CLOSE_TOO_LARGE,
  type RoomConn,
} from '../../src/net/room';
import {
  encode,
  decode,
  MAX_DRAWING_BYTES,
  type Addressed,
  type DrawingMsg,
  type Envelope,
  type JoinMsg,
  type PeerEvent,
  type StateMsg,
} from '../../src/net/protocol';
import type { StrokeList } from '../../src/shape/types';

const ROOM = 'abcd';

/** A RoomConn that records everything the hub does to it. */
class FakeConn implements RoomConn {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  /** Decoded view of sent frames, oldest first. */
  received(): unknown[] {
    return this.sent.map((raw) => decode(raw));
  }
  last(): unknown {
    return decode(this.sent[this.sent.length - 1] ?? '');
  }
}

function join(hub: RoomHub, conn: RoomConn, role: 'phone' | 'world', room = ROOM): void {
  const msg: JoinMsg = { t: 'join', role, room };
  hub.handleMessage(conn, encode(msg));
}

const tinyStrokes: StrokeList = [{ pts: [[0.5, 0.5, 1]], w: 0.02 }];

describe('RoomHub', () => {
  let hub: RoomHub;
  let world: FakeConn;
  let phoneA: FakeConn;
  let phoneB: FakeConn;
  let idA: string;
  let idB: string;

  beforeEach(() => {
    hub = new RoomHub(ROOM);
    world = new FakeConn();
    phoneA = new FakeConn();
    phoneB = new FakeConn();
    join(hub, world, 'world');
    join(hub, phoneA, 'phone');
    join(hub, phoneB, 'phone');
    const events = world.received() as PeerEvent[];
    idA = events[0]!.id;
    idB = events[1]!.id;
  });

  it('announces each phone join to the world with distinct ids', () => {
    const events = world.received() as PeerEvent[];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ t: 'peer', event: 'joined' });
    expect(events[1]).toMatchObject({ t: 'peer', event: 'joined' });
    expect(idA).not.toBe(idB);
    expect(world.closed).toBeNull();
  });

  it('replays already-joined phones to a world that arrives late', () => {
    const lateHub = new RoomHub(ROOM);
    const p = new FakeConn();
    const w = new FakeConn();
    join(lateHub, p, 'phone');
    join(lateHub, w, 'world');
    expect(w.received()).toHaveLength(1);
    expect(w.last()).toMatchObject({ t: 'peer', event: 'joined' });
  });

  it('wraps a phone drawing in an envelope and forwards it to the world only', () => {
    const drawing: DrawingMsg = { t: 'drawing', strokes: tinyStrokes };
    hub.handleMessage(phoneA, encode(drawing));

    const envelope = world.last() as Envelope;
    expect(envelope.from).toBe(idA);
    expect(envelope.msg).toMatchObject({ t: 'drawing' });
    expect((envelope.msg as DrawingMsg).strokes).toEqual(tinyStrokes);
    // The other phone hears nothing.
    expect(phoneB.sent).toHaveLength(0);
    expect(phoneA.sent).toHaveLength(0);
  });

  it('routes an addressed world message to that phone alone', () => {
    const addressed: Addressed = { to: idA, msg: { t: 'state', phase: 'egg', hatchInMs: 900 } };
    hub.handleMessage(world, encode(addressed));

    expect(phoneA.sent).toHaveLength(1);
    // Phones receive the bare message, not the wrapper.
    expect(phoneA.last()).toMatchObject({ t: 'state', phase: 'egg', hatchInMs: 900 });
    expect(phoneB.sent).toHaveLength(0);
  });

  it('broadcasts to every phone when `to` is omitted', () => {
    const addressed: Addressed = { msg: { t: 'name', name: 'wobble' } };
    hub.handleMessage(world, encode(addressed));

    expect(phoneA.last()).toMatchObject({ t: 'name', name: 'wobble' });
    expect(phoneB.last()).toMatchObject({ t: 'name', name: 'wobble' });
    // The world never echoes back to itself: still just the two join events.
    expect(world.sent).toHaveLength(2);
  });

  it('refuses a second world via close code, leaving the room intact', () => {
    const usurper = new FakeConn();
    join(hub, usurper, 'world');
    expect(usurper.closed).toMatchObject({ code: CLOSE_WORLD_TAKEN });

    // The original world still routes.
    hub.handleMessage(phoneA, encode({ t: 'hatch' }));
    expect((world.last() as Envelope).msg).toMatchObject({ t: 'hatch' });
    expect(world.closed).toBeNull();
  });

  it('notifies the world when a phone leaves', () => {
    hub.handleClose(phoneA);
    const event = world.last() as PeerEvent;
    expect(event).toMatchObject({ t: 'peer', id: idA, event: 'left' });

    // Messages addressed to the departed phone are dropped, not misrouted.
    const addressed: Addressed = { to: idA, msg: { t: 'state', phase: 'draw' } };
    hub.handleMessage(world, encode(addressed));
    expect(phoneA.sent).toHaveLength(0);
    expect(phoneB.sent).toHaveLength(0);
  });

  it('closes an oversized drawing sender without harming the room', () => {
    // Enough points to push the encoded frame past the cap.
    const pts: [number, number, number][] = [];
    while (pts.length * 12 < MAX_DRAWING_BYTES) pts.push([0.123, 0.456, 1]);
    const big: DrawingMsg = { t: 'drawing', strokes: [{ pts, w: 0.02 }] };
    hub.handleMessage(phoneA, encode(big));

    expect(phoneA.closed).toMatchObject({ code: CLOSE_TOO_LARGE });
    // The world sees the offender leave, nothing else.
    expect(world.last()).toMatchObject({ t: 'peer', id: idA, event: 'left' });
    expect(world.closed).toBeNull();

    // Room intact: the other phone still routes both ways.
    hub.handleMessage(phoneB, encode({ t: 'emote', emote: 'wave' }));
    expect((world.last() as Envelope).from).toBe(idB);
    const state: StateMsg = { t: 'state', phase: 'alive' };
    hub.handleMessage(world, encode({ to: idB, msg: state } satisfies Addressed));
    expect(phoneB.last()).toMatchObject({ t: 'state', phase: 'alive' });
  });

  it('ignores garbage: bad json, wrong version, and shapeless frames', () => {
    hub.handleMessage(phoneA, 'not json at all {');
    hub.handleMessage(phoneA, JSON.stringify({ v: 999, t: 'emote', emote: 'wave' }));
    hub.handleMessage(phoneA, JSON.stringify({ v: 1 }));
    hub.handleMessage(world, 'also } not { json');

    expect(decode('not json at all {')).toBeNull();
    expect(phoneA.closed).toBeNull();
    expect(world.closed).toBeNull();
    expect(world.sent).toHaveLength(2); // just the original join events
    expect(phoneA.sent).toHaveLength(0);
    expect(phoneB.sent).toHaveLength(0);
  });

  it('reports empty only after everyone is gone', () => {
    expect(hub.isEmpty).toBe(false);
    hub.handleClose(phoneA);
    hub.handleClose(phoneB);
    expect(hub.isEmpty).toBe(false);
    hub.handleClose(world);
    expect(hub.isEmpty).toBe(true);
  });
});
