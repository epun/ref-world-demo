/**
 * Haptics: the hatch buzz, and — more importantly — every way a handset
 * can refuse to buzz without breaking the screen.
 */

import { describe, expect, it } from 'vitest';
import {
  canSwitchHaptic,
  canVibrate,
  describeHaptics,
  hapticTransport,
  HATCH_PATTERN,
  hatchPulse,
  pulse,
  type VibrateLike,
} from '../../src/phone/haptics';

function recorder(result: boolean | (() => never) = true): VibrateLike & { calls: (number | number[])[] } {
  const calls: (number | number[])[] = [];
  return {
    calls,
    vibrate(pattern) {
      calls.push(pattern);
      if (typeof result === 'function') result();
      return result as boolean;
    },
  };
}

describe('hatch haptic', () => {
  it('hands the device the hatch pattern', () => {
    const nav = recorder();
    expect(hatchPulse(nav)).toBe(true);
    expect(nav.calls).toEqual([[...HATCH_PATTERN]]);
  });

  it('is a tick, not a ring — the whole thing under a fifth of a second', () => {
    const total = HATCH_PATTERN.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(200);
    // Two buzzes with a gap: crack, then out.
    expect(HATCH_PATTERN).toHaveLength(3);
    for (const ms of HATCH_PATTERN) expect(ms).toBeGreaterThan(0);
  });

  it('copies the pattern — a caller cannot mutate the shared constant', () => {
    const nav = recorder();
    hatchPulse(nav);
    (nav.calls[0] as number[])[0] = 9999;
    expect(HATCH_PATTERN[0]).not.toBe(9999);
  });
});

describe('a handset that will not buzz', () => {
  it('reports no support rather than pretending (every iphone)', () => {
    expect(canVibrate({})).toBe(false);
    // A navigator that carries the key but not a function (older shims).
    expect(canVibrate({ vibrate: 'nope' } as unknown as VibrateLike)).toBe(false);
    expect(hatchPulse({})).toBe(false);
  });

  it('reports refusal when the browser declines (no engagement yet)', () => {
    const nav = recorder(false);
    expect(hatchPulse(nav)).toBe(false);
    expect(nav.calls).toHaveLength(1);
  });

  it('never throws, whatever the device does', () => {
    const throwing = recorder(() => {
      throw new Error('blocked');
    });
    expect(() => hatchPulse(throwing)).not.toThrow();
    expect(hatchPulse(throwing)).toBe(false);
  });

  it('refuses an empty pattern instead of calling with nothing', () => {
    const nav = recorder();
    expect(pulse([], nav)).toBe(false);
    expect(nav.calls).toHaveLength(0);
  });
});

describe('the iphone route', () => {
  /** A document stub: only what haptics.ts touches. */
  function fakeDoc(opts: { switchSupported: boolean }) {
    const clicks: string[] = [];
    const created: any[] = [];
    const byId: Record<string, any> = {};
    const make = (tag: string): any => {
      const el: any = {
        tagName: tag,
        id: '',
        style: { cssText: '' },
        children: [] as any[],
        firstElementChild: null,
        tabIndex: 0,
        setAttribute(k: string, v: string) {
          (el as any)[`attr:${k}`] = v;
          if (k === 'type' && opts.switchSupported) el.switch = false;
        },
        appendChild(c: any) {
          el.children.push(c);
          el.firstElementChild = el.children[0];
          return c;
        },
        click() {
          clicks.push(el.id || el.tagName);
        },
      };
      if (tag === 'input' && opts.switchSupported) el.switch = false;
      created.push(el);
      return el;
    };
    const body = make('body');
    return {
      clicks,
      doc: {
        createElement: make,
        getElementById: (id: string) => byId[id] ?? null,
        get body() {
          return body;
        },
        _register(el: any) {
          byId[el.id] = el;
        },
      } as unknown as Document,
      body,
      register: (el: any) => {
        byId[el.id] = el;
      },
    };
  }

  it('detects the switch attribute rather than sniffing the user agent', () => {
    expect(canSwitchHaptic(fakeDoc({ switchSupported: true }).doc)).toBe(true);
    expect(canSwitchHaptic(fakeDoc({ switchSupported: false }).doc)).toBe(false);
    expect(canSwitchHaptic({} as unknown as Document)).toBe(false);
  });

  it('names the transport a handset will actually use', () => {
    const ios = fakeDoc({ switchSupported: true }).doc;
    const android = recorder();
    expect(hapticTransport(android, ios)).toBe('vibration-api');
    expect(hapticTransport({}, ios)).toBe('ios-switch');
    expect(hapticTransport({}, fakeDoc({ switchSupported: false }).doc)).toBe('none');
    expect(describeHaptics({}, ios)).toContain('one tick');
  });

  it('falls back to the switch when there is no vibration api', () => {
    const f = fakeDoc({ switchSupported: true });
    expect(hatchPulse({}, f.doc)).toBe(true);
    // The haptic rides the label's activation, so the LABEL is what clicks.
    expect(f.clicks).toHaveLength(1);
  });

  it('prefers the vibration api when both exist — a pattern beats one tick', () => {
    const f = fakeDoc({ switchSupported: true });
    const nav = recorder();
    expect(hatchPulse(nav, f.doc)).toBe(true);
    expect(nav.calls).toEqual([[...HATCH_PATTERN]]);
    expect(f.clicks).toHaveLength(0);
  });

  it('stays silent, and safe, when the handset has neither', () => {
    const f = fakeDoc({ switchSupported: false });
    expect(hatchPulse({}, f.doc)).toBe(false);
    expect(f.clicks).toHaveLength(0);
    expect(() => hatchPulse({}, undefined)).not.toThrow();
  });
});
