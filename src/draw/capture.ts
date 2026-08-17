/**
 * Pointer capture for the phone draw screen (PLAN §3.1).
 *
 * Listens to Pointer Events on a square canvas, drains coalesced events so
 * fast phone strokes don't go polygonal, and emits strokes in the wire
 * format from src/shape/types.ts: pts as [x, y, widthScale] triples with
 * x/y normalized to [0, 1] over the canvas square. Width is
 * velocity-modulated via src/draw/velocity.ts — slow thickens, fast thins.
 *
 * Points are stored exactly as captured — no resampling, no smoothing of
 * positions. The stroke list is the deterministic pipeline input both the
 * phone and the world share (PLAN §6.3), so capture must not editorialize.
 *
 * Capture-relative timestamps are kept in a parallel structure
 * (TimedStrokeList) for the egg paint-on replay later; the Stroke type
 * itself is untouched.
 */

import type { Stroke, StrokeList } from '../shape/types';
import {
  createWidthTracker,
  DEFAULT_MID_SPEED,
  type WidthTracker,
} from './velocity';

/** Base stroke width as a fraction of the canvas square (PLAN §3.1). */
export const DEFAULT_BASE_WIDTH = 0.045;

/**
 * StrokeList plus capture-relative timing, kept OUTSIDE the Stroke type so
 * the wire format in src/shape/types.ts stays untouched.
 */
export interface TimedStrokeList {
  strokes: StrokeList;
  /**
   * timesMs[i][j] is the capture time of strokes[i].pts[j], in ms relative
   * to the first pen-down of the session. Parallel to strokes.
   */
  timesMs: number[][];
}

export interface DrawCaptureOptions {
  /** Base stroke width (fraction of canvas). Default DEFAULT_BASE_WIDTH. */
  baseWidth?: number;
  /**
   * Called after every mutation — new points while drawing, stroke end,
   * undo, clear. Receives the LIVE stroke list (including the in-progress
   * stroke) as a read-only view for cheap re-rendering; call getStrokes()
   * for a defensive copy.
   */
  onChange?: (strokes: StrokeList) => void;
}

export class DrawCapture {
  private canvas: HTMLCanvasElement | null = null;
  private strokes: Stroke[] = [];
  private timesMs: number[][] = [];

  /** In-progress stroke — already present at the tail of `strokes`. */
  private active: Stroke | null = null;
  private activeTimes: number[] | null = null;
  private activePointerId: number | null = null;

  private readonly tracker: WidthTracker = createWidthTracker();
  /** Last accepted point, in CSS px + event time, for speed computation. */
  private last: { x: number; y: number; t: number; scale: number } | null = null;
  /** timeStamp of the session's first pen-down; timestamps are relative to it. */
  private epoch: number | null = null;

  private readonly baseWidth: number;
  onChange: ((strokes: StrokeList) => void) | undefined;

  // Bound once so detach() removes the same references.
  private readonly handleDown = (e: PointerEvent): void => this.onDown(e);
  private readonly handleMove = (e: PointerEvent): void => this.onMove(e);
  private readonly handleUp = (e: PointerEvent): void => this.onUp(e);

