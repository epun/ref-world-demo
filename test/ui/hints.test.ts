/**
 * The contextual hints on the world view (src/ui/hints.ts, hintcopy.ts).
 *
 * > User ask, 2026-09-17, from a three-screen mock: *"For mobile I want the
 * > onboarding to be contextual within the device"*, and with the mock,
 * > *"retain our existing style for components"*.
 *
 * Three labels, centred in the screen, one at a time, each dismissed by DOING
 * what it says. What is pinned here, in the order it can go wrong:
 *
 * 1. THE COPY — the mock's three lines, in order, all lowercase (TASTE §5),
 *    and the chevrons asked for by the first step only.
 * 2. THE MACHINE — the order, what dismisses what, and the two things that
 *    must never happen: a label over the loading line, and a label coming
 *    back.
 * 3. THE LABEL — centred, paper inside the project's own wavering hairline
 *    (docs/TASTE.md §9a, the recorded paper-card ruling), spring-driven in and
 *    out, drifting, and gone when it is done. NOT the mock's filled pill with
 *    a drop shadow: *"retain our existing style"*.
 * 4. THE CHEVRONS — on the stick's own box, on step one and nowhere else.
 * 5. ONCE PER DEVICE — under a key of its own.
 * 6. THE GATE — nothing is reached on a world without the game, and it
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
  arrowPaths,
  hinted,
  hintsFinished,
  installWorldHints,
  labelFramePath,
  labelInset,
  markHinted,
  shouldHint,
  stepHints,
  type HintSignals,
  type HintState,
} from '../../src/ui/hints';
import { HINTS, hintFor, showsArrows } from '../../src/ui/hintcopy';
import { frameInset } from '../../src/ui/leaderboard';
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

describe('the copy — the mock’s three labels, in order', () => {
  it('says exactly what the mock says', () => {
    expect(HINTS.map((h) => h.stage)).toEqual(['move', 'pickup', 'grow']);
    expect(HINTS.map((h) => h.line)).toEqual([
      'move using the joystick',
      'roll over objects to collect',
      'become the biggest',
    ]);
    expect(HINT_COUNT).toBe(3);
  });

  it('is lowercase and short enough to read at a glance (TASTE §5)', () => {
    for (const { line } of HINTS) {
      expect(line).toBe(line.toLowerCase());
      expect(line).not.toMatch(/[A-Z]/);
      expect(line.length).toBeLessThan(32);
      expect(line).not.toContain('\n');
    }
  });

  it('puts the chevrons on the stick for the first step and no other', () => {
    expect(showsArrows('move')).toBe(true);
    expect(showsArrows('pickup')).toBe(false);
    expect(showsArrows('grow')).toBe(false);
    // …including the phases that show nothing at all.
    expect(showsArrows('moved')).toBe(false);
    expect(showsArrows('done')).toBe(false);
    expect(hintFor('nonsense')).toBe(null);
  });

  it('draws four chevrons, one per direction, as strokes and not a shape', () => {
    const paths = arrowPaths();
    expect(paths).toHaveLength(4);
    for (const d of paths) {
      // A tip and two strokes back to it: an open mark, never a closed fill.
      expect(d).toMatch(/^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/);
      expect(d).not.toContain('Z');
    }
    // Deterministic, so the same stick is the same hand on every device.
    expect(arrowPaths()).toEqual(paths);
  });
});

describe('the label’s frame — the project’s hand, not the mock’s pill', () => {
  it('insets its hairline exactly as the leaderboard and the map do', () => {
    // One expression for all four boxes (docs/TASTE.md §9a): if the
    // leaderboard's moves, this must move with it.
    for (const [w, h] of [[120, 44], [240, 52], [300, 80], [90, 36]]) {
      expect(labelInset(w!, h!)).toBe(frameInset(w!, h!));
    }
  });

  it('is a drawn wavering loop, closed, and nothing for a degenerate box', () => {
    const d = labelFramePath(220, 48);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    // Quadratic midpoint smoothing — the same generator as the minimap's
    // border, so the hand is one hand.
    expect(d).toContain(' Q ');
    expect(labelFramePath(2, 2)).toBe('');
    expect(labelFramePath(0, 0)).toBe('');
    // Deterministic per size and seed.
    expect(labelFramePath(220, 48)).toBe(d);
    expect(labelFramePath(220, 49)).not.toBe(d);
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

  it('drops it on the first pickup, and the last label takes its place', () => {
    let state: HintState = { phase: 'pickup', heldMs: 0, shownMs: 0, pickedAt: 0 };
    for (let i = 0; i < 100; i++) state = stepHints(state, { ...READY, picked: 0 }, 33);
    expect(state.phase).toBe('pickup');
    state = stepHints(state, { ...READY, picked: 1 }, 33);
    expect(state.phase).toBe('grow');
    expect(hintFor(state.phase)?.line).toBe(HINTS[2]!.line);
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

  it('puts four chevrons on the stick for step one, and takes them off', () => {
    const dom = stubDom();
    const stick = (globalThis.document as unknown as { createElement(t: string): StubEl })
      .createElement('div');
    dom.mount.appendChild(stick);
    const signals = { ...READY };
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      stickEl: stick as unknown as HTMLElement,
      signals: () => signals,
      store: stubStore(),
    });
    dom.step(40);
    // On the stick's own box — not in the label, and not on the page.
    const ring = find(stick, 'world-hint-arrows');
    expect(ring).not.toBe(null);
    expect(findAll(stick, 'world-hint-arrow')).toHaveLength(4);
    expect(handle.arrows()).toBe(true);
    // They fade in with the label rather than appearing (TASTE §2.1).
    expect(Number.parseFloat(ring!.style['opacity'] ?? '1')).toBeLessThan(1);
    for (let f = 2; f < 40; f++) dom.step(f * 40);
    expect(Number.parseFloat(ring!.style['opacity'] ?? '0')).toBeCloseTo(1, 1);

    // A held drive ends step one, and the chevrons go with it.
    signals.drive = 1;
    dom.step(40 * 40 + DRIVE_HELD_MS);
    expect(handle.arrows()).toBe(false);
    for (let f = 1; f < 60; f++) dom.step(40 * 40 + DRIVE_HELD_MS + f * 40);
    expect(find(stick, 'world-hint-arrows')).toBe(null);
    handle.dispose();
    dom.restore();
  });

  it('shows no chevrons at all on a page with no stick to point at', () => {
    const dom = stubDom();
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => READY,
      store: stubStore(),
    });
    dom.step(40);
    // The label still teaches; there is simply nothing to decorate.
    expect(handle.showing()).toBe('move');
    expect(handle.arrows()).toBe(false);
    expect(findAll(dom.mount, 'world-hint-arrow')).toHaveLength(0);
    handle.dispose();
    dom.restore();
  });

  it('stands the label on paper inside the wavering hairline (TASTE §9a)', () => {
    const dom = stubDom();
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => READY,
      store: stubStore(),
    });
    dom.step(40);
    const paper = find(dom.mount, 'world-hint-paper');
    expect(paper).not.toBe(null);
    // The recorded paper-card ruling: a drawn loop with a fill and the one
    // 1.25 hairline — never a css box, which would be a rectangle.
    const sheet = dom.head.children[0]!.textContent;
    expect(sheet).toContain('stroke-width: 1.25');
    expect(sheet).toMatch(/fill: var\(--rw-light,/);
    handle.dispose();
    dom.restore();
  });

  it('carries no skip and no dots — the mock has neither', () => {
    const dom = stubDom();
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => READY,
      store: stubStore(),
    });
    dom.step(40);
    // Each step dismisses itself on the action it teaches, so there is
    // nothing to press and nothing to count.
    expect(find(dom.mount, 'world-hint-skip')).toBe(null);
    expect(findAll(dom.mount, 'world-hint-tick')).toHaveLength(0);
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

  it('is marks only — the ruled paper, and no shadow or radius (TASTE §4, §9a)', () => {
    const dom = stubDom();
    const handle = installWorldHints({
      mount: dom.mount as unknown as HTMLElement,
      signals: () => READY,
      store: stubStore(),
    });
    const sheet = dom.head.children[0]!.textContent;
    // The paper is the recorded ruling — a DRAWN loop's fill and the one
    // hairline, with the type over it…
    expect(sheet).toContain('stroke-width: 1.25');
    // …and nothing this taste has no mark for is. No css background
    // DECLARATION in particular: the mock's filled pill is not what ships,
    // and the paper is a path's fill rather than a box's colour.
    expect(sheet).not.toMatch(/background\s*:/);
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

  it('hands the chevrons the stick’s own element', () => {
    expect(main).toMatch(/stickEl: stick\?\.el \?\? null/);
  });

  it('left the old slideshow behind entirely', () => {
    expect(main).not.toMatch(/installOnboarding|ui\/onboard/);
    const phone = readFileSync(join(process.cwd(), 'src/phone/main.ts'), 'utf8');
    expect(phone).not.toMatch(/installOnboarding|ui\/onboard/);
  });
});
