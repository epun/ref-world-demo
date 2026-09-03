/**
 * Water tests — the built scene graph, headless. Meshes, geometries and
 * materials are plain objects in node (no WebGL), so everything the pass
 * builds can be read straight off the group.
 *
 * What these pin is the seam between the pure geography and the drawn result:
 * that every vertex the pass emits is actually over water, that a lake's fill
 * has its island punched out of it and both shores drawn, that the marks come
 * from tokens and nothing else, and that the surface never fully arrests.
 */

import { describe, expect, it } from 'vitest';
import { Color, DoubleSide, Mesh, MeshBasicMaterial, type BufferAttribute } from 'three';
import { SURFACE, WORLD } from '../../src/taste/tokens';
import {
  ISLAND_OUTLINE_POINTS,
  OUTLINE_POINTS,
  RIPPLE_MARGIN,
  WATER_BODIES,
  islandOutline,
  isWater,
  rippleSpots,
  terrainHeight,
  waterLevel,
  waterOutline,
  wobbledRadius,
  type WaterBody,
} from '../../src/world/landscape';
import {
  RIPPLE_DRIFT,
  RIPPLE_LIFT,
  SHORE_LIFT,
  WATER_LIFT,
  createWater,
} from '../../src/world/water';

/** The scatter's ticks sit here — everything water must stay under it. */
const TICK_LIFT = 0.015;
/** The pond margin water.ts uses (ponds are too small for the default). */
const POND_MARGIN = 1.0;

const LAKE: WaterBody = WATER_BODIES[0]!;
/** The lake's island — its own centre, not the lake's. */
const ISLAND = LAKE.island!;
/** The ribbon's sampling multiple over each outline's default budget
 * (water.ts SHORE_SUBDIVISION) — the density both rings are built at. */
const SUBDIVISION = 4;

const meshes = (): Mesh[] => createWater().group.children as Mesh[];

const named = (name: string): Mesh => {
  const found = createWater().group.getObjectByName(name);
  expect(found, name).toBeInstanceOf(Mesh);
  return found as Mesh;
};

/** Every position in a geometry, as world x/z (the meshes only lift in y). */
function points(mesh: Mesh): [number, number][] {
  const attr = mesh.geometry.getAttribute('position') as BufferAttribute;
  const out: [number, number][] = [];
  for (let i = 0; i < attr.count; i++) out.push([attr.getX(i), attr.getZ(i)]);
  return out;
}

/** The body a mesh belongs to, off its `<layer>-<kind>-<index>` name (the
 * island ribbon's kind is `island`, and its index is its lake's). */
function bodyOf(mesh: Mesh): WaterBody {
  const index = Number(mesh.name.split('-')[2]);
  return WATER_BODIES[index]!;
}

/** The body a loose point belongs to. The bodies are far apart (their shore
 * ramps do not even touch), so the nearest center is the one it is in. */
function bodyNear(x: number, z: number): WaterBody {
  let best = WATER_BODIES[0]!;
  let bestD = Infinity;
  for (const body of WATER_BODIES) {
    const d = Math.hypot(x - body.x, z - body.z);
    if (d < bestD) {
      bestD = d;
      best = body;
    }
  }
  return best;
}

function totalRippleSpots(): number {
  let n = 0;
  for (const body of WATER_BODIES) {
    n += rippleSpots(body, body.kind === 'pond' ? POND_MARGIN : RIPPLE_MARGIN).length;
  }
  return n;
}

