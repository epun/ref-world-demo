/**
 * The egg (PLAN §4): an organic ellipsoid resting on the ground, painted
 * with the user's drawing, rocking continuously until it hatches.
 *
 * - Shell geometry is a y-stretched sphere with a slight asymmetric radial
 *   nudge from deterministic noise, so it never reads as a perfect primitive
 *   (no engineered forms — shared law, TASTE §3).
 * - The shell texture is a CanvasTexture rendered from the stroke list with
 *   renderStrokesPartial: the mark centered on the front face plus a smaller
 *   rotated repeat band around the sides, so it reads as a *painted* egg
 *   rather than a decal. On spawn the reveal progress replays the strokes
 *   over t.primary — the egg visibly paints itself.
 * - The shell ground is SURFACE.canvas (the palette's light role): the egg
 *   is the one lit object in the mid-toned field. Ink is CHARACTER.body via
 *   renderStrokesPartial. The material's base color stays default white so
 *   the map's light value renders exactly at token value (a WORLD.light base
 *   would multiply against the map and drag the shell toward a midtone).
 * - Wobble is continuous rocking that never stops: two incommensurate sines
 *   per axis, seeded per egg, base period t.ambient, pivoting at the ground
 *   contact. Amplitude and frequency ramp smoothly with hatch progress —
 *   the world telegraphs what's coming, without a single step or snap.
 * - Entrance: the egg slides down from slightly above the ground on a ζ≥1
 *   spring over t.primary. No pop, no scale-in.
 */

