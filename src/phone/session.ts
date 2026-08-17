/**
 * Phone session orchestration (PLAN §6, §8): one NetLike seam between the
 * screens and whatever transport exists.
 *
 * - With a valid ?room=xxxx and a compatible src/net/client.ts, the room
 *   client (built concurrently against src/net/protocol.ts) is adapted in
 *   behind NetLike. The adapter feature-detects every method and callback
 *   slot on an `unknown` surface — if the client module's shape drifts, the
 *   phone build never breaks; it just falls back.
 * - Otherwise SameDeviceSession: the offline demo and the fast dev loop
 *   (PLAN §8) — drawing → local hatch timer → alive, with a synthesized
 *   deterministic wander so the minimap shows life without a world.
 */

import { sampleDrift } from '../motion/ambient';
import {
  isRoomCode,
  type EmoteName,
  type NameMsg,
  type PlayerPhase,
  type PoseMsg,
  type RosterMsg,
  type StateMsg,
} from '../net/protocol';
import type { StrokeList } from '../shape/types';
import { MOTION } from '../taste/tokens';
import { hash01, strokeSeed } from './seed';

export type SessionStatus = 'local' | 'connecting' | 'online' | 'offline';

/** The thin client seam every screen codes against. */
export interface NetLike {
  sendDrawing(strokes: StrokeList): void;
  sendEmote(emote: EmoteName): void;
  sendHatch(): void;
  onState(cb: (msg: StateMsg) => void): void;
  onPose(cb: (msg: PoseMsg) => void): void;
  onRoster(cb: (msg: RosterMsg) => void): void;
  onName(cb: (msg: NameMsg) => void): void;
  status(): SessionStatus;
  dispose(): void;
}

// ── Pure helpers (unit-tested in test/phone) ────────────────────────────────

/** Parse ?room=xxxx from a location search string; null unless a valid code. */
export function roomFromLocation(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const room = params.get('room');
  return room !== null && isRoomCode(room) ? room : null;
}

/** How far the same-device wander roams, as a fraction of the world extent. */
export const WANDER_SPAN = 0.35;
/** Time compression feeding the ambient noise — a stroll, not a drift. */
const WANDER_TIME_SCALE = 0.085;
const WANDER_LOOKAHEAD_MS = 240;

export interface WanderSample {
  x: number;
  z: number;
  heading: number;
}

/**
 * Deterministic wander path for same-device mode: the ambient drift noise
 * (src/motion/ambient.ts) re-scaled from a 0.3%-of-scale floor up to a slow
 * stroll across WANDER_SPAN of the world. Heading looks a beat ahead along
 * the same path, so the marker faces where it is going.
 */
export function wanderPose(nowMs: number, seed: number, extent: number): WanderSample {
  const span = (extent * WANDER_SPAN) / MOTION.ambientAmplitude;
  const t = nowMs * WANDER_TIME_SCALE;
  const here = sampleDrift(t, seed, span);
  const ahead = sampleDrift(t + WANDER_LOOKAHEAD_MS * WANDER_TIME_SCALE, seed, span);
  const dx = ahead.x - here.x;
  const dz = ahead.y - here.y;
  const heading = dx === 0 && dz === 0 ? 0 : Math.atan2(dz, dx);
  return { x: here.x, z: here.y, heading };
}

const LOCAL_NAMES = ['pebble', 'moss', 'bean', 'tuft', 'wisp', 'fern', 'knub'] as const;

/** Deterministic lowercase name for the same-device character (TASTE §5). */
export function localName(seed: number): string {
  return LOCAL_NAMES[Math.floor(hash01(seed * 7.31) * LOCAL_NAMES.length)] ?? LOCAL_NAMES[0];
}

// ── Same-device session ─────────────────────────────────────────────────────

/** Local default hatch timer (PLAN §13.2 — short when unattended). */
export const LOCAL_HATCH_MS = 20_000;
/** World half-extent used for the local minimap. */
export const LOCAL_EXTENT = 48;
const POSE_INTERVAL_MS = 100; // ~10Hz, matching the wire rate (PLAN §8)
const ROSTER_INTERVAL_MS = 1000;
const EMOTE_ECHO_MS = 2000;

