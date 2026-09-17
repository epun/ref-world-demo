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
 * THE MARKS, and there are two (TASTE §4 — `icon` + `ruleLine` + `border`,
 * the world brief's #1 defining signal at confidence 1.00):
 *
 * - TYPE, in the world view's own face and size — the same one `.world-say`,
 *   `.draw-hint` and the ball readout are set in, because this is another
 *   line of the world's own chrome and a second face here would be a second
 *   voice. Lowercase throughout (TASTE §5): the header word, every name (the
 *   name is lowercased at its source, src/creatures/naming.ts) and the units;
 * - a single HAIRLINE RULE under the header — the world brief's *"reserve a
 *   single hairline rule to divide the frame"*. One, under `biggest`, and
 *   none between the rows: ten rules down the left of a projection is a
 *   table, and the density axis is the design (TASTE §2.3).
 *
 * No filled panel, no card, no background, no shadow, and no rank icons: the
 * edge is a layout, not a surface. It sits at the TOP of the left edge
 * because the bottom-left corner is the join code (src/ui/joinqr.ts) and the
 * two must never reach each other — the rows are capped at ten and the block
 * is one fixed height, so the leaderboard cannot grow into the qr.
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

// ── the edge ─────────────────────────────────────────────────────────────────

/** Stable seed for this block's drift channel. */
const BOARD_SEED = 71.6;
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
  width: clamp(224px, 18vmin, 300px);
  color: ${WORLD.ink};
  font: 400 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  pointer-events: none;
}
/* The drift layer, written per frame: nothing fully arrests (TASTE §3). It
   is its own element because the slide below owns a transform of its own. */
.world-leaderboard-drift { display: block; }
/*
 * The header, and the one hairline rule. Out of the way and transparent
 * until there is a ball anywhere in the world, then it comes down into
 * place over t.secondary on the drift-settle curve — the css-side
 * equivalent of the ζ≥1 spring, so no bounce by construction.
 */
.world-leaderboard-head {
  padding-bottom: 0.45em;
  border-bottom: 1px solid ${WORLD.ink};
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity ${MOTION.secondaryMs}ms ${MOTION.settleCurve},
    transform ${MOTION.secondaryMs}ms ${MOTION.settleCurve};
}
.world-leaderboard-head.in {
  opacity: 1;
  transform: translateY(0);
}
/* The rows are laid out by transform inside a block of fixed height, so a
   rank change slides and never reflows. Ten rows is the cap and the height. */
.world-leaderboard-rows {
  position: relative;
  height: ${LEADERBOARD_ROWS * ROW_PX}px;
  margin-top: 0.4em;
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
  el.setAttribute('aria-label', 'biggest balls');

  const drift = document.createElement('div');
  drift.className = 'world-leaderboard-drift';
  const head = document.createElement('div');
  head.className = 'world-leaderboard-head';
  head.textContent = 'biggest';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'world-leaderboard-rows';
  drift.append(head, rowsEl);
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
      head.classList.toggle('in', any);
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
      rows.clear();
      el.remove();
    },
  };
}
