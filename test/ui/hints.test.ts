/**
 * The contextual hints on the world view (src/ui/hints.ts, hintcopy.ts).
 *
 * > User ask, 2026-09-17, with three screenshots of the live slides: *"For
 * > mobile I want the onboarding to be contextual within the device."*
 *
 * The three lessons are the same; what changed is that they are marks IN the
 * game, anchored to the thing they are about and dismissed by DOING it. What
 * is pinned here, in the order it can go wrong:
 *
 * 1. THE COPY — three lines, in the order the game is learned, all lowercase
 *    (TASTE §5), each asking for a mark and a place that already exist.
 * 2. THE MACHINE — the order, what dismisses what, and the two things that
 *    must never happen: a hint over the loading line, and a hint coming back.
 * 3. THE LAYER — it mounts at the right anchor, slides (never pops), drifts,
 *    skips, and leaves.
 * 4. ONCE PER DEVICE — under a NEW key, so everybody who saw the slideshow
 *    is taught once by these.
 * 5. THE GATE — nothing is reached on a world without the game, and it
 *    arrives by dynamic import like the readout and the loading line.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRIVE_HELD_MS,
  GROW_MS,
  HINT_COUNT,
  HINT_START,
  HINTS_KEY,
  MOVE_UNITS,
  PICKUP_STEP_U,
  hinted,
  hintsFinished,
  iconRings,
  installWorldHints,
  markHinted,
  shouldHint,
  stepHints,
  type HintSignals,
  type HintState,
} from '../../src/ui/hints';
import { HINTS, SKIP_LABEL, hintFor } from '../../src/ui/hintcopy';
import { DEADZONE } from '../../src/world/joystick';
import { MOTION } from '../../src/taste/tokens';
import { find, findAll, stubDom, stubStore, type StubEl } from './stubdom';

const IDLE: HintSignals = {
  ready: false,
  loading: true,
  drive: 0,
  travelled: 0,
  picked: 0,
};
/** The world is up, the creature stands, nobody has touched anything. */
const READY: HintSignals = { ...IDLE, ready: true, loading: false };

describe('the copy — three lessons, in the order the game is learned', () => {
  it('teaches the stick, then the pickup, then the point', () => {
    expect(HINTS.map((h) => h.stage)).toEqual(['move', 'pickup', 'grow']);
    expect(HINTS.map((h) => h.line)).toEqual([
      'move with the joystick to roll your creature',
      'run into things to pick them up',
      'grow as big as you can',
    ]);
    expect(HINT_COUNT).toBe(3);
  });

  it('is lowercase, everywhere, including the way out (TASTE §5)', () => {
    for (const line of [...HINTS.map((h) => h.line), SKIP_LABEL]) {
      expect(line).toBe(line.toLowerCase());
      expect(line).not.toMatch(/[A-Z]/);
    }
  });

  it('anchors each line to the thing it is about', () => {
    // The stick's lesson stands over the stick; the two about the ball stand
    // by the number that measures it.
    expect(hintFor('move')?.anchor).toBe('stick');
    expect(hintFor('pickup')?.anchor).toBe('readout');
    expect(hintFor('grow')?.anchor).toBe('readout');
    expect(hintFor('nonsense')).toBe(null);
  });

  it('asks only for marks this world already draws', () => {
    for (const { icon } of HINTS) {
      const rings = iconRings(icon);
      expect(rings.length).toBeGreaterThan(0);
      for (const r of rings) expect(r.r).toBeGreaterThan(0);
    }
    const [small, big] = iconRings('grow');
    expect(big!.r).toBeGreaterThan(small!.r * 2);
  });
});

// ── the machine ──────────────────────────────────────────────────────────────

/** Run the machine over a sequence of frames, returning what was on screen. */
function run(
  frames: { signals: HintSignals; dt?: number }[],
  from: HintState = HINT_START,
): { state: HintState; phases: string[] } {
  let state = from;
  const phases: string[] = [from.phase];
  for (const f of frames) {
    state = stepHints(state, f.signals, f.dt ?? 1000 / 30);
    if (phases[phases.length - 1] !== state.phase) phases.push(state.phase);
  }
  return { state, phases };
}

