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
import type { DrawFeed, DrawFeedOptions, FeedDrawing, FeedStroke } from './vendor/draw-feed';

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

export interface IncomingDrawing {
  /** Stable id for spawn bookkeeping (their id, or a hash of content). */
  id: string;
  /** Lowercased drawer name, if the phone page sent one. */
  name: string | null;
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

export function normalizeDrawing(d: FeedDrawing): IncomingDrawing | null {
  const strokes = feedDrawingToStrokes(d);
  if (strokes.length === 0) return null;
  const id = d.id != null ? String(d.id) : contentId(strokes);
  const name = typeof d.name === 'string' && d.name.trim() !== '' ? d.name.trim().toLowerCase() : null;
  return { id, name, strokes };
}

export interface WorldFeedOptions {
  room: string;
  onDrawing(d: IncomingDrawing): void;
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
