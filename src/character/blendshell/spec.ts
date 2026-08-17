/**
 * Blend-shell character spec (BLENDSHELL step 1) — the "~15 lines of JSON".
 *
 * A character is a small set of SDF primitives (capsules/spheres/cones) whose
 * smooth-min union IS the body. specFromMotifs resolves the measured drawing
 * motifs (aspect, fullness, head size, foot/crown angles) into that primitive
 * set: a chunky torso cluster, a head sphere merged high, two short stubby
 * legs (the avatar spec's default), crown appendages at the drawn angles with
 * a CAPPED blend radius (the antenna rule — thin parts must not dissolve into
 * the mass), and an optional tail.
 *
 * PURE module: no Three.js, no DOM, no Math.random, no Date. Same motifs +
 * seed → identical spec on every device. The CPU smooth-min SDF here is the
 * exact twin of the GLSL in shell.ts — eyes placement, IK, and tests all read
 * the same field the vertex shader snaps to.
 *
 * Space: y up, ground at y = 0, forward +z (the root's heading convention).
 * Units are "spec units" — the whole character stands roughly 0.7–1 unit tall
 * and is scaled to CHARACTER_HEIGHT downstream.
 */

import type { Motifs } from '../interpret';

export type V3 = [number, number, number];

export type PartKind = 'capsule' | 'sphere' | 'cone';

export type PartGroup =
  | 'torso'
  | 'head'
  | 'leg-l'
  | 'leg-r'
  | 'arm-l'
  | 'arm-r'
  | 'crown'
  | 'tail';

export interface SdfPart {
  kind: PartKind;
  /** Segment start (or sphere center). */
  a: V3;
  /** Segment end — absent for spheres. */
  b?: V3;
  /** Radius at `a`. */
  r: number;
  /** Radius at `b` (tapered capsule / rounded cone). Defaults to `r`. */
  r2?: number;
  /** Smooth-min blend radius. Pairwise k = min(blend_i, blend_j). */
  blend: number;
  group: PartGroup;
}

export interface CharacterSpec {
  parts: SdfPart[];
}

/** Uniform-array budget — the shader's part table (shell.ts) is sized to it. */
export const MAX_PARTS = 15;

/**
 * The antenna rule: thin crown appendages cap their blend radius so they stay
 * read-able spikes/ears instead of dissolving into the head mass.
 */
export const CROWN_BLEND_CAP = 0.035;