describe('the machine — taught by doing, in order', () => {
  it('says nothing while the world is still loading', () => {
    const { state, phases } = run(
      Array.from({ length: 60 }, () => ({ signals: { ...IDLE, ready: true } })),
    );
    expect(state.phase).toBe('none');
    expect(phases).toEqual(['none']);
  });

  it('says nothing before the creature can be driven', () => {
    const { state } = run(
      Array.from({ length: 60 }, () => ({ signals: { ...IDLE, loading: false } })),
    );
    expect(state.phase).toBe('none');
  });

  it('shows the stick’s lesson the moment the stick can move something', () => {
    const { state } = run([{ signals: READY }]);
    expect(state.phase).toBe('move');
    expect(hintFor(state.phase)?.line).toBe(HINTS[0]!.line);
  });

  it('keeps it up for a brush against the glass, and drops it for a drive', () => {
    let state = stepHints(HINT_START, READY, 33);
    expect(state.phase).toBe('move');
    // A touch inside the deadzone is not a drive, however long it lasts.
    for (let i = 0; i < 200; i++) {
      state = stepHints(state, { ...READY, drive: DEADZONE }, 33);
    }
    expect(state.phase).toBe('move');
    // Held past it, but not yet for long enough.
    state = stepHints(state, { ...READY, drive: 0.9 }, DRIVE_HELD_MS - 1);
    expect(state.phase).toBe('move');
    // …and now it is a drive.
    state = stepHints(state, { ...READY, drive: 0.9 }, 2);
    expect(state.phase).toBe('moved');
  });

  it('forgets a push that was let go of — it wants one held drive', () => {
    let state = stepHints(HINT_START, READY, 33);
    for (let i = 0; i < 10; i++) {
      state = stepHints(state, { ...READY, drive: 0.8 }, DRIVE_HELD_MS / 4);
      state = stepHints(state, { ...READY, drive: 0 }, 33);
    }
    expect(state.phase).toBe('move');
    expect(state.heldMs).toBe(0);
  });

  it('brings the pickup lesson once the creature is actually rolling', () => {
    let state = stepHints(HINT_START, READY, 33);
    state = stepHints(state, { ...READY, drive: 1 }, DRIVE_HELD_MS);
    expect(state.phase).toBe('moved');
    // Nothing on screen while it is only a step or two.
    state = stepHints(state, { ...READY, travelled: MOVE_UNITS - 0.1 }, 33);
    expect(state.phase).toBe('moved');
    expect(hintFor(state.phase)).toBe(null);
    state = stepHints(state, { ...READY, travelled: MOVE_UNITS }, 33);
    expect(state.phase).toBe('pickup');
  });

  it('drops it on the first pickup, and points at the number instead', () => {
    let state: HintState = { phase: 'pickup', heldMs: 0, shownMs: 0, pickedAt: 0 };
    for (let i = 0; i < 100; i++) state = stepHints(state, { ...READY, picked: 0 }, 33);
    expect(state.phase).toBe('pickup');
    state = stepHints(state, { ...READY, picked: 1 }, 33);
    expect(state.phase).toBe('grow');
    expect(hintFor(state.phase)?.anchor).toBe('readout');
  });

  it('ends on the next pickup, or on its own if nobody picks anything', () => {
    let onPickup: HintState = { phase: 'grow', heldMs: 0, shownMs: 0, pickedAt: 1 };
    onPickup = stepHints(onPickup, { ...READY, picked: 2 }, 33);
    expect(onPickup.phase).toBe('done');

    let onTime: HintState = { phase: 'grow', heldMs: 0, shownMs: 0, pickedAt: 1 };
    onTime = stepHints(onTime, { ...READY, picked: 1 }, GROW_MS - 1);
    expect(onTime.phase).toBe('grow');
    onTime = stepHints(onTime, { ...READY, picked: 1 }, 2);
    expect(onTime.phase).toBe('done');
    expect(hintsFinished(onTime)).toBe(true);
  });

  it('never comes back, whatever happens afterwards', () => {
    let state: HintState = { phase: 'done', heldMs: 0, shownMs: 0, pickedAt: 3 };
    for (const signals of [IDLE, READY, { ...READY, drive: 1 }, { ...READY, picked: 9 }]) {
      for (let i = 0; i < 50; i++) state = stepHints(state, signals, 33);
    }
    expect(state.phase).toBe('done');
  });

  it('walks the whole tour in one pass, and only forwards', () => {
    const frames: { signals: HintSignals; dt?: number }[] = [];
    // the world comes up
    for (let i = 0; i < 5; i++) frames.push({ signals: { ...IDLE, ready: true } });
    // it stands
    frames.push({ signals: READY });
    // a held drive
    frames.push({ signals: { ...READY, drive: 1 }, dt: DRIVE_HELD_MS });
    // …which carries it a few units
    frames.push({ signals: { ...READY, drive: 1, travelled: MOVE_UNITS } });
    // …into something
    frames.push({ signals: { ...READY, travelled: MOVE_UNITS, picked: 1 } });
    // …and then it runs out
    frames.push({ signals: { ...READY, picked: 1 }, dt: GROW_MS });
    const { phases } = run(frames);
    expect(phases).toEqual(['none', 'move', 'moved', 'pickup', 'grow', 'done']);
  });

  it('measures a pickup as a CHANGE, not as a diameter', () => {
    // A creature's own footprint is a diameter from the moment it hatches, so
    // the step has to be small and nonzero (src/main.ts reads it).
    expect(PICKUP_STEP_U).toBeGreaterThan(0);
    expect(PICKUP_STEP_U).toBeLessThan(0.1);
  });

  it('takes its durations from motion tokens, never literals', () => {
    expect(DRIVE_HELD_MS).toBe(MOTION.secondaryMs);
    expect(GROW_MS).toBe(MOTION.primaryMs * 3);
  });
});

