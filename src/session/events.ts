/**
 * The session log format — pure data (PLAN §2 purity contract).
 *
 * WHY THIS SHAPE. The generation pipeline is already pure and deterministic:
 * `src/shape/`, `src/inflate/` and `src/character/interpret.ts` take a stroke
 * list and an identity id and produce a byte-identical creature on every
 * device, and every behaviour agent is seeded from the slot id
 * (`src/creatures/manager.ts` → `behaviorSeed`). So a faithful recording does
 * NOT need per-frame positions. It needs the INPUTS (the strokes, the id, the
 * name, the personality answer) and the DECISIONS (what the moderation gate
 * ruled, what the operator tapped, when an egg was forced to hatch), each
 * stamped with an offset from session start. Replay re-drives the same world
 * with the same inputs and the same decisions, and the same creatures come
 * back out.
 *
 * That is the whole reason this file has no positions, no rotations, no
 * per-frame samples and no float dumps in it.
 *
 * TIME. Every `t` in the body is milliseconds since session start. There is
 * exactly one wall clock in the format — `startedAt` in the header — and it is
 * never read during replay. Offsets are monotonically non-decreasing.
 *
 * PURITY. No Three.js, no DOM, no clock, no randomness in this directory. The
 * recorder takes its clock as an injected function, so the whole module runs
 * under node and is unit-testable (test/session/).
 */

import type { StrokeList } from '../shape/types';

/** Format tag written into every log so a reader can recognise the file. */
export const SESSION_SCHEMA = 'refworld.session';

/**
 * Schema version. Bump on any change that an older reader could not honour;
 * `parseSessionLog` refuses versions it does not know.
 *
 * 2 — `drive`, `paint` and `keep` (2026-09-09). Additive kinds, but the bump
 * is NOT optional: `isEvent` below refuses an unrecognised `k`, and one bad
 * event fails the WHOLE file, so a v1 reader handed a log with a drive in it
 * would refuse it as junk rather than as a newer format. The version says
 * which of those two it is. Reading DOWN still works — a v1 log parses here
 * exactly as it always did.
 *
 * 3 — `stick`, `drop`, `loose` and `settle` (2026-09-15, the katamari
 * rules). The same argument as the v2 bump, for the same reason: these are
 * additive kinds, but `isEvent` refuses an unrecognised `k` and one bad
 * event fails the WHOLE file, so a v2 reader handed a log with a pickup in
 * it would call the file junk rather than call it newer. The version is what
 * tells those two apart. Reading DOWN is unaffected — a v1 or v2 log parses
 * here exactly as it always did.
 *
 * 4 — `crack` and `shatter` (2026-09-15, the destruction runtime). Same
 * argument a third time: two more additive kinds, and a v3 reader handed a
 * log with a collapsed building in it would refuse the whole file rather
 * than the event it does not know.
 */
export const SESSION_SCHEMA_VERSION = 4;

// ── event kinds ─────────────────────────────────────────────────────────────

/** Where a drawing came in from. */
export type DrawingSource =
  /** the draw-to-3d mqtt feed (a phone) */
  | 'phone'
  /** the world page's own draw overlay (press d) */
  | 'local'
  /** the ghost panel's fallback fixtures */
  | 'dev';

/** What made a creature emote. */
export type EmoteSource = 'phone' | 'key' | 'panel';

/** What a person chose to keep, in the words the handset shows them
 * (src/phone/keepui.ts labels them `photo`, `3d model`, `link`). */
export type KeepAction = 'photo' | 'model' | 'link';

/** Where a keep came from. Only a handset can save today; the field exists
 * so a later one (an operator export, say) does not need a new kind. */
export type KeepSource = 'phone';

/** Why an egg opened: its own timer, or a person/preset forcing it. */
export type HatchCause = 'timer' | 'forced';

/** Why a creature left the world. */
export type RetireCause =
  /** the population guard retired the oldest slot */
  | 'population'
  /** an operator removed or blocked it */
  | 'operator'
  /** the same drawer sent a new drawing, replacing their slot */
  | 'replaced'
  /** clear-all / reset world */
  | 'cleared';

