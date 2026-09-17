/**
 * The top ten balls, down the left edge of the projection.
 *
 * > User ask, 2026-09-17: *"on the web view i want to see a leaderboard on
 * > the left hand side of the top 10."*
 *
 * The web view is the PROJECTION — the screen the room is looking at, which
 * is the one view that is about everybody rather than about one creature.
 * The phone already answers "how big is mine" in its own top-left corner
 * (src/ui/size.ts); this answers "who is winning", and the two never appear
 * on the same screen: the readout is a handset's and this is a wall's.
 *
 * THE MARKS, and there are three (TASTE §4 — `icon` + `ruleLine` + `border`,
 * the world brief's #1 defining signal at confidence 1.00):
 *
 * - a BORDER: the project's own wavering hand-drawn loop on paper, which is
 *   the frame the join code and the minimap already stand in. Same
 *   generator, same smoothing, same inset and same 1.25 hairline —
 *   `wavyBorderPoints` + `wavyBorderPath` off src/phone/minimap.ts, emitted
 *   as an svg path because this box is type in the dom rather than a canvas
 *   (src/phone/worldlink.ts draws its button the same way). A second
 *   implementation would be a second hand;
 * - TYPE, in the world view's own face and size — the same one `.world-say`,
 *   `.draw-hint` and the ball readout are set in, because this is another
 *   line of the world's own chrome and a second face here would be a second
 *   voice. Lowercase throughout (TASTE §5): the title, every name (the name
 *   is lowercased at its source, src/creatures/naming.ts) and the units;
 * - a single HAIRLINE RULE under the title — the world brief's *"reserve a
 *   single hairline rule to divide the frame"*. One, under `leaderboard`,
 *   and none between the rows: ten rules down the left of a projection is a
 *   table, and the density axis is the design (TASTE §2.3).
 *
 * THE PAPER IS A USER OVERRIDE of §4's "no filled panels", recorded in
 * docs/TASTE.md §9b: *"Give it a white background and style it in the same
 * style as we've done for the rest of ref, with the doodle lines."*
 * (2026-09-17). It is the same override the two corners it now matches are
 * already under — the join code's field is `WORLD.light` and the minimap's
 * is `SURFACE.ground`, both of them paper inside a wavering hairline, and
 * the mark-set lint has carried the minimap's as a ruled exemption since the
 * qa audit. This box takes the JOIN CODE's value, because the join code is
 * the other thing on this screen that is a card of paper laid on the world
 * rather than a window into it, and `WORLD.light` is the whitest paper this
 * palette has. Nothing else comes with it: no shadow, no radius, no second
 * fill. The lint samples this element by name.
 *
 * It sits at the TOP of the left edge because the bottom-left corner is the
 * join code (src/ui/joinqr.ts) and the two must never reach each other — the
 * rows are capped at ten, so the tallest the box can ever be is ten rows.
 *
 * THE MOTION (TASTE §2.1, confidence 1.00 — no overshoot, no bounce, no hard
 * cuts):
 *
 * - the ORDER is re-read a couple of times a second, never per frame
 *   (`RERANK_MS`, off the motion tokens). A row that re-sorted on every
 *   frame while two balls traded places would be a flicker, not a ranking;
 * - a row that changes rank SLIDES to its new place on a ζ ≥ 1 spring
 *   (src/motion/spring.ts, where underdamped is unrepresentable). The rows
 *   are laid out by transform rather than by document order, so nothing
 *   reflows and nothing jumps;
 * - a new entrant slides UP INTO the list from the row below it and fades in
 *   as it comes; a creature that drops off slides down and fades out, and
 *   only then leaves the page. Never a `scale: 0 → 1`, never a pop;
 * - every number rolls, on its own spring, exactly as the phone's readout
 *   rolls — and through the SAME formatter (`formatLength`, imported from
 *   src/ui/size.ts), so a ball cannot be one length on the wall and another
 *   in its owner's hand;
 * - the BOX grows and shrinks with the field on a spring of its own, so the
 *   paper is never taller than the rows standing on it and never cuts one
 *   off. The border is re-emitted at each new size — the same hand redrawing
 *   the same loop, which is what the generator is deterministic for;
 * - the whole block drifts imperceptibly, forever, like everything else on
 *   screen (TASTE §3).
 *
 * THIS MODULE IS KATAMARI-ONLY (2026-09-15 user ruling, src/world/game.ts).
 * There are no balls to rank in a world without the game, so `src/main.ts`
 * reaches it through a DYNAMIC import behind `game === 'katamari'` — the same
 * discipline the ball readout and the object library are loaded under: the
 * public world and meridian never pull this chunk at all.
 *
 * The ranking, the fallback name and the row layout are pure functions at
 * the top of the file with no DOM in them, so test/ui can cover the things
 * that are easy to get wrong — ties, a short field, a nameless creature — in
 * node.
 */