// ── once per device ──────────────────────────────────────────────────────────

describe('taught once per device, under a key of their own', () => {
  it('uses a NEW key, so the slideshow’s flag does not silence them', () => {
    expect(HINTS_KEY).toBe('refworld:hinted');
    expect(HINTS_KEY).not.toBe('refworld:onboarded');
    // A phone that saw the slides is taught by these exactly once.
    expect(shouldHint('', stubStore({ 'refworld:onboarded': '1' }))).toBe(true);
  });

  it('is written once and then stays quiet', () => {
    const store = stubStore();
    expect(shouldHint('', store)).toBe(true);
    markHinted(store);
    expect(store.data[HINTS_KEY]).toBe('1');
    expect(hinted(store)).toBe(true);
    expect(shouldHint('', store)).toBe(false);
  });

  it('re-shows for ?hints=1, and for the ?onboard=1 link it replaced', () => {
    const store = stubStore({ [HINTS_KEY]: '1' });
    expect(shouldHint('?hints=1', store)).toBe(true);
    expect(shouldHint('?view=world&onboard=1', store)).toBe(true);
    expect(shouldHint('?hints=0', stubStore())).toBe(false);
  });

  it('survives a store that throws, and teaches rather than hiding', () => {
    const angry = {
      getItem: (): string | null => {
        throw new Error('private window');
      },
      setItem: (): void => {
        throw new Error('private window');
      },
    };
    expect(() => markHinted(angry)).not.toThrow();
    expect(hinted(angry)).toBe(false);
    expect(shouldHint('', angry)).toBe(true);
    expect(shouldHint('', null)).toBe(true);
  });
});

// ── the layer, against a recording DOM ───────────────────────────────────────

