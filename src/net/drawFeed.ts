/**
 * Typed bridge from the vendored draw-to-3d feed into our pipeline.
 *
 * The kit's wire strokes are [{ color, width, pts: [[x, y], …] }] with
 * coordinates normalized 0..1 and width in units of a 320px reference canvas
 * (see vendor/draw-feed.js strokesToCanvas). Our pipeline wants the pure
 * StrokeList: { pts: [x, y, widthScale][], w } with w as a fraction of the
 * canvas. Their points carry no velocity data, so widthScale is 1 — the
 * woodcut edge modulation only exists for drawings captured by our own pad.
 * Color is dropped: the shape pipeline rasterizes a binary mask, and the
 * character is always the body token.
 */

import type { Stroke, StrokeList } from '../shape/types';
import { EMOTE_NAMES, type EmoteName } from './protocol';
import { readEmoteMessage, readHello } from './phoneLink';
import type { DrawFeed, DrawFeedOptions, FeedDrawing, FeedStroke } from './vendor/draw-feed';

const EMOTE_SET = new Set<string>(EMOTE_NAMES);
/** Guard for the wire: only the protocol's own emote names pass. */
export const isEmoteName = (v: string): boolean => EMOTE_SET.has(v);

/** Their width unit → fraction of canvas (matches vendor strokesToCanvas). */
const WIDTH_REFERENCE_PX = 320;
/** Their default stroke width when unset. */
const DEFAULT_FEED_WIDTH = 6;
/** Clamp incoming widths to a sane band of the canvas. */
const MIN_W = 0.012;
const MAX_W = 0.12;

export function feedStrokeToStroke(s: FeedStroke): Stroke | null {
  if (!Array.isArray(s.pts) || s.pts.length === 0) return null;
  const pts: [number, number, number][] = [];
  for (const p of s.pts) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = p[0];
    const y = p[1];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), 1]);
  }
  if (pts.length === 0) return null;
  const w = (s.width ?? DEFAULT_FEED_WIDTH) / WIDTH_REFERENCE_PX;
  return { pts, w: Math.min(MAX_W, Math.max(MIN_W, w)) };
}

export function feedDrawingToStrokes(d: FeedDrawing): StrokeList {
  const out: StrokeList = [];
  for (const s of d.strokes ?? []) {
    const stroke = feedStrokeToStroke(s);
    if (stroke) out.push(stroke);
  }
  return out;
}

/** The five audience personality answers ("what does your little creature
 * want most?" — docs/GENERATOR.md §behavior). */
export const PERSONALITIES = ['friends', 'snacks', 'sleep', 'adventure', 'chaos'] as const;
export type Personality = (typeof PERSONALITIES)[number];

export interface IncomingDrawing {
  /** Stable id for spawn bookkeeping (their id, or a hash of content). */
  id: string;
  /** Lowercased drawer name, if the phone page sent one. */
  name: string | null;
  /** Validated personality answer; anything else (absent, unknown value,
   * older phone page) → null, meaning neutral behavior defaults. */
  personality: Personality | null;
  strokes: StrokeList;
}

/** Deterministic fallback id from stroke content (no randomness). */
function contentId(strokes: StrokeList): string {
  let h = 2166136261;
  for (const s of strokes) {
    for (const [x, y] of s.pts) {
      h = Math.imul(h ^ ((x * 65535) | 0), 16777619);
      h = Math.imul(h ^ ((y * 65535) | 0), 16777619);
    }
  }
  return 'd' + (h >>> 0).toString(36);
}

function normalizePersonality(v: unknown): Personality | null {
  return typeof v === 'string' && (PERSONALITIES as readonly string[]).includes(v)
    ? (v as Personality)
    : null;
}

export function normalizeDrawing(d: FeedDrawing): IncomingDrawing | null {
  const strokes = feedDrawingToStrokes(d);
  if (strokes.length === 0) return null;
  const id = d.id != null ? String(d.id) : contentId(strokes);
  const name = typeof d.name === 'string' && d.name.trim() !== '' ? d.name.trim().toLowerCase() : null;
  return { id, name, personality: normalizePersonality(d.personality), strokes };
}

