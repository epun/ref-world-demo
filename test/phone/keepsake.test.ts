/**
 * Taking a creature home: the parts of it that are decisions rather than
 * plumbing.
 *
 * The renders need a gpu and the delivery needs a share sheet, so neither
 * is here. What is here is the link — which is the piece that has to keep
 * working for months after the event, on a device that has never seen this
 * creature, and is therefore the piece worth pinning.
 */

import { describe, expect, it } from 'vitest';
import { keepUrl, keepsakeFilename, readKeepId } from '../../src/phone/keeplink';
import { roomForWorld } from '../../src/net/protocol';

describe('keepUrl', () => {
  it('carries an id and a world, and nothing else', () => {
    // Short on purpose: this gets texted, read aloud, and turned into a qr.
    const url = keepUrl('https://ref-world-demo.vercel.app', {
      world: 'public',
      id: 'd3f2a1',
    });
    expect(url).toBe('https://ref-world-demo.vercel.app/?world=public&keep=d3f2a1');
    expect(url.length).toBeLessThan(80);
  });

  it('does not carry the drawing', () => {
    // The alternative was encoding the strokes into the url, which needs
    // them quantized to fit — and a quantized stroke list is a DIFFERENT
    // drawing. It would rebuild a creature that is nearly right, which is
    // worse than one that is either right or absent.
    const url = keepUrl('https://x.test', { world: 'public', id: 'd1' });
    expect(url).not.toMatch(/pts|strokes|[A-Za-z0-9+/]{100}/);
  });

  it('resolves to the room the world derives, so an old link still lands right', () => {
    const url = keepUrl('https://x.test', { world: 'public', id: 'd1' });
    const world = new URL(url).searchParams.get('world')!;
    expect(roomForWorld(world)).toBe(roomForWorld('public'));
  });

  it('escapes rather than pasting into the query', () => {
    const url = keepUrl('https://x.test', { world: 'a b', id: 'x&y=z' });
    const params = new URL(url).searchParams;
    expect(params.get('world')).toBe('a b');
    expect(params.get('keep')).toBe('x&y=z');
  });
});

describe('readKeepId', () => {
  const read = (query: string) => readKeepId(new URLSearchParams(query));

  it('reads the id a keep link carries', () => {
    expect(read('world=public&keep=d3f2a1')).toBe('d3f2a1');
  });

  it('is null when there is no keep in the url', () => {
    expect(read('world=public')).toBeNull();
    expect(read('keep=')).toBeNull();
  });

  it('bounds and cleans what it returns, because it goes into a lookup', () => {
    expect(read('keep=' + encodeURIComponent('../../etc/passwd'))).toBe('etcpasswd');
    expect(read('keep=' + encodeURIComponent('D3F2A1'))).toBe('d3f2a1');
    expect(read('keep=' + 'a'.repeat(200))).toHaveLength(32);
  });

  it('is null when nothing survives cleaning', () => {
    expect(read('keep=' + encodeURIComponent('!!!'))).toBeNull();
  });
});

describe('keepsakeFilename', () => {
  it('names the file after the creature, so it can be found again', () => {
    expect(keepsakeFilename('wonder', 'd3f2a1b9', 'png')).toBe('refworld-wonder-d3f2a1.png');
  });

  it('keeps two creatures of the same name apart', () => {
    const a = keepsakeFilename('wonder', 'd1111111', 'png');
    const b = keepsakeFilename('wonder', 'd2222222', 'png');
    expect(a).not.toBe(b);
  });

  it('never produces uppercase — a filename is type', () => {
    const name = keepsakeFilename('Wonder The GREAT', 'D3F2A1', 'glb');
    expect(name).toBe(name.toLowerCase());
    expect(name).toBe('refworld-wonder-the-great-d3f2a1.glb');
  });

  it('survives a name made entirely of punctuation', () => {
    // Nothing usable left, so it falls back rather than emitting
    // `refworld--d3f2a1.png` with a doubled separator.
    expect(keepsakeFilename('!!! ???', 'd3f2a1', 'png')).toBe('refworld-creature-d3f2a1.png');
    expect(keepsakeFilename(null, 'd3f2a1', 'png')).toBe('refworld-creature-d3f2a1.png');
  });

  it('does not run away with a very long name', () => {
    const long = keepsakeFilename('a'.repeat(200), 'd3f2a1', 'png');
    expect(long.length).toBeLessThan(50);
  });
});
