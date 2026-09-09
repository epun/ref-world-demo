# the session log

An append-only record of everything that happened in one world session, in a form that can
be replayed in code later to re-drive the same world.

Code: [`src/session/`](../src/session) — pure, node-safe, no Three.js and no DOM.
Wired at the seams in [`src/main.ts`](../src/main.ts),
[`src/moderation/gate.ts`](../src/moderation/gate.ts) and
[`src/creatures/manager.ts`](../src/creatures/manager.ts).
Tests: [`test/session/`](../test/session).

---

## 1. Why the log has no positions in it

The generation pipeline is already pure and deterministic. `src/shape/`, `src/inflate/` and
`src/character/interpret.ts` turn a stroke list plus an identity id into a byte-identical
creature on every device; spawn placement is a golden-angle spiral over the arrival order;
and each behaviour agent is seeded from its slot id (`behaviorSeed`). PLAN §1 calls that
determinism load-bearing — it is why the phone can render your character locally instead of
streaming video from the world.

So a faithful recording does **not** need per-frame state. It needs:

- the **inputs** — the strokes, the id, the name, the personality answer, the hatch delay;
- the **decisions** — what the moderation screen ruled, what the operator tapped, whether a
  shell opened on its timer or because someone forced it;
- an **offset in ms** for each, from session start.

Replay re-drives a world with the same inputs and the same decisions in the same order, and
the same creatures come back out. That is the whole trick, and it is why this format is a
few kilobytes of json rather than a video.

It also means the log stays cheap: appending is one push, and **nothing is wired to the
frame loop**, so an idle world records nothing at all.

---

## 2. The format

One json object: a header, then a flat array of events.

```jsonc
{
  "schema": "refworld.session",
  "version": 2,
  "epoch": "w1x9k2j",          // the world session id src/main.ts mints
  "room": "xkcd",
  "startedAt": "2026-08-18T09:14:02.115Z",   // the ONE wall clock in the file
  "config": {                  // generation-affecting configuration
    "hatchMs": 20000,
    "maxPopulation": 24,
    "wanderSpeed": 1.4,
    "ground": "#dfdfdf",
    "construction": "inflate",
    "worldScale": 1
  },
  "events": [ /* … */ ]
}
```

**Time.** Every `t` in the body is **milliseconds since session start**. There is exactly
one wall clock in the format — `startedAt` — and replay never reads it. Offsets are clamped
monotonic: a clock that stalls or steps back can never write an event before one already in
the log, so the log is always schedulable.

### events

| `k` | fields | meaning |
|---|---|---|
| `drawing` | `id`, `name`, `personality`, `source`, `strokes`, `hatchMs`, `disposition`, `verdict`, `reason`, `confidence` | a drawing arrived and the gate ruled on it. **The load-bearing event** — the stroke list here is the exact generator input. `source` is `phone` \| `local` \| `dev`; `disposition` is the gate's ruling (`admitted` \| `refused` \| `held` \| `blocked` \| `unusable`) and `verdict` the automatic screen's (`allow` \| `hold` \| `refuse`) |
| `egg` | `id`, `x`, `z` | an egg was placed. Informational: replay derives it from the drawing. The spot is the cross-check that placement stayed deterministic |
| `hatch` | `id`, `cause` | a shell opened. `cause` is `timer` or `forced` |
| `retire` | `id`, `cause` | a creature left. `cause` is `population` (the guard), `operator`, `replaced` (same drawer sent a new drawing), `cleared` (clear-all / reset) |
| `emote` | `id`, `emote`, `source` | an emote played. `source` is `phone` \| `key` \| `panel` |
| `drive` | `id`, `ax`, `az`, `mag` | somebody steered a creature. `ax`/`az` are the ground-space direction under the camera at that moment, `mag` how hard. `mag: 0` (with no `ax`/`az`) is the release — the hand came off the stick. Thinned, never per frame — see below |
| `paint` | `tool`, `x`, `z`, `r`, `strength`, `hardness?`, `mode?`, `seed?`, `flattenTo?` | one dab of the terrain brush (dev). `tool` is `raise` \| `lower` \| `flatten` \| `smooth`; `x`/`z`/`r` are world units, the same space `egg` uses; `mode` is what the dab actually did (a tool erases with ctrl, smooths with alt); `seed` is the dab's own rim. `{ tool: 'clear' }` — the map was thrown away — carries no geometry |
| `keep` | `id`, `action`, `source` | somebody kept their creature: `action` is `photo` \| `model` \| `link`, `source` is `phone`. Informational — nothing in the world changed — and in the log because "somebody wanted to take this home" is what a session is judged on afterwards |
| `operator` | `action`, `id`, `on?` | a moderation tap: `approve`, `discard`, `remove`, `block`, `unblock`, or `hold` (with `on` carrying the new hold-arrivals state). Bulk taps record one event per drawer, not one for the batch |
| `world` | `field`, `value`, `kind?` | a world control an operator moved: `weather`, `timeOfDay`, `intensity`, `wind`, `density`, `kindDensity`/`kindScale` (with `kind`), `landscape` (`1` reveals the authored map, `0` returns the world to the flat plain it opens on), `terrain` (with `kind` — `elevation`, `tierStep` or `relief`), `grain`, `background`, `objectHue`/`objectSaturation`, `ink*`, `wanderSpeed` |

