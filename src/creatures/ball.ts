/**
 * THE BALL HAS A BODY.
 *
 * > User report, 2026-09-17: *"Currently there is a bug where the characters
 * > are floating in space."*
 *
 * Until 2026-09-17 the drawn creature WAS the ball: `character.group` was
 * reparented into the pile and the root's uniform scale — the growth — made
 * it as big as the mass it was carrying. The creature came back out of the
 * pile that day (*"we should not scale up the characters as they stick to
 * things"*, docs/PLAN.md §7.6, the `rider` node), and it came out standing on
 * a sphere that nothing draws: the items are seated on the surface of a ball
 * of radius `bodyR` (`clumpLocalOffset`, src/creatures/sticky.ts) and the
 * creature rides its north pole at `2R`, so at a `GROWTH_K` of 4 and a ball
 * ten to twenty metres across what the room saw was a small character hanging
 * in the air over a thin shell of a dozen props. Not a misplaced creature — a
 * MISSING MESH.
 *
 * So this is the mesh: one sphere per creature, radius 1 in its own space and
 * scaled to `baseR`, hung on the ROOT so the root's growth carries it to
 * `bodyR` exactly the way it carries the resolve circle, the pickup reach and
 * the shadow stamp. The growth stays ONE write on the root (CLAUDE.md), the
 * rider still divides it back out, and nothing here is on the wire: every
 * page derives the same sphere from the same synced pile.
 *
 * THE LOOK (TASTE §8, §9 — the creature's own colourway, never the
 * environment's):
 *
 *  - the creature's HUE, one of the six read off its drawing
 *    (src/character/palette.ts), and specifically `palette.stalk` — the body
 *    hue pulled toward the brief's dark neutral. A tint of the one hue on the
 *    figure rather than a second one (*"color rarely mixes on one figure"*),
 *    and darker than the body so the small bright creature standing on top of
 *    it still reads as the character. The environment rule is untouched:
 *    nothing environmental takes a hue, and this is a creature.
 *  - the same material family as the creature (`createCharacterMaterial`)
 *    with the cel chain applied LAST (`applyToon`, src/world/toon.ts), so a
 *    ball lights with the props and the ground it is rolling over.
 *  - NOT A PRIMITIVE. A radial nudge from a deterministic low-frequency field
 *    makes it hand-formed, the same recipe the egg shell uses (src/egg/egg.ts
 *    `shellNoise`) and for the same reason — "no rectilinear or engineered
 *    geometry" (TASTE §2.6) is about form, and a CAD sphere is a form. The
 *    nudge is INWARD ONLY and fades out over the top of the ball, so the
 *    north pole is exactly radius 1: that is where the creature's feet are,
 *    and a bulge there would lift it off its own pile.
 *
 * KATAMARI ONLY. `becomeAlive` builds it inside the same `game === 'katamari'`
 * guard as the clump and the rider, so no other world has a ball to draw
 * (2026-09-15 user ruling, src/world/game.ts). A creature that is still
 * walking has `roll` 0, and the manager parks the sphere a radius UNDER the
 * root where the ground hides it — so an unladen creature shows no ball
 * without anything being switched off.
 */

import { Mesh, SphereGeometry } from 'three';
import type { BufferGeometry, Material } from 'three';
import { createCharacterMaterial } from '../character/mesh';
import type { CreaturePalette } from '../character/palette';
import { applyToon } from '../world/toon';

/**
 * [D] Segments. 32 × 20 is 1280 triangles a ball — a fifth of one prop's
 * budget on a map that carries forty thousand blades, and enough that a
 * twenty-metre sphere has no visible facet at the default framing. Balls are
 * one draw call each and cannot be instanced (the hue is per creature), so
 * this is the number a room of eighty pays eighty times.
 */
export const BALL_SEGMENTS_W = 32;
export const BALL_SEGMENTS_H = 20;

/**
 * [D] Radial nudge, as a fraction of the radius. The egg's is 0.032 on a
 * 1 u shell; a ball is up to twenty units across and reads as a smooth
 * primitive at that size unless the nudge is bigger, so 0.06 — a hand's
 * width of wobble on a three-metre ball and never enough to move where the
 * items are seated (they sit at `R + itemR × CLUMP_FIT`, a fifth of a
 * radius out).
 */
export const BALL_NUDGE = 0.06;

