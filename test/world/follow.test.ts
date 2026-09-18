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
import { createFollow, createFollowAim } from '../../src/world/follow';
import { PHONE_FOLLOW_ZOOM, followSpringLag, followZoomFor } from '../../src/world/camera';

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
    // The condition is named now (2026-09-17) because `shouldCloseOnHatch`
    // asks the same question about the same page — one answer to "can this
    // page follow at all", read by both, rather than the expression twice.
    expect(mainSrc()).toMatch(
      /const canFollow = Boolean\(tray\?\.middle\) && myDrawerId\.length > 0;/,
    );
    expect(mainSrc()).toMatch(/createFollow\(\{ enabled: canFollow \}\)/);
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
    // TWO branches since 2026-09-17: the katamari handset's tight follow
    // aims at the LED point (`followAim`, src/world/follow.ts), and every
    // other world retargets onto the creature exactly as it shipped.
    expect(loop).toMatch(/if \(at && followTight\) \{/);
    expect(loop).toMatch(/world\.cameraRig\.frameAt\(followPoint\.set\(aim\.x, 0, aim\.z\)\);/);
    expect(loop).toMatch(/\} else if \(at\) \{[\s\S]*?world\.cameraRig\.frameAt\(at\);/);
  });

  it('moves the look target and never the angle', () => {
    // Following and orbiting are two halves of the same camera, not two
    // modes competing for it. frameAt touches the target springs only, and
    // the ANGLE is never touched here: a one-finger drag keeps orbiting
    // around the creature for the whole time it is being followed.
    const loop = frameLoop();
    expect(loop).not.toMatch(/rotateBy\(|panBy\(|rotateBy |panBy /);
  });

  it('widens the frame as the ball grows, and only when it changes', () => {
    /*
     * The ZOOM is in this loop since 2026-09-17 (user ask: *"we should allow
     * for larger mass sizes than 10 meters for users"* — a 20 m ball framed
     * at the hatch zoom is a wall). It is not the angle: the angle is still
     * entirely the person's, and this one rule was the reason the loop used
     * to be pinned zoom-free.
     *
     * The guard is what keeps the pinch. Retargeting every frame would undo
     * a two-finger zoom on the frame after the fingers moved, so the loop
     * only asks when the answer has actually changed — and then it
     * RETARGETS, on the rig's own ζ≥1 spring.
     */
    const loop = frameLoop();
    /*
     * The radius it frames by is the DRAWN MASS since 2026-09-18 (user
     * report: *"The camera is also too far zoomed out"*): `ballDiameter` is
     * the accumulated volume — the game's size — and it runs well ahead of
     * the packed pile, so framing on it opened the view for a ball twice the
     * size of anything on screen. Measured on a 390x844 frame, a 2.2 u mass
     * that read 7.1 u of volume: 1.22 -> 2.60 at rest.
     */
    expect(loop).toMatch(/creatures\.drawnRadius\(myDrawerId\)/);
    expect(loop).toMatch(/creatures\.pileFootprint\(myDrawerId\)/);
    expect(loop).not.toMatch(/const ballR = creatures\.ballDiameter/);
    // The ZOOM comes off the same pure answer as the aim since 2026-09-17:
    // the tight framing, widened by the pile AND by however far the frame is
    // actually behind the creature (`followZoomFor`, via `createFollowAim`).
    expect(loop).toMatch(/const want = aim\.zoom;/);
    expect(loop).toMatch(/if \(Math\.abs\(want - lastFollowZoom\) > 0\.01\) \{/);
    expect(loop).toMatch(/world\.cameraRig\.zoomTo\(want\);/);
    // Never a direct write: `zoomDirect` resets the spring, which is a cut.
    expect(loop).not.toMatch(/zoomDirect|zoomBy/);
  });

  it('suspends on the minimap tap and on a hand that reframes, and nowhere else', () => {
    expect(mainSrc()).toMatch(/onFocus: \(\) => follow\.suspend\(\)/);
    /*
     * TWO places let go since 2026-09-17 (user ask: *"if a user wants to zoom
     * out and pan around they still can"*): the map's tap, and the world's
     * own report that the person framed the view themselves — a pinch, a
     * wheel or a shift-drag pan (`setFreeLook`, src/world/scene.ts).
     *
     * Still not the ORBIT, which does not report at all: turning the camera
     * around your creature is looking AT it.
     */
    expect(mainSrc()).toMatch(/world\.setFreeLook\(\(\) => follow\.suspend\(\)\);/);
    expect(mainSrc().match(/follow\.suspend\(\)/g)).toHaveLength(2);
    const scene = readFileSync(join(process.cwd(), 'src/world/scene.ts'), 'utf8');
    // The gesture seam: the pan, the pinch and the wheel report; the orbit
    // branch is the one that does not.
    expect(scene).toMatch(/reframedByHand\(\);\s*\n\s*cameraRig\.panBy/);
    expect(scene).toMatch(/reframedByHand\(\);\s*\n\s*cameraRig\.zoomDirect/);
    expect(scene).toMatch(/reframedByHand\(\);\s*\n\s*cameraRig\.zoomBy/);
    expect(scene).not.toMatch(/reframedByHand\(\);\s*\n\s*cameraRig\.rotateBy/);
    expect(scene.match(/reframedByHand\(\);/g)).toHaveLength(3);
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
    // On the EDGE and not on every frame of the hold (2026-09-17): the push
    // past the deadzone is also the recentre, and dropping `lastFollowZoom`
    // is what makes the next followed frame slide back to the tight framing.
    expect(mainSrc()).toMatch(
      /const held = v\.mag > 0;\s*\n\s*if \(held && !stickHeld\) \{\s*\n\s*follow\.resume\(\);\s*\n\s*lastFollowZoom = 0;/,
    );
    // …and both edges reach the follow, because a gesture made mid-drive must
    // not be able to let go of the creature (`Follow.driving`).
    expect(mainSrc()).toMatch(/follow\.driving\(held\);/);
    // TWO callers now (2026-09-17): the stick, and your own shell opening —
    // somebody who tapped the map before the hatch asked to look elsewhere,
    // and their own creature coming out is the one thing worth taking that
    // back for. Still nothing else.
    expect(mainSrc().match(/follow\.resume\(\);/g)).toHaveLength(2);
  });

  it('closes the camera in when this page\u2019s own shell opens', () => {
    // On the ONE seam every hatch crosses — the observer — because a
    // viewer's creature opens because the host said so, and a viewer is
    // what a handset in a room of phones is (src/net/worldsync.ts).
    expect(mainSrc()).toMatch(/closeOnMyHatch\(id\);/);
    expect(mainSrc()).toMatch(
      /shouldCloseOnHatch\(\{ game: worldGame, hatched: id, mine: myDrawerId, canFollow \}\)/,
    );
    // At the FOLLOW framing, which is where the frame lives on this world —
    // the close-in is the start of the follow, not a framing of its own.
    expect(mainSrc()).toMatch(/world\.cameraRig\.closeOn\(at, PHONE_FOLLOW_ZOOM\)/);
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

describe('the tight follow is the katamari handset\u2019s alone', () => {
  it('hangs the whole of it on one flag, and the flag is the game\u2019s', () => {
    // Every other world's handset keeps the camera it shipped with: no raised
    // ceiling, no led aim, no gesture that lets go (the 2026-09-15 ruling).
    expect(mainSrc()).toMatch(
      /const followTight = worldGame === 'katamari' && canFollow;/,
    );
    expect(mainSrc()).toMatch(/if \(followTight\) world\.cameraRig\.raiseZoomCeiling\(PHONE_ZOOM_MAX\);/);
    expect(mainSrc()).toMatch(/if \(followTight\) \{[\s\S]*?world\.setFreeLook/);
    // …and the frame only ever opens itself on the first followed frame
    // because nothing has been asked for yet, which is what 0 means.
    expect(mainSrc()).toMatch(/let lastFollowZoom = followTight \? 0 : HATCH_CLOSE_ZOOM;/);
  });
});

describe('the stick owns the frame while it is held', () => {
  it('ignores a gesture made mid-drive, and takes the suspend back after', () => {
    const follow = createFollow();
    follow.driving(true);
    follow.suspend();
    // A drag still orbits and a pinch still zooms — they just do not let go.
    expect(follow.active()).toBe(true);
    expect(follow.held()).toBe(true);
    // The thumb lifts, and the next gesture suspends as it always did.
    follow.driving(false);
    follow.suspend();
    expect(follow.active()).toBe(false);
  });

  it('is a state, not a count, on this edge too', () => {
    const follow = createFollow();
    follow.driving(true);
    follow.driving(true);
    follow.driving(false);
    follow.suspend();
    expect(follow.active()).toBe(false);
  });

  it('cannot turn following on for a page that has none', () => {
    const follow = createFollow({ enabled: false });
    follow.driving(true);
    expect(follow.active()).toBe(false);
  });
});

describe('the follow aim', () => {
  const PHONE = 390 / 844;
  const aimAt = (close = PHONE_FOLLOW_ZOOM) => createFollowAim({ close });

  it('aims exactly at a creature that is standing still', () => {
    const aim = aimAt();
    let out = aim({ x: 4, z: -7, bodyR: 1, lookX: 4, lookZ: -7, aspect: PHONE, dtMs: 16 });
    for (let i = 0; i < 200; i++) {
      out = aim({ x: 4, z: -7, bodyR: 1, lookX: 4, lookZ: -7, aspect: PHONE, dtMs: 16 });
    }
    expect(out.x).toBeCloseTo(4, 6);
    expect(out.z).toBeCloseTo(-7, 6);
    expect(out.zoom).toBe(PHONE_FOLLOW_ZOOM);
  });

  it('leads a moving creature by the reframe spring\u2019s own lag', () => {
    const aim = aimAt();
    const speed = 4.5;
    let x = 0;
    let out = { x: 0, z: 0, zoom: 0, behind: 0 };
    for (let i = 0; i < 400; i++) {
      x += (speed * 16) / 1000;
      out = aim({ x, z: 0, bodyR: 1, lookX: x, lookZ: 0, aspect: PHONE, dtMs: 16 });
    }
    // Ahead of the creature, by the closed form and in the direction of
    // travel — which is what makes the spring settle ON the creature.
    expect(out.x - x).toBeCloseTo(followSpringLag(speed), 2);
    expect(out.z).toBeCloseTo(0, 6);
  });

  it('never leads a creature it has only just found', () => {
    // The first frame has no previous position to difference, and a lead
    // invented out of a jump would be a cut.
    const out = aimAt()({ x: 90, z: 12, bodyR: 1, lookX: 0, lookZ: 0, aspect: PHONE, dtMs: 16 });
    expect(out.x).toBe(90);
    expect(out.z).toBe(12);
  });

  it('widens the zoom by what the frame is actually behind by', () => {
    const aim = aimAt();
    const near = aim({ x: 0, z: 0, bodyR: 1, lookX: 0, lookZ: 0, aspect: PHONE, dtMs: 16 });
    const far = aim({ x: 0, z: 0, bodyR: 1, lookX: 6, lookZ: 0, aspect: PHONE, dtMs: 16 });
    expect(near.behind).toBeCloseTo(0, 6);
    expect(far.behind).toBeCloseTo(6, 6);
    expect(far.zoom).toBeLessThan(near.zoom);
    // …and there is no feedback in it: the reading is a distance on the
    // ground, which does not depend on how wide the frame is.
    expect(far.zoom).toBe(
      followZoomFor(1, { close: PHONE_FOLLOW_ZOOM, aspect: PHONE, behind: 6 }),
    );
  });
});
