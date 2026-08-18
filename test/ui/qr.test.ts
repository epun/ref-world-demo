/**
 * QR encoder tests. The load-bearing ones DECODE: every matrix goes back
 * through jsqr (an independent reader, devDependency, tests only) so the
 * spec tables here are checked against a real decoder rather than against
 * themselves.
 */

import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import {
  chooseFit,
  ecCodewords,
  encodeQr,
  formatBits,
  MAX_VERSION,
  utf8Bytes,
  versionBits,
  type QrMatrix,
} from '../../src/ui/qr';

/** Render a matrix to an rgba buffer with a quiet zone, for the decoder. */
function toRgba(matrix: QrMatrix, scale = 4, quiet = 4): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const modules = matrix.length + quiet * 2;
  const size = modules * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (!matrix[r]![c]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = (c + quiet) * scale + x;
          const py = (r + quiet) * scale + y;
          const i = (py * size + px) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

function decode(matrix: QrMatrix): string | null {
  const { data, width, height } = toRgba(matrix);
  return jsQR(data, width, height)?.data ?? null;
}

describe('encodeQr', () => {
  it('round-trips the join url a room actually mints', () => {
    const url = 'https://ref-world-demo.vercel.app/draw/?room=cfaa';
    const matrix = encodeQr(url);
    expect(matrix).not.toBeNull();
    expect(decode(matrix!)).toBe(url);
  });

  it('round-trips every room code shape through a real decoder', () => {
    for (const room of ['abcd', 'zzzz', 'gjce', 'udnr']) {
      const url = `https://ref-world-demo.vercel.app/draw/?room=${room}`;
      expect(decode(encodeQr(url)!), room).toBe(url);
    }
  });

  it('round-trips across every version and level it claims to support', () => {
    // One payload per version: grow the text until chooseFit steps up.
    const seen = new Set<number>();
    for (let n = 8; n <= 240; n += 7) {
      const text = 'https://ref-world-demo.vercel.app/draw/?room=' + 'a'.repeat(n);
      const fit = chooseFit(utf8Bytes(text).length);
      if (!fit) break;
      const matrix = encodeQr(text);
      expect(matrix, `v${fit.version}${fit.level}`).not.toBeNull();
      expect(matrix!.length, `v${fit.version} size`).toBe(17 + 4 * fit.version);
      expect(decode(matrix!), `v${fit.version}${fit.level} (${text.length} chars)`).toBe(text);
      seen.add(fit.version);
    }
    // The sweep must actually exercise a spread of versions, not just v3.
    expect(seen.size).toBeGreaterThanOrEqual(6);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(8);
  });

  it('round-trips multi-byte utf-8 (interleaving across blocks)', () => {
    const text = 'https://ref-world-demo.vercel.app/draw/?room=cfaa — 🥚 draw a creature';
    expect(decode(encodeQr(text)!)).toBe(text);
  });

  it('is deterministic — the same text yields the identical matrix', () => {
    const a = encodeQr('https://ref-world-demo.vercel.app/draw/?room=abcd');
    const b = encodeQr('https://ref-world-demo.vercel.app/draw/?room=abcd');
    expect(a).toEqual(b);
  });

  it('returns null only past its declared ceiling', () => {
    // v10-l holds 271 payload bytes; past that the module bows out.
    expect(encodeQr('x'.repeat(250))).not.toBeNull();
    expect(chooseFit(100000)).toBeNull();
    expect(encodeQr('x'.repeat(100000))).toBeNull();
  });

  it('carries the finder patterns at all three corners', () => {
    const m = encodeQr('https://ref-world-demo.vercel.app/draw/?room=abcd')!;
    const size = m.length;
    for (const [r0, c0] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      expect(m[r0]![c0]).toBe(true);
      expect(m[r0 + 1]![c0 + 1]).toBe(false);
      expect(m[r0 + 3]![c0 + 3]).toBe(true);
    }
    // The dark module is mandatory and never masked away.
    expect(m[size - 8]![8]).toBe(true);
  });
});

describe('qr internals', () => {
  it('chooseFit picks the smallest version, preferring the stronger level', () => {
    // 20 bytes fits v1-l (19 data codewords → 17 bytes) at v2 instead.
    expect(chooseFit(10)).toEqual({ version: 1, level: 'm' });
    expect(chooseFit(16)).toEqual({ version: 1, level: 'l' });
    expect(chooseFit(49)).toEqual({ version: 3, level: 'l' });
    expect(chooseFit(200)?.version).toBeLessThanOrEqual(MAX_VERSION);
  });

  it('reed-solomon matches the worked example from the spec', () => {
    // ISO/IEC 18004 annex example: the v1-m 'HELLO WORLD' data block.
    const data = [
      0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96,
      0x70, 0xec,
    ];
    expect(ecCodewords(data, 10)).toEqual([
      0xbc, 0x2a, 0x90, 0x13, 0x6b, 0xaf, 0xef, 0xfd, 0x4b, 0xe0,
    ]);
  });

  it('format bits match the published table', () => {
    // Level m, mask 0 → 101010000010010 (spec table C.1).
    expect(formatBits('m', 0)).toBe(0b101010000010010);
    // Level l, mask 5 → 110001100011000.
    expect(formatBits('l', 5)).toBe(0b110001100011000);
  });

  it('version bits match the published table', () => {
    // Canonical version-information words (iso/iec 18004 annex d).
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(9)).toBe(0x09a99);
    expect(versionBits(10)).toBe(0x0a4d3);
  });

  it('utf8Bytes encodes ascii, latin, and astral planes', () => {
    expect(utf8Bytes('ab')).toEqual([0x61, 0x62]);
    expect(utf8Bytes('é')).toEqual([0xc3, 0xa9]);
    expect(utf8Bytes('🥚')).toEqual([0xf0, 0x9f, 0xa5, 0x9a]);
  });
});
