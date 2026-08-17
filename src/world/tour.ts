/**
 * Presentation tour (GENERATOR §scale+camera, PLAN §7.1, TASTE §2.1).
 *
 * The camera has to choose: with creatures dispersed across a huge map there
 * is no single framing that contains them, so the presentation camera drifts
 * on its own — easing near clusters and lone wanderers, dwelling, then moving
 * on. It never cuts (forbidden at confidence 1.00): every reframe goes
 * through CameraRig.frameAt (a t.primary spring slide) and every zoom change
 * through the zoom spring. Wide compositions are frequent — roughly one dwell
 * in four frames an empty scenic quadrant, the world brief's "emptiness as
 * material".
 *
 * Manual is the default mode. Any user camera input (pan / rotate / zoom)
 * interrupts the tour instantly and it resumes only when re-enabled.
 *
 * The hatch-all moment is the generator brief's set piece: pull wide over the
 * population centroid, burst every shell at once, hold while dozens begin
 * moving, then drift on.
 *
 * Deterministic by construction: subject choice and dwell lengths derive from
 * a tick counter through the same hash family as the ambient drift floor —
 * no Math.random anywhere (shape/inflate discipline, applied here too so a
 * replayed session tours identically).
 */

import { MOTION } from '../taste/tokens';

export type TourMode = 'manual' | 'tour';

/** What the manager's positions() yields — the tour's whole world model. */
export interface EntityPoint {
  x: number;
  z: number;
  r: number;
  kind: 'egg' | 'character';
}

/** The slice of CameraRig the tour drives. Every method is drift-only. */
export interface TourCameraRig {
  frameAt(point: { x: number; y: number; z: number }): void;
  zoomTo(target: number): void;
  orbitDrift(radPerSec: number): void;
}

export interface TourDeps {
  cameraRig: TourCameraRig;
  positions(): EntityPoint[];
}

export interface Tour {
  setMode(mode: TourMode): void;
  mode(): TourMode;
  update(dt: number, nowMs: number): void;
  /** Any pan/rotate/zoom input — flips to manual instantly. */
  notifyUserInput(): void;
  /** The scripted set piece: wide slide → hatchAll() → hold → resume. */
  hatchAllMoment(hatchAll: () => void): void;
  /** Dwell length bounds (panel slider). */
  setDwellRange(minMs: number, maxMs: number): void;
  dispose(): void;
}

// ── tuning ───────────────────────────────────────────────────────────────────

/** Two or more entities within this radius read as a cluster (world units). */
export const CLUSTER_RADIUS = 12;
/** Fraction of dwells that frame an empty scenic quadrant instead. */
export const SCENIC_CHANCE = 0.25;
/** Dwell bounds. Pacing (a wait between reframes), not an animation
 * duration — the reframes themselves run on the motion-token springs. */
export const DWELL_MIN_MS = 6000;
export const DWELL_MAX_MS = 12000;
/** Zoom breathing: wider for scenic/cluster beats, closer for lone dwells. */
export const WIDE_ZOOM = 0.7;
export const CLOSE_ZOOM = 1.15;
/** The hatch-all pull-back — widest framing the tour ever asks for. */
export const HATCH_WIDE_ZOOM = 0.55;
/** Wide slide travel time before the burst: the t.primary reframe plus its
 * drift-settle tail. */
export const HATCH_SLIDE_MS = 1.2 * MOTION.primaryMs;
/** Hold on the wide while shells burst everywhere. */
export const HATCH_HOLD_MS = 2 * MOTION.primaryMs;
/** Azimuth drift during tour dwells (rad/s) — imperceptible frame to frame. */
export const ORBIT_DRIFT_RAD_PER_SEC = 0.02;
/** How far out a scenic quadrant's anchor sits (world units). */
export const SCENIC_RADIUS = 45;
/** Subjects this close to the previous dwell are penalized so the tour is
 * never locked to one creature. */
const REPEAT_RADIUS = 10;
const CLUSTER_BASE_SCORE = 10;
const SINGLE_BASE_SCORE = 1;
const REPEAT_PENALTY = 8;

// ── seeded choice ────────────────────────────────────────────────────────────

/**
 * Deterministic [0,1) from the dwell tick counter — same hash family as the
 * ambient drift floor (src/motion/ambient.ts). Channel separates independent
 * decisions made on the same tick.
 */
export function tourRand(tick: number, channel: number): number {
  const x = Math.sin(tick * 127.1 + channel * 311.7 + 17.13) * 43758.5453123;
  return x - Math.floor(x);
}

/** Scenic (wide, empty) beat gate — ~1 dwell in 4, hash-spread not metronomic. */
export function isScenicTick(tick: number): boolean {
  return tourRand(tick, 0) < SCENIC_CHANCE;
}

