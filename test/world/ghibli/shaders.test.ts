/**
 * The ghibli element shaders: they build, they declare each function once,
 * and they carry the uniforms their callers write.
 *
 * WHY THE DUPLICATE-FUNCTION CHECK IS THE IMPORTANT ONE. Every material in
 * `src/world/ghibli/` is assembled by CONCATENATING chunks nobody owns
 * together: `src/world/toon.ts`'s `toon*` lighting chain, `src/world/wind.ts`'s
 * `wind*` gust field, and this folder's own `gg*` copies of the scatter's wind
 * and variation blocks. Two of those chunks declaring one function name is a
 * GLSL compile error, and it surfaces at runtime, on one style, as a blank
 * frame with a console message — exactly the class of bug nobody can name
 * (src/world/scene.ts's own note). A regex here is cheap; a shader compiler
 * in a unit test is not.
 *
 * These tests run in node with no renderer: three builds materials and
 * geometry perfectly well without a gl context, and nothing here compiles a
 * program.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createCloudMaterial } from '../../../src/world/ghibli/clouds';
import { createFlowerField } from '../../../src/world/ghibli/flowers';
import { createGrassField } from '../../../src/world/ghibli/grass';
import { createGroundMaterial } from '../../../src/world/ghibli/ground';
import { createRockMaterial } from '../../../src/world/ghibli/rocks';
import { createCanopyMaterial } from '../../../src/world/ghibli/trees';
import {
  createSeaSurfaceMaterial,
  createWaterSurfaceMaterial,
} from '../../../src/world/ghibli/water';

/** One entry per material a ghibli world builds. */
function materials(): { name: string; material: ShaderMaterial; uniforms: string[] }[] {
  const grass = createGrassField({ count: 64 });
  const flowers = createFlowerField({ count: 64 });
  return [
    {
      name: 'grass',
      material: grass.material,
      uniforms: [
        'uGrass',
        'uComb',
        'uPress',
        'uRegion',
        'uHeight',
        'uCenter',
        'uWindTime',
        'uWindDir',
        'uSunDir',
      ],
    },
    {
      name: 'flowers',
      material: flowers.material,
      uniforms: ['uFlowers', 'uGrass', 'uRegion', 'uHeight', 'uCenter', 'uMix', 'uStem', 'uWindGust'],
    },
    {
      name: 'rock',
      material: createRockMaterial(),
      uniforms: ['uRock', 'uWarm', 'uCool', 'uMoss', 'uSpeckle'],
    },
    {
      name: 'canopy',
      material: createCanopyMaterial(),
      uniforms: ['uTrunk', 'uCanopyDark', 'uCanopyLight', 'uHighlight', 'uTrunkLine', 'uCrownY'],
    },
    {
      name: 'cloud',
      material: createCloudMaterial(),
      uniforms: ['uCloudLit', 'uCloudShade', 'uCloudSpan', 'uWindStrength'],
    },
    {
      name: 'water',
      material: createWaterSurfaceMaterial(),
      uniforms: ['uDeep', 'uMid', 'uShallow', 'uFoam', 'uWet', 'uRippleTex', 'uDepthScale'],
    },
    {
      name: 'sea',
      material: createSeaSurfaceMaterial(),
      uniforms: ['uDeep', 'uShallow', 'uDrift', 'uRippleTex'],
    },
    {
      name: 'ground',
      material: createGroundMaterial().material,
      uniforms: ['uGrass', 'uPath', 'uScorch', 'uRegion', 'uSand', 'uSandWet', 'uInk', 'uStep'],
    },
  ];
}

/**
 * Every top-level function DEFINITION in a shader stage: a return type, a
 * name, an argument list and an opening brace. Nothing in these chunks
 * declares a prototype separately, so a definition is the whole story.
 */
