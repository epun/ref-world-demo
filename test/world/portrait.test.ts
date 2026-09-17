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
 *   1. THE FIT. The orthographic half-extent is a function of `bodyR`, and it
 *      is never smaller than `bodyR` — the ball's whole diameter is inside
 *      the frame at every size a session can reach, with air to spare.
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
  portraitAimY,
  portraitHalfExtent,
  type PortraitSubject,
} from '../../src/world/portrait';
import { MOTION } from '../../src/taste/tokens';

describe('the fit is a function of the ball, and never smaller than it', () => {
  it('frames the creature itself when there is no ball', () => {
    expect(portraitHalfExtent(0)).toBeCloseTo(PORTRAIT_MIN_HALF * (1 + PORTRAIT_MARGIN), 10);
    // A hatchling's own footprint is about a unit — under the floor, so it is
    // framed by its height and not by its width (`CHARACTER_HEIGHT` is 3.5,
    // and a creature framed at its footprint would be cropped at the stalk).
    expect(portraitHalfExtent(0.98)).toBe(portraitHalfExtent(0));
  });

  it('contains the whole diameter at every size a session reaches', () => {
    // The ladder docs/PLAN.md §7.6 lists, and well past it.
    for (const bodyR of [0, 0.5, 0.98, 1.2, 1.5, 2.22, 3.06, 7.125, 12, 20, 40]) {
      const half = portraitHalfExtent(bodyR);
      // The frame's half-height covers the ball's radius…
      expect(half).toBeGreaterThanOrEqual(bodyR);
      // …with the authored air around it.
      if (bodyR > PORTRAIT_MIN_HALF) {
        expect(half / bodyR).toBeCloseTo(1 + PORTRAIT_MARGIN, 10);
      }
    }
  });

  it('only ever grows with the ball', () => {
    let previous = 0;
    for (let bodyR = 0; bodyR < 40; bodyR += 0.25) {
      const half = portraitHalfExtent(bodyR);
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
  it('is the mass’s centre once the creature is rolling', () => {
    // The root is the ball's underside and the rider sits at `bodyR · roll`
    // (docs/PLAN.md §7.6) — the same height, so the creature and the mass are
    // both in the middle of the frame.
    expect(portraitAimY(7.125, 1)).toBeCloseTo(7.125, 10);
    expect(portraitAimY(3, 1)).toBeCloseTo(3, 10);
  });

  it('is the creature’s own middle while it walks', () => {
    expect(portraitAimY(0.98, 0)).toBeCloseTo(PORTRAIT_MIN_HALF * PORTRAIT_AIM_FRACTION, 10);
    expect(portraitAimY(0, 0)).toBeCloseTo(PORTRAIT_MIN_HALF * PORTRAIT_AIM_FRACTION, 10);
  });

  it('stays inside the frame it is aiming in', () => {
    for (const bodyR of [0, 1, 3, 7.125, 20]) {
      for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
        const aim = portraitAimY(bodyR, roll);
        expect(aim).toBeGreaterThanOrEqual(0);
        // The subject spans `bodyR` about the aim, and the frame's half is at
        // least `bodyR` — so nothing the aim does can push the mass out.
        expect(aim).toBeLessThanOrEqual(portraitHalfExtent(bodyR) + 1e-9);
      }
    }
  });
});

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
    pass.setSource({ subject: () => ({ root, bodyR: 3, roll: 1 }), rect: () => null });
    pass.render(16);
    expect(stub.calls).toEqual([]);
    pass.dispose();
  });

  it('scissors itself to the rect, in GL’s own y', () => {
    const stub = stubRenderer();
    const pass = createPortraitPass({ renderer: stub.renderer as never, paper: PAPER });
    const root = rig();
    const rect = { x: 15.6, y: 15.6, w: 99, h: 99 };
    pass.setSource({ subject: () => ({ root, bodyR: 7.125, roll: 1 }), rect: () => rect });
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
      subject: () => ({ root, bodyR: 3, roll: 1 }),
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
      subject: () => ({ root, bodyR: 3, roll: 1 }),
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
    let bodyR = 0.98;
    const subject = (): PortraitSubject => ({ root, bodyR, roll: 1 });
    pass.setSource({ subject, rect: () => ({ x: 0, y: 0, w: 99, h: 99 }) });
    for (let f = 0; f < 60; f++) pass.render(16);
    const walking = pass.fit();
    expect(walking).toBeCloseTo(portraitHalfExtent(0.98), 3);

    // Fifteen props at once — the growth is a step, and the view must not be.
    bodyR = 7.125;
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
