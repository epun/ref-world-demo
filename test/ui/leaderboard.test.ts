/**
 * The projection's top ten (src/ui/leaderboard.ts).
 *
 * > User ask, 2026-09-17: *"on the web view i want to see a leaderboard on
 * > the left hand side of the top 10."*
 *
 * Five things are pinned here, in the order they can go wrong:
 *
 * 1. THE RANKING. Biggest first, ten at most, ties broken deterministically,
 *    and a creature with no ball at all left off — a rank about nothing is
 *    the same mistake as `0cm 0mm` in the phone's corner.
 * 2. THE NAMES. Lowercase, always (TASTE §5, confidence 1.00), and a
 *    creature nobody signed for gets a short stand-in rather than twelve
 *    characters of id.
 * 3. THE FORMATTER. The same `formatLength` the phone's readout uses, off
 *    the same import — a ball cannot be one length on the wall and another
 *    in its owner's hand.
 * 4. THE MOTION. A rank change RETARGETS a ζ ≥ 1 spring: the row is somewhere
 *    between its old place and its new one on the next frame, never already
 *    at it (TASTE §2.1, no hard cuts). A new entrant slides in, a dropped
 *    one slides out before it leaves the page, and nothing shows at all in a
 *    world with no balls in it.
 * 5. THE MARK SET. `icon` + `ruleLine` + `border` and nothing else (TASTE
 *    §4): the sheet is read back and checked for a background, a card and a
 *    shadow.
 *
 * …and the wiring, read out of src/main.ts: the board is behind the game flag
 * and behind a dynamic import, and it is mounted on the PROJECTION only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEADERBOARD_ROWS,
  RERANK_MS,
  ROW_PX,
  displayName,
  installLeaderboard,
  rankEntries,
  rowOffset,
  type LeaderboardEntry,
} from '../../src/ui/leaderboard';
import { formatLength, metresOf } from '../../src/ui/size';
import { MOTION } from '../../src/taste/tokens';

describe('rankEntries — biggest first, ten at most', () => {
  it('sorts by diameter, descending', () => {
    const ranked = rankEntries([
      { id: 'a', diameter: 1 },
      { id: 'b', diameter: 9 },
      { id: 'c', diameter: 4 },
    ]);
    expect(ranked.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('caps at ten however many creatures the room holds', () => {
    const many: LeaderboardEntry[] = [];
    for (let i = 0; i < 40; i++) many.push({ id: `c${i}`, diameter: i + 1 });
    const ranked = rankEntries(many);
    expect(ranked.length).toBe(LEADERBOARD_ROWS);
    // The ten biggest, not the first ten it met.
    expect(ranked[0]!.diameter).toBe(40);
    expect(ranked[9]!.diameter).toBe(31);
  });

  it('shows only the creatures there are, under ten', () => {
    const ranked = rankEntries([
      { id: 'a', diameter: 2 },
      { id: 'b', diameter: 3 },
    ]);
    expect(ranked.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('breaks a tie on the id, so equal balls do not reshuffle', () => {
    const one = rankEntries([
      { id: 'zed', diameter: 5 },
      { id: 'ana', diameter: 5 },
      { id: 'mid', diameter: 5 },
    ]);
    // The same answer whichever order the roster happened to iterate in.
    const two = rankEntries([
      { id: 'mid', diameter: 5 },
      { id: 'zed', diameter: 5 },
      { id: 'ana', diameter: 5 },
    ]);
    expect(one.map((e) => e.id)).toEqual(['ana', 'mid', 'zed']);
    expect(two.map((e) => e.id)).toEqual(one.map((e) => e.id));
  });

  it('leaves off a creature with no ball, and survives nonsense', () => {
    // 0 is a shell, and 0 is every world without the game.
    const ranked = rankEntries([
      { id: 'egg', diameter: 0 },
      { id: 'big', diameter: 3 },
      { id: 'odd', diameter: Number.NaN },
      { id: 'neg', diameter: -2 },
      { id: '', diameter: 8 },
    ]);
    expect(ranked.map((e) => e.id)).toEqual(['big']);
  });

  it('is empty for an empty world', () => {
    expect(rankEntries([])).toEqual([]);
  });
});

describe('displayName — lowercase, and never the raw id', () => {
  it('lowercases whatever the drawer signed', () => {
    expect(displayName('Bob', 1)).toBe('bob');
    expect(displayName('  DOTTY  ', 1)).toBe('dotty');
    expect(displayName('mo', 1)).toBe('mo');
  });

  it('stands in for a creature nobody named', () => {
    expect(displayName(null, 7)).toBe('creature 7');
    expect(displayName(undefined, 1)).toBe('creature 1');
    // Whitespace is not a name.
    expect(displayName('   ', 3)).toBe('creature 3');
  });

  it('has no uppercase in it, ever (TASTE §5)', () => {
    for (const [signed, n] of [['ZZ', 2], [null, 4], ['MiXeD', 5]] as const) {
      const name = displayName(signed, n);
      expect(name).toBe(name.toLowerCase());
      expect(name).not.toMatch(/[A-Z]/);
    }
  });
});

describe('the cadence and the layout are tokens, not literals', () => {
  it('re-ranks a couple of times a second, off a motion token', () => {
    expect(RERANK_MS).toBe(MOTION.tertiaryMs);
    // "A few times a second": between two and five.
    expect(1000 / RERANK_MS).toBeGreaterThan(2);
    expect(1000 / RERANK_MS).toBeLessThan(5);
  });

  it('stacks rows one row-height apart', () => {
    expect(rowOffset(0)).toBe(0);
    expect(rowOffset(3)).toBe(3 * ROW_PX);
  });
});

// ── the board, against a recording DOM ───────────────────────────────────────
// This project keeps no jsdom (see test/ui/size.test.ts, test/phone/keepui.
// test.ts): what is worth pinning here — what the rows say, where they are
// sliding to, and whether they leave — is all observable on a recorder.

interface StubEl {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  classes: Set<string>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
    toggle(name: string, on?: boolean): void;
  };
  children: StubEl[];
  parent: StubEl | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: StubEl): StubEl;
  append(...kids: StubEl[]): void;
  remove(): void;
}

function makeEl(tag: string): StubEl {
  const el: StubEl = {
    tag,
    id: '',
    className: '',
    textContent: '',
    style: {},
    attrs: {},
    classes: new Set<string>(),
    classList: {
      add: (name: string): void => void el.classes.add(name),
      remove: (name: string): void => void el.classes.delete(name),
      contains: (name: string): boolean => el.classes.has(name),
      toggle: (name: string, on?: boolean): void => {
        const next = on ?? !el.classes.has(name);
        if (next) el.classes.add(name);
        else el.classes.delete(name);
      },
    },
    children: [],
    parent: null,
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value;
    },
    appendChild(child: StubEl): StubEl {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    append(...kids: StubEl[]): void {
      for (const kid of kids) el.appendChild(kid);
    },
    remove(): void {
      const at = el.parent?.children.indexOf(el) ?? -1;
      if (el.parent && at >= 0) el.parent.children.splice(at, 1);
      el.parent = null;
    },
  };
  return el;
}

function find(root: StubEl, className: string): StubEl | null {
  if (root.className === className) return root;
  for (const kid of root.children) {
    const hit = find(kid, className);
    if (hit) return hit;
  }
  return null;
}

function stubDom(): {
  mount: StubEl;
  head: StubEl;
  step(now: number): void;
  restore(): void;
} {
  const head = makeEl('head');
  const mount = makeEl('body');
  const styles = new Map<string, StubEl>();
  let pending: FrameRequestCallback | null = null;

  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    raf: globals.requestAnimationFrame,
    caf: globals.cancelAnimationFrame,
  };
  globals.document = {
    hidden: false,
    head,
    getElementById: (id: string): StubEl | null => styles.get(id) ?? null,
    createElement: (tag: string): StubEl => {
      const el = makeEl(tag);
      if (tag === 'style') {
        Object.defineProperty(el, 'id', {
          get: () => el.attrs['id'] ?? '',
          set: (value: string) => {
            el.attrs['id'] = value;
            styles.set(value, el);
          },
        });
      }
      return el;
    },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    pending = cb;
    return 1;
  };
  globals.cancelAnimationFrame = (): void => {
    pending = null;
  };
  return {
    mount,
    head,
    step: (now: number): void => {
      const cb = pending;
      pending = null;
      cb?.(now);
    },
    restore: (): void => {
      globals.document = before.document;
      globals.requestAnimationFrame = before.raf;
      globals.cancelAnimationFrame = before.caf;
    },
  };
}

/** Drive `frames` throttled frames, 40ms apart. */
function run(dom: { step(now: number): void }, from: number, frames: number): number {
  let t = from;
  for (let i = 0; i < frames; i++) {
    t += 40;
    dom.step(t);
  }
  return t;
}

