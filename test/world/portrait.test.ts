/**
 * The corner's LIVE VIEW (src/world/portrait.ts).
 *
 * > User ask, 2026-09-17: *"in the top left hand corner we should show a live
 * > view of the character and the objects it collects. the 3d view of the
 * > character and the object ball should not scale beyond the radius
 * > measurement ui div in the top left."*
 *
 * Two promises, and the whole point of this file is that they are pinned
 * separately, because they fail separately:
 *
 *   1. THE FIT. The orthographic half-extent is a function of the DRAWN
 *      pile's own reach (`CreatureManager.pileReach`, not `ballDiameter / 2`
 *      — see `portraitHalfExtent`), and it is never smaller than that reach:
 *      the whole lump is inside the frame at every size a session can reach,
 *      with air to spare.
 *   2. THE BOUND. Not one pixel lands outside the readout's rect, because the
 *      pass scissors itself to it — and it hands the renderer back exactly as
 *      it found it, which is what keeps the next frame's full-screen passes
 *      from inheriting a corner-sized viewport.
 *
 * The pass is driven against a RECORDING renderer: everything it touches on
 * three's `WebGLRenderer` is a handful of setters, so the calls it makes are
 * observable in node without a GL context.
 */

import { Color, Group, Mesh, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import {
  PORTRAIT_AIM_FRACTION,
  PORTRAIT_MARGIN,
  PORTRAIT_MIN_HALF,
  createPortraitPass,
  portraitBoundsHalf,
  portraitCentreY,
  portraitHalfExtent,
  type PortraitSubject,
} from '../../src/world/portrait';
import { MOTION } from '../../src/taste/tokens';

describe('the corner frames what is DRAWN, at whatever size it is drawn', () => {
  /*
   * > User report, 2026-09-18, of a phone whose readout said 67 m while the
   * > circle held a speck: *"the 3d representation is too small in the top
   * > left corner."*
   *
   * The page handed the view a CONSTANT height and a constant radius, so a
   * ball grown thirty times over was framed as though it were a hatchling —
   * and since the creature IS the ball (restored the same day), the subject
   * really is its growth times its own size. `src/main.ts` multiplies both by
   * `CreatureManager.growthOf`; these are the two properties that makes the
   * picture fill the circle either way.
   */
  it('grows its frame with the mass, so the share of the circle holds', () => {
    const hatchling = portraitBoundsHalf({
      height: 3.5,
      radius: 0.9,
      floor: 0,
      ceiling: 0,
      footprint: 0,
    });
    // The same creature at ten times its size — what a grown ball is.
    const grown = portraitBoundsHalf({
      height: 35,
      radius: 9,
      floor: 0,
      ceiling: 0,
      footprint: 0,
    });
    // The frame tracks it rather than staying put…
    expect(grown).toBeGreaterThan(hatchling * 5);
    /*
     * …and the subject's share of the frame does not FALL as it grows, which
     * is the thing that was wrong: against a constant frame the share shrank
     * as 1/growth until the mass was a speck. The two are not identical
     * because `PORTRAIT_MIN_HALF` gives the smallest creature a touch more
     * paper, which is the floor doing its job.
     */
    expect((35 / 2) / grown).toBeGreaterThanOrEqual((3.5 / 2) / hatchling);
    expect((35 / 2) / grown).toBeGreaterThan(0.9);
  });

  it('leaves only a hair of paper around the mass', () => {
    // A hatchling is 3.5 tall, so half of it is 1.75 — and the frame it gets
    // is that plus the margin and nothing else, so it fills the circle.
    const half = portraitBoundsHalf({
      height: 3.5,
      radius: 0.9,
      floor: 0,
      ceiling: 0,
      footprint: 0,
    });
    expect(1.75 / half).toBeGreaterThan(0.85);
    expect(PORTRAIT_MARGIN).toBeLessThanOrEqual(0.06);
  });
});

describe('the fit is a function of the drawn pile, and never smaller than it', () => {
  it('frames the creature itself when there is no ball', () => {
    expect(portraitHalfExtent(0)).toBeCloseTo(PORTRAIT_MIN_HALF * (1 + PORTRAIT_MARGIN), 10);
    // A hatchling's own footprint is about a unit — under the floor, so it is
    // framed by its height and not by its width (`CHARACTER_HEIGHT` is 3.5,
    // and a creature framed at its footprint would be cropped at the stalk).
    expect(portraitHalfExtent(0.98)).toBe(portraitHalfExtent(0));
  });

  it('contains the whole lump at every size a session reaches', () => {
    // The ladder docs/PLAN.md §7.6 lists, and well past it.
    for (const reach of [0, 0.5, 0.98, 1.2, 1.5, 2.22, 3.06, 4.6, 7.125, 12, 20, 40]) {
      const half = portraitHalfExtent(reach);
      // The frame's half-height covers the pile's reach…
      expect(half).toBeGreaterThanOrEqual(reach);
      // …with the authored air around it.
      if (reach > PORTRAIT_MIN_HALF) {
        expect(half / reach).toBeCloseTo(1 + PORTRAIT_MARGIN, 10);
      }
    }
  });

  it('only ever grows with the pile', () => {
    let previous = 0;
    for (let reach = 0; reach < 40; reach += 0.25) {
      const half = portraitHalfExtent(reach);
      expect(half).toBeGreaterThanOrEqual(previous);
      previous = half;
    }
  });

  it('answers the floor for a number that is not a radius', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(portraitHalfExtent(bad)).toBe(portraitHalfExtent(0));
    }
  });
});

