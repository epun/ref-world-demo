/**
 * Ground tests — the built mesh, headless. Geometries are plain buffers in
 * node (no WebGL), so the displaced field can be read vertex by vertex.
 *
 * What these pin is the seam: the paper the world stands on is the Surface
 * (src/world/surface.ts) and nothing else, its rim is flat where the terrain
 * is flat so the far field meets it without a seam, and it carries the
 * normals the ink pass needs to draw the terraces at all.
 *
 * THE MODE. There is only terrain to displace in the landscape mode
 * (src/world/landscape.ts) — the world SHIPS as a flat plain — so this file
 * switches it on and puts it back. The plain field is measured at the bottom:
 * it is the same ground the FLAT_SURFACE case already pins, arrived at from
 * the other direction.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, type BufferAttribute } from 'three';
import { SURFACE } from '../../src/taste/tokens';
import {
  FIELD_SEGMENTS,
  FIELD_SIZE,
  createGround,
  fieldQuad,
  fieldSegments,
  fieldSize,
} from '../../src/world/ground';
import {
  setIslandMode,
  setLandscapeMode,
  setTerrainParams,
  TERRAIN,
  TERRAIN_DEFAULTS,
  terrainParams,
} from '../../src/world/landscape';
import { FLAT_SURFACE, ROLLING_SURFACE } from '../../src/world/surface';

/* The island — and so the sea floor the far ring rests on — is the katamari
 * world's map and ships OFF (src/world/game.ts), so this file switches it on
 * with the mode and puts both back. */
beforeAll(() => {
  setLandscapeMode('landscape');
  setIslandMode(true);
});
afterAll(() => {
  setLandscapeMode('plain');
  setIslandMode(false);
});

const field = (ground = createGround(ROLLING_SURFACE)): Mesh =>
  ground.group.getObjectByName('ground-field') as Mesh;

const positionOf = (mesh: Mesh): BufferAttribute =>
  mesh.geometry.getAttribute('position') as BufferAttribute;

/** Same sin-hash family as the world's own: a fixed, reproducible sample. */
function seededIndices(count: number, of: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
    out.push(Math.floor((x - Math.floor(x)) * of));
  }
  return out;
}

describe('ground — what gets built', () => {
  it('is one named group of two meshes sharing a single unlit material', () => {
    const ground = createGround(ROLLING_SURFACE);
    expect(ground.group.name).toBe('ground');
    expect(ground.group.children.map((child) => child.name)).toEqual([
      'ground-field',
      'ground-far',
    ]);
    for (const child of ground.group.children) {
      // ONE material: the paper is one value by construction, so a color
      // grade can never pull the field and the horizon apart.
      expect((child as Mesh).material, child.name).toBe(ground.material);
    }
    expect(ground.material).toBeInstanceOf(MeshBasicMaterial);
    expect(ground.material.color.equals(new Color(SURFACE.ground))).toBe(true);
  });

  it('keeps the field at the budgeted density', () => {
    // ~205k triangles is the ceiling this world pays for its ground on a world
    // with no island, and `MAP_SCALE`² times that on a scaled one
    // (src/world/landscape.ts), because what is held fixed across the scale is
    // the QUAD and not the count — a quad wider than a terrace riser washes
    // the drawn contour out (PLAN §7.1 measured it, and `riserRun` in
    // src/world/field.ts re-measures it per scale: the riser's own run is
    // 2.101 units at 1.1, so a 1.25-unit quad still puts more than one vertex
    // across it while a 2.5-unit one would be wider than the riser).
    expect(FIELD_SEGMENTS).toBeLessThanOrEqual(320);
    // `toBeCloseTo` and not `toBeLessThanOrEqual`: since `MAP_SCALE` became
    // 1.1 the side is 400 · 1.1 = 440.00000000000006 and the quad comes out
    // 1.2500000000000002 — the same 1.25 with the last bit of a float that is
    // not exact in binary (2026-09-17).
    expect(fieldQuad()).toBeCloseTo(1.25, 9);
    const index = field().geometry.getIndex();
    expect(index).not.toBeNull();
    expect(index!.count / 3).toBe(fieldSegments() * fieldSegments() * 2);
  });
});

