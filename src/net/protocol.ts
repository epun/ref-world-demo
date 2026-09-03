/**
 * Room protocol (PLAN §8) — the shared contract between phone, world, and
 * the relay (Cloudflare Durable Object in production, the dev relay locally).
 *
 * Pure types + codecs: no DOM, no Three.js, no network. Both entry points and
 * the worker import this file, so it must stay dependency-free.
 *
 * Design notes:
 * - The stroke list is the wire format for drawings (tiny, replayable, and
 *   the deterministic input both devices share — no geometry ever crosses).
 * - The world page is authoritative for simulation; the relay only routes.
 * - Roster entries are pre-clustered by the world before broadcast so a busy
 *   room never pushes per-character data to every phone (PLAN §8).
 */

import type { StrokeList } from '../shape/types.js';

/** Room codes: 4 lowercase letters (no uppercase anywhere — TASTE §5). */
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz'; // no i/l/o — legibility

export type EmoteName =
  | 'happy'
  | 'sad'
  | 'sleepy'
  | 'angry'
  | 'surprised'
  | 'dance'
  | 'wave';

export const EMOTE_NAMES: readonly EmoteName[] = [
  'happy',
  'sad',
  'sleepy',
  'angry',
  'surprised',
  'dance',
  'wave',
] as const;

/** Lifecycle of one player's character, as the phone sees it. */
export type PlayerPhase = 'draw' | 'egg' | 'hatching' | 'alive';

// ── Messages: phone → relay → world ─────────────────────────────────────────

export interface JoinMsg {
  t: 'join';
  /** 'phone' | 'world' — the world registers as the room's simulation host. */
  role: 'phone' | 'world';
  room: string;
}

export interface DrawingMsg {
  t: 'drawing';
  strokes: StrokeList;
}

export interface EmoteMsg {
  t: 'emote';
  emote: EmoteName;
}

export interface HatchMsg {
  t: 'hatch';
}

export type PhoneToWorld = DrawingMsg | EmoteMsg | HatchMsg;

// ── Messages: world → relay → phone ─────────────────────────────────────────

export interface StateMsg {
  t: 'state';
  phase: PlayerPhase;
  /** ms until auto-hatch, when phase is 'egg'. */
  hatchInMs?: number;
}

export interface PoseMsg {
  t: 'pose';
  /** Your character: world position and heading. ~10Hz, drift-interpolated client-side. */
  x: number;
  z: number;
  heading: number;
  emote?: EmoteName;
}

/** One minimap entry. Non-self peers may be pre-clustered. */
export interface RosterEntry {
  x: number;
  z: number;
  /** Number of characters folded into this mark (1 = a single peer). */
  n: number;
}

export interface RosterMsg {
  t: 'roster';
  /** Peers only — never includes yourself; your pose comes from PoseMsg. */
  peers: RosterEntry[];
  /** World half-extent in world units, for minimap scaling. */
  extent: number;
}

export interface NameMsg {
  t: 'name';
  /** Lowercase (TASTE §5). */
  name: string;
}

export type WorldToPhone = StateMsg | PoseMsg | RosterMsg | NameMsg;

// ── Relay envelope ──────────────────────────────────────────────────────────
// The relay wraps every routed message with the originating client id so the
// world can address per-player state back.

export interface Envelope {
  /** Stable per-connection id assigned by the relay. */
  from: string;
  msg: PhoneToWorld | WorldToPhone;
}

/** World → relay: address one phone (or broadcast when `to` is omitted). */
export interface Addressed {
  to?: string;
  msg: WorldToPhone;
}

/** Relay → world when a phone joins/leaves (so the world can clean up). */
export interface PeerEvent {
  t: 'peer';
  id: string;
  event: 'joined' | 'left';
}

export type ClientMsg = JoinMsg | PhoneToWorld | Addressed;
export type ServerMsg = Envelope | PeerEvent | StateMsg | PoseMsg | RosterMsg | NameMsg;

// ── Codec ───────────────────────────────────────────────────────────────────
// JSON with a version tag; keep it boring. Size guard: drawings are the only
// large payload — cap points to keep the DO happy.

export const PROTOCOL_VERSION = 1;
export const MAX_DRAWING_BYTES = 256 * 1024;

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
}

export function decode(raw: string): (ClientMsg | ServerMsg) | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (rec['v'] !== PROTOCOL_VERSION) return null;
    if (typeof rec['t'] !== 'string' && typeof rec['msg'] !== 'object') return null;
    return parsed as ClientMsg | ServerMsg;
  } catch {
    return null;
  }
}

/** Generate a room code from a seed function (inject randomness at the edge). */
export function roomCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)]!;
  }
  return code;
}

/**
 * The room a NAMED world always meets in.
 *
 * A room code is normally random — an installation mints one per session
 * and puts it in the join code. A public world cannot work that way: the
 * link carries a world name and no room, so every visitor was minting their
 * own, and two people on the same url ended up on two different mqtt topics
 * (found 2026-08-26).
 *
 * The store hid it. Everybody read the same drawings from the same world
 * and saw the same population, so it looked shared — but only on the 20s
 * poll, and the live seam was per-visitor: arrivals did not cross in real
 * time, and the host election (src/net/worldsync.ts) ran inside each
 * visitor's private room, so every one of them elected itself. "One world,
 * many screens" quietly meant one screen each.
 *
 * Derived from the name, so it is the same on every device forever without
 * anything being stored or agreed. fnv-1a, then folded into the alphabet.
 */
export function roomForWorld(world: string): string {
  let h = 2166136261;
  for (let i = 0; i < world.length; i++) {
    h ^= world.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let code = '';
  let n = h >>> 0;
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[n % ROOM_CODE_ALPHABET.length]!;
    n = Math.floor(n / ROOM_CODE_ALPHABET.length);
  }
  return code;
}

/**
 * The url the join qr encodes.
 *
 * A NAMED world gets its own link — the same address that is shared
 * anywhere else. The room is derived from the name, so leaving it out loses
 * nothing, and a phone opening it is redirected to the pad with the world
 * still attached: the identical destination, reached by the identical path
 * as every other visitor. The point is that a place has ONE address. A qr
 * carrying a deep link meant the projection handed out a url nobody else
 * had, so a scan and a shared link could quietly drift apart and the one
 * printed on the wall was the one nobody ever checked.
 *
 * An UNNAMED world keeps the deep link, because it has no choice: its room
 * was minted at random and cannot be derived from anything in the address,
 * so dropping it would strand the scan in a room of its own.
 *
 * `page` is that same rule applied one level up. A world with a page of its
 * own (worlds/<name>/index.html — see scripts/new-world.mjs) is reached at
 * `/worlds/<name>/`, and THAT is its address: the one on the card, the one
 * a client was sent, the one anybody would paste. `/?world=<name>` still
 * lands in the identical world, but a qr encoding it would be a second
 * address for a place that is supposed to have one. So when the page
 * declares the world, pass its path and the qr encodes the page.
 *
 * It is ignored without a world, because an unnamed world's room is not in
 * the path — a page-only url would strand the scan exactly as dropping the
 * deep link would.
 */
export function joinUrl(
  origin: string,
  where: { world: string | null; room: string; epoch: string; page?: string },
): string {
  if (where.world) {
    if (where.page) return `${origin}${where.page}`;
    return `${origin}/?world=${encodeURIComponent(where.world)}`;
  }
  return `${origin}/draw/?room=${where.room}&w=${where.epoch}`;
}

/** Validate a room code (lowercase, right length, in-alphabet). */
export function isRoomCode(s: string): boolean {
  if (s.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of s) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
