import { describe, expect, it } from 'vitest';
import { MeshPhysicalMaterial } from 'three';
import { applyDeform } from '../../src/character/deform';

/** Run a material's onBeforeCompile against a stub shader. */
function compile(material: MeshPhysicalMaterial): {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
} {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n',
    fragmentShader: '',
  };
  material.onBeforeCompile(shader as never, null as never);
  return shader;
}

describe('deform attach — the rig bends with the body', () => {
  const frame = { baseY: -0.5, height: 1 };

  it('an attached material gets the same deform program as the body', () => {
    const body = new MeshPhysicalMaterial();
    const stalk = new MeshPhysicalMaterial();
    const handles = applyDeform(body, frame);
    handles.attach(stalk);
    const a = compile(body);
    const b = compile(stalk);
    expect(b.vertexShader).toContain('transformed = gaitBody(deformBody(transformed))');
    expect(b.vertexShader).toContain('objectNormal = gaitBodyNormal(deformBodyNormal(');
    expect(b.vertexShader).toBe(a.vertexShader);
    expect(stalk.customProgramCacheKey()).toBe(body.customProgramCacheKey());
  });

  it('shares the uniform OBJECTS, so one set() moves every attached surface', () => {
    const body = new MeshPhysicalMaterial();
    const topper = new MeshPhysicalMaterial();
    const handles = applyDeform(body, frame);
    handles.attach(topper);
    const a = compile(body).uniforms;
    const b = compile(topper).uniforms;
    for (const key of ['uSquash', 'uLeanX', 'uLeanZ', 'uTwist', 'uReach', 'uGaitPhase']) {
      expect(b[key]).toBe(a[key]);
    }
    handles.set({ leanX: 0.3, squash: 0.8 });
    handles.setGait({ ...handles.getGait(), phase: 1.25, amp: 0.5 });
    expect(b['uLeanX']!.value).toBe(0.3);
    expect(b['uSquash']!.value).toBe(0.8);
    expect(b['uGaitPhase']!.value).toBe(1.25);
  });
});