describe('ground — the field is the surface', () => {
  it('lifts every sampled vertex to exactly surface.sampleHeight', () => {
    const attr = positionOf(field());
    let moved = 0;
    for (const i of seededIndices(50, attr.count)) {
      const x = attr.getX(i);
      const z = attr.getZ(i);
      expect(attr.getY(i), `vertex ${i} at ${x},${z}`).toBeCloseTo(
        ROLLING_SURFACE.sampleHeight(x, z),
        4,
      );
      if (Math.abs(attr.getY(i)) > 1e-6) moved++;
    }
    // …and the sample really is over terrain, not 50 flat points.
    expect(moved).toBeGreaterThan(20);
  });

  it('rests its whole rim on the sea floor, where the far ring meets it', () => {
    // This used to read "rests its whole rim on zero": the terrain was
    // exactly 0 past TERRAIN.farEnd (185) and the rim is at 200. Since the
    // map became an island (2026-09-15) the ground outside the coast falls to
    // the SEA FLOOR and stays there, and the coast's farthest bulge plus its
    // floor slope (171.8 + 16) lands well inside 200 — so the rim is still
    // ONE flat number, and the far ring is seated on that number rather than
    // on zero.
    const attr = positionOf(field());
    // `fieldSize`, not `FIELD_SIZE`: the field's side rides the island's scale
    // and the rim moves out with it (±200, and ±400 on the doubled island).
    const half = fieldSize() / 2;
    const floor = ROLLING_SURFACE.sampleHeight(half, 0);
    // A floor, not paper: the ocean is a real basin under the plain.
    expect(floor).toBeLessThan(-1);
    let rim = 0;
    for (let i = 0; i < attr.count; i++) {
      const x = attr.getX(i);
      const z = attr.getZ(i);
      if (Math.abs(Math.abs(x) - half) > 1e-3 && Math.abs(Math.abs(z) - half) > 1e-3) continue;
      rim++;
      expect(attr.getY(i), `rim vertex at ${x},${z}`).toBeCloseTo(floor, 5);
    }
    expect(rim).toBe(fieldSegments() * 4);
    // …and the ring is seated on it, so the two meet with no seam to hide.
    const far = createGround(ROLLING_SURFACE).group.getObjectByName('ground-far')!;
    expect(far.position.y).toBe(floor);
  });

  it('carries unit normals, computed after the displacement', () => {
    // These normals ARE the terraces: the ink pass hatches faces turned from
    // the key and creases a contour at every riser. A mesh normalled before
    // the lift (or not at all) would render the whole map as flat paper.
    const attr = positionOf(field());
    const normal = field().geometry.getAttribute('normal') as BufferAttribute;
    expect(normal.count).toBe(attr.count);
    let tilted = 0;
    for (const i of seededIndices(200, normal.count)) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(length, `normal ${i}`).toBeCloseTo(1, 5);
      expect(normal.getY(i), `normal ${i}`).toBeGreaterThan(0);
      if (normal.getY(i) < 0.999) tilted++;
    }
    // A riser turns a face away from straight up; a flat sheet never would.
    expect(tilted).toBeGreaterThan(20);
  });

  it('follows whatever Surface it is handed — flat means flat', () => {
    // The seam, negatively: hand it the pre-terrain world and the ground is
    // the plane it used to be, with nothing in this file to change.
    const attr = positionOf(field(createGround(FLAT_SURFACE)));
    for (let i = 0; i < attr.count; i++) expect(attr.getY(i)).toBe(0);
  });
});

