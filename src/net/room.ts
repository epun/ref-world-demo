/**
 * RoomHub — the routing state machine for one room (PLAN §8).
 *
 * PURE: no `ws`, no Durable Object APIs, no timers, no randomness. Connections
 * are abstract `RoomConn` callbacks, so the Cloudflare DO (worker/relay.ts) and
 * the node dev relay (src/net/devRelay.ts) are thin adapters over this ONE
 * implementation, and the routing logic is tested once (test/net/room.test.ts).
 *
 * Routing rules:
 * - The first message on a connection must be a `join` declaring its role.
 * - One 'world' per room; a second world join is refused via close code.
 * - Phone messages are wrapped in Envelope{from, msg} and forwarded to the
 *   world socket only.
 * - The world sends Addressed{to?, msg}: routed to that phone, or broadcast to
 *   every phone when `to` is omitted. Phones receive the bare WorldToPhone
 *   message (they never see the Addressed wrapper).
 * - PeerEvent joined/left keeps the world's view of the room current — a world
 *   joining late is replayed the phones already present.
 * - Drawings over MAX_DRAWING_BYTES close the offender, never the room.
 * - Undecodable input (decode → null) is ignored.
 */

import {
  decode,
  encode,
  MAX_DRAWING_BYTES,
  type Addressed,
  type ClientMsg,
  type Envelope,
  type JoinMsg,
  type PeerEvent,
  type PhoneToWorld,
  type ServerMsg,
} from './protocol';

/** What the hub needs from a socket — adapters supply these two callbacks. */
export interface RoomConn {
  send(data: string): void;
  close(code: number, reason: string): void;
}

// App close codes (the 4000–4999 range is reserved for applications).
/** This room already has a world; the simulation host slot is taken. */
export const CLOSE_WORLD_TAKEN = 4001;
/** First message was not a valid join for this room. */
export const CLOSE_BAD_JOIN = 4002;
/** A drawing payload exceeded MAX_DRAWING_BYTES. */
export const CLOSE_TOO_LARGE = 4009;

const PHONE_MSG_TYPES = new Set(['drawing', 'emote', 'hatch']);

const utf8 = new TextEncoder();

interface Member {
  id: string;
  role: 'phone' | 'world';
}

export class RoomHub {
  private members = new Map<RoomConn, Member>();
  private phonesById = new Map<string, RoomConn>();
  private world: RoomConn | null = null;
  private nextId = 0;

  constructor(readonly room: string) {}

  /** True when nobody is connected — adapters may drop the room then. */
  get isEmpty(): boolean {
    return this.members.size === 0;
  }

  /** Every raw frame from an adapter lands here; joins are dispatched within. */
  handleMessage(conn: RoomConn, raw: string): void {
    const msg = decode(raw);
    if (msg === null) return; // garbage is ignored, not fatal

    const member = this.members.get(conn);
    if (!member) {
      if ('t' in msg && msg.t === 'join') {
        this.handleJoin(conn, msg as JoinMsg);
      } else {
        // A decodable non-join before joining is a protocol violation.
        conn.close(CLOSE_BAD_JOIN, 'join first');
      }
      return;
    }

    if (member.role === 'phone') this.routeFromPhone(conn, member, msg, raw);
    else this.routeFromWorld(msg);
  }

  handleJoin(conn: RoomConn, msg: JoinMsg): void {
    if (this.members.has(conn)) return; // duplicate join — already registered
    if (msg.room !== this.room || (msg.role !== 'phone' && msg.role !== 'world')) {
      conn.close(CLOSE_BAD_JOIN, 'bad join');
      return;
    }

    if (msg.role === 'world') {
      if (this.world !== null) {
        // One world per room — refuse the second politely, room unharmed.
        conn.close(CLOSE_WORLD_TAKEN, 'room already has a world');
        return;
      }
      this.world = conn;
      this.members.set(conn, { id: 'world', role: 'world' });
      // Replay phones that joined before the world arrived.
      for (const id of this.phonesById.keys()) this.sendPeerEvent(id, 'joined');
      return;
    }

    const id = `p${++this.nextId}`;
    this.members.set(conn, { id, role: 'phone' });
    this.phonesById.set(id, conn);
    this.sendPeerEvent(id, 'joined');
  }

  handleClose(conn: RoomConn): void {
    const member = this.members.get(conn);
    if (!member) return; // idempotent — safe to call after a hub-initiated close
    this.members.delete(conn);
    if (member.role === 'world') {
      this.world = null;
      return;
    }
    this.phonesById.delete(member.id);
    this.sendPeerEvent(member.id, 'left');
  }

  private routeFromPhone(
    conn: RoomConn,
    member: Member,
    msg: ClientMsg | ServerMsg,
    raw: string,
  ): void {
    if (!('t' in msg) || !PHONE_MSG_TYPES.has(msg.t as string)) return;

    if (msg.t === 'drawing' && utf8.encode(raw).length > MAX_DRAWING_BYTES) {
      // Close the offender, not the room.
      conn.close(CLOSE_TOO_LARGE, 'drawing too large');
      this.handleClose(conn); // keep hub state consistent even if the adapter's close event lags
      return;
    }

    if (this.world === null) return; // no simulation host yet — drop
    const envelope: Envelope = { from: member.id, msg: msg as PhoneToWorld };
    this.world.send(encode(envelope));
  }

  private routeFromWorld(msg: ClientMsg | ServerMsg): void {
    if (!('msg' in msg) || typeof msg.msg !== 'object' || msg.msg === null) return;
    const addressed = msg as Addressed;
    const wire = encode(addressed.msg);
    if (addressed.to !== undefined) {
      this.phonesById.get(addressed.to)?.send(wire);
      return;
    }
    for (const conn of this.phonesById.values()) conn.send(wire);
  }

  private sendPeerEvent(id: string, event: 'joined' | 'left'): void {
    if (this.world === null) return;
    const peer: PeerEvent = { t: 'peer', id, event };
    this.world.send(encode(peer));
  }
}
