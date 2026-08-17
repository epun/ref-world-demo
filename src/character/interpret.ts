/**
 * The interpretation pass (GENERATOR §1a — "drawn objects keep their shape").
 *
 * The creature's body silhouette IS the drawing's own shape, processed for
 * robustness: outline drawings are flood-filled into solid mass, stray and
 * thin ink is chunkified to a minimum body thickness (never a wire figure),
 * and the contour is simplified CORNER-PRESERVINGLY — a drawn triangle keeps
 * its three shoulders, softened by hand-wobble rather than rounded into a
 * blob. Species membership comes from what gets ADDED around that shape:
 * the two tiny stubby legs every character stands on (user ruling),
 * grounding, and the proportion band. Motif extraction (./extractMotifs)
 * still measures the ORIGINAL drawing; drawn feet/ears/crowns stay part of
 * the contour and the species legs stamp beneath the grounded mass.
 *
 * The processed silhouette is a MASK, not a re-synthesized stroke list: the
 * mask runs through the same pure tail (distance transform → contour →
 * skeleton → analyzeMask) that analyze() uses, so eyes, deformation, and
 * locomotion all work on the actual body. interpretDrawing returns the
 * ORIGINAL strokes untouched — they serve the egg paint-on and the marking
 * channel, while only the analysis drives the mesh.
 *
 * Recognition channel 2 (the drawing painted onto the body) lives in
 * ./marking.ts; the verbatim path survives as fidelity 0 (the dial's floor).
 *
 * PURE module: no Three.js, no DOM, no Math.random, no Date. Same strokes →
 * same creature on every device (PLAN §6.3). All randomness is a seeded LCG
 * keyed off a hash of the input strokes, optionally salted by a stable
 * identity id (identitySeedOf) so no two submissions ever share a body.
 */

import { analyze, analyzeMask, type AnalyzeOptions } from '../shape/analyze';
import {
  chaikin,
  chaikinOpen,
  detectCorners,
  resample,
  resampleOpen,
  simplify,
  simplifyOpen,
  traceContour,
} from '../shape/contour';
import { distanceTransform } from '../shape/distance';
import {
  dilate,
  erode,
  fillHoles,
  largestComponent,
  rasterize,
  stampLine,
} from '../shape/raster';
import type {
  Archetype,
  Contour,
  Feature,
  Mask,
  Point,
  ShapeAnalysis,
  StrokeList,
} from '../shape/types';

// ── Motifs ───────────────────────────────────────────────────────────────────

/** A drawn foot: where it points and how far it sticks out. */
export interface FootMotif {
  /** Radians off straight-down, from the ink-bounds center. Positive → right. */
  angle: number;
  /** Distance from the bounds center, normalized by half the ink height. */
  reach: number;
}

/** A drawn lateral limb (arm/wing). */
export interface LimbMotif {
  /** −1 left, +1 right of the bounds center. */
  side: -1 | 1;
  /** Height up the body, 0 = bottom of ink, 1 = top. */
  height: number;
  /** Lateral extent from center, normalized by half the ink width. */
  reach: number;
}

/** A top-of-head appendage (ear / antenna / horn). */
export interface CrownMotif {
  /** Radians off straight-up, from the head lobe. Positive → right. */
  angle: number;
  /** How far it rises above the head's inscribed disc, / ink height. */
  reach: number;
}

/** Everything the species synthesis reads from a drawing. */
export interface Motifs {
  archetype: Archetype;
  /** BODY aspect: bulk height / bulk width from the mask's row-coverage
   * profile. Appendages don't stretch it. */
  aspect: number;
  /** DT peak vs the bounds — 1 for a full disc, small for a skinny scrawl. */
  torsoFullness: number;
  /** Head thickness at the head lobe relative to the body's DT peak. */
  headSize: number;
  feet: FootMotif[];
  limbs: LimbMotif[];
  /** THE signature motif channel — drawn ears/antennae/horns. */
  crown: CrownMotif[];
  /** Contour turning-angle deviation, normalized to [0, 1]. */
  lumpiness: number;
}

