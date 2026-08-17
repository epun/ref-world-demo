/**
 * src/shape/ is pure: data in, data out. No Three.js, no DOM, no Math.random,
 * no Date. Determinism here is load-bearing — the phone and the world both run
 * this pipeline on the same stroke list and must get identical results
 * (PLAN §6.3).
 */

/** One captured stroke: points plus a base width. */
export interface Stroke {
  /** [x, y, widthScale] triples. x/y in [0,1] canvas space; widthScale from velocity. */
  pts: [number, number, number][];
  /** Base stroke width in canvas-space units (fraction of canvas size). */
  w: number;
}

export type StrokeList = Stroke[];

/** Binary raster mask. */
export interface Mask {
  size: number;
  /** size*size, 0 | 1 */
  data: Uint8Array;
}

/** Euclidean distance transform of a mask. */
export interface DistanceField {
  size: number;
  /** size*size, distance in pixels to the nearest background pixel. */
  data: Float32Array;
  /** Maximum value in data (interior "thickness" peak). */
  max: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Closed contour, wound counterclockwise, in mask pixel space. */
export type Contour = Point[];

/** A skeleton leaf — an extremity of the medial axis. */
export interface SkeletonLeaf {
  at: Point;
  /** Distance-field value at the leaf: local half-thickness. */
  thickness: number;
  /** Path length from the leaf to its junction, in pixels. */
  reach: number;
}

export type Archetype = 'blob' | 'biped' | 'quadruped' | 'bird';

export type FeatureRole = 'head' | 'foot' | 'limb';

export interface Feature {
  role: FeatureRole;
  at: Point;
  thickness: number;
}

/** Everything downstream needs to build and drive a character. */
export interface ShapeAnalysis {
  mask: Mask;
  distance: DistanceField;
  /** Smoothed outer contour (post RDP + resample + Chaikin). */
  contour: Contour;
  features: Feature[];
  archetype: Archetype;
  /** Eye anchor: largest DT maximum in the upper region of the shape. */
  headLobe: Point;
  /** Bounding box of the ink in mask space. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
