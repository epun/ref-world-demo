/**
 * Flat stamped contact shadows (TASTE §2.4).
 *
 * Shadow as a graphic shape: a single hard-edged value — solid SURFACE.shadow
 * — cut sharp against the ground. No gradient, no blur, no opacity falloff,
 * no penumbra. Each registered entity gets one stamp sitting just above y=0,
 * polygon-offset and render-ordered so it never z-fights the ground.
 */

import { CircleGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { SURFACE } from '../taste/tokens';

/** Just proud of the ground plane. */
const SHADOW_LIFT = 0.02;
const SHADOW_SEGMENTS = 64;

export interface ShadowHandle {
  /** Move the stamp on the ground plane. Y is owned by the pass. */
  setPosition(x: number, z: number): void;
}

export class FlatShadows {
  /** Add this group to the scene once; stamps live inside it. */
  readonly group = new Group();

  private readonly stamps = new Map<string, Mesh>();

  // One shared material: every shadow is the same single value by
  // construction. MeshBasicMaterial — a shadow must not be lit.
  private readonly material = new MeshBasicMaterial({
    color: SURFACE.shadow,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  addShadow(id: string, radius: number): ShadowHandle {
    this.removeShadow(id);
    const geometry = new CircleGeometry(radius, SHADOW_SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    const stamp = new Mesh(geometry, this.material);
    stamp.position.y = SHADOW_LIFT;
    stamp.renderOrder = 1;
    this.group.add(stamp);
    this.stamps.set(id, stamp);
    return {
      setPosition: (x: number, z: number): void => {
        stamp.position.set(x, SHADOW_LIFT, z);
      },
    };
  }

  removeShadow(id: string): void {
    const stamp = this.stamps.get(id);
    if (!stamp) return;
    this.group.remove(stamp);
    stamp.geometry.dispose();
    this.stamps.delete(id);
  }
}
