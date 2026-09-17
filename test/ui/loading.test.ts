/**
 * The loading state of the phone's world view (src/ui/loading.ts).
 *
 * > User ask, 2026-09-17 (mobile): *"there should be better empty/loading
 * > states."*
 *
 * What is pinned, in the order it can go wrong:
 *
 * 1. THE ORDER. Four milestones, four lines, and the machine reads the
 *    DEEPEST one that has passed — a socket that drops after the island is
 *    built must not walk the line backwards.
 * 2. THE TIMEOUT. A room that never answers says so and offers a retry, after
 *    a multiple of a MOTION token and never a literal; and only in the first
 *    wait, because every later one has demonstrably reached its room.
 * 3. THE EXIT. When the creature stands the line slides out — it does not cut
 *    and it does not stay.
 * 4. THE MARK SET. `icon` + `ruleLine` + `border` and nothing else
 *    (TASTE §4): a line, a hairline rule that fills, and no panel, card,
 *    shadow or spinner.
 * 5. THE GATE. None of it is reached on `game === 'none'`, and it arrives by
 *    dynamic import like the ball readout.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIRST_FRAME_MARK,
  LOADING_LINES,
  LOADING_STAGES,
  LOADING_TIMEOUT_MS,
  RETRY_LABEL,
  TIMEOUT_LINE,
  TIMEOUT_MULTIPLE,
  installWorldLoading,
  loadingProgress,
  loadingStage,
  timedOut,
  type LoadingMilestones,
} from '../../src/ui/loading';
import { MOTION } from '../../src/taste/tokens';
import { find, stubDom, type StubEl } from './stubdom';

const NONE: LoadingMilestones = {
  reached: false,
  built: false,
  present: false,
  standing: false,
};

describe('the machine — four milestones, in order', () => {
  it('walks the four waits as the milestones pass', () => {
    expect(loadingStage(NONE)).toBe('room');
    expect(loadingStage({ ...NONE, reached: true })).toBe('island');
    expect(loadingStage({ ...NONE, reached: true, built: true })).toBe('creature');
    expect(loadingStage({ ...NONE, reached: true, built: true, present: true })).toBe('hatch');
    expect(loadingStage({ reached: true, built: true, present: true, standing: true })).toBe(
      'done',
    );
  });

  it('reads the deepest milestone, so a dropped socket never un-builds the island', () => {
    // The socket went away; the island is still there and the egg is still
    // standing in it.
    expect(loadingStage({ ...NONE, built: true })).toBe('creature');
    expect(loadingStage({ ...NONE, present: true })).toBe('hatch');
    expect(loadingStage({ ...NONE, standing: true })).toBe('done');
  });

  it('says what each wait is, in lowercase, and says nothing at the end', () => {
    expect(LOADING_LINES.room).toBe('finding the room');
    expect(LOADING_LINES.island).toBe('building the island');
    expect(LOADING_LINES.creature).toBe('waiting for your creature');
    expect(LOADING_LINES.hatch).toBe('your creature is hatching');
    expect(LOADING_LINES.done).toBe('');
    for (const line of [...Object.values(LOADING_LINES), TIMEOUT_LINE, RETRY_LABEL]) {
      expect(line).toBe(line.toLowerCase());
      expect(line).not.toMatch(/[A-Z]/);
    }
  });

  it('fills the rule monotonically, from nothing to full', () => {
    let previous = -1;
    for (const stage of LOADING_STAGES) {
      const at = loadingProgress(stage);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
    expect(loadingProgress('room')).toBe(0);
    expect(loadingProgress('done')).toBe(1);
  });

  it('reads the terrain off the mark the world itself writes', () => {
    // Never a second derivation of "is the land there": the page that builds
    // it says so, once, on the platform's own timeline (src/world/scene.ts).
    expect(FIRST_FRAME_MARK).toBe('refworld:first-frame');
    const scene = readFileSync(join(process.cwd(), 'src/world/scene.ts'), 'utf8');
    expect(scene).toContain(`markOnce('${FIRST_FRAME_MARK}')`);
  });
});

describe('a room that never answers', () => {
  it('waits a multiple of a motion token, never a literal', () => {
    expect(LOADING_TIMEOUT_MS).toBe(MOTION.primaryMs * TIMEOUT_MULTIPLE);
    // Long enough that a working handset is never called broken: the
    // slow-network pass measured its island rebuild at 1944ms.
    expect(LOADING_TIMEOUT_MS).toBeGreaterThan(10000);
  });

  it('admits it only in the first wait', () => {
    expect(timedOut('room', LOADING_TIMEOUT_MS)).toBe(true);
    expect(timedOut('room', LOADING_TIMEOUT_MS - 1)).toBe(false);
    // Past the room, a retry would throw away a built island for a slow store.
    for (const stage of ['island', 'creature', 'hatch', 'done'] as const) {
      expect(timedOut(stage, LOADING_TIMEOUT_MS * 10)).toBe(false);
    }
  });
});

// ── the line, against a recording DOM ────────────────────────────────────────

function mountLoading(
  milestones: () => LoadingMilestones,
  now: () => number = () => 0,
): {
  dom: ReturnType<typeof stubDom>;
  handle: ReturnType<typeof installWorldLoading>;
  retries: number[];
} {
  const dom = stubDom();
  const retries: number[] = [];
  const handle = installWorldLoading({
    mount: dom.mount as unknown as HTMLElement,
    milestones,
    retry: () => retries.push(1),
    now,
  });
  return { dom, handle, retries };
}

describe('the line on screen', () => {
  it('says the first wait in its very first frame, not a frame later', () => {
    const { dom, handle } = mountLoading(() => NONE);
    expect(handle.line()).toBe(LOADING_LINES.room);
    expect(find(handle.el as unknown as StubEl, 'world-loading-line')!.textContent).toBe(
      LOADING_LINES.room,
    );
    handle.dispose();
    dom.restore();
  });

  it('changes as the milestones pass, and fills the rule as it goes', () => {
    const state: LoadingMilestones = { ...NONE };
    const { dom, handle } = mountLoading(() => state);
    const fill = find(handle.el as unknown as StubEl, 'world-loading-fill')!;
    const width = (): number => Number.parseFloat(fill.style['width'] ?? '0');

    for (let f = 1; f <= 10; f++) dom.step(f * 40);
    const atRoom = width();

    state.reached = true;
    for (let f = 11; f <= 80; f++) dom.step(f * 40);
    expect(handle.line()).toBe(LOADING_LINES.island);
    expect(width()).toBeGreaterThan(atRoom);
    const atIsland = width();

    state.built = true;
    for (let f = 81; f <= 160; f++) dom.step(f * 40);
    expect(handle.line()).toBe(LOADING_LINES.creature);
    expect(width()).toBeGreaterThan(atIsland);

    state.present = true;
    for (let f = 161; f <= 240; f++) dom.step(f * 40);
    expect(handle.line()).toBe(LOADING_LINES.hatch);
    handle.dispose();
    dom.restore();
  });

  it('never runs the rule past the milestone it has reached (ζ ≥ 1)', () => {
    const state: LoadingMilestones = { ...NONE, reached: true };
    const { dom, handle } = mountLoading(() => state);
    for (let f = 1; f <= 400; f++) {
      dom.step(f * 40);
      expect(handle.progress()).toBeLessThanOrEqual(loadingProgress('island') + 1e-9);
    }
    handle.dispose();
    dom.restore();
  });

  it('holds the deepest wait even if a milestone flaps', () => {
    const state: LoadingMilestones = { ...NONE, reached: true, built: true };
    const { dom, handle } = mountLoading(() => state);
    for (let f = 1; f <= 40; f++) dom.step(f * 40);
    expect(handle.stage()).toBe('creature');
    // The socket drops and the mark is still there: the line stays put.
    state.reached = false;
    for (let f = 41; f <= 80; f++) dom.step(f * 40);
    expect(handle.stage()).toBe('creature');
    expect(handle.line()).toBe(LOADING_LINES.creature);
    handle.dispose();
    dom.restore();
  });

  it('slides out when the creature is standing, and says nothing more', () => {
    const state: LoadingMilestones = { reached: true, built: true, present: true, standing: false };
    const { dom, handle } = mountLoading(() => state);
    for (let f = 1; f <= 40; f++) dom.step(f * 40);
    expect(handle.gone()).toBe(false);

    state.standing = true;
    for (let f = 41; f <= 60; f++) dom.step(f * 40);
    expect(handle.gone()).toBe(true);
    expect(handle.line()).toBe('');
    // It LEAVES rather than vanishing: the class the sheet transitions.
    expect((handle.el as unknown as StubEl).classes.has('out')).toBe(true);
    // …and the rule finishes filling on the way out rather than freezing
    // part-drawn.
    for (let f = 61; f <= 300; f++) dom.step(f * 40);
    expect(handle.progress()).toBeCloseTo(1, 2);
    handle.dispose();
    dom.restore();
  });

  it('opens on the world already standing without ever saying a word', () => {
    // A handset coming back to a world it is already in: nothing to wait for.
    const { dom, handle } = mountLoading(() => ({
      reached: true,
      built: true,
      present: true,
      standing: true,
    }));
    expect(handle.gone()).toBe(true);
    expect(handle.line()).toBe('');
    handle.dispose();
    dom.restore();
  });

  it('admits a room that never answered, and offers a retry', () => {
    let clock = 0;
    const { dom, handle, retries } = mountLoading(
      () => NONE,
      () => clock,
    );
    for (let f = 1; f <= 10; f++) dom.step(f * 40);
    expect(handle.offeringRetry()).toBe(false);

    clock = LOADING_TIMEOUT_MS;
    dom.step(11 * 40);
    expect(handle.line()).toBe(TIMEOUT_LINE);
    expect(handle.offeringRetry()).toBe(true);
    const link = find(handle.el as unknown as StubEl, 'world-loading-retry')!;
    expect(link.classes.has('in')).toBe(true);
    expect(link.textContent).toBe(RETRY_LABEL);
    link.fire('click');
    expect(retries.length).toBe(1);

    // …and the wait goes on underneath: a slow room is not a gone room.
    const state = { ...NONE, reached: true };
    const later = mountLoading(
      () => state,
      () => LOADING_TIMEOUT_MS * 2,
    );
    later.dom.step(40);
    expect(later.handle.line()).toBe(LOADING_LINES.island);
    expect(later.handle.offeringRetry()).toBe(false);
    later.handle.dispose();
    later.dom.restore();

    handle.dispose();
    dom.restore();
  });

  it('keeps drifting through the longest wait (TASTE §3)', () => {
    const { dom, handle } = mountLoading(() => NONE);
    const drift = find(handle.el as unknown as StubEl, 'world-loading-drift')!;
    for (let f = 1; f <= 10; f++) dom.step(f * 40);
    const at = drift.style['transform'];
    expect(at).toMatch(/^translate\(/);
    for (let f = 11; f <= 40; f++) dom.step(f * 40);
    expect(drift.style['transform']).not.toBe(at);
    handle.dispose();
    dom.restore();
  });

  it('takes itself off the page on dispose, and stops reading', () => {
    let reads = 0;
    const { dom, handle } = mountLoading(() => {
      reads++;
      return NONE;
    });
    dom.step(40);
    expect(dom.mount.children.length).toBe(1);
    const after = reads;
    handle.dispose();
    expect(dom.mount.children.length).toBe(0);
    dom.step(80);
    expect(reads).toBe(after);
    dom.restore();
  });

  it('is marks only — a line and a rule, no panel and no spinner (TASTE §4)', () => {
    const { dom, handle } = mountLoading(() => NONE);
    const sheet = dom.head.children[0]!.textContent;
    // The rule marks are there — the track, its fill, and the retry link's…
    expect([...sheet.matchAll(/border-top: 1px solid/g)].length).toBe(2);
    expect(sheet).toContain('border-bottom: 1px solid');
    // …and nothing this taste has no mark for is.
    expect(sheet).not.toMatch(/\bbackground\b/);
    expect(sheet).not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/border-radius/);
    expect(sheet).not.toMatch(/gradient/);
    // No spinner: a rotation would be a fifth mark, and it says nothing.
    expect(sheet).not.toMatch(/@keyframes|animation:/);
    expect(sheet).not.toMatch(/\b(?:linear|ease-in-out)\b/);
    expect(sheet).not.toMatch(/scale\(0/);
    handle.dispose();
    dom.restore();
  });
});

describe('the loading line is absent on a world without the game', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

  it('is mounted only behind the katamari flag, the handset and a creature', () => {
    const site =
      /if \(worldGame === 'katamari' && handheld\) \{[\s\S]{0,600}?if \(myDrawerId\.length > 0\) \{[\s\S]{0,1600}?installWorldLoading\(/;
    expect(main).toMatch(site);
    expect([...main.matchAll(/installWorldLoading\(/g)].length).toBe(1);
  });

  it('is reached by a DYNAMIC import, so no other world fetches the chunk', () => {
    expect(main).toMatch(/void import\('\.\/ui\/loading'\)/);
    expect(main).not.toMatch(/^import .*'\.\/ui\/loading'/m);
  });

  it('reads the one identity this page already has for “mine”', () => {
    // Never a second answer to which creature is this handset's.
    expect(main).toMatch(/present: creatures\.positionOf\(myDrawerId\) !== null/);
    expect(main).toMatch(/!creatures\.eggIds\(\)\.includes\(myDrawerId\)/);
  });

  it('latches the room off the feed’s own status rather than a timer', () => {
    expect(main).toMatch(/if \(state === 'on'\) roomOn = true;/);
    expect(main).toMatch(/reached: roomOn,/);
  });
});