// ── small pure helpers ───────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Same LCG recipe as the egg module — deterministic per seed. */
function makeRng(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Deterministic seed from the stroke data — FNV-1a over quantized points, so
 * the same drawing yields the same creature everywhere (and a nudged drawing
 * yields a visibly different individual of the same species).
 */
export function strokeSeed(strokes: StrokeList): number {
  let h = 2166136261;
  for (const stroke of strokes) {
    h = Math.imul(h ^ Math.round(stroke.w * 4096), 16777619);
    for (const [x, y, ws] of stroke.pts) {
      h = Math.imul(h ^ Math.round(x * 4096), 16777619);
      h = Math.imul(h ^ Math.round(y * 4096), 16777619);
      h = Math.imul(h ^ Math.round(ws * 256), 16777619);
    }
  }
  return h >>> 0;
}

/**
 * Identity salt: FNV-1a over a stable id string (a publish id, a slot id).
 * Mixed into the stroke seed so the SAME drawing submitted twice (two ids)
 * hatches two visibly distinct individuals, while the same submission viewed
 * on phone and world (same id) stays byte-identical. Same recipe as the
 * behavior seed, so no new hash family enters the deterministic path.
 */
export function identitySeedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── motif extraction ─────────────────────────────────────────────────────────

/**
 * Skeleton features at production resolution are noisy — stacked duplicate
 * leaves along a limb, hairline spurs on a blob's rim. Features are filtered
 * by thickness (absolute + relative floors), then single-linkage clustered so
 * one drawn leg reads as one motif.
 */
function clusterFeatures(features: Feature[], radius: number): Feature[][] {
  const clusters: Feature[][] = [];
  for (const f of features) {
    let home: Feature[] | null = null;
    for (const c of clusters) {
      if (c.length === 0) continue;
      const near = c.some((m) => Math.hypot(m.at.x - f.at.x, m.at.y - f.at.y) <= radius);
      if (!near) continue;
      if (home) {
        // f bridges two clusters — merge.
        home.push(...c);
        c.length = 0;
      } else {
        c.push(f);
        home = c;
      }
    }
    if (!home) clusters.push([f]);
  }
  return clusters.filter((c) => c.length > 0);
}

/** Deterministic representative of a cluster. */
function pick(cluster: Feature[], better: (a: Feature, b: Feature) => boolean): Feature {
  let best = cluster[0]!;
  for (const f of cluster) if (better(f, best)) best = f;
  return best;
}

/**
 * Turning-angle deviation of the smoothed contour. A resampled circle turns
 * uniformly (deviation ~0); a lumpy hand-drawn outline wobbles around the
 * mean. Normalized so ~0.35 rad of standard deviation saturates to 1.
 */
function contourLumpiness(contour: Contour): number {
  const n = contour.length;
  if (n < 8) return 0;
  let sum = 0;
  const turns = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const a = contour[(i + n - 1) % n]!;
    const b = contour[i]!;
    const c = contour[(i + 1) % n]!;
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const t = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
    turns[i] = t;
    sum += t;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (turns[i]! - mean) ** 2;
  return clamp(Math.sqrt(varSum / n) / 0.35, 0, 1);
}

/**
 * Split one past-the-line contour run into its distinct protrusion tips.
 * Two drawn ears whose bases both rise past the line arrive as a single run;
 * the height profile then shows two peaks with a low saddle between them.
 * A peak survives next to a taller neighbor only when the saddle drops below
 * 0.35 × the smaller peak — hand-wobble bumps merge, real appendages split.
 */
function splitPeaks(run: Point[], height: (p: Point) => number): Point[] {
  // Local maxima of the height profile (plateau-tolerant).
  const peaks: number[] = [];
  for (let i = 0; i < run.length; i++) {
    const h = height(run[i]!);
    const prev = i > 0 ? height(run[i - 1]!) : -Infinity;
    const next = i < run.length - 1 ? height(run[i + 1]!) : -Infinity;
    if (h >= prev && h > next) peaks.push(i);
  }
  if (peaks.length === 0) peaks.push(0);

  // Merge peaks whose separating saddle stays high.
  const kept: number[] = [peaks[0]!];
  for (let k = 1; k < peaks.length; k++) {
    const candidate = peaks[k]!;
    const last = kept[kept.length - 1]!;
    let saddle = Infinity;
    for (let i = last; i <= candidate; i++) saddle = Math.min(saddle, height(run[i]!));
    const smaller = Math.min(height(run[last]!), height(run[candidate]!));
    if (saddle < smaller * 0.35) {
      kept.push(candidate);
    } else if (height(run[candidate]!) > height(run[last]!)) {
      kept[kept.length - 1] = candidate;
    }
  }
  return kept.map((i) => run[i]!);
}

/**
 * Contour protrusions past a horizontal line — the extremity detector for
 * crown appendages (above the head's inscribed disc) and feet (below the
 * belly's). This reads the CONTOUR, not skeleton leaves: diagonal or thin
 * hand-drawn appendages rasterize with ragged ridges whose leaves the
 * skeleton pruning eats (especially at production resolution), while the
 * contour keeps them faithfully. Each circular run of points past the line
 * yields one or more tips (see splitPeaks).
 */
function contourProtrusions(
  contour: Contour,
  line: number,
  eps: number,
  below: boolean,
): Point[] {
  const n = contour.length;
  if (n === 0) return [];
  const past = contour.map((p) => (below ? p.y > line + eps : p.y < line - eps));
  if (past.every(Boolean) || !past.some(Boolean)) return [];
  const height = (p: Point): number => (below ? p.y - line : line - p.y);

  // Circular runs of past-the-line points; start scanning at a non-past point.
  const start = past.indexOf(false);
  const reps: Point[] = [];
  let run: Point[] = [];
  for (let k = 0; k <= n; k++) {
    const i = (start + k) % n;
    if (k < n && past[i]) {
      run.push(contour[i]!);
    } else if (run.length > 0) {
      reps.push(...splitPeaks(run, height));
      run = [];
    }
  }
  return reps;
}

/** DT sample at a point, nearest pixel. */
function dtAt(analysis: ShapeAnalysis, x: number, y: number): number {
  const size = analysis.distance.size;
  const px = clamp(Math.round(x), 0, size - 1);
  const py = clamp(Math.round(y), 0, size - 1);
  return analysis.distance.data[py * size + px]!;
}

/** Top of the head's inscribed disc — appendages rise above it. */
function crownLineOf(analysis: ShapeAnalysis): number {
  const { headLobe } = analysis;
  return headLobe.y - Math.max(dtAt(analysis, headLobe.x, headLobe.y), 1);
}

/**
 * Bottom of the belly's inscribed disc — the bottom-most pixel carrying
 * (near-)peak thickness, plus the peak. Legs hang below it.
 */
function bellyLineOf(analysis: ShapeAnalysis): number {
  const { size, data, max } = analysis.distance;
  const floor = max * 0.985;
  let bx = 0;
  let by = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x]! >= floor && y >= by) {
        if (y > by) bx = x;
        by = y;
      }
    }
  }
  if (by < 0) return analysis.bounds.maxY;
  return by + Math.max(data[by * size + bx]!, 1);
}

