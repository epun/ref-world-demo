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
 * 5. THE MARKS. The PAPER BOX — a recorded user override of §4's "no filled
 *    panels" for this element (docs/TASTE.md §9a) — is drawn with the shared
 *    wavering generator at the shared inset, filled with the join code's own
 *    paper token, and it brings nothing else with it: no shadow, no radius.
 *    The one hairline rule is still one.
 * 6. THE TITLE. `Leaderboard`, the product's one recorded capital, in one
 *    constant — and every other string on the board still lowercase.
 *
 * …and the wiring, read out of src/main.ts: the board is behind the game flag
 * and behind a dynamic import, and it is mounted on the PROJECTION only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { find, stubDom, type StubEl } from './stubdom';
import {
  BOARD_PAD_PX,
  BOARD_SEED,
  BOARD_W_PX,
  LEADERBOARD_ROWS,
  LEADERBOARD_TITLE,
  LIST_GAP_PX,
  RERANK_MS,
  ROW_PX,
  TITLE_BLOCK_PX,
  boardHeight,
  displayName,
  frameInset,
  framePath,
  installLeaderboard,
  rankEntries,
  rowOffset,
  type LeaderboardEntry,
} from '../../src/ui/leaderboard';
import {
  mapBorderInset,
  mapMarkScale,
  wavyBorderPath,
  wavyBorderPoints,
} from '../../src/phone/minimap';
import { WORLD } from '../../src/taste/tokens';
import { QR_INSET_PX } from '../../src/ui/joinqr';
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
// test.ts): what is worth pinning here — what the rows say, how big the paper
// is, where they are sliding to, and whether they leave — is all observable on
// the shared recorder in test/ui/stubdom.ts.


/**
 * The sheet's DECLARATIONS, with its comments blanked — the same masking the
 * static gate does before it scans (scripts/gates/static.ts), so a comment
 * that says the word `background` is not read as one.
 */
function declarations(sheet: string): string {
  return sheet.replace(/\/\*[\s\S]*?\*\//g, ' ');
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
    const box = find(handle.el as unknown as StubEl, 'world-leaderboard-box')!;
    // No empty board: the title is in the element, but it has not slid in.
    expect(box.classList.contains('in')).toBe(false);
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

  it('brings the paper and NOTHING else with it (TASTE §4, docs §9a)', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [{ id: 'a', diameter: 1 }],
      mount: dom.mount as unknown as HTMLElement,
    });
    const sheet = declarations(dom.head.children[0]!.textContent);
    // The one hairline rule, under the title…
    expect(sheet).toContain('border-bottom: 1px solid');
    expect([...sheet.matchAll(/border-bottom/g)].length).toBe(1);
    // …the paper, which is the recorded override: the JOIN CODE's own value,
    // and drawn as a fill on the wavering path rather than a css box.
    // …now through the chrome palette (src/ui/theme.ts), which resolves to
    // exactly these tokens on the shipped look — the fallback in each `var`
    // IS the value, so this sheet paints them with no theme installed.
    expect(sheet).toContain(`fill: var(--rw-light, ${WORLD.light})`);
    expect(sheet).toContain(`stroke: var(--rw-ink, ${WORLD.ink})`);
    expect(sheet).toContain('stroke-width: 1.25');
    // …and the marks that are still not in this taste's vocabulary.
    expect(sheet).not.toMatch(/\bbackground\b/);
    expect(sheet).not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/\bfilter\s*:\s*drop-shadow/);
    expect(sheet).not.toMatch(/border-radius/);
    expect(sheet).not.toMatch(/\b(?:linear|ease-in-out)\b/);
    handle.dispose();
    dom.restore();
  });

  it('draws the frame with the shared generator, at the shared inset', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [
        { id: 'a', diameter: 3 },
        { id: 'b', diameter: 1 },
      ],
      mount: dom.mount as unknown as HTMLElement,
    });
    run(dom, 0, 300);
    const svg = find(handle.el as unknown as StubEl, 'world-leaderboard-frame')!;
    const path = find(handle.el as unknown as StubEl, 'world-leaderboard-paper')!;
    const h = Math.round(boardHeight(2));
    // The box settled at the height of the field standing on it…
    expect(svg.attrs['viewBox']).toBe(`0 0 ${BOARD_W_PX} ${h}`);
    // …and the loop is the minimap's and the join code's own hand, not a
    // second one: the same points, smoothing, inset and seed.
    expect(path.attrs['d']).toBe(
      wavyBorderPath(
        wavyBorderPoints(BOARD_W_PX, h, mapBorderInset(mapMarkScale(Math.min(BOARD_W_PX, h))), BOARD_SEED),
      ),
    );
    expect(path.attrs['d']).toBe(framePath(BOARD_W_PX, h));
    expect(frameInset(BOARD_W_PX, h)).toBe(
      mapBorderInset(mapMarkScale(Math.min(BOARD_W_PX, h))),
    );
    // A wavering loop of quadratics, never a rectangle (TASTE §2.5).
    expect(path.attrs['d']).toMatch(/^M .* Q .* Z$/);
    handle.dispose();
    dom.restore();
  });

  it('grows the paper with the field instead of jumping to it', () => {
    const dom = stubDom();
    const sizes = new Map<string, number>([['a', 4]]);
    const handle = installLeaderboard({
      entries: () => [...sizes].map(([id, diameter]) => ({ id, diameter })),
      mount: dom.mount as unknown as HTMLElement,
    });
    let t = run(dom, 0, 300);
    const box = find(handle.el as unknown as StubEl, 'world-leaderboard-box')!;
    const oneRow = Number.parseFloat(box.style['height']!);
    expect(oneRow).toBeCloseTo(boardHeight(1), 1);

    sizes.set('b', 2);
    sizes.set('c', 1);
    t = run(dom, t, Math.ceil(RERANK_MS / 40) + 1);
    const growing = Number.parseFloat(box.style['height']!);
    // On its way up, not there yet: a box that resized in one frame would
    // be a cut (TASTE §2.1).
    expect(growing).toBeGreaterThan(oneRow);
    expect(growing).toBeLessThan(boardHeight(3));
    run(dom, t, 300);
    expect(Number.parseFloat(box.style['height']!)).toBeCloseTo(boardHeight(3), 1);
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
    expect(sheet).toContain(`width: ${BOARD_W_PX}px`);
    // Left-aligned to the join code: the same inset, so the two share a column.
    expect(sheet).toContain(`left: calc(env(safe-area-inset-left, 0px) + ${QR_INSET_PX}px)`);
    expect(sheet).toContain(`top: calc(env(safe-area-inset-top, 0px) + ${QR_INSET_PX}px)`);
    expect(sheet).not.toContain('4vw');
    // Ten rows is the cap AND the tallest the paper can ever be.
    expect(boardHeight(LEADERBOARD_ROWS)).toBe(
      BOARD_PAD_PX * 2 + TITLE_BLOCK_PX + LEADERBOARD_ROWS * ROW_PX,
    );
    expect(boardHeight(40)).toBe(boardHeight(LEADERBOARD_ROWS));
    expect(boardHeight(0)).toBeLessThan(boardHeight(1));
    handle.dispose();
    dom.restore();
  });

  it('keeps 16px of paper between the rule and the top of the list (user ask, 2026-09-17)', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [{ id: 'a', diameter: 1 }],
      mount: dom.mount as unknown as HTMLElement,
    });
    const sheet = dom.head.children[0]!.textContent;
    expect(LIST_GAP_PX).toBe(16);
    // The gap is the rows block's top margin, not a margin on the first row,
    // so a rank change never moves it…
    const rowsRule = /\.world-leaderboard-rows\s*\{[^}]*\}/.exec(sheet)?.[0] ?? '';
    expect(rowsRule).toContain(`margin-top: ${LIST_GAP_PX}px`);
    expect(/\.world-leaderboard-row\s*\{[^}]*\}/.exec(sheet)?.[0] ?? '').not.toMatch(/margin-top/);
    // …and the paper counts it: the title block covers the 14px/1.4 line, the
    // rule's 0.45em of room, the rule itself and the gap.
    expect(TITLE_BLOCK_PX).toBeGreaterThanOrEqual(19.6 + 6.3 + 1 + LIST_GAP_PX);
    expect(TITLE_BLOCK_PX).toBeLessThan(19.6 + 6.3 + 1 + LIST_GAP_PX + 1);
    handle.dispose();
    dom.restore();
  });
});