/** Species clamp — same band as interpret.ts. */
const ASPECT_MIN = 0.9;
const ASPECT_MAX = 1.6;
/** Near-vertical clamp on drawn foot angles so the creature stands. */
const LEG_SPLAY = 0.18;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Same LCG recipe as interpret.ts — deterministic per seed. */
function makeRng(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── spec synthesis ───────────────────────────────────────────────────────────

/**
 * Resolve motifs + seed into the primitive-set character. Deterministic.
 * Emission order is a contract the animation layers rely on:
 *   torso parts → head → legs as (upper, lower) pairs interleaved l/r →
 *   crown chains (consecutive fused segments) → tail chain.
 * Total parts never exceed MAX_PARTS (chains that would overflow are skipped).
 */
export function specFromMotifs(motifs: Motifs, seed: number): CharacterSpec {
  const rng = makeRng(seed);
  const parts: SdfPart[] = [];

  const aspect = clamp(motifs.aspect, ASPECT_MIN, ASPECT_MAX);
  const full = clamp(motifs.torsoFullness, 0, 1);

  const legCount =
    motifs.archetype === 'quadruped' ? 4 : motifs.archetype === 'blob' ? 0 : 2;
  const legLen = legCount > 0 ? 0.15 + 0.05 * rng() : 0;

  // Torso: a fat vertical capsule + belly/rump spheres — chunky, never a
  // clean primitive read once the belly and blend soften it.
  const torsoH = 0.5 + 0.12 * ((aspect - ASPECT_MIN) / (ASPECT_MAX - ASPECT_MIN));
  const rT = clamp((torsoH / (2 * aspect)) * (0.9 + 0.35 * full), 0.15, 0.3);
  const core = Math.max(torsoH - 2 * rT, 0.02);
  const yB = legCount > 0 ? legLen + rT * 0.72 : rT * 0.95;
  const yT = yB + core;

  parts.push({
    kind: 'capsule',
    a: [0, yB, 0],
    b: [0, yT, 0],
    r: rT,
    blend: 0.1,
    group: 'torso',
  });
  parts.push({
    kind: 'sphere',
    a: [(rng() - 0.5) * rT * 0.1, yB + core * 0.2, rT * 0.16],
    r: rT * 0.82,
    blend: 0.1,
    group: 'torso',
  });
  parts.push({
    kind: 'sphere',
    a: [(rng() - 0.5) * rT * 0.1, yB + core * 0.1, -rT * 0.14],
    r: rT * 0.74,
    blend: 0.1,
    group: 'torso',
  });

  // Head: a sphere merged high — deep overlap with the torso top so the
  // smooth-min reads one mass with a proud upper lobe.
  const rH = rT * (0.6 + 0.4 * clamp(motifs.headSize, 0.3, 1));
  const headC: V3 = [(rng() - 0.5) * rT * 0.06, yT + rT * 0.4 + rH * 0.35, rT * 0.06];
  parts.push({ kind: 'sphere', a: headC, r: rH, blend: 0.09, group: 'head' });

  // Legs: short stubby two-part chains (upper + lower capsule per leg — the
  // IK in step.ts drives exactly these entries). Foot angles echo the drawing,
  // clamped near-vertical. Interleaved l/r so step.ts can pair them by scan.
  if (legCount > 0) {
    const drawn = motifs.feet.map((f) => f.angle).sort((a, b) => a - b);
    const angleFor = (i: number, n: number): number => {
      if (drawn.length === 0) return 0;
      const pick = drawn[Math.round((i * (drawn.length - 1)) / Math.max(1, n - 1))]!;
      return clamp(pick, -LEG_SPLAY, LEG_SPLAY);
    };
    const rLeg = clamp(rT * 0.3, 0.045, 0.09);
    const footY = rLeg * 0.85;
    const hipY = yB - rT * 0.4;
    const hipRows: { x: number; z: number; side: -1 | 1 }[] =
      legCount === 4
        ? [
            { x: -rT * 0.45, z: rT * 0.5, side: -1 },
            { x: rT * 0.45, z: rT * 0.5, side: 1 },
            { x: -rT * 0.45, z: -rT * 0.5, side: -1 },
            { x: rT * 0.45, z: -rT * 0.5, side: 1 },
          ]
        : [
            { x: -rT * 0.5, z: 0, side: -1 },
            { x: rT * 0.5, z: 0, side: 1 },
          ];
    hipRows.forEach((hip, i) => {
      const angle = angleFor(i, hipRows.length);
      const drop = hipY - footY;
      const foot: V3 = [hip.x + Math.sin(angle) * drop, footY, hip.z];
      const hipAt: V3 = [hip.x, hipY, hip.z];
      // Rest knee: midpoint bent forward so the chain carries slack for IK
      // (total length ≈ 1.15× the rest hip→foot distance).
      const mid: V3 = [
        (hipAt[0] + foot[0]) / 2,
        (hipAt[1] + foot[1]) / 2,
        (hipAt[2] + foot[2]) / 2,
      ];
      const dist = Math.hypot(foot[0] - hipAt[0], foot[1] - hipAt[1], foot[2] - hipAt[2]);
      const knee: V3 = [mid[0], mid[1], mid[2] + dist * 0.28];
      const group: PartGroup = hip.side < 0 ? 'leg-l' : 'leg-r';
      parts.push({
        kind: 'capsule',
        a: hipAt,
        b: knee,
        r: rLeg,
        r2: rLeg * 0.95,
        blend: 0.055,
        group,
      });
      parts.push({
        kind: 'capsule',
        a: knee,
        b: foot,
        r: rLeg * 0.95,
        r2: rLeg * 0.85,
        blend: 0.055,
        group,
      });
    });
  }

  // Crown: the signature echo — chains of 2 fused segments at the drawn
  // angles. Segments are ordinary SdfParts, so the verlet layer can flop them
  // while they stay welded to the head. Blend is CAPPED (the antenna rule).
  for (const m of motifs.crown) {
    if (parts.length + 2 > MAX_PARTS) break;
    const reach01 = clamp(m.reach * 2.2, 0, 1);
    const angle = clamp(m.angle, -1.15, 1.15);
    const dir: V3 = [Math.sin(angle), Math.cos(angle), 0];
    const len = clamp(rH * (0.55 + 1.6 * reach01), 0.08, 0.55);
    const rBase = clamp(rH * (0.34 - 0.14 * reach01), 0.035, 0.09);
    const blend = Math.min(CROWN_BLEND_CAP, rBase * 0.8);
    const base: V3 = [
      headC[0] + dir[0] * rH * 0.75,
      headC[1] + dir[1] * rH * 0.75,
      headC[2] + dir[2] * rH * 0.75,
    ];
    const mid: V3 = [
      base[0] + dir[0] * len * 0.5,
      base[1] + dir[1] * len * 0.5,
      base[2] + dir[2] * len * 0.5,
    ];
    const tip: V3 = [base[0] + dir[0] * len, base[1] + dir[1] * len, base[2] + dir[2] * len];
    parts.push({
      kind: 'capsule',
      a: base,
      b: mid,
      r: rBase,
      r2: rBase * 0.78,
      blend,
      group: 'crown',
    });
    parts.push({
      kind: 'cone',
      a: mid,
      b: tip,
      r: rBase * 0.78,
      r2: Math.max(rBase * 0.45, 0.02),
      blend,
      group: 'crown',
    });
  }

  // Tail: quadrupeds always; others by seeded chance. Two fused rope segments
  // off the rump — the other verlet chain.
  const wantsTail = motifs.archetype === 'quadruped' || rng() < 0.35;
  if (wantsTail && parts.length + 2 <= MAX_PARTS) {
    const rTail = clamp(rT * 0.22, 0.035, 0.075);
    const tailLen = rT * 0.9;
    const base: V3 = [0, yB + core * 0.3, -(rT * 0.82)];
    const dir: V3 = [0, 0.22, -0.98];
    const n = Math.hypot(dir[0], dir[1], dir[2]);
    const d: V3 = [dir[0] / n, dir[1] / n, dir[2] / n];
    const mid: V3 = [
      base[0] + d[0] * tailLen * 0.5,
      base[1] + d[1] * tailLen * 0.5,
      base[2] + d[2] * tailLen * 0.5,
    ];
    const tip: V3 = [base[0] + d[0] * tailLen, base[1] + d[1] * tailLen, base[2] + d[2] * tailLen];
    parts.push({
      kind: 'capsule',
      a: base,
      b: mid,
      r: rTail,
      r2: rTail * 0.8,
      blend: 0.05,
      group: 'tail',
    });
    parts.push({
      kind: 'cone',
      a: mid,
      b: tip,
      r: rTail * 0.8,
      r2: Math.max(rTail * 0.5, 0.02),
      blend: 0.05,
      group: 'tail',
    });
  }

  return { parts };
}

// ── CPU SDF twin (the GLSL in shell.ts mirrors this exactly) ─────────────────

/** Distance to one part: a tapered segment (sphere when b is absent). */
export function sdfPart(p: V3, part: SdfPart): number {
  const a = part.a;
  const b = part.b ?? part.a;
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const dd = abx * abx + aby * aby + abz * abz;
  const t =
    dd > 1e-12
      ? clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / dd, 0, 1)
      : 0;
  const dx = p[0] - a[0] - abx * t;
  const dy = p[1] - a[1] - aby * t;
  const dz = p[2] - a[2] - abz * t;
  const r = part.r + ((part.r2 ?? part.r) - part.r) * t;
  return Math.hypot(dx, dy, dz) - r;
}

