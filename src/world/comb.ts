/**
 * The comb — a painted LEAN DIRECTION the grass reads, and the transient
 * PRESS a creature leaves under it. PURE (no Three.js, no DOM, no clock, no
 * Math.random), like every other world module a placement roll reads.
 *
 * WHY (2026-09-10, user ask: *"the brushes should have real world physics as
 * well just in the style of ref world"*). EnvPaint's comb tool writes the
 * stroke's own direction into a two-channel layer and its grass leans into
 * it; the same idea here, one step earlier in the pipeline. Meridian's grass
 * is not a GPU blade field — it is INSTANCED INK MARKS placed by
 * `src/world/scatter.ts` — so the lean cannot be a fragment of a vertex
 * shader reading a texture. It is applied AT PLACEMENT, to the instance
 * matrix: the mark's yaw turns to the combed heading and the whole tuft tips
 * over by the vector's magnitude. Deterministic in the layer, so the same
 * painted comb leans the same tufts on every device.
 *
 * THE ENCODING is EnvPaint's own (`PaintLayer.stamp`, mode `direction`):
 * channel 0 is `dir.x * 0.5 + 0.5`, channel 1 is `dir.z * 0.5 + 0.5`, so the
 * neutral — "no comb here" — is 0.5 in both, which is what the live layer is
 * filled with at construction.
 *
 * EXCEPT for one texel value that is NOT neutral in that scheme and has to
 * be: exactly (0, 0). A map serialised before the comb existed deserialises
 * with a zeroed array (src/world/painted.ts allocates zeroed), and so does
 * every buffer nobody has ever painted into. Decoded literally, (0, 0) is
 * the vector (-1, -1) — every blade in an unpainted world would lie flat to
 * the north-west. So exactly (0, 0) reads as UNSET, and only as unset: a
 * genuinely combed texel is (0.5 ± something, 0.5 ± something) and can only
 * land on both zeros by asking for a lean nobody can paint.
 *
 * WHERE THE PRESS WOULD PLUG IN. The companion idea — a transient one-channel
 * layer written under each creature every frame and decaying back to 0 over
 * `MOTION.ambientMs`, read here as a FLATTEN factor beside the lean — is
 * deliberately not built yet (2026-09-10, scope call). It lands as a second
 * sampler on the same seam (`setPaintedLean` in src/world/landscape.ts
 * already hands a per-point object to scatter's mark loop, so it gains a
 * `press` field rather than a second hook), and the mark loop squashes y and
 * splays xz by it. Nothing else moves.
 */

/** The neutral value in both channels of a direction layer — EnvPaint's own
 * (`dir * 0.5 + 0.5` with `dir = 0`). A layer is filled with this at
 * construction, and erasing a comb sets a texel back to it. */
export const COMB_NEUTRAL = 0.5;

/** Channels in the comb layer: x then z, in that order. */
export const COMB_CHANNELS = 2;

/**
 * [D] Hardest a combed tuft may lie over, radians (~26°).
 *
 * Capped, and low, because a grass mark is a handful of ink strokes 0.5 u
 * tall: past this it stops reading as a blade of grass leaning and starts
 * reading as a mark lying on the paper at a funny angle. The taste's grass
 * is drawn texture, and drawn texture that folds flat disappears.
 */
export const COMB_LEAN_MAX = 0.46;

/**
 * [D] Magnitude below which a texel is not combed at all. A lean this small
 * is invisible and the yaw it implies is noise, so the mark keeps its own
 * rolled rotation rather than being turned by nothing.
 */
export const COMB_MIN = 0.05;

/** A decoded comb vector in WORLD xz. (0, 0) is an uncombed point. */
export interface CombVector {
  x: number;
  z: number;
}

/**
 * One texel pair, decoded. Exactly (0, 0) — an unpainted or legacy buffer —
 * reads as no comb rather than as the vector (-1, -1); see the header.
 */
export function decodeComb(c0: number, c1: number): CombVector {
  if (c0 === 0 && c1 === 0) return { x: 0, z: 0 };
  return { x: c0 * 2 - 1, z: c1 * 2 - 1 };
}

/**
 * The comb vector at (x, z), bilinear between texel centres and exactly
 * (0, 0) outside the layer.
 *
 * The interpolation runs over the DECODED vectors, not over the raw channels:
 * blending a combed texel with an unset one has to fade the lean toward
 * nothing at the edge of a stroke, and blending the raw 0.5-centred value
 * against a raw 0 would drag it toward (-1, -1) instead — the exact
 * discontinuity the unset rule exists to remove.
 *
 * Same texel-centre recipe (and the same zero-outside rule) as
 * `samplePlanting`, for the same reason: a stroke that runs to the rim fades
 * out instead of smearing a straight edge across the field (TASTE §2.5).
 */
export function sampleComb(
  data: Float32Array | null | undefined,
  res: number,
  size: number,
  x: number,
  z: number,
): CombVector {
  if (!data) return { x: 0, z: 0 };
  const u = x / size + 0.5;
  const v = z / size + 0.5;
  if (u < 0 || u > 1 || v < 0 || v > 1) return { x: 0, z: 0 };
  const fx = u * res - 0.5;
  const fy = v * res - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (tex: number, tey: number): CombVector => {
    if (tex < 0 || tex >= res || tey < 0 || tey >= res) return { x: 0, z: 0 };
    const i = (tey * res + tex) * COMB_CHANNELS;
    return decodeComb(data[i] ?? 0, data[i + 1] ?? 0);
  };
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  const topX = a.x + (b.x - a.x) * tx;
  const topZ = a.z + (b.z - a.z) * tx;
  const botX = c.x + (d.x - c.x) * tx;
  const botZ = c.z + (d.z - c.z) * tx;
  return { x: topX + (botX - topX) * ty, z: topZ + (botZ - topZ) * ty };
}

/** The lean one mark takes from a comb vector, or null where nothing is
 * combed and the mark keeps the rotation its own roll gave it. */
export interface CombLean {
  /** Heading the mark turns to, radians about +y. */
  yaw: number;
  /** How far it tips over, radians — capped at `COMB_LEAN_MAX`. */
  lean: number;
  /** The horizontal axis it tips ABOUT, so that +y falls toward the comb
   * direction. Unit length. */
  axisX: number;
  axisZ: number;
}

/**
 * A comb vector as a lean, or null for an uncombed point.
 *
 * The axis is the one that carries +y onto the comb direction: rotating
 * about `a` by θ takes y to `y·cosθ + (a × y)·sinθ`, and for `a = (dz, 0,
 * -dx)` that cross product is exactly `(dx, 0, dz)`. Spelled out rather than
 * derived at the call site, because getting it wrong tips every tuft in the
 * world ninety degrees off the stroke and still looks plausible in a
 * screenshot.
 */
export function combLean(dir: CombVector): CombLean | null {
  const mag = Math.hypot(dir.x, dir.z);
  if (!(mag > COMB_MIN)) return null;
  const nx = dir.x / mag;
  const nz = dir.z / mag;
  return {
    yaw: Math.atan2(nx, nz),
    lean: Math.min(1, mag) * COMB_LEAN_MAX,
    axisX: nz,
    axisZ: -nx,
  };
}