describe('water — what gets built', () => {
  it('is one named group holding a fill per body, a shore per shoreline, one mark sheet', () => {
    const water = createWater();
    expect(water.group.name).toBe('water');
    const names = water.group.children.map((child) => child.name);
    expect(names).toEqual([
      'water-lake-0',
      'water-pond-1',
      'water-pond-2',
      'water-pond-3',
      'water-pond-4',
      'shore-lake-0',
      'shore-island-0',
      'shore-pond-1',
      'shore-pond-2',
      'shore-pond-3',
      'shore-pond-4',
      'ripples',
    ]);
    // One fill per body — the lake's has its island punched out as a hole —
    // and one ribbon per SHORELINE, which is two for the lake: its outer
    // shore and its island's. Plus one ripple sheet: twelve draws.
    expect(names.filter((n) => n.startsWith('water-'))).toHaveLength(WATER_BODIES.length);
    expect(names.filter((n) => n.startsWith('shore-'))).toHaveLength(WATER_BODIES.length + 1);
  });

  it('gives every mark two arcs of six quads, in one buffer', () => {
    const ripples = named('ripples');
    const attr = ripples.geometry.getAttribute('position');
    const spots = totalRippleSpots();
    expect(spots).toBeGreaterThan(0);
    // 2 arcs × 6 quads × 2 triangles per spot, non-indexed.
    expect(attr.count / 3).toBe(spots * 2 * 6 * 2);
    expect(ripples.geometry.getIndex()).toBeNull();
  });

  it('lifts each layer a hair, in drawing order, under the ticks', () => {
    expect(WATER_LIFT).toBeLessThan(SHORE_LIFT);
    expect(SHORE_LIFT).toBeLessThan(RIPPLE_LIFT);
    expect(RIPPLE_LIFT).toBeLessThan(TICK_LIFT);
    expect(WATER_LIFT).toBeGreaterThan(0);
    for (const mesh of meshes()) {
      // Each body's sheets ride ITS basin — the lifts are over the water
      // level, not over y=0. The ripples are the exception: one buffer holds
      // every body's marks, so their heights are baked per vertex and the
      // mesh itself stays at the origin.
      const expected = mesh.name.startsWith('water-')
        ? waterLevel(bodyOf(mesh)) + WATER_LIFT
        : mesh.name.startsWith('shore-')
          ? waterLevel(bodyOf(mesh)) + SHORE_LIFT
          : 0;
      expect(mesh.position.y, mesh.name).toBe(expected);
    }
  });

  it('sinks each body into its own basin — no sheet is left floating at y=0', () => {
    const levels = WATER_BODIES.map((body) => waterLevel(body));
    // The map's basins really are at different heights; a pass that ignored
    // the terrain would still pass every other test in this file.
    expect(new Set(levels).size).toBeGreaterThan(1);
    for (const mesh of meshes()) {
      if (mesh.name === 'ripples') continue;
      expect(Math.abs(mesh.position.y), mesh.name).toBeGreaterThan(0.02);
    }
  });

  it('bakes each mark at the level of the body it belongs to', () => {
    const ripples = named('ripples');
    const attr = ripples.geometry.getAttribute('position') as BufferAttribute;
    const seen = new Set<number>();
    for (let i = 0; i < attr.count; i++) {
      const level = waterLevel(bodyNear(attr.getX(i), attr.getZ(i)));
      expect(attr.getY(i), `ripple ${i}`).toBeCloseTo(level + RIPPLE_LIFT, 5);
      seen.add(level);
    }
    // …and the buffer really does span more than one level.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('never lets a fill poke through the land it sits in', () => {
    // The basin makes every point inside a shore ramp climb OUT of the water
    // level, so the sheet can only ever be at or above the ground under it.
    // If this fails the terrain is wrong, not the water: a pond would show
    // grass islands through its own surface.
    createWater()
      .fills()
      .forEach((poly, index) => {
        const level = waterLevel(WATER_BODIES[index]!);
        for (const [x, z] of poly) {
          expect(terrainHeight(x, z), `fill ${index} at ${x},${z}`).toBeLessThanOrEqual(
            level + 1e-6,
          );
        }
      });
    // …and the same on the island's shoreline, where the bank starts: the
    // hole in the sheet is cut exactly where the ground leaves the water.
    for (const [x, z] of islandOutline(LAKE, ISLAND_OUTLINE_POINTS * SUBDIVISION)!) {
      expect(terrainHeight(x, z), `island shore at ${x},${z}`).toBeLessThanOrEqual(
        waterLevel(LAKE) + 1e-6,
      );
    }
  });

  it('faces every surface up, exactly like the paper under it', () => {
    // The ink pass reads a normal target: a facing of its own would ring each
    // pond in a second contour beside the drawn shoreline.
    for (const mesh of meshes()) {
      const normal = mesh.geometry.getAttribute('normal') as BufferAttribute;
      expect(normal, mesh.name).toBeDefined();
      for (let i = 0; i < normal.count; i++) {
        expect(normal.getY(i)).toBeCloseTo(1, 6);
        expect(Math.abs(normal.getX(i))).toBeLessThan(1e-6);
        expect(Math.abs(normal.getZ(i))).toBeLessThan(1e-6);
      }
    }
  });

  it('winds every fill triangle that has any area at all up', () => {
    for (const mesh of meshes()) {
      if (!mesh.name.startsWith('water-')) continue;
      const attr = mesh.geometry.getAttribute('position') as BufferAttribute;
      const index = mesh.geometry.getIndex();
      expect(index, mesh.name).not.toBeNull();
      let net = 0;
      for (let i = 0; i < index!.count; i += 3) {
        const a = index!.getX(i);
        const b = index!.getX(i + 1);
        const c = index!.getX(i + 2);
        const ny =
          (attr.getZ(b) - attr.getZ(a)) * (attr.getX(c) - attr.getX(a)) -
          (attr.getX(b) - attr.getX(a)) * (attr.getZ(c) - attr.getZ(a));
        net += ny;
        // The densified bank legs are runs of exactly collinear points, so
        // earcut returns a few slivers whose winding is float noise (largest
        // measured: 8e-7 square units, under a sixth of a pixel even at
        // maximum zoom). Anything that could cover a pixel must face up.
        if (Math.abs(ny) > 1e-4) expect(ny, mesh.name).toBeGreaterThan(0);
      }
      // And the sheet as a whole faces up, not just most of it.
      expect(net, mesh.name).toBeGreaterThan(0);
    }
  });

  it('double-sides the fill, so a sliver can never become a hole', () => {
    const fill = named('water-lake-0').material as MeshBasicMaterial;
    expect(fill.side).toBe(DoubleSide);
  });
});

