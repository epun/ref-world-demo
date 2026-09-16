/**
 * How many full-screen passes the ink chain actually runs, and what it hides
 * for the normal one (src/world/ink.ts).
 *
 * Both are performance seams with a look contract attached, so they are
 * pinned rather than trusted:
 *
 *  - the OVERLAY pass is skipped on a frame with nothing on
 *    `OVERLAY_LAYER`. It draws the speech bubbles, which detach themselves
 *    when they hide, so almost every frame in a room was paying a
 *    full-screen render's worth of traversal and submission to draw nothing.
 *    With `autoClear` off and no background, a pass with nothing in it
 *    writes nothing — so skipping it is the same picture.
 *  - `setNormalPassSkip` is the phone tier's way of drawing the katamari
 *    library ONCE a frame instead of twice (src/world/scene.ts). It has to
 *    hide exactly what it was given, for exactly that one pass, and put it
 *    back — a prop left invisible after the pass is a prop that has left the
 *    world.
 *
 * The renderer is a stub: this is about the ORDER and the COUNT of renders
 * and the visibility either side of them, none of which needs a GL context.
 */

import { describe, expect, it } from 'vitest';
import { Group, Mesh, OrthographicCamera, Scene } from 'three';
import type { Camera, WebGLRenderer } from 'three';
import { InkPass } from '../../src/world/ink';
import { OVERLAY_LAYER } from '../../src/world/layers';

/** One recorded render: which scene, and what was visible in it. */
interface Shot {
  overrideMaterial: boolean;
  /** Names of the visible meshes in the rendered scene, sorted. */
  visible: string[];
  /** The camera's layer mask at the moment of the render. */
  layerMask: number;
}

function stubRenderer(): { renderer: WebGLRenderer; shots: Shot[] } {
  const shots: Shot[] = [];
  const renderer = {
    autoClear: true,
    setRenderTarget(): void {},
    getDrawingBufferSize(target: { x: number; y: number }): { x: number; y: number } {
      target.x = 8;
      target.y = 8;
      return target;
    },
    render(scene: Scene, camera: Camera): void {
      const visible: string[] = [];
      // As three's own renderer decides it: a mesh under a hidden ancestor is
      // not drawn either.
      const shown = (object: { visible: boolean; parent: unknown }): boolean => {
        let node: { visible: boolean; parent: unknown } | null = object;
        while (node) {
          if (!node.visible) return false;
          node = node.parent as { visible: boolean; parent: unknown } | null;
        }
        return true;
      };
      scene.traverse?.((object) => {
        if ((object as { isMesh?: boolean }).isMesh === true && shown(object)) {
          visible.push(object.name);
        }
      });
      shots.push({
        overrideMaterial: scene.overrideMaterial !== null,
        visible: visible.sort(),
        layerMask: camera.layers.mask,
      });
    },
  } as unknown as WebGLRenderer;
  return { renderer, shots };
}

function world(): { scene: Scene; camera: Camera; prop: Mesh; bubble: Mesh; ground: Mesh } {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const ground = new Mesh();
  ground.name = 'ground';
  const propGroup = new Group();
  const prop = new Mesh();
  prop.name = 'prop';
  propGroup.add(prop);
  const bubble = new Mesh();
  bubble.name = 'bubble';
  bubble.layers.set(OVERLAY_LAYER);
  bubble.visible = false;
  scene.add(ground, propGroup, bubble);
  return { scene, camera, prop, bubble, ground };
}

describe('the ink chain’s passes', () => {
  it('runs three scene renders with nothing on the overlay layer', () => {
    const ink = new InkPass();
    const { renderer, shots } = stubRenderer();
    const { scene, camera } = world();
    ink.render(renderer, scene, camera, 0);
    // beauty, normal, composite — and no fourth for an empty overlay.
    expect(shots.length).toBe(3);
    expect(shots[1]!.overrideMaterial).toBe(true);
    ink.dispose();
  });

  it('runs the overlay pass on a frame where a bubble is showing', () => {
    const ink = new InkPass();
    const { renderer, shots } = stubRenderer();
    const { scene, camera, bubble } = world();
    bubble.visible = true;
    ink.render(renderer, scene, camera, 0);
    expect(shots.length).toBe(4);
    // The last one is the overlay layer alone, and it is the only pass that
    // sees the bubble.
    expect(shots[3]!.layerMask).toBe(1 << OVERLAY_LAYER);
    // …and the camera's mask is put back.
    expect(camera.layers.mask).toBe(shots[0]!.layerMask);
    ink.dispose();
  });

  it('hides the registered subtree for the normal pass alone, and restores it', () => {
    const ink = new InkPass();
    const { renderer, shots } = stubRenderer();
    const { scene, camera, prop } = world();
    const propGroup = prop.parent!;
    ink.setNormalPassSkip([propGroup]);
    ink.render(renderer, scene, camera, 0);
    // beauty sees the prop, the normal pass does not, the composite is a quad.
    expect(shots[0]!.visible).toContain('prop');
    expect(shots[1]!.visible).not.toContain('prop');
    expect(shots[1]!.visible).toContain('ground');
    // Back in the world the moment the pass is over.
    expect(propGroup.visible).toBe(true);
    ink.dispose();
  });

  it('skips nothing by default — the projection draws both passes whole', () => {
    const ink = new InkPass();
    const { renderer, shots } = stubRenderer();
    const { scene, camera } = world();
    ink.render(renderer, scene, camera, 0);
    expect(shots[1]!.visible).toContain('prop');
    ink.dispose();
  });

  it('leaves an already-hidden subtree hidden, and does not resurrect it', () => {
    const ink = new InkPass();
    const { renderer, shots } = stubRenderer();
    const { scene, camera, prop } = world();
    const propGroup = prop.parent!;
    propGroup.visible = false;
    ink.setNormalPassSkip([propGroup]);
    ink.render(renderer, scene, camera, 0);
    expect(shots[0]!.visible).not.toContain('prop');
    expect(shots[1]!.visible).not.toContain('prop');
    expect(propGroup.visible).toBe(false);
    ink.dispose();
  });

  it('still hides what carries the ghibliNormalPassSkip flag', () => {
    const ink = new InkPass();
    const { renderer, shots } = stubRenderer();
    const { scene, camera } = world();
    const blades = new Mesh();
    blades.name = 'blades';
    blades.userData.ghibliNormalPassSkip = true;
    scene.add(blades);
    ink.render(renderer, scene, camera, 0);
    expect(shots[0]!.visible).toContain('blades');
    expect(shots[1]!.visible).not.toContain('blades');
    expect(blades.visible).toBe(true);
    ink.dispose();
  });
});