/** Seeded dwell length within [minMs, maxMs). */
export function dwellDurationMs(
  tick: number,
  minMs: number = DWELL_MIN_MS,
  maxMs: number = DWELL_MAX_MS,
): number {
  return minMs + tourRand(tick, 7) * (maxMs - minMs);
}

// ── interest model (pure) ────────────────────────────────────────────────────

export interface Cluster {
  x: number;
  z: number;
  size: number;
}

/**
 * Single-linkage grouping: entities chain into one cluster whenever each
 * link is within `radius`. Greedy absorb — deterministic in input order.
 */
export function findClusters(points: readonly EntityPoint[], radius: number = CLUSTER_RADIUS): Cluster[] {
  const grouped = new Array<boolean>(points.length).fill(false);
  const clusters: Cluster[] = [];
  const r2 = radius * radius;
  for (let i = 0; i < points.length; i++) {
    if (grouped[i]) continue;
    const members = [i];
    grouped[i] = true;
    // Absorb until stable: chains merge (single linkage).
    for (let m = 0; m < members.length; m++) {
      const idx = members[m];
      if (idx === undefined) continue;
      const a = points[idx];
      if (!a) continue;
      for (let j = 0; j < points.length; j++) {
        if (grouped[j]) continue;
        const b = points[j];
        if (!b) continue;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        if (dx * dx + dz * dz <= r2) {
          grouped[j] = true;
          members.push(j);
        }
      }
    }
    let sx = 0;
    let sz = 0;
    for (const idx of members) {
      const p = points[idx];
      if (!p) continue;
      sx += p.x;
      sz += p.z;
    }
    clusters.push({ x: sx / members.length, z: sz / members.length, size: members.length });
  }
  return clusters;
}

export interface Subject {
  x: number;
  z: number;
  kind: 'cluster' | 'single' | 'scenic';
  size: number;
  zoom: number;
  score: number;
}

/**
 * Score every candidate subject, best first. Clusters (2+ within
 * CLUSTER_RADIUS) always outrank singles; anything near the previous dwell
 * is penalized so the tour keeps moving. Tie-breaks come from the tick hash.
 */
export function scoreSubjects(
  points: readonly EntityPoint[],
  tick: number,
  last: { x: number; z: number } | null,
): Subject[] {
  const clusters = findClusters(points);
  const subjects = clusters.map((c, i) => {
    const isCluster = c.size >= 2;
    let score = isCluster ? CLUSTER_BASE_SCORE + c.size : SINGLE_BASE_SCORE;
    // Seeded jitter breaks ties between equal candidates without ever
    // crossing the cluster/single band gap.
    score += tourRand(tick, 8 + i) * 0.5;
    if (last) {
      const dx = c.x - last.x;
      const dz = c.z - last.z;
      if (dx * dx + dz * dz < REPEAT_RADIUS * REPEAT_RADIUS) score -= REPEAT_PENALTY;
    }
    return {
      x: c.x,
      z: c.z,
      kind: (isCluster ? 'cluster' : 'single') as Subject['kind'],
      size: c.size,
      zoom: isCluster ? WIDE_ZOOM : CLOSE_ZOOM,
      score,
    };
  });
  subjects.sort((a, b) => b.score - a.score);
  return subjects;
}

/** Population centroid; origin when the world is empty. */
export function centroid(points: readonly EntityPoint[]): { x: number; z: number } {
  if (points.length === 0) return { x: 0, z: 0 };
  let sx = 0;
  let sz = 0;
  for (const p of points) {
    sx += p.x;
    sz += p.z;
  }
  return { x: sx / points.length, z: sz / points.length };
}

/**
 * A wide-composition beat: anchor in the emptiest quadrant (fewest entities;
 * hash tie-break), jittered so repeats don't land on the same spot.
 */
export function scenicSubject(points: readonly EntityPoint[], tick: number): Subject {
  const counts = [0, 0, 0, 0];
  for (const p of points) {
    const q = (p.x >= 0 ? 0 : 1) + (p.z >= 0 ? 0 : 2);
    const c = counts[q];
    if (c !== undefined) counts[q] = c + 1;
  }
  let best = 0;
  let bestCount = Number.POSITIVE_INFINITY;
  const rotate = Math.floor(tourRand(tick, 1) * 4);
  for (let i = 0; i < 4; i++) {
    const q = (i + rotate) % 4;
    const c = counts[q] ?? 0;
    if (c < bestCount) {
      bestCount = c;
      best = q;
    }
  }
  const sx = best & 1 ? -1 : 1;
  const sz = best & 2 ? -1 : 1;
  const d = SCENIC_RADIUS * (0.55 + tourRand(tick, 2) * 0.45);
  const skew = (tourRand(tick, 3) - 0.5) * 0.6;
  return {
    x: sx * d * (1 + skew),
    z: sz * d * (1 - skew),
    kind: 'scenic',
    size: 0,
    zoom: WIDE_ZOOM,
    score: 0,
  };
}

