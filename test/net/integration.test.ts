/**
 * Real websocket round-trip over the dev relay (src/net/devRelay.ts) on an
 * ephemeral in-process port — proving the `ws` adapter carries the same
 * routing the pure RoomHub tests pin down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { startDevRelay, type DevRelay } from '../../src/net/devRelay';
import {
  encode,
  decode,
  type Addressed,
  type ClientMsg,
  type Envelope,
  type PeerEvent,
  type ServerMsg,
} from '../../src/net/protocol';

const ROOM = 'abcd';

interface Client {
  ws: WebSocket;
  /** Next decoded message (FIFO over everything received so far). */
  next(): Promise<ClientMsg | ServerMsg>;
  close(): void;
}

function connect(port: number, role: 'phone' | 'world', room = ROOM): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/r/${room}/ws`);
    const queue: (ClientMsg | ServerMsg)[] = [];
    const waiters: ((msg: ClientMsg | ServerMsg) => void)[] = [];
    ws.on('message', (data) => {
      const msg = decode(data.toString());
      if (msg === null) return;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(encode({ t: 'join', role, room }));
      resolve({
        ws,
        next: () =>
          new Promise((resolveNext) => {
            const queued = queue.shift();
            if (queued !== undefined) resolveNext(queued);
            else waiters.push(resolveNext);
          }),
        close: () => ws.close(),
      });
    });
  });
}

describe('dev relay round-trip', () => {
  let relay: DevRelay;

  beforeAll(async () => {
    relay = await startDevRelay(0); // ephemeral port
  });

  afterAll(async () => {
    await relay.close();
  });

  it('routes phone → world envelope and world → phone broadcast over real sockets', async () => {
    const world = await connect(relay.port, 'world');
    const phone = await connect(relay.port, 'phone');

    // The world learns the phone joined.
    const joined = (await world.next()) as PeerEvent;
    expect(joined).toMatchObject({ t: 'peer', event: 'joined' });
    const phoneId = joined.id;

    // Phone emotes; the world receives it wrapped in an envelope.
    phone.ws.send(encode({ t: 'emote', emote: 'dance' }));
    const envelope = (await world.next()) as Envelope;
    expect(envelope.from).toBe(phoneId);
    expect(envelope.msg).toMatchObject({ t: 'emote', emote: 'dance' });

    // World broadcasts state; the phone receives the bare message.
    const addressed: Addressed = { msg: { t: 'state', phase: 'egg', hatchInMs: 1500 } };
    world.ws.send(encode(addressed));
    const state = await phone.next();
    expect(state).toMatchObject({ t: 'state', phase: 'egg', hatchInMs: 1500 });

    // Addressed delivery also works over the wire.
    world.ws.send(encode({ to: phoneId, msg: { t: 'name', name: 'pip' } } satisfies Addressed));
    const name = await phone.next();
    expect(name).toMatchObject({ t: 'name', name: 'pip' });

    // Teardown: the world hears the phone leave.
    phone.close();
    const left = (await world.next()) as PeerEvent;
    expect(left).toMatchObject({ t: 'peer', id: phoneId, event: 'left' });
    world.close();
  });

  it('rejects a bad room code at the http layer', async () => {
    await expect(
      new Promise((_resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/r/NOPE/ws`);
        ws.on('error', reject);
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
