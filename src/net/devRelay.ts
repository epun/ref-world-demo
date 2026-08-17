/**
 * Local dev relay — the same room routing as the Cloudflare DO, served from
 * node over the `ws` package. Node-only: run with `npm run relay:dev`
 * (default port 8787, override with an argv port: `npm run relay:dev -- 9000`).
 *
 * All routing lives in the pure RoomHub (src/net/room.ts); this file — like
 * worker/relay.ts — is only the adapter: the /r/:code/ws path, the upgrade,
 * and socket events wired into hub calls. Same path shape, same close codes,
 * same behavior, so a phone + world pair tested here works unchanged against
 * the deployed worker.
 *
 * Never imported by the app pages; the browser side is src/net/client.ts.
 */

import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { isRoomCode } from './protocol';
import { RoomHub, type RoomConn } from './room';

const ROOM_PATH = /^\/r\/([^/]+)\/ws$/;

export const DEFAULT_PORT = 8787;

export interface DevRelay {
  /** The bound port — pass 0 to startDevRelay for an ephemeral one (tests). */
  port: number;
  close(): Promise<void>;
}

export function startDevRelay(port: number = DEFAULT_PORT): Promise<DevRelay> {
  // Rooms are in-memory and dropped when their last socket closes — mirroring
  // the DO's lifecycle (PLAN open decision #4: no durable storage yet).
  const rooms = new Map<string, RoomHub>();

  const server: Server = createServer((_req, res) => {
    // Plain HTTP has nothing here; the only route is the websocket upgrade.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const code = ROOM_PATH.exec(request.url ?? '')?.[1];
    if (code === undefined || !isRoomCode(code)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let hub = rooms.get(code);
      if (hub === undefined) {
        hub = new RoomHub(code);
        rooms.set(code, hub);
      }
      const room = hub;
      const conn: RoomConn = {
        send: (data) => ws.send(data),
        close: (closeCode, reason) => ws.close(closeCode, reason),
      };
      ws.on('message', (data, isBinary) => {
        if (!isBinary) room.handleMessage(conn, data.toString());
        // Binary frames are not part of the protocol — ignored.
      });
      ws.on('close', () => {
        room.handleClose(conn);
        if (room.isEmpty) rooms.delete(code);
      });
      ws.on('error', () => ws.close());
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            for (const clientSocket of wss.clients) clientSocket.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

// CLI entry (`npm run relay:dev` → tsx src/net/devRelay.ts [port]). Guarded so
// importing this module (tests do) never starts a server.
const argv1 = typeof process !== 'undefined' ? (process.argv[1] ?? '') : '';
if (/devRelay\.(?:ts|js)$/.test(argv1)) {
  const argPort = Number(process.argv[2] ?? '');
  const port = Number.isInteger(argPort) && argPort > 0 ? argPort : DEFAULT_PORT;
  void startDevRelay(port).then((relay) => {
    console.log(`dev relay listening on ws://localhost:${relay.port}/r/:code/ws`);
  });
}