type Cb<T> = (msg: T) => void;

/**
 * No network at all: drawing → immediate egg with a local hatch timer →
 * alive with a synthesized wander. This is the offline demo and the fast dev
 * loop, kept permanently (PLAN §8).
 */
export class SameDeviceSession implements NetLike {
  private readonly stateCbs: Cb<StateMsg>[] = [];
  private readonly poseCbs: Cb<PoseMsg>[] = [];
  private readonly rosterCbs: Cb<RosterMsg>[] = [];
  private readonly nameCbs: Cb<NameMsg>[] = [];

  private phase: PlayerPhase = 'draw';
  private seed = 0;
  private hatchTimer: ReturnType<typeof setTimeout> | null = null;
  private poseTimer: ReturnType<typeof setInterval> | null = null;
  private rosterTimer: ReturnType<typeof setInterval> | null = null;
  private emote: EmoteName | null = null;
  private emoteUntil = 0;

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  sendDrawing(strokes: StrokeList): void {
    if (this.phase !== 'draw') return;
    this.seed = strokeSeed(strokes);
    this.phase = 'egg';
    this.emit(this.stateCbs, { t: 'state', phase: 'egg', hatchInMs: LOCAL_HATCH_MS });
    this.hatchTimer = setTimeout(() => this.hatch(), LOCAL_HATCH_MS);
  }

  sendHatch(): void {
    this.hatch();
  }

  sendEmote(emote: EmoteName): void {
    this.emote = emote;
    this.emoteUntil = this.now() + EMOTE_ECHO_MS;
  }

  onState(cb: Cb<StateMsg>): void {
    this.stateCbs.push(cb);
  }
  onPose(cb: Cb<PoseMsg>): void {
    this.poseCbs.push(cb);
  }
  onRoster(cb: Cb<RosterMsg>): void {
    this.rosterCbs.push(cb);
  }
  onName(cb: Cb<NameMsg>): void {
    this.nameCbs.push(cb);
  }

  status(): SessionStatus {
    return 'local';
  }

  dispose(): void {
    if (this.hatchTimer !== null) clearTimeout(this.hatchTimer);
    if (this.poseTimer !== null) clearInterval(this.poseTimer);
    if (this.rosterTimer !== null) clearInterval(this.rosterTimer);
    this.hatchTimer = null;
    this.poseTimer = null;
    this.rosterTimer = null;
  }

  private hatch(): void {
    if (this.phase !== 'egg') return;
    if (this.hatchTimer !== null) clearTimeout(this.hatchTimer);
    this.hatchTimer = null;
    this.phase = 'alive';

    // Warm the caches before the phase flips so the alive screen mounts with
    // a name, a roster extent, and a first pose already in hand.
    this.emit(this.nameCbs, { t: 'name', name: localName(this.seed) });
    this.emitRoster();
    this.emitPose();
    this.emit(this.stateCbs, { t: 'state', phase: 'alive' });

    this.poseTimer = setInterval(() => this.emitPose(), POSE_INTERVAL_MS);
    this.rosterTimer = setInterval(() => this.emitRoster(), ROSTER_INTERVAL_MS);
  }

  private emitPose(): void {
    const pose = wanderPose(this.now(), this.seed, LOCAL_EXTENT);
    const fresh = this.emote !== null && this.now() < this.emoteUntil;
    const msg: PoseMsg = {
      t: 'pose',
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      ...(fresh && this.emote !== null ? { emote: this.emote } : {}),
    };
    this.emit(this.poseCbs, msg);
  }

  private emitRoster(): void {
    // No peers on one device — the roster still carries the map extent.
    this.emit(this.rosterCbs, { t: 'roster', peers: [], extent: LOCAL_EXTENT });
  }

