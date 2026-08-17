/**
 * Types for the vendored draw-to-3d feed module (./draw-feed.js).
 * Vendored from the user-supplied draw-to-3d kit; see public/draw/ for the
 * matching phone page. Typed to exactly the surface we use.
 */

/** Their wire stroke: color/width plus bare [x, y] points, all 0..1. */
export interface FeedStroke {
  color?: string;
  width?: number;
  pts: [number, number][];
}

export interface FeedDrawing {
  id?: string | number;
  name?: string;
  /** Audience personality answer added by our draw page; untyped on the wire
   * (createDrawFeed passes the parsed payload through untouched), validated
   * by normalizeDrawing on ingest. */
  personality?: string | null;
  strokes: FeedStroke[];
  ts?: number;
}

export interface DrawFeedOptions {
  broker?: string;
  topicPrefix?: string;
  room?: string;
  mqtt?: unknown;
  accept?: boolean;
  maxQueue?: number;
  throttleMs?: number;
  dedupe?: boolean;
  onDrawing?: (d: FeedDrawing) => void;
  onStatus?: (state: 'on' | 'off' | '', text: string) => void;
}

export interface DrawFeed {
  client: unknown;
  topic: string;
  upTopic: string;
  setAccepting(v: boolean): boolean;
  publishToPhones(obj: Record<string, unknown>): void;
  destroy(): void;
}

export const DEFAULTS: { broker: string; topicPrefix: string; room: string };
export function createDrawFeed(opts?: DrawFeedOptions): DrawFeed;
export function strokesToCanvas(
  strokes: FeedStroke[],
  opts?: { size?: number; background?: string; padding?: number },
): HTMLCanvasElement;
export function strokesToDataURL(
  strokes: FeedStroke[],
  opts?: { size?: number; background?: string; padding?: number },
): string;
export function topicFor(room: string, prefix?: string): string;