/** Crown appendages: contour runs rising above the head's inscribed disc. */
function extractCrown(analysis: ShapeAnalysis): CrownMotif[] {
  const { contour, headLobe, bounds } = analysis;
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const crownLine = crownLineOf(analysis);

  const motifs: CrownMotif[] = [];
  for (const tip of contourProtrusions(contour, crownLine, 0.015 * h, false)) {
    const reach = (crownLine - tip.y) / h;
    if (reach < 0.03) continue;
    motifs.push({
      angle: Math.atan2(tip.x - headLobe.x, headLobe.y - tip.y),
      reach,
    });
  }
  // Keep the three strongest, presented left→right.
  motifs.sort((a, b) => b.reach - a.reach);
  const kept = motifs.slice(0, 3);
  kept.sort((a, b) => a.angle - b.angle);
  return kept;
}

/**
 * Feet: contour runs dropping below the belly's inscribed disc — the
 * bottom-most point of peak thickness plus the peak itself. Robust where the
 * skeleton channel is not (thin legs on a fat body are pruned wholesale at
 * production resolution).
 */
function extractFeet(analysis: ShapeAnalysis): FootMotif[] {
  const { contour, bounds } = analysis;
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const bellyLine = bellyLineOf(analysis);

  const found: { motif: FootMotif; depth: number }[] = [];
  for (const tip of contourProtrusions(contour, bellyLine, 0.015 * h, true)) {
    const depth = (tip.y - bellyLine) / h;
    if (depth < 0.035) continue;
    found.push({
      depth,
      motif: {
        angle: Math.atan2(tip.x - cx, tip.y - cy),
        reach: clamp(Math.hypot(tip.x - cx, tip.y - cy) / (h / 2), 0, 2),
      },
    });
  }
  // Keep the four deepest, presented left→right.
  found.sort((a, b) => b.depth - a.depth);
  const kept = found.slice(0, 4).map((f) => f.motif);
  kept.sort((a, b) => a.angle - b.angle);
  return kept;
}

/** Measure a drawing's motifs from its shape analysis. */
export function extractMotifs(analysis: ShapeAnalysis): Motifs {
  const { bounds, distance, features, headLobe, archetype } = analysis;
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const cx = (bounds.minX + bounds.maxX) / 2;

  const headThickness = Math.max(dtAt(analysis, headLobe.x, headLobe.y), 1);

  // Body aspect from the mask's row-coverage profile — NOT the full ink
  // bounds (ears/legs/wings are appendage motifs; letting them stretch the
  // aspect would turn a round body with tall ears into a tall creature), and
  // NOT the DT peak (a scribble-filled body has interior gaps that flatten
  // the distance field). Bulk width = the 0.9-quantile of ink pixels per
  // row (robust to the few wing rows); bulk height = rows carrying at least
  // 35% of that (appendage rows are thin and drop out).
  const { size: maskSize, data: maskData } = analysis.mask;
  const coverage: number[] = [];
  for (let y = Math.max(0, bounds.minY); y <= Math.min(maskSize - 1, bounds.maxY); y++) {
    let run = 0;
    for (let x = 0; x < maskSize; x++) run += maskData[y * maskSize + x]!;
    coverage.push(run);
  }
  const sorted = [...coverage].sort((a, b) => a - b);
  const bulkW = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
  const bulkH = coverage.filter((c) => c >= bulkW * 0.35).length;
  const aspect = bulkW > 0 && bulkH > 0 ? clamp(bulkH / bulkW, 0.4, 2.6) : h / w;

  // Noise floor before clustering (see clusterFeatures).
  const solid = features.filter(
    (f) => f.thickness >= 2.5 && f.thickness >= distance.max * 0.04,
  );
  const radius = 0.06 * (w + h);

  const limbClusters = clusterFeatures(solid.filter((f) => f.role === 'limb'), radius);
  const bySide = new Map<number, Feature>();
  for (const c of limbClusters) {
    const rep = pick(c, (a, b) => Math.abs(a.at.x - cx) > Math.abs(b.at.x - cx));
    const side = rep.at.x >= cx ? 1 : -1;
    const cur = bySide.get(side);
    if (!cur || rep.thickness > cur.thickness) bySide.set(side, rep);
  }
  const limbs: LimbMotif[] = [...bySide.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([side, rep]) => ({
      side: side as -1 | 1,
      height: clamp((bounds.maxY - rep.at.y) / h, 0, 1),
      reach: clamp(Math.abs(rep.at.x - cx) / (w / 2), 0, 1),
    }))
    // Arms/wings live at mid-body; leaves outside that band are stroke-end
    // noise (a scribble tail, a foot corner), not drawn limbs.
    .filter((m) => m.height >= 0.35 && m.height <= 0.85);

  return {
    archetype,
    aspect,
    torsoFullness: clamp(distance.max / (0.5 * Math.min(w, h)), 0, 1),
    headSize: clamp(headThickness / Math.max(distance.max, 1), 0, 1),
    feet: extractFeet(analysis),
    limbs,
    crown: extractCrown(analysis),
    lumpiness: contourLumpiness(analysis.contour),
  };
}

