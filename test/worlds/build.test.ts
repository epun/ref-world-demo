/**
 * Which world a build is for, how it starts, and what that does to the html.
 *
 * A client's world is its own deployment of this repo, so the difference
 * between deployments is decided at build time and baked into index.html —
 * the card is read by crawlers that never run the app. That makes this the
 * one seam whose mistakes are invisible until somebody pastes a link: a
 * wrong og:url points a client at another world, and a world resolving
 * where it should not have would put a client's name on the public site.
 *
 * So the two properties pinned hardest here are the negative ones: an
 * unknown host resolves to nothing, and resolving to nothing leaves the
 * html byte-identical to the file on disk.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RESIDENTS,
  applyWorldToHtml,
  normalizeHost,
  readWorlds,
  resolveWorld,
  sanitizeResidents,
  sanitizeWorldName,
} from '../../scripts/world-build.mjs';
import { residentsFrom } from '../../src/world/residents';

const ROOT = resolve(__dirname, '..', '..');
const INDEX = readFileSync(join(ROOT, 'index.html'), 'utf8');
const WORLDS = readWorlds(join(ROOT, 'worlds.json'));
/** the rule in docs/PUBLIC.md §urls. */
const NAME_RULE = /^[a-z0-9-]{1,24}$/;

describe('worlds.json — one entry per deployment', () => {
  it('names worlds the app would read back unchanged, at real hostnames', () => {
    const entries = Object.entries(WORLDS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, config] of entries) {
      expect(name).toMatch(NAME_RULE);
      expect(sanitizeWorldName(name)).toBe(name);
      expect(config.host).toBe(config.host.toLowerCase());
      expect(config.host).toContain('.');
      expect(RESIDENTS).toContain(config.residents);
    }
  });

  it('one hostname belongs to one world', () => {
    const hosts = Object.values(WORLDS).map((w) => w.host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('knows meridian, empty on purpose, and does not know the public site', () => {
    expect(WORLDS['meridian']).toEqual({
      host: 'ref-world-meridian.vercel.app',
      residents: 'none',
    });
    // the public site is absent on purpose: it is the world without an
    // entry, and nothing a client adds may change what it builds.
    expect(Object.values(WORLDS).some((w) => w.host === 'ref-world-demo.vercel.app')).toBe(false);
  });
});

describe('resolveWorld — what world is this build for', () => {
  it('is nothing for the public deployment', () => {
    expect(
      resolveWorld({ VERCEL_PROJECT_PRODUCTION_URL: 'ref-world-demo.vercel.app' }, WORLDS),
    ).toBe(null);
  });

  it('is nothing when there is no host and no override at all', () => {
    // a bare local build is the public site. it has to be, or a checkout
    // would build somebody's client world by accident.
    expect(resolveWorld({}, WORLDS)).toBe(null);
  });

  it('reads the deployment its own production hostname, settings and all', () => {
    expect(
      resolveWorld({ VERCEL_PROJECT_PRODUCTION_URL: 'ref-world-meridian.vercel.app' }, WORLDS),
    ).toEqual({
      name: 'meridian',
      host: 'ref-world-meridian.vercel.app',
      residents: 'none',
    });
  });

  it('lets the env override win, so a world can be looked at locally', () => {
    // VITE_WORLD=meridian npm run dev, before any deployment exists. the
    // host and the setting come from the file rather than being invented,
    // so what renders locally is what the deployment will render.
    expect(resolveWorld({ VITE_WORLD: 'meridian' }, WORLDS)).toEqual({
      name: 'meridian',
      host: 'ref-world-meridian.vercel.app',
      residents: 'none',
    });
  });

  it('works for a world the file has never heard of, on the defaults', () => {
    // trying a name out should not require editing a checked-in file.
    expect(resolveWorld({ VITE_WORLD: 'harbour' }, WORLDS)).toEqual({
      name: 'harbour',
      host: 'ref-world-harbour.vercel.app',
      residents: 'shipped',
    });
  });

  it('the override beats the hostname, not the other way round', () => {
    const world = resolveWorld(
      { VITE_WORLD: 'harbour', VERCEL_PROJECT_PRODUCTION_URL: 'ref-world-meridian.vercel.app' },
      WORLDS,
    );
    expect(world?.name).toBe('harbour');
  });

  it('sanitises an override the same way the app would', () => {
    // otherwise the injected tag and the app's own reading of it could name
    // two different worlds.
    expect(resolveWorld({ VITE_WORLD: 'Meridian!' }, WORLDS)?.name).toBe('meridian');
    expect(resolveWorld({ VITE_WORLD: '!!!' }, WORLDS)).toBe(null);
    expect(resolveWorld({ VITE_WORLD: 'a'.repeat(40) }, WORLDS)?.name).toHaveLength(24);
  });

  it('takes a hostname however it was written', () => {
    expect(normalizeHost('https://Ref-World-Meridian.vercel.app/x')).toBe(
      'ref-world-meridian.vercel.app',
    );
    expect(
      resolveWorld(
        { VERCEL_PROJECT_PRODUCTION_URL: 'https://ref-world-meridian.vercel.app/' },
        WORLDS,
      )?.name,
    ).toBe('meridian');
  });

  it('lets an explicit site url name the host in the card', () => {
    // for the custom domain, once there is one.
    const world = resolveWorld(
      { VITE_WORLD: 'meridian', VITE_SITE_URL: 'https://meridian.example/' },
      WORLDS,
    );
    expect(world?.host).toBe('meridian.example');
  });
});

describe('residents — only the word asked for empties a world', () => {
  it('reads the tag, and its absence', () => {
    expect(residentsFrom('none')).toBe('none');
    expect(residentsFrom(' NONE ')).toBe('none');
    // the public page injects no tag at all, so absent must mean shipped.
    expect(residentsFrom(null)).toBe('shipped');
    expect(residentsFrom('')).toBe('shipped');
    expect(residentsFrom('shipped')).toBe('shipped');
  });

  it('a typo populates rather than empties, on both sides of the build', () => {
    // this setting decides whether a world has anything in it. a misspelling
    // in a config file must not be able to clear one.
    expect(residentsFrom('non')).toBe('shipped');
    expect(residentsFrom('empty')).toBe('shipped');
    expect(sanitizeResidents('non')).toBe('shipped');
    expect(sanitizeResidents(undefined)).toBe('shipped');
    expect(sanitizeResidents('none')).toBe('none');
  });

  it('the two sides agree about every value either can produce', () => {
    for (const value of [...RESIDENTS, 'nonsense', '']) {
      expect(residentsFrom(value)).toBe(sanitizeResidents(value));
    }
  });
});

describe('the html transform', () => {
  it('leaves the public build byte-identical', () => {
    // the property this whole design rests on: adding a client cannot
    // change the site everyone else sees.
    expect(applyWorldToHtml(INDEX, null)).toBe(INDEX);
  });

  const out = applyWorldToHtml(INDEX, {
    name: 'meridian',
    host: 'ref-world-meridian.vercel.app',
    residents: 'none',
  });

  it('tells the app which world it is in', () => {
    expect(out).toContain('<meta name="refworld:world" content="meridian" />');
  });

  it('tells a clean world to skip the shipped population', () => {
    expect(out).toContain('<meta name="refworld:residents" content="none" />');
    expect(residentsFrom(/refworld:residents" content="([^"]*)"/.exec(out)?.[1] ?? null)).toBe(
      'none',
    );
  });

  it('says nothing about residents for a world that keeps them', () => {
    // an absent tag is the default, so a world on the default adds no line
    // — the public html keeps not mentioning a setting it does not have.
    const shipped = applyWorldToHtml(INDEX, {
      name: 'harbour',
      host: 'ref-world-harbour.vercel.app',
      residents: 'shipped',
    });
    expect(shipped).not.toContain('refworld:residents');
    expect(shipped).toContain('<meta name="refworld:world" content="harbour" />');
  });

  it('puts the world in the tab and on the card', () => {
    expect(out).toContain('<title>ref world · meridian</title>');
    expect(out).toContain('<meta property="og:title" content="meridian" />');
    expect(out).toContain('<meta name="twitter:title" content="meridian" />');
    expect(out).toContain('content="https://ref-world-meridian.vercel.app/"');
    expect(out).toContain(
      'content="a world for meridian. draw a creature on your phone and it hatches somewhere everyone can see."',
    );
    // both descriptions, not just the open-graph one.
    expect(out.match(/a world for meridian\./g)).toHaveLength(2);
  });

  it('keeps the card image, which is a real frame of the same pipeline', () => {
    expect(out).toContain('content="https://ref-world-demo.vercel.app/og.png"');
    // and nothing of the public world's own identity survives.
    expect(out).not.toContain('?world=public');
    expect(out).not.toContain('it hatches into a world everyone can see');
  });

  it('writes no uppercase into anything a person reads (TASTE §5)', () => {
    // the tab, the injected tags, and every string the card shows.
    const read = [
      /<title>([\s\S]*?)<\/title>/i.exec(out)?.[1],
      /<meta name="refworld:world" content="([^"]*)"/.exec(out)?.[1],
      /<meta name="refworld:residents" content="([^"]*)"/.exec(out)?.[1],
      /og:title" content="([^"]*)"/.exec(out)?.[1],
      /twitter:title" content="([^"]*)"/.exec(out)?.[1],
      /og:description"[\s\S]*?content="([^"]*)"/.exec(out)?.[1],
      /twitter:description"[\s\S]*?content="([^"]*)"/.exec(out)?.[1],
    ];
    expect(read.filter(Boolean)).toHaveLength(7);
    for (const value of read) expect(value).not.toMatch(/[A-Z]/);
  });

  it('is still one html document, structurally', () => {
    // a transform that duplicated the head or dropped the app would pass
    // every assertion above.
    expect(out.match(/<title>/g)).toHaveLength(1);
    expect(out).toContain('<script type="module" src="/src/main.ts"></script>');
    expect(out).toContain('<canvas id="world"></canvas>');
  });
});

describe('scripts/new-world.mjs — the worlds.json entry is the only file it writes', () => {
  const SCRIPT = join(ROOT, 'scripts', 'new-world.mjs');

  function run(args: string[]): { status: number; out: string } {
    try {
      return {
        status: 0,
        out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }),
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  it('adds a world, is idempotent, and prints the recipe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-world-'));
    const file = join(dir, 'worlds.json');
    try {
      writeFileSync(file, JSON.stringify({ worlds: {} }, null, 2));

      const first = run(['harbour', '--file', file]);
      expect(first.status).toBe(0);
      expect(readWorlds(file)).toEqual({
        harbour: { host: 'ref-world-harbour.vercel.app', residents: 'shipped' },
      });
      // the parts that are a dashboard rather than a file.
      expect(first.out).toContain('https://ref-world-harbour.vercel.app/');
      expect(first.out).toContain(
        'node scripts/seed-world.mjs https://ref-world-harbour.vercel.app harbour',
      );
      expect(first.out).toContain('VITE_WORLD=harbour');

      // twice is once.
      expect(run(['harbour', '--file', file]).status).toBe(0);
      expect(readWorlds(file)).toEqual({
        harbour: { host: 'ref-world-harbour.vercel.app', residents: 'shipped' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--clean is how a client world is made, and it is what meridian is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-world-'));
    const file = join(dir, 'worlds.json');
    try {
      writeFileSync(file, JSON.stringify({ worlds: {} }, null, 2));
      const { status, out } = run(['meridian', '--clean', '--host', 'meridian.example', '--file', file]);
      expect(status).toBe(0);
      expect(readWorlds(file)).toEqual({
        meridian: { host: 'meridian.example', residents: 'none' },
      });
      expect(out).toContain('none');
      expect(out).toContain('nothing to seed');

      // and the committed entry is what this script writes, minus the host.
      expect(WORLDS['meridian']?.residents).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a bad name, and a host that is already somebody else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-world-'));
    const file = join(dir, 'worlds.json');
    try {
      const before = `${JSON.stringify(
        { worlds: { harbour: { host: 'ref-world-harbour.vercel.app', residents: 'shipped' } } },
        null,
        2,
      )}\n`;
      writeFileSync(file, before);

      for (const bad of ['Harbour', 'two words', 'a'.repeat(25)]) {
        expect(run([bad, '--file', file]).status).toBe(1);
      }
      // pointing a live deployment at a different world renames somebody's
      // link, and that does not happen quietly.
      expect(
        run(['meridian', '--host', 'ref-world-harbour.vercel.app', '--file', file]).status,
      ).toBe(1);

      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