function definitions(source: string): string[] {
  const out: string[] = [];
  const re = /^[ \t]*(?:float|vec2|vec3|vec4|mat3|mat4|void)\s+(\w+)\s*\([^)]*\)\s*\{/gm;
  for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

describe('ghibli element shaders', () => {
  for (const { name, material, uniforms } of materials()) {
    it(`${name} — builds as a ShaderMaterial with both stages`, () => {
      expect(material).toBeInstanceOf(ShaderMaterial);
      expect(material.vertexShader.length).toBeGreaterThan(0);
      expect(material.fragmentShader.length).toBeGreaterThan(0);
      // `main` is there, once, in each stage.
      expect(definitions(material.vertexShader).filter((d) => d === 'main')).toHaveLength(1);
      expect(definitions(material.fragmentShader).filter((d) => d === 'main')).toHaveLength(1);
    });

    it(`${name} — declares every function exactly once per stage`, () => {
      for (const stage of [material.vertexShader, material.fragmentShader]) {
        const names = definitions(stage);
        const seen = new Set<string>();
        const duplicates = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
        expect(duplicates).toEqual([]);
      }
    });

    it(`${name} — carries the uniforms its caller writes`, () => {
      for (const key of uniforms) expect(material.uniforms[key]).toBeDefined();
      // The shared cel switch, by reference: one write flips the whole frame.
      expect(material.uniforms.uToonOn).toBeDefined();
      expect(material.uniforms.uSunDir).toBeDefined();
    });

    it(`${name} — every declared uniform has a value`, () => {
      for (const [key, slot] of Object.entries(material.uniforms)) {
        expect(slot, key).toBeDefined();
        expect(slot.value, key).not.toBeUndefined();
      }
    });
  }

  it('the toon and wind chunks agree on names across every material', () => {
    // Concatenating two stages of two different materials must still not
    // collide on the SHARED chunks — which is what a future chunk rename
    // would break.
    const toon = ['toonHash21', 'toonVnoise', 'toonFbm', 'toonRamp', 'toonShadowColor', 'toonLight'];
    const wind = ['windHash21', 'windVnoise', 'windFbm', 'refWindAt'];
    const own = [
      'ggWindHash',
      'ggWindNoise',
      'ggVariation',
      'ggVoronoiF1',
      'ggGroundHash',
      'ggGroundVNoise',
      'ggGroundNoise',
      // The shared bakes: the ground under a blade, and the window it stands
      // in (src/world/ghibli/height.ts).
      'ggGroundAt',
      'ggWindow',
    ];
    for (const { material } of materials()) {
      const all = definitions(material.vertexShader).concat(definitions(material.fragmentShader));
      for (const n of all) {
        // Anything that is not one of the three known families, or a stage
        // entry point, is a new name somebody added without a namespace.
        const known = toon.includes(n) || wind.includes(n) || own.includes(n) || n === 'main';
        expect(known, `unnamespaced glsl function: ${n}`).toBe(true);
      }
    }
  });
});

/**
 * Comments blanked, newlines kept — the same trick scripts/gates/static.ts
 * uses, and for the same reason: these module headers DISCUSS the things the
 * scans below forbid (they say why envpaint's `uGrain` is dropped and why
 * `Math.random` is banned), and a scan that cannot tell code from prose
 * fails on its own documentation.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

describe('ghibli sources', () => {
  const dir = join(process.cwd(), 'src', 'world', 'ghibli');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('has every module', () => {
    for (const expected of [
      'clouds.ts',
      'flowers.ts',
      'grass.ts',
      'ground.ts',
      'post.ts',
      'region.ts',
      'rocks.ts',
      'shared.ts',
      'trees.ts',
      'water.ts',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('never reaches for Math.random — the layout has to agree across devices', () => {
    for (const file of files) {
      const source = code(readFileSync(join(dir, file), 'utf8'));
      expect(source.includes('Math.random'), file).toBe(false);
    }
  });

  it('does not import the files other delegates own', () => {
    // The wind and variation blocks are COPIED on purpose (see the module
    // headers); an import here would be a merge conflict waiting to happen.
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(
          /\.\.\/(scatter|scene|water|ground|rocks)$/,
        );
      }
    }
  });

  it('keeps envpaint material grain out (grain is a post-process, TASTE §2.7)', () => {
    for (const file of files) {
      const source = code(readFileSync(join(dir, file), 'utf8'));
      expect(source.includes('uGrain'), file).toBe(false);
    }
  });
});
