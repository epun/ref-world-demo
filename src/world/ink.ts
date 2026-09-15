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
 * stays the final paper layer). Ink-exempt overlay marks (OVERLAY_LAYER —
 * speech bubbles, whose emoji keep native color per the TASTE §6 carve-out)
 * are skipped by both scene renders and drawn once on top of the composite,
 * so the quantize/exposure/weather chain never touches them.
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
import { OVERLAY_LAYER } from './layers';
import { KEY_DIRECTION } from './lighting';

/**
 * Per-frame environment drive (src/world/environment.ts). All values arrive
 * pre-glided through ζ≥1 springs — the pass just forwards them as uniforms.
 */
export interface InkEnvironment {
  /** Pre-quantize exposure multiplier: night ~0.55 → day 1.0. Applied
   * before the toon quantize so night frames sit in the darker bands —
   * still band-quantized, never smooth. */
  exposure: number;
  /** Depth-banded paper wash toward the light token, 0–1. */
  fogAmt: number;
  /** Rain streak coverage, 0–1: sparse diagonal ink hairlines. */
  rainAmt: number;
  /** Snow fleck coverage, 0–1: sparse light dots with lateral sway. */
  snowAmt: number;
  /** Multiplier on hatch strength (overcast light flattens hatching). */
  hatchMul: number;
}

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
  // 0.0009 produced spurious edge clipping at grazing view angles once the
  // camera could orbit freely (user report); 0.004 keeps silhouettes inked
  // without the depth-noise artifacts.
  edgeThreshold: 0.004,
  lineWidth: 2.1,
  // 3.0 detached lines visibly from small silhouettes (user report);
  // 1.6 keeps the pen roughness with the line still riding the mesh.
  wobble: 1.6,
  hatchStrength: 0.15,
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
uniform float uHatchPeriod;
uniform vec3 uInk;
uniform vec3 uLightDir;
uniform float uAnchors[6];
uniform float uExposure;
uniform float uHatchMul;
uniform float uFogAmt;
uniform float uRainAmt;
uniform float uSnowAmt;
uniform vec3 uLight;
uniform float uEnvTime;

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
  // Exposure runs BEFORE the quantize: at night the whole frame slides into
  // the darker anchors — the result is still flat cel bands, never smooth.
  vec3 col = texture2D(uScene, vUv).rgb * uExposure;
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
    float coord1 = (sp.x * 0.5 + sp.y + wob.x * 2.0 + jit) / uHatchPeriod;
    float line1 = 1.0 - smoothstep(0.18, 0.34, abs(fract(coord1) - 0.5));
    float coord2 = (sp.x - sp.y * 0.5 + wob.y * 2.0 + jit) / uHatchPeriod;
    float line2 = 1.0 - smoothstep(0.16, 0.3, abs(fract(coord2) - 0.5));
    float band1 = 1.0 - smoothstep(0.12, 0.3, ndl);
    float band2 = 1.0 - smoothstep(-0.2, -0.02, ndl);
    float hatch = clamp(line1 * band1 + line2 * band2, 0.0, 1.0);
    // Near-black exemption (QA audit D7, mirrors the grain rule TASTE §2.7):
    // the character is one solid mass — where the beauty luma sits in the
    // near-black band the hatch contribution fades to nothing, so full-field
    // night hatching never breaks the silhouette into stripes.
    float solidMass = smoothstep(0.05, 0.14, l);
    col = mix(col, uInk, hatch * uHatchStrength * uHatchMul * solidMass);

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
    // The normal target renders with an override material that skips the
    // character's deform/gait vertex stage, so its edges sit at the
    // UNDEFORMED pose and drift off a walking body (user-visible offset).
    // Depth comes from the beauty render and is always correct — so near
    // the dark character mass, depth edges own the line and the stale
    // normal edges are suppressed.
    float mn = min(
      min(luma(texture2D(uScene, wuv - ox).rgb), luma(texture2D(uScene, wuv + ox).rgb)),
      min(luma(texture2D(uScene, wuv - oy).rgb), luma(texture2D(uScene, wuv + oy).rgb)));
    float nearDark = 1.0 - smoothstep(0.09, 0.22, mn);
    float edge = smoothstep(uEdgeThreshold, uEdgeThreshold * 2.2, dEdge);
    edge = max(edge, smoothstep(0.45, 0.85, nEdge) * 0.9 * (1.0 - nearDark));
    // Ink flow varies along the line — occasionally thin, never uniform.
    float flow = 0.55 + 0.45 * smoothstep(0.25, 0.6, fbm(sp * 0.013 + 131.0));
    col = mix(col, uInk, clamp(edge * flow, 0.0, 1.0));
  }

  // ── fog: a paper wash keyed to linear ortho depth, cut into 2–3 flat
  // bands so it reads as drawn layers, never a smooth atmosphere. Band
  // boundaries wobble with the pen noise. The sky (depth 1) washes fully.
  if (uFogAmt > 0.001) {
    float fogT = clamp((depth - 0.20) / 0.12, 0.0, 1.0);
    float fogBand = clamp(floor(fogT * 3.0 + 0.5 + (n1 - 0.5) * 0.9), 0.0, 3.0) / 3.0;
    // The wash target is the light token under the frame's exposure, so
    // night fog washes toward dimmed paper instead of fighting the dark.
    col = mix(col, uLight * uExposure, fogBand * uFogAmt * 0.85);
  }

  // ── rain: sparse short diagonal ink hairlines drifting down the page at
  // a measured pace — an ambient drizzle of pen marks, never a spray.
  if (uRainAmt > 0.001) {
    vec2 rd = normalize(vec2(0.20, -1.0));
    float across = dot(sp, vec2(-rd.y, rd.x)) + (n1 - 0.5) * 7.0;
    float along = dot(sp, rd);
    float lane = floor(across / 64.0);
    float h = hash(vec2(lane, 3.7));
    if (h < uRainAmt * 0.85) {
      float speed = 80.0 + 70.0 * hash(vec2(lane, 9.1));
      float cycle = 420.0 + 360.0 * hash(vec2(lane, 5.3));
      float head = fract((along - uEnvTime * speed) / cycle + h * 7.31);
      float lat = abs(fract(across / 64.0) - 0.5);
      float hair = 1.0 - smoothstep(0.012, 0.026, lat);
      float seg = 1.0 - smoothstep(30.0 / cycle, 40.0 / cycle, head);
      col = mix(col, uInk, hair * seg * 0.7);
    }
  }

  // ── snow: sparse light flecks drifting slowly downward with a lateral
  // noise sway — same restraint, dots of the light token on the frame.
  if (uSnowAmt > 0.001) {
    vec2 q = vec2(sp.x + (n2 - 0.5) * 10.0, sp.y + uEnvTime * 24.0);
    vec2 id = floor(q / 72.0);
    float hs = hash(id);
    if (hs < uSnowAmt * 0.8) {
      vec2 jit = vec2(hash(id + 11.0), hash(id + 29.0));
      vec2 c = (id + 0.15 + 0.7 * jit) * 72.0;
      c.x += sin(uEnvTime * (0.4 + 0.5 * hs) + hs * 6.28) * 8.0;
      float d = distance(q, c);
      float fleck = 1.0 - smoothstep(1.1, 2.1, d);
      col = mix(col, uLight, fleck * 0.9);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/** [D] Base hatch stroke period in device pixels (landed by screenshot
 * iteration — the day look at DPR 1). */
const HATCH_PERIOD_PX = 7;

/** [D] Screen-space floor between hatch strokes, in CSS pixels (QA audit
 * D7): under ~4px the diagonal strokes interfere with the pixel grid and
 * alias into corduroy moiré at DPR 2. */
const HATCH_MIN_SPACING_PX = 4;

/** Stroke-normal length of the (0.5, 1) hatch direction — converts a period
 * along the coordinate axis into perpendicular line spacing. */
const HATCH_DIAGONAL = Math.hypot(0.5, 1);

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
  /** World-space key direction; environment.ts retargets it per frame as the
   * sun arcs. Defaults to the calibrated constant. */
  private readonly keyDirection = KEY_DIRECTION.clone();
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
        uHatchPeriod: { value: HATCH_PERIOD_PX },
        uInk: { value: linearColor(WORLD.ink) },
        uLightDir: { value: this.lightView },
        uAnchors: { value: ANCHORS },
        uExposure: { value: 1 },
        uHatchMul: { value: 1 },
        uFogAmt: { value: 0 },
        uRainAmt: { value: 0 },
        uSnowAmt: { value: 0 },
        uLight: { value: linearColor(WORLD.light) },
        uEnvTime: { value: 0 },
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
    // Hatch frequency limit (QA audit D7): hold the perpendicular stroke
    // spacing at >= HATCH_MIN_SPACING_PX CSS pixels regardless of DPR, and
    // quantize the period to whole device pixels so the stroke lattice never
    // sits in an interference band with the pixel grid. At DPR 1 this is
    // exactly the calibrated HATCH_PERIOD_PX; at DPR 2 it widens to 9.
    const period = Math.max(
      HATCH_PERIOD_PX,
      Math.ceil(HATCH_MIN_SPACING_PX * pixelRatio * HATCH_DIAGONAL),
    );
    this.material.uniforms.uHatchPeriod!.value = period;
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

  /** Point the hatch/shading key. Called per frame by the environment engine
   * so the hatch threshold follows the sun. */
  setKeyDirection(direction: Vector3): void {
    this.keyDirection.copy(direction);
  }

  /** Push the frame's environment drive (already spring-glided upstream). */
  setEnvironment(env: InkEnvironment): void {
    const u = this.material.uniforms;
    u.uExposure!.value = env.exposure;
    u.uHatchMul!.value = env.hatchMul;
    u.uFogAmt!.value = env.fogAmt;
    u.uRainAmt!.value = env.rainAmt;
    u.uSnowAmt!.value = env.snowAmt;
  }

  /**
   * Render the scene through the ink chain. Returns the composited texture
   * (linear) for the grain pass to compose to screen.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, nowMs: number): Texture {
    // Slow shared drift — the same pacing as the grain's paper slide.
    const t = (nowMs % (MOTION.ambientMs * 4096)) / MOTION.ambientMs;
    this.material.uniforms.uTime!.value = t * 0.05;
    // Streak clock in seconds — slow, measured drift for rain/snow. Wrapped
    // on the same long period as the other clocks so precision holds.
    this.material.uniforms.uEnvTime!.value = (nowMs % (MOTION.ambientMs * 4096)) / 1000;
    // Key direction into view space (the normal target is view-space).
    this.lightView.copy(this.keyDirection).transformDirection(camera.matrixWorldInverse);

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

    // ── overlay pass: ink-exempt marks over the composite ────────────────
    // Objects living only on OVERLAY_LAYER (the speech bubbles — emoji keep
    // native color, TASTE §6 carve-out) were invisible to the beauty and
    // normal renders above, so the quantize/exposure/fog chain never touched
    // them. Draw them once here, straight onto the composed frame: true
    // color at any time of day or weather. The grain pass still composes
    // over this, so the full-frame paper layer stays uniform (TASTE §2.7).
    const prevMask = camera.layers.mask;
    const prevAutoClear = renderer.autoClear;
    const bg = scene.background;
    camera.layers.set(OVERLAY_LAYER);
    renderer.autoClear = false;
    scene.background = null;
    renderer.render(scene, camera);
    scene.background = bg;
    renderer.autoClear = prevAutoClear;
    camera.layers.mask = prevMask;

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