import { MOTION, WORLD } from '../taste/tokens';
import { Spring } from '../motion/spring';
import { sampleDrift } from '../motion/ambient';
import { mapBorderInset, mapMarkScale, wavyBorderPath, wavyBorderPoints } from '../phone/minimap';
import { formatLength, metresOf } from './size';

// ── pure helpers ─────────────────────────────────────────────────────────────

/** How many rows. The ask says ten. */
export const LEADERBOARD_ROWS = 10;

/**
 * How often the order is re-read, ms. **[D]**
 *
 * `MOTION.tertiaryMs` — the shortest token there is, which puts it at a
 * little over twice a second. Fast enough that a ball overtaking another
 * reads as it happens, slow enough that two balls within a centimetre of
 * each other do not swap places on every frame. Off a token rather than a
 * literal, like every other duration in this project.
 */
export const RERANK_MS = MOTION.tertiaryMs;

/** One row's height, css px. **[D]** The type is 14px/1.4 ≈ 19.6. */
export const ROW_PX = 22;

export interface LeaderboardEntry {
  id: string;
  /** World units, as `CreatureManager.ballDiameter` answers. */
  diameter: number;
}

/**
 * The field, in order: biggest first, capped at `limit`.
 *
 * A ball of ZERO is not on it. `ballDiameter` answers 0 for a creature still
 * in its shell and 0 for the whole of any world without the game, so a row
 * for one would be a rank about nothing — the same argument the phone's
 * readout makes for showing an empty corner until there is a ball. **[D]**
 *
 * Ties break on the id, ascending. Not on encounter order: the entries
 * arrive from a map iteration, and a ranking that reshuffled equal balls
 * because the roster did would be motion with no news in it.
 */
