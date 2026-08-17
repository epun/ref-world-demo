/**
 * Prop motif tests — pure: the variant stroke lists run through analyze(),
 * the architectural builders run headless, and the built geometries are
 * inspected as data. No WebGL, no DOM.
 */

import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { analyze } from '../../src/shape/analyze';
import {
  ARCH_PROP_KINDS,
  ARCH_VARIANT_DEFS,
  buildPropGeometries,
  extrudeWobbled,
  INFLATED_PROP_KINDS,
  latheWobbled,
  PROP_KINDS,
  PROP_MASK_SIZE,
  PROP_MASK_SIZE_SMALL,
  PROP_VARIANT_COUNTS,
  PROP_VARIANT_DEFS,
  type ArchPropKind,
  type InflatedPropKind,
  type PropKind,
} from '../../src/world/props';

/** Mask size per kind, mirroring buildPropGeometries' small-kind rule. */
function maskSize(kind: InflatedPropKind): number {
  return kind === 'rock' ||
    kind === 'bush' ||
    kind === 'stump' ||
    kind === 'cactus' ||
    kind === 'monolith'
    ? PROP_MASK_SIZE_SMALL
    : PROP_MASK_SIZE;
}

/** name+height meta for any kind, either construction path. */
function metaOf(kind: PropKind): { name: string; height: number }[] {
  return (INFLATED_PROP_KINDS as readonly string[]).includes(kind)
    ? PROP_VARIANT_DEFS[kind as InflatedPropKind]
    : ARCH_VARIANT_DEFS[kind as ArchPropKind];
}

/** Area-weighted fraction of faces whose normal sits within `deg` of ±dir —
 * the planar-wall probe: walls cluster tightly, pillows scatter. */
function planarFraction(g: BufferGeometry, dir: [number, number, number], deg: number): number {
  const pos = g.getAttribute('position');
  const idx = g.index;
  const n = idx ? idx.count : pos.count;
  const at = (k: number): number => (idx ? idx.getX(k) : k);
  const cos = Math.cos((deg * Math.PI) / 180);
  let hit = 0;
  let total = 0;
  for (let i = 0; i < n; i += 3) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    const ax = pos.getX(a);
    const ay = pos.getY(a);
    const az = pos.getZ(a);
    const ux = pos.getX(b) - ax;
    const uy = pos.getY(b) - ay;
    const uz = pos.getZ(b) - az;
    const vx = pos.getX(c) - ax;
    const vy = pos.getY(c) - ay;
    const vz = pos.getZ(c) - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const area = len / 2;
    total += area;
    if (Math.abs((nx * dir[0] + ny * dir[1] + nz * dir[2]) / len) > cos) hit += area;
  }
  return hit / total;
}