// ── body genesis (GENERATOR §1a — the drawing's own shape) ───────────────────

/** Widened proportion band: a tall drawn bottle or a wide drawn fish keeps
 * its identity; only the extremes are pulled back in (GENERATOR §1a). */
export const SPECIES_ASPECT_MIN = 0.6;
export const SPECIES_ASPECT_MAX = 2.0;
/** Species trait: added legs are tiny — never longer than this × body height. */
export const SPECIES_LEG_MAX = 0.35;
/** Near-vertical clamp on leg splay (radians) so the creature stands. */
export const SPECIES_LEG_SPLAY = 0.18;

/** Morphological closing radius (fraction of mask size): fuses stray/nearby
 * lines into one mass before filling. */
export const CLOSE_RADIUS = 0.035;
/** Chunk floor (fraction of mask size): the filled mask's DT peak must clear
 * this — a scribble or stick figure becomes a solid blob, never a wire. */
export const CHUNK_FLOOR = 0.07;
/** Corner detection: windowed turning angle above this pins the vertex. */
export const CORNER_ANGLE = (35 * Math.PI) / 180;
/** Corner detection window, as a fraction of the contour ring's point count. */
export const CORNER_WINDOW = 0.03;

/** Identity jitter spans — WITHIN-band variation only. The drawing keeps
 * deciding the shape; the salt moves the individual around inside the
 * species envelope. Spans are deliberately wide enough that two hatchlings
 * of one drawing differ at world scale, not under a loupe. */
export const IDENTITY_ASPECT_JITTER = 0.1;
export const IDENTITY_FULLNESS_JITTER = 0.08;
export const IDENTITY_STANCE_WIDTH_JITTER = 0.15;
export const IDENTITY_STANCE_JITTER = 0.08;
export const IDENTITY_LEG_JITTER = 0.25;
export const IDENTITY_LEG_WIDTH_JITTER = 0.2;

/** Discrete identity axes — read-at-a-glance classes. All resolve to the
 * neutral middle when unsalted. */
/** Upper-region width classes (small / medium / large "head" mass). */
export const IDENTITY_HEAD_CLASSES = [0.88, 1, 1.14] as const;
/** Mass-distribution taper: ±14% row-width shift top↔bottom per class. */
export const IDENTITY_TAPER_AMOUNT = 0.14;
/** Appendage attitude: leg splay/droop bias per class −1 | 0 | +1. */
export const IDENTITY_DROOP_AMOUNT = 0.18;

/** One added stubby leg, in body-relative units. */
export interface BodyLeg {
  /** Attach x offset from the body center, as a fraction of body width. */
  x: number;
  /** Radians off straight-down. |angle| ≤ SPECIES_LEG_SPLAY. */
  angle: number;
  /** Length as a fraction of body height. ≤ SPECIES_LEG_MAX. */
  length: number;
  /** Width as a fraction of body width. */
  width: number;
}

/** The numeric plan for processing a drawing into a body — split out from
 * the mask work so the banding rules (aspect band, tiny legs, near-vertical
 * splay, leg count) are directly testable numbers. */
export interface BodyPlan {
  /** Identity axis: multiplies the measured aspect before the band clamp. 1 unsalted. */
  aspectJitter: number;
  /** Identity axis: overall bulk scale inside the frame. 1 unsalted. */
  fullness: number;
  /** Identity axis: upper-region width class multiplier. 1 unsalted. */
  headScale: number;
  /** Identity axis: row-width taper, +top-heavy / −bottom-heavy. 0 unsalted. */
  taper: number;
  /** Identity axis: appendage attitude class × amount. 0 unsalted. */
  droop: number;
  /** Stubby legs to append. Always two (user ruling: all characters have
   * legs) — drawn feet stay part of the contour and the species legs stamp
   * beneath the mass regardless. */
  legs: BodyLeg[];
  /** Contour hand-wobble amplitude, as a fraction of mask size. */
  wobble: number;
  /** Wobble phases (radians) for the two sine octaves. */
  wobblePhase: [number, number];
}