export interface WorldFeedOptions {
  room: string;
  onDrawing(d: IncomingDrawing): void;
  /** A phone tapped its emote wheel: `from` is the drawer id the world
   * spawned that creature under (src/net/phoneLink.ts). Optional — the
   * same-device flow never sees one. */
  onEmote?(e: { from: string; emote: EmoteName }): void;
  /** A phone announced itself. The world answers on the down topic with
   * that drawer's verdict and its own session id, which is how a phone
   * learns its drawing was refused, or that this world never knew it. */
  onHello?(e: { from: string }): void;
  onStatus?(state: 'on' | 'off' | '', text: string): void;
  broker?: string;
}

/**
 * Subscribe the world page to a room's drawing feed. Loads the vendored
 * module lazily and requires window.mqtt (the vendored client script tag) —
 * returns null when either is unavailable, so the same-device flow is
 * untouched with no network.
 */
export async function connectWorldFeed(opts: WorldFeedOptions): Promise<DrawFeed | null> {
  const w = globalThis as { mqtt?: unknown };
  if (!w.mqtt) return null;
  try {
    const mod = await import('./vendor/draw-feed.js');
    const feedOpts: DrawFeedOptions = {
      room: opts.room,
      throttleMs: 350, // pace floods so spawns never spike the render loop
      onDrawing: (d) => {
        // One topic, two message shapes: a drawing carries strokes, an
        // emote carries { type: 'emote' }. Route before normalizing, since
        // an emote has no strokes and would otherwise be dropped as junk.
        const emote = readEmoteMessage(d, isEmoteName);
        if (emote) {
          opts.onEmote?.(emote);
          return;
        }
        const hello = readHello(d);
        if (hello) {
          opts.onHello?.(hello);
          return;
        }
        const normalized = normalizeDrawing(d);
        if (normalized) opts.onDrawing(normalized);
      },
    };
    if (opts.onStatus) feedOpts.onStatus = opts.onStatus;
    if (opts.broker !== undefined) feedOpts.broker = opts.broker;
    return mod.createDrawFeed(feedOpts);
  } catch {
    return null;
  }
}

/**
 * Announce this world's session id as a RETAINED message.
 *
 * The difference between retained and not is the difference between a
 * recovery that works and one that needs luck. `publishToPhones` sends at
 * qos 0 with no retain, so a message only reaches handsets that are
 * connected at that instant — and a projection restart is exactly the moment
 * when phones are asleep, backgrounded, or reconnecting. Those phones never
 * hear that the world changed, so they never re-home their drawing, and the
 * population comes back short.
 *
 * A retained message is held by the broker and delivered to every subscriber
 * the moment it subscribes, however much later that is. So a phone that
 * wakes up in ten minutes learns the new epoch on connect, sees its record
 * is stale, and hands its drawing back with nobody pressing anything
 * (src/phone/main.ts). It also makes the reply-to-hello path a backstop
 * rather than the mechanism.
 *
 * Published through the feed's own client because the vendored
 * `publishToPhones` hardcodes `{ qos: 0 }` and cannot carry the flag. The
 * vendored file stays untouched.
 *
 * Best-effort by design: a client without `publish` (a test double, an
 * offline page) is simply skipped. Recovery must never be able to throw
 * inside the code path that starts the world.
 */
export function announceEpochRetained(feed: DrawFeed | null, epoch: string): boolean {
  if (!feed || epoch.length === 0) return false;
  const client = feed.client as {
    publish?(topic: string, payload: string, opts: Record<string, unknown>): void;
  } | null;
  if (!client || typeof client.publish !== 'function') return false;
  try {
    client.publish(feed.upTopic, JSON.stringify({ type: 'world', epoch }), {
      qos: 0,
      retain: true,
    });
    return true;
  } catch {
    return false;
  }
}
