/**
 * The stalk and its topper — the creature brief's rig (docs/taste/creature.md).
 *
 * The brief's one reusable creature is *"a soft ovoid body with two dot eyes
 * and a stalk sprouting from the head that ends in a leaf, bud, or flower"*,
 * and it is explicit that the stalk-topper *"carries species identity while
 * the body stays constant"* [M]. In ours the topper IS the person's drawing:
 * the body is the drawing reproportioned into a creature (interpret.ts), and
 * the thing on the stalk is the same drawing inflated thinly, so what someone
 * drew reads twice — once as mass, once as the species marker.
 *
 * Everything here works in the BODY MESH's object space (inflate() centres on
 * the ink bounds and scales by 1/mask size, so the body is roughly unit-sized)
 * and the numbers below are fractions of the body's own height — a creature
 * built from a tall drawing gets a proportionally tall stalk, never a
 * world-absolute one.
 *
 * Deterministic: the only variation is the stalk's lean, taken from the seed
 * the caller already derives from the strokes (+ identity). Same drawing →
 * same stalk on the phone and in the world.
 */

import {
  BufferGeometry,
  CatmullRomCurve3,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { inflate } from '../inflate/inflate';
import type { Point, ShapeAnalysis } from '../shape/types';
import type { CreaturePalette } from './palette';
import { toBufferGeometry } from './mesh';

/**
 * Stalk reach, as a fraction of body height. [D] The board shows *"one to
 * one-and-a-half body heights of reach"* for the drawn creatures, but those
 * are portraits; at world scale a creature is a few percent of the frame and
 * a full-body stalk reads as a second creature, so ours sits at roughly a
 * third to a half of a body.
 */
export const STALK_LENGTH = 0.42;

/** Stalk thickness (tube radius), as a fraction of body height. [D] Thin —
 * the brief's stalk is a drawn line, not a limb. */
export const STALK_RADIUS = 0.014;

/** Topper extent (larger of width/height), as a fraction of body height. [D]
 * Big enough to read the drawing at world scale, small enough that the body
 * still owns the silhouette. */
export const TOPPER_SIZE = 0.34;

/** How thin the topper is puffed. [D] The default 0.9 would make a pillow;
 * the brief's topper is a flat graphic thing that still needs to survive the
 * free-orbit camera, so it is a thick card rather than a blob. */
export const TOPPER_DEPTH_SCALE = 0.35;

/** Fallback bud radius when the drawing's own inflation is degenerate. [D] */
export const BUD_RADIUS = 0.08;

/** Half-width of the x window searched for the crown, in object units. [D] */
export const CROWN_WINDOW = 0.08;

/** How far the stalk's mid control point leans off vertical, as a fraction
 * of body height. [D] The board's stalks are *"thin, slightly curved"* — a
 * hand-drawn wobble, not an arc. */
export const STALK_LEAN = 0.06;

/** Tube segments / radial segments. [D] Cheap: 200 creatures share this. */
const TUBE_SEGMENTS = 12;
const TUBE_RADIAL = 6;

/**
 * Dev-tunable overrides (src/dev/index.ts, `character` folder). Module-level
 * and mutable on purpose: the panel writes them and creatures built AFTER
 * the write pick them up. Never read outside createTopper.
 */
let stalkLengthTunable = STALK_LENGTH;
let topperSizeTunable = TOPPER_SIZE;

/** Dev only: move the stalk/topper dials. Affects creatures built afterwards. */
export function setTopperTunables(next: { stalkLength?: number; topperSize?: number }): void {
  if (next.stalkLength !== undefined) stalkLengthTunable = next.stalkLength;
  if (next.topperSize !== undefined) topperSizeTunable = next.topperSize;
}

/** Dev only: the current dial values (the panel seeds its sliders from these). */
export function topperTunables(): { stalkLength: number; topperSize: number } {
  return { stalkLength: stalkLengthTunable, topperSize: topperSizeTunable };
}

export interface TopperArgs {
  /** The body geometry, in its own object space (already bounding-boxed). */
  body: BufferGeometry;
  /** Analysis of the PROCESSED body — supplies the head lobe and mask size. */
  analysis: ShapeAnalysis;
  /** Analysis of the drawing AS DRAWN — the topper is cut from this. */
  source: ShapeAnalysis;
  /** The creature's colourway (./palette.ts). */
  palette: CreaturePalette;
  /** Deterministic seed (stroke seed, optionally identity-salted). */
  seed: number;
}

export interface TopperHandle {
  /** A Group named `topper`: the stalk tube plus the topper mesh. */
  group: Group;
  /**
   * The stalk's and the topper's materials, for the body's deform handles to
   * attach to (src/character/deform.ts `attach`). Both geometries are baked
   * into the BODY's object space with identity mesh transforms, which is
   * what lets the body's vertex deformation — squash, lean, twist, reach,
   * gait — run on them unchanged: a vertex above the head takes the full
   * bend the head takes, so the stalk follows the head and the topper rides
   * the stalk.
   */
  materials: MeshPhysicalMaterial[];
  /** Where the stalk leaves the body, in body object space. */
  base: Vector3;
  /** Where the topper sits, in body object space. */
  tip: Vector3;
  dispose(): void;
}

/**
 * Map a mask-space point into the body mesh's object space, using exactly
 * the transform inflate() applies (centre on ink bounds, flip y up, scale by
 * 1/mask size). Kept here rather than imported so src/inflate/ stays pure.
 */
function toObjectSpace(analysis: ShapeAnalysis, p: Point): { x: number; y: number } {
  const cx = (analysis.bounds.minX + analysis.bounds.maxX) / 2;
  const cy = (analysis.bounds.minY + analysis.bounds.maxY) / 2;
  const inv = 1 / analysis.mask.size;
  return { x: (p.x - cx) * inv, y: (cy - p.y) * inv };
}

/** Same LCG recipe as the rest of the character pipeline. */
function makeRng(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The crown: the topmost body vertex in a narrow x window around the head
 * lobe. That is where the stalk leaves the body — on the drawing's own head,
 * not on an averaged bbox top. Falls back to the bbox top centre when the
 * window is empty (a body whose head lobe sits off the silhouette's top).
 */
function crownOf(body: BufferGeometry, analysis: ShapeAnalysis): Vector3 {
  if (!body.boundingBox) body.computeBoundingBox();
  const box = body.boundingBox!;
  const lobe = toObjectSpace(analysis, analysis.headLobe);
  const position = body.getAttribute('position');
  let bestY = -Infinity;
  let bestX = 0;
  let bestZ = 0;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    if (Math.abs(x - lobe.x) > CROWN_WINDOW) continue;
    const y = position.getY(i);
    if (y > bestY) {
      bestY = y;
      bestX = x;
      bestZ = position.getZ(i);
    }
  }
  if (bestY === -Infinity) {
    return new Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
  }
  // The stalk leaves the surface, not the rim: pull it back to the mid-depth
  // plane so it never floats off the front or back of a thin head.
  return new Vector3(bestX, bestY, bestZ * 0.5);
}

/**
 * Build the stalk + topper for one creature. Pure of side effects beyond the
 * GPU resources it allocates; dispose() releases every one of them.
 */
export function createTopper(args: TopperArgs): TopperHandle {
  const { body, analysis, source, palette, seed } = args;
  if (!body.boundingBox) body.computeBoundingBox();
  const box = body.boundingBox!;
  const height = Math.max(box.max.y - box.min.y, 1e-6);

  const rng = makeRng(seed);
  // One draw per channel, in a fixed order — determinism is load-bearing.
  const leanSide = rng() < 0.5 ? -1 : 1;
  const leanAmount = (0.4 + rng() * 0.6) * STALK_LEAN * height;
  const tipLean = leanAmount * 0.5;

  const base = crownOf(body, analysis);
  const reach = stalkLengthTunable * height;
  const mid = new Vector3(
    base.x + leanSide * leanAmount,
    base.y + reach * 0.5,
    base.z + leanSide * leanAmount * 0.35,
  );
  const tip = new Vector3(base.x + leanSide * tipLean, base.y + reach, base.z);

  const curve = new CatmullRomCurve3([base.clone(), mid, tip.clone()]);
  const stalkGeometry = new TubeGeometry(
    curve,
    TUBE_SEGMENTS,
    STALK_RADIUS * height,
    TUBE_RADIAL,
    false,
  );
  const stalkMaterial = new MeshPhysicalMaterial({
    color: palette.stalk,
    roughness: 0.6,
    metalness: 0,
    clearcoat: 0.5,
    clearcoatRoughness: 0.3,
  });
  const stalkMesh = new Mesh(stalkGeometry, stalkMaterial);

  // The topper IS the drawing: the source analysis inflated thinly, so it
  // reads as the drawn thing from the front and still has body from the side.
  // A degenerate contour inflates to nothing — then every creature still gets
  // a bud, so the rig is never half-built.
  let topperGeometry = toBufferGeometry(inflate(source, { depthScale: TOPPER_DEPTH_SCALE }));
  let topperBox = topperGeometry.boundingBox;
  if (!topperBox || topperBox.isEmpty()) {
    topperGeometry.dispose();
    topperGeometry = new SphereGeometry(BUD_RADIUS * height, 16, 12);
    topperGeometry.computeBoundingBox();
    topperBox = topperGeometry.boundingBox;
  }
  const tb = topperBox!;
  const extent = Math.max(tb.max.x - tb.min.x, tb.max.y - tb.min.y, 1e-6);
  const topperScale = (topperSizeTunable * height) / extent;
  const topperMaterial = new MeshPhysicalMaterial({
    color: palette.topper,
    roughness: 0.6,
    metalness: 0,
    clearcoat: 0.5,
    clearcoatRoughness: 0.3,
  });
  // Centred over the tip in x/z, sitting ON the tip in y — the flower rests
  // on the stalk rather than being skewered by it. Faces +z, the creature's
  // front, which is the inflated drawing's own facing.
  //
  // BAKED into the geometry rather than set on the mesh: the body's vertex
  // deformation reads `transformed` in the mesh's own local space, so for
  // the topper to bend with the head its vertices have to already be where
  // they stand in the body's frame. The mesh stays at identity.
  topperGeometry.scale(topperScale, topperScale, topperScale);
  topperGeometry.translate(
    tip.x - ((tb.min.x + tb.max.x) / 2) * topperScale,
    tip.y - tb.min.y * topperScale,
    tip.z - ((tb.min.z + tb.max.z) / 2) * topperScale,
  );
  topperGeometry.computeBoundingBox();
  topperGeometry.computeBoundingSphere();
  const topperMesh = new Mesh(topperGeometry, topperMaterial);

  const group = new Group();
  group.name = 'topper';
  group.add(stalkMesh);
  group.add(topperMesh);

  return {
    group,
    materials: [stalkMaterial, topperMaterial],
    base,
    tip,
    dispose(): void {
      group.remove(stalkMesh);
      group.remove(topperMesh);
      stalkGeometry.dispose();
      stalkMaterial.dispose();
      topperGeometry.dispose();
      topperMaterial.dispose();
    },
  };
}