/**
 * Resolve motifs + seed into the body plan. Every character gets the two
 * stubby species legs (user ruling: all characters have legs). A drawing
 * with its own foot protrusions keeps them — they are already part of the
 * contour — and the species legs still stamp beneath the grounded mass, so
 * even a drawing whose bottom bumps register as "feet" reads as standing.
 *
 * @param identitySeed optional identity salt (identitySeedOf). When present,
 *   a SEPARATE rng channel jitters the within-band numbers so two ids never
 *   share a body; when absent the output is byte-identical to the unsalted
 *   pipeline.
 */
export function bodyPlan(motifs: Motifs, seed: number, identitySeed?: number): BodyPlan {
  const rng = makeRng(seed);
  // Identity channel: its own rng so adding the salt never reshuffles the
  // base draws. Draws happen in one fixed order, so the same id always lands
  // the same individual.
  const idRng = identitySeed === undefined ? null : makeRng((identitySeed ^ 0x85ebca6b) >>> 0);
  const jitter = (span: number): number => (idRng ? 1 + (idRng() - 0.5) * 2 * span : 1);
  /** Discrete class draw: −1 | 0 | +1 (0 when unsalted). */
  const pickClass = (): number => (idRng ? Math.floor(idRng() * 3) - 1 : 0);

  const aspectJitter = jitter(IDENTITY_ASPECT_JITTER);
  const fullness = jitter(IDENTITY_FULLNESS_JITTER);
  const headScale = IDENTITY_HEAD_CLASSES[pickClass() + 1]!;
  const taper = pickClass() * IDENTITY_TAPER_AMOUNT;
  const droop = pickClass() * IDENTITY_DROOP_AMOUNT;
  const stanceWidth = jitter(IDENTITY_STANCE_WIDTH_JITTER);
  const legLenJitter = jitter(IDENTITY_LEG_JITTER);
  const legWidthJitter = jitter(IDENTITY_LEG_WIDTH_JITTER);

  // Base draws, fixed order regardless of salt (compat: no salt → the exact
  // unsalted body).
  const legLenBase = 0.16 + 0.05 * rng();
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;

  const legs: BodyLeg[] = [];
  // Every character stands on the two stubby species legs (user ruling: all
  // characters have legs). Drawn foot protrusions remain in the contour —
  // the stamped legs land beneath the grounded bottom band and merge with
  // them — so drawings with "feet" that never read as legs still stand.
  // Exactly two stubby, near-vertical, chunky legs (avatar spec). The
  // attitude class splays them a touch (droopy) or pulls them under
  // (perky); the stance jitters per identity, clamped so it stands.
  {
    const length = clamp(legLenBase * legLenJitter, 0.1, SPECIES_LEG_MAX);
    const width = clamp(0.14 * legWidthJitter, 0.1, 0.2);
    for (const side of [-1, 1] as const) {
      const stance = idRng ? (idRng() - 0.5) * 2 * IDENTITY_STANCE_JITTER : 0;
      legs.push({
        x: side * 0.22 * stanceWidth,
        angle: clamp(
          side * (0.04 + droop * 0.2) + stance,
          -SPECIES_LEG_SPLAY,
          SPECIES_LEG_SPLAY,
        ),
        length,
        width,
      });
    }
  }

  return {
    aspectJitter,
    fullness,
    headScale,
    taper,
    droop,
    legs,
    wobble: 0.0035 + 0.004 * clamp(motifs.lumpiness, 0, 1),
    wobblePhase: [
      phase1 + (idRng ? idRng() * Math.PI * 2 : 0),
      phase2 + (idRng ? idRng() * Math.PI * 2 : 0),
    ],
  };
}

