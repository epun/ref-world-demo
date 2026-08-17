/**
 * The crack (PLAN §4) — shader work on the shell material, never a texture
 * swap. onBeforeCompile injects a fragment snippet that darkens shell pixels
 * along a procedural crack pattern: a few jagged polyline SDFs in the shell's
 * uv space, deterministic per egg seed, revealed by a single uCrack uniform
 * 0→1 that grows the crack's length and width continuously. Scrubbable via
 * setCrack — nothing pops, and Ghost Panel can drive it later (PLAN §10).
 *
 * The crack renders in WORLD.ink — the darkest the environment goes — so the
 * shell stays out of the character's near-black band (TASTE §1).
 */

import { Color } from 'three';
import type { MeshPhysicalMaterial } from 'three';
import { WORLD } from '../taste/tokens';

export interface CrackHandle {
  /** Scrub the crack: 0 pristine shell → 1 fully broken. Clamped. */
  setCrack(value: number): void;
  crackValue(): number;
}

/**
 * u spans the full circumference while v spans only pole-to-pole, so
 * distances measured in raw uv are anisotropic. Crack coordinates are
 * pre-scaled by this factor on u so the jag reads evenly on the shell.
 */
const U_SCALE = 1.5;

/** One revealed segment of a crack polyline, in pre-scaled uv space. */
export interface CrackSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** uCrack fraction at which this segment starts growing. */
  t0: number;
  /** uCrack fraction at which this segment is fully grown. */
  t1: number;
}

/** Deterministic per-egg RNG — same seed, same crack, on every device. */
function makeRng(seed: number): () => number {
  let s = (Math.floor(Math.abs(seed)) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Distribute a polyline's reveal window over its segments by arc length. */
function pushLine(
  segments: CrackSegment[],
  pts: [number, number][],
  t0: number,
  t1: number,
): void {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a === undefined || b === undefined) continue;
    const l = Math.hypot((b[0] - a[0]) * U_SCALE, b[1] - a[1]);
    lengths.push(l);
    total += l;
  }
  if (total <= 0) return;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = lengths[i - 1];
    if (a === undefined || b === undefined || l === undefined) continue;
    const s0 = t0 + ((t1 - t0) * acc) / total;
    acc += l;
    const s1 = t0 + ((t1 - t0) * acc) / total;
    segments.push({
      ax: a[0] * U_SCALE,
      ay: a[1],
      bx: b[0] * U_SCALE,
      by: b[1],
      t0: s0,
      t1: s1,
    });
  }
}

/**
 * The crack layout: one main jagged line descending the front of the shell
 * (uv u≈0.5 faces the camera once the egg group is oriented), plus two
 * shorter branches that fork off partway and reveal later. All positions
 * stay inside u∈[0.15,0.85] so the pattern never crosses the uv seam.
 */
export function buildCrackSegments(seed: number): CrackSegment[] {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const segments: CrackSegment[] = [];

  const main: [number, number][] = [];
  let u = 0.5 + (rng() - 0.5) * 0.08;
  let v = 0.78;
  main.push([u, v]);
  for (let i = 0; i < 6; i++) {
    u += (rng() - 0.5) * 0.1;
    v -= 0.05 + rng() * 0.035;
    main.push([u, v]);
  }
  pushLine(segments, main, 0, 0.55);

  const forkA = main[2];
  if (forkA !== undefined) {
    const b1: [number, number][] = [forkA];
    let bu = forkA[0];
    let bv = forkA[1];
    for (let i = 0; i < 3; i++) {
      bu -= 0.035 + rng() * 0.05;
      bv -= 0.028 + rng() * 0.03;
      b1.push([bu, bv]);
    }
    pushLine(segments, b1, 0.35, 0.8);
  }

  const forkB = main[4];
  if (forkB !== undefined) {
    const b2: [number, number][] = [forkB];
    let bu = forkB[0];
    let bv = forkB[1];
    for (let i = 0; i < 3; i++) {
      bu += 0.035 + rng() * 0.05;
      bv -= 0.024 + rng() * 0.03;
      b2.push([bu, bv]);
    }
    pushLine(segments, b2, 0.5, 1.0);
  }

  return segments;
}

function f(n: number): string {
  return n.toFixed(4);
}

/** Emit the deterministic crack SDF as a GLSL snippet for this seed. */
function buildCrackGlsl(seed: number): string {
  const segments = buildCrackSegments(seed);
  const calls = segments
    .map(
      (s) =>
        `  m = max(m, crackSeg(p, vec2(${f(s.ax)}, ${f(s.ay)}), ` +
        `vec2(${f(s.bx)}, ${f(s.by)}), ${f(s.t0)}, ${f(s.t1)}, cr, w));`,
    )
    .join('\n');
  return `
float crackSeg(vec2 p, vec2 a, vec2 b, float t0, float t1, float cr, float w) {
  float grow = clamp((cr - t0) / max(t1 - t0, 1e-4), 0.0, 1.0);
  if (grow <= 0.0) return 0.0;
  vec2 tip = a + (b - a) * grow;
  vec2 pa = p - a;
  vec2 ba = tip - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * h);
  return 1.0 - smoothstep(0.45 * w, w, d);
}
float eggCrack(vec2 uv, float cr) {
  if (cr <= 0.001) return 0.0;
  vec2 p = vec2(uv.x * ${f(U_SCALE)}, uv.y);
  float w = mix(0.0035, 0.0125, cr);
  float m = 0.0;
${calls}
  return m;
}
`;
}

/**
 * Inject the crack into a shell material. The material must carry a map
 * (the shell texture) so vMapUv exists in the fragment shader. Multiple
 * materials sharing a seed (the shell and its hatch pieces) share the same
 * pattern — and, via customProgramCacheKey, the same compiled program —
 * while each keeps its own uCrack value.
 */
export function applyCrackShader(material: MeshPhysicalMaterial, seed: number): CrackHandle {
  const uCrack = { value: 0 };
  const uCrackInk = { value: new Color(WORLD.ink) };
  const glsl = buildCrackGlsl(seed);

  material.onBeforeCompile = (shader) => {
    shader.uniforms['uCrack'] = uCrack;
    shader.uniforms['uCrackInk'] = uCrackInk;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uCrack;\nuniform vec3 uCrackInk;\n${glsl}`,
      )
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n' +
          'diffuseColor.rgb = mix(diffuseColor.rgb, uCrackInk, eggCrack(vMapUv, uCrack));',
      );
  };
  material.customProgramCacheKey = () => `egg-crack-${seed}`;
  material.needsUpdate = true;

  return {
    setCrack(value: number): void {
      uCrack.value = Math.min(1, Math.max(0, value));
    },
    crackValue(): number {
      return uCrack.value;
    },
  };
}
