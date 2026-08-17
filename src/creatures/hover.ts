/**
 * Hover names (user ask): pointing at a creature in the world view shows the
 * name entered on the draw page. One restrained lowercase line in ink — the
 * taste's sparse-type allowance — fading on the tertiary token, never
 * popping. Creatures without a name show nothing.
 */

import { Raycaster, Vector2 } from 'three';
import type { Camera, Object3D } from 'three';
import { MOTION, WORLD } from '../taste/tokens';
import type { CreatureManager } from './manager';

const STYLE_ID = 'hover-name-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.hover-name {
  position: fixed;
  z-index: 6;
  color: ${WORLD.ink};
  font: 400 13px/1.2 ui-sans-serif, system-ui, sans-serif;
  opacity: 0;
  transform: translate(-50%, 6px);
  transition:
    opacity ${MOTION.tertiaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.tertiaryMs}ms ${MOTION.settleCurve};
  pointer-events: none;
  white-space: nowrap;
}
.hover-name.visible {
  opacity: 0.9;
  transform: translate(-50%, 0);
}
`;
  document.head.appendChild(style);
}

export interface HoverNames {
  dispose(): void;
}

export function installHoverNames(
  canvas: HTMLCanvasElement,
  camera: Camera,
  manager: CreatureManager,
): HoverNames {
  ensureStyle();
  const label = document.createElement('div');
  label.className = 'hover-name';
  document.body.appendChild(label);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pending = false;
  let lastX = 0;
  let lastY = 0;
  let buttonsDown = false;

  function check(): void {
    pending = false;
    if (buttonsDown) {
      // Dragging the view — the label would fight the pan; keep it away.
      label.classList.remove('visible');
      return;
    }
    const targets = manager.hoverTargets();
    if (targets.length === 0) {
      label.classList.remove('visible');
      return;
    }
    pointer.set((lastX / window.innerWidth) * 2 - 1, -(lastY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    let hitName: string | null = null;
    for (const target of targets) {
      const hits = raycaster.intersectObject(target.object as Object3D, true);
      if (hits.length > 0) {
        hitName = target.name;
        break;
      }
    }
    if (hitName) {
      label.textContent = hitName;
      label.style.left = `${lastX}px`;
      label.style.top = `${lastY - 26}px`;
      label.classList.add('visible');
    } else {
      label.classList.remove('visible');
    }
  }

  const onMove = (event: PointerEvent): void => {
    lastX = event.clientX;
    lastY = event.clientY;
    buttonsDown = event.buttons !== 0;
    if (!pending) {
      pending = true;
      requestAnimationFrame(check);
    }
  };
  const onLeave = (): void => {
    label.classList.remove('visible');
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  return {
    dispose(): void {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      label.remove();
    },
  };
}