/** One tap in the moderation panel. `hold` carries `on`. */
export type OperatorAction =
  | 'approve'
  | 'discard'
  | 'remove'
  | 'block'
  | 'unblock'
  | 'hold';

interface EventBase {
  /** Milliseconds since session start. Never a wall clock. */
  t: number;
}

/**
 * A drawing arrived and the gate ruled on it. THE LOAD-BEARING EVENT: the
 * stroke list here is the exact input the generator ran on, so replay can
 * rebuild the identical creature.
 */
export interface DrawingEvent extends EventBase {
  k: 'drawing';
  /** The id the world spawns under — the creature's identity, and the salt
   * for within-band synthesis. Reproducing it is what makes replay faithful. */
  id: string;
  name: string | null;
  personality: string | null;
  source: DrawingSource;
  strokes: StrokeList;
  /** ms until auto-hatch this drawing was admitted with. */
  hatchMs: number;
  /** The gate's ruling: admitted | refused | held | blocked | unusable. */
  disposition: string;
  /** The automatic screen's verdict: allow | hold | refuse. */
  verdict: string;
  reason: string | null;
  confidence: number;
}

/** An egg was placed in the world. Informational — replay derives it from the
 * drawing — but the recorded spot is the cross-check that placement stayed
 * deterministic. */
export interface EggEvent extends EventBase {
  k: 'egg';
  id: string;
  x: number;
  z: number;
}

export interface HatchEvent extends EventBase {
  k: 'hatch';
  id: string;
  cause: HatchCause;
}

export interface RetireEvent extends EventBase {
  k: 'retire';
  id: string;
  cause: RetireCause;
}

export interface EmoteEvent extends EventBase {
  k: 'emote';
  id: string;
  emote: string;
  source: EmoteSource;
}

/** An operator acted in the moderation panel. A replay that silently lost one
 * of these would resurrect something a person deleted. */
export interface OperatorEvent extends EventBase {
  k: 'operator';
  action: OperatorAction;
  /** The drawer acted on; null for the hold-mode toggle. */
  id: string | null;
  /** Only for `hold`: the new state of hold-arrivals mode. */
  on?: boolean;
}

/**
 * Somebody steered a creature: a thumb on the stick, or a handset's intent
 * applied by the page that simulates (src/main.ts, src/net/worldsync.ts).
 *
 * NOT per-frame state, and this is the one kind where that has to be argued
 * rather than assumed. A stick pushes at the display's rate; what is
 * RECORDED is the intent when it changes — the recorder quantises the vector
 * and rate-caps it per creature (src/session/recorder.ts) — so a minute of
 * steering is a handful of events and not 3600. The creature's path is not
 * in the log at all: it is re-derived by re-driving the same intents at the
 * same offsets, exactly as every other kind is.
 */
export interface DriveEvent extends EventBase {
  k: 'drive';
  /** The creature being steered — the id it was spawned under. */
  id: string;
  /** Ground-space direction, x. Absent at rest. */
  ax?: number;
  /** Ground-space direction, z. Absent at rest. */
  az?: number;
  /** 0 is the release — the hand came off the stick. */
  mag: number;
}

/**
 * One dab of the terrain brush, or the tap that cleared the map
 * (src/dev/paint.ts, envpaint's port plan §5 step 6).
 *
 * One event per STAMP, not per stroke: a stroke replays because every dab
 * carries its own place, size and seed. `tool: 'clear'` carries no geometry.
 */