import {
  CanvasTexture,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { renderStrokesPartial } from '../draw/render';
import { sampleDrift } from '../motion/ambient';
import { Spring } from '../motion/spring';
import type { StrokeList } from '../shape/types';
import { MOTION, SURFACE } from '../taste/tokens';
import { applyCrackShader } from './crack';

/** Egg height in world units, resting on the ground. */
export const EGG_HEIGHT = 2.6;
/** Vertical stretch of the base sphere. */
const SCALE_Y = 1.35;
/** Horizontal radius of the shell. */
export const EGG_RADIUS = EGG_HEIGHT / (2 * SCALE_Y);

/** Radial nudge amplitude as a fraction of radius — organic, not lumpy. */
const NUDGE_AMP = 0.032;

/** Entrance drop height: slides down from slightly above the ground. */
const ENTRANCE_DROP = 1.5;

/** Base wobble amplitude (radians) — slow and measured at rest. */
const WOBBLE_AMP = 0.045;
/** Incommensurate ratio between the two wobble sines. */
const WOBBLE_RATIO = Math.SQRT2;

/**
 * Rotate the shell so texture u=0.5 (where the front mark is painted) faces
 * the isometric camera at azimuth 45°: SphereGeometry puts u=0.5 on +x, and
 * a -45° yaw carries +x onto the camera diagonal (+x,+z).
 */
const FACE_CAMERA_Y = -Math.PI / 4;

const TEX_SIZE = 1024;
const STAMP_SIZE = 512;

/** A partial-shell range, used by the hatch to split the egg into pieces. */
export interface ShellSlice {
  phiStart: number;
  phiLength: number;
  thetaStart: number;
  thetaLength: number;
}

export interface EggOptions {
  /** World-space rest position of the egg's ground contact. */
  x?: number;
  z?: number;
  /** Override the stroke-derived deterministic seed (dev only). */
  seed?: number;
  /**
   * Play the entrance slide (default true).
   *
   * The world wants it: an egg arriving in a wide frame should slide down
   * and settle (TASTE §2.1 — entrances slide). A PORTRAIT does not. The
   * phone frames its camera to the egg's settled bounds, so an egg that
   * starts ENTRANCE_DROP above the ground begins outside the frustum and
   * reads as cut off at the top edge.
   *
   * With this false the egg is at rest from its first frame and the
   * entrance belongs to whatever is presenting it — on the phone that is
   * the stage's own core cross-fade (docs/PHONE-STAGE.md §3), which is
   * already an entrance and already on the settle curve. The ambient drift
   * floor still runs; nothing is frozen.
   */
  entrance?: boolean;
}

export interface Egg {
  /** Add to the scene; position/rotation are owned by update(). */
  group: Group;
  /** Deterministic per-egg seed (shell noise, crack pattern, wobble). */
  seed: number;
  /** The shell texture — shared with hatch pieces; disposed by dispose(). */
  texture: CanvasTexture;
  /** Horizontal footprint radius, for the flat shadow stamp. */
  radius: number;
  /** Advance entrance, paint-on reveal, wobble, and ambient drift. */
  update(dt: number, nowMs: number): void;
  /** 0→1 as the hatch timer approaches; ramps wobble smoothly. */
  setHatchProgress(p: number): void;
  hatchProgress(): number;
  /** Scrub the crack shader, 0→1. */
  crack(p: number): void;
  crackValue(): number;
  /** World-space point the character should rise from. */
  hatchPoint(): Vector3;
  /** Release GPU resources (geometry, material, texture). Idempotent. */
  dispose(): void;
}

/** Deterministic seed from the stroke data — same drawing, same egg. */
function eggSeed(strokes: StrokeList): number {
  let h = 2166136261;
  for (const stroke of strokes) {
    h = Math.imul(h ^ stroke.pts.length, 16777619);
  }
  const first = strokes[0]?.pts[0];
  if (first) {
    h = Math.imul(h ^ (Math.floor(first[0] * 8191) + (Math.floor(first[1] * 8191) << 13)), 16777619);
  }
  return h >>> 0;
}

/** Same LCG as the crack module — deterministic per seed. */
function makeRng(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Smooth deterministic scalar field over the unit sphere — a few
 * low-frequency lobes with mixed phases, so the nudged shell reads as
 * hand-formed, never as a scaled primitive. Depends only on raw sphere
 * position + seed, so partial slices land on the same surface as the
 * full shell.
 */
function shellNoise(x: number, y: number, z: number, seed: number): number {
  const s = (seed % 977) * 0.013;
  return (
    Math.sin(x * 3.1 + y * 2.3 + s) * 0.5 +
    Math.sin(y * 2.7 + z * 3.7 + s * 1.7 + 1.3) * 0.3 +
    Math.sin(z * 2.9 + x * 4.1 + s * 2.3 + 2.6) * 0.2
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * SphereGeometry remaps u to 0..1 across a partial phi range, which would
 * tear the shell texture at hatch time. Recompute uvs from the raw sphere
 * positions so every slice samples the same texture space as the full
 * shell. Must run before the y-stretch and noise nudge.
 */
function remapSliceUvs(geometry: BufferGeometry, uCenter: number): void {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const sinTheta = Math.hypot(x, z);
    let u: number;
    if (sinTheta < 1e-5 * EGG_RADIUS) {
      // Pole vertex: u is degenerate; pin it to the slice center.
      u = uCenter;
    } else {
      // Inverse of SphereGeometry's mapping: x = -r cosφ sinθ, z = r sinφ sinθ.
      const phi = Math.atan2(z, -x);
      u = (phi / (Math.PI * 2) + 1) % 1;
      // Unwrap toward the slice center so boundary verts don't jump the seam.
      if (u - uCenter > 0.5) u -= 1;
      if (uCenter - u > 0.5) u += 1;
    }
    const v = 1 - Math.acos(Math.min(1, Math.max(-1, y / EGG_RADIUS))) / Math.PI;
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}

/**
 * Build the shell geometry — the full egg, or a slice of it for the hatch
 * pieces. Deterministic per seed: slices coincide with the shell surface,
 * so the swap at hatch time never pops.
 */
export function buildShellGeometry(seed: number, slice?: ShellSlice): BufferGeometry {
  const phiStart = slice?.phiStart ?? 0;
  const phiLength = slice?.phiLength ?? Math.PI * 2;
  const thetaStart = slice?.thetaStart ?? 0;
  const thetaLength = slice?.thetaLength ?? Math.PI;
  // Segment counts proportional to the slice so sampling density matches
  // the full shell.
  const widthSegments = Math.max(12, Math.round((48 * phiLength) / (Math.PI * 2)));
  const heightSegments = Math.max(8, Math.round((36 * thetaLength) / Math.PI));
  const geometry = new SphereGeometry(
    EGG_RADIUS,
    widthSegments,
    heightSegments,
    phiStart,
    phiLength,
    thetaStart,
    thetaLength,
  );
  if (slice) {
    remapSliceUvs(geometry, ((phiStart + phiLength / 2) / (Math.PI * 2)) % 1);
  }

  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // Radial nudge in sphere space, then the y-stretch.
    const s = 1 + NUDGE_AMP * shellNoise(x / EGG_RADIUS, y / EGG_RADIUS, z / EGG_RADIUS, seed);
    position.setXYZ(i, x * s, y * s * SCALE_Y, z * s);
    // Normals for the y-scale (inverse transpose); the low-amplitude nudge
    // rides on the smooth sphere normals, keeping the surface seamless.
    const nx = normal.getX(i);
    const ny = normal.getY(i) / SCALE_Y;
    const nz = normal.getZ(i);
    const len = Math.hypot(nx, ny, nz) || 1;
    normal.setXYZ(i, nx / len, ny / len, nz / len);
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
  // Rest on the ground: bottom of the ellipsoid lands at y = 0.
  geometry.translate(0, EGG_HEIGHT / 2, 0);
  return geometry;
}

/** One stamped copy of the drawing on the shell texture, canvas fractions. */
interface Placement {
  cx: number;
  cy: number;
  size: number;
  rot: number;
}

/**
 * The painted layout: the mark front and center, plus a smaller rotated
 * repeat band around the sides — painted, not a sticker (PLAN §4).
 * Deterministic per seed. Placements stay clear of the uv seam at u=0/1.
 */
function buildPlacements(rng: () => number): Placement[] {
  const placements: Placement[] = [
    { cx: 0.5, cy: 0.48, size: 0.46, rot: (rng() - 0.5) * 0.12 },
  ];
  const bandU = [0.16, 0.32, 0.68, 0.84];
  for (let i = 0; i < bandU.length; i++) {
    const u = bandU[i];
    if (u === undefined) continue;
    placements.push({
      cx: u + (rng() - 0.5) * 0.04,
      cy: (i % 2 === 0 ? 0.4 : 0.58) + (rng() - 0.5) * 0.05,
      size: 0.16 + rng() * 0.04,
      rot: (rng() < 0.5 ? -1 : 1) * (0.35 + rng() * 0.5),
    });
  }
  return placements;
}

export function createEgg(strokes: StrokeList, options: EggOptions = {}): Egg {
  const seed = options.seed ?? eggSeed(strokes);
  const rng = makeRng(seed);
  const baseX = options.x ?? 0;
  const baseZ = options.z ?? 0;

  // ── shell texture ─────────────────────────────────────────────────────────
  const stamp = document.createElement('canvas');
  stamp.width = STAMP_SIZE;
  stamp.height = STAMP_SIZE;
  const stampCtx = stamp.getContext('2d');
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d');

  const placements = buildPlacements(rng);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const paint = (t: number): void => {
    if (!ctx || !stampCtx) return;
    renderStrokesPartial(stampCtx, strokes, STAMP_SIZE, t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = SURFACE.canvas;
    ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
    // 'darken' keeps ink wherever stamps overlap: the stamp's light ground
    // is the same value as the shell ground, so only the mark lands.
    ctx.globalCompositeOperation = 'darken';
    for (const p of placements) {
      ctx.setTransform(1, 0, 0, 1, p.cx * TEX_SIZE, p.cy * TEX_SIZE);
      ctx.rotate(p.rot);
      const s = p.size * TEX_SIZE;
      ctx.drawImage(stamp, -s / 2, -s / 2, s, s);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    texture.needsUpdate = true;
  };
  paint(0); // pristine light shell until the reveal starts

  // ── shell mesh ────────────────────────────────────────────────────────────
  const geometry = buildShellGeometry(seed);
  const material = new MeshPhysicalMaterial({
    map: texture,
    roughness: 0.4,
    metalness: 0,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
  });
  const crackHandle = applyCrackShader(material, seed);

  const mesh = new Mesh(geometry, material);
  const group = new Group();
  group.add(mesh);
  const wantsEntrance = options.entrance !== false;
  group.position.set(baseX, wantsEntrance ? ENTRANCE_DROP : 0, baseZ);
  group.rotation.y = FACE_CAMERA_Y;

  // ── motion state ──────────────────────────────────────────────────────────
  // Entrance: slide down from slightly above the ground (TASTE §2.1 —
  // entrances slide; the ζ≥1 spring settles without ever crossing).
  const dropSpring = new Spring(wantsEntrance ? ENTRANCE_DROP : 0, {
    settleMs: MOTION.primaryMs,
  });
  dropSpring.retarget(0);
  // Paint-on reveal, driven through a spring so the replay eases in and
  // drifts to completion over t.primary — nothing linear.
  const revealSpring = new Spring(0, { settleMs: MOTION.primaryMs });
  revealSpring.retarget(1);
  let revealPainted = 0;

  // Wobble: phase accumulators so the frequency can ramp with hatch
  // progress without a single phase jump.
  let phaseA = rng() * Math.PI * 2;
  let phaseB = rng() * Math.PI * 2;
  let phaseC = rng() * Math.PI * 2;
  const offsetB = rng() * Math.PI * 2;
  const offsetC = rng() * Math.PI * 2;
  const driftChannel = (seed % 1000) * 0.101 + 3.7;

  let hatchP = 0;
  let disposed = false;

  return {
    group,
    seed,
    texture,
    radius: EGG_RADIUS,

    update(dt: number, nowMs: number): void {
      const drop = dropSpring.update(dt);

      if (revealPainted < 1) {
        const reveal = revealSpring.update(dt);
        if (reveal - revealPainted > 0.006 || reveal >= 0.999) {
          const t = reveal >= 0.999 ? 1 : reveal;
          paint(t);
          revealPainted = t;
        }
      }

      // Amplitude and frequency ramp smoothly as the hatch approaches —
      // continuous drift, never an entrance or a settle, never a step.
      const rate = ((Math.PI * 2) / MOTION.ambientMs) * (1 + 1.3 * hatchP);
      phaseA += rate * dt;
      phaseB += rate * WOBBLE_RATIO * dt;
      phaseC += rate * 0.77 * dt;
      const amp = WOBBLE_AMP * (1 + 2.8 * hatchP * hatchP);
      group.rotation.z = amp * (Math.sin(phaseA) + 0.55 * Math.sin(phaseB + offsetB));
      group.rotation.x =
        amp * 0.6 * (Math.sin(phaseB * 0.5 + offsetC) + 0.55 * Math.sin(phaseC));

      // Ambient drift floor on top of the entrance slide.
      const drift = sampleDrift(nowMs, driftChannel, EGG_HEIGHT);
      group.position.set(baseX + drift.x, drop, baseZ + drift.y);
      group.rotation.y = FACE_CAMERA_Y + drift.rot;
    },

    setHatchProgress(p: number): void {
      hatchP = clamp01(p);
    },
    hatchProgress(): number {
      return hatchP;
    },

    crack(p: number): void {
      crackHandle.setCrack(p);
    },
    crackValue(): number {
      return crackHandle.crackValue();
    },

    hatchPoint(): Vector3 {
      return new Vector3(group.position.x, EGG_HEIGHT * 0.55, group.position.z);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      dropSpring.dispose();
      revealSpring.dispose();
    },
  };
}