describe('water — everything drawn is over water', () => {
  it('keeps every fill vertex inside the water, grown a little', () => {
    for (const mesh of meshes()) {
      if (!mesh.name.startsWith('water-')) continue;
      for (const [x, z] of points(mesh)) {
        expect(isWater(x, z, 0.5), `${mesh.name} at ${x},${z}`).toBe(true);
      }
    }
  });

  it('keeps every ripple vertex in open water', () => {
    for (const [x, z] of points(named('ripples'))) {
      expect(isWater(x, z), `ripple at ${x},${z}`).toBe(true);
    }
  });

  it('draws the island shore on the island, all the way round it', () => {
    // Every vertex of the island's ribbon sits within half a mitered pen
    // width of the island's own wobbled edge: the stroke is ON the shore, not
    // adrift in the lake, and it straddles the line the way a pen does.
    const sectors = new Set<number>();
    const vertices = points(named('shore-island-0'));
    expect(vertices.length).toBeGreaterThan(600);
    for (const [x, z] of vertices) {
      const theta = Math.atan2(z - ISLAND.z, x - ISLAND.x);
      const d = Math.hypot(x - ISLAND.x, z - ISLAND.z);
      expect(Math.abs(d - wobbledRadius(ISLAND, theta)), `island shore at ${x},${z}`).toBeLessThan(
        0.25,
      );
      sectors.add(Math.floor(((theta + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 6)));
    }
    // …in all twelve 30° sectors: the causeway that used to break this stroke
    // (and tie the island to the mainland) is gone.
    expect(sectors.size).toBe(12);
  });

  it('keeps the outer shore on the outer shore, with nothing crossing the lake', () => {
    for (const [x, z] of points(named('shore-lake-0'))) {
      const theta = Math.atan2(z - LAKE.z, x - LAKE.x);
      const d = Math.hypot(x - LAKE.x, z - LAKE.z);
      expect(Math.abs(d - wobbledRadius(LAKE, theta)), `shore at ${x},${z}`).toBeLessThan(0.25);
    }
  });

  it('gives a pond one plain ribbon — its fill outline is its shore', () => {
    for (const name of ['shore-pond-1', 'shore-pond-2', 'shore-pond-3', 'shore-pond-4']) {
      const body = WATER_BODIES.find((b, i) => `shore-${b.kind}-${i}` === name)!;
      for (const [x, z] of points(named(name))) {
        // Every vertex sits within half a mitered pen width of the shore.
        const theta = Math.atan2(z - body.z, x - body.x);
        const d = Math.hypot(x - body.x, z - body.z);
        expect(Math.abs(d - wobbledRadius(body, theta))).toBeLessThan(0.25);
      }
    }
  });

  it('draws a broken contour — the pen lifts, and the shore is not a closed rule', () => {
    // 384 outer samples, minus roughly one segment in twelve: a complete
    // ribbon would be every segment.
    const quads = points(named('shore-pond-1')).length / 6;
    expect(quads).toBeLessThan(96 * 4);
    expect(quads).toBeGreaterThan(96 * 4 * 0.8);
    // …and the island's own stroke breaks in its own places: the two rings
    // of the lake are seeded apart, so the pen does not lift twice at the
    // same bearing.
    const island = points(named('shore-island-0')).length / 6;
    expect(island).toBeLessThan(ISLAND_OUTLINE_POINTS * SUBDIVISION);
    expect(island).toBeGreaterThan(ISLAND_OUTLINE_POINTS * SUBDIVISION * 0.8);
  });
});

describe('water — the fill edge and the pen line are one line', () => {
  /** Worst distance from a ribbon's centerline to the nearest point of a
   * polygon: the two paired vertices of every quad edge should straddle one
   * polygon point exactly. */
  const ribbonOffPolygon = (mesh: Mesh, poly: readonly [number, number][]): number => {
    const attr = mesh.geometry.getAttribute('position') as BufferAttribute;
    let worst = 0;
    let checked = 0;
    for (let q = 0; q < attr.count; q += 6) {
      for (const [a, b] of [
        [0, 1],
        [2, 4],
      ] as const) {
        const mx = (attr.getX(q + a) + attr.getX(q + b)) / 2;
        const mz = (attr.getZ(q + a) + attr.getZ(q + b)) / 2;
        let nearest = Infinity;
        for (const [x, z] of poly) {
          const d = Math.hypot(x - mx, z - mz);
          if (d < nearest) nearest = d;
        }
        if (nearest > worst) worst = nearest;
        checked++;
      }
    }
    expect(checked, mesh.name).toBeGreaterThan(100);
    return worst;
  };

  it('builds both from a single polygon per ring, so no paper shows between them', () => {
    // A coarsely sampled fill and a finely sampled ribbon sit a chord's
    // sagitta apart on every wobble, which shows as a hair of bare paper
    // between the grey and the ink. One shared array per ring makes that
    // unrepresentable.
    const water = createWater();
    const fills = water.fills();
    const bodies = water.group.children.filter((c) => c.name.startsWith('water-')) as Mesh[];
    expect(fills).toHaveLength(WATER_BODIES.length);

    fills.forEach((poly, i) => {
      // Earcut triangulates the polygon's own points and invents none — and a
      // hole adds exactly its own points — so the fill's vertices ARE the
      // outlines'.
      const island = islandOutline(WATER_BODIES[i]!, ISLAND_OUTLINE_POINTS * SUBDIVISION);
      const fillAttr = bodies[i]!.geometry.getAttribute('position') as BufferAttribute;
      expect(fillAttr.count, bodies[i]!.name).toBe(poly.length + (island?.length ?? 0));
      const shore = createWater().group.getObjectByName(
        `shore-${WATER_BODIES[i]!.kind}-${i}`,
      ) as Mesh;
      // Coincident to float32 rounding — not "close", the same point.
      expect(ribbonOffPolygon(shore, poly), shore.name).toBeLessThan(1e-4);
    });
  });

  it('rides the island ring the same way, so its hole and its pen line agree', () => {
    const island = islandOutline(LAKE, ISLAND_OUTLINE_POINTS * SUBDIVISION)!;
    expect(ribbonOffPolygon(named('shore-island-0'), island)).toBeLessThan(1e-4);
  });

  it('samples every ring finely enough that no segment can gape', () => {
    // Half a segment is the worst a fill vertex and a pen vertex could ever be
    // apart if they drifted; the stroke is wider than that everywhere.
    const rings = [
      ...createWater().fills(),
      islandOutline(LAKE, ISLAND_OUTLINE_POINTS * SUBDIVISION)!,
    ];
    for (const poly of rings) {
      let longest = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        longest = Math.max(longest, Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      expect(longest).toBeLessThan(1);
    }
  });

  it('hands the map the outer ring, densified exactly as the geography drew it', () => {
    // fills() is the outer polygon only; the hole is islandOutline. Both are
    // the geography's own points at the ribbon's density — no resampling.
    createWater()
      .fills()
      .forEach((poly, i) => {
        expect(poly).toEqual(waterOutline(WATER_BODIES[i]!, OUTLINE_POINTS * SUBDIVISION));
      });
  });
});

describe('water — value', () => {
  it('fills with the measured mid grey, unlit', () => {
    const fill = named('water-lake-0').material as MeshBasicMaterial;
    expect(fill).toBeInstanceOf(MeshBasicMaterial);
    expect(fill.color.equals(new Color(WORLD.neutralMid))).toBe(true);
    // One material for every body: the water is one flat value by construction.
    const water = createWater();
    const fills = water.group.children.filter((c) => c.name.startsWith('water-')) as Mesh[];
    for (const mesh of fills) expect(mesh.material).toBe(fills[0]!.material);
  });

  it('draws every shore and every ripple in the ink token', () => {
    const water = createWater();
    for (const child of water.group.children) {
      const mesh = child as Mesh;
      if (mesh.name.startsWith('water-')) continue;
      const material = mesh.material as MeshBasicMaterial;
      expect(material, mesh.name).toBeInstanceOf(MeshBasicMaterial);
      expect(material.color.equals(new Color(SURFACE.ink)), mesh.name).toBe(true);
    }
  });

  it('never reaches near-black — that value belongs to characters', () => {
    const ink = new Color(SURFACE.ink);
    const body = new Color(WORLD.nearBlack);
    expect(ink.r).toBeGreaterThan(body.r);
  });
});

describe('water — the ambient drift', () => {
  it('slides each mark along its own direction, on a bounded sine', () => {
    const attr = named('ripples').geometry.getAttribute('aRipple') as BufferAttribute;
    expect(attr.itemSize).toBe(3);
    for (let i = 0; i < attr.count; i++) {
      // dir is a unit vector in x/z, phase is an angle.
      expect(Math.hypot(attr.getX(i), attr.getY(i))).toBeCloseTo(1, 5);
      expect(attr.getZ(i)).toBeGreaterThanOrEqual(0);
      expect(attr.getZ(i)).toBeLessThanOrEqual(Math.PI * 2);
    }
    // The whole displacement is |sin| ≤ 1 times this, in world units: small
    // enough that a mark stays where the geography put it, never zero.
    expect(RIPPLE_DRIFT).toBe(0.06);
    expect(RIPPLE_DRIFT).toBeGreaterThan(0);
  });

  it('advances the time uniform on update, and injects it into the shader', () => {
    const water = createWater();
    const material = (water.group.getObjectByName('ripples') as Mesh)
      .material as MeshBasicMaterial;
    const uniforms = material.userData.rippleUniforms as { uTime: { value: number } };
    expect(uniforms.uTime.value).toBe(0);
    water.update(2500);
    expect(uniforms.uTime.value).toBeCloseTo(2.5, 9);
    water.update(9000);
    expect(uniforms.uTime.value).toBeCloseTo(9, 9);

    // The injection itself: a uTime uniform, the aRipple attribute, and a
    // smooth sine displacement — no step, no snap.
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '',
    };
    material.onBeforeCompile(
      shader as unknown as Parameters<typeof material.onBeforeCompile>[0],
      null as never,
    );
    expect(shader.uniforms.uTime).toBe(uniforms.uTime);
    expect(shader.vertexShader).toContain('attribute vec3 aRipple;');
    expect(shader.vertexShader).toContain('sin(uTime');
    expect(shader.vertexShader).toContain(`${RIPPLE_DRIFT}`);
  });
});

describe('water — fills()', () => {
  it('hands back one counter-clockwise polygon per body, for the map', () => {
    const fills = createWater().fills();
    expect(fills).toHaveLength(WATER_BODIES.length);
    fills.forEach((poly, i) => {
      expect(poly.length).toBeGreaterThan(3);
      let area = 0;
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k]!;
        const q = poly[(k + 1) % poly.length]!;
        area += p[0] * q[1] - q[0] * p[1];
      }
      expect(area / 2, WATER_BODIES[i]!.kind).toBeGreaterThan(0);
    });
  });

  it('is a copy — a caller cannot reach in and move the geography', () => {
    const water = createWater();
    const first = water.fills();
    first[0]![0]![0] = 9999;
    expect(water.fills()[0]![0]![0]).not.toBe(9999);
  });
});

describe('water — dispose', () => {
  it('empties the group and releases every geometry and material', () => {
    const water = createWater();
    const children = water.group.children as Mesh[];
    let released = 0;
    const onDispose = (): void => {
      released++;
    };
    const geometries = new Set(children.map((mesh) => mesh.geometry));
    const materials = new Set(children.map((mesh) => mesh.material as MeshBasicMaterial));
    for (const item of [...geometries, ...materials]) item.addEventListener('dispose', onDispose);
    water.dispose();
    expect(water.group.children).toHaveLength(0);
    expect(released).toBe(geometries.size + materials.size);
  });
});
