/**
 * A world's own page.
 *
 * `worlds/<name>/index.html` is the address a client is actually sent — the
 * link, the card it unfurls into, the thing on a slide. It is generated
 * (scripts/new-world.mjs) and therefore is exactly the kind of file nobody
 * rereads, and it is the one file whose mistakes are visible to somebody
 * who never opens the app: a stale og:url points a client at the previous
 * client's world, and a meta tag that disagrees with its folder name is a
 * page that shows a different world than its url says.
 *
 * So the checks run against every page in the folder rather than against a
 * fixture, and once more against a page the script writes here and now — a
 * template whose output stops passing has stopped being a template.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const WORLDS = join(ROOT, 'worlds');
const SCRIPT = join(ROOT, 'scripts', 'new-world.mjs');

/** the rule in docs/PUBLIC.md §urls, and the one the app sanitises with. */
const NAME_RULE = /^[a-z0-9-]{1,24}$/;

function metaContent(html: string, attr: 'name' | 'property', key: string): string | null {
  const re = new RegExp(`<meta\\s+${attr}="${key}"[\\s\\S]*?content="([^"]*)"`, 'i');
  return re.exec(html)?.[1] ?? null;
}

/** the same assertions for a committed page and for a freshly generated one. */
function checkPage(name: string, html: string): void {
  // the page's world is the folder it lives in. if these drift, /worlds/a/
  // quietly shows world b.
  expect(metaContent(html, 'name', 'refworld:world')).toBe(name);
  expect(name).toMatch(NAME_RULE);

  // the card points at itself, not at whatever world was templated before.
  expect(metaContent(html, 'property', 'og:url')).toBe(
    `https://ref-world-demo.vercel.app/worlds/${name}/`,
  );

  // no uppercase, anywhere (TASTE §5) — including the two strings that only
  // ever appear outside the app, in a browser tab and in a link preview.
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  expect(title).not.toBe('');
  expect(title).not.toMatch(/[A-Z]/);
  const description = metaContent(html, 'property', 'og:description') ?? '';
  expect(description).not.toBe('');
  expect(description).not.toMatch(/[A-Z]/);

  // it is the same app, loaded by absolute path so a page one folder down
  // resolves it identically to index.html.
  expect(html).toContain('src="/src/main.ts"');
  expect(html).toContain('src="/vendor/mqtt.min.js"');
}

function worldDirs(): string[] {
  if (!existsSync(WORLDS)) return [];
  return readdirSync(WORLDS).filter((n) => statSync(join(WORLDS, n)).isDirectory());
}

describe('worlds/<name>/index.html — a page per world', () => {
  const names = worldDirs();

  it('there is at least one, and meridian is it', () => {
    expect(names).toContain('meridian');
  });

  for (const name of names) {
    it(`${name} declares itself, and only itself`, () => {
      const page = join(WORLDS, name, 'index.html');
      expect(existsSync(page)).toBe(true);
      checkPage(name, readFileSync(page, 'utf8'));
    });
  }
});

describe('scripts/new-world.mjs — the next client is one command', () => {
  function run(args: string[]): { status: number; out: string } {
    try {
      const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('writes a page that passes every check the committed ones do', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-world-'));
    try {
      const { status, out } = run(['orbiter-two', '--out', dir]);
      expect(status).toBe(0);
      // it tells you the three things you need next: the link, the phone's
      // link (the same one), and how to put a population in.
      expect(out).toContain('https://ref-world-demo.vercel.app/worlds/orbiter-two/');
      expect(out).toContain('node scripts/seed-world.mjs');

      const page = join(dir, 'orbiter-two', 'index.html');
      expect(existsSync(page)).toBe(true);
      checkPage('orbiter-two', readFileSync(page, 'utf8'));

      // a second run does not silently replace a live client's page…
      expect(run(['orbiter-two', '--out', dir]).status).toBe(1);
      // …unless it is asked to.
      expect(run(['orbiter-two', '--out', dir, '--force']).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a name the app would have sanitised into a different world', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-world-'));
    try {
      for (const bad of ['Meridian', 'meridian world', 'a'.repeat(25), '']) {
        expect(run(bad ? [bad, '--out', dir] : ['--out', dir]).status).toBe(1);
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