/**
 * [D] Where the nudge has faded out entirely, as a fraction of the radius up
 * the ball. Above this the sphere is exact, because the creature's feet stand
 * on the north pole (`growPass`: the rider's height is `2 · baseR · roll`) and
 * a lump under them would read as a creature sunk into its own pile.
 */
export const BALL_POLE_CLEAR = 0.8;

/**
 * [D] How many distinct shapes exist, and the one reason there is a cache:
 * geometry is per SEED BUCKET rather than per creature, so a hundred balls
 * hold eight geometries between them ("a hundred creatures is a memory
 * number", PLAN §7.1). The unit radius is what makes the sharing possible —
 * the size is the mesh's own scale.
 */
export const BALL_SHAPES = 8;

const shapes = new Map<number, BufferGeometry>();

/**
 * Smooth deterministic scalar field over the unit sphere, in 0..1 — a few
 * low-frequency lobes with mixed phases. Its own function rather than the
 * egg's private `shellNoise`, and the same shape of thing: pure in (position,
 * seed), so every page builds the identical ball for the identical creature.
 */
export function ballNoise(x: number, y: number, z: number, seed: number): number {
  const s = (seed % 877) * 0.017;
  const raw =
    Math.sin(x * 2.3 + y * 1.7 + s) * 0.5 +
    Math.sin(y * 1.9 + z * 2.9 + s * 1.3 + 0.7) * 0.3 +
    Math.sin(z * 2.1 + x * 3.3 + s * 2.1 + 2.2) * 0.2;
  return Math.min(1, Math.max(0, raw * 0.5 + 0.5));
}

/**
 * The unit ball's geometry for a seed bucket. Cached and SHARED, so the mesh
 * must never be disposed of by a creature going away — `createBallBody`
 * disposes its material and nothing else.
 */
export function ballGeometry(seed: number): BufferGeometry {
  const bucket = ((seed % BALL_SHAPES) + BALL_SHAPES) % BALL_SHAPES;
  const cached = shapes.get(bucket);
  if (cached) return cached;
  const geometry = new SphereGeometry(1, BALL_SEGMENTS_W, BALL_SEGMENTS_H);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // INWARD ONLY: the radius never exceeds 1, so the seated items and the
    // creature on the pole are on or outside the surface, never inside it.
    // And faded out over the top, so the pole itself is exactly 1.
    const pole = Math.min(1, Math.max(0, (y - BALL_POLE_CLEAR) / (1 - BALL_POLE_CLEAR)));
    const fade = 1 - pole * pole * (3 - 2 * pole);
    const s = 1 - BALL_NUDGE * ballNoise(x, y, z, bucket) * fade;
    position.setXYZ(i, x * s, y * s, z * s);
  }
  position.needsUpdate = true;
  // The nudge rides on the sphere's own normals like the egg's does — a 6%
  // low-frequency wobble leaves the shading seamless, and the cel chain reads
  // two flat tones off it anyway.
  geometry.computeBoundingSphere();
  shapes.set(bucket, geometry);
  return geometry;
}

export interface BallBody {
  /** The mesh, named `ball`. Parent it to the creature ROOT. */
  mesh: Mesh;
  /** Release the material. The geometry is shared and stays. */
  dispose(): void;
}

/**
 * One creature's ball. `baseR` is the creature's MEASURED footprint radius —
 * the growth is the root's and arrives through the parent, so the mesh's own
 * scale is the size the pile started at.
 */
export function createBallBody(baseR: number, palette: CreaturePalette, seed: number): BallBody {
  const material: Material = createCharacterMaterial(palette.stalk);
  // LAST, after nothing — this material owns no other injection — but through
  // the same call every other mesh in the world goes through, so one style
  // write reaches the ball with the props (src/world/toon.ts: chain, never
  // clobber).
  applyToon(material);
  const mesh = new Mesh(ballGeometry(seed), material);
  mesh.name = 'ball';
  mesh.scale.setScalar(Math.max(1e-6, baseR));
  // Parked under the ground until the pile rolls: `growPass` writes the
  // height every frame and a creature that is still walking has `roll` 0,
  // which puts the whole sphere below the root (see the manager).
  mesh.position.y = -baseR;
  mesh.visible = false;
  return {
    mesh,
    dispose(): void {
      material.dispose();
    },
  };
}