  constructor(options?: DrawCaptureOptions) {
    this.baseWidth = options?.baseWidth ?? DEFAULT_BASE_WIDTH;
    this.onChange = options?.onChange;
  }

  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas) return;
    this.detach();
    this.canvas = canvas;
    // One brush, one finger: the canvas must never scroll or zoom mid-stroke.
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.handleDown);
    canvas.addEventListener('pointermove', this.handleMove);
    canvas.addEventListener('pointerup', this.handleUp);
    canvas.addEventListener('pointercancel', this.handleUp);
  }

  detach(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    this.endStroke();
    canvas.removeEventListener('pointerdown', this.handleDown);
    canvas.removeEventListener('pointermove', this.handleMove);
    canvas.removeEventListener('pointerup', this.handleUp);
    canvas.removeEventListener('pointercancel', this.handleUp);
    this.canvas = null;
  }

  /** Deep copy of the captured strokes (the wire format). */
  getStrokes(): StrokeList {
    return this.strokes.map((s) => ({
      pts: s.pts.map((p) => [...p] as [number, number, number]),
      w: s.w,
    }));
  }

  /** Deep copy of strokes plus their capture-relative timestamps. */
  getTimedStrokes(): TimedStrokeList {
    return {
      strokes: this.getStrokes(),
      timesMs: this.timesMs.map((t) => [...t]),
    };
  }

  /**
   * Remove the last stroke. While a stroke is in progress, undo cancels it
   * instead — the natural "no, not that" mid-gesture.
   */
  undo(): void {
    if (this.active) {
      this.cancelActive();
    } else if (this.strokes.length > 0) {
      this.strokes.pop();
      this.timesMs.pop();
    } else {
      return;
    }
    this.emit();
  }

  clear(): void {
    if (this.active) this.cancelActive();
    if (this.strokes.length === 0) return;
    this.strokes = [];
    this.timesMs = [];
    this.emit();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private onDown(e: PointerEvent): void {
    if (!this.canvas || this.activePointerId !== null) return;
    this.activePointerId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.epoch ??= e.timeStamp;

    // Seed the EMA at the neutral speed so every stroke starts at width
    // scale 1.0 and diverges from there (see velocity.ts).
    this.tracker.reset();
    const seedScale = this.tracker.push(DEFAULT_MID_SPEED);

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const stroke: Stroke = {
      pts: [[this.norm(x, rect.width), this.norm(y, rect.height), seedScale]],
      w: this.baseWidth,
    };
    const times = [e.timeStamp - this.epoch];

    this.active = stroke;
    this.activeTimes = times;
    this.strokes.push(stroke);
    this.timesMs.push(times);
    this.last = { x, y, t: e.timeStamp, scale: seedScale };
    this.emit();
  }

  private onMove(e: PointerEvent): void {
    if (!this.canvas || e.pointerId !== this.activePointerId) return;
    // Coalesced events recover the full-rate pointer trail between frames;
    // guard for browsers (and some pens) that don't implement it or return
    // an empty batch.
    const coalesced =
      typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events: PointerEvent[] = coalesced.length > 0 ? coalesced : [e];

    const rect = this.canvas.getBoundingClientRect();
    let added = false;
    for (const ev of events) {
      if (this.addPoint(ev, rect)) added = true;
    }
    if (added) this.emit();
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.activePointerId) return;
    this.endStroke();
    this.emit();
  }

  /** Append one point to the active stroke. Returns true if a point landed. */
  private addPoint(ev: PointerEvent, rect: DOMRect): boolean {
    if (!this.active || !this.activeTimes || !this.last || this.epoch === null)
      return false;
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const dx = x - this.last.x;
    const dy = y - this.last.y;
    const dt = ev.timeStamp - this.last.t;
    const dist = Math.hypot(dx, dy);
    // Exact duplicate sample — nothing to record.
    if (dist === 0 && dt <= 0) return false;

    // Speed in CSS px/ms. When two samples share a timestamp (coalesced
    // batches sometimes do) there is no usable dt: keep the previous width
    // rather than inventing an infinite speed.
    const scale = dt > 0 ? this.tracker.push(dist / dt) : this.last.scale;

    this.active.pts.push([
      this.norm(x, rect.width),
      this.norm(y, rect.height),
      scale,
    ]);
    this.activeTimes.push(ev.timeStamp - this.epoch);
    this.last = { x, y, t: ev.timeStamp, scale };
    return true;
  }

  /** Finalize the in-progress stroke (it is already in the list). */
  private endStroke(): void {
    if (this.activePointerId !== null && this.canvas?.hasPointerCapture(this.activePointerId)) {
      this.canvas.releasePointerCapture(this.activePointerId);
    }
    this.active = null;
    this.activeTimes = null;
    this.activePointerId = null;
    this.last = null;
  }

  /** Drop the in-progress stroke entirely (undo/clear mid-gesture). */
  private cancelActive(): void {
    this.endStroke();
    this.strokes.pop();
    this.timesMs.pop();
  }

  private norm(v: number, extent: number): number {
    if (extent <= 0) return 0;
    return Math.min(1, Math.max(0, v / extent));
  }

  private emit(): void {
    this.onChange?.(this.strokes);
  }
}
