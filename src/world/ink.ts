/**
 * Ink pass (GENERATOR §ink rendering pass — reference-locked).
 *
 * The frame must read as a hand-drawn cel illustration that happens to be
 * 3D: light paper-filled forms carried by rough wobbly ink contours, flat
 * toon value bands instead of smooth shading, hatching on faces turned away
 * from the key, the character the only solid black mass.
 *
 * Route chosen: two scene renders per frame —
 *   1. beauty → color target with an attached DepthTexture (r180 supports
 *      depth textures on WebGLRenderTarget directly), and
 *   2. scene.overrideMaterial = MeshNormalMaterial → normal target —
 * then one fullscreen composite that does, in order:
 *   toon quantize → hatch → wobbled edge lines,
 * writing into an output target the grain pass composes to screen (grain
 * stays the final paper layer).
 *
 * Toon quantization: scene luma snaps to the nearest of the six measured
 * palette lumas (linear), so every surface collapses into flat cel bands
 * that ARE the corpus greys — the ground stays on its token, props read
 * paper-light, the character bottoms out near black. Band boundaries are
 * dithered by the wobble noise so even they look drawn.
 *
 * Roughness of line: edge-sample positions ride 3-octave value noise tied
 * to screen position plus a very slow time drift (same ambient pacing as
 * the grain), and line width varies along the line with the same field —
 * a pen line, never a clean postprocess contour.
 *
 * Known simplification: the normal target renders with an override
 * material, so the character's vertex-shader deform is absent there. At
 * rest the deform is identity; during emotes the depth-based edges (from
 * the true beauty render) still carry the silhouette, and interior normal
 * edges are invisible on a near-black body.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DepthTexture,
  FloatType,
  Mesh,
  MeshNormalMaterial,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { Camera, Texture, WebGLRenderer } from 'three';
import { CHARACTER, MOTION, SURFACE, WORLD } from '../taste/tokens';
import { KEY_DIRECTION } from './lighting';

export interface InkParams {
  /** Depth discontinuity (0–1 ortho depth) that starts a contour line. */
  edgeThreshold: number;
  /** Line width in device pixels (varies ±30% along the line). */
  lineWidth: number;
  /** Pen wobble amplitude in device pixels. */
  wobble: number;
  /** Hatch overlay opacity, 0–1. */
  hatchStrength: number;
}

/** [D] Landed by screenshot iteration against the reference read. */
const DEFAULTS: InkParams = {
  edgeThreshold: 0.0009,
  lineWidth: 2.1,
  wobble: 3.0,
  hatchStrength: 0.7,
};

/** Linear-space luma of an srgb token — the cel band anchors. Color
 * management already converts hex (srgb) into the linear working space on
 * construction; converting again would double-apply the transfer curve. */
