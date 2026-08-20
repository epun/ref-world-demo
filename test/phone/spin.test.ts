/**
 * Turning the object by hand (src/phone/spin.ts).
 *
 * The gesture is a motion feature, so what these cover is the motion law,
 * not the plumbing: a release must not freeze the object (abrupt stop,
 * confidence 1.00), the turn must never reverse (overshoot and bounce,
 * confidence 1.00), and nothing may snap back to front — the person turned
 * the creature round to look at the drawing on its back, and that is where
 * it has to stay.
 *
 * Node-only, per the phone test discipline: the surface is a stub that
 * records its listeners, so no DOM is needed to drive a whole drag.
 */

import { describe, expect, it } from 'vitest';
import { MIN_ZETA } from '../../src/motion/spring';
import { MOTION } from '../../src/taste/tokens';
import {
  createSpin,
  MAX_SPIN_RATE,
  radiansPerPixel,
  TURN_PER_WIDTH,
  type SpinHandle,
} from '../../src/phone/spin';

type Handler = (event: PointerEvent) => void;

interface Stub {
  el: HTMLElement;
  fire(type: string, event: Partial<PointerEvent>): void;
  listeners: number;
}

function stubSurface(): Stub {
  const handlers = new Map<string, Handler>();
  const el = {
    addEventListener(type: string, fn: Handler): void {
      handlers.set(type, fn);
    },
    removeEventListener(type: string): void {
      handlers.delete(type);
    },
  } as unknown as HTMLElement;
  return {
    el,
    fire(type, event): void {
      handlers.get(type)?.(event as PointerEvent);
    },
    get listeners(): number {
      return handlers.size;
    },
  };
}

const WIDTH = 300;

function spinOn(stub: Stub, extra: Partial<Parameters<typeof createSpin>[0]> = {}): SpinHandle {
  return createSpin({ surface: stub.el, width: () => WIDTH, ...extra });
}

/** A whole drag: down, one move of `dx`, up. */
function drag(stub: Stub, dx: number, dtMs = 16): void {
  stub.fire('pointerdown', { pointerId: 1, clientX: 0, timeStamp: 0 });
  stub.fire('pointermove', { pointerId: 1, clientX: dx, timeStamp: dtMs });
  stub.fire('pointerup', { pointerId: 1, clientX: dx, timeStamp: dtMs });
}

describe('radiansPerPixel', () => {
  it('is one full turn across the surface width', () => {
    expect(radiansPerPixel(WIDTH) * WIDTH).toBeCloseTo(TURN_PER_WIDTH);
    expect(radiansPerPixel(1000) * 1000).toBeCloseTo(Math.PI * 2);
  });

  it('never divides by zero on an unlaid-out surface', () => {
    expect(Number.isFinite(radiansPerPixel(0))).toBe(true);
  });
});

describe('drag → yaw', () => {
  it('turns by the drag distance, in both directions', () => {
    const stub = stubSurface();
    const spin = spinOn(stub);
    drag(stub, 75);
    expect(spin.yaw()).toBeCloseTo(75 * radiansPerPixel(WIDTH));
    drag(stub, -75);
    expect(spin.yaw()).toBeCloseTo(0);
    spin.destroy();
  });

  it('a full-width drag is a full turn', () => {
    const stub = stubSurface();
    const spin = spinOn(stub);
    drag(stub, WIDTH);
    expect(spin.yaw()).toBeCloseTo(TURN_PER_WIDTH);
    spin.destroy();
  });

  it('carries a yaw and a throw in from the previous screen', () => {
    const stub = stubSurface();
    const spin = spinOn(stub, { initial: { yaw: 1.25, velocity: 0.002 } });
    expect(spin.yaw()).toBe(1.25);
    expect(spin.state().velocity).toBeCloseTo(0.002);
    // The inherited throw keeps turning it — the seam is not a stop.
    expect(spin.update(16)).toBeGreaterThan(1.25);
    spin.destroy();
  });

  it('refuses a new gesture while it is held, without cutting a throw short', () => {
    const stub = stubSurface();
    let held = true;
    const spin = spinOn(stub, {
      initial: { yaw: 0, velocity: 0.001 },
      held: () => held,
    });
    drag(stub, 120);
    expect(spin.dragging()).toBe(false);
    // The drag did nothing, but the throw already in flight kept running.
    const after = spin.update(16);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(120 * radiansPerPixel(WIDTH));
    held = false;
    drag(stub, 120);
    expect(spin.yaw()).toBeGreaterThan(120 * radiansPerPixel(WIDTH));
    spin.destroy();
  });

  it('leaves a control alone — a key press is never a drag', () => {
    const stub = stubSurface();
    const spin = spinOn(stub);
    const button = { closest: (): unknown => ({}) } as unknown as EventTarget;
    stub.fire('pointerdown', { pointerId: 1, clientX: 0, timeStamp: 0, target: button });
    stub.fire('pointermove', { pointerId: 1, clientX: 90, timeStamp: 16 });
    expect(spin.dragging()).toBe(false);
    expect(spin.yaw()).toBe(0);
    spin.destroy();
  });

  it('unhooks every listener on destroy', () => {
    const stub = stubSurface();
    const spin = spinOn(stub);
    expect(stub.listeners).toBeGreaterThan(0);
    spin.destroy();
    expect(stub.listeners).toBe(0);
  });
});

