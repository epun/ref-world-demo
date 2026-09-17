/**
 * A LIVE VIEW OF YOUR OWN BALL, in the corner of the phone's world view.
 *
 * > User ask, 2026-09-17: *"in the top left hand corner we should show a live
 * > view of the character and the objects it collects. the 3d view of the
 * > character and the object ball should not scale beyond the radius
 * > measurement ui div in the top left."*
 *
 * The size readout has been in that corner since 2026-09-16 (src/ui/size.ts);
 * this is the picture behind it, inside the same wavering hairline the join
 * code, the minimap and the leaderboard stand in (TASTE §9a). It is a real
 * render of the real creature — its gait, its emotes, its pile, its roll, the
 * passengers on it — and not a second model of anything: the same subtree the
 * world is drawing, drawn again from a camera of its own.
 *
 * HOW IT IS CHEAP. One extra pass over ONE SUBTREE, after the main frame has
 * composed:
 *
 *  - `renderer.render(root, camera)` takes any `Object3D` as its root, so the
 *    traversal is the creature's own rig — the rider, the ball, the clump and
 *    whatever is seated on it — and nothing else in the scene is walked,
 *    culled or drawn. No layer bookkeeping, no visibility toggling of a
 *    hundred creature roots a frame.
 *  - no shadows (the stamps live in `shadows.group`, which is not in the
 *    subtree) and no post: the ink and grain passes have already composed the
 *    frame by the time this runs, so the inset is the raw cel render. That is
 *    the whole reason it costs one pass and not three.
 *  - **the subtree carries no lights, and does not need any.** On a katamari
 *    world the cel chain is SELF-LIT: `applyToon` replaces `opaque_fragment`
 *    and writes `outgoingLight` from `toonUniforms` (src/world/toon.ts), so a
 *    creature, a ball and a prop are fully shaded with no light in the graph.
 *    A katamari world on the `ink` style would draw an unlit inset, and there
 *    is no such world — valiocon is the katamari and valiocon is ghibli. If
 *    one is ever added, this is the line that has to grow a light rig.
 *
 * THE PAPER IS A DISC, not the scissor's square. A scissor is rectangular, so
 * clearing the region to the chrome's paper painted a light SQUARE behind a
 * circular mark — a filled panel, which is the one thing the world brief's
 * mark set forbids (TASTE §4). So the pass clears DEPTH only and draws the
 * paper as a screen-facing circle of its own, sized to the frustum so it lands
 * exactly on the ring the DOM draws: inside it, paper; outside it, the world.
 * One more draw call and ninety-six triangles for a mark that is the shape it
 * is supposed to be.
 *
 * HOW IT STAYS INSIDE THE DIV. Two independent bounds, and that is deliberate:
 *
 *  - a SCISSOR on the readout div's own rect, so not one pixel of the pass can
 *    land outside the circle's box whatever the camera is doing — the hard
 *    bound the ask names;
 *  - and the FIT, which is the soft one: the orthographic half-extent is a
 *    function of the DRAWN pile's own reach every frame
 *    (`portraitHalfExtent`), eased by a ζ ≥ 1 spring, so as the pile grows
 *    the view pulls back and the mass keeps the same share of the circle
 *    instead of bursting it. A creature carrying nothing is framed by its own
 *    drawn height.
 *
 * The direction is FIXED at the world's own isometric pair rather than the
 * live camera's: a portrait that swung as the person orbited the world would
 * be a second camera to watch, and what is interesting in the corner is the
 * ball turning under its own roll — which it does, because the roll is on the
 * creature's rig and this pass draws that rig.
 *
 * Nothing here is katamari-gated by itself: the pass draws whatever subtree it
 * is handed. The GATE is the caller — src/main.ts installs it only for a
 * handset in the katamari world with a creature of its own, exactly like the
 * readout it sits behind.
 */

import {
  CircleGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Vector3,
} from 'three';
import type { Object3D, WebGLRenderer } from 'three';
import { Spring } from '../motion/spring';
import { MOTION } from '../taste/tokens';
import { ISO_AZIMUTH, ISO_ELEVATION } from './camera';