### the two thinned kinds

Every other kind is wired to a discrete seam and records once per thing that
happened. Two are wired to a *continuous* input and would otherwise be a
per-frame dump wearing an event's clothes:

- **`drive`** — a thumb on the stick pushes at the display's rate, times every
  creature being steered. The recorder quantises the intent (heading to **1/16
  of a turn**, magnitude to **tenths** — both [D]) and writes one only when
  that cell changes, at most **one per creature per `MOTION.tertiaryMs`**
  (456ms, [D] — the shortest interval this project treats as a movement anybody
  perceives, so also the shortest at which "they turned" is worth a line).
  A change that arrives inside the window is *dropped*, not deferred. The
  **release is exempt from the cap and recorded exactly once**: it is the event
  that ends a drive, and a log that lost it would leave the creature walking for
  the rest of the replay. What lands in the log is the vector as it was pushed,
  rounded — the quantised cell decides *when* to write, never *what*.
- **`paint`** — one event per **dab**, not per pointermove: dabs are spaced by
  the brush, not by the display. The four rim-shape settings (`edgeNoise`,
  `edgeScale`, `spatter`, `aspect`) are *not* recorded per dab — they are brush
  state, identical across a stroke, and a replay reads them off the brush it is
  stamping through.

Both still hold the rule the format is built on: an idle world records nothing,
and nothing in the file is a per-frame sample of anything.

### the one rewrite

The log is append-only with a single narrowly-scoped exception: a **continuous** control
writing the same `world` field again within 250ms overwrites its own previous sample instead
of appending. That turns a slider drag into one event rather than one per pointermove. Every
other event kind only ever appends.

Past a hard `limit` (50 000 events) the recorder **refuses** new events rather than dropping
old ones — a truncated prefix still replays faithfully, a log with a hole in the middle does
not. The panel readout says so when it happens.

### ordering note

An admitted drawing reads `egg` then `drawing` at the same offset. The gate stamps its
ruling when its spawn call *returns* — the only moment it can tell `admitted` from
`unusable` — while the manager emits the egg from inside that call. Same id, same
millisecond, and replay treats `egg` as informational.

---

## 3. What is and is not captured

**Captured**

- session start: the world `epoch`, the room, the generation-affecting config, the schema
  version, and one wall-clock stamp;
- every drawing that reached the gate, with its strokes — including the ones that were
  refused, held or blocked, so a decision stays auditable after the event;
- every egg, every hatch (timer vs forced), every retirement and why;
- every emote the world played, and what triggered it;
- every steering intent applied on the page that simulates — this screen's own
  stick, and a handset's intent arriving over the wire — including the releases,
  thinned as above;
- every dab of the terrain brush, and the tap that cleared the map;
- every save a handset made (photo, 3d model, link);
- every operator tap in the moderation panel, including hold-mode toggles;
- world-level control changes an operator made from the panel.

**Not captured** — deliberately

- per-frame anything: positions, headings, gait phase, camera. All of it is re-derived;
- the camera tour's autonomous choices, and the behaviour agents' moment-to-moment
  decisions. Both are seeded and re-derive themselves, but they are driven by the world
  clock, so a replay reproduces the same *population*, not the same frame-by-frame walk;