describe('the title — one recorded capital, and nothing else moves', () => {
  const source = readFileSync(join(process.cwd(), 'src/ui/leaderboard.ts'), 'utf8');

  it('says Leaderboard, from the copy constant', () => {
    // The 2026-09-17 user override of TASTE §5, asked for twice, recorded in
    // docs/TASTE.md §9a. One string, in one place.
    expect(LEADERBOARD_TITLE).toBe('Leaderboard');
  });

  it('carries the static gate’s own scoped hatch on that line', () => {
    // Not a widened scan: the line before the constant is the documented
    // escape hatch (scripts/gates/static.ts), and it names the ruling.
    expect(source).toMatch(
      /\/\/ gate-allow-uppercase[^\n]*\n\s*export const LEADERBOARD_TITLE = 'Leaderboard';/,
    );
  });

  it('is the only capital the module ships', () => {
    // Every other string here is lowercase — the names are lowercased at
    // their source, and the stand-in and the units never had a capital.
    expect(displayName('ANA', 1)).toBe('ana');
    expect(displayName(null, 2)).toBe('creature 2');
    // The class names and selectors are lowercase too, so the sheet the
    // module writes holds no capital at all.
    const sheet = declarations(/style\.textContent = `([\s\S]*?)`;/.exec(source)?.[1] ?? '');
    expect(sheet.length).toBeGreaterThan(100);
    // Interpolations are code, not copy — the gate's own allowance. The
    // word boundary is the other one: `translateY` is a css function, and a
    // capital that starts a WORD is the thing the taste is about.
    expect(sheet.replace(/\$\{[^}]*\}/g, '')).not.toMatch(/\b[A-Z]/);
  });

  it('is what a screen reader is told, too', () => {
    const dom = stubDom();
    const handle = installLeaderboard({
      entries: () => [{ id: 'a', diameter: 1 }],
      mount: dom.mount as unknown as HTMLElement,
    });
    expect((handle.el as unknown as StubEl).attrs['aria-label']).toBe(LEADERBOARD_TITLE);
    handle.dispose();
    dom.restore();
  });
});

describe('the mark-set lint knows about the paper', () => {
  const dev = readFileSync(join(process.cwd(), 'src/dev/index.ts'), 'utf8');

  it('samples the board and reports its fill as the recorded ruling', () => {
    // The same arrangement the minimap's own paper is under, so the gate
    // stays a button rather than a memo (TASTE §7).
    expect(dev).toMatch(
      /selector: '\.world-leaderboard',[\s\S]{0,200}?exemptReason: 'paper-card ruling[^']*'/,
    );
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
