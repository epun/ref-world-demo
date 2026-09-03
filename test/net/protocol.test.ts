/**
 * The protocol's url surface.
 *
 * `joinUrl` is what the qr on the wall encodes, and it is the only place in
 * the project that decides what address a stranger is handed. It is pure so
 * that decision can be pinned here rather than read off a canvas.
 */

import { describe, expect, it } from 'vitest';
import { joinUrl, roomForWorld } from '../../src/net/protocol';

describe('joinUrl — what the qr on the wall encodes', () => {
  /**
   * The qr used to encode a `/draw/` deep link even in a named world, so
   * the projection was handing out an address that appeared nowhere else
   * (user ask, 2026-08-27: *"let's make sure the qr code also points to the
   * correct url. it should point to the world url"*).
   */

  it('a named world gets its own link and nothing else', () => {
    const url = joinUrl('https://ref-world-demo.vercel.app', {
      world: 'public',
      room: 'qtse',
      epoch: 'w-public',
    });
    expect(url).toBe('https://ref-world-demo.vercel.app/?world=public');
    // Specifically NOT the deep link: no pad, no room, no epoch. A scan and
    // a shared link have to be the same string.
    expect(url).not.toContain('/draw/');
    expect(url).not.toContain('room=');
    expect(url).not.toContain('w=');
  });

  it('resolves to the same room a visitor to that link would derive', () => {
    // The reason dropping the room is safe at all. If these ever diverge,
    // a scan and a share end up in different mqtt topics.
    const world = 'public';
    const url = joinUrl('https://x.test', { world, room: 'zzzz', epoch: 'e' });
    const landed = new URL(url).searchParams.get('world')!;
    expect(roomForWorld(landed)).toBe(roomForWorld(world));
  });

  it('an unnamed world keeps the deep link — its room cannot be derived', () => {
    const url = joinUrl('https://x.test', { world: null, room: 'qtse', epoch: 'w-7' });
    expect(url).toBe('https://x.test/draw/?room=qtse&w=w-7');
  });

  it('escapes the world name rather than pasting it into the query', () => {
    const url = joinUrl('https://x.test', { world: 'a b&c', room: 'qtse', epoch: 'e' });
    expect(new URL(url).searchParams.get('world')).toBe('a b&c');
  });

  /**
   * A world with a page of its own (worlds/<name>/index.html) is reached at
   * `/worlds/<name>/`. That path is the address on its card and the one a
   * client was sent, so the qr has to be that and not a second address for
   * the same place.
   */
  it('a world with a page of its own gets the page, not the query form', () => {
    const url = joinUrl('https://ref-world-demo.vercel.app', {
      world: 'meridian',
      room: roomForWorld('meridian'),
      epoch: 'w-meridian',
      page: '/worlds/meridian/',
    });
    expect(url).toBe('https://ref-world-demo.vercel.app/worlds/meridian/');
    expect(url).not.toContain('?');
    expect(url).not.toContain('/draw/');
  });

  it('the page url still lands in the same room as the query form', () => {
    // Same reason as above: the room is derived from the NAME, and both
    // addresses carry the same name, so neither loses anything by omitting
    // the room. If this diverged, a scan and a share would split the topic.
    const page = joinUrl('https://x.test', {
      world: 'meridian',
      room: 'zzzz',
      epoch: 'e',
      page: '/worlds/meridian/',
    });
    const query = joinUrl('https://x.test', { world: 'meridian', room: 'zzzz', epoch: 'e' });
    expect(new URL(page).pathname).toBe('/worlds/meridian/');
    expect(roomForWorld('meridian')).toBe(
      roomForWorld(new URL(query).searchParams.get('world')!),
    );
  });

  /**
   * An unnamed world's room was minted at random and appears nowhere in a
   * path, so a page-only url would strand the scan exactly as dropping the
   * deep link would. `page` is a refinement of the named case, not an
   * override of the unnamed one.
   */
  it('ignores the page in an unnamed world — the deep link is still the only option', () => {
    const url = joinUrl('https://x.test', {
      world: null,
      room: 'qtse',
      epoch: 'w-7',
      page: '/worlds/meridian/',
    });
    expect(url).toBe('https://x.test/draw/?room=qtse&w=w-7');
  });
});
