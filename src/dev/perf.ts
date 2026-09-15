/**
 * Pure helpers behind the dev panel's perf readout (the live line the crowd
 * reference demo shows: frame ms, draw calls, triangles, instance count).
 *
 * No DOM, no Three.js, no timers — the ring and the formatter are plain
 * arithmetic over numbers so test/dev/perf.test.ts can pin them in node.
 * Everything here is imported only from src/dev/, so it leaves the demo
 * build with the rest of the dev chunk.
 */

/** Frames kept in the ring — two seconds at 60fps, the window the readout
 * averages and takes its p95 from. */
export const FRAME_RING_SIZE = 120;

export interface FrameStats {
  /** Mean frame time in ms over the ring, 0 when empty. */
  avgMs: number;
  /** 95th percentile frame time in ms over the ring, 0 when empty. */
  p95Ms: number;
  /** How many samples the ring currently holds. */
  frames: number;
}

export interface FrameRing {
  push(ms: number): void;
  stats(): FrameStats;
  reset(): void;
}

/**
 * A fixed-size ring of frame times.
 *
 * Non-finite and negative deltas are dropped rather than stored: a tab that
 * was backgrounded hands back a garbage first delta, and one bad sample in a
 * 120-frame window moves the average by a whole millisecond.
 */
export function createFrameRing(size: number = FRAME_RING_SIZE): FrameRing {
  const capacity = Math.max(1, Math.floor(size));
  const samples: number[] = [];
  let head = 0;
  return {
    push(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) return;
      if (samples.length < capacity) samples.push(ms);
      else {
        samples[head] = ms;
        head = (head + 1) % capacity;
      }
    },
    stats(): FrameStats {
      return frameStats(samples);
    },
    reset(): void {
      samples.length = 0;
      head = 0;
    },
  };
}

/** Mean and p95 over a sample list, in the order-independent way the ring
 * needs (the ring stores samples out of order once it wraps). */
export function frameStats(samples: readonly number[]): FrameStats {
  const n = samples.length;
  if (n === 0) return { avgMs: 0, p95Ms: 0, frames: 0 };
  let total = 0;
  for (const s of samples) total += s;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1));
  return { avgMs: total / n, p95Ms: sorted[index] ?? 0, frames: n };
}

/**
 * Counts in the readout's shorthand: 1234 → `1.2k`, 1_200_000 → `1.2m`.
 * Lowercase suffixes (TASTE §5 — no uppercase type anywhere).
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export interface PerfLineInput {
  frames: FrameStats;
  /** renderer.info.render.calls — omitted when the build has no renderer
   * handle (DevHandles.renderer is optional). */
  calls?: number | undefined;
  /** renderer.info.render.triangles — same story. */
  triangles?: number | undefined;
  creatures: number;
}

/**
 * The one line: `frame 16.4ms (p95 22.1) · draw calls 213 · tris 1.2m ·
 * creatures 200`. Renderer fields drop out entirely when absent rather than
 * printing a zero that would read as "nothing is drawing".
 */
export function formatPerfLine(input: PerfLineInput): string {
  const { frames } = input;
  const parts: string[] = [
    frames.frames === 0
      ? 'frame —'
      : `frame ${frames.avgMs.toFixed(1)}ms (p95 ${frames.p95Ms.toFixed(1)})`,
  ];
  if (typeof input.calls === 'number') parts.push(`draw calls ${formatCount(input.calls)}`);
  if (typeof input.triangles === 'number') parts.push(`tris ${formatCount(input.triangles)}`);
  parts.push(`creatures ${formatCount(input.creatures)}`);
  return parts.join(' · ');
}