/**
 * [D] Air around the subject, as a fraction of its own half-extent. An eighth
 * of the radius: enough that the wavering ring never cuts the mass and the
 * items on the far rim stay inside the circle, and not so much that a
 * fifteen-metre ball reads as a speck in a big hole.
 */
export const PORTRAIT_MARGIN = 0.12;

/**
 * [D] The smallest half-extent the view will use, world units.
 *
 * A creature carrying nothing reaches nothing and is about a unit across, but
 * it stands `CHARACTER_HEIGHT` (3.5) tall with its stalk, so framing it by its
 * FOOTPRINT would crop its head off. Half its height plus a little is the
 * number that frames the drawn creature, and it is also the floor of every
 * ball's fit — which is what makes a hatchling's portrait and a hatchling's
 * first pickup the same picture at the same scale.
 */
export const PORTRAIT_MIN_HALF = 2;

/**
 * [D] Where the camera looks, as a fraction of `PORTRAIT_MIN_HALF` above the
 * creature's feet. A creature's mass is in its lower half, so the middle of
 * the frame is a little under the middle of its height — and since the items
 * pack onto the CHARACTER (2026-09-17) that is the middle of the whole pile
 * too, at every size — which is why the frame is centred on the MASS's own
 * bounds (`portraitCentreY`) and this is only the floor's own share.
 */
export const PORTRAIT_AIM_FRACTION = 0.55;

/** [D] How far the ortho camera stands off. An orthographic frustum's size is
 * its own, so this only has to keep the subject between the planes. */
const PORTRAIT_DIST = 100;
const PORTRAIT_NEAR = 1;
const PORTRAIT_FAR = 200;

/**
 * WHAT THE DRAWN MASS OCCUPIES, in the creature's own frame — feet at 0.
 *
 * Four numbers and they all come off the pile the person can see: the
 * creature's own drawn height and footprint radius, and the pile's own
 * `floor` (≤ 0), `ceiling` (above the feet) and `footprint`
 * (`CreatureManager.pileFloor` / `pileCeiling` / `pileFootprint`).
 */
export interface PortraitBounds {
  /** How tall the drawn creature is — `CHARACTER_HEIGHT` in world units. */
  height: number;
  /** Its own footprint radius. */
  radius: number;
  /** The pile's lowest point above the feet: 0 or negative. */
  floor: number;
  /** …and its highest. 0 for a creature carrying nothing. */
  ceiling: number;
  /** …and how far it reaches sideways from the creature's axis. */
  footprint: number;
}

/**
 * THE MIDDLE OF THAT MASS, world units above the creature's feet. PURE.
 *
 * > User direction, 2026-09-17, with a crop of the live inset showing a 52 m
 * > mass sitting low-left in the circle and the top half empty: *"the 3d
 * > representation of the character and mass should be vertically and
 * > horizontally centred in the circle."*
 *
 * The midpoint of the whole thing's vertical bounds — the creature from its
 * feet to its stalk, and the pile from its floor to its ceiling — and not the
 * creature's own middle, because with a pile packed to one side and up over
 * its head the creature is nowhere near the middle of the lump.
 */
export function portraitCentreY(bounds: PortraitBounds): number {
  const low = Math.min(0, Number.isFinite(bounds.floor) ? bounds.floor : 0);
  const height = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 0;
  const ceiling = Number.isFinite(bounds.ceiling) ? bounds.ceiling : 0;
  const high = Math.max(height, ceiling);
  return (low + high) / 2;
}

/**
 * …and HOW BIG A FRAME holds it, world units. PURE.
 *
 * Half of whichever bound is larger — the mass's own height, or twice its
 * widest horizontal reach about the creature's axis — plus the margin, and
 * never under the floor that frames a creature carrying nothing. Horizontally
 * a sideways pile is off-centre about the axis, so the half-width that has to
 * fit is the reach on the far side: the footprint itself.
 */