describe('where it looks', () => {
  it('is the middle of the drawn creature when it carries nothing', () => {
    // Feet at 0, stalk at `CHARACTER_HEIGHT`: the middle of that.
    expect(portraitCentreY(boundsFor(0))).toBeCloseTo(3.5 / 2, 10);
  });

  it('is the middle of the MASS once there is a pile, not the creature’s', () => {
    /*
     * > User direction, 2026-09-17, with a crop of the live inset showing the
     * > mass low-left in the circle: *"the 3d representation of the character
     * > and mass should be vertically and horizontally centred in the
     * > circle."*
     *
     * A pile packed to ONE SIDE and up over the creature's head: its bounds
     * run from the feet to the top of the pile, and the middle of that is
     * well above the creature's own middle.
     */
    const sideways = { height: 3.5, radius: 0.95, floor: 0, ceiling: 9, footprint: 6 };
    expect(portraitCentreY(sideways)).toBeCloseTo(4.5, 10);
    // …and one hanging below the feet drops the centre toward them.
    const under = { height: 3.5, radius: 0.95, floor: -2, ceiling: 3.5, footprint: 2 };
    expect(portraitCentreY(under)).toBeCloseTo(0.75, 10);
  });

  it('frames the whole of those bounds, and everything stays inside', () => {
    for (const bounds of [
      boundsFor(0),
      boundsFor(1),
      boundsFor(4.6),
      boundsFor(7.125),
      { height: 3.5, radius: 0.95, floor: 0, ceiling: 9, footprint: 6 },
      { height: 3.5, radius: 0.95, floor: -2, ceiling: 14, footprint: 3 },
    ]) {
      const half = portraitBoundsHalf(bounds);
      const centre = portraitCentreY(bounds);
      const low = Math.min(0, bounds.floor);
      const high = Math.max(bounds.height, bounds.ceiling);
      // Vertically: both ends of the mass are inside the frustum.
      expect(centre - low).toBeLessThanOrEqual(half + 1e-9);
      expect(high - centre).toBeLessThanOrEqual(half + 1e-9);
      // Horizontally: the far side of a sideways pile is inside it too.
      expect(bounds.footprint).toBeLessThanOrEqual(half + 1e-9);
      // And it never drops under the floor that frames a bare creature.
      expect(half).toBeGreaterThanOrEqual(portraitHalfExtent(0) - 1e-9);
    }
  });
});

/**
 * A subject's bounds for a pile that reaches `reach` in every direction about
 * the creature's middle — the shape the old single-radius tests described,
 * written out once so the pass tests read as they did.
 */
function boundsFor(reach: number, radius = 0.95, height = 3.5) {
  return reach > 0
    ? { height, radius, floor: -(reach - radius), ceiling: reach + radius, footprint: reach }
    : { height, radius, floor: 0, ceiling: 0, footprint: 0 };
}