- drawings that never reached the gate (a phone that never hit send);
- **`follow`** — whether a handset's camera is riding its own creature
  (src/world/follow.ts). It is handset-local view state, not a world event:
  nothing in the world changes when somebody taps the minimap, and two people
  watching the same world hold different answers at the same instant. A log is
  what happened in the world, not where each person was looking;
- a save that FAILED. A save that did not save is not a save;
- anything from the phone side that the world does not observe.

---

## 4. Replaying

### in code

`src/session/replay.ts` is pure: it walks the log and calls a `ReplayDriver`.

```ts
import { parseSessionLog, replaySession, replayNow } from './session';

const log = parseSessionLog(json);          // null if it is not a log this build reads
replayNow(log, driver);                     // immediately, in order — no waiting
replaySession(log, driver, { speed: 2 });   // in time, at 2× the recorded pace
```

The driver is four methods — `spawn`, `hatch`, `emote`, `remove` — plus optional `world`,
`operator`, `drive` and `paint`. `src/main.ts` implements it over the live creature manager; a test implements it
with a `Map`.

What replay does with each event:

| recorded | replay |
|---|---|
| `drawing`, `admitted` | spawn that id with those strokes |
| `drawing`, `held` | hold the payload; spawn only if an `operator approve` follows |
| `drawing`, `refused` / `blocked` / `unusable` | never spawn. A verdict a person or the screen made is **not re-litigated** on a newer build |
| `operator remove` / `block` | remove that creature — the event whose loss would resurrect something someone deleted |
| `hatch` | force that shell open at the recorded offset |
| `emote` | play it, if that creature is still standing |
| `drive` | steer that creature again through `manager.drive`, and let go again at the recorded offset — the hold makes its agent wait exactly as long as it waited live. Paced replay only (below) |
| `paint` | re-stamp that dab through the paint skill's own apply path, on the panel's terrain-rebuild throttle. Skipped in a build with no brush mounted — the skill is dev-gated, and what this page cannot drive is never faked. Paced replay only |
| `keep` | ignored — informational, like `egg` |
| `world` | hand the change to the driver |
| `egg`, `retire (population / replaced)` | ignored — reproduced by the world itself from the same spawn sequence |

**`drive` and `paint` are paced-replay only.** Both are made of time — a drive is
"push, hold, let go", a stroke is a hand moving — so applied all at once they mean
nothing, and the last push would never be released: the creature would walk for
good. `replayNow`, which is what a restore uses (§4a), passes `{ instant: true }`
and skips them; `replaySession` applies them in full.

Spawns go **straight to the manager**, never back through the moderation screen: the
recorded verdict is the decision.

`expectedCreatures(log)` returns the ids that should be standing when the log ends, computed
from the log alone with no world involved — the assertion handle for verification.

### in the running world

The world page exposes an always-on handle (same family as `__refworldCreatures`), in every
build, not just dev:

```js
__refworldSession.count()             // events so far
__refworldSession.log()               // the log object
__refworldSession.json()              // the log as json
__refworldSession.replay(json, { speed: 4 })   // clear the world and re-drive it
__refworldSession.stopReplay()
__refworldSession.restore(json)       // the WHOLE log at once — see §4a
__refworldRestore()                   // restore this machine's last session
```

### from the ghost panel (shift+d → `session`)

- a readout: event count, session length, and counts by kind;
- **restore last session** — the recovery button, see §4a;
- **restore from a log file** — the same, from a downloaded json;
- **download session log** — writes `session-<epoch>.json`, with every kind in it. In a
  named world the epoch is `w-<world>`, so the file is `session-w-meridian.json` — the world,
  not the page, which is what makes two viewers' downloads comparable. It stays the
  operator's button: the projection's panel is where the record of the room belongs, and a
  handset has no business exporting the room's log;
- **replay a session log (at its recorded pace)** — re-drive this world with it.

The panel is the only dev-gated part. **The recorder itself ships in every build** — a live
event is exactly when you want the log.

---

## 4a. Restore — recovery, which is not replay

> User report, 2026-08-20: *"chrome refreshed is there any way to recover the session where
> people added their character"* — *"no i want to recover it."*