export function rankEntries(
  entries: readonly LeaderboardEntry[],
  limit = LEADERBOARD_ROWS,
): LeaderboardEntry[] {
  const measurable = entries.filter(
    (e) => Number.isFinite(e.diameter) && e.diameter > 0 && e.id.length > 0,
  );
  measurable.sort(
    (a, b) => b.diameter - a.diameter || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return measurable.slice(0, Math.max(0, limit));
}

/**
 * What a row is called.
 *
 * The name the drawer signed, lowercased — the taste has no uppercase
 * anywhere (TASTE §5, confidence 1.00) and the first real drawing on the
 * public world came in signed with a capital.
 *
 * Nobody signed anything: a short lowercase stand-in, NEVER the raw id. An
 * id is a machine's word for a creature — twelve characters of base36 on a
 * projection is noise, and it is also the one string on this screen that
 * could arrive with capitals in it.
 */
export function displayName(supplied: string | null | undefined, ordinal: number): string {
  const trimmed = (supplied ?? '').trim();
  if (trimmed.length > 0) return trimmed.toLowerCase();
  return `creature ${Math.max(1, Math.floor(ordinal))}`;
}

/** Where row `rank` sits, css px from the top of the rows block. */
export function rowOffset(rank: number): number {
  return rank * ROW_PX;
}

/**
 * The title, and the only copy this module has.
 *
 * `Leaderboard`, with the capital — a RECORDED USER OVERRIDE of TASTE §5
 * (*"no uppercase. anywhere"*, confidence 1.00) for this ONE string, asked
 * for twice on 2026-09-17 and written down in docs/TASTE.md §9a beside the
 * paper. Nothing else in the product moves: the room code still renders
 * `xkcd`, the way out of the device still says `view world`, the ball
 * readout still says `34cm 5mm`, and every name on this very board is still
 * lowercased at its source (src/creatures/naming.ts).
 *
 * It is a named constant so that the override is one string in one place,
 * and the line carries the static gate's own scoped escape hatch
 * (`gate-allow-uppercase`, scripts/gates/static.ts) rather than the scan
 * being widened for everybody.
 */
// gate-allow-uppercase — recorded user override, 2026-09-17 (docs/TASTE.md §9a)
export const LEADERBOARD_TITLE = 'Leaderboard';

/**
 * Stable seed for this box — its border's waver and its drift channel.
 *
 * Its own, not the map's (129.4) and not the join code's (57.3): three
 * boxes drawn from one seed would be three copies of one wobble, and they
 * are all on screen at once.
 */
export const BOARD_SEED = 71.6;

/** The box's width, css px. **[D]** `264` is the size the join code and the
 * minimap cap at, so the three boxes on this screen are one family. */
export const BOARD_W_PX = 264;
/**
 * Paper kept clear inside the wavering border, css px. **[D]**
 *
 * The border itself sits `frameInset` (9) in, so this leaves nine more
 * between the hairline and the type. Generous negative space is one of the
 * two briefs' shared signals, and at 15 the last row's units came within five
 * pixels of the border (measured in the headless run).
 */
export const BOARD_PAD_PX = 18;
/**
 * The title's block, css px. **[D]** Its 14px/1.4 line (19.6), the hairline
 * rule's own 0.45em of breathing room (6.3), and seven more between the rule
 * and the first row. The gap is counted HERE rather than left to a margin on
 * the rows, so `boardHeight` is the whole truth about how tall the paper is.
 */
export const TITLE_BLOCK_PX = 33;

/**
 * How tall the box is for a field of `rows`, css px.
 *
 * The paper follows the field: an empty board is not drawn at all, and a
 * board of three is three rows tall rather than a tenth of the screen with
 * seven rows of nothing on it. Pure, so the frame below can be generated
 * without a browser.
 */
export function boardHeight(rows: number): number {
  const n = Math.max(0, Math.min(LEADERBOARD_ROWS, Math.floor(rows)));
  return BOARD_PAD_PX * 2 + TITLE_BLOCK_PX + n * ROW_PX;
}

/**
 * The border's inset for a box this size — `mapBorderInset` off the map's
 * own mark scale, which is the expression the join code uses and the map
 * uses, so the three hairlines sit the same distance inside their edges.
 */
export function frameInset(w: number, h: number): number {
  return mapBorderInset(mapMarkScale(Math.min(w, h)));
}

/**
 * The frame, as svg path data: the project's own wavering loop at this size.
 *
 * `wavyBorderPoints` + `wavyBorderPath` from src/phone/minimap.ts — the
 * identical generator and midpoint smoothing the minimap's border, the join
 * code's frame and the way-back button are all drawn with. Deterministic per
 * size and seed, so the same box is the same hand on every device.
 */
export function framePath(w: number, h: number, seed = BOARD_SEED): string {
  if (!(w > 2) || !(h > 2)) return '';
  return wavyBorderPath(wavyBorderPoints(Math.round(w), Math.round(h), frameInset(w, h), seed));
}

// ── the edge ─────────────────────────────────────────────────────────────────

/**
 * Nominal scale the drift amplitude is a fraction of, px — the minimap's
 * 140, which is about this block's own span. `MOTION` owns the fraction.
 */
const DRIFT_SCALE = 140;
/** Draw cadence — numbers that roll, not a viewport. */
const DRAW_INTERVAL_MS = 1000 / 30;
/** A leaving row is off the page below this much opacity. */
const GONE = 0.01;

const STYLE_ID = 'world-leaderboard-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.world-leaderboard {
  position: fixed;
  left: calc(env(safe-area-inset-left, 0px) + 4vw);
  top: calc(env(safe-area-inset-top, 0px) + 4vw);
  z-index: 5;
  width: ${BOARD_W_PX}px;
  color: ${WORLD.ink};
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  pointer-events: none;
}
/* The drift layer, written per frame: nothing fully arrests (TASTE §3). It
   is its own element because the box below owns a transform of its own. */