/** The tour's dwell choice for a tick: scenic beat, else best-scored subject. */
export function pickSubject(
  points: readonly EntityPoint[],
  tick: number,
  last: { x: number; z: number } | null,
): Subject {
  if (points.length === 0 || isScenicTick(tick)) return scenicSubject(points, tick);
  const ranked = scoreSubjects(points, tick, last);
  return ranked[0] ?? scenicSubject(points, tick);
}

// ── the tour itself ──────────────────────────────────────────────────────────

export function createTour(deps: TourDeps): Tour {
  let currentMode: TourMode = 'manual';
  let disposed = false;

  // Dwell state. tick seeds every choice; dwellRemaining ≤ 0 forces a pick
  // on the next update, so enabling the tour reframes immediately.
  let tick = 0;
  let dwellRemainingMs = 0;
  let dwellMinMs = DWELL_MIN_MS;
  let dwellMaxMs = DWELL_MAX_MS;
  let lastSubject: { x: number; z: number } | null = null;

  // Hatch-all set piece. Runs independent of mode — a manual presenter can
  // trigger it too; the underlying mode resumes untouched when it ends.
  type HatchPhase = 'idle' | 'slide' | 'hold';
  let hatchPhase: HatchPhase = 'idle';
  let hatchTimerMs = 0;
  let hatchCb: (() => void) | null = null;

  /** Azimuth drifts only during tour dwells — never under the user's hand,
   * never during the hatch hold (the wide should feel poised, not restless —
   * the ambient floor keeps it alive). */
  function applyDrift(): void {
    deps.cameraRig.orbitDrift(
      currentMode === 'tour' && hatchPhase === 'idle' ? ORBIT_DRIFT_RAD_PER_SEC : 0,
    );
  }

  function beginDwell(): void {
    const subject = pickSubject(deps.positions(), tick, lastSubject);
    deps.cameraRig.frameAt({ x: subject.x, y: 0, z: subject.z });
    deps.cameraRig.zoomTo(subject.zoom);
    dwellRemainingMs = dwellDurationMs(tick, dwellMinMs, dwellMaxMs);
    lastSubject = { x: subject.x, z: subject.z };
    tick++;
  }

  /** Fire the pending hatch callback exactly once. */
  function fireHatch(): void {
    const cb = hatchCb;
    hatchCb = null;
    cb?.();
  }

  return {
    setMode(mode: TourMode): void {
      if (disposed || mode === currentMode) return;
      currentMode = mode;
      if (mode === 'tour' && hatchPhase === 'idle') dwellRemainingMs = 0;
      applyDrift();
    },

    mode(): TourMode {
      return currentMode;
    },

    update(dt: number, _nowMs: number): void {
      if (disposed) return;
      if (hatchPhase !== 'idle') {
        hatchTimerMs -= dt;
        if (hatchPhase === 'slide' && hatchTimerMs <= 0) {
          // The wide slide has settled — burst every shell at once.
          fireHatch();
          hatchPhase = 'hold';
          hatchTimerMs = HATCH_HOLD_MS;
        } else if (hatchPhase === 'hold' && hatchTimerMs <= 0) {
          // Resume whatever mode was active: tour drifts to its next dwell,
          // manual just stays where the wide left it.
          hatchPhase = 'idle';
          if (currentMode === 'tour') dwellRemainingMs = 0;
          applyDrift();
        }
        return;
      }
      if (currentMode !== 'tour') return;
      dwellRemainingMs -= dt;
      if (dwellRemainingMs <= 0) beginDwell();
    },

    notifyUserInput(): void {
      if (disposed) return;
      if (hatchPhase !== 'idle') {
        // The camera is the user's again, but the presenter asked for the
        // hatch — if the burst hasn't fired yet, fire it now rather than
        // swallowing it.
        fireHatch();
        hatchPhase = 'idle';
      }
      currentMode = 'manual';
      applyDrift();
    },

    hatchAllMoment(hatchAll: () => void): void {
      if (disposed || hatchPhase !== 'idle') return;
      hatchCb = hatchAll;
      const c = centroid(deps.positions());
      // Leg 1: pull wide and slide to the population centroid — both on the
      // existing springs, so mid-flight retargets stay continuous.
      deps.cameraRig.zoomTo(HATCH_WIDE_ZOOM);
      deps.cameraRig.frameAt({ x: c.x, y: 0, z: c.z });
      hatchPhase = 'slide';
      hatchTimerMs = HATCH_SLIDE_MS;
      applyDrift();
    },

    setDwellRange(minMs: number, maxMs: number): void {
      dwellMinMs = Math.max(1000, minMs);
      dwellMaxMs = Math.max(dwellMinMs, maxMs);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      hatchCb = null;
      deps.cameraRig.orbitDrift(0);
    },
  };
}
