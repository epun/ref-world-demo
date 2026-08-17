/**
 * src/inflate/ is pure: data in, data out. No Three.js, no DOM, no
 * Math.random, no Date. It emits plain typed arrays; a separate module wraps
 * them into a THREE.BufferGeometry. Same input → byte-identical output on
 * every device (PLAN §6.3), which is why nothing here touches a renderer.
 */

/** A closed, welded triangle mesh produced by inflating a silhouette. */
export interface InflatedMesh {
  /** xyz triples. x right, y up, z toward the viewer for the front side. */
  positions: Float32Array;
  /** xyz triples, smooth (area-weighted face normals, normalized). */
  normals: Float32Array;
  /** Triangle indices into positions/normals, consistently outward-wound. */
  indices: Uint32Array;
}

export interface InflateOptions {
  /**
   * Peak inflation depth relative to the distance-field maximum: the front
   * surface tops out at ≈ depthScale * dtMax (in mask pixels, before the
   * 1/maskSize normalization). Default 0.9.
   */
  depthScale?: number;
  /**
   * Interior sampling step in mask pixels — triangulation edges are refined
   * until none is longer than this. Default 6.
   */
  gridStep?: number;
}