describe('ground — the terrain draws its own tiers', () => {
  /** Compile the material against a stub shader, like water.test.ts does. */
  function compile(material: MeshBasicMaterial): {
    uniforms: Record<string, { value: unknown }>;
    vertexShader: string;
    fragmentShader: string;
  } {
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}',
    };
    material.onBeforeCompile(
      shader as unknown as Parameters<typeof material.onBeforeCompile>[0],
      null as never,
    );
    return shader;
  }

  it('injects the tier marks into the shared material, unlit and achromatic', () => {
    // Geometry alone is invisible here: the ground is unlit paper and the ink
    // pass's hatch/contour thresholds never trip on a riser this gentle. The
    // ground therefore draws its own lip lines and hatching, in color only.
    const ground = createGround(ROLLING_SURFACE);
    const shader = compile(ground.material);

    // World position and world normal reach the fragment stage…
    expect(shader.vertexShader).toContain('varying vec3 vGroundPos;');
    expect(shader.vertexShader).toContain('varying vec3 vGroundNormal;');
    expect(shader.vertexShader).toContain('modelMatrix * vec4(transformed, 1.0)');
    expect(shader.fragmentShader).toContain('varying vec3 vGroundPos;');

    // …the marks are a function of HEIGHT (so a line is a contour) and of
    // tilt (so a tread stays clean paper)…
    expect(shader.fragmentShader).toContain('uInk');
    expect(shader.fragmentShader).toContain('uStep');
    expect(shader.fragmentShader).toContain('uRiser');
    expect(shader.fragmentShader).toContain('float h = vGroundPos.y;');
    // …and the ONLY thing they do is mix the ink token into the paper: no
    // second light, no material swap, nothing chromatic.
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = mix(diffuseColor.rgb, uInk, ink);');
    expect(ground.material).toBeInstanceOf(MeshBasicMaterial);
    expect(ground.material.color.equals(new Color(SURFACE.ground))).toBe(true);

    // The uniforms are the geography's own numbers, not a second opinion.
    expect((shader.uniforms.uStep as { value: number }).value).toBe(terrainParams().tierStep);
    const riser = shader.uniforms.uRiser as { value: { x: number; y: number } };
    expect([riser.value.x, riser.value.y]).toEqual([...TERRAIN.terraceRiser]);
    expect((shader.uniforms.uInk as { value: Color }).value.equals(new Color(SURFACE.ink))).toBe(
      true,
    );
    // The injected program must never share a cache slot with a stock one.
    expect(ground.material.customProgramCacheKey()).toContain('ground');
  });

  it('drifts the pen wobble on update — the marks never fully arrest', () => {
    const ground = createGround(ROLLING_SURFACE);
    const shader = compile(ground.material);
    const time = shader.uniforms.uGroundTime as { value: number };
    expect(time.value).toBe(0);
    ground.update(2500);
    expect(time.value).toBeCloseTo(2.5, 9);
    ground.update(9000);
    expect(time.value).toBeCloseTo(9, 9);
    // Wall-clock, not integrated: a dropped frame cannot make a line jump.
    expect(shader.fragmentShader).toContain('uGroundTime');
  });

  it('is driven every frame from the render loop', () => {
    // scene.ts needs a gl context, so this reads the seam in the source: the
    // wobble is a per-frame uniform write like water.update, and a ground
    // nobody updates is a ground that has fully stopped (TASTE §2.1).
    const scene = readFileSync(join(process.cwd(), 'src/world/scene.ts'), 'utf8');
    expect(scene).toContain('ground.update(nowMs)');
  });

  it('is rebuilt with the scatter, the water and its visibility when the map is toggled', () => {
    // Same reason (scene.ts needs a gl context). FOUR calls, not the dial's
    // three: switching the map on re-cuts the ground, RE-ROLLS the scatter
    // (the map decides what grows where), re-levels the water onto its
    // basins — a body sits under the plain's zero — and only then shows it.
    const scene = readFileSync(join(process.cwd(), 'src/world/scene.ts'), 'utf8');
    const body = scene.slice(scene.indexOf('setLandscape: ('));
    expect(body).toContain("setLandscapeMode(on ? 'landscape' : 'plain')");
    expect(body).toContain('ground.rebuild()');
    expect(body).toContain('scatter.refreshLandscape()');
    expect(body).toContain('water.refreshLevels()');
    expect(body).toContain('water.setVisible(on)');
  });

  it('is rebuilt with the scatter and the water when a terrain dial moves', () => {
    // Same reason as above (scene.ts needs a gl context): the seam is read in
    // the source. All THREE have to be told, or the props stand in the air
    // over a re-cut field and the lakes sit at last dial's level.
    const scene = readFileSync(join(process.cwd(), 'src/world/scene.ts'), 'utf8');
    const body = scene.slice(scene.indexOf('setTerrain: ('));
    expect(body).toContain('setTerrainParams(next)');
    expect(body).toContain('ground.rebuild()');
    expect(body).toContain('scatter.refreshTerrain()');
    expect(body).toContain('water.refreshLevels()');
  });
});

