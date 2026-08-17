/**
 * Full-frame grain pass (TASTE §2.7).
 *
 * "A steady grain sits over gloss finishes" — a defining signal, implemented
 * as a post-process so it is uniform across the whole image and never varies
 * within a character's fill. The scene renders to a target; a fullscreen
 * triangle then adds hash noise at GRAIN.amplitude after the sRGB conversion,
 * so the amplitude is perceptual.
 *
 * The grain must read as paper, not video noise: the hash pattern is fixed
 * per pixel and the whole field slides a couple of pixels per second, paced
 * by t.ambient. Nothing re-randomizes per frame.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import type { Camera, WebGLRenderer } from 'three';
import { GRAIN, MOTION } from '../taste/tokens';

const VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uScene;
uniform float uAmplitude;
uniform vec2 uDrift;

varying vec2 vUv;

// Deterministic per-pixel hash. Stable for a given lattice cell, so the
// grain field is a fixed pattern that drifts, not per-frame noise.
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  gl_FragColor = texture2D(uScene, vUv);
  #include <colorspace_fragment>
  // Signed, uniform across the frame, added after the sRGB conversion so the
  // amplitude reads evenly across the value range.
  float g = hash(floor(gl_FragCoord.xy + uDrift)) - 0.5;
  gl_FragColor.rgb += g * uAmplitude;
}
`;

/** Pixels of pattern slide per ambient period — a slow paper drift. */
const DRIFT_PER_AMBIENT = new Vector2(5.3, 3.1);

export class GrainPass {
  private readonly target: WebGLRenderTarget;
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly drift = new Vector2();
  private readonly material: ShaderMaterial;

  constructor() {
    // Multisampled so canvas antialiasing survives the indirection.
    this.target = new WebGLRenderTarget(1, 1, { samples: 4 });
    this.material = new ShaderMaterial({
      uniforms: {
        uScene: { value: this.target.texture },
        uAmplitude: { value: GRAIN.amplitude },
        uDrift: { value: this.drift },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    // Fullscreen triangle — covers the viewport with no seam.
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const quad = new Mesh(geometry, this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.target.setSize(Math.floor(width * pixelRatio), Math.floor(height * pixelRatio));
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, nowMs: number): void {
    // Wrapped so precision holds over long sessions.
    const t = (nowMs % (MOTION.ambientMs * 4096)) / MOTION.ambientMs;
    this.drift.set(t * DRIFT_PER_AMBIENT.x, t * DRIFT_PER_AMBIENT.y);

    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCamera);
  }
}
