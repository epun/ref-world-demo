/**
 * QR encoder — pure, deterministic, dependency-free (PLAN §6.3 discipline:
 * the same input yields the same matrix everywhere, and nothing here touches
 * the DOM or Three.js, so the whole module is importable from node tests).
 *
 * Scope is exactly what the world's join code needs: BYTE mode, versions
 * 1–10, error-correction levels l and m. That covers any url this demo can
 * mint with room to spare, and keeps the tables small enough to read.
 *
 * Implements ISO/IEC 18004: mode + count header, terminator and pad bytes,
 * reed-solomon ec over GF(256), block interleaving, function-pattern layout,
 * zigzag data placement, all eight masks scored by the four penalty rules,
 * and BCH format/version information.
 *
 * Correctness is proven by decoding: test/ui/qr.test.ts runs the rendered
 * matrices back through an independent decoder (jsqr), so these tables are
 * checked against a real reader rather than against themselves.
 */

/** Error-correction level. Lowercase by house rule; l = 7%, m = 15%. */
export type EcLevel = 'l' | 'm';

/** Highest version this module encodes (17 + 4 × 10 = 57 modules). */
export const MAX_VERSION = 10;

/**
 * Per (version, level): ec codewords per block, then the block groups as
 * [blockCount, dataCodewordsPerBlock] pairs. Sums are asserted by test.
 */
const BLOCKS: Record<EcLevel, ([number, [number, number][]] | null)[]> = {
  // index 0 unused — versions are 1-based.
  l: [
    null,
    [7, [[1, 19]]],
    [10, [[1, 34]]],
    [15, [[1, 55]]],
    [20, [[1, 80]]],
    [26, [[1, 108]]],
    [18, [[2, 68]]],
    [20, [[2, 78]]],
    [24, [[2, 97]]],
    [30, [[2, 116]]],
    [18, [[2, 68], [2, 69]]],
  ],
  m: [
    null,
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
  ],
};

/** Alignment-pattern centre coordinates per version (1-based). */
const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Remainder bits appended after the interleaved codewords, per version. */
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

/** Format-info ec level bits (l = 01, m = 00 — not the level's own order). */
const LEVEL_BITS: Record<EcLevel, number> = { l: 0b01, m: 0b00 };

// ── GF(256) ──────────────────────────────────────────────────────────────────
// Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d), generator 2.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial of degree `degree`, coefficients high → low. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j]!, 1);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Reed-solomon remainder — the ec codewords for one block. */
export function ecCodewords(data: number[], count: number): number[] {
  const gen = generatorPoly(count);
  const rest = [...data, ...new Array<number>(count).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const lead = rest[i]!;
    if (lead === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      rest[i + j] = rest[i + j]! ^ gfMul(gen[j]!, lead);
    }
  }
  return rest.slice(data.length);
}

// ── data encoding ────────────────────────────────────────────────────────────

function dataCapacity(version: number, level: EcLevel): number {
  const entry = BLOCKS[level][version];
  if (!entry) return 0;
  return entry[1].reduce((sum, [blocks, per]) => sum + blocks * per, 0);
}

/**
 * Smallest version that fits `bytes`. Ties prefer the STRONGER level (m):
 * a bigger module is worth more than spare ec on a screen — a code that
 * needs a larger version at m is encoded at l instead, so the modules stay
 * as large as the corner allows.
 */
export function chooseFit(byteLength: number): { version: number; level: EcLevel } | null {
  for (let version = 1; version <= MAX_VERSION; version++) {
    for (const level of ['m', 'l'] as const) {
      const countBits = version < 10 ? 8 : 16;
      const needed = 4 + countBits + byteLength * 8;
      if (needed <= dataCapacity(version, level) * 8) return { version, level };
    }
  }
  return null;
}

/** utf-8 bytes of a string, without depending on TextEncoder's presence. */
export function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

/** Header + payload + terminator + pad, as whole codewords. */
function dataCodewords(bytes: number[], version: number, level: EcLevel): number[] {
  const capacity = dataCapacity(version, level);
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  // Terminator: up to four zeros, then zero-fill to the codeword boundary.
  const room = capacity * 8 - bits.length;
  push(0, Math.min(4, room));
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    out.push(byte);
  }
  // Alternating pad bytes to capacity.
  const PAD = [0xec, 0x11];
  while (out.length < capacity) out.push(PAD[(out.length - bits.length / 8) % 2]!);
  return out;
}

/** Split into blocks, add ec, interleave (data then ec), per the spec. */
function interleave(data: number[], version: number, level: EcLevel): number[] {
  const entry = BLOCKS[level][version]!;
  const [ecPerBlock, groups] = entry;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const [blockCount, per] of groups) {
    for (let b = 0; b < blockCount; b++) {
      const block = data.slice(at, at + per);
      at += per;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, ecPerBlock));
    }
  }
  const out: number[] = [];
  const widest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < widest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return out;
}

// ── matrix ───────────────────────────────────────────────────────────────────

/** true = dark module. */
export type QrMatrix = boolean[][];

function emptyMatrix(size: number): (boolean | null)[][] {
  return Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
}

function placeFinder(m: (boolean | null)[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr]![cc] = edge ? false : ring || core;
    }
  }
}