/** Everything the pass touches on a renderer, recorded. */
function stubRenderer() {
  const calls: string[] = [];
  const viewport: number[][] = [];
  const scissor: number[][] = [];
  const rendered: { root: Object3D; left: number; right: number; top: number }[] = [];
  const clearColors: string[] = [];
  let scissorTest: boolean | null = null;
  const renderer = {
    autoClear: true,
    domElement: { clientWidth: 390, clientHeight: 844 },
    getClearAlpha: () => 1,
    getClearColor: (target: Color): Color => target.set('#ffffff'),
    setClearColor: (color: Color | string): void => {
      calls.push('setClearColor');
      clearColors.push(new Color(color as Color).getHexString());
    },
    setRenderTarget: (): void => {
      calls.push('setRenderTarget');
    },
    setViewport: (x: number, y: number, w: number, h: number): void => {
      calls.push('setViewport');
      viewport.push([x, y, w, h]);
    },
    setScissor: (x: number, y: number, w: number, h: number): void => {
      calls.push('setScissor');
      scissor.push([x, y, w, h]);
    },
    setScissorTest: (on: boolean): void => {
      calls.push(`setScissorTest:${on}`);
      scissorTest = on;
    },
    clear: (): void => {
      calls.push('clear');
    },
    render: (root: Object3D, camera: { left: number; right: number; top: number }): void => {
      calls.push('render');
      rendered.push({ root, left: camera.left, right: camera.right, top: camera.top });
    },
  };
  return {
    renderer,
    calls,
    viewport,
    scissor,
    rendered,
    clearColors,
    scissorTest: () => scissorTest,
  };
}

/** A creature rig: a root with a ball mesh under it, like the real one. */
function rig(y = 0): Group {
  const root = new Group();
  root.name = 'creature test';
  root.position.set(4, y, -3);
  const ball = new Mesh();
  ball.name = 'ball';
  root.add(ball);
  root.updateMatrixWorld(true);
  return root;
}

const PAPER = '#f2ede1';

