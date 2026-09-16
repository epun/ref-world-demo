/**
 * One real glb, through the real `GLTFLoader`, in node.
 *
 * IT WORKS, WITH TWO GLOBALS. `GLTFLoader.parseAsync` needs no dom for the
 * buffers — but the moment it reaches an embedded image it looks for `self`
 * and `createImageBitmap`, which node has neither of. Two stubs are the whole
 * polyfill: `self` pointed at `globalThis`, and a `createImageBitmap` that
 * hands back a 4x4 stand-in. Nothing here samples the texture, so a stand-in
 * bitmap is as good as the real one — what is under test is that a library
 * file parses, that its meshes become one normalised prop, and that the parts
 * come out in the prop's own space.
 *
 * `parseAsync` rather than `loadAsync` on purpose: `loadAsync` would need a
 * `fetch` over a file url, and the point of the test is the parse and the
 * assembly, not node's loader.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KATAMARI_CATALOG } from '../../../src/world/katamari/catalog';
import {
  KATAMARI_LOAD_CONCURRENCY,
  assembleLibrary,
  buildKatamariModel,
} from '../../../src/world/katamari/models';

const MODELS = join(process.cwd(), 'public', 'katamari', 'models');

/** A single-mesh prop and a multipart one, so both part routes are exercised. */
const ROCK = KATAMARI_CATALOG.find((e) => e.id === '03a9')!;
const CAR = KATAMARI_CATALOG.find((e) => e.id === '0091')!;

function arrayBufferOf(file: string): ArrayBuffer {
  const buffer = readFileSync(join(MODELS, file));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

let GLTFLoaderCtor: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader;

beforeAll(async () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.self ??= globalThis;
  scope.createImageBitmap ??= async (): Promise<unknown> => ({
    width: 4,
    height: 4,
    close(): void {},
  });
  ({ GLTFLoader: GLTFLoaderCtor } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
});

async function parse(file: string): Promise<import('three').Object3D> {
  const gltf = await new GLTFLoaderCtor().parseAsync(arrayBufferOf(file), '');
  return gltf.scene;
}

describe('katamari glb loading', () => {
  it('parses a library glb and normalises it to the catalog height', async () => {
    const model = buildKatamariModel(await parse(ROCK.file), ROCK);
    expect(model.id).toBe(ROCK.id);
    model.geometry.computeBoundingBox();
    const box = model.geometry.boundingBox!;
    expect(box.max.y - box.min.y).toBeCloseTo(ROCK.heightUnits, 4);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 5);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 5);
    expect(model.height).toBe(ROCK.heightUnits);
    expect(model.radius).toBeGreaterThan(0);
  });

  it('keeps position, normal and uv — a katamari prop is its texture', async () => {
    const model = buildKatamariModel(await parse(ROCK.file), ROCK);
    for (const name of ['position', 'normal', 'uv']) {
      expect(model.geometry.getAttribute(name), name).toBeDefined();
    }
    expect(model.geometry.index).toBeNull();
    expect(model.texture).not.toBeNull();
    // Nearest, no mipmaps, as extracted.
    expect(model.texture!.generateMipmaps).toBe(false);
    expect(model.textures.length).toBeGreaterThan(0);
    expect(['opaque', 'mask', 'blend']).toContain(model.alphaMode);
  });

  it('a single-mesh prop is cut into stacked pieces inside its own box', async () => {
    const model = buildKatamariModel(await parse(ROCK.file), ROCK);
    expect(model.parts.length).toBeGreaterThanOrEqual(1);
    expect(model.parts.length).toBeLessThanOrEqual(3);
    expect(model.parts[model.parts.length - 1]!.stage).toBe(2);
    for (const part of model.parts) {
      // Every piece sits inside the prop it came off, in the prop's space.
      expect(part.offset.y).toBeGreaterThanOrEqual(0);
      expect(part.offset.y).toBeLessThanOrEqual(ROCK.heightUnits);
      expect(part.radius).toBeGreaterThan(0);
      expect(part.geometry.getAttribute('uv')).toBeDefined();
    }
  });

  it('a multipart prop takes the glb’s own meshes as its pieces, top-down', async () => {
    const model = buildKatamariModel(await parse(CAR.file), CAR);
    expect(model.parts.length).toBeGreaterThan(1);
    const heights = model.parts.map((p) => p.offset.y);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!).toBeLessThanOrEqual(heights[i - 1]!);
    }
    expect(model.parts[0]!.stage).toBe(0);
    expect(model.parts[model.parts.length - 1]!.stage).toBe(2);
  });

  it('is deterministic — the same glb builds the same prop twice', async () => {
    const one = buildKatamariModel(await parse(ROCK.file), ROCK);
    const two = buildKatamariModel(await parse(ROCK.file), ROCK);
    expect(one.parts.map((p) => p.radius)).toEqual(two.parts.map((p) => p.radius));
    expect(one.parts.map((p) => p.offset)).toEqual(two.parts.map((p) => p.offset));
    expect(Array.from(one.geometry.getAttribute('position').array)).toEqual(
      Array.from(two.geometry.getAttribute('position').array),
    );
  });

  it('indexes a library by id and by kind, and disposes what it owns', async () => {
    const models = [
      buildKatamariModel(await parse(ROCK.file), ROCK),
      buildKatamariModel(await parse(CAR.file), CAR),
    ];
    const library = assembleLibrary(models);
    expect(library.byId.get(ROCK.id)).toBe(models[0]);
    expect(library.byKind.get('rock')).toEqual([models[0]]);
    expect(library.byKind.get('large')).toEqual([models[1]]);
    expect(() => library.dispose()).not.toThrow();
  });

  it('caps the glbs in flight', () => {
    expect(KATAMARI_LOAD_CONCURRENCY).toBe(8);
  });
});