function placeFunctionPatterns(m: (boolean | null)[][], version: number): void {
  const size = m.length;
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    m[6]![i] = dark;
    m[i]![6] = dark;
  }

  // Alignment patterns, skipping the three finder corners.
  const centres = ALIGNMENT[version] ?? [];
  for (const r of centres) {
    for (const c of centres) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr]![c + dc] = ring !== 1;
        }
      }
    }
  }

  // Dark module.
  m[size - 8]![8] = true;

  // Reserve the format areas (filled later).
  for (let i = 0; i <= 8; i++) {
    if (m[8]![i] === null) m[8]![i] = false;
    if (m[i]![8] === null) m[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8]![size - 1 - i] === null) m[8]![size - 1 - i] = false;
    if (m[size - 1 - i]![8] === null) m[size - 1 - i]![8] = false;
  }
  // Reserve the version areas (v7+).
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m[size - 11 + j]![i] = false;
        m[i]![size - 11 + j] = false;
      }
    }
  }
}

/** Upward-then-downward zigzag over the free modules, right to left. */
function placeData(m: (boolean | null)[][], codewords: number[], remainder: number): void {
  const size = m.length;
  const bits: number[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  for (let i = 0; i < remainder; i++) bits.push(0);

  let at = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right === 6 ? right - 1 : right; // column 6 is the timing line
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (m[row]![c] !== null) continue;
        m[row]![c] = at < bits.length ? bits[at]! === 1 : false;
        at++;
      }
    }
    upward = !upward;
    if (right === 6) right--; // skip past the timing column cleanly
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules; lower total is a better-looking, safer code. */
export function maskPenalty(m: QrMatrix): number {
  const size = m.length;
  let penalty = 0;

  // Rule 1 — runs of five or more same-colour modules in a line.
  for (const byRow of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const prev = byRow ? m[a]![b - 1]! : m[b - 1]![a]!;
        const cur = byRow ? m[a]![b]! : m[b]![a]!;
        if (cur === prev) {
          run++;
          if (run === 5) penalty += 3;
          else if (run > 5) penalty += 1;
        } else run = 1;
      }
    }
  }

  // Rule 2 — every 2×2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c]!;
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) penalty += 3;
    }
  }

  // Rule 3 — finder-like 1:1:3:1:1 patterns with four light modules beside.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  for (const byRow of [true, false]) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 11 <= size; b++) {
        let matchA = true;
        let matchB = true;
        for (let k = 0; k < 11; k++) {
          const v = byRow ? m[a]![b + k]! : m[b + k]![a]!;
          if (v !== A[k]) matchA = false;
          if (v !== B[k]) matchB = false;
        }
        if (matchA) penalty += 40;
        if (matchB) penalty += 40;
      }
    }
  }

  // Rule 4 — deviation of the dark-module share from half.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return penalty;
}

/** BCH(15,5) format information, already xor-masked. */
export function formatBits(level: EcLevel, mask: number): number {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rest = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rest >> i) & 1) rest ^= 0b101_0011_0111 << (i - 10);
  }
  return ((data << 10) | rest) ^ 0b101_0100_0001_0010;
}

/** BCH(18,6) version information (versions 7+). */
export function versionBits(version: number): number {
  let rest = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rest >> i) & 1) rest ^= 0b1_1111_0010_0101 << (i - 12);
  }
  return (version << 12) | rest;
}

function applyFormatAndVersion(
  m: QrMatrix,
  reserved: boolean[][],
  version: number,
  level: EcLevel,
  mask: number,
): void {
  const size = m.length;
  const bits = formatBits(level, mask);
  // Index 0 is the MOST significant bit: (8,0) takes the head of the
  // 15-bit string, not its tail. (Verified against a reference encoder —
  // reading it the other way put the whole format strip in backwards while
  // the entire data region matched.)
  const bit = (i: number): boolean => ((bits >> (14 - i)) & 1) === 1;
  // Copy 1 — around the top-left finder.
  for (let i = 0; i <= 5; i++) m[8]![i] = bit(i);
  m[8]![7] = bit(6);
  m[8]![8] = bit(7);
  m[7]![8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i]![8] = bit(i);
  // Copy 2 — split across the other two finders.
  for (let i = 0; i <= 7; i++) m[size - 1 - i]![8] = bit(i);
  for (let i = 8; i <= 14; i++) m[8]![size - 15 + i] = bit(i);
  m[size - 8]![8] = true; // dark module survives the format write

  if (version >= 7) {
    const vbits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((vbits >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      m[r]![c] = on;
      m[c]![r] = on;
    }
  }
  void reserved;
}

/**
 * Encode `text` as a QR matrix (true = dark). Returns null only when the
 * text cannot fit MAX_VERSION at level l — far past anything this world
 * mints.
 */
export function encodeQr(
  text: string,
  force?: { version: number; level: EcLevel; mask?: number },
): QrMatrix | null {
  const bytes = utf8Bytes(text);
  const fit = force ?? chooseFit(bytes.length);
  if (!fit) return null;
  const { version, level } = fit;
  const size = 17 + 4 * version;

  const working = emptyMatrix(size);
  placeFunctionPatterns(working, version);
  // Remember which modules are function patterns — masks skip them.
  const reserved = working.map((row) => row.map((v) => v !== null));
  placeData(working, interleave(dataCodewords(bytes, version, level), version, level), REMAINDER_BITS[version]!);

  let best: QrMatrix | null = null;
  let bestPenalty = Infinity;
  let bestMask = 0;
  const masks = force?.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [force.mask];
  for (const mask of masks) {
    const candidate: QrMatrix = working.map((row, r) =>
      row.map((v, c) => {
        const on = v === true;
        return reserved[r]![c] ? on : on !== MASKS[mask]!(r, c);
      }),
    );
    applyFormatAndVersion(candidate, reserved, version, level, mask);
    const penalty = maskPenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = candidate;
      bestMask = mask;
    }
  }
  void bestMask;
  return best;
}
