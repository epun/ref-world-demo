/**
 * taste gate: static scans (TASTE §7).
 *
 * "a constraint that isn't a button doesn't survive a build." this script is
 * the build-time button: it scans repo source and fails the build on
 *
 *   1. uppercase   — user-facing string literals with runs of 2+ capitals
 *                    (the taste forbids uppercase anywhere, confidence 1.00)
 *   2. hex         — hex color literals outside src/taste/tokens.ts
 *                    (every color must come from tokens)
 *   3. motion      — scale-from-zero entrances, linear/ease-in-out easings,
 *                    underdamped zeta literals, animation library imports
 *                    (overshoot/bounce/cut are forbidden at confidence 1.00)
 *
 * escape hatches, each on the line PRECEDING the flagged one:
 *   // gate-allow-uppercase   // gate-allow-hex   // gate-allow-motion
 *
 * run: npm run gate:static   (exit 0 when clean, 1 with a violation table)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

interface Violation {
  file: string;
  line: number;
  check: 'uppercase' | 'hex' | 'motion';
  message: string;
}

const violations: Violation[] = [];

// ── file discovery ───────────────────────────────────────────────────────────

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      walk(path, out);
    } else if (path.endsWith('.ts') || path.endsWith('.html')) {
      out.push(path);
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];
  const srcDir = join(ROOT, 'src');
  if (existsSync(srcDir)) walk(srcDir, files);
  // root-level html entry points (index.html, phone.html) are user-facing too
  for (const name of readdirSync(ROOT)) {
    if (name.endsWith('.html')) files.push(join(ROOT, name));
  }
  return files;
}

// ── comment masking ──────────────────────────────────────────────────────────
// comments are blanked to spaces (newlines kept) so that doc references like
// "TASTE §7" or hex values in jsdoc are never flagged, while every match still
// reports its true line number.

function maskTsComments(source: string): string {
  const out = source.split('');
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && n === '/') {
          state = 'line';
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === '/' && n === '*') {
          state = 'block';
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        break;
      case 'line':
        if (c === '\n') state = 'code';
        else out[i] = ' ';
        break;
      case 'block':
        if (c === '*' && n === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          state = 'code';
          i += 2;
          continue;
        }
        if (c !== '\n') out[i] = ' ';
        break;
      case 'single':
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === "'" || c === '\n') state = 'code';
        break;
      case 'double':
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"' || c === '\n') state = 'code';
        break;
      case 'template':
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '`') state = 'code';
        break;
    }
    i++;
  }
  return out.join('');
}

function maskHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** blank a region's non-newline chars, preserving line numbers. */
function blankRegions(source: string, re: RegExp): string {
  return source.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

// ── helpers ──────────────────────────────────────────────────────────────────

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

/** the escape hatch: a gate-allow comment on the line preceding the match. */
function allowedByComment(rawLines: string[], line: number, kind: string): boolean {
  const prev = line >= 2 ? (rawLines[line - 2] ?? '') : '';
  return prev.includes(`gate-allow-${kind}`) || /gate-allow(?![-\w])/.test(prev);
}

/**
 * find a run of 2+ uppercase letters in a user-facing string, ignoring
 * allow-listed substrings: template interpolations (code identifiers like
 * `${SURFACE.canvas}`, not copy), urls, and hex colors.
 */
function uppercaseRun(value: string): string | null {
  const cleaned = value
    .replace(/\$\{[^}]*\}/g, ' ') // template interpolations are code
    .replace(/\b[a-zA-Z][\w+.-]*:\/\/[^\s'"]+/g, ' ') // urls (any scheme)
    .replace(/\bwww\.[^\s'"]+/g, ' ')
    .replace(/#[0-9a-fA-F]{3,8}\b/g, ' '); // hex colors
  const m = cleaned.match(/[A-Z]{2,}/);
  return m ? m[0] : null;
}

/** glsl blocks announce themselves with precision/uniform declarations. */
function looksLikeGlsl(value: string): boolean {
  return /\b(?:precision|uniform)\b/.test(value);
}

/**
 * a stylesheet assigned to style.textContent is code, not copy — detect the
 * `selector { prop: value; }` shape.
 */
function looksLikeCss(value: string): boolean {
  return /\{[^{}]*:[^{}]*;[^{}]*\}/.test(value);
}

// ── check 1: uppercase in user-facing strings ────────────────────────────────
// heuristic scope for .ts files: only string literals assigned to text-bearing
// properties (textContent, innerHTML, title, label, aria-label, ...) are
// user-facing. everything else — identifiers, keys, shader code, log strings —
// is left alone to keep false positives sane.

const TS_TEXT_ASSIGN =
  /\b(?:textContent|innerHTML|innerText|title|label|ariaLabel|placeholder|alt)\s*[:=](?!=)\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
const TS_SET_ATTRIBUTE =
  /\bsetAttribute\(\s*['"](?:title|label|aria-label|alt|placeholder)['"]\s*,\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

function scanUppercaseTs(file: string, rawLines: string[], masked: string): void {
  for (const re of [TS_TEXT_ASSIGN, TS_SET_ATTRIBUTE]) {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re)) {
      const value = m[2] ?? '';
      if (looksLikeGlsl(value) || looksLikeCss(value)) continue;
      const run = uppercaseRun(value);
      if (!run) continue;
      const line = lineAt(masked, m.index ?? 0);
      if (allowedByComment(rawLines, line, 'uppercase')) continue;
      violations.push({
        file,
        line,
        check: 'uppercase',
        message: `"${run}" in user-facing string — the taste has no uppercase, anywhere (TASTE §5)`,
      });
    }
  }
}

const HTML_TEXT_ATTR =
  /\b(?:title|aria-label|alt|placeholder|label)\s*=\s*(["'])((?:(?!\1)[\s\S])*?)\1/g;

function scanUppercaseHtml(file: string, rawLines: string[], masked: string): void {
  // text nodes — with script/style bodies blanked (style is css, script is
  // handled by the ts heuristics when it matters; neither is html "text")
  const textOnly = blankRegions(
    blankRegions(masked, /<script\b[\s\S]*?<\/script>/gi),
    /<style\b[\s\S]*?<\/style>/gi,
  );
  for (const m of textOnly.matchAll(/>([^<>]+)</g)) {
    const value = m[1] ?? '';
    const run = uppercaseRun(value);
    if (!run) continue;
    const offset = (m.index ?? 0) + 1;
    const line = lineAt(textOnly, offset);
    if (allowedByComment(rawLines, line, 'uppercase')) continue;
    violations.push({
      file,
      line,
      check: 'uppercase',
      message: `"${run}" in html text — the taste has no uppercase, anywhere (TASTE §5)`,
    });
  }
  // user-facing attributes
  for (const m of masked.matchAll(HTML_TEXT_ATTR)) {
    const value = m[2] ?? '';
    const run = uppercaseRun(value);
    if (!run) continue;
    const line = lineAt(masked, m.index ?? 0);
    if (allowedByComment(rawLines, line, 'uppercase')) continue;
    violations.push({
      file,
      line,
      check: 'uppercase',
      message: `"${run}" in html attribute — the taste has no uppercase, anywhere (TASTE §5)`,
    });
  }
}

// ── check 2: hex color literals outside tokens.ts ────────────────────────────

const HEX_LITERAL = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;

function scanHex(file: string, rel: string, rawLines: string[], masked: string): void {
  if (rel === join('src', 'taste', 'tokens.ts')) return; // the one legal home
  for (const m of masked.matchAll(HEX_LITERAL)) {
    const line = lineAt(masked, m.index ?? 0);
    if (allowedByComment(rawLines, line, 'hex')) continue;
    violations.push({
      file,
      line,
      check: 'hex',
      message: `hex literal ${m[0]} — every color comes from src/taste/tokens.ts`,
    });
  }
}

// ── check 3: forbidden motion ────────────────────────────────────────────────

const MOTION_PATTERNS: { re: RegExp; message: string }[] = [
  {
    re: /\bscale\s*:\s*0(?![\d.])/g,
    message: 'scale-from-zero entrance — entrances slide, they do not pop (TASTE §2.1)',
  },
  {
    re: /\bscale\(\s*0(?:\.0+)?\s*\)/g,
    message: 'scale(0) entrance — entrances slide, they do not pop (TASTE §2.1)',
  },
  {
    re: /animation-timing-function\s*:\s*(?:linear|ease-in-out)\b/g,
    message: 'linear/ease-in-out timing function — motion drifts on the settle curve (TASTE §2.1)',
  },
  {
    re: /(['"])(?:linear|ease-in-out)\1/g,
    message: 'linear/ease-in-out easing string — motion drifts on the settle curve (TASTE §2.1)',
  },
  {
    re: /\b(?:transition|animation)\s*:[^;{}\n]*\b(?:linear|ease-in-out)\b/g,
    message: 'linear/ease-in-out in css shorthand — motion drifts on the settle curve (TASTE §2.1)',
  },
  {
    re: /\bzeta\s*[:=]\s*0?\.\d+/g,
    message: 'zeta literal below 1 — underdamped springs bounce, and bounce is forbidden at confidence 1.00',
  },
  {
    re: /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:framer-motion|gsap|motion|popmotion|animejs|anime|react-spring|@react-spring\/[^'"]+|@tweenjs\/tween\.js|tween\.js|es6-tween|tweenjs)(?:\/[^'"]*)?['"]/g,
    message: 'animation library import — all motion goes through src/motion/spring.ts',
  },
];

function scanMotion(file: string, rawLines: string[], masked: string): void {
  for (const { re, message } of MOTION_PATTERNS) {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re)) {
      const line = lineAt(masked, m.index ?? 0);
      if (allowedByComment(rawLines, line, 'motion')) continue;
      violations.push({ file, line, check: 'motion', message });
    }
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

const files = collectFiles();

for (const path of files) {
  const rel = relative(ROOT, path);
  const raw = readFileSync(path, 'utf8');
  const rawLines = raw.split('\n');
  if (path.endsWith('.html')) {
    const masked = maskHtmlComments(raw);
    scanUppercaseHtml(rel, rawLines, masked);
    scanMotion(rel, rawLines, masked);
  } else {
    const masked = maskTsComments(raw);
    scanUppercaseTs(rel, rawLines, masked);
    if (rel.startsWith('src')) scanHex(rel, rel, rawLines, masked);
    scanMotion(rel, rawLines, masked);
  }
}

if (violations.length === 0) {
  console.log(`gate:static clean — ${files.length} files scanned, 0 violations`);
  process.exit(0);
}

violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

const locWidth = Math.max(...violations.map((v) => `${v.file}:${v.line}`.length), 8);
const checkWidth = Math.max(...violations.map((v) => v.check.length), 5);

console.log('gate:static — taste violations\n');
console.log(`${'location'.padEnd(locWidth)}  ${'check'.padEnd(checkWidth)}  detail`);
console.log(`${'-'.repeat(locWidth)}  ${'-'.repeat(checkWidth)}  ${'-'.repeat(6)}`);
for (const v of violations) {
  console.log(`${`${v.file}:${v.line}`.padEnd(locWidth)}  ${v.check.padEnd(checkWidth)}  ${v.message}`);
}
console.log(`\n${violations.length} violation(s). see docs/TASTE.md §7 for the gates and the escape hatches.`);
process.exit(1);