/**
 * Smooth-min union of all parts. Pairwise k = min(blend_i, blend_j): the
 * running union carries the blend of whichever part currently dominates, so a
 * capped-blend antenna meeting a soft torso blends at the antenna's cap.
 */
export function sdfSpec(p: V3, parts: readonly SdfPart[]): number {
  let d = 1e9;
  let cb = 1e9;
  for (const part of parts) {
    const di = sdfPart(p, part);
    const bi = part.blend;
    const k = Math.max(Math.min(cb, bi), 1e-5);
    const h = Math.max(k - Math.abs(d - di), 0) / k;
    const nd = Math.min(d, di) - h * h * k * 0.25;
    if (di < d) cb = bi;
    d = nd;
  }
  return d;
}

/** Central-difference SDF gradient (not normalized). */
export function sdfGradient(p: V3, parts: readonly SdfPart[], eps = 0.004): V3 {
  return [
    sdfSpec([p[0] + eps, p[1], p[2]], parts) - sdfSpec([p[0] - eps, p[1], p[2]], parts),
    sdfSpec([p[0], p[1] + eps, p[2]], parts) - sdfSpec([p[0], p[1] - eps, p[2]], parts),
    sdfSpec([p[0], p[1], p[2] + eps], parts) - sdfSpec([p[0], p[1], p[2] - eps], parts),
  ];
}

/** Conservative bounds from part endpoints ± radii (blend only shrinks). */
export function specBounds(spec: CharacterSpec): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const part of spec.parts) {
    const r = Math.max(part.r, part.r2 ?? part.r);
    for (const p of part.b ? [part.a, part.b] : [part.a]) {
      for (const i of [0, 1, 2] as const) {
        min[i] = Math.min(min[i], p[i] - r);
        max[i] = Math.max(max[i], p[i] + r);
      }
    }
  }
  return { min, max };
}

/** Character height in spec units (bounds y extent). */
export function specHeight(spec: CharacterSpec): number {
  const { min, max } = specBounds(spec);
  return Math.max(max[1] - min[1], 1e-6);
}
