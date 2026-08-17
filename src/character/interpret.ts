/**
 * The interpretation pass (GENERATOR §1 — "motifs, not replica").
 *
 * The user's drawing is no longer inflated verbatim: analyze() measures it,
 * this module extracts its motifs (proportions, foot/limb placement,
 * top-of-head appendages, contour lumpiness), and synthesizes a SPECIES BODY
 * — an irregular blob/egg torso with a merged head lobe, tiny legs, optional
 * lateral nubs and crown appendages — whose anatomy echoes those motifs. The
 * synthesized stroke list runs through the very same analyze → inflate
 * pipeline, so eyes, deformation, and locomotion all work on the actual body.
 *
 * Recognition channel 2 (the drawing painted onto the body) lives in
 * ./marking.ts; the verbatim path survives as fidelity 0 (the dial's floor).
 *
 * PURE module: no Three.js, no DOM, no Math.random, no Date. Same strokes →
 * same creature on every device (PLAN §6.3). All randomness is a seeded LCG
 * keyed off a hash of the input strokes, optionally salted by a stable
 * identity id (identitySeedOf) so no two submissions ever share a body.
 */

import { analyze, type AnalyzeOptions } from '../shape/analyze';
import type {
  Archetype,
  Contour,
  Feature,
  Point,
  ShapeAnalysis,
  Stroke,
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

// ── species synthesis ────────────────────────────────────────────────────────

/** Species band: every creature reads as the same loose species (GENERATOR §1). */
export const SPECIES_ASPECT_MIN = 0.9;
export const SPECIES_ASPECT_MAX = 1.6;
/** Species trait: legs are tiny — never longer than this × torso height. */
export const SPECIES_LEG_MAX = 0.35;
/** Near-vertical clamp on leg splay (radians) so the creature stands. */
export const SPECIES_LEG_SPLAY = 0.18;

/** The numeric body plan, in [0,1] canvas space (y-down). */
export interface SpeciesParams {
  torso: { cx: number; cy: number; width: number; height: number };
  head: { cx: number; cy: number; r: number };
  legs: { x: number; topY: number; angle: number; length: number; width: number }[];
  arms: { side: -1 | 1; y: number; length: number; width: number }[];
  crown: { angle: number; length: number; width: number }[];
  /** Low-frequency hand-wobble amplitude, canvas units. */
  wobble: number;
  /** Identity axis: body taper class × amount — +top-heavy / −bottom-heavy
   * shift between the torso's softening discs. 0 when unsalted. */
  taper: number;
  /** Identity axis: extra arm droop, radians (negative = perky). 0 when
   * unsalted. */
  droop: number;
}

/** Identity jitter spans — WITHIN-band variation only. The drawing's motifs
 * keep deciding counts (legs, crown, arms); the salt moves the individual
 * around inside the species envelope. Spans are deliberately wide: two
 * hatchlings of one drawing must differ at world scale, not under a loupe. */
export const IDENTITY_TORSO_JITTER = 0.18;
export const IDENTITY_LEG_JITTER = 0.25;
export const IDENTITY_LEG_WIDTH_JITTER = 0.2;
export const IDENTITY_CROWN_JITTER = 0.22;
/** Stance width: how far apart the leg slots sit, as a multiplier span. */
export const IDENTITY_STANCE_WIDTH_JITTER = 0.15;
/** Stance: radians of per-leg angle nudge, clamped back under the splay. */
export const IDENTITY_STANCE_JITTER = 0.08;

/** Discrete identity axes — read-at-a-glance classes that multiply perceived
 * variety far beyond continuous jitter. All resolve to the neutral middle
 * when unsalted. */
/** Head-lobe size classes: small / medium / large. */
export const IDENTITY_HEAD_CLASSES = [0.8, 1, 1.22] as const;
/** Body taper strength: ±16% shift between the torso's two softening discs
 * (top-heavy vs bottom-heavy), by the taper class −1 | 0 | +1. */
export const IDENTITY_TAPER_AMOUNT = 0.16;
/** Appendage attitude: extra arm droop (radians) per droop class −1 (perk)
 * | 0 | +1 (droop); crown angles spread/pull by ±20% on the same class. */
export const IDENTITY_DROOP_AMOUNT = 0.18;
export const IDENTITY_CROWN_SPREAD = 0.2;

/**
 * Resolve motifs + seed into the species body plan. Split out from stroke
 * emission so the banding rules (aspect clamp, tiny legs, near-vertical
 * splay, crown echo) are directly testable numbers.
 *
 * @param identitySeed optional identity salt (identitySeedOf). When present,
 *   a SEPARATE rng channel jitters the within-band numbers (torso fullness
 *   ±8%, leg length ±12%, crown reach ±10%, stance) so two ids never share a
 *   body; when absent the output is byte-identical to the unsalted pipeline.
 */
export function speciesParams(
  motifs: Motifs,
  seed: number,
  identitySeed?: number,
): SpeciesParams {
  const rng = makeRng(seed);
  // Identity channel: its own rng so adding the salt never reshuffles the
  // base draws (compat: no salt → the exact pre-salt body). Draws happen in
  // one fixed order (continuous jitters + discrete classes below), so the
  // same id always lands the same individual.
  const idRng = identitySeed === undefined ? null : makeRng((identitySeed ^ 0x85ebca6b) >>> 0);
  const jitter = (span: number): number => (idRng ? 1 + (idRng() - 0.5) * 2 * span : 1);
  /** Discrete class draw: −1 | 0 | +1 (0 when unsalted). */
  const pickClass = (): number => (idRng ? Math.floor(idRng() * 3) - 1 : 0);

  const torsoJitter = jitter(IDENTITY_TORSO_JITTER);
  const headClass = pickClass();
  const headClassMult = IDENTITY_HEAD_CLASSES[headClass + 1]!;
  const taper = pickClass() * IDENTITY_TAPER_AMOUNT;
  const droopClass = pickClass();
  const droop = droopClass * IDENTITY_DROOP_AMOUNT;
  const stanceWidth = jitter(IDENTITY_STANCE_WIDTH_JITTER);
  const legLenJitter = jitter(IDENTITY_LEG_JITTER);
  const legWidthJitter = jitter(IDENTITY_LEG_WIDTH_JITTER);

  // Torso: aspect and fullness echo the drawing, clamped into the species band.
  const aspect = clamp(motifs.aspect, SPECIES_ASPECT_MIN, SPECIES_ASPECT_MAX);
  const torsoH = 0.44;
  let torsoW =
    (torsoH / aspect) * (0.85 + 0.25 * clamp(motifs.torsoFullness, 0, 1)) * torsoJitter;
  torsoW = clamp(torsoW, torsoH / SPECIES_ASPECT_MAX, torsoH / SPECIES_ASPECT_MIN);

  // Head: merged upper lobe sized from the drawing's head thickness, scaled
  // by the identity's discrete size class (small / medium / large).
  const headR = (torsoW / 2) * (0.52 + 0.42 * clamp(motifs.headSize, 0.3, 1)) * headClassMult;

  // Legs: 2 or 4 per feet motifs/archetype; a legless blob drawing stays a
  // blob (it glides). The contour feet channel outranks the archetype: the
  // production-resolution skeleton routinely prunes thin drawn legs (or
  // hallucinates extras), while the contour counts them faithfully — the
  // archetype only decides when no foot protrusions were found at all.
  const feetCount = motifs.feet.length;
  const legCount =
    feetCount >= 4
      ? 4
      : feetCount >= 1
        ? 2
        : motifs.archetype === 'quadruped'
          ? 4
          : motifs.archetype === 'biped' || motifs.archetype === 'bird'
            ? 2
            : 0;
  // Tiny — the identity jitter is clamped back under SPECIES_LEG_MAX.
  const legLen = Math.min(
    torsoH * (0.26 + 0.06 * rng()) * legLenJitter,
    torsoH * SPECIES_LEG_MAX,
  );
  const legW = Math.max(0.034, torsoW * 0.11 * legWidthJitter);

  // Crown: the signature echo — same angular POSITIONS as the drawing (a
  // left ear stays a left ear), reach in a band. The identity salt scales
  // each reach, and the droop class spreads (droopy) or pulls upright
  // (perky) the whole set by ±20% — never flipping a side.
  const crown = motifs.crown.map((m) => {
    const r = clamp(m.reach * 2.2, 0, 1);
    return {
      angle: clamp(m.angle * (1 + droopClass * IDENTITY_CROWN_SPREAD), -1.15, 1.15),
      length: headR * (0.7 + 1.3 * r) * jitter(IDENTITY_CROWN_JITTER),
      width: Math.max(0.03, headR * (0.72 - 0.3 * r)),
    };
  });

  // Vertical layout: center the whole plan, scale down if it overflows.
  const crownMax = crown.reduce((m, c) => Math.max(m, c.length), 0);
  const above = headR * 1.45 + crownMax; // head + crown overhang past torso top
  const below = legCount > 0 ? legLen : 0;
  let total = torsoH + above + below;
  const fit = total > 0.88 ? 0.88 / total : 1;
  const s = (v: number): number => v * fit;
  total *= fit;

  const torso = {
    cx: 0.5,
    cy: (1 - total) / 2 + s(above) + s(torsoH) / 2,
    width: s(torsoW),
    height: s(torsoH),
  };
  const torsoTop = torso.cy - torso.height / 2;
  const torsoBottom = torso.cy + torso.height / 2;

  const head = {
    cx: 0.5 + (rng() - 0.5) * 0.02,
    // Overlapping merge, but proud enough of the torso to read as a head.
    cy: torsoTop - s(headR) * 0.45,
    r: s(headR),
  };

  // Leg slots, left→right, with angles echoing the drawn feet (clamped
  // near-vertical so it stands).
  const slots =
    legCount === 4
      ? [-0.36, -0.13, 0.13, 0.36]
      : legCount === 2
        ? [-0.24, 0.24]
        : [];
  const defaults =
    legCount === 4 ? [-0.14, -0.05, 0.05, 0.14] : legCount === 2 ? [-0.08, 0.08] : [];
  const drawn = motifs.feet.map((f) => f.angle).sort((a, b) => a - b);
  const legs = slots.map((off, i) => {
    const echo =
      drawn.length > 0
        ? drawn[Math.round((i * (drawn.length - 1)) / Math.max(1, slots.length - 1))]!
        : defaults[i]!;
    // Stance: the identity salt widens/narrows the slot spread and nudges
    // each leg's angle, clamped back under the splay so it still stands.
    const stance = idRng ? (idRng() - 0.5) * 2 * IDENTITY_STANCE_JITTER : 0;
    return {
      x: torso.cx + off * torso.width * stanceWidth,
      topY: torsoBottom - torso.width * 0.18,
      angle: clamp(echo + stance, -SPECIES_LEG_SPLAY, SPECIES_LEG_SPLAY),
      length: s(legLen),
      width: s(legW),
    };
  });

  // Arms/wings: tiny lateral nubs at the drawn heights.
  const arms = motifs.limbs.map((m) => ({
    side: m.side,
    y: torsoBottom - clamp(m.height, 0.35, 0.7) * torso.height,
    length: torso.width * (0.16 + 0.1 * clamp(m.reach, 0, 1)),
    width: Math.max(0.028, torso.width * 0.13),
  }));

  return {
    torso,
    head,
    legs,
    arms,
    crown: crown.map((c) => ({ ...c, length: s(c.length), width: s(c.width) })),
    wobble: 0.005 + 0.02 * clamp(motifs.lumpiness, 0, 1),
    taper,
    droop,
  };
}

/** A filled disc stroke (test/fixtures/strokes.ts style). */
function disc(cx: number, cy: number, r: number): Stroke {
  return { pts: [[clamp(cx, 0.02, 0.98), clamp(cy, 0.02, 0.98), 1]], w: r * 2 };
}

/**
 * A capsule from (x0,y0) toward (dx,dy)·length, perturbed by seeded
 * low-frequency waviness (amplitude pinned to zero at both ends) and tapered
 * slightly toward the tip — so no stroke ever reads as an engineered segment.
 */
function wavyStroke(
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  length: number,
  width: number,
  amp: number,
  taper: number,
  rng: () => number,
): Stroke {
  const cycles = 1 + rng();
  const phase = rng() * Math.PI * 2;
  const px = -dy;
  const py = dx;
  const pts: [number, number, number][] = [];
  const K = 8;
  for (let i = 0; i <= K; i++) {
    const t = i / K;
    const o = amp * Math.sin(t * Math.PI * cycles + phase) * Math.sin(t * Math.PI);
    pts.push([
      clamp(x0 + dx * length * t + px * o, 0.02, 0.98),
      clamp(y0 + dy * length * t + py * o, 0.02, 0.98),
      1 - taper * t,
    ]);
  }
  return { pts, w: width };
}

/**
 * Build the species creature as a stroke list. Deterministic: same motifs +
 * seed (+ identity salt) → identical strokes. The result feeds the ordinary
 * analyze → inflate pipeline.
 */
export function synthesizeSpecies(
  motifs: Motifs,
  seed: number,
  identitySeed?: number,
): StrokeList {
  const p = speciesParams(motifs, seed, identitySeed);
  // Separate channel so param evolution never reshuffles the wobble phases.
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const strokes: StrokeList = [];
  const { torso, head } = p;

  // Torso: a fat capsule/disc cluster — an irregular egg, never a primitive.
  // The capsule runs along the longer dimension (tall bodies stand a vertical
  // core, squat ones a horizontal one); jittered discs soften it into a blob.
  const tall = torso.height >= torso.width;
  const coreLen = Math.abs(torso.height - torso.width);
  const coreW = Math.min(torso.height, torso.width);
  const ax = tall ? 0 : 1;
  const ay = tall ? 1 : 0;
  strokes.push(
    wavyStroke(
      torso.cx - ax * coreLen * 0.5,
      torso.cy - ay * coreLen * 0.5,
      ax,
      ay,
      Math.max(coreLen, 1e-3),
      coreW,
      p.wobble * 0.6,
      0,
      rng,
    ),
  );
  // The softening discs carry the identity's taper axis: canvas y runs down,
  // so the +along disc sits at the BOTTOM of a tall body — top-heavy
  // (taper > 0) shrinks it and grows the top disc, bottom-heavy the reverse.
  // Zero taper (unsalted) keeps the exact pre-salt radii.
  const along = coreLen / 2 + coreW * 0.1;
  strokes.push(
    disc(
      torso.cx + ax * along * 0.7 + (rng() - 0.5) * coreW * 0.08,
      torso.cy + ay * along * 0.7 + (rng() - 0.5) * coreW * 0.08,
      coreW * 0.5 * (1 - p.taper),
    ),
  );
  strokes.push(
    disc(
      torso.cx - ax * along * 0.75 + (rng() - 0.5) * coreW * 0.1,
      torso.cy - ay * along * 0.75 + (rng() - 0.5) * coreW * 0.1,
      coreW * 0.44 * (1 + p.taper),
    ),
  );

  // Head: merged upper lobe, with a jittered companion so the merge is soft.
  strokes.push(disc(head.cx, head.cy, head.r));
  strokes.push(
    disc(head.cx + (rng() - 0.5) * head.r * 0.5, head.cy + head.r * 0.2, head.r * 0.8),
  );

  // Legs: tiny, near-vertical, echoing the drawn angles.
  for (const leg of p.legs) {
    strokes.push(
      wavyStroke(
        leg.x,
        leg.topY,
        Math.sin(leg.angle),
        Math.cos(leg.angle),
        leg.length + torso.width * 0.18, // embedded start → visible length ≈ leg.length
        leg.width,
        p.wobble * 0.8,
        0.12,
        rng,
      ),
    );
  }

  // Arms/wings: tiny lateral nubs at the drawn heights, drooping slightly —
  // plus the identity's attitude axis (perky lifts them, droopy sinks them).
  for (const arm of p.arms) {
    const droop = Math.max(0.02, 0.25 + rng() * 0.2 + p.droop);
    const dx = arm.side * Math.cos(droop);
    const dy = Math.sin(droop);
    strokes.push(
      wavyStroke(
        torso.cx + arm.side * torso.width * 0.34,
        arm.y,
        dx,
        dy,
        arm.length + torso.width * 0.16,
        arm.width,
        p.wobble * 0.7,
        0.15,
        rng,
      ),
    );
  }

  // Crown appendages: the drawn ears/antennae/horns echoed at their angles.
  for (const c of p.crown) {
    const dx = Math.sin(c.angle);
    const dy = -Math.cos(c.angle);
    strokes.push(
      wavyStroke(
        head.cx + dx * head.r * 0.55,
        head.cy + dy * head.r * 0.55,
        dx,
        dy,
        c.length + head.r * 0.2,
        c.width,
        p.wobble * (0.9 + 0.6 * clamp(motifs.lumpiness, 0, 1)),
        0.18,
        rng,
      ),
    );
  }

  return strokes;
}

// ── the pass ─────────────────────────────────────────────────────────────────

export interface InterpretedDrawing {
  /** The strokes the character body is built from (synthesized, or the
   * original at fidelity 0). */
  strokes: StrokeList;
  /** Analysis OF THOSE STROKES — eyes and inflation work on the actual body. */
  analysis: ShapeAnalysis;
}

/**
 * Run the full interpretation: analyze the drawing, extract motifs,
 * synthesize the species body, re-analyze it.
 *
 * @param fidelity 1 (default) = full species synthesis; 0 = verbatim
 *   passthrough (the dial's floor, dev-tunable). Intermediate values
 *   threshold at 0.5 — a true geometric blend between the drawing and the
 *   species body is future work.
 * @param opts analyze options (tests use smaller mask sizes).
 * @param identitySeed optional identity salt (identitySeedOf): mixed (XOR)
 *   into the stroke seed so the same drawing under two ids synthesizes two
 *   distinct individuals of the SAME species — motif counts and angles stay
 *   motif-driven; only the within-band jitter takes the salt. Absent → the
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
  const species = synthesizeSpecies(motifs, seed, identitySeed);
  const synthesized = analyze(species, opts);
  // A synthesized body that fails analysis would leave the creature with no
  // silhouette at all — fall back to the verbatim drawing (should not happen;
  // the species plan always rasterizes to one fat component).
  if (!synthesized) return { strokes, analysis: source };
  return { strokes: species, analysis: synthesized };
}