.world-leaderboard-drift { display: block; }
/*
 * The paper. Its HEIGHT is written per frame off a ζ≥1 spring, so the box
 * grows with the field instead of standing at its full ten rows over an
 * empty world. No background here and no radius: the fill is the svg path
 * below, because the shape is a drawn loop and a css box would be a
 * rectangle — nothing rectilinear (TASTE §2.5).
 */
.world-leaderboard-box {
  position: relative;
  /* The written height IS the paper's height, padding included — so the
     frame drawn at that size and the box on screen are the same box. */
  box-sizing: border-box;
  padding: ${BOARD_PAD_PX}px;
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.world-leaderboard-box.in {
  opacity: 1;
  transform: translateY(0);
}
/* The frame, under the type and over nothing: the world shows through the
   paper's own value, which is the join code's arrangement exactly. */
.world-leaderboard-frame {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}
.world-leaderboard-paper {
  fill: ${WORLD.light};
  stroke: ${WORLD.ink};
  stroke-width: 1.25;
  stroke-linejoin: round;
}
/* The title, and the one hairline rule under it. */
.world-leaderboard-head {
  position: relative;
  padding-bottom: 0.45em;
  border-bottom: 1px solid ${WORLD.ink};
}
/* The rows are laid out by transform inside a block whose height is written
   per frame, so a rank change slides and never reflows. */
.world-leaderboard-rows {
  position: relative;
  height: 0;
  overflow: hidden;
}
.world-leaderboard-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: ${ROW_PX}px;
  display: flex;
  align-items: baseline;
  gap: 7px;
}
/* Tabular figures, so a rolling number and a column of ranks do not shuffle
   the lines they are on. */
