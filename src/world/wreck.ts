/**
 * What has broken, and how far — the destruction bookkeeping (PLAN §7.6).
 *
 * > User brief, 2026-09-15: *"buildings use STAGED destruction: impact 1 →
 * > cracks, impact 2 → a section removed, impact 3 → collapse into rubble."*
 *
 * PURE-ISH, and deliberately so. Nothing in here touches three.js, rapier,
 * the clock or the scene graph: it is a record of state and the arithmetic
 * that moves it on. The presentation of that state — which chunk meshes are
 * drawn, which ones become bodies, where the ink draws cracks — lives in
 * `src/creatures/manager.ts` (every page) and `src/world/debris.ts` (the
 * host's bodies). The split is the same one the katamari rules already make:
 * a `WreckState` is what a `crack` or a `shatter` event PUTS a page into, so
 * it has to be derivable from the event alone and from nothing else about
 * the page that received it.
 *
 * TWO WAYS A PROP COMES APART, and they meet here:
 *
 *   STAGED (`building`, `mountain`) — cumulative damage climbs through
 *   `STICKY[kind].stages` and the wreck advances a stage at a time. Stage 1
 *   is cracks and nothing more; stage 2 takes the chunks marked `stage: 0`
 *   out (a section gone); stage 3 frees everything that is left (the
 *   collapse).
 *
 *   WHOLE (`monolith`, `waterTower`) — one impact past `shatterStrength`
 *   and every chunk goes at once, which is `advance(state, 3, chunks)` with
 *   nothing before it.
 *
 * WHICH CHUNK GOES WHEN comes off the chunk itself (`Chunk.stage`, authored
 * per family in src/world/chunks.ts — a mountain's summit before its
 * shoulders before its foot), never off an index, so a family whose parts
 * are listed in a different order still comes down top-first.
 */

import type { Chunk } from './chunks';
import type { PropKind } from './props';

/** Everything a page needs to know about one broken placement. */
export interface WreckState {
  /** The placement key of the prop that broke. */
  key: string;
  kind: PropKind;
  variant: number;
  /** Instance scale it was drawn at — chunk offsets are in the prop's own
   * object space at scale 1, so every one of them multiplies by this. */
  scale: number;
  x: number;
  z: number;
  rotY: number;
  /** 0 intact, 1 cracked, 2 a section gone, 3 rubble. */
  stage: 0 | 1 | 2 | 3;
  /** Chunk indices that have already left as debris. Never re-freed: a
   * fragment that a creature has since carried off must not be respawned by
   * a later stage of the same collapse. */
  removed: Set<number>;
}

/** What a stage change does to the world, as two lists of chunk indices. */
export interface WreckChange {
  /** Chunks that become debris NOW (bodies on the host, meshes everywhere). */
  freed: number[];
  /** Chunks that are still part of the ruin, to be drawn where they sit. */
  standing: number[];
}

/**
 * A fresh record of a prop that has just started coming apart.
 *
 * `stage: 0` — nothing has been taken out yet, which is true even of a
 * shatter for the one call it takes to advance it.
 */
export function createWreck(seed: {
  key: string;
  kind: PropKind;
  variant: number;
  scale: number;
  x: number;
  z: number;
  rotY: number;
}): WreckState {
  return { ...seed, stage: 0, removed: new Set<number>() };
}

/**
 * Which chunks a wreck at `stage` has let go of.
 *
 * Stage 1 frees nothing — a crack is a mark on a building that is still
 * standing, and a building that shed a wall on the first hit would leave the
 * brief's three beats with two. Stage 2 frees the chunks authored as
 * `stage: 0` (the section that goes first). Stage 3 frees everything, which
 * is what "collapse into rubble" has to mean.
 */
export function freedAtStage(chunks: readonly Chunk[], stage: 0 | 1 | 2 | 3): number[] {
  if (stage <= 1) return [];
  const out: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (stage >= 3 || chunks[i]!.stage === 0) out.push(i);
  }
  return out;
}

/**
 * Move a wreck to `stage` and say what changed.
 *
 * MONOTONIC and IDEMPOTENT, both of which the event format depends on: a
 * `crack` carries the stage a prop has reached rather than a blow, a
 * restored log replays only the LAST crack per item (`compactScene`), and a
 * page that hears stage 3 having missed 1 and 2 must land in the same place
 * as one that heard all three. So this is written as "bring the state up to
 * here", not "apply one more hit" — asking for a stage already passed
 * changes nothing and frees nothing twice.
 */
export function advance(
  state: WreckState,
  stage: 0 | 1 | 2 | 3,
  chunks: readonly Chunk[],
): WreckChange {
  if (stage > state.stage) state.stage = stage;
  const freed: number[] = [];
  for (const index of freedAtStage(chunks, state.stage)) {
    if (state.removed.has(index)) continue;
    state.removed.add(index);
    freed.push(index);
  }
  const standing: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!state.removed.has(i)) standing.push(i);
  }
  return { freed, standing };
}

/**
 * Is there anything of this prop left standing?
 *
 * The presentation reads it to decide whether the ruin is still worth
 * drawing chunk meshes for, or whether the whole placement is now debris and
 * the ruin is gone.
 */
export function intact(state: WreckState, chunks: readonly Chunk[]): boolean {
  return state.removed.size < chunks.length;
}

/**
 * A deterministic spread for `n` fragments leaving a break, in the xz plane.
 *
 * NO RANDOMNESS, like everywhere else in this pipeline (CLAUDE.md): the
 * angle is folded out of the parent's own key and the chunk's index, so a
 * collapse looks the same on every screen that is told about it — and, more
 * to the point, looks the same twice in a row on the same one. The caller
 * combines this with the chunk's own offset direction, which is what
 * actually points a piece outward; this is the jitter that stops four
 * fragments leaving along the same four spokes every time.
 */
export function fragmentSpread(key: string, index: number): { x: number; z: number } {
  // A plain string fold (the same family as the prop pipeline's hashes: a
  // multiply-and-add over the characters, kept in a safe integer range).
  let n = 2166136261;
  for (let i = 0; i < key.length; i++) {
    n = (n ^ key.charCodeAt(i)) * 16777619;
    n = n >>> 0;
  }
  n = (n ^ (index * 2654435761)) >>> 0;
  const angle = (n / 4294967296) * Math.PI * 2;
  return { x: Math.cos(angle), z: Math.sin(angle) };
}