describe('ground — it rebuilds under the terrain dials', () => {
  // Module state in landscape.ts: put it back, whatever the test did.
  afterEach(() => setTerrainParams(TERRAIN_DEFAULTS));

  /** The same stub-shader compile the tier tests above use. */
  function uStepOf(material: MeshBasicMaterial): { value: number } {
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n}',
    };
    material.onBeforeCompile(
      shader as unknown as Parameters<typeof material.onBeforeCompile>[0],
      null as never,
    );
    return shader.uniforms.uStep as { value: number };
  }

  // 60s: the field is 411k vertices on the doubled island (2026-09-16,
  // `MAP_SCALE`) and this walks every one of them twice, through the Surface
  // seam, across two rebuilds.
  it('re-displaces every vertex from the surface — elevation 0 is a flat field', () => {
    const ground = createGround(ROLLING_SURFACE);
    const mesh = field(ground);
    const before = positionOf(mesh);
    let moved = 0;
    for (const i of seededIndices(50, before.count)) {
      if (Math.abs(before.getY(i)) > 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(20);

    setTerrainParams({ elevation: 0 });
    ground.rebuild();
    // The GEOMETRY is reused — the attribute is rewritten in place, not
    // re-allocated, so a drag does not rebuild 205k triangles per frame.
    const after = positionOf(mesh);
    expect(after).toBe(before);
    for (let i = 0; i < after.count; i++) expect(after.getY(i)).toBe(0);
    // …and the normals came with it: a flat field points straight up.
    const normal = mesh.geometry.getAttribute('normal') as BufferAttribute;
    for (const i of seededIndices(50, normal.count)) {
      expect(normal.getY(i), `normal ${i}`).toBeCloseTo(1, 6);
    }

    // Back to the shipped dials and the terrain is exactly what it was.
    setTerrainParams(TERRAIN_DEFAULTS);
    ground.rebuild();
    for (const i of seededIndices(50, after.count)) {
      expect(after.getY(i), `vertex ${i}`).toBeCloseTo(
        ROLLING_SURFACE.sampleHeight(after.getX(i), after.getZ(i)),
        4,
      );
    }
  }, 60_000);

  it('tracks the tier spacing in uStep — the hatch is cut at the same step', () => {
    // The drawn lip lines are `fract(h / uStep)`: a hatch drawn at the old
    // step over geometry cut at the new one would put its contours somewhere
    // other than the risers.
    const ground = createGround(ROLLING_SURFACE);
    const uStep = uStepOf(ground.material);
    expect(uStep.value).toBe(TERRAIN_DEFAULTS.tierStep);
    setTerrainParams({ tierStep: 3.2 });
    ground.rebuild();
    expect(uStep.value).toBe(3.2);
    setTerrainParams({ tierStep: TERRAIN.terraceStep });
    ground.rebuild();
    expect(uStep.value).toBe(TERRAIN.terraceStep);
  }, 30000); // a whole-field walk: over the 5 s budget on the doubled island
});

describe('ground — the plain mode is a flat field', () => {
  /** Build a ground with the map switched off, then put the file's mode
   * back. */
  function inPlain<T>(f: () => T): T {
    setLandscapeMode('plain');
    try {
      return f();
    } finally {
      setLandscapeMode('landscape');
    }
  }

  it('displaces nothing — the world opens on flat paper', () => {
    // The world ships plain (2026-09-09, user ask), so this is the ground the
    // room actually opens on: the same plane FLAT_SURFACE gives, reached
    // through ROLLING_SURFACE with no map under it.
    const attr = inPlain(() => positionOf(field()));
    for (let i = 0; i < attr.count; i++) expect(attr.getY(i)).toBe(0);
  });

  // 60s: same reason as above — every vertex of the doubled field, twice.
  it('re-displaces on rebuild when the map is switched on', () => {
    // What WorldHandles.setLandscape leans on: the same geometry, re-cut.
    const ground = inPlain(() => createGround(ROLLING_SURFACE));
    const mesh = ground.group.getObjectByName('ground-field') as Mesh;
    const attr = positionOf(mesh);
    for (let i = 0; i < attr.count; i++) expect(attr.getY(i)).toBe(0);

    ground.rebuild(); // the file's mode is landscape again
    expect(positionOf(mesh)).toBe(attr);
    let moved = 0;
    for (const i of seededIndices(50, attr.count)) {
      if (Math.abs(attr.getY(i)) > 1e-6) moved++;
      expect(attr.getY(i), `vertex ${i}`).toBeCloseTo(
        ROLLING_SURFACE.sampleHeight(attr.getX(i), attr.getZ(i)),
        4,
      );
    }
    expect(moved).toBeGreaterThan(20);

    // …and back to flat when it is switched off again.
    inPlain(() => {
      ground.rebuild();
      for (let i = 0; i < attr.count; i++) expect(attr.getY(i)).toBe(0);
    });
  }, 60_000);
});
