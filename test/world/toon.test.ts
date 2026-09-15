/**
 * The cel injection's one structural obligation: it CHAINS (src/world/toon.ts).
 *
 * Half the materials it lands on already own their `onBeforeCompile` — the
 * ground's terrace marks, the scatter's wind/nudge/variation stack, the
 * character's deform → marking → eye chain, the egg's crack. A hook that
 * assigned instead of wrapping would silently delete one of those, and the
 * symptom would be a missing terrace line or a creature that stopped walking,
 * with nothing on screen naming the cause. Two lines of TypeScript, so it is
 * pinned here rather than noticed in a demo.
 */

import { MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { applyToon, setToonEnabled, toonUniforms } from '../../src/world/toon';

/** A stand-in for the shader three hands `onBeforeCompile`, carrying just the
 * include lines the injection replaces. */
function fakeShader(): WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    defines: {},
    vertexShader: [
      '#include <common>',
      'void main() {',
      '  #include <begin_vertex>',
      '  #include <project_vertex>',
      '}',
    ].join('\n'),
    fragmentShader: [
      '#include <common>',
      'void main() {',
      '  vec4 diffuseColor = vec4(1.0);',
      '  vec3 outgoingLight = diffuseColor.rgb;',
      '  #include <opaque_fragment>',
      '}',
    ].join('\n'),
  } as unknown as WebGLProgramParametersWithUniforms;
}

const NO_RENDERER = null as unknown as WebGLRenderer;

function compile(material: Material): WebGLProgramParametersWithUniforms {
  const shader = fakeShader();
  material.onBeforeCompile(shader, NO_RENDERER);
  return shader;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('applyToon — chains, never clobbers', () => {
  it('calls the hook that was already there, first', () => {
    const order: string[] = [];
    const material = new MeshStandardMaterial();
    material.onBeforeCompile = (shader): void => {
      order.push('previous');
      // a pre-existing injection of its own, to prove it survives
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n// previous-mark',
      );
    };
    material.customProgramCacheKey = (): string => 'previous-key';

    applyToon(material);
    const shader = compile(material);

    expect(order).toEqual(['previous']);
    // and the earlier hook's own edit is still in the source it produced
    expect(shader.vertexShader).toContain('// previous-mark');
    expect(shader.vertexShader).toContain('vToonWorldPos');
  });

  it('suffixes the cache key it found rather than replacing it', () => {
    const material = new MeshStandardMaterial();
    material.customProgramCacheKey = (): string => 'previous-key';
    applyToon(material);
    expect(material.customProgramCacheKey()).toBe('previous-key+toon-v1');
  });

  it('gives a stock material a key of its own', () => {
    const material = new MeshBasicMaterial();
    applyToon(material);
    expect(material.customProgramCacheKey()).toContain('+toon-v1');
  });

  it('keeps the slope-rock ground on its own program', () => {
    const plain = new MeshBasicMaterial();
    const ground = new MeshBasicMaterial();
    applyToon(plain);
    applyToon(ground, { slopeRock: true });
    expect(ground.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
    expect(compile(ground).defines).toHaveProperty('TOON_SLOPE_ROCK');
    expect(compile(plain).defines).not.toHaveProperty('TOON_SLOPE_ROCK');
  });
});

describe('applyToon — what it writes into the shader', () => {
  it('guards the replacement on uToonOn, once', () => {
    const shader = compile(applied(new MeshStandardMaterial()));
    expect(count(shader.fragmentShader, 'if (uToonOn > 0.5)')).toBe(1);
    expect(count(shader.fragmentShader, 'uniform float uToonOn;')).toBe(1);
    // the stock include is kept, not dropped: three still writes the frame out.
    expect(count(shader.fragmentShader, '#include <opaque_fragment>')).toBe(1);
  });

  it('shares ONE uniform set, so the switch moves every material at once', () => {
    const a = compile(applied(new MeshStandardMaterial()));
    const b = compile(applied(new MeshPhysicalMaterial()));
    expect(a.uniforms['uToonOn']).toBe(toonUniforms.uToonOn);
    expect(b.uniforms['uToonOn']).toBe(toonUniforms.uToonOn);
    setToonEnabled(true);
    expect(a.uniforms['uToonOn']!.value).toBe(1);
    expect(b.uniforms['uToonOn']!.value).toBe(1);
    setToonEnabled(false);
    expect(a.uniforms['uToonOn']!.value).toBe(0);
  });

  it('declares its noise under names nothing else in this repo uses', () => {
    // the ground defines groundHash/groundVNoise and the scatter's wind block
    // defines its own — a duplicate definition fails the compile outright.
    const shader = compile(applied(new MeshBasicMaterial()));
    expect(shader.fragmentShader).toContain('float toonFbm(');
    expect(shader.fragmentShader).not.toContain('float fbm(');
    expect(shader.fragmentShader).not.toContain('float hash21(');
  });

  it('is a no-op the second time, on any material', () => {
    for (const material of [
      new MeshBasicMaterial(),
      new MeshStandardMaterial(),
      new MeshPhysicalMaterial(),
    ]) {
      applyToon(material);
      const once = compile(material);
      applyToon(material);
      const twice = compile(material);
      expect(twice.fragmentShader).toBe(once.fragmentShader);
      expect(twice.vertexShader).toBe(once.vertexShader);
      expect(count(twice.fragmentShader, 'uniform float uToonOn;')).toBe(1);
      expect(count(material.customProgramCacheKey(), '+toon-v1')).toBe(1);
    }
  });
});

function applied<T extends Material>(material: T): T {
  applyToon(material);
  return material;
}