export interface PaintEvent extends EventBase {
  k: 'paint';
  /** A strip tool id — `sculpt` on the height layer, `pond` / `river` on the
   * water one, a planting brush on its own weight layer — or one of the two
   * that are not tools: `clear` for the whole map, and `patch` for a
   * rectangle of texels somebody UNDID (see `layer` below). Ids recorded by
   * older builds (`raise`, `grove`, `drain`…) still apply: src/dev/paint-tools.ts
   * `LEGACY_TOOLS` maps them at the seam. */
  tool: string;
  /** Ground-space centre of the dab — world units, the same space `egg`
   * records, converted from the brush's uv at the seam. Absent on `clear`. */
  x?: number;
  z?: number;
  /** Radius in world units. Absent on `clear`. */
  r?: number;
  /** Per-dab amount, already scaled by the brush. */
  strength?: number;
  hardness?: number;
  /** The stamp mode actually used — a tool erases and alt-smooths, so the
   * tool id alone does not say what the dab did. */
  mode?: string;
  /** The dab's own rim seed, so a replayed stroke has the same edge. */
  seed?: number;
  /** `flatten` only: the height the stroke levelled toward. */
  flattenTo?: number;
  /**
   * Comb only: the stroke's own HEADING at this dab, a unit vector in world
   * xz (2026-09-10, user ask: *"the brushes should have real world physics as
   * well just in the style of ref world"*).
   *
   * The one thing a direction dab did that neither its position nor its mode
   * says. The Brush derives it from the two points the pointer passed
   * through, so nothing at replay time could recover it — and a replayed comb
   * with a different heading is a different comb. Absent on a dab that ERASED
   * a comb, which has no heading to carry.
   */
  dx?: number;
  dz?: number;
  /**
   * `patch` only — the layer the rectangle belongs to (`height`, `water`, or
   * a planting brush's own id), the rectangle in TEXELS, and its floats.
   *
   * An undo is the one thing in this log that is not a dab: History puts a
   * recorded rectangle back into the layer, and no stamp describes what it
   * put there (docs/SESSION.md §paint). So the texels themselves travel —
   * base64 little-endian Float32, row-major within the rect, `(x1-x0+1) *
   * (y1-y0+1)` of them — and the same event replays on a phone, restores
   * from the store and re-applies from the log, exactly like a dab.
   */
  layer?: string;
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  data?: string;
  /**
   * `patch` only — floats per TEXEL in `data`, 1 unless the layer says
   * otherwise. Absent means 1, which is every layer but one.
   *
   * The comb is two channels (a direction, not a weight — src/world/comb.ts),
   * so an undo of a combing stroke carries twice the floats of the rectangle
   * it covers. Without this the door would measure its payload against the
   * texel count, refuse it as the wrong length, and the undo would apply on
   * the projection and nowhere else — which is the exact failure the patch
   * event exists to remove.
   */
  ch?: number;
  /** Water tools only: the absolute surface height the dab filled to, so a
   * replay lays the same plane without re-reading a bank that may since have
   * moved. Absent on a drain, which fills to nothing. */
  level?: number;
  /**
   * `waterfall` only: the y rotation the mark was stamped facing, radians
   * (2026-09-10, user ask: *"i want to match the brushes for env paint
   * exactly"*).
   *
   * Recorded rather than re-derived for the same reason `level` is: the
   * facing comes off the terrain gradient at stamp time, and by the time a
   * log is replayed that ground may have been sculpted. A dab without one —
   * an older log, or a sender that left it off — falls back to the gradient
   * as it now stands, which is the best guess available.
   */
  yaw?: number;
}

/**
 * Somebody kept their creature — a photo, a 3d model, or a link
 * (src/phone/keepui.ts). Informational: it changes nothing in the world, and
 * replay ignores it exactly as it ignores `egg`. It is in the log because
 * "somebody wanted to take this home" is the thing a session is judged on
 * afterwards, and nothing else in the record says it happened.
 */
export interface KeepEvent extends EventBase {
  k: 'keep';
  /** The drawer id — whose creature was saved. */
  id: string;
  action: KeepAction;
  source: KeepSource;
}

/**
 * The four katamari kinds (src/creatures/sticky.ts, docs/SESSION.md §6).
 *
 * WHY THEY ARE IN THE LOG AT ALL, when nothing else about a creature's
 * movement is. The format's whole argument is that positions are DERIVED —
 * same strokes, same id, same seeded agent, same path (see the header). A
 * pickup breaks that: it depends on where a stone had rolled to, which
 * depends on a rapier simulation that is explicitly not bit-identical
 * across devices (src/world/rocks.ts). So "who is carrying what" cannot be
 * re-derived, and the one page that simulates has to SAY it.
 *
 * Which also makes them the one set of creature kinds that are SCENE events
 * (src/session/scene.ts): they describe the world every screen has to be
 * looking at, not this screen's opinion of it.
 *
 * `item` addresses a thing three ways, and the shape of the string is what
 * says which: a placement key (`rock:2:11.50:-8.25` — src/world/scatter.ts
 * `placementKey`), a dev-dropped rock (`spawn:3`), or a creature riding on
 * another creature (`creature:<id>`).
 */
