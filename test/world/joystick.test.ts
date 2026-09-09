/**
 * The stick's two pure halves: what a thumb on glass means, and where that
 * points once the isometric camera has had its say.
 *
 * Both are here rather than in the tray because both have a right answer
 * that is easy to get wrong in a way nobody notices until a creature walks
 * the wrong way on a projector.
 *
 * The mark itself is at the end, pinned as a source fact — the painting is
 * DOM-shaped, this project keeps no jsdom, and what matters about it is
 * which token each part is drawn in.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEADZONE,
  STICK_REST,
  WORLD_REST,
  stickToWorld,
  stickVector,
  wavyRingPoints,
} from '../../src/world/joystick';
import { SURFACE, WORLD } from '../../src/taste/tokens';

const CENTRE = 100;
const RADIUS = 50;

/** A thumb at (dx, dy) from the centre, in fractions of the radius. */
const at = (dx: number, dy: number) =>
  stickVector(CENTRE, CENTRE, CENTRE + dx * RADIUS, CENTRE + dy * RADIUS, RADIUS);

describe('stickVector', () => {
  it('rests in the middle, and inside the deadzone', () => {
    expect(at(0, 0)).toEqual(STICK_REST);
    expect(at(DEADZONE * 0.9, 0).mag).toBe(0);
  });

  it('leaves the deadzone from zero, not from a step', () => {
    // Rescaled, not subtracted. Subtracting would have the creature jump
    // straight to a tenth of full speed the instant the stick moved off
    // centre — a hard cut in velocity, which the motion law forbids.
    const justOut = at(DEADZONE + 0.001, 0);
    expect(justOut.mag).toBeGreaterThan(0);
    expect(justOut.mag).toBeLessThan(0.01);
  });

  it('clamps to the disc, so a corner is not faster than an axis', () => {
    // The oldest bug in this control: clamping each axis separately makes
    // the diagonal √2 times quicker, which people feel and cannot name.
    const axis = at(1, 0);
    const corner = at(1, 1);
    expect(axis.mag).toBeCloseTo(1, 6);
    expect(corner.mag).toBeCloseTo(1, 6);
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1, 6);
  });

  it('never exceeds full deflection however far past the rim it is dragged', () => {
    const far = at(12, -9);
    expect(far.mag).toBeCloseTo(1, 6);
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('keeps the direction the thumb is actually in', () => {
    const up = at(0, -1);
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(-1, 6);
    const rightish = at(1, 0);
    expect(rightish.x).toBeCloseTo(1, 6);
    expect(rightish.y).toBeCloseTo(0, 6);
  });

  it('is inert with no radius rather than dividing by zero', () => {
    // A control measured before layout has run. It must read as centred,
    // not as NaN — a NaN reaches the creature's velocity and the creature
    // disappears from the world entirely.
    expect(stickVector(0, 0, 10, 10, 0)).toEqual(STICK_REST);
  });
});

describe('stickToWorld', () => {
  /** The camera's default: true isometric, azimuth 45°. */
  const ISO = Math.PI / 4;

  it('pushes the creature away from the viewer when the thumb goes up', () => {
    // The camera sits at (sin a, ·, cos a) looking at the origin, so away
    // from the viewer is (−sin a, −cos a). At 45° that is negative in both.
    const away = stickToWorld({ x: 0, y: -1, mag: 1 }, ISO);
    expect(away.x).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(away.z).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it('pulls it back toward the viewer when the thumb goes down', () => {
    // Screen y grows downward — the sign that is wrong in every first
    // attempt at this.
    const toward = stickToWorld({ x: 0, y: 1, mag: 1 }, ISO);
    expect(toward.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(toward.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('sends it across the screen, square to the way it would walk away', () => {
    const away = stickToWorld({ x: 0, y: -1, mag: 1 }, ISO);
    const right = stickToWorld({ x: 1, y: 0, mag: 1 }, ISO);
    // Perpendicular on the ground: a dot product of zero is the whole
    // claim that these are screen axes and not two arbitrary directions.
    expect(away.x * right.x + away.z * right.z).toBeCloseTo(0, 6);
  });

  it('follows the camera as it orbits', () => {
    // The tour drifts the azimuth continuously, so the same thumb position
    // has to mean a different ground direction from one second to the next.
    const a = stickToWorld({ x: 0, y: -1, mag: 1 }, 0);
    const b = stickToWorld({ x: 0, y: -1, mag: 1 }, Math.PI / 2);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1);
    // A quarter turn of the camera is a quarter turn of the direction.
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.z).toBeCloseTo(-1, 6);
    expect(b.x).toBeCloseTo(-1, 6);
    expect(b.z).toBeCloseTo(0, 6);
  });

  it('preserves strength, and rotation alone cannot change it', () => {
    for (const az of [0, 0.4, ISO, 2.2, -1.1]) {
      const v = stickToWorld({ x: 0.6, y: -0.8, mag: 0.5 }, az);
      expect(v.mag).toBe(0.5);
      // The direction stays a unit vector; `mag` carries the strength, so
      // the manager can scale by the creature's own speed rather than
      // inheriting a magnitude from screen geometry.
      expect(Math.hypot(v.x, v.z)).toBeCloseTo(1, 6);
    }
  });

  it('is rest at rest, at every camera angle', () => {
    expect(stickToWorld(STICK_REST, ISO)).toEqual(WORLD_REST);
    expect(stickToWorld(STICK_REST, 1.7)).toEqual(WORLD_REST);
  });
});

describe('wavyRingPoints', () => {
  it('closes, wavers, and is deterministic per seed', () => {
    const a = wavyRingPoints(50, 50, 40, 31);
    const b = wavyRingPoints(50, 50, 40, 31);
    expect(a).toEqual(b);
    expect(wavyRingPoints(50, 50, 40, 32)).not.toEqual(a);

    // Every point near the nominal radius, none exactly on it — a true
    // circle is the most engineered shape there is, and this taste has no
    // engineered geometry in it.
    const radii = a.map((p) => Math.hypot(p.x - 50, p.y - 50));
    expect(Math.min(...radii)).toBeGreaterThan(38);
    expect(Math.max(...radii)).toBeLessThan(42);
    expect(radii.every((r) => r !== 40)).toBe(true);
  });
});

describe('the stick as a mark', () => {
  const src = () => readFileSync(join(process.cwd(), 'src/world/joystick.ts'), 'utf8');

  it('fills the knob with the paper light the device carries', () => {
    // User ask, 2026-09-09: "fill in the center of the joystick with the
    // same offwhite fill as the device". The shell's body is #e9ebe9 —
    // WORLD.light — so the token is the same one, never a second literal
    // that happens to match today (the static gate bans the literal here
    // anyway, which is the point of the token).
    expect(src()).toMatch(/\.stick-knob \{ fill: \$\{WORLD\.light\};/);
    expect(WORLD.light).toBe(SURFACE.canvas);
    // ...and it keeps its ink outline. Light shape, dark wobbly line: the
    // rule every form in this world is drawn to, and what stops a filled
    // knob reading as a panel (TASTE §4).
    expect(src()).toMatch(/\.stick-ring,\s*\n\.stick-knob \{\s*\n\s*stroke: \$\{WORLD\.ink\}/);
    expect(src()).toMatch(/\.stick-knob \{ fill: [^;]*; stroke-width: 1\.75/);
  });

  it('leaves the well itself a hole through to the world', () => {
    // Only the knob gained a fill. A filled well would be a dish sitting on
    // the world — a card by another name.
    expect(src()).toMatch(/\.stick-ring \{ fill: none;/);
  });

  it('never goes near the value the creature owns', () => {
    // Near-black belongs to characters only (TASTE §1). A control as dark
    // as the thing it steers competes with it.
    expect(src()).not.toMatch(/CHARACTER\.|nearBlack/);
  });
});