function linearLuma(hex: string): number {
  const c = new Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function linearColor(hex: string): Color {
  return new Color(hex);
}

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
uniform sampler2D uDepth;
uniform sampler2D uNormal;
uniform vec2 uResolution;
uniform float uTime;
uniform float uEdgeThreshold;
uniform float uLineWidth;
uniform float uWobble;
uniform float uHatchStrength;
uniform vec3 uInk;
uniform vec3 uLightDir;
uniform float uAnchors[6];

varying vec2 vUv;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 3 octaves — low-frequency, so lines wobble like a pen, not like static.
float fbm(vec2 p) {
  float v = 0.0;
  v += 0.5 * vnoise(p);
  v += 0.25 * vnoise(p * 2.03 + 17.1);
  v += 0.125 * vnoise(p * 4.01 + 47.7);
  return v / 0.875;
}

float readDepth(vec2 uv) {
  return texture2D(uDepth, uv).x;
}

vec3 readNormal(vec2 uv) {
  return normalize(texture2D(uNormal, uv).xyz * 2.0 - 1.0);
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 px = 1.0 / uResolution;
  vec2 sp = gl_FragCoord.xy;
  vec3 col = texture2D(uScene, vUv).rgb;
  float depth = readDepth(vUv);

  // Pen-wobble field: two decorrelated low-frequency channels, world-stable
  // (screen position + a very slow drift shared with the grain's pacing).
  float n1 = fbm(sp * 0.017 + uTime);
  float n2 = fbm(sp * 0.017 + vec2(39.7, 71.3) - uTime);
  vec2 wob = (vec2(n1, n2) - 0.5) * uWobble;

  // ── toon quantize: snap to the nearest palette luma (cel bands) ──────────
  float l = luma(col);
  float dith = (fbm(sp * 0.045 + 11.3) - 0.5) * 0.045;
  float lq = l + dith;
  float band = uAnchors[0];
  float bestD = abs(lq - band);
  for (int i = 1; i < 6; i++) {
    float d = abs(lq - uAnchors[i]);
    if (d < bestD) { bestD = d; band = uAnchors[i]; }
  }
  col *= band / max(l, 1e-4);

  if (depth < 0.9999) {
    // ── hatching: faces turned from the key read as parallel ink strokes ──
    // Two stepped density bands (like the reference's cliff sides), stroke
    // coordinates jittered by the same noise so nothing reads ruled.
    vec3 nrm = readNormal(vUv);
    float ndl = dot(nrm, uLightDir);
    float jit = (fbm(sp * 0.05 + 91.7) - 0.5) * 5.0;
    float coord1 = (sp.x * 0.5 + sp.y + wob.x * 2.0 + jit) / 7.0;
    float line1 = 1.0 - smoothstep(0.18, 0.34, abs(fract(coord1) - 0.5));
    float coord2 = (sp.x - sp.y * 0.5 + wob.y * 2.0 + jit) / 7.0;
    float line2 = 1.0 - smoothstep(0.16, 0.3, abs(fract(coord2) - 0.5));
    float band1 = 1.0 - smoothstep(0.12, 0.3, ndl);
    float band2 = 1.0 - smoothstep(-0.2, -0.02, ndl);
    float hatch = clamp(line1 * band1 + line2 * band2, 0.0, 1.0);
    col = mix(col, uInk, hatch * uHatchStrength);

    // ── rough contour lines over depth + normal discontinuities ──────────
    float wWidth = uLineWidth * (0.7 + 0.6 * fbm(sp * 0.021 + 5.1));
    vec2 wuv = vUv + wob * px;
    vec2 ox = vec2(px.x, 0.0) * wWidth;
    vec2 oy = vec2(0.0, px.y) * wWidth;
    float dl = readDepth(wuv - ox);
    float dr = readDepth(wuv + ox);
    float db = readDepth(wuv - oy);
    float dt = readDepth(wuv + oy);
    float dEdge = max(abs(dl - dr), abs(db - dt));
    vec3 nl = readNormal(wuv - ox);
    vec3 nr = readNormal(wuv + ox);
    vec3 nb = readNormal(wuv - oy);
    vec3 nt = readNormal(wuv + oy);
    float nEdge = max(1.0 - dot(nl, nr), 1.0 - dot(nb, nt));
    float edge = smoothstep(uEdgeThreshold, uEdgeThreshold * 2.2, dEdge);
    edge = max(edge, smoothstep(0.45, 0.85, nEdge) * 0.9);
    // Ink flow varies along the line — occasionally thin, never uniform.
    float flow = 0.55 + 0.45 * smoothstep(0.25, 0.6, fbm(sp * 0.013 + 131.0));
    col = mix(col, uInk, clamp(edge * flow, 0.0, 1.0));
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/** The cel band anchors: the measured palette, as linear lumas, ascending.
 * SURFACE.shadow shares WORLD.neutral's value, so the shadow stamps sit on
 * an anchor by construction. */
const ANCHORS = [
  linearLuma(CHARACTER.body),
  linearLuma(WORLD.ink),
  linearLuma(WORLD.neutralDark),
  linearLuma(WORLD.neutral),
  linearLuma(SURFACE.ground),
  linearLuma(WORLD.light),
];

export class InkPass {
  private readonly colorTarget: WebGLRenderTarget;
  private readonly normalTarget: WebGLRenderTarget;
  private readonly outTarget: WebGLRenderTarget;
  private readonly depthTexture: DepthTexture;
  private readonly normalMaterial = new MeshNormalMaterial();
  private readonly material: ShaderMaterial;
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly resolution = new Vector2(1, 1);
  private readonly lightView = new Vector3();
  private readonly normalClear = new Color(0.5, 0.5, 1);
  private readonly params: InkParams = { ...DEFAULTS };

  constructor() {
    this.depthTexture = new DepthTexture(1, 1);
    this.depthTexture.type = FloatType;
    this.colorTarget = new WebGLRenderTarget(1, 1, { depthTexture: this.depthTexture });
    this.normalTarget = new WebGLRenderTarget(1, 1);
    this.outTarget = new WebGLRenderTarget(1, 1);

    this.material = new ShaderMaterial({
      uniforms: {
        uScene: { value: this.colorTarget.texture },
        uDepth: { value: this.depthTexture },
        uNormal: { value: this.normalTarget.texture },
        uResolution: { value: this.resolution },
        uTime: { value: 0 },
        uEdgeThreshold: { value: this.params.edgeThreshold },
        uLineWidth: { value: this.params.lineWidth },
        uWobble: { value: this.params.wobble },
        uHatchStrength: { value: this.params.hatchStrength },
        uInk: { value: linearColor(WORLD.ink) },
        uLightDir: { value: this.lightView },
        uAnchors: { value: ANCHORS },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    // Fullscreen triangle, same pattern as the grain pass.
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
    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);
    this.colorTarget.setSize(w, h);
    this.normalTarget.setSize(w, h);
    this.outTarget.setSize(w, h);
    this.resolution.set(w, h);
  }

  setParams(next: Partial<InkParams>): void {
    Object.assign(this.params, next);
    const u = this.material.uniforms;
    u.uEdgeThreshold!.value = this.params.edgeThreshold;
    u.uLineWidth!.value = this.params.lineWidth;
    u.uWobble!.value = this.params.wobble;
    u.uHatchStrength!.value = this.params.hatchStrength;
  }

  getParams(): InkParams {
    return { ...this.params };
  }

  /**
   * Render the scene through the ink chain. Returns the composited texture
   * (linear) for the grain pass to compose to screen.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, nowMs: number): Texture {
    // Slow shared drift — the same pacing as the grain's paper slide.
    const t = (nowMs % (MOTION.ambientMs * 4096)) / MOTION.ambientMs;
    this.material.uniforms.uTime!.value = t * 0.05;
    // Key direction into view space (the normal target is view-space).
    this.lightView.copy(KEY_DIRECTION).transformDirection(camera.matrixWorldInverse);

    renderer.setRenderTarget(this.colorTarget);
    renderer.render(scene, camera);

    const background = scene.background;
    scene.background = this.normalClear;
    scene.overrideMaterial = this.normalMaterial;
    renderer.setRenderTarget(this.normalTarget);
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    scene.background = background;

    renderer.setRenderTarget(this.outTarget);
    renderer.render(this.quadScene, this.quadCamera);
    renderer.setRenderTarget(null);
    return this.outTarget.texture;
  }

  dispose(): void {
    this.colorTarget.dispose();
    this.normalTarget.dispose();
    this.outTarget.dispose();
    this.normalMaterial.dispose();
    this.material.dispose();
  }
}