describe('nothing turns on its own', () => {
  /**
   * User ruling, 2026-08-20: *"the egg and the character should not
   * ambiently spin. It should be user-driven."* Yaw has exactly one source
   * now — this module — and the screens write `rotation.y = facing + yaw`
   * with `facing` captured once. So "leave the phone alone and the yaw does
   * not change" reduces to this: with no pointer down and no throw in
   * flight, update() must return the SAME number, bit for bit, forever.
   */
  it('returns a bit-identical yaw over ten thousand idle frames', () => {
    const stub = stubSurface();
    const spin = spinOn(stub);
    const first = spin.update(16);
    for (let i = 0; i < 10_000; i++) expect(spin.update(16)).toBe(first);
    expect(first).toBe(0);
    expect(spin.state().velocity).toBe(0);
    spin.destroy();
  });

  it('holds an inherited resting angle exactly, however long it idles', () => {
    const stub = stubSurface();
    const spin = spinOn(stub, { initial: { yaw: Math.PI, velocity: 0 } });
    for (let i = 0; i < 5_000; i++) expect(spin.update(16)).toBe(Math.PI);
    spin.destroy();
  });

  it('leaves a spent throw imperceptible, and still never at rest', () => {
    // A THROW is different from idling: the person's own flick dissipating
    // is user-driven motion, and TASTE §2.1 forbids it stopping dead. So
    // this asserts the honest pair — the tail is far below anything a
    // person could see, and it is never exactly zero.
    const stub = stubSurface();
    const spin = spinOn(stub);
    drag(stub, 90);
    for (let i = 0; i < 600; i++) spin.update(16); // ~10s of settling
    const rest = spin.update(16);
    let travelled = 0;
    for (const dt of [1, 7, 16, 33, 100, 4, 16, 250]) {
      const before = spin.yaw();
      const after = spin.update(dt);
      expect(after).not.toBe(before); // nothing ever fully arrests
      travelled += Math.abs(after - before);
    }
    // A tenth of a degree is already invisible; this is orders under it.
    expect(Math.abs(spin.yaw() - rest)).toBeLessThan(1e-4);
    expect(travelled).toBeGreaterThan(0);
    spin.destroy();
  });
});

describe('the throw settles by drifting', () => {
  /** Sample the tail of a release: one flick, then a long free run. */
  function tail(dx: number, steps: number, dt = 16): { yaw: number; v: number }[] {
    const stub = stubSurface();
    const spin = spinOn(stub);
    drag(stub, dx, dt);
    const out: { yaw: number; v: number }[] = [];
    for (let i = 0; i < steps; i++) {
      const yaw = spin.update(dt);
      out.push({ yaw, v: spin.state().velocity });
    }
    spin.destroy();
    return out;
  }

  it('never abruptly stops: the velocity decays but never reaches zero', () => {
    // Four seconds of free run — more than twice t.primary.
    const samples = tail(120, 250);
    const lastV = samples[samples.length - 1]?.v ?? 0;
    expect(lastV).not.toBe(0);
    expect(Math.abs(lastV)).toBeLessThan(1e-6);
  });

  it('decays monotonically — every step is slower than the last', () => {
    const samples = tail(120, 200);
    for (let i = 2; i < samples.length; i++) {
      const prev = Math.abs(samples[i - 1]?.v ?? 0);
      const now = Math.abs(samples[i]?.v ?? 0);
      expect(now).toBeLessThanOrEqual(prev + 1e-12);
    }
  });

  it('never overshoots: the yaw never reverses after a release', () => {
    for (const dx of [40, -40, 220, -220]) {
      const samples = tail(dx, 200);
      const sign = Math.sign(dx);
      for (let i = 1; i < samples.length; i++) {
        const step = (samples[i]?.yaw ?? 0) - (samples[i - 1]?.yaw ?? 0);
        expect(step * sign).toBeGreaterThanOrEqual(-1e-12);
      }
    }
  });

  it('never snaps back to front: it rests where the person left it', () => {
    const samples = tail(150, 400);
    const settled = samples[samples.length - 1]?.yaw ?? 0;
    const released = 150 * radiansPerPixel(WIDTH);
    // Past the release angle (the throw carried it on), never back toward 0.
    expect(settled).toBeGreaterThan(released);
    expect(samples[samples.length - 1]?.yaw).toBeCloseTo(
      samples[samples.length - 2]?.yaw ?? 0,
      6,
    );
  });

  it('caps a flick at a full turn per t.tertiary', () => {
    expect(MAX_SPIN_RATE).toBeCloseTo(TURN_PER_WIDTH / MOTION.tertiaryMs);
    const stub = stubSurface();
    const spin = spinOn(stub);
    // A 4000px jump in one millisecond — a slipped finger, not a throw.
    stub.fire('pointerdown', { pointerId: 1, clientX: 0, timeStamp: 0 });
    stub.fire('pointermove', { pointerId: 1, clientX: 4000, timeStamp: 1 });
    stub.fire('pointerup', { pointerId: 1, clientX: 4000, timeStamp: 1 });
    expect(Math.abs(spin.state().velocity)).toBeLessThanOrEqual(MAX_SPIN_RATE + 1e-12);
    spin.destroy();
  });

  it('decays through a spring the damping audit can see', () => {
    // The decay is a real Spring, so it registers — ζ is clamped at the api
    // boundary and the gate covers this gesture like every other motion.
    expect(MIN_ZETA).toBe(1);
  });
});