describe('the hints on screen', () => {
  it('slides in, drifts, and leaves without popping', () => {
    const dom = stubDom();
    const signals = { ...READY };
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => signals,
      store: stubStore(),
    });
    // First painted frame: the lesson is on screen, and not in place yet —
    // it arrives on a ζ ≥ 1 spring, written per frame (never a class-driven
    // transition: on the built page one of those never ran at all).
    dom.step(40);
    expect(handle.showing()).toBe('move');
    expect(handle.line()).toBe(HINTS[0]!.line);
    const row = find(dom.mount, 'world-hint-row')!;
    const presence = (): number => Number.parseFloat(row.style['opacity'] ?? '0');
    const offset = (): number =>
      Number.parseFloat(/translateY\(([-\d.]+)px\)/.exec(row.style['transform'] ?? '')?.[1] ?? '0');
    expect(presence()).toBeLessThan(0.2);
    // In from BELOW: a positive offset that shrinks as it settles.
    expect(offset()).toBeGreaterThan(0);
    let previous = presence();
    for (let f = 2; f < 40; f++) {
      dom.step(f * 40);
      // It only ever comes in — ζ ≥ 1, so it cannot overshoot and fall back.
      expect(presence()).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = presence();
    }
    expect(presence()).toBeCloseTo(1, 1);
    expect(Math.abs(offset())).toBeLessThan(0.5);

    // The drift floor runs underneath it (TASTE §3).
    const drift = find(dom.mount, 'world-hint-drift')!;
    const at = drift.style['transform'];
    expect(at).toMatch(/^translate\(/);
    for (let f = 40; f < 80; f++) dom.step(f * 40);
    expect(drift.style['transform']).not.toBe(at);

    // A held drive retires it — by sliding out UPWARDS, not by vanishing.
    signals.drive = 1;
    dom.step(80 * 40 + DRIVE_HELD_MS);
    dom.step(80 * 40 + DRIVE_HELD_MS + 40);
    expect(handle.showing()).toBe('');
    expect(presence()).toBeLessThan(1);
    dom.step(80 * 40 + DRIVE_HELD_MS + 120);
    expect(offset()).toBeLessThan(0);
    handle.dispose();
    dom.restore();
  });

  it('puts the stick’s lesson in the tray when it is given one', () => {
    const dom = stubDom();
    const tray = (globalThis.document as unknown as { createElement(t: string): StubEl })
      .createElement('div');
    dom.mount.appendChild(tray);
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      stickMount: tray as unknown as HTMLElement,
      signals: () => READY,
      store: stubStore(),
    });
    dom.step(40);
    // In the tray, and marked as the anchor it asked for.
    const hint = find(tray, 'world-hint at-stick');
    expect(hint).not.toBe(null);
    handle.dispose();
    dom.restore();
  });

  it('is skippable in one tap, and writes the flag when it is', () => {
    const dom = stubDom();
    const store = stubStore();
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => READY,
      store,
    });
    dom.step(40);
    const skip = find(dom.mount, 'world-hint-skip')!;
    expect(skip.textContent).toBe(SKIP_LABEL);
    skip.fire('click');
    expect(handle.phase()).toBe('done');
    expect(handle.showing()).toBe('');
    expect(store.data[HINTS_KEY]).toBe('1');
    // …and nothing comes back on later frames.
    for (let f = 2; f < 60; f++) dom.step(f * 40);
    expect(handle.showing()).toBe('');
    handle.dispose();
    dom.restore();
  });

  it('writes the flag when the tour finishes on its own', () => {
    const dom = stubDom();
    const store = stubStore();
    // Somebody who drives, rolls into something, and then stops playing with
    // the last hint up: the whole tour without a single tap on the skip.
    const signals = { ...READY, drive: 1, travelled: MOVE_UNITS, picked: 0 };
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => signals,
      store,
    });
    let at = 0;
    const step = (ms: number): void => {
      at += ms;
      dom.step(at);
    };
    step(40);
    step(DRIVE_HELD_MS);
    step(40);
    expect(handle.phase()).toBe('pickup');
    signals.picked = 1;
    step(40);
    expect(handle.phase()).toBe('grow');
    expect(handle.line()).toBe(HINTS[2]!.line);
    step(GROW_MS);
    expect(handle.phase()).toBe('done');
    expect(handle.showing()).toBe('');
    expect(store.data[HINTS_KEY]).toBe('1');
    handle.dispose();
    dom.restore();
  });

  it('shows nothing at all while the loading line is up', () => {
    const dom = stubDom();
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => ({ ...READY, loading: true }),
      store: stubStore(),
    });
    for (let f = 1; f < 60; f++) dom.step(f * 40);
    expect(handle.showing()).toBe('');
    expect(findAll(dom.mount, 'world-hint-row').length).toBe(0);
    handle.dispose();
    dom.restore();
  });

  it('is marks only — no panel, no card, no shadow (TASTE §4)', () => {
    const dom = stubDom();
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => READY,
      store: stubStore(),
    });
    const sheet = dom.head.children[0]!.textContent;
    // The rule mark is there…
    expect(sheet).toContain('border-bottom: 1px solid');
    // …and nothing this taste has no mark for is.
    expect(sheet).not.toMatch(/\bbackground\b/);
    expect(sheet).not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/border-radius/);
    expect(sheet).not.toMatch(/gradient/);
    expect(sheet).not.toMatch(/\b(?:linear|ease-in-out)\b/);
    expect(sheet).not.toMatch(/scale\(0/);
    handle.dispose();
    dom.restore();
  });

  it('takes itself off the page on dispose, and stops reading', () => {
    const dom = stubDom();
    let reads = 0;
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => {
        reads++;
        return READY;
      },
      store: stubStore(),
    });
    dom.step(40);
    expect(findAll(dom.mount, 'world-hint-row').length).toBe(1);
    const after = reads;
    handle.dispose();
    expect(findAll(dom.mount, 'world-hint-row').length).toBe(0);
    dom.step(66);
    expect(reads).toBe(after);
    dom.restore();
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe('the hints are absent on a world without the game', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

  it('is mounted only behind the katamari flag, the handset and a creature', () => {
    const site =
      /if \(worldGame === 'katamari' && handheld\) \{[\s\S]{0,600}?if \(myDrawerId\.length > 0\) \{[\s\S]{0,3000}?installWorldHints\(/;
    expect(main).toMatch(site);
    expect([...main.matchAll(/installWorldHints\(/g)].length).toBe(1);
  });

  it('is reached by a DYNAMIC import, so no other world fetches the chunk', () => {
    expect(main).toMatch(/void import\('\.\/ui\/hints'\)/);
    expect(main).not.toMatch(/^import .*'\.\/ui\/hints'/m);
    expect(main).toMatch(/if \(!m\.shouldHint\(location\.search, m\.deviceStore\(\)\)\) return;/);
  });

  it('reads its five signals through the seams this page already has', () => {
    // No second event path for any of them (docs/PLAN.md §7.6): the manager's
    // own answers, the stick's own vector, and the loading line's own state.
    expect(main).toMatch(/ready: standing && stick !== null/);
    expect(main).toMatch(/loading: loadingLine !== null && !loadingLine\.gone\(\)/);
    expect(main).toMatch(/drive: stickVec\.mag/);
    expect(main).toMatch(/creatures\.ballDiameter\(myDrawerId\)/);
    expect(main).toMatch(/travelled \+= Math\.hypot/);
  });

  it('puts the stick’s hint in the tray the stick is in', () => {
    expect(main).toMatch(/stickMount: tray\?\.middle \?\? null/);
  });

  it('left the old slideshow behind entirely', () => {
    expect(main).not.toMatch(/installOnboarding|ui\/onboard/);
    const phone = readFileSync(join(process.cwd(), 'src/phone/main.ts'), 'utf8');
    expect(phone).not.toMatch(/installOnboarding|ui\/onboard/);
  });
});
