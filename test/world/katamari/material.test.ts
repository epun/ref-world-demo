/**
 * The katamari material: it builds in node, it declares every function once,
 * and it carries the uniforms its callers write.
 *
 * WHY THE DUPLICATE-FUNCTION CHECK IS THE IMPORTANT ONE — the same reason
 * `test/world/ghibli/shaders.test.ts` gives, and this material is assembled
 * out of even more borrowed chunks: `src/world/toon.ts`'s `toon*` lighting
 * (which already contains its own noise), `src/world/ghibli/shared.ts`'s
 * `ggWindNoise` and `ggVariation`, and this folder's own `kat*` posterise. Two
 * of them declaring one function name is a glsl compile error that surfaces at
 * runtime, on one world, as a blank frame. The regex is cheap.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataTexture, DoubleSide, ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  KATAMARI_LEVELS,
  createKatamariMaterial,
  createKatamariMaterialSet,
} from '../../../src/world/katamari/material';
import { assembleLibrary, type KatamariModel } from '../../../src/world/katamari/models';

function texture(): DataTexture {
  const tex = new DataTexture(new Uint8Array([255, 200, 120, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

/** Every top-level function DEFINITION in a shader stage — the same regex
 * `test/world/ghibli/shaders.test.ts` uses. */
function definitions(source: string): string[] {
  const out: string[] = [];
  const re = /^[ \t]*(?:float|vec2|vec3|vec4|mat3|mat4|void)\s+(\w+)\s*\([^)]*\)\s*\{/gm;
  for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

/** A model-shaped stand-in: the material only reads four of its fields. */
function model(over: Partial<KatamariModel> = {}): KatamariModel {
  return {
    id: '0001',
    name: 'Spatula',
    file: '0001_Spatula.glb',
    kind: 'small',
    tier: 'small',
    heightUnits: 0.3,
    rooted: false,
    geometry: undefined as never,
    height: 0.3,
    radius: 0.1,
    texture: texture(),
    textures: [],
    alphaMode: 'opaque',
    doubleSide: false,
    parts: [],
    ...over,
  } as KatamariModel;
}

describe('katamari material', () => {
  it('builds as a ShaderMaterial with both stages', () => {
    const material = createKatamariMaterial(texture());
    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.vertexShader.length).toBeGreaterThan(0);
    expect(material.fragmentShader.length).toBeGreaterThan(0);
    expect(definitions(material.vertexShader).filter((d) => d === 'main')).toHaveLength(1);
    expect(definitions(material.fragmentShader).filter((d) => d === 'main')).toHaveLength(1);
  });

  it('declares every function exactly once per stage', () => {
    const material = createKatamariMaterial(texture());
    for (const stage of [material.vertexShader, material.fragmentShader]) {
      const names = definitions(stage);
      const seen = new Set<string>();
      const duplicates = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
      expect(duplicates).toEqual([]);
    }
  });

  it('every glsl function belongs to a known namespace', () => {
    const toon = ['toonHash21', 'toonVnoise', 'toonFbm', 'toonRamp', 'toonShadowColor', 'toonLight'];
    const shared = ['ggWindHash', 'ggWindNoise', 'ggVariation'];
    const own = ['katPosterize', 'katSrgbToLinear'];
    const material = createKatamariMaterial(texture());
    const all = definitions(material.vertexShader).concat(definitions(material.fragmentShader));
    for (const name of all) {
      const known =
        toon.includes(name) || shared.includes(name) || own.includes(name) || name === 'main';
      expect(known, `unnamespaced glsl function: ${name}`).toBe(true);
    }
  });

  it('carries the posterise dial, the albedo and the shared cel switch', () => {
    const material = createKatamariMaterial(texture());
    expect(material.uniforms.uLevels).toBeDefined();
    expect(material.uniforms.uLevels!.value).toBe(KATAMARI_LEVELS);
    expect(material.uniforms.uAlbedo).toBeDefined();
    expect(material.uniforms.uWarm).toBeDefined();
    expect(material.uniforms.uDab).toBeDefined();
    expect(material.uniforms.uHeight).toBeDefined();
    // By reference, so one write flips the whole frame and the sun swings.
    expect(material.uniforms.uToonOn).toBeDefined();
    expect(material.uniforms.uSunDir).toBeDefined();
    // The wind write (`setWindOnMaterial`) reaches it unchanged.
    expect(material.uniforms.uWindTime).toBeDefined();
    expect(material.uniforms.uWindDir).toBeDefined();
    expect(material.uniforms.uWindStrength).toBeDefined();
  });

  it('every declared uniform has a value', () => {
    const material = createKatamariMaterial(texture());
    for (const [key, slot] of Object.entries(material.uniforms)) {
      expect(slot, key).toBeDefined();
      expect(slot.value, key).not.toBeUndefined();
    }
  });

  it('the fragment reads the albedo through the posterise and never raw', () => {
    const material = createKatamariMaterial(texture());
    expect(material.fragmentShader).toContain('katPosterize(texel.rgb, uLevels)');
    expect(material.fragmentShader).toContain('toonLight(albedo, n, 1.0, 3.0)');
  });

  it('mask alpha is a hard cutout, blend is a transparent draw', () => {
    const mask = createKatamariMaterial(texture(), { alphaMode: 'mask' });
    expect(mask.alphaTest).toBe(0.5);
    expect(mask.transparent).toBe(false);
    expect(mask.defines).toHaveProperty('KATAMARI_MASK');
    const blend = createKatamariMaterial(texture(), { alphaMode: 'blend' });
    expect(blend.transparent).toBe(true);
    expect(blend.alphaTest).toBe(0);
    const opaque = createKatamariMaterial(texture());
    expect(opaque.transparent).toBe(false);
    expect(opaque.alphaTest).toBe(0);
  });

  it('honours the game’s culling flag', () => {
    expect(createKatamariMaterial(texture(), { doubleSide: true }).side).toBe(DoubleSide);
  });

  it('the vertex stage carries the instanced variation attribute', () => {
    const material = createKatamariMaterial(texture());
    expect(material.vertexShader).toContain('attribute vec4 aVariation');
    expect(material.vertexShader).toContain('ggVariation(position, aVariation)');
    // USE_INSTANCING is the scatter's path, and the non-instanced fallback
    // (src/world/loose.ts draws a fallen prop as a mesh) is there too.
    expect(material.vertexShader).toContain('#ifdef USE_INSTANCING');
  });
});

