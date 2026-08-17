import { describe, it, expect } from 'vitest';
import { analyze } from '../../src/shape/analyze';
import { inflate } from '../../src/inflate/inflate';
import type { InflatedMesh } from '../../src/inflate/types';
import { circleBlob } from '../fixtures/strokes';

const SIZE = 256;

const analysis = analyze(circleBlob, { size: SIZE });
if (analysis === null) throw new Error('circle fixture failed to analyze');
const mesh = inflate(analysis);

function bytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

/** Cross-product magnitude of triangle t — twice its area. */
function triArea2(m: InflatedMesh, t: number): number {
  const p = m.positions;
  const ia = m.indices[t]! * 3;
  const ib = m.indices[t + 1]! * 3;
  const ic = m.indices[t + 2]! * 3;
  const e1x = p[ib]! - p[ia]!, e1y = p[ib + 1]! - p[ia + 1]!, e1z = p[ib + 2]! - p[ia + 2]!;
  const e2x = p[ic]! - p[ia]!, e2y = p[ic + 1]! - p[ia + 1]!, e2z = p[ic + 2]! - p[ia + 2]!;
  return Math.hypot(
    e1y * e2z - e1z * e2y,
    e1z * e2x - e1x * e2z,
    e1x * e2y - e1y * e2x,
  );
}

describe('inflate: structure', () => {
  it('returns non-empty positions, normals, and indices', () => {
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.positions.length % 3).toBe(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
  });

  it('has all indices in range', () => {
    const vertCount = mesh.positions.length / 3;
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]!).toBeLessThan(vertCount);
    }
  });

  it('has no degenerate triangles', () => {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!, b = mesh.indices[t + 1]!, c = mesh.indices[t + 2]!;
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(c).not.toBe(a);
      expect(triArea2(mesh, t)).toBeGreaterThan(1e-12);
    }
  });
});

describe('inflate: manifold sanity', () => {
  it('has no NaN in positions or normals', () => {
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(Number.isNaN(mesh.positions[i]!)).toBe(false);
      expect(Number.isNaN(mesh.normals[i]!)).toBe(false);
    }
  });

  it('has unit-length normals', () => {
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const len = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
      expect(Math.abs(len - 1)).toBeLessThan(1e-3);
    }
  });

  it('is a closed, consistently wound surface (every directed edge paired)', () => {
    // In a closed oriented manifold each directed edge appears exactly once
    // and its reverse exactly once. This also proves the rim is welded: an
    // unwelded rim would leave unpaired boundary edges on both sheets.
    const K = 0x200000; // 2^21 > vertex count
    const counts = new Map<number, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!, b = mesh.indices[t + 1]!, c = mesh.indices[t + 2]!;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        const k = u * K + v;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of counts) {
      expect(n).toBe(1);
      const u = Math.floor(k / K);
      const v = k % K;
      expect(counts.get(v * K + u)).toBe(1);
    }
  });

  it('encloses positive volume (outward winding)', () => {
    const p = mesh.positions;
    let vol6 = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const ia = mesh.indices[t]! * 3;
      const ib = mesh.indices[t + 1]! * 3;
      const ic = mesh.indices[t + 2]! * 3;
      vol6 +=
        p[ia]! * (p[ib + 1]! * p[ic + 2]! - p[ib + 2]! * p[ic + 1]!) +
        p[ia + 1]! * (p[ib + 2]! * p[ic]! - p[ib]! * p[ic + 2]!) +
        p[ia + 2]! * (p[ib]! * p[ic + 1]! - p[ib + 1]! * p[ic]!);
    }
    expect(vol6).toBeGreaterThan(0);
  });
});

describe('inflate: silhouette invariant', () => {
  it('keeps every contour point on the rim at z = 0 (the drawing is the silhouette)', () => {
    const cx = (analysis.bounds.minX + analysis.bounds.maxX) / 2;
    const cy = (analysis.bounds.minY + analysis.bounds.maxY) / 2;
    const vertCount = mesh.positions.length / 3;
    for (const p of analysis.contour) {
      const ex = (p.x - cx) / SIZE;
      const ey = (cy - p.y) / SIZE;
      let found = false;
      for (let i = 0; i < vertCount; i++) {
        const x = mesh.positions[i * 3]!;
        const y = mesh.positions[i * 3 + 1]!;
        const z = mesh.positions[i * 3 + 2]!;
        if (Math.abs(z) < 1e-7 && Math.abs(x - ex) < 1e-5 && Math.abs(y - ey) < 1e-5) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
  });
});

describe('inflate: determinism', () => {
  it('produces byte-identical output across calls', () => {
    const again = inflate(analysis);
    expect(bytesEqual(again.positions, mesh.positions)).toBe(true);
    expect(bytesEqual(again.normals, mesh.normals)).toBe(true);
    expect(bytesEqual(again.indices, mesh.indices)).toBe(true);
  });
});

describe('inflate: depth profile', () => {
  function maxZ(m: InflatedMesh): number {
    let max = 0;
    for (let i = 2; i < m.positions.length; i += 3) {
      if (m.positions[i]! > max) max = m.positions[i]!;
    }
    return max;
  }

  it('peaks at ≈ depthScale · dtMax / maskSize (default depthScale)', () => {
    const expected = 0.9 * analysis.distance.max / SIZE;
    expect(Math.abs(maxZ(mesh) - expected) / expected).toBeLessThan(0.15);
  });

  it('scales the peak with the depthScale option', () => {
    const half = inflate(analysis, { depthScale: 0.45 });
    const expected = 0.45 * analysis.distance.max / SIZE;
    expect(Math.abs(maxZ(half) - expected) / expected).toBeLessThan(0.15);
  });

  it('produces fewer vertices with a coarser gridStep', () => {
    const coarse = inflate(analysis, { gridStep: 16 });
    expect(coarse.positions.length).toBeLessThan(mesh.positions.length);
    expect(coarse.positions.length).toBeGreaterThan(0);
  });
});
