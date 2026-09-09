/**
 * The follow camera's rule, and the four places it is wired.
 *
 * The rule is one sentence — the handset camera rides its own creature
 * unless the person has asked to look somewhere else — and it is exactly
 * the kind of sentence that survives review and then ships wrong, because
 * everything about it is in the wiring: which event turns it off, which
 * one turns it back on, and which ones must do neither.
 *
 * So the decision is pure and tested here, and the wiring is pinned as a
 * source fact in the same idiom the rest of the main.ts scans use — the
 * frame loop is a whole world with a gl context in it, and this project
 * keeps no jsdom.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFollow } from '../../src/world/follow';

const mainSrc = (): string => readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

/** The one per-frame block on the world page. */
const frameLoop = (): string =>
  /world\.onFrame\(\(dt, nowMs\) => \{[\s\S]*?\n  \}\);/.exec(mainSrc())?.[0] ?? '';

describe('the follow decision', () => {
  it('follows from the start — it does not wait to be asked', () => {
    // The creature exists before it moves: it spends its first minute as an
    // egg, and that spot is where somebody opening this view wants to be
    // looking. Waiting for the first nudge would open the world on
    // somebody else's corner of it.
    expect(createFollow().active()).toBe(true);
    expect(createFollow({ enabled: true }).active()).toBe(true);
  });

  it('never follows on a page with nothing of its own', () => {
    // A projection, a desktop, a handset whose owner has not drawn.
    const follow = createFollow({ enabled: false });
    expect(follow.active()).toBe(false);
    // ...and no amount of input can turn it on, or the frame loop would ask
    // forever for a position that will never exist.
    follow.resume();
    expect(follow.active()).toBe(false);
  });

  it('lets go when somebody asks to look somewhere else', () => {
    const follow = createFollow();
    follow.suspend();
    expect(follow.active()).toBe(false);
  });

  it('comes back when they walk', () => {
    const follow = createFollow();
    follow.suspend();
    follow.resume();
    expect(follow.active()).toBe(true);
  });

  it('is a state, not a count — repeats are harmless', () => {
    // Both edges arrive repeatedly: the map can be tapped twice and the
    // stick reports every frame it is held. A latch that counted would
    // need two taps to release after two holds.
    const follow = createFollow();
    follow.suspend();
    follow.suspend();
    follow.resume();
    expect(follow.active()).toBe(true);
    follow.resume();
    follow.resume();
    follow.suspend();
    expect(follow.active()).toBe(false);
  });
});

describe('where the follow camera is wired', () => {
  it('is armed only for a handset with a creature to follow', () => {
    expect(mainSrc()).toMatch(
      /createFollow\(\{ enabled: Boolean\(tray\?\.middle\) && myDrawerId\.length > 0 \}\)/,
    );
  });

  it('retargets the frame onto the creature every frame it is following', () => {
    // Every frame, not on arrival: frameAt retargets a ζ≥1 spring that
    // carries position and velocity across, so a target that moves a little
    // each frame is one continuous glide. Retargeting only on arrival would
    // be a series of slides that each have to stop.
    const loop = frameLoop();
    expect(loop).toBeTruthy();
    expect(loop).toMatch(/if \(follow\.active\(\)\) \{/);
    expect(loop).toMatch(/const at = creatures\.positionOf\(myDrawerId\);/);
    expect(loop).toMatch(/if \(at\) world\.cameraRig\.frameAt\(at\);/);
  });

  it('moves the look target and never the angle', () => {
    // Following and orbiting are two halves of the same camera, not two
    // modes competing for it. frameAt touches the target springs only;
    // rotateBy and the zoom are nowhere near this loop.
    const loop = frameLoop();
    expect(loop).not.toMatch(/rotateBy|zoomTo|zoomBy|zoomDirect|panBy/);
  });

  it('suspends on the minimap tap, and only there', () => {
    expect(mainSrc()).toMatch(/onFocus: \(\) => follow\.suspend\(\)/);
    // Exactly one place lets go. In particular the canvas orbit handlers do
    // not: turning the camera around your creature is looking AT it, and a
    // drag that dropped the follow would make the control feel broken.
    expect(mainSrc().match(/follow\.suspend\(\)/g)).toHaveLength(1);
  });

  it('the map actually tells anyone it was tapped', () => {
    // The option is inert if the click handler never calls it — and the
    // failure is silent, which is the whole reason this line is pinned.
    const map = readFileSync(join(process.cwd(), 'src/ui/minimap.ts'), 'utf8');
    expect(map).toMatch(/opts\.onFocus\?\.\(x, z\);/);
    // Before the reframe: whoever else is framing must have let go by the
    // time this slide starts, or it fights the first frame of it.
    expect(map).toMatch(/opts\.onFocus\?\.\(x, z\);\s*\n\s*opts\.cameraRig\.frameAt/);
  });

  it('resumes on the first non-zero stick input, from the stick itself', () => {
    // Wired to onChange rather than to the drive publisher: the publisher
    // only exists inside the sync block, so a phone that never reached the
    // broker could walk its creature and never get its camera back.
    expect(mainSrc()).toMatch(/if \(v\.mag > 0\) follow\.resume\(\);/);
    expect(mainSrc().match(/follow\.resume\(\)/g)).toHaveLength(1);
  });

  it('asks the manager for its own creature by id, egg or hatched', () => {
    // positions() is anonymous on purpose — the world view has no "self" —
    // so following needs the one accessor that takes an id, and it has to
    // answer for an egg too or the camera opens on an empty field.
    const manager = readFileSync(join(process.cwd(), 'src/creatures/manager.ts'), 'utf8');
    expect(manager).toMatch(/positionOf\(id\) \{[\s\S]*?worldPositionOf\(slot\)/);
    // worldPositionOf is the shared reader, and it already falls back from
    // the character root to the egg's group.
    expect(manager).toMatch(/slot\.characterRoot \?\? slot\.egg\?\.group \?\? null/);
  });

  it('leaves the tour alone', () => {
    // The tour is 'manual' by default (src/world/tour.ts) and nothing on a
    // handset turns it on, so following never has to argue with it. Its
    // notifyUserInput stays wired to the canvas exactly as it was.
    const tour = readFileSync(join(process.cwd(), 'src/world/tour.ts'), 'utf8');
    expect(tour).toMatch(/let currentMode: TourMode = 'manual';/);
    expect(mainSrc()).toMatch(
      /canvas\.addEventListener\('pointerdown', \(\) => tour\.notifyUserInput\(\)/,
    );
    expect(frameLoop()).not.toMatch(/notifyUserInput/);
  });
});
