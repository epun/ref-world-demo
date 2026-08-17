/**
 * RoomClient — the browser side of the room protocol (PLAN §8), used by both
 * pages: the world (index.html) joins as the simulation host, phones
 * (phone.html) join as players.
 *
 * Degrades gracefully: the static pages deploy to Vercel while the relay is a
 * separately-deployed Cloudflare Worker — so when no relay URL resolves or the
 * connection fails, the client just reports 'offline' and the same-device draw
 * flow keeps working (PLAN §8 fallback). Nothing here throws on network
 * absence.
 *
 * Reconnects with exponential backoff (1s → 2s → 4s → 8s cap, jittered) and
 * resends `join` on every reopen. Jitter uses Math.random — this is I/O
 * timing, not rendered content, so determinism rules don't apply.
 */

import {
  decode,
  encode,
  isRoomCode,
  MAX_DRAWING_BYTES,
  type Addressed,
  type EmoteName,
  type Envelope,
  type JoinMsg,
  type NameMsg,
  type PeerEvent,
  type PoseMsg,
  type RosterMsg,
  type StateMsg,
  type WorldToPhone,
} from './protocol';
import type { StrokeList } from '../shape/types';

export type RoomRole = 'phone' | 'world';
export type RoomStatus = 'offline' | 'connecting' | 'online';

// Backoff schedule: base doubles 1s → 8s cap, each delay jittered ±25%.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 8000;
const BACKOFF_JITTER = 0.25;

// Close codes that mean "the room refused you" — retrying would only repeat
// the refusal, so the client goes offline instead. Values mirror src/net/room.ts
// (not imported: the client must not pull the hub into the page bundle).
const NO_RETRY_CLOSES = new Set([4001, 4002]);

const utf8 = new TextEncoder();

/**
 * Resolve the relay base URL. Pure and injectable for tests:
 * 1. an explicit env URL (VITE_RELAY_URL) wins — http(s) schemes are mapped to
 *    ws(s), a bare host gets wss;
 * 2. else same-origin ws(s)://host (the dev relay proxied or served directly);
 * 3. else null → offline.
 */
export function resolveRelayUrl(
  env?: { VITE_RELAY_URL?: string | undefined },
  loc?: { protocol: string; host: string } | null,
  devMode = false,
): string | null {
  const configured = env?.VITE_RELAY_URL?.trim();
  if (configured !== undefined && configured !== '') {
    const noSlash = configured.replace(/\/+$/, '');
    if (/^wss?:\/\//.test(noSlash)) return noSlash;
    if (/^https?:\/\//.test(noSlash)) return noSlash.replace(/^http/, 'ws');
    return `wss://${noSlash}`;
  }
  // Same-origin is only a plausible relay in dev (the local dev relay /
  // vite proxy). A static production host (Vercel) serves no WebSockets —
  // guessing it there left phone sessions waiting on a dead endpoint and
  // eggs that never hatched (user report). Production requires an explicit
  // VITE_RELAY_URL; without one the session degrades to same-device.
  if (devMode && loc && loc.host !== '') {
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}`;
  }
  return null;
}

/** The browser default: VITE_RELAY_URL, else same-origin, else null. */
export function defaultRelayUrl(): string | null {
  const env = import.meta.env as { VITE_RELAY_URL?: string | undefined; DEV?: boolean };
  const loc = typeof location !== 'undefined' ? location : null;
  return resolveRelayUrl(env, loc, env.DEV === true);
}

export class RoomClient {
  // Status
  onStatus: ((status: RoomStatus) => void) | null = null;

  // World-role events
  onEnvelope: ((envelope: Envelope) => void) | null = null;
  onPeer: ((event: PeerEvent) => void) | null = null;

  // Phone-role events
  onState: ((msg: StateMsg) => void) | null = null;
  onPose: ((msg: PoseMsg) => void) | null = null;
  onRoster: ((msg: RosterMsg) => void) | null = null;
  onName: ((msg: NameMsg) => void) | null = null;

  private ws: WebSocket | null = null;
  private url: string | null = null;
  private room = '';
  private role: RoomRole = 'phone';
  private statusValue: RoomStatus = 'offline';
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  get status(): RoomStatus {
    return this.statusValue;
  }

  /**
   * Connect to a room. A null url (no relay configured) or an invalid room
   * code leaves the client offline — the local same-device flow still works.
   */
  connect(url: string | null, room: string, role: RoomRole): void {
    this.close();
    if (url === null || !isRoomCode(room)) return;
    this.url = url.replace(/\/+$/, '');
    this.room = room;
    this.role = role;
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }

  /** Leave the room and stop reconnecting. */
  close(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'bye');
      }
    }
    this.setStatus('offline');
  }

  // ── Phone sends ───────────────────────────────────────────────────────────

  /** Returns false when offline or when the drawing exceeds the wire cap. */
  sendDrawing(strokes: StrokeList): boolean {
    const wire = encode({ t: 'drawing', strokes });
    if (utf8.encode(wire).length > MAX_DRAWING_BYTES) return false;
    return this.sendRaw(wire);
  }

  sendEmote(emote: EmoteName): boolean {
    return this.sendRaw(encode({ t: 'emote', emote }));
  }

  sendHatch(): boolean {
    return this.sendRaw(encode({ t: 'hatch' }));
  }

  // ── World sends ───────────────────────────────────────────────────────────

  sendTo(to: string, msg: WorldToPhone): boolean {
    const addressed: Addressed = { to, msg };
    return this.sendRaw(encode(addressed));
  }

  broadcast(msg: WorldToPhone): boolean {
    const addressed: Addressed = { msg };
    return this.sendRaw(encode(addressed));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private open(): void {
    if (this.stopped || this.url === null) return;
    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${this.url}/r/${this.room}/ws`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      const join: JoinMsg = { t: 'join', role: this.role, room: this.room };
      socket.send(encode(join));
      this.attempts = 0;
      this.setStatus('online');
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') this.dispatch(event.data);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.ws !== socket) return; // superseded by a newer socket
      this.ws = null;
      if (this.stopped) return;
      if (NO_RETRY_CLOSES.has(event.code)) {
        this.stopped = true;
        this.setStatus('offline');
        return;
      }
      this.scheduleRetry();
    };
    // Errors always surface as a close; onclose owns the retry.
    socket.onerror = () => {};
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.setStatus('offline');
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.attempts, BACKOFF_CAP_MS);
    const delay = base * (1 + (Math.random() * 2 - 1) * BACKOFF_JITTER);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private sendRaw(wire: string): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(wire);
    return true;
  }

  private dispatch(raw: string): void {
    const msg = decode(raw);
    if (msg === null) return;

    if (this.role === 'world') {
      if ('from' in msg && 'msg' in msg) {
        this.onEnvelope?.(msg as Envelope);
        return;
      }
      if ('t' in msg && msg.t === 'peer') {
        this.onPeer?.(msg as PeerEvent);
      }
      return;
    }

    if (!('t' in msg)) return;
    switch (msg.t) {
      case 'state':
        this.onState?.(msg as StateMsg);
        break;
      case 'pose':
        this.onPose?.(msg as PoseMsg);
        break;
      case 'roster':
        this.onRoster?.(msg as RosterMsg);
        break;
      case 'name':
        this.onName?.(msg as NameMsg);
        break;
      default:
        break;
    }
  }

  private setStatus(status: RoomStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.onStatus?.(status);
  }
}