A **replay** re-runs a session at the pace it was recorded. That is right for watching a
session back and wrong for getting a refreshed projection its population back: press it on
an hour-long log and the world sits empty for minutes while the panel says it is working.

A **restore** walks the same log with `replayNow` — every spawn, hatch, emote and removal
applied at once — so the world lands in the state the log ends in. The kinds that are made
of pacing are left out of it: `drive` and `paint` are skipped (§4), and `keep` is
informational everywhere. Same driver, same
recorded decisions, same ids. The pipeline is pure in `(strokes, id)`, so these are the
**identical** creatures, not lookalikes.

There are three copies of a drawing at any moment, and recovery tries them in the order
that asks least of the room:

| copy | where | how it comes back |
|---|---|---|
| the world's log | `localStorage` on the projection machine, written on every gate decision and every hatch | **`shift+R`**, or the panel's *restore last session*. Instant, offline, needs nobody |
| the handset's record | `localStorage` on each phone | the phone **re-homes itself** the moment it hears a new epoch (below); **`shift+R`** also broadcasts a recall; `?recover=1` is the deliberate link |
| the downloaded json | wherever it was saved | the panel's *restore from a log file* |

`shift+R` runs the first and broadcasts the second, and says on screen which of them found anything. Both are idempotent in the creature id — the
manager replaces a slot rather than adding one — so running both is safe.

**Fullest, not newest.** A refresh mints a new epoch and immediately starts an empty log, so
"most recent" is reliably the one with nothing in it. Restore picks the log from a *previous*
epoch with the most events.

### the handsets re-home themselves

When the world restarts it announces a new epoch — as a **retained** message
(`announceEpochRetained`, src/net/drawFeed.ts). Retained is the whole trick.
`publishToPhones` sends at qos 0 with no retain, which reaches exactly the
handsets connected at that instant — and a projection restart is precisely the
moment when phones are asleep, backgrounded or reconnecting. The broker holds a
retained message and delivers it to every subscriber the moment it subscribes,
however much later, so a phone that wakes in ten minutes still learns the new
epoch on connect. The reply-to-`hello` path stays as a backstop rather than
being the mechanism. A handset holding a drawing from the old
one used to be sent back to a blank pad — and the record was **deleted on the way out**. That
was the single most destructive line in the project: the one copy of a drawing that survives
a projection restart, thrown away by the code that noticed the restart. There were two of
them, one in `src/phone/main.ts` and one in `public/draw/index.html`, and they are both gone
(`test/session/recovery.test.ts` pins that).

Now the handset re-publishes instead, under the same id, and adopts the new epoch. The
population rebuilds itself within seconds of a refresh, with nobody pressing anything. Beyond
`REHOME_WINDOW_MS` (6 hours) it stops — a drawing from yesterday is not walked into a new
session — but even then the record is kept, so a recall can still ask for it.

---

## 5. Where it is wired

| seam | what it records |
|---|---|
| `src/moderation/gate.ts` → `observer` | every ruling (`decision`) and every operator tap (`operator`). One seam, so a drawing cannot enter the world unrecorded — nothing spawns around the gate |
| `src/creatures/manager.ts` → `observer` | `egg`, `hatch` (with its cause), `retire` (with its cause), `emote` (with its source) |
| `src/main.ts` → `applyDrive` | `drive`. The one seam every steering intent passes through on the page that SIMULATES — this screen's own stick, a viewer's intent off the wire, and the expiry that lets go for a phone that stopped talking. A route that steered a creature around it would be a hand on the world the log never saw |
| `src/main.ts` → `connectWorldFeed({ onKeep })` | `keep`, on the host only, so a room with two screens open does not log it twice. The handset publishes `{ type: 'keep', from, action }` on the room's own topic (src/net/phoneLink.ts), the same transport an emote rides; with no link there is nothing sent and the save is exactly as saved |
| `src/dev/paint.ts` → each tool's `onStamp`, and the `clear map` button | `paint` |
| `src/dev/index.ts` panel handlers | `world` control changes |

Both observers are **structural** interfaces declared in the module they serve, so neither
moderation nor the creature manager imports the session module. They stay leaves; the log is
wired in at `src/main.ts`.