  private emit<T>(cbs: Cb<T>[], msg: T): void {
    for (const cb of cbs) cb(msg);
  }
}

// ── Defensive RoomClient adapter ────────────────────────────────────────────
// src/net/client.ts is being built concurrently. Everything below treats its
// module surface as `unknown` and narrows: any missing capability throws
// inside createSession's try, which lands on SameDeviceSession.

const clientModules = import.meta.glob('../net/client.ts');

type AnyFn = (...args: unknown[]) => unknown;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function methodOf(target: unknown, key: string): AnyFn | null {
  const rec = asRecord(target);
  if (!rec) return null;
  const value = rec[key];
  return typeof value === 'function' ? (value as AnyFn).bind(target) : null;
}

function firstMethod(target: unknown, keys: readonly string[]): AnyFn | null {
  for (const key of keys) {
    const fn = methodOf(target, key);
    if (fn) return fn;
  }
  return null;
}

/** Get an instance out of whatever the module exports. */
function instantiateClient(mod: unknown): unknown {
  const rec = asRecord(mod) ?? {};
  const ctor = rec['RoomClient'];
  if (typeof ctor === 'function') {
    return new (ctor as new () => unknown)();
  }
  const factory = [rec['createRoomClient'], rec['default']].find(
    (v): v is AnyFn => typeof v === 'function',
  );
  if (factory) return factory();
  throw new Error('no room client export');
}