export interface StickEvent extends EventBase {
  k: 'stick';
  /** The carrier — a live creature's spawn id. */
  id: string;
  /** What stuck. See the note above on the three forms. */
  item: string;
  /** Prop kind and variant, so a viewer that never had this placement drawn
   * (it was hidden from the scatter the moment it was taken) can build a
   * mesh for it. Absent for a creature passenger, which already has one. */
  kind?: string;
  variant?: number;
  /** Instance scale of that mesh. */
  scale?: number;
  /**
   * The item's FOOTPRINT RADIUS, which is the volume it adds to the pile
   * (2026-09-17, the sticking report).
   *
   * Additively added, and it has to travel for the same reason `scale` does
   * — only worse. Growth is DERIVED on every page (`clump.growth()` off the
   * radii of what it is carrying), and a viewer reads the radius off the
   * scatter's own instance row. But the placement was hidden the moment the
   * host took it, so by the time a phone applies the event that row can be
   * gone: the radius fell back to the instance SCALE, which is about 1 for
   * everything, and a tree that added 1.73 to the host's pile added 1.00 to
   * the phone's. So the two pages drew the same ball at two sizes, the
   * phone's own size readout under-reported its own ball, and the circle
   * that picks things up on the phone's screen was not the one the host was
   * deciding with — which is what *"some users are having issues sticking
   * to objects"* looks like from the hand holding the phone.
   *
   * Optional, so an old log and an old page still read: absent falls back to
   * exactly what it fell back to before.
   */
  r?: number;
  /** Offset in the CLUMP's local frame — where on the pile it sits. */
  ox: number;
  oy: number;
  oz: number;
  /** …and its rotation there, in the same frame. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** A carrier shed one item: it is set down loose at x, z. */
export interface DropEvent extends EventBase {
  k: 'drop';
  id: string;
  item: string;
  x: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** A rooted prop was knocked out of the ground. On the simulating page it
 * becomes a dynamic body; everywhere else it becomes a mesh of its own
 * (src/world/loose.ts), because the scatter has stopped drawing it. */
export interface LooseEvent extends EventBase {
  k: 'loose';
  item: string;
  x: number;
  z: number;
  /**
   * The instance scale it was DRAWN at (2026-09-17, *"objects shrink when
   * they stick to the character"*).
   *
   * Added additively, and the same argument as `StickEvent.r`: the host has
   * the scatter's instance row when it decides, and a viewer does not — the
   * placement stopped being drawn the moment it came out of the ground. So
   * `showLoose` fell back to 1 and a library model that stood at 2.4 lay
   * there at a third of its size on every screen but the one that decided.
   *
   * And it does not end there: `LooseMeshes.show` is idempotent and hands
   * back the mesh it already made, so a prop drawn at 1 while it lay on the
   * ground kept that scale through the `settle` that followed it and through
   * the pickup after that.
   *
   * Optional, so an old log and an old page read exactly as they did: absent
   * falls back to the instance row, then to 1.
   */
  scale?: number;
}

/**
 * A loose body came to rest here.
 *
 * The only kind in this file that is a POSITION, and it earns it the same
 * way `egg` does not: a viewer runs no physics at all (docs/PLAN.md §7.6),
 * so without this it would have a tree lying wherever the host last told it
 * and no way to learn where the tree actually stopped. Rate-limited on the
 * host to one per item per `MOTION.secondaryMs`, and only for an item that
 * has actually moved — a field of sleeping stones records nothing.
 */
export interface SettleEvent extends EventBase {
  k: 'settle';
  item: string;
  x: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/**
 * A staged prop advanced one stage of its collapse (src/creatures/sticky.ts
 * `stages`, src/world/wreck.ts).
 *
 * A STATE, not a blow: `stage` is where the prop has GOT to — 1 is cracked,
 * 2 is a section gone, 3 is collapsed into rubble — and it is absolute
 * rather than a delta, so a page that missed the first two hits still ends
 * up looking at the same ruin. Which is also why `compactScene` keeps only
 * the last one per item.
 *
 * The damage that produced it is not in the log at all. It is a running
 * total on the host (a `Map<key, number>`, docs/PLAN.md §7.6) and no other
 * page has a use for it: what a viewer has to know is what the building
 * looks like now.
 */
export interface CrackEvent extends EventBase {
  k: 'crack';
  /** The placement key of the prop that took the damage. */
  item: string;
  /** 1 cracks, 2 a section gone, 3 rubble. */
  stage: number;
}

/**
 * A `large` prop broke into all of its chunks at once — the `break` outcome
 * (src/creatures/sticky.ts `shatterStrength`).
 *
 * Unlike a `crack` this carries the prop's own pose and mesh hints: by the
 * time a phone hears it the placement has been hidden from the scatter, and
 * the chunk set has to be built and seated from the event alone
 * (src/world/chunks.ts `buildChunkGeometries`, whose offsets are in the
 * prop's object space at scale 1).
 *
 * The chunks themselves are LOCAL debris on every page — they are secondary,
 * there can be a lot of them, and the brief asks for exactly that split
 * (*"the server syncs only destruction states and major transforms"*). The
 * ones that come to matter travel anyway: as a `settle` (where a piece ended
 * up) or as a `stick` whose `item` is `<placementKey>#<chunkIndex>` (a
 * creature picked a piece up).
 */
export interface ShatterEvent extends EventBase {
  k: 'shatter';
  item: string;
  x: number;
  z: number;
  rotY: number;
  scale: number;
  kind: string;
  variant: number;
}

/** A world-level control an operator changed — weather, time of day, density,
 * grain, paper colour. Discrete samples only: nothing here is read per frame. */
export interface WorldEvent extends EventBase {
  k: 'world';
  field: string;
  value: number | string | boolean | null;
  /** Prop kind, for the per-kind density/scale sliders. */
  kind?: string;
}

export type SessionEvent =
  | DrawingEvent
  | EggEvent
  | HatchEvent
  | RetireEvent
  | EmoteEvent
  | DriveEvent
  | PaintEvent
  | KeepEvent
  | OperatorEvent
  | WorldEvent
  | StickEvent
  | DropEvent
  | LooseEvent
  | SettleEvent
  | CrackEvent
  | ShatterEvent;

export type SessionEventKind = SessionEvent['k'];

// ── header ──────────────────────────────────────────────────────────────────

/**
 * The generation-affecting configuration this session ran under. Anything
 * that changes what a stroke list turns into belongs here, so a replay on a
 * later build can tell whether it is comparing like with like.
 */
export interface SessionConfig {
  [key: string]: number | string | boolean | null;
}

export interface SessionHeader {
  schema: typeof SESSION_SCHEMA;
  version: number;
  /** The world session id `src/main.ts` mints (its `epoch`). */
  epoch: string;
  /** The room this world hosted. */
  room: string;
  /** The one and only wall clock in the format (iso 8601). Replay ignores it. */
  startedAt: string;
  config: SessionConfig;
}

export interface SessionLog extends SessionHeader {
  events: SessionEvent[];
}

// ── serialise / parse ───────────────────────────────────────────────────────

export function serializeSessionLog(log: SessionLog): string {
  return JSON.stringify(log);
}

const EVENT_KINDS = new Set<string>([
  'drawing',
  'egg',
  'hatch',
  'retire',
  'emote',
  'drive',
  'paint',
  'keep',
  'operator',
  'world',
  'stick',
  'drop',
  'loose',
  'settle',
  'crack',
  'shatter',
]);

function isStrokeList(value: unknown): value is StrokeList {
  if (!Array.isArray(value)) return false;
  for (const stroke of value) {
    if (typeof stroke !== 'object' || stroke === null) return false;
    const rec = stroke as Record<string, unknown>;
    if (typeof rec['w'] !== 'number' || !Number.isFinite(rec['w'])) return false;
    const pts = rec['pts'];
    if (!Array.isArray(pts)) return false;
    for (const p of pts) {
      if (!Array.isArray(p) || p.length < 2) return false;
      for (const n of p) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return false;
      }
    }
  }
  return true;
}

function isEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  const kind = rec['k'];
  if (typeof kind !== 'string' || !EVENT_KINDS.has(kind)) return false;
  if (typeof rec['t'] !== 'number' || !Number.isFinite(rec['t']) || rec['t'] < 0) return false;
  if (kind === 'drawing') return typeof rec['id'] === 'string' && isStrokeList(rec['strokes']);
  if (kind === 'world') return typeof rec['field'] === 'string';
  if (kind === 'operator') return typeof rec['action'] === 'string';
  // A dab is addressed by its tool, not by a creature id — the map is what
  // it acts on. `clear` is the one that carries no geometry at all.
  if (kind === 'paint') return typeof rec['tool'] === 'string';
  if (kind === 'drive') {
    return typeof rec['id'] === 'string' && typeof rec['mag'] === 'number';
  }
  if (kind === 'keep') {
    return typeof rec['id'] === 'string' && typeof rec['action'] === 'string';
  }
  // The katamari kinds are addressed by the ITEM, and two of them by a
  // carrier as well. `loose` and `settle` carry no creature id at all — a
  // tree comes out of the ground because something hit it, and which
  // something is not a thing anybody replays.
  if (kind === 'stick' || kind === 'drop') {
    return typeof rec['id'] === 'string' && typeof rec['item'] === 'string';
  }
  if (kind === 'loose' || kind === 'settle') return typeof rec['item'] === 'string';
  // The two destruction kinds are addressed by the item as well — a building
  // cracks because something hit it, and which something is no more
  // replayable than it is for a `loose`. A `crack` needs its stage: the
  // event IS the state, and a stage nobody can read is not a state.
  if (kind === 'crack') {
    return typeof rec['item'] === 'string' && typeof rec['stage'] === 'number';
  }
  if (kind === 'shatter') {
    return typeof rec['item'] === 'string' && typeof rec['kind'] === 'string';
  }
  return typeof rec['id'] === 'string';
}

/**
 * Read a log back. Returns null on anything that is not a log this build
 * understands — a wrong schema tag, a future version, junk in the events —
 * rather than half-replaying a file. Offsets are also checked for monotonicity,
 * because a log whose clock went backwards cannot be scheduled.
 */
export function parseSessionLog(text: string): SessionLog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return readSessionLog(parsed);
}