describe('katamari material set', () => {
  it('shares one material per texture, alpha mode and culling', () => {
    const a = model({ id: '0001' });
    const b = model({ id: '0002', name: 'Persimmon', alphaMode: 'mask' });
    const c = model({ id: '0003', name: 'Brick' });
    const set = createKatamariMaterialSet(assembleLibrary([a, b, c]));
    expect(set.materials()).toHaveLength(3);
    expect(set.materialFor(a)).toBe(set.materialFor(a));
    expect(set.materialFor(a)).not.toBe(set.materialFor(b));
    set.dispose();
    expect(set.materials()).toHaveLength(0);
  });

  it('a shared material takes the tallest height on it', () => {
    const tex = texture();
    const short = model({ id: '0001', texture: tex, height: 0.3 });
    const tall = model({ id: '0001', texture: tex, height: 4 });
    const set = createKatamariMaterialSet(assembleLibrary([short, tall]));
    expect(set.materials()).toHaveLength(1);
    expect(set.materials()[0]!.uniforms.uHeight!.value).toBe(4);
  });
});

/**
 * Comments blanked, newlines kept — the trick `scripts/gates/static.ts` and
 * the ghibli test both use, because this folder's headers DISCUSS the things
 * the scans forbid.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

describe('katamari sources', () => {
  const dir = join(process.cwd(), 'src', 'world', 'katamari');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('has every module', () => {
    for (const expected of ['catalog.ts', 'material.ts', 'models.ts']) {
      expect(files).toContain(expected);
    }
  });

  it('never reaches for Math.random — two handsets must cut the same building', () => {
    for (const file of files) {
      expect(code(readFileSync(join(dir, file), 'utf8')).includes('Math.random'), file).toBe(false);
    }
  });

  it('does not import the files other delegates own', () => {
    // props.ts is imported on purpose (the normalise rule and the hash
    // family live there and must not be copied); everything else in the
    // scatter/scene/destruction stack belongs to another delegate at merge
    // time and is reached through the wiring plan instead.
    const forbidden = [
      '../scatter',
      '../chunks',
      '../scene',
      '../ground',
      '../water',
      '../ink',
      '../camera',
    ];
    for (const file of files) {
      const source = code(readFileSync(join(dir, file), 'utf8'));
      for (const path of forbidden) {
        expect(source.includes(`'${path}'`), `${file} imports ${path}`).toBe(false);
      }
    }
  });

  it('the catalog stays free of three, so the curate script can read it', () => {
    const source = code(readFileSync(join(dir, 'catalog.ts'), 'utf8'));
    // Only `import type` is allowed in there — a value import would drag
    // three.js into a node build script.
    for (const line of source.split('\n')) {
      if (/^\s*import\b/.test(line)) expect(line).toContain('import type');
    }
  });
});