describe('the board mounts, ranks, and leaves cleanly', () => {
  it('shows nothing at all in a world with no balls in it', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      // Every creature still in its shell — which is also what every world
      // without the game answers.
      entries: () => [
        { id: 'a', diameter: 0 },
        { id: 'b', diameter: 0 },
      ],
      mount: dom.mount as unknown as HTMLElement,
    });
    run(dom, 0, 30);
    expect(handle.shown()).toBe(false);
    expect(handle.rows()).toEqual([]);
    const head = find(handle.el as unknown as StubEl, 'world-leaderboard-head')!;
    // No empty header: the word is in the element, but it has not slid in.
    expect(head.classList.contains('in')).toBe(false);
    const rows = find(handle.el as unknown as StubEl, 'world-leaderboard-rows')!;
    expect(rows.children.length).toBe(0);
    handle.dispose();
    dom.restore();
  });

  it('draws one row per creature, in rank order, and slides them in', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [
        { id: 'a', diameter: 1 },
        { id: 'b', diameter: 5 },
        { id: 'c', diameter: 3 },
      ],
      name: (id) => ({ a: 'Ana', b: null, c: 'cid' })[id] ?? null,
      mount: dom.mount as unknown as HTMLElement,
    });
    dom.step(40);
    expect(handle.shown()).toBe(true);
    const first = handle.rows();
    expect(first.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(first.map((r) => r.rank)).toEqual([1, 2, 3]);
    // Names: lowercased, and a stand-in for the creature nobody signed.
    expect(first.map((r) => r.name)).toEqual(['creature 1', 'cid', 'ana']);
    // …sliding in from below, so none of them is at its place yet.
    for (const row of first) expect(row.y).toBeGreaterThan(row.targetY);

    run(dom, 40, 200);
    const settled = handle.rows();
    for (const row of settled) expect(Math.abs(row.y - row.targetY)).toBeLessThan(0.5);
    // And the numbers are the phone's own formatter, on the same ruler.
    expect(settled.map((r) => r.text)).toEqual([
      formatLength(metresOf(5)),
      formatLength(metresOf(3)),
      formatLength(metresOf(1)),
    ]);
    handle.dispose();
    dom.restore();
  });

  it('rolls a number up rather than printing it (the readout’s spring)', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [{ id: 'a', diameter: 6 }],
      mount: dom.mount as unknown as HTMLElement,
    });
    dom.step(40);
    const early = handle.rows()[0]!.text;
    expect(early).not.toBe('');
    expect(early).not.toBe(formatLength(metresOf(6)));
    run(dom, 40, 200);
    expect(handle.rows()[0]!.text).toBe(formatLength(metresOf(6)));
    handle.dispose();
    dom.restore();
  });

  it('RETARGETS a spring when the order changes — it never jumps', () => {
    const dom = stubDom();
    const sizes = new Map<string, number>([
      ['a', 9],
      ['b', 4],
    ]);
    const handle = installLeaderboard({
      entries: () => [...sizes].map(([id, diameter]) => ({ id, diameter })),
      mount: dom.mount as unknown as HTMLElement,
    });
    let t = run(dom, 0, 200);
    expect(handle.rows().map((r) => r.id)).toEqual(['a', 'b']);
    const settledY = new Map(handle.rows().map((r) => [r.id, r.y]));

    // b overtakes a. The next rerank re-sorts them…
    sizes.set('b', 20);
    t = run(dom, t, Math.ceil(RERANK_MS / 40) + 1);
    const moving = handle.rows();
    expect(moving.map((r) => r.id)).toEqual(['b', 'a']);
    expect(moving.map((r) => r.targetY)).toEqual([rowOffset(0), rowOffset(1)]);
    // …and both rows are on their way, not already there: between where
    // they were and where they are going.
    for (const row of moving) {
      expect(row.y).not.toBe(row.targetY);
      const wasAt = settledY.get(row.id)!;
      const lo = Math.min(wasAt, row.targetY) - 0.01;
      const hi = Math.max(wasAt, row.targetY) + 0.01;
      expect(row.y).toBeGreaterThanOrEqual(lo);
      expect(row.y).toBeLessThanOrEqual(hi);
    }
    // No overshoot on the way in, either — ζ ≥ 1 is unrepresentable below 1.
    run(dom, t, 200);
    for (const row of handle.rows()) {
      expect(Math.abs(row.y - row.targetY)).toBeLessThan(0.5);
    }
    handle.dispose();
    dom.restore();
  });

  it('slides a new entrant in and a dropped one out before it leaves', () => {
    const dom = stubDom();
    const sizes = new Map<string, number>([['a', 9]]);
    const handle = installLeaderboard({
      entries: () => [...sizes].map(([id, diameter]) => ({ id, diameter })),
      mount: dom.mount as unknown as HTMLElement,
    });
    let t = run(dom, 0, 200);
    const rowsEl = find(handle.el as unknown as StubEl, 'world-leaderboard-rows')!;
    expect(rowsEl.children.length).toBe(1);

    // A second creature arrives: a row that is on screen, faded in from
    // below rather than appearing at its rank.
    sizes.set('b', 4);
    t = run(dom, t, Math.ceil(RERANK_MS / 40) + 1);
    const entrant = handle.rows().find((r) => r.id === 'b')!;
    expect(entrant.y).toBeGreaterThan(entrant.targetY);
    expect(Number(rowsEl.children[1]!.style['opacity'])).toBeLessThan(1);
    t = run(dom, t, 200);
    expect(Number(rowsEl.children[1]!.style['opacity'])).toBeCloseTo(1, 2);

    // …and it is retired. It slides DOWN and out, and only then leaves.
    sizes.delete('b');
    t = run(dom, t, Math.ceil(RERANK_MS / 40) + 1);
    const leaving = handle.rows().find((r) => r.id === 'b')!;
    expect(leaving.leaving).toBe(true);
    expect(leaving.targetY).toBe(rowOffset(2));
    expect(rowsEl.children.length).toBe(2);
    t = run(dom, t, 300);
    expect(handle.rows().map((r) => r.id)).toEqual(['a']);
    expect(rowsEl.children.length).toBe(1);
    handle.dispose();
    dom.restore();
  });

  it('keeps drifting once the order has settled (TASTE §3)', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [{ id: 'a', diameter: 2 }],
      mount: dom.mount as unknown as HTMLElement,
    });
    const t = run(dom, 0, 200);
    const drift = find(handle.el as unknown as StubEl, 'world-leaderboard-drift')!;
    const at = drift.style['transform'];
    run(dom, t, 60);
    expect(drift.style['transform']).not.toBe(at);
    expect(drift.style['transform']).toMatch(/^translate\(/);
    handle.dispose();
    dom.restore();
  });

  it('takes itself off the page on dispose, and stops asking for frames', () => {
    const dom = stubDom();
    let reads = 0;
    const handle = installLeaderboard({
      entries: () => {
        reads++;
        return [{ id: 'a', diameter: 2 }];
      },
      mount: dom.mount as unknown as HTMLElement,
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

  it('asks for a name once per creature, however often it re-ranks', () => {
    const dom = stubDom();
    let asked = 0;
    const handle = installLeaderboard({
      entries: () => [{ id: 'a', diameter: 2 }],
      name: () => {
        asked++;
        return 'ana';
      },
      mount: dom.mount as unknown as HTMLElement,
    });
    run(dom, 0, 300);
    expect(asked).toBe(1);
    handle.dispose();
    dom.restore();
  });

  it('mounts one sheet however many boards are installed', () => {
    const dom = stubDom();
    const a = installLeaderboard({
      entries: () => [],
      mount: dom.mount as unknown as HTMLElement,
    });
    const b = installLeaderboard({
      entries: () => [],
      mount: dom.mount as unknown as HTMLElement,
    });
    expect(dom.head.children.length).toBe(1);
    a.dispose();
    b.dispose();
    dom.restore();
  });

  it('is marks only — no filled panel, no card, no shadow (TASTE §4)', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [{ id: 'a', diameter: 1 }],
      mount: dom.mount as unknown as HTMLElement,
    });
    const sheet = dom.head.children[0]!.textContent;
    // The one hairline rule, under the header…
    expect(sheet).toContain('border-bottom: 1px solid');
    expect([...sheet.matchAll(/border-bottom/g)].length).toBe(1);
    // …and the marks that are not in this taste's vocabulary are not here.
    expect(sheet).not.toMatch(/\bbackground\b/);
    expect(sheet).not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/\bfilter\s*:\s*drop-shadow/);
    expect(sheet).not.toMatch(/border-radius/);
    expect(sheet).not.toMatch(/\b(?:linear|ease-in-out)\b/);
    // The header word and the label a screen reader reads are lowercase.
    const head = find(handle.el as unknown as StubEl, 'world-leaderboard-head')!;
    expect(head.textContent).toBe('biggest');
    const label = (handle.el as unknown as StubEl).attrs['aria-label']!;
    expect(label).toBe(label.toLowerCase());
    handle.dispose();
    dom.restore();
  });

  it('cannot grow into the join code in the other left corner', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [],
      mount: dom.mount as unknown as HTMLElement,
    });
    const sheet = dom.head.children[0]!.textContent;
    // One fixed height, ten rows of it: the block's extent does not depend
    // on how many creatures are in the room.
    expect(sheet).toContain(`height: ${LEADERBOARD_ROWS * ROW_PX}px`);
    expect(sheet).toContain('top: calc(env(safe-area-inset-top, 0px) + 4vw)');
    handle.dispose();
    dom.restore();
  });
});

