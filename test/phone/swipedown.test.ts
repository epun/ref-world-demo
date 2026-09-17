/**
 * Swipe down from the top of the device to go back to the world
 * (src/phone/swipedown.ts, wired in src/phone/main.ts).
 *
 * > User ask, 2026-09-17 (mobile): *"on mobile if you swipe down at the top of
 * > the screen on the device view it should take you back to the world"*.
 *
 * What is pinned: the band it starts in, the direction and distance that make
 * it a swipe rather than a tap or a sideways flick, that it fires once, that
 * the move is prevented so the browser's pull-to-refresh cannot, and that it
 * leaves through the one exit the `view world` button already uses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SWIPE_PX,
  TOP_BAND,
  installSwipeDown,
  isSwipeDown,
  startsInBand,
  type TouchLike,
} from '../../src/phone/swipedown';

/** A phone, in the size this was asked for. */
const H = 844;

describe('the band — a pull from the top, and nowhere else', () => {
  it('owns the top band of the screen and nothing below it', () => {
    expect(TOP_BAND).toBeGreaterThan(0.05);
    expect(TOP_BAND).toBeLessThan(0.25);
    expect(startsInBand(0, H)).toBe(true);
    expect(startsInBand(H * TOP_BAND, H)).toBe(true);
    expect(startsInBand(H * TOP_BAND + 1, H)).toBe(false);
    // The creature is turned with a drag in the middle of the screen
    // (src/phone/spin.ts); that gesture must keep working.
    expect(startsInBand(H / 2, H)).toBe(false);
  });

  it('is a fraction of the viewport, not a number of pixels', () => {
    // A short window and a tall one both get a band of their own.
    expect(startsInBand(100, 1200)).toBe(true);
    expect(startsInBand(100, 400)).toBe(false);
  });

  it('answers false for nonsense rather than throwing', () => {
    expect(startsInBand(Number.NaN, H)).toBe(false);
    expect(startsInBand(10, 0)).toBe(false);
    expect(startsInBand(-5, H)).toBe(false);
  });
});

describe('the gesture — down, far enough, and mostly vertical', () => {
  const from = { startX: 200, startY: 20, height: H };

  it('fires on a downward pull past the threshold', () => {
    expect(isSwipeDown({ ...from, x: 200, y: 20 + SWIPE_PX })).toBe(true);
    expect(isSwipeDown({ ...from, x: 200, y: 20 + SWIPE_PX * 3 })).toBe(true);
  });

  it('does not fire on a tap, or on a pull that stops short', () => {
    expect(isSwipeDown({ ...from, x: 200, y: 20 })).toBe(false);
    expect(isSwipeDown({ ...from, x: 200, y: 20 + SWIPE_PX - 1 })).toBe(false);
  });

  it('does not fire UPWARDS, whatever the distance', () => {
    expect(isSwipeDown({ ...from, startY: 100, x: 200, y: 100 - SWIPE_PX * 4 })).toBe(false);
  });

  it('does not fire on a sideways flick with a droop in it', () => {
    // Further across than down: that is a swipe, but not this one.
    expect(isSwipeDown({ ...from, x: 200 + SWIPE_PX * 3, y: 20 + SWIPE_PX + 5 })).toBe(false);
    // …and the same distance mostly down still counts.
    expect(isSwipeDown({ ...from, x: 200 + 10, y: 20 + SWIPE_PX + 5 })).toBe(true);
  });

  it('does not fire for a drag that began below the band', () => {
    expect(isSwipeDown({ startX: 200, startY: H / 2, x: 200, y: H / 2 + 300, height: H })).toBe(
      false,
    );
  });
});

// ── the listener, against a recording target ─────────────────────────────────

function stubTarget(): {
  target: Parameters<typeof installSwipeDown>[0]['target'];
  fire(type: string, event: TouchLike): void;
  listeners: Map<string, { handler: (e: TouchLike) => void; passive?: boolean }[]>;
} {
  const listeners = new Map<string, { handler: (e: TouchLike) => void; passive?: boolean }[]>();
  return {
    listeners,
    target: {
      addEventListener: (type, handler, options): void => {
        const list = listeners.get(type) ?? [];
        list.push({ handler, ...(options?.passive === undefined ? {} : { passive: options.passive }) });
        listeners.set(type, list);
      },
      removeEventListener: (type, handler): void => {
        const list = listeners.get(type) ?? [];
        const at = list.findIndex((l) => l.handler === handler);
        if (at >= 0) list.splice(at, 1);
      },
    },
    fire: (type, event): void => {
      for (const { handler } of [...(listeners.get(type) ?? [])]) handler(event);
    },
  };
}

/** One finger, at a point. */
const touch = (x: number, y: number, extra: Partial<TouchLike> = {}): TouchLike => ({
  touches: [{ clientX: x, clientY: y }],
  ...extra,
});

