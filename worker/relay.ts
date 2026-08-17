/**
 * The production relay: a Cloudflare Worker fronting one Durable Object per
 * room (PLAN §8, §11). Deployed separately from the static pages (Vercel
 * cannot host WebSocket relays); the pages point at it via VITE_RELAY_URL.
 *
 * All routing logic lives in the pure RoomHub (src/net/room.ts) — this file is
 * only the adapter: URL validation, the WebSocket upgrade dance, and wiring
 * socket events into hub calls. The node dev relay (src/net/devRelay.ts) is
 * the same adapter over `ws`, so both run identical, tested routing.
 *
 * Rooms are IN-MEMORY ONLY (PLAN open decision #4 — room lifetime is an open
 * call). When every socket closes and the runtime evicts the DO, the room
 * resets; no durable storage is used yet. If decision #4 lands on "characters
 * survive a rejoin", persistence gets added here behind the same RoomHub.
 *
 * Deploy: npx wrangler deploy --config worker/wrangler.toml
 */

import { isRoomCode } from '../src/net/protocol';
import { RoomHub, type RoomConn } from '../src/net/room';

export interface Env {
  ROOMS: DurableObjectNamespace;
}

/** /r/:code/ws — the one route. Code shape is enforced again with isRoomCode. */
const ROOM_PATH = /^\/r\/([^/]+)\/ws$/;

export class RoomDO {
  private hub: RoomHub | null = null;

  // The DO contract passes state + env; this relay needs neither (in-memory
  // only, no bindings used inside the room), but the parameters document the
  // seam where open decision #4 would land.
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const code = ROOM_PATH.exec(new URL(request.url).pathname)?.[1];
    if (code === undefined || !isRoomCode(code)) {
      return new Response('not found', { status: 404 });
    }

    // One hub per DO; the DO id is derived from the room code, so every socket
    // for a room lands on the same instance.
    this.hub ??= new RoomHub(code);
    const hub = this.hub;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const conn: RoomConn = {
      send: (data) => server.send(data),
      close: (closeCode, reason) => server.close(closeCode, reason),
    };
    server.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') hub.handleMessage(conn, event.data);
      // Binary frames are not part of the protocol — ignored.
    });
    server.addEventListener('close', () => hub.handleClose(conn));
    server.addEventListener('error', () => hub.handleClose(conn));

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const code = ROOM_PATH.exec(new URL(request.url).pathname)?.[1];
    if (code === undefined || !isRoomCode(code)) {
      return new Response('not found', { status: 404 });
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(request);
  },
};
