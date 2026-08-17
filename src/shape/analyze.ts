/**
 * The full pipeline: stroke list → ShapeAnalysis.
 * Pure and deterministic end to end (PLAN §3.2).
 */

import type {
  Archetype,
  Contour,
  Feature,
  Mask,
  ShapeAnalysis,
  SkeletonLeaf,
  StrokeList,
} from './types';
import { rasterize, largestComponent } from './raster';
import { distanceTransform } from './distance';
import { traceContour, simplify, resample, chaikin } from './contour';
import { extractRidges, findLeaves, findHeadLobe } from './skeleton';

function inkBounds(mask: Mask): { minX: number; minY: number; maxX: number; maxY: number } {
  const { size, data } = mask;
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x] === 1) {
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
 * Classify skeleton leaves into features by where they sit in the bbox
 * (PLAN §3.2 step 6):
 *   top 35%            → head-ish (ears/antennae fold into 'head')
 *   bottom 30%         → feet
 *   lateral mid-height → limbs (arms/wings)
 */
function classifyLeaves(
  leaves: SkeletonLeaf[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): Feature[] {
  const h = bounds.maxY - bounds.minY;
  const w = bounds.maxX - bounds.minX;
  if (h <= 0 || w <= 0) return [];
  const features: Feature[] = [];
  for (const leaf of leaves) {
    const fy = (leaf.at.y - bounds.minY) / h;
    const fx = (leaf.at.x - bounds.minX) / w;
    if (fy <= 0.35) {
      features.push({ role: 'head', at: leaf.at, thickness: leaf.thickness });
    } else if (fy >= 0.7) {
      features.push({ role: 'foot', at: leaf.at, thickness: leaf.thickness });
    } else if (fx <= 0.25 || fx >= 0.75) {
      features.push({ role: 'limb', at: leaf.at, thickness: leaf.thickness });
    }
    // Interior mid-leaves carry no role; they're body mass.
  }
  return features;
}

/** Archetype from foot count, laterals, and aspect (PLAN §3.2 step 7). */
function classifyArchetype(
  features: Feature[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): Archetype {
  const feet = features.filter((f) => f.role === 'foot').length;
  const limbs = features.filter((f) => f.role === 'limb').length;
  const aspect = (bounds.maxY - bounds.minY) / Math.max(1, bounds.maxX - bounds.minX);
  if (feet >= 4) return 'quadruped';
  if (feet >= 2 && limbs >= 1 && aspect > 1.05) return 'bird';
  if (feet >= 2) return 'biped';
  return 'blob';
}

export interface AnalyzeOptions {
  /** Mask resolution. 512 is the production value; tests may go smaller. */
  size?: number;
  /** RDP tolerance in pixels, scaled to size/512. */
  epsilon?: number;
  /** Final contour density. */
  contourPoints?: number;
}

export interface MaskAnalyzeOptions {
  /** RDP tolerance in pixels, scaled to size/512. Ignored when `contour` is given. */
  epsilon?: number;
  /** Final contour density. Ignored when `contour` is given. */
  contourPoints?: number;
  /**
   * Pre-built contour in mask pixel space (e.g. the §1a corner-preserving
   * chain). When absent, the default trace → RDP → Chaikin → resample chain
   * runs on the mask.
   */
  contour?: Contour;
}

/**
 * Run the pipeline's tail on an already-built mask: bounds, distance
 * transform, contour (default chain or a caller-supplied one), skeleton
 * features, archetype, head lobe. Returns null for empty or degenerate ink.
 * The mask must be a single connected component (largestComponent first).
 */
export function analyzeMask(mask: Mask, opts: MaskAnalyzeOptions = {}): ShapeAnalysis | null {
  const size = mask.size;
  const bounds = inkBounds(mask);
  if (bounds.maxX < 0) return null;
  // Reject degenerate ink (a dot or a hairline): nothing to inflate.
  if (bounds.maxX - bounds.minX < size * 0.02 && bounds.maxY - bounds.minY < size * 0.02) {
    return null;
  }

  const distance = distanceTransform(mask);

  let contour = opts.contour;
  if (!contour) {
    const rawContour = traceContour(mask);
    if (rawContour.length < 8) return null;
    const eps = (opts.epsilon ?? 1.5) * (size / 512);
    const soft = chaikin(simplify(rawContour, eps), 2);
    contour = resample(soft, opts.contourPoints ?? 120);
  } else if (contour.length < 8) {
    return null;
  }

  const skel = extractRidges(distance, mask);
  const leaves = findLeaves(skel, distance, Math.max(4, size / 85));
  const features = classifyLeaves(leaves, bounds);
  const archetype = classifyArchetype(features, bounds);
  const headLobe = findHeadLobe(distance, bounds);

  return { mask, distance, contour, features, archetype, headLobe, bounds };
}

/**
 * Run the whole pipeline. Returns null when the drawing carries no usable ink
 * (empty stroke list, or everything eliminated as stray dots).
 */
export function analyze(strokes: StrokeList, opts: AnalyzeOptions = {}): ShapeAnalysis | null {
  const size = opts.size ?? 512;
  const raw = rasterize(strokes, size);
  const { mask } = largestComponent(raw);
  const maskOpts: MaskAnalyzeOptions = {};
  if (opts.epsilon !== undefined) maskOpts.epsilon = opts.epsilon;
  if (opts.contourPoints !== undefined) maskOpts.contourPoints = opts.contourPoints;
  return analyzeMask(mask, maskOpts);
}