describe('the listener', () => {
  it('leaves for the world on a pull from the top', () => {
    const stub = stubTarget();
    let left = 0;
    const handle = installSwipeDown({
      target: stub.target,
      height: () => H,
      onSwipe: () => left++,
    });
    stub.fire('touchstart', touch(200, 18));
    expect(handle.live()).toBe(true);
    stub.fire('touchmove', touch(200, 18 + SWIPE_PX / 2));
    expect(left).toBe(0);
    stub.fire('touchmove', touch(204, 18 + SWIPE_PX + 4));
    expect(left).toBe(1);
    expect(handle.fired()).toBe(true);
    handle.destroy();
  });

  it('fires ONCE — two navigations for one thumb is a stutter', () => {
    const stub = stubTarget();
    let left = 0;
    const handle = installSwipeDown({
      target: stub.target,
      height: () => H,
      onSwipe: () => left++,
    });
    stub.fire('touchstart', touch(200, 10));
    stub.fire('touchmove', touch(200, 10 + SWIPE_PX * 2));
    stub.fire('touchmove', touch(200, 10 + SWIPE_PX * 3));
    stub.fire('touchend', touch(200, 10 + SWIPE_PX * 3));
    stub.fire('touchstart', touch(200, 10));
    stub.fire('touchmove', touch(200, 10 + SWIPE_PX * 2));
    expect(left).toBe(1);
    handle.destroy();
  });

  it('ignores a drag that started under the band, and a pinch', () => {
    const stub = stubTarget();
    let left = 0;
    const handle = installSwipeDown({
      target: stub.target,
      height: () => H,
      onSwipe: () => left++,
    });
    // below the band
    stub.fire('touchstart', touch(200, H / 2));
    expect(handle.live()).toBe(false);
    stub.fire('touchmove', touch(200, H / 2 + 300));
    expect(left).toBe(0);
    // two fingers
    stub.fire('touchstart', {
      touches: [
        { clientX: 100, clientY: 10 },
        { clientX: 300, clientY: 12 },
      ],
    });
    stub.fire('touchmove', touch(100, 10 + SWIPE_PX * 2));
    expect(left).toBe(0);
    handle.destroy();
  });

  it('forgets a gesture that ended without travelling', () => {
    const stub = stubTarget();
    let left = 0;
    const handle = installSwipeDown({
      target: stub.target,
      height: () => H,
      onSwipe: () => left++,
    });
    stub.fire('touchstart', touch(200, 10));
    stub.fire('touchend', touch(200, 20));
    expect(handle.live()).toBe(false);
    // A move with no gesture behind it does nothing at all.
    stub.fire('touchmove', touch(200, 10 + SWIPE_PX * 2));
    expect(left).toBe(0);
    handle.destroy();
  });

  it('kills pull-to-refresh: the move is prevented and not passive', () => {
    const stub = stubTarget();
    const handle = installSwipeDown({
      target: stub.target,
      height: () => H,
      onSwipe: () => {},
    });
    // The move listener is the one that must be able to preventDefault.
    expect(stub.listeners.get('touchmove')?.[0]?.passive).toBe(false);
    expect(stub.listeners.get('touchstart')?.[0]?.passive).toBe(true);
    let prevented = 0;
    stub.fire('touchstart', touch(200, 12));
    stub.fire(
      'touchmove',
      touch(200, 30, { preventDefault: () => prevented++, cancelable: true }),
    );
    // Prevented from the first move of the gesture, long before it is
    // recognised — the reload happens at the top of the drag, not the end.
    expect(prevented).toBe(1);
    handle.destroy();
  });

  it('stops listening on destroy', () => {
    const stub = stubTarget();
    let left = 0;
    const handle = installSwipeDown({
      target: stub.target,
      height: () => H,
      onSwipe: () => left++,
    });
    handle.destroy();
    for (const [type] of stub.listeners) expect(stub.listeners.get(type)).toHaveLength(0);
    stub.fire('touchstart', touch(200, 10));
    stub.fire('touchmove', touch(200, 10 + SWIPE_PX * 2));
    expect(left).toBe(0);
  });
});

describe('the wiring', () => {
  const main = readFileSync(join(process.cwd(), 'src/phone/main.ts'), 'utf8');

  it('leaves through the ONE exit the button already uses', () => {
    expect(main).toMatch(/installSwipeDown\(\{[\s\S]{0,300}?onSwipe: \(\) => intoTheWorld\(\),/);
    // …which is `leaveForWorld`: the case slides, then the page goes.
    expect(main).toMatch(/leaveForWorld\(\{ room, world: publicWorld, device: deviceEl \}\)/);
  });

  it('is mounted only where there is a world to go back to', () => {
    expect(main).toMatch(/if \(publicWorld\.length > 0\) \{\s*\n\s*installSwipeDown\(/);
  });

  it('reads the viewport per gesture rather than capturing it', () => {
    // A phone rotates, and a captured height would put the band in the wrong
    // place for the rest of the session.
    expect(main).toMatch(/height: \(\) => window\.innerHeight/);
  });
});