/** The same validation over an already-parsed value (a structured clone, a
 * fetch's json, a postMessage payload). */
export function readSessionLog(parsed: unknown): SessionLog | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['schema'] !== SESSION_SCHEMA) return null;
  const version = rec['version'];
  if (typeof version !== 'number' || version > SESSION_SCHEMA_VERSION || version < 1) return null;
  if (typeof rec['epoch'] !== 'string') return null;
  if (typeof rec['room'] !== 'string') return null;
  if (typeof rec['startedAt'] !== 'string') return null;
  const config = rec['config'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const events = rec['events'];
  if (!Array.isArray(events)) return null;
  let last = -1;
  for (const event of events) {
    if (!isEvent(event)) return null;
    if (event.t < last) return null;
    last = event.t;
  }
  return {
    schema: SESSION_SCHEMA,
    version,
    epoch: rec['epoch'],
    room: rec['room'],
    startedAt: rec['startedAt'],
    config: config as SessionConfig,
    events: events as SessionEvent[],
  };
}

/** Offset of the last event, in ms — how long the session ran. */
export function sessionDurationMs(log: SessionLog): number {
  const last = log.events[log.events.length - 1];
  return last ? last.t : 0;
}

/** Count events by kind — the panel readout, and a cheap test assertion. */
export function countByKind(log: SessionLog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of log.events) out[event.k] = (out[event.k] ?? 0) + 1;
  return out;
}