describe('the pass draws one subtree into one rect', () => {
  it('does nothing at all with no source, no subject or no rect', () => {
    const stub = stubRenderer();
    const pass = createPortraitPass({ renderer: stub.renderer as never, paper: PAPER });
    pass.render(16);
    expect(stub.calls).toEqual([]);

    pass.setSource({ subject: () => null, rect: () => ({ x: 0, y: 0, w: 99, h: 99 }) });
    pass.render(16);
    expect(stub.calls).toEqual([]);

    const root = rig();
    pass.setSource({ subject: () => ({ root, bounds: boundsFor(3) }), rect: () => null });
    pass.render(16);
    expect(stub.calls).toEqual([]);
    pass.dispose();
  });

  it('scissors itself to the rect, in GL’s own y', () => {
    const stub = stubRenderer();
    const pass = createPortraitPass({ renderer: stub.renderer as never, paper: PAPER });
    const root = rig();
    const rect = { x: 15.6, y: 15.6, w: 99, h: 99 };
    pass.setSource({ subject: () => ({ root, bounds: boundsFor(7.125) }), rect: () => rect });
    pass.render(16);
    // The rect is measured from the TOP of the page and GL counts from the
    // bottom: 844 − (15.6 + 99).
    const want = [rect.x, 844 - (rect.y + rect.h), rect.w, rect.h];
    expect(stub.scissor).toEqual([want]);
    expect(stub.viewport[0]).toEqual(want);
    expect(stub.scissorTest()).toBe(false);
    // …and the order: scissor on, clear the DEPTH, paper, subject, scissor off.
    expect(stub.calls).toEqual([
      'setRenderTarget',
      'setViewport',
      'setScissor',
      'setScissorTest:true',
      'clear',
      'render',
      'render',
      'setScissorTest:false',
      'setViewport',
      'setClearColor',
    ]);
    /*
     * THE COLOUR IS NEVER CLEARED. A scissor is a rectangle, and clearing it
     * to the paper painted a light SQUARE behind a circular mark — a filled
     * panel (TASTE §4). The paper is the first of the two renders instead: a
     * screen-facing disc whose rim is the frustum's edge, so it lands on the
     * ring the DOM draws and the world shows outside it.
     */
    expect(stub.clearColors).toEqual(['ffffff']);
    const disc = stub.rendered[0]!.root as Mesh;
    expect(disc.name).toBe('portrait paper');
    expect((disc.material as unknown as { color: Color }).color.getHexString()).toBe(
      new Color(PAPER).getHexString(),
    );
    // Its radius IS the half-extent, so the paper's edge is the circle's.
    expect(disc.scale.x).toBeCloseTo(pass.fit(), 9);
    pass.dispose();
  });

  it('hands the renderer back exactly as it found it', () => {
    const stub = stubRenderer();
    const pass = createPortraitPass({ renderer: stub.renderer as never, paper: PAPER });
    const root = rig();
    pass.setSource({
      subject: () => ({ root, bounds: boundsFor(3) }),
      rect: () => ({ x: 10, y: 10, w: 90, h: 90 }),
    });
    pass.render(16);
    // The full frame's own viewport is the LAST thing set, so the next
    // frame's fullscreen passes are not drawing into a corner.
    expect(stub.viewport[stub.viewport.length - 1]).toEqual([0, 0, 390, 844]);
    expect(stub.scissorTest()).toBe(false);
    expect(stub.renderer.autoClear).toBe(true);
    // And the clear colour is put back to the one it read — the only
    // `setClearColor` this pass makes at all.
    expect(stub.clearColors).toEqual(['ffffff']);
    pass.dispose();
  });

  it('renders the SUBTREE, not the scene', () => {
    const stub = stubRenderer();
    const pass = createPortraitPass({ renderer: stub.renderer as never, paper: PAPER });
    const root = rig();
    pass.setSource({
      subject: () => ({ root, bounds: boundsFor(3) }),
      rect: () => ({ x: 0, y: 0, w: 99, h: 99 }),
    });
    pass.render(16);
    // The one argument that makes this cheap: the creature's own root is the
    // scene graph the renderer walks. (The paper disc goes first, and it is
    // the only other thing this pass draws.)
    expect(stub.rendered.length).toBe(2);
    expect(stub.rendered[1]!.root).toBe(root);
    pass.dispose();
  });

  it('slides the fit onto the ball instead of cutting to it', () => {
    const stub = stubRenderer();
    const pass = createPortraitPass({ renderer: stub.renderer as never, paper: PAPER });
    const root = rig();
    let reach = 0.98;
    const subject = (): PortraitSubject => ({ root, bounds: boundsFor(reach) });
    pass.setSource({ subject, rect: () => ({ x: 0, y: 0, w: 99, h: 99 }) });
    for (let f = 0; f < 60; f++) pass.render(16);
    const walking = pass.fit();
    expect(walking).toBeCloseTo(portraitHalfExtent(0.98), 3);

    // Fifteen props at once — the growth is a step, and the view must not be.
    reach = 7.125;
    pass.render(16);
    expect(pass.fit()).toBeLessThan(portraitHalfExtent(7.125));
    expect(pass.fit()).toBeGreaterThan(walking);
    let previous = pass.fit();
    let frames = 0;
    // ζ ≥ 1: monotone toward the target and never past it.
    while (frames < 400) {
      pass.render(16);
      const fit = pass.fit();
      expect(fit).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(fit).toBeLessThanOrEqual(portraitHalfExtent(7.125) + 1e-9);
      previous = fit;
      frames++;
    }
    // Settled, over about `MOTION.primaryMs` (400 frames at 16ms is deep in
    // the tail of a 1823ms settle).
    expect(400 * 16).toBeGreaterThan(MOTION.primaryMs);
    expect(previous).toBeCloseTo(portraitHalfExtent(7.125), 3);
    // The frustum the renderer was actually handed is that fit, square.
    const last = stub.rendered[stub.rendered.length - 1]!;
    expect(last.top).toBeCloseTo(previous, 9);
    expect(last.right).toBeCloseTo(previous, 9);
    expect(last.left).toBeCloseTo(-previous, 9);
    pass.dispose();
  });
});