.world-leaderboard-rank {
  flex: none;
  width: 1.6em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.world-leaderboard-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.world-leaderboard-size {
  flex: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
`;
  document.head.appendChild(style);
}

export interface LeaderboardOptions {
  /**
   * Every creature that could be on the board, read live.
   *
   * A function, not a list: balls grow on every frame a pickup lands, and
   * this reads the manager per rerank rather than being told about it — the
   * same arrangement the ball readout and the minimap's marks are under.
   */
  entries(): LeaderboardEntry[];
  /**
   * What this creature's drawer signed, if they signed anything. Null or
   * absent is a nameless creature and takes the stand-in above.
   *
   * Asked ONCE per creature and remembered: a name does not change, and a
   * lookup that walked the gate's admitted list ten times a second would be
   * a search for something that already has an answer.
   */
  name?(id: string): string | null | undefined;
  mount: HTMLElement;
}

export interface LeaderboardRow {
  id: string;
  /** 1-based, as it reads on screen. A leaving row keeps its last one. */
  rank: number;
  name: string;
  /** What the row says right now — the rolling number, not the true one. */
  text: string;
  /** Current and target y, css px. Equal only once the slide has settled. */
  y: number;
  targetY: number;
  leaving: boolean;
}

export interface LeaderboardHandle {
  /** The block's root, for a caller that owns where it hangs. */
  el: HTMLElement;
  /** The rows on screen right now, in rank order. */
  rows(): LeaderboardRow[];
  /** Has the header slid in — i.e. is there anything to rank at all? */
  shown(): boolean;
  dispose(): void;
}

interface Row {
  id: string;
  el: HTMLElement;
  rankEl: HTMLElement;
  nameEl: HTMLElement;
  sizeEl: HTMLElement;
  /** The slide. One spring per row, retargeted — never reset. */
  y: Spring;
  /** The entrance and the exit. */
  fade: Spring;
  /** The number, eased exactly as the phone's readout eases it. */
  size: Spring;
  rank: number;
  leaving: boolean;
  text: string;
  name: string;
}

/**
 * Mount the board. Knows what an id and a diameter are and nothing else — it
 * never touches the scene, the manager or the camera.
 */
export function installLeaderboard(opts: LeaderboardOptions): LeaderboardHandle {
  ensureStyle();

  const el = document.createElement('div');
  el.className = 'world-leaderboard';
  // Findable, and it says what it is rather than reading out a bare column.
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', LEADERBOARD_TITLE);

  const drift = document.createElement('div');
  drift.className = 'world-leaderboard-drift';
  const box = document.createElement('div');
  box.className = 'world-leaderboard-box';

  /*
   * The frame: one wavering loop on paper, the join code's own arrangement
   * in the dom instead of on a canvas (src/phone/worldlink.ts does the same
   * for the way-back button). `aria-hidden` — it is the shape of the thing
   * the type is already announcing.
   */
  const frameSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  frameSvg.setAttribute('class', 'world-leaderboard-frame');
  frameSvg.setAttribute('aria-hidden', 'true');
  frameSvg.setAttribute('preserveAspectRatio', 'none');
  const paper = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  paper.setAttribute('class', 'world-leaderboard-paper');
  frameSvg.appendChild(paper);

  const head = document.createElement('div');
  head.className = 'world-leaderboard-head';
  head.textContent = LEADERBOARD_TITLE;
  const rowsEl = document.createElement('div');
  rowsEl.className = 'world-leaderboard-rows';
  box.append(frameSvg, head, rowsEl);
  drift.appendChild(box);
  el.appendChild(drift);
  opts.mount.appendChild(el);

  /** Resolved display names, one lookup per creature, forever. */
  const names = new Map<string, string>();
  /** How many creatures this board has ever named — the stand-in's number. */
  let named = 0;
  const nameOf = (id: string): string => {
    const held = names.get(id);
    if (held !== undefined) return held;
    named += 1;
    const resolved = displayName(opts.name?.(id), named);
    names.set(id, resolved);
    return resolved;
  };

  const rows = new Map<string, Row>();
  let shown = false;
  let last = 0;
  let lastRank = 0;
  /*
   * The paper's own height, on a ζ≥1 spring over `MOTION.secondaryMs`: the
   * box grows as the field fills and shrinks again as creatures retire, and
   * it never cuts a row off because the row count it is chasing counts the
   * rows still sliding out as well. It starts at the height of an EMPTY
   * board rather than at zero — a box that grew from nothing would be a
   * pop, and the whole thing slides in as one anyway (TASTE §2.1).
   */
  const boxH = new Spring(boardHeight(0), { settleMs: MOTION.secondaryMs });
  /** The size the frame was last drawn at, so the loop is re-emitted only
   * when it has actually changed (src/phone/worldlink.ts's own guard). */
  let drawnAt = '';

  const makeRow = (id: string, rank: number, diameter: number): Row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'world-leaderboard-row';
    const rankEl = document.createElement('span');
    rankEl.className = 'world-leaderboard-rank';
    const nameEl = document.createElement('span');
    nameEl.className = 'world-leaderboard-name';
    const sizeEl = document.createElement('span');
    sizeEl.className = 'world-leaderboard-size';
    rowEl.append(rankEl, nameEl, sizeEl);
    rowsEl.appendChild(rowEl);

    const name = nameOf(id);
    nameEl.textContent = name;
    /*
     * The entrance: one row BELOW where it belongs, transparent, on springs
     * that carry it up into place. A row that appeared at its rank would be
     * a cut, and one that grew from nothing would be a pop (TASTE §2.1).
     */
    const row: Row = {
      id,
      el: rowEl,
      rankEl,
      nameEl,
      sizeEl,
      y: new Spring(rowOffset(rank + 1), { settleMs: MOTION.secondaryMs }),
      fade: new Spring(0, { settleMs: MOTION.secondaryMs }),
      // From zero, so a new entrant's number rolls up the way the phone's
      // does the first time there is a ball to measure.
      size: new Spring(0, { settleMs: MOTION.primaryMs }),
      rank,
      leaving: false,
      text: '',
      name,
    };
    row.y.retarget(rowOffset(rank));
    row.fade.retarget(1);
    row.size.retarget(diameter);
    return row;
  };

  /** Re-read the order. A couple of times a second, never per frame. */
  const rerank = (): void => {
    const ranked = rankEntries(opts.entries(), LEADERBOARD_ROWS);
    const live = new Set<string>();
    for (let i = 0; i < ranked.length; i++) {
      const entry = ranked[i]!;
      live.add(entry.id);
      const held = rows.get(entry.id);
      if (!held) {
        rows.set(entry.id, makeRow(entry.id, i, entry.diameter));
        continue;
      }
      // Back on the board after a drop: it is already on screen and on its
      // way out, so it turns round from wherever it got to rather than
      // being rebuilt at its new rank.
      held.leaving = false;
      held.rank = i;
      held.y.retarget(rowOffset(i));
      held.fade.retarget(1);
      held.size.retarget(entry.diameter);
    }
    for (const row of rows.values()) {
      if (live.has(row.id) || row.leaving) continue;
      // Off the board: down one row and out, and only then off the page.
      row.leaving = true;
      row.y.retarget(rowOffset(row.rank + 1));
      row.fade.retarget(0);
    }
    const any = ranked.length > 0;
    if (any !== shown) {
      shown = any;
      box.classList.toggle('in', any);
    }
  };

  const paint = (now: number): void => {
    const dt = last === 0 ? DRAW_INTERVAL_MS : Math.max(0, now - last);
    last = now;

    if (lastRank === 0 || now - lastRank >= RERANK_MS) {
      lastRank = now;
      rerank();
    }

    // Under everything, forever: the block drifts imperceptibly even in a
    // world where nothing has changed size in a minute (TASTE §3).
    const d = sampleDrift(now, BOARD_SEED, DRIFT_SCALE);
    drift.style.transform = `translate(${d.x.toFixed(3)}px, ${d.y.toFixed(3)}px)`;

    /*
     * The paper, at the height of the field standing on it — every row this
     * board holds, the ones on their way out included, so a leaving row
     * still has paper under it while it goes.
     */
    boxH.retarget(boardHeight(rows.size));
    boxH.update(dt);
    const h = boxH.value;
    rowsEl.style.height = `${Math.max(0, h - boardHeight(0)).toFixed(2)}px`;
    box.style.height = `${h.toFixed(2)}px`;
    // …and the border re-emitted at that size: the same hand redrawing the
    // same loop, which is what makes it deterministic per size and seed.
    const fw = Math.round(BOARD_W_PX);
    const fh = Math.round(h);
    const key = `${fw}x${fh}`;
    if (key !== drawnAt) {
      drawnAt = key;
      frameSvg.setAttribute('viewBox', `0 0 ${fw} ${fh}`);
      paper.setAttribute('d', framePath(fw, fh));
    }

    for (const row of [...rows.values()]) {
      row.y.update(dt);
      row.fade.update(dt);
      row.size.update(dt);

      const fade = Math.max(0, Math.min(1, row.fade.value));
      if (row.leaving && fade < GONE && row.fade.settled()) {
        row.y.dispose();
        row.fade.dispose();
        row.size.dispose();
        row.el.remove();
        rows.delete(row.id);
        continue;
      }

      row.el.style.transform = `translateY(${row.y.value.toFixed(3)}px)`;
      row.el.style.opacity = fade.toFixed(3);

      const rank = `${row.rank + 1}`;
      if (row.rankEl.textContent !== rank) row.rankEl.textContent = rank;
      const next = formatLength(metresOf(row.size.value));
      if (next !== row.text) {
        row.text = next;
        row.sizeEl.textContent = next;
      }
    }
  };

  // ── ~30fps loop: own rAF, skipping frames — the readout's arrangement ─────
  let raf = 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    paint(now);
  };
  const start = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(frame);
  };
  const stop = (): void => {
    if (raf === 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else {
      // A tab that was away for a minute must not hand the springs that
      // whole minute as one step — every row would jump to its new place,
      // and a jump is a cut (TASTE §2.1).
      last = 0;
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  return {
    el,
    rows(): LeaderboardRow[] {
      return [...rows.values()]
        .sort((a, b) => a.rank - b.rank)
        .map((row) => ({
          id: row.id,
          rank: row.rank + 1,
          name: row.name,
          text: row.text,
          y: row.y.value,
          targetY: rowOffset(row.leaving ? row.rank + 1 : row.rank),
          leaving: row.leaving,
        }));
    },
    shown: () => shown,
    dispose(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const row of rows.values()) {
        row.y.dispose();
        row.fade.dispose();
        row.size.dispose();
      }
      boxH.dispose();
      rows.clear();
      el.remove();
    },
  };
}