export function portraitBoundsHalf(bounds: PortraitBounds): number {
  const low = Math.min(0, Number.isFinite(bounds.floor) ? bounds.floor : 0);
  const height = Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : 0;
  const ceiling = Number.isFinite(bounds.ceiling) ? bounds.ceiling : 0;
  const high = Math.max(height, ceiling);
  const vertical = (high - low) / 2;
  const radius = Number.isFinite(bounds.radius) && bounds.radius > 0 ? bounds.radius : 0;
  const footprint = Number.isFinite(bounds.footprint) && bounds.footprint > 0 ? bounds.footprint : 0;
  return portraitHalfExtent(Math.max(vertical, radius, footprint));
}

/**
 * Half-height of the orthographic frustum that frames this subject, world
 * units. PURE.
 *
 * `reach` IS THE DRAWN MASS'S OWN RADIUS — `CreatureManager.pileReach`, the
 * furthest seat plus that item's radius — and NOT `ballDiameter / 2`. The two
 * were the same number when the items sat on the surface of a sphere of that
 * radius; since they pack onto the character (2026-09-17, *"the character
 * should be the object that the items stick to"*) `bodyR` is the accumulated
 * VOLUME and runs well ahead of the lump anybody can see — measured at
 * fifteen props, packed 4.6 u against a `bodyR` of 7.1, which framed the
 * picture on a sphere half again as wide as its subject and left the lump
 * rattling around in the middle of the circle. So the fit reads the reach and
 * the mass fills the circle at every size.
 *
 * Plus the margin, and never under the floor that frames the creature itself.
 */
export function portraitHalfExtent(reach: number): number {
  const r = Number.isFinite(reach) && reach > 0 ? reach : 0;
  return Math.max(r, PORTRAIT_MIN_HALF) * (1 + PORTRAIT_MARGIN);
}

/** Where the inset is on screen, CSS pixels from the top-left of the page. */
export interface PortraitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What to draw: one creature's rig, and what the mass on it occupies. */
export interface PortraitSubject {
  /** The creature ROOT — `renderer.render` walks this and nothing else. */
  root: Object3D;
  /**
   * What the DRAWN mass occupies in the creature's own frame — never
   * `ballDiameter / 2`, which is the accumulated volume and is larger than
   * anything on screen (see `portraitHalfExtent`). A creature carrying
   * nothing has a floor, a ceiling and a footprint of 0 and is framed by its
   * own height.
   */
  bounds: PortraitBounds;
}

export interface PortraitSource {
  /** Read per frame: null when there is nothing to draw (still an egg, the
   * creature was retired, the corner has not slid in yet). */
  subject(): PortraitSubject | null;
  /** …and where to draw it. Null hides the pass entirely. */
  rect(): PortraitRect | null;
}

export interface PortraitPass {
  /** Install (or clear) the source. */
  setSource(source: PortraitSource | null): void;
  /** Draw it. Called from the frame AFTER the main pass has composed. */
  render(dtMs: number): void;
  /** The half-extent the fit spring is at, for a test and the panel. */
  fit(): number;
  dispose(): void;
}

/**
 * Build the pass. Cheap to construct and inert until `setSource`, so a page
 * that never shows a portrait pays one camera and one spring.
 */