/** Resolve the relay URL via the module's own helper when it has one. */
function relayUrlFrom(mod: unknown): string | null {
  const helper = firstMethod(mod, ['defaultRelayUrl', 'relayUrl']);
  if (helper) {
    const url = helper();
    return typeof url === 'string' ? url : null;
  }
  if (typeof location !== 'undefined' && location.host !== '') {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}`;
  }
  return null;
}

/**
 * Wire callback fan-out into the instance. Supports both surfaces:
 * assignable callback slots (`client.onState = cb`, the current RoomClient
 * shape) and method-style subscription (`client.onState(cb)` /
 * `client.onMessage(cb)` / `client.on('message', cb)`).
 */
function wireListeners(
  instance: unknown,
  fanOut: {
    state: Cb<StateMsg>;
    pose: Cb<PoseMsg>;
    roster: Cb<RosterMsg>;
    name: Cb<NameMsg>;
  },
): void {
  const dispatch = (raw: unknown): void => {
    const msg = asRecord(raw);
    if (!msg) return;
    switch (msg['t']) {
      case 'state':
        fanOut.state(raw as StateMsg);
        break;
      case 'pose':
        fanOut.pose(raw as PoseMsg);
        break;
      case 'roster':
        fanOut.roster(raw as RosterMsg);
        break;
      case 'name':
        fanOut.name(raw as NameMsg);
        break;
      default:
        break;
    }
  };

  const rec = asRecord(instance);
  if (!rec) throw new Error('client instance is not an object');

  const slots: [string, (raw: unknown) => void][] = [
    ['onState', (raw): void => dispatch(withTag(raw, 'state'))],
    ['onPose', (raw): void => dispatch(withTag(raw, 'pose'))],
    ['onRoster', (raw): void => dispatch(withTag(raw, 'roster'))],
    ['onName', (raw): void => dispatch(withTag(raw, 'name'))],
  ];
  const haveAllSlots = slots.every(([key]) => key in rec);
  if (haveAllSlots) {
    for (const [key, handler] of slots) {
      const existing = rec[key];
      if (typeof existing === 'function') {
        // Method-style subscription under the same name.
        (existing as AnyFn).call(instance, handler);
      } else {
        // Assignable callback slot (the current RoomClient shape).
        rec[key] = handler;
      }
    }
    return;
  }

  const onMessage = firstMethod(instance, ['onMessage', 'subscribe']);
  if (onMessage) {
    onMessage(dispatch);
    return;
  }
  const on = firstMethod(instance, ['on', 'addEventListener']);
  if (on) {
    on('message', dispatch);
    return;
  }
  throw new Error('client has no message surface');
}

/** Per-type slots deliver typed messages that may or may not carry `t`. */
function withTag(raw: unknown, t: string): unknown {
  const rec = asRecord(raw);
  if (!rec) return raw;
  return rec['t'] === undefined ? { ...rec, t } : raw;
}

function adaptClient(instance: unknown, room: string, relayUrl: string | null): NetLike {
  const stateCbs: Cb<StateMsg>[] = [];
  const poseCbs: Cb<PoseMsg>[] = [];
  const rosterCbs: Cb<RosterMsg>[] = [];
  const nameCbs: Cb<NameMsg>[] = [];

  wireListeners(instance, {
    state: (m): void => {
      for (const cb of stateCbs) cb(m);
    },
    pose: (m): void => {
      for (const cb of poseCbs) cb(m);
    },
    roster: (m): void => {
      for (const cb of rosterCbs) cb(m);
    },
    name: (m): void => {
      for (const cb of nameCbs) cb(m);
    },
  });

  const sendDrawingFn = firstMethod(instance, ['sendDrawing']);
  const sendEmoteFn = firstMethod(instance, ['sendEmote']);
  const sendHatchFn = firstMethod(instance, ['sendHatch']);
  const sendFn = firstMethod(instance, ['send']);
  if (!sendDrawingFn && !sendFn) throw new Error('client has no send surface');

  // Connect after listeners are wired so no early message is missed. The
  // current RoomClient signature is connect(url, room, role); older/simpler
  // shapes might take (room) — try the rich call first.
  const connectFn = firstMethod(instance, ['connect', 'open', 'join']);
  if (connectFn) {
    try {
      connectFn(relayUrl, room, 'phone');
    } catch {
      connectFn(room);
    }
  }

  const readStatus = (): unknown => {
    const fn = firstMethod(instance, ['getStatus']);
    if (fn) return fn();
    const rec = asRecord(instance);
    const value = rec?.['status'];
    return typeof value === 'function' ? (value as AnyFn).call(instance) : value;
  };

  return {
    sendDrawing(strokes): void {
      if (sendDrawingFn) sendDrawingFn(strokes);
      else sendFn?.({ t: 'drawing', strokes });
    },
    sendEmote(emote): void {
      if (sendEmoteFn) sendEmoteFn(emote);
      else sendFn?.({ t: 'emote', emote });
    },
    sendHatch(): void {
      if (sendHatchFn) sendHatchFn();
      else sendFn?.({ t: 'hatch' });
    },
    onState(cb): void {
      stateCbs.push(cb);
    },
    onPose(cb): void {
      poseCbs.push(cb);
    },
    onRoster(cb): void {
      rosterCbs.push(cb);
    },
    onName(cb): void {
      nameCbs.push(cb);
    },
    status(): SessionStatus {
      const s = readStatus();
      if (s === 'online' || s === 'connecting' || s === 'offline') return s;
      if (s === 'open' || s === 'connected' || s === 'ready') return 'online';
      return 'connecting';
    },
    dispose(): void {
      firstMethod(instance, ['close', 'dispose', 'disconnect'])?.();
    },
  };
}

/**
 * Build the session for this page load: the room client when ?room=xxxx is
 * valid and src/net/client.ts adapts cleanly, SameDeviceSession otherwise.
 * Never throws — every failure degrades to the same-device flow.
 */
export async function createSession(search?: string): Promise<NetLike> {
  const query =
    search ?? (typeof location !== 'undefined' ? location.search : '');
  const room = roomFromLocation(query);
  if (room === null) return new SameDeviceSession();

  try {
    const loader = clientModules['../net/client.ts'];
    if (!loader) return new SameDeviceSession();
    const mod: unknown = await loader();
    const relayUrl = relayUrlFrom(mod);
    if (relayUrl === null) return new SameDeviceSession();
    const instance = instantiateClient(mod);
    return adaptClient(instance, room, relayUrl);
  } catch {
    return new SameDeviceSession();
  }
}
