/**
 * Two things that must survive: the durable copy of a drawing, and a way
 * out of the companion.
 *
 * Both are source-level pins. The first lives in a static html page in
 * `public/` that imports nothing and that no unit test can drive; the
 * second is a browser-only entry module and a postMessage between two
 * documents. What can be checked is that the code is shaped the way the
 * failures require.
 *
 * The failures, both reported 2026-09-09 on a phone:
 *
 *   1. "the character doesn't load in the scene when i draw it" — the pad
 *      navigates to the companion MOTION.secondaryMs after the send, and a
 *      navigation cancels the outgoing document's in-flight requests. The
 *      durable POST was being aborted (net::ERR_ABORTED) before a cold
 *      serverless function could answer it, so nothing was stored and the
 *      world view, which reads the store, opened on an empty field.
 *
 *   2. "the view goes blank on the device and there is nothing shown or any
 *      way to refresh or go back" — the companion is framed full screen
 *      over the world, and its only exit is a control the boot mounts. A
 *      boot that throws is therefore a dead end, not just a blank screen.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOSE_MESSAGE, FAILED_MESSAGE } from '../../src/world/companionpanel';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
/** Strip comments — a rule NAMED in prose must not stand in for the code. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the durable copy outlives the page that sends it', () => {
  const src = code(read('public/draw/index.html'));

  it('the api POST is keepalive', () => {
    expect(src).toMatch(/keepalive\s*=\s*true/);
  });

  it('the request that carries it is the one that gets the flag', () => {
    // The flag has to be on the options object handed to the api fetch, not
    // on some other request: an aborted POST is the whole bug.
    const post = src.slice(src.indexOf("fetch('/api/drawings"));
    expect(post.length).toBeGreaterThan(0);
    const options = src.slice(src.indexOf('var options = {'), src.indexOf("fetch('/api/drawings"));
    expect(options).toMatch(/method:\s*'POST'/);
    expect(src).toMatch(/options\.keepalive\s*=\s*true/);
    expect(src).toMatch(/fetch\('\/api\/drawings\?world=' \+ encodeURIComponent\(WORLD\), options\)/);
  });

  it('a body too big for the keepalive budget is still sent, unflagged', () => {
    // Over the budget a browser refuses the request outright. A race we
    // might lose beats a request that is never made.
    expect(src).toMatch(/KEEPALIVE_MAX_BYTES/);
    expect(src).toMatch(/payloadBytes\(payload\)\s*<=\s*KEEPALIVE_MAX_BYTES/);
    const limit = /const KEEPALIVE_MAX_BYTES = (\d+);/.exec(src);
    expect(limit).toBeTruthy();
    expect(Number(limit![1])).toBeLessThanOrEqual(64000);
  });

  it('still waits on nothing — the hand-off is not held up by the api', () => {
    // Fire and forget was always the rule (docs/PUBLIC.md): keepalive keeps
    // the request alive past the navigation, it does not make anyone wait.
    expect(src).not.toMatch(/await fetch\('\/api\/drawings/);
  });
});

describe('a companion that cannot boot is not a dead end', () => {
  const phone = code(read('src/phone/main.ts'));
  const panel = code(read('src/world/companionpanel.ts'));

  it('a failed boot is caught rather than left to the console', () => {
    expect(phone).toMatch(/boot\(\)\.catch\(/);
  });

  it('and it tells the panel it failed', () => {
    const caught = phone.slice(phone.indexOf('boot().catch('));
    expect(caught).toMatch(/FAILED_MESSAGE/);
    expect(caught).toMatch(/window\.parent\.postMessage/);
    // Only when there IS a panel: on its own page the person has an address
    // bar, and there is nobody to tell.
    expect(caught).toMatch(/window\.parent !== window/);
  });

  it('the failure is a different message from a close', () => {
    // A close is the person leaving and the frame is KEPT — that is the
    // whole point of the panel. A failure has to be able to throw it away.
    expect(FAILED_MESSAGE).not.toBe(CLOSE_MESSAGE);
  });

  it('the panel leaves on it, and drops the frame so the next tap rebuilds', () => {
    const handler = panel.slice(panel.indexOf('const onMessage'), panel.indexOf('function open_'));
    expect(handler).toMatch(/FAILED_MESSAGE/);
    expect(handler).toMatch(/close\(\)/);
    expect(handler).toMatch(/frame = null/);
    // Same-origin only, still: the listener is on window and anything can
    // post to it.
    expect(handler).toMatch(/event\.origin !== window\.location\.origin/);
  });

  it('a close still keeps the frame — the second toggle costs nothing', () => {
    const handler = panel.slice(panel.indexOf('const onMessage'), panel.indexOf('function open_'));
    const onClose = handler.slice(
      handler.indexOf('CLOSE_MESSAGE'),
      handler.indexOf('FAILED_MESSAGE'),
    );
    expect(onClose).not.toMatch(/frame = null/);
  });
});