describe('the board is the projection’s, and only in the game', () => {
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8');

  it('is mounted behind the katamari flag, and NOT on a handset', () => {
    const site =
      /if \(worldGame === 'katamari' && !handheld\) \{[\s\S]{0,600}?installLeaderboard\(/;
    expect(main).toMatch(site);
    expect([...main.matchAll(/installLeaderboard\(/g)].length).toBe(1);
  });

  it('is reached by a DYNAMIC import, so no other world fetches the chunk', () => {
    expect(main).toMatch(/void import\('\.\/ui\/leaderboard'\)/);
    expect(main).not.toMatch(/^import .*'\.\/ui\/leaderboard'/m);
  });

  it('ranks by the manager’s own ball measurement, over its live roster', () => {
    expect(main).toMatch(/creatures\s*\n?\s*\.liveIds\(\)/);
    expect(main).toMatch(/creatures\.ballDiameter\(id\)/);
  });

  it('lists one row per BALL, not one per creature stuck to it', () => {
    // `ballDiameter` answers a passenger with its carrier's size (the
    // manager's own rule), so the roster has to be filtered by whose pile
    // each creature belongs to or the biggest ball fills the board.
    expect(main).toMatch(/creatures\.ballOwner\(id\) === id/);
  });

  it('reuses the phone readout’s formatter rather than a second one', () => {
    const source = readFileSync(join(process.cwd(), 'src/ui/leaderboard.ts'), 'utf8');
    expect(source).toMatch(/import \{ formatLength, metresOf \} from '\.\/size'/);
    // No second format of a length, and no second copy of the world scale.
    expect(source).not.toMatch(/\bcm\b|\bmm\b/);
    expect(source).not.toMatch(/WORLD_SCALE/);
  });
});