/** Ink bounds of a mask (−1 maxX when empty). */
function maskBounds(mask: Mask): { minX: number; minY: number; maxX: number; maxY: number } {
  const { size, data } = mask;
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      if (data[row + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * FILL + CHUNKIFY (GENERATOR §1a robustness rules): rasterize the original
 * strokes, close (fuse stray/nearby lines), flood-fill enclosed regions so
 * outline drawings become solid mass, keep the largest component, then
 * enforce the minimum chunk thickness — if the DT peak sits under the chunk
 * floor, dilate until it clears it. Never a wire figure.
 */
function fillAndChunkify(strokes: StrokeList, size: number): Mask | null {
  const raw = rasterize(strokes, size);
  const closeR = Math.max(2, Math.round(CLOSE_RADIUS * size));
  // Fill between dilate and erode: the erosion of a solid mass stays solid,
  // so outline gaps up to ~2×closeR still seal before the fill.
  let mask = erode(fillHoles(dilate(raw, closeR)), closeR);
  mask = largestComponent(mask).mask;
  const bounds = maskBounds(mask);
  if (bounds.maxX < 0) return null;

  const floor = CHUNK_FLOOR * size;
  for (let i = 0; i < 3; i++) {
    const dt = distanceTransform(mask);
    // Thin-part guard: the max-DT floor alone is defeated by one fat lobe
    // (a stick figure's head clears it while the limbs stay wires). The
    // 25th-percentile DT over ink approximates the thin parts' half-width —
    // solid shapes score high (a disc's p25 is ~0.13R), wire figures low.
    const hist = new Uint32Array(size);
    let ink = 0;
    for (let p = 0; p < dt.data.length; p++) {
      const v = dt.data[p]!;
      if (v > 0) {
        hist[Math.min(size - 1, Math.floor(v))]!++;
        ink++;
      }
    }
    let p25 = 0;
    for (let acc = 0, b = 0; b < size; b++) {
      acc += hist[b]!;
      if (acc >= ink * 0.25) {
        p25 = b;
        break;
      }
    }
    const need = Math.max(floor - dt.max, floor * 0.5 - p25);
    if (need <= 0) break;
    mask = dilate(mask, Math.max(1, Math.ceil(need)));
  }
  // Dilation can seal a U into an O — re-fill so no interior holes survive.
  return fillHoles(mask);
}

/**
 * PROPORTION: scale the body into the widened species band and normalize it
 * into the frame (nearest-neighbor inverse warp — pure and deterministic).
 * The same warp carries the identity's mass-distribution axes: the taper
 * class biases row width top↔bottom, the head class scales the upper
 * region's width. Leaves margin below for the stubby legs.
 */
function proportionWarp(mask: Mask, plan: BodyPlan): Mask | null {
  const size = mask.size;
  const b = maskBounds(mask);
  if (b.maxX < 0) return null;
  const w0 = Math.max(1, b.maxX - b.minX + 1);
  const h0 = Math.max(1, b.maxY - b.minY + 1);
  const aspect0 = h0 / w0;
  const target = clamp(
    aspect0 * plan.aspectJitter,
    SPECIES_ASPECT_MIN,
    SPECIES_ASPECT_MAX,
  );

  // Target box: the body's longer dimension spans ~62% of the frame (the
  // inflate step renormalizes scale anyway; this keeps mask resolution high
  // and leaves leg + wobble margin on every side).
  const bulk = 0.62 * clamp(plan.fullness, 0.85, 1.12) * size;
  let bodyH = target >= 1 ? bulk : bulk * target;
  let bodyW = bodyH / target;
  const legPx = plan.legs.reduce((m, l) => Math.max(m, l.length), 0) * bodyH * 1.2;
  const maxH = 0.92 * size - legPx;
  if (bodyH > maxH) {
    const s = maxH / bodyH;
    bodyH *= s;
    bodyW *= s;
  }

  const cxT = size / 2;
  const top = (size - bodyH - legPx) / 2;
  const cx0 = (b.minX + b.maxX) / 2;

  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (y - top) / bodyH;
    if (v < 0 || v > 1) continue;
    // Row-width scale: taper (top-heavy vs bottom-heavy) × head class
    // (upper-region width), bounded so nothing reads as a different shape.
    const headW = clamp(1 - v / 0.35, 0, 1);
    const rs = clamp(
      (1 + plan.taper * (1 - 2 * v)) * (1 + (plan.headScale - 1) * headW),
      0.78,
      1.28,
    );
    const ys = b.minY + v * (h0 - 1);
    const sy = Math.round(ys);
    if (sy < 0 || sy >= size) continue;
    const row = y * size;
    const srcRow = sy * size;
    const invSx = w0 / (bodyW * rs);
    for (let x = 0; x < size; x++) {
      const xs = cx0 + (x - cxT) * invSx;
      const sx = Math.round(xs);
      if (sx < b.minX || sx > b.maxX) continue;
      if (mask.data[srcRow + sx] === 1) out[row + x] = 1;
    }
  }
  return { size, data: out };
}

/**
 * SPECIES ADDITIONS: grounding + stubby legs. Everything is measured
 * against the body's UNDERSIDE BASELINE — the median of the per-column
 * lowest-ink profile — not the mask's absolute bottom, so a drawing's own
 * legs (which hang below the baseline) are never swallowed:
 *
 * - Grounding flattens columns whose underside sits just above the baseline
 *   down TO the baseline (a stance, not a slab) so the creature stands
 *   rather than balances. Columns already deeper than the baseline are
 *   drawn legs/feet and stay untouched.
 * - Each species leg stamps at its stance column UNLESS that column already
 *   carries a drawn protrusion at least half a leg deep — the drawn leg IS
 *   the leg there. Either way every character ends up visibly legged (user
 *   ruling: all characters have legs).
 *
 * Legs are slightly wavy tapered capsules rooted inside the mass at the
 * baseline. A small closing afterwards fillets the junctions so nothing
 * reads as an engineered weld.
 */
function groundAndLegs(mask: Mask, plan: BodyPlan, rng: () => number): Mask {
  const size = mask.size;
  const b = maskBounds(mask);
  if (b.maxX < 0) return mask;
  const bodyW = b.maxX - b.minX + 1;
  const bodyH = b.maxY - b.minY + 1;
  const cx = (b.minX + b.maxX) / 2;
  const data = mask.data.slice();
  const out: Mask = { size, data };

  if (plan.legs.length > 0) {
    // Per-column underside profile (lowest ink y; -1 = empty column).
    const lowestAt = (x: number): number => {
      for (let y = b.maxY; y >= b.minY; y--) if (data[y * size + x] === 1) return y;
      return -1;
    };
    const profile: number[] = [];
    for (let x = b.minX; x <= b.maxX; x++) {
      const y = lowestAt(x);
      if (y >= 0) profile.push(y);
    }
    profile.sort((a, c) => a - c);
    // Median underside: drawn feet are the deep tail and don't drag it down.
    const baseline = profile[Math.floor(profile.length / 2)] ?? b.maxY;

    // Grounding: flatten near-baseline columns down to the baseline.
    const band = Math.max(1, Math.round(0.05 * bodyH));
    for (let x = b.minX; x <= b.maxX; x++) {
      const lowest = lowestAt(x);
      if (lowest >= baseline - band && lowest < baseline) {
        for (let y = lowest; y <= baseline; y++) data[y * size + x] = 1;
      }
    }

    for (const leg of plan.legs) {
      const lx = cx + leg.x * bodyW;
      let col = clamp(Math.round(lx), 0, size - 1);
      // Walk inward to the nearest inked column so a narrow-bottomed body
      // still gets its leg on the mass.
      const step = leg.x < 0 ? 1 : -1;
      while (lowestAt(col) < 0 && col > b.minX && col < b.maxX) col += step;
      const colLowest = lowestAt(col);
      if (colLowest < 0) continue;
      const len = leg.length * bodyH;
      // A drawn leg already hangs at this stance column — keep it as the
      // leg instead of welding a second one onto its tip.
      if (colLowest >= baseline + 0.5 * len) continue;
      // Root at the underside baseline, never on a protrusion tip.
      const attachY = Math.min(colLowest, baseline);
      const r0 = Math.max(2.5, (leg.width * bodyW) / 2);
      const dirX = Math.sin(leg.angle);
      const dirY = Math.cos(leg.angle);
      // Rooted inside the mass; three slightly wavy segments; gentle taper.
      let px = lx;
      let py = attachY - r0 * 1.5;
      const wob = r0 * 0.3;
      const total = len + r0 * 1.5;
      const K = 3;
      for (let s = 1; s <= K; s++) {
        const t = s / K;
        const sway = s < K ? (rng() - 0.5) * 2 * wob : 0;
        const nx = lx + dirX * total * t + sway;
        const ny = attachY - r0 * 1.5 + dirY * total * t;
        stampLine(out, px, py, nx, ny, r0 * (1 - 0.15 * ((s - 1) / K)), r0 * (1 - 0.15 * t));
        px = nx;
        py = ny;
      }
    }

    // Fillet the junctions (small closing) — the taste bans engineered
    // welds; radius stays well under the leg half-width so nothing vanishes.
    const filletR = Math.max(1, Math.round(0.012 * size));
    return largestComponent(fillHoles(erode(fillHoles(dilate(out, filletR)), filletR))).mask;
  }
  return out;
}

/**
 * SIMPLIFY, corner-preservingly (GENERATOR §1a silhouette variety): trace
 * the mask, detect corners by windowed turning angle, simplify with RDP but
 * PIN corner vertices, Chaikin-smooth ONLY the runs between pinned corners,
 * then lay the seeded hand-wobble (+ identity-salt phase) over the whole
 * ring. A drawn triangle keeps three shoulders; a circle stays smooth.
 */
function bodyContour(
  mask: Mask,
  plan: BodyPlan,
  contourPoints: number,
): Contour | null {
  const size = mask.size;
  const rawC = traceContour(mask);
  if (rawC.length < 8) return null;
  const eps = 1.8 * (size / 512);

  // Uniform ring for stable windowed turning angles.
  const ring = resample(rawC, 360);
  const win = Math.max(3, Math.round(ring.length * CORNER_WINDOW));
  const corners = detectCorners(ring, win, CORNER_ANGLE);

  let pts: Point[];
  if (corners.length >= 1) {
    // Perimeter shares per inter-corner run → point budget per run.
    const n = ring.length;
    const runs: { pts: Point[]; len: number }[] = [];
    let total = 0;
    for (let k = 0; k < corners.length; k++) {
      const a = corners[k]!;
      const b = corners[(k + 1) % corners.length]!;
      // Walk a → b the long way when a === b (single corner: the whole ring).
      const run: Point[] = [ring[a]!];
      for (let i = (a + 1) % n; ; i = (i + 1) % n) {
        run.push(ring[i]!);
        if (i === b) break;
      }
      let len = 0;
      for (let i = 0; i < run.length - 1; i++) {
        len += Math.hypot(run[i + 1]!.x - run[i]!.x, run[i + 1]!.y - run[i]!.y);
      }
      runs.push({ pts: run, len });
      total += len;
    }
    pts = [];
    for (const r of runs) {
      const budget = Math.max(3, Math.round((contourPoints * r.len) / Math.max(total, 1e-9)));
      const seg = resampleOpen(chaikinOpen(simplifyOpen(r.pts, eps), 2), budget);
      // Drop the last point — it is the next run's pinned first corner.
      for (let i = 0; i < seg.length - 1; i++) pts.push(seg[i]!);
    }
  } else {
    // No corners: the classic smooth chain (a circle stays a circle).
    pts = resample(chaikin(simplify(rawC, eps), 2), contourPoints);
  }
  if (pts.length < 8) return null;

  // Hand-wobble: two low-frequency octaves along the outward normal, seeded
  // (and phase-salted) — keeps the silhouette from reading as a tracing.
  const amp = Math.min(plan.wobble, 0.008) * size;
  const [p1, p2] = plan.wobblePhase;
  const m = pts.length;
  const out: Contour = new Array<Point>(m);
  for (let i = 0; i < m; i++) {
    const prev = pts[(i - 1 + m) % m]!;
    const next = pts[(i + 1) % m]!;
    let nx = next.y - prev.y;
    let ny = prev.x - next.x;
    const nl = Math.hypot(nx, ny);
    if (nl > 1e-9) {
      nx /= nl;
      ny /= nl;
    }
    const t = i / m;
    const o =
      amp *
      (0.65 * Math.sin(2 * Math.PI * 2 * t + p1) + 0.35 * Math.sin(2 * Math.PI * 5 * t + p2));
    const p = pts[i]!;
    out[i] = {
      x: clamp(p.x + nx * o, 0, size - 1),
      y: clamp(p.y + ny * o, 0, size - 1),
    };
  }
  return out;
}

/**
 * The full §1a body genesis: fill → chunkify → proportion → ground + legs →
 * corner-preserving contour → analysis. Pure and deterministic. Returns null
 * when any stage degenerates (callers fall back to the source analysis).
 */
export function buildBody(
  strokes: StrokeList,
  motifs: Motifs,
  seed: number,
  size: number,
  contourPoints: number,
  identitySeed?: number,
): ShapeAnalysis | null {
  const plan = bodyPlan(motifs, seed, identitySeed);
  const filled = fillAndChunkify(strokes, size);
  if (!filled) return null;
  const proportioned = proportionWarp(filled, plan);
  if (!proportioned) return null;
  // Separate stamp channel so plan evolution never reshuffles leg waviness.
  const legRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const body = groundAndLegs(proportioned, plan, legRng);
  const contour = bodyContour(body, plan, contourPoints);
  if (!contour) return null;
  return analyzeMask(body, { contour });
}

// ── the pass ─────────────────────────────────────────────────────────────────

export interface InterpretedDrawing {
  /** The ORIGINAL strokes, untouched — they serve the egg paint-on and the
   * marking channel. Only the analysis drives the body mesh. */
  strokes: StrokeList;
  /** Analysis of the PROCESSED BODY — eyes and inflation work on the actual
   * silhouette (the drawing's own shape, §1a). */
  analysis: ShapeAnalysis;
}

/**
 * Run the full interpretation: analyze the drawing, extract motifs, process
 * the drawing's own mask into the body (fill, chunkify, proportion, legs,
 * corner-preserving contour), and analyze THAT.
 *
 * @param fidelity 1 (default) = full §1a processing; 0 = verbatim
 *   passthrough (the dial's floor, dev-tunable). Intermediate values
 *   threshold at 0.5 — a true geometric blend is future work.
 * @param opts analyze options (tests use smaller mask sizes).
 * @param identitySeed optional identity salt (identitySeedOf): mixed (XOR)
 *   into the stroke seed so the same drawing under two ids processes into
 *   two distinct individuals of the SAME shape — leg counts and corners stay
 *   drawing-driven; only the within-band jitter takes the salt. Absent → the
 *   unsalted pipeline, byte-identical to before.
 * @returns null when the drawing carries no usable ink.
 */
export function interpretDrawing(
  strokes: StrokeList,
  fidelity = 1,
  opts: AnalyzeOptions = {},
  identitySeed?: number,
): InterpretedDrawing | null {
  const source = analyze(strokes, opts);
  if (!source) return null;
  if (fidelity < 0.5) return { strokes, analysis: source };

  const motifs = extractMotifs(source);
  const base = strokeSeed(strokes);
  const seed = identitySeed === undefined ? base : (base ^ identitySeed) >>> 0;
  const size = opts.size ?? 512;
  const body = buildBody(
    strokes,
    motifs,
    seed,
    size,
    opts.contourPoints ?? 120,
    identitySeed,
  );
  // A body that fails analysis would leave the creature with no silhouette
  // at all — fall back to the verbatim drawing (should not happen; the
  // processed mask is always one fat component).
  if (!body) return { strokes, analysis: source };
  return { strokes, analysis: body };
}