export function createPortraitPass(opts: {
  renderer: WebGLRenderer;
  /** The paper the circle stands on — cleared in GL rather than painted by
   * the DOM, because the DOM is IN FRONT of the canvas and a paper fill up
   * there would cover the picture (src/ui/size.ts draws the ring alone). */
  paper: string;
}): PortraitPass {
  const { renderer } = opts;
  const camera = new OrthographicCamera(-1, 1, 1, -1, PORTRAIT_NEAR, PORTRAIT_FAR);
  /*
   * THE FIT IS A SLIDE. The ball's radius steps every time something sticks
   * to it (`growth` is instantaneous in the volumes), and a view that
   * re-framed on the same frame would be a cut in the one part of the screen
   * a person is watching. ζ ≥ 1 over `MOTION.primaryMs`, like every other
   * spring in this project, so it can never overshoot into a frame smaller
   * than the mass.
   */
  const fitSpring = new Spring(portraitHalfExtent(0), { settleMs: MOTION.primaryMs });
  /** The isometric direction, from the same pair the world's rig opens on. */
  const dir = new Vector3(
    Math.cos(ISO_ELEVATION) * Math.sin(ISO_AZIMUTH),
    Math.sin(ISO_ELEVATION),
    Math.cos(ISO_ELEVATION) * Math.cos(ISO_AZIMUTH),
  ).normalize();
  const aim = new Vector3();
  const paper = new Color(opts.paper);
  /*
   * THE PAPER, as geometry (see the header). A unit circle scaled to the
   * frustum's half-extent, so its edge is exactly where the wavering ring is
   * drawn; `MeshBasicMaterial` because this is a flat fill and not a surface
   * in the world — no lighting, and deliberately NO `applyToon`: the cel
   * chain is for things that are in the world, and the paper is chrome.
   */
  const paperDisc = new Mesh(
    new CircleGeometry(1, 48),
    new MeshBasicMaterial({ color: paper }),
  );
  paperDisc.name = 'portrait paper';
  const previousColor = new Color();
  let source: PortraitSource | null = null;
  let half = fitSpring.value;

  return {
    setSource(next): void {
      source = next;
    },
    fit: () => half,
    render(dtMs): void {
      const rect = source?.rect() ?? null;
      const subject = source?.subject() ?? null;
      // The spring runs whether or not there is anything to draw, so a
      // portrait that comes back after a retire comes back at the size it
      // left rather than jumping to it.
      fitSpring.retarget(
        subject ? portraitBoundsHalf(subject.bounds) : portraitHalfExtent(0),
      );
      half = fitSpring.update(dtMs);
      if (!rect || !subject) return;
      if (!(rect.w > 1) || !(rect.h > 1)) return;

      camera.left = -half;
      camera.right = half;
      camera.top = half;
      camera.bottom = -half;
      camera.updateProjectionMatrix();
      subject.root.getWorldPosition(aim);
      // The middle of the mass, not the middle of the creature: with a pile
      // packed to one side the two are not the same point (2026-09-17).
      aim.y += portraitCentreY(subject.bounds);
      camera.position.copy(aim).addScaledVector(dir, PORTRAIT_DIST);
      camera.lookAt(aim);

      /*
       * GL's Y IS FROM THE BOTTOM and the rect is from the top, so the
       * viewport's y is the canvas height less the rect's bottom edge. CSS
       * pixels: three multiplies both by the pixel ratio itself.
       */
      const canvas = renderer.domElement;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const x = rect.x;
      const y = height - (rect.y + rect.h);

      const wasAutoClear = renderer.autoClear;
      const wasAlpha = renderer.getClearAlpha();
      renderer.getClearColor(previousColor);
      // The composed frame is on the canvas; this draws into a corner of it.
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.setViewport(x, y, rect.w, rect.h);
      renderer.setScissor(x, y, rect.w, rect.h);
      renderer.setScissorTest(true);
      /*
       * DEPTH ONLY — the colour behind the circle is the world, and the paper
       * inside it is the disc below. Clearing colour here would fill the
       * scissor's SQUARE (see the header).
       */
      renderer.clear(false, true, false);
      /*
       * The paper first, behind everything the subject is made of: a radius
       * past the far side of the mass, facing the camera, scaled so its rim
       * is the frustum's own edge.
       */
      paperDisc.position.copy(aim).addScaledVector(dir, -half * 2);
      paperDisc.quaternion.copy(camera.quaternion);
      paperDisc.scale.setScalar(half);
      paperDisc.updateMatrixWorld(true);
      renderer.render(paperDisc, camera);
      renderer.render(subject.root, camera);
      // …and put the renderer back exactly as the frame left it.
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      renderer.setClearColor(previousColor, wasAlpha);
      renderer.autoClear = wasAutoClear;
    },
    dispose(): void {
      source = null;
      fitSpring.dispose();
      paperDisc.geometry.dispose();
      (paperDisc.material as MeshBasicMaterial).dispose();
    },
  };
}
