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
 * of radius `bodyR` (`clumpLocalOffset`, src/creatures/sticky.ts), so at a
 * `GROWTH_K` of 4 and a ball ten to twenty metres across what the room saw
 * was a small character hanging in the air over a thin shell of a dozen
 * props. Not a misplaced creature — a MISSING MESH.
 *
 * AND THE CREATURE IS AT ITS CENTRE (user direction, 2026-09-17: *"the objects
 * that collect around the creatures sit under the creature. I think the
 * creature should be at the center, and then it should just be a giant rolling
 * mass. We still have a glitch where the creature is sitting on the Z-index
 * above whatever objects they collect. They should be at the center of the
 * sphere of the objects."*). The pole seat is gone — `growPass` puts the rider
 * at the ball's CENTRE — which is what makes the shell's SIDE the load-bearing
 * choice in this file: see `BALL_SIDE`.
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
 *    and darker than the body so the creature inside it still reads as the
 *    character against it. The environment rule is untouched: nothing
 *    environmental takes a hue, and this is a creature.
 *  - the same material family as the creature (`createCharacterMaterial`)
 *    with the cel chain applied LAST (`applyToon`, src/world/toon.ts), so a
 *    ball lights with the props and the ground it is rolling over.
 *  - NOT A PRIMITIVE. A radial nudge from a deterministic low-frequency field
 *    makes it hand-formed, the same recipe the egg shell uses (src/egg/egg.ts
 *    `shellNoise`) and for the same reason — "no rectilinear or engineered
 *    geometry" (TASTE §2.6) is about form, and a CAD sphere is a form. The
 *    nudge is INWARD ONLY, so the radius never exceeds 1 and every seat
 *    (`R + itemR × CLUMP_FIT`) is still on or outside the surface. It used to
 *    fade out over the north pole because the creature stood there; it no
 *    longer does, so the whole mass is lumpy — one shape rather than a shape
 *    with a flat spot on top.
 *
 * KATAMARI ONLY. `becomeAlive` builds it inside the same `game === 'katamari'`
 * guard as the clump and the rider, so no other world has a ball to draw
 * (2026-09-15 user ruling, src/world/game.ts). A creature that is still
 * walking has `roll` 0, and the manager parks the sphere a radius UNDER the
 * root where the ground hides it — so an unladen creature shows no ball
 * without anything being switched off.
 */

import { BackSide, Mesh, SphereGeometry } from 'three';
import type { BufferGeometry, Material } from 'three';
import { createCharacterMaterial } from '../character/mesh';
import type { CreaturePalette } from '../character/palette';
import { applyToon } from '../world/toon';

/**
 * [D] THE SHELL IS DRAWN FROM THE INSIDE — `BackSide`, and this is the whole
 * answer to the user's *"z-index"* complaint (2026-09-17).
 *
 * With the creature at the ball's CENTRE, an opaque sphere of radius `bodyR`
 * would simply swallow it: the near hemisphere is between the camera and the
 * creature at every angle. The two ways out of that are a depth or
 * render-order hack — draw the creature last, or turn its depth test off,
 * which is exactly the glitch that was reported — or a shell that has no near
 * hemisphere. `BackSide` culls the front faces, so what is drawn is the FAR
 * inside of the mass: the fill behind the creature, the full circle of the
 * silhouette (the far shell reaches the rim), and nothing at all in front.
 *
 * Everything else then falls out correctly with no special cases:
 *
 *  - the creature is nearer than the far shell, so it draws over it by the
 *    ordinary depth test;
 *  - an item seated on the NEAR side of the pile is genuinely in front of the
 *    creature and genuinely occludes it, which is the part the report asked
 *    for — a creature inside a mass is behind the near half of that mass;
 *  - an item on the far side is behind the shell where the shell covers it and
 *    pokes out past the rim where it does not, which is what a thing stuck
 *    into the back of a ball looks like.
 *
 * The lighting reads the geometry's own outward normals (the cel chain's
 * `vToonNormal`), which on the far inside face away from the camera — so the
 * interior takes the shade tone and sits behind the creature as depth rather
 * than competing with it. That is the look, not an accident of the cull.
 */
export const BALL_SIDE = BackSide;

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
    // INWARD ONLY: the radius never exceeds 1, so every seated item is on or
    // outside the surface (`R + itemR × CLUMP_FIT`) rather than sunk into it.
    // Over the whole ball, with no exemption at the pole — the creature is at
    // the CENTRE now (2026-09-17), so nothing stands on the top of the shell.
    const s = 1 - BALL_NUDGE * ballNoise(x, y, z, bucket);
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
  // FROM THE INSIDE (see `BALL_SIDE`): the near hemisphere is never drawn, so
  // the creature at the ball's centre is visible with no depth or
  // render-order hack of any kind.
  material.side = BALL_SIDE;
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