describe('prop motif variants', () => {
  it('ships the authored variant counts per kind', () => {
    expect(PROP_VARIANT_COUNTS.tree).toBe(4);
    expect(PROP_VARIANT_COUNTS.conifer).toBe(3);
    expect(PROP_VARIANT_COUNTS.rock).toBe(3);
    expect(PROP_VARIANT_COUNTS.bush).toBe(3);
    expect(PROP_VARIANT_COUNTS.building).toBe(9); // the pack's family kit
    expect(PROP_VARIANT_COUNTS.stump).toBe(2);
    expect(PROP_VARIANT_COUNTS.cactus).toBe(2);
    expect(PROP_VARIANT_COUNTS.monolith).toBe(2);
    expect(PROP_VARIANT_COUNTS.palm).toBe(3);
    expect(PROP_VARIANT_COUNTS.picnicTable).toBe(2);
    expect(PROP_VARIANT_COUNTS.waterTower).toBe(2);
    for (const kind of PROP_KINDS) {
      expect(metaOf(kind).length).toBe(PROP_VARIANT_COUNTS[kind]);
    }
  });

  it('every inflated variant analyzes to usable ink', () => {
    for (const kind of INFLATED_PROP_KINDS) {
      for (const def of PROP_VARIANT_DEFS[kind]) {
        const a = analyze(def.strokes, { size: maskSize(kind), contourPoints: 96 });
        expect(a, `${kind}/${def.name}`).not.toBeNull();
        expect(a!.contour.length, `${kind}/${def.name}`).toBeGreaterThan(30);
      }
    }
  });

  it('proportions are sane per kind: tall kinds tall, low kinds low', () => {
    const aspects: Record<InflatedPropKind, [number, number]> = {
      tree: [1.1, 3.2], // fat lobe … tall narrow crown
      conifer: [1.3, 3.5], // squat pine … spire
      rock: [0.3, 1.0],
      bush: [0.3, 1.0],
      stump: [0.5, 2.0], // cut stump … roofed well
      cactus: [1.0, 2.8], // lobed columns
      monolith: [1.2, 3.4], // standing stones, taller than wide
    };
    for (const kind of INFLATED_PROP_KINDS) {
      const [lo, hi] = aspects[kind];
      for (const def of PROP_VARIANT_DEFS[kind]) {
        const a = analyze(def.strokes, { size: maskSize(kind) })!;
        const aspect = (a.bounds.maxY - a.bounds.minY) / (a.bounds.maxX - a.bounds.minX);
        expect(aspect, `${kind}/${def.name} aspect`).toBeGreaterThan(lo);
        expect(aspect, `${kind}/${def.name} aspect`).toBeLessThan(hi);
      }
    }
  });

  it('variants within a kind are actually distinct silhouettes', () => {
    for (const kind of INFLATED_PROP_KINDS) {
      const seen = new Set<string>();
      for (const def of PROP_VARIANT_DEFS[kind]) {
        const a = analyze(def.strokes, { size: maskSize(kind) })!;
        const key = a.contour
          .slice(0, 12)
          .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
          .join(';');
        expect(seen.has(key), `${kind}/${def.name} duplicates another variant`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('analysis is deterministic', () => {
    for (const def of [PROP_VARIANT_DEFS.tree[0]!, PROP_VARIANT_DEFS.cactus[0]!]) {
      const a = analyze(def.strokes, { size: PROP_MASK_SIZE });
      const b = analyze(def.strokes, { size: PROP_MASK_SIZE });
      expect(a!.contour).toEqual(b!.contour);
      expect(a!.bounds).toEqual(b!.bounds);
    }
  });

  it('built geometries are grounded, centered, and scaled to variant height', () => {
    const geometries = buildPropGeometries();
    for (const kind of PROP_KINDS) {
      const variants = geometries.get(kind)!;
      const meta = metaOf(kind);
      expect(variants.length, kind).toBe(PROP_VARIANT_COUNTS[kind]);
      variants.forEach((v, i) => {
        const tag = `${kind}/${meta[i]!.name}`;
        const box = v.geometry.boundingBox!;
        expect(box.min.y, `${tag} grounded`).toBeCloseTo(0, 4);
        expect(box.max.y - box.min.y, `${tag} height`).toBeCloseTo(meta[i]!.height, 3);
        expect(v.height).toBe(meta[i]!.height);
        // Centered in x/z within a small tolerance.
        expect(Math.abs(box.min.x + box.max.x), `${tag} centered x`).toBeLessThan(1e-3);
        expect(Math.abs(box.min.z + box.max.z), `${tag} centered z`).toBeLessThan(1e-3);
        expect(v.radius, `${tag} radius`).toBeGreaterThan(0);
        // Sane footprint: nothing degenerate, nothing sprawling. (The
        // walled courtyard is deliberately wide-and-low: bound is absolute.)
        expect(v.radius, `${tag} radius sane`).toBeLessThan(8);
        v.geometry.dispose();
      });
    }
  });

  it('variant heights vary within tree, conifer, and building (the skyline reads)', () => {
    const spread = (kind: PropKind): number => {
      const hs = metaOf(kind).map((d) => d.height);
      return Math.max(...hs) - Math.min(...hs);
    };
    expect(spread('tree')).toBeGreaterThan(0.5);
    expect(spread('conifer')).toBeGreaterThan(1.5);
    expect(spread('building')).toBeGreaterThan(1.5);
  });
});

// ── architectural construction (buildings are buildings, not trees) ──────────

describe('architectural construction', () => {
  it('extrudeWobbled is deterministic in its seed — and the seed matters', () => {
    const square: [number, number][] = [
      [-1, 0],
      [1, 0],
      [1, 2],
      [-1, 2],
    ];
    const a = extrudeWobbled(square, 1.5, 42.1);
    const b = extrudeWobbled(square, 1.5, 42.1);
    expect(Array.from(a.getAttribute('position').array)).toEqual(
      Array.from(b.getAttribute('position').array),
    );
    const c = extrudeWobbled(square, 1.5, 43.7);
    expect(Array.from(c.getAttribute('position').array)).not.toEqual(
      Array.from(a.getAttribute('position').array),
    );
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('latheWobbled is deterministic in its seed — and the seed matters', () => {
    const profile: [number, number][] = [
      [0.8, 0],
      [0.6, 1.5],
      [0.02, 2],
    ];
    const a = latheWobbled(profile, 12, 7.7);
    const b = latheWobbled(profile, 12, 7.7);
    expect(Array.from(a.getAttribute('position').array)).toEqual(
      Array.from(b.getAttribute('position').array),
    );
    const c = latheWobbled(profile, 12, 9.9);
    expect(Array.from(c.getAttribute('position').array)).not.toEqual(
      Array.from(a.getAttribute('position').array),
    );
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('the wobble stays a wobble: bowed walls, never engineered-straight', () => {
    // A wobbled square's outline points must deviate from the ideal edges
    // (drawn, not ruled) but only slightly (a bow, not a new shape).
    const square: [number, number][] = [
      [-1, 0],
      [1, 0],
      [1, 2],
      [-1, 2],
    ];
    const g = extrudeWobbled(square, 1, 11.3);
    const pos = g.getAttribute('position');
    let maxDev = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // Distance outside the ideal box (or inside, folded to a deviation).
      const dx = Math.max(Math.abs(x) - 1, 0);
      const dy = Math.max(y - 2, 0, -y);
      maxDev = Math.max(maxDev, dx, dy);
    }
    expect(maxDev).toBeGreaterThan(0.005); // it wobbles…
    expect(maxDev).toBeLessThan(0.2); // …but the wall is still that wall
    g.dispose();
  });

  it('buildPropGeometries is deterministic for architectural kinds', () => {
    const a = buildPropGeometries();
    const b = buildPropGeometries();
    for (const kind of ARCH_PROP_KINDS) {
      const va = a.get(kind)!;
      const vb = b.get(kind)!;
      va.forEach((v, i) => {
        expect(
          Array.from(v.geometry.getAttribute('position').array),
          `${kind}/${i}`,
        ).toEqual(Array.from(vb[i]!.geometry.getAttribute('position').array));
      });
    }
    for (const m of [a, b]) for (const vs of m.values()) for (const v of vs) v.geometry.dispose();
  });

  it('buildings carry PLANAR wall evidence — walls are walls, not pillows', () => {
    const geometries = buildPropGeometries();
    const building = geometries.get('building')!;
    // Slab-built families: facade planes face ±z and flank walls ±x — a
    // big area fraction of near-identical normals. (The keep's round
    // corner towers and teeth dilute its fraction; still far from pillow.)
    for (const [i, name, zMin, xMin] of [
      [0, 'keep', 0.12, 0.1],
      [3, 'courtyard', 0.3, 0.3],
      [4, 'adobe', 0.2, 0.15],
      [7, 'cottage', 0.2, 0.1],
    ] as const) {
      const g = building[i]!.geometry;
      expect(planarFraction(g, [0, 0, 1], 10), `${name} facade`).toBeGreaterThan(zMin);
      expect(planarFraction(g, [1, 0, 0], 10), `${name} flank`).toBeGreaterThan(xMin);
    }
    // Control: an inflated crown has no such cluster — that is exactly the
    // pillow read the buildings had to escape.
    const tree = geometries.get('tree')![0]!.geometry;
    expect(planarFraction(tree, [0, 0, 1], 10)).toBeLessThan(0.05);
    expect(planarFraction(tree, [1, 0, 0], 10)).toBeLessThan(0.05);
    // The picnic table is all planks: strong horizontal planes.
    const table = geometries.get('picnicTable')![0]!.geometry;
    expect(planarFraction(table, [0, 1, 0], 10)).toBeGreaterThan(0.2);
    for (const vs of geometries.values()) for (const v of vs) v.geometry.dispose();
  });

  it('architectural variants are distinct geometries', () => {
    const geometries = buildPropGeometries();
    for (const kind of ARCH_PROP_KINDS) {
      const seen = new Set<string>();
      for (const v of geometries.get(kind)!) {
        const pos = v.geometry.getAttribute('position');
        const key = `${pos.count}:${Array.from(pos.array.slice(0, 24))
          .map((x) => (x as number).toFixed(4))
          .join(',')}`;
        expect(seen.has(key), kind).toBe(false);
        seen.add(key);
      }
    }
    for (const vs of geometries.values()) for (const v of vs) v.geometry.dispose();
  });

  it('the palm reads as a palm: trunk-narrow at the base, frond-wide at the crown', () => {
    const geometries = buildPropGeometries();
    for (const v of geometries.get('palm')!) {
      // Crown spread well past the trunk: footprint radius > 2 world units.
      expect(v.radius).toBeGreaterThan(2);
      // Base slice (bottom 10%) stays narrow — it's a trunk, not a bush.
      const pos = v.geometry.getAttribute('position');
      let baseR = 0;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < v.height * 0.1) {
          baseR = Math.max(baseR, Math.hypot(pos.getX(i), pos.getZ(i)));
        }
      }
      expect(baseR).toBeGreaterThan(0);
      // (the base sits off-center by the trunk's bend after x/z centering,
      // so the bound is bend + trunk radius, still far under the crown)
      expect(baseR).toBeLessThan(1.6);
    }
    for (const vs of geometries.values()) for (const v of vs) v.geometry.dispose();
  });
});
