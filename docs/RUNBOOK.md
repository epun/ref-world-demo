# running the room

One page. Read it before the demo, not during.

## before people arrive

1. Open the world on the projection machine. Note the room code in the corner —
   it is lowercase, always, and it is what the QR encodes.
2. Press `h` once with no eggs present. Nothing should happen. That is the check
   that the manual hatch is wired; eggs do **not** hatch on a timer any more
   (`AUTO_HATCH = false`), so `h` is the only thing that opens them.
3. Draw one throwaway creature yourself from a phone, end to end, and hatch it.
   This proves the broker is reachable from the venue's network — the single
   most common way the room fails, and the one thing you cannot fix in the
   moment.
4. Delete it: `shift+d` → the creature's row → remove. Or just reload; nobody
   has drawn yet.

## during

- `h` hatches every waiting egg, staggered.
- `shift+R` is recovery (below). It always reports on screen.
- `t` toggles the camera tour. `d` opens the local draw overlay.
- `shift+d` is the ghost panel. It has the moderation list, the session
  readout, and the recovery buttons.
- **The world opens flat** — an open field of scattered props on flat paper,
  no forest, no lake, no hills. That is the starting point to sculpt from.
- To reveal the map: `shift+d` → `landscape` → tick **landscape**. The forest,
  the range, the lake and its island, the ponds and every foot of elevation
  come in together. The three dials under it — **elevation**, **tier spacing**,
  **relief spread** — then shape it live; each one re-cuts the ground, so give
  a drag half a second to settle.
- To open a link already revealed, put `?landscape=1` on it. The deployed
  build has no panel until somebody presses `shift+d`, so this is how a world
  that is meant to show its geography from the first frame gets it.

## sculpting live

The world opens flat and the operator builds it in front of the room. Every
phone in the room is looking at **this same page**, so what gets sculpted has
to reach them — and it has to survive the redeploy that happens between the
rehearsal and the night.

1. **Open the projection as `?host=1&mod=<MODERATOR_SECRET>`** (plus `?world=`
   if you are on the public site rather than the world's own deployment). The
   secret is taken off the address the moment the page loads and kept on that
   machine, so the url you then hand round is clean. Without it you can still
   sculpt and everyone still sees it — it just is not kept.
2. Sculpt: `shift+d` → `landscape` → tick **landscape**, move the three dials,
   then `paint` → tick **painting** and drag on the ground.
3. Under the dials, the **`scene`** line says what is happening to all of it:
   `scene · 412 events · stored`. Anything else is worth reading —
   `not stored (no secret)` means step 1 was skipped,
   `not stored (404: wrong secret)` means it was wrong, and
   `no store on this deployment` means this world has no database behind it.
4. Phones follow on their own. There is nothing to press on a handset and
   nothing to open — a phone that never opens the panel still gets the map,
   the dials and every stroke.
5. **`reset scene`**, the button under that line, throws the whole scene away
   — here, on every other screen, and in the store. It is the only thing that
   does; a reload does not.

**What a redeploy keeps.** The drawings come back grown, as they always did,
and the scene is restored from the store on load — the map, the dials and the
strokes, in the order they were made. Nobody presses anything. What a redeploy
does *not* keep is a scene made on a page that had no secret: it was shared
with the room and never written down.

## if the projection dies

This is the one that has actually happened. **It is now self-healing — you
should not have to do anything.**

When the world starts it publishes its session id as a *retained* message, so
every handset is told the moment it connects, including phones that were
asleep. A phone holding a drawing from the previous session re-publishes it
under the same id, and because `src/shape/` and `src/inflate/` are pure in
`(strokes, id)` the world rebuilds the **identical** creature. Within a few
seconds of the reload the population comes back on its own.

Give it ten seconds. If it has not come back:

1. **Press `shift+R`.** It restores this machine's own autosaved log
   (instant, offline, needs nobody) and broadcasts a recall to every handset,
   then prints on screen what it did — `restored 3 from this machine · recall
   sent to the phones`, or `nothing autosaved here to restore`. Shifted
   because the ghost panel binds plain `r` to its gizmo's rotate mode.
2. Still short? `shift+d` → `session` → **restore last session**. Same thing
   with a readout of how many came back.
3. Have people re-open the room link. A handset that reconnects heals itself.
4. Nothing worked, and the drawings matter? Send the room this link:
   `…/draw/?room=<code>&recover=1`. One tap re-publishes whatever drawing that
   handset has stored — ignoring the record's age and which room it was
   originally drawn into, because nobody remembers the old code. Have the
   projection open on that room first.

In a **public world** (`?world=`) there is a second self-heal that needs
nobody either: a handset whose drawing is missing from the store posts it
back, on the pad and again on the companion, and the world's poll picks it up
within twenty seconds (docs/PUBLIC.md §the handset heals the store).

Do **not** press *replay a session log*. A replay re-runs a session at the pace
it was recorded — on an hour-long log the world sits empty for an hour and
looks broken. *Restore* is the recovery button. (docs/SESSION.md §4a.)

## if you need the log afterwards

`shift+d` → `session` → **download session log**. It writes
`session-<epoch>.json`, which restores into any later build.

Last resort, if a session was lost with no log:
`node scripts/recover-from-chrome.mjs <chrome profile>/Local Storage/leveldb`
pulls the handset records straight out of Chrome's files. Quit Chrome first,
and do it the same day — Chrome compacts its log files and the records go with
them. This is a salvage tool, not a plan.

## what cannot be recovered

Nothing about a drawing ever reaches a server. There is no `fetch`, no `api/`
route, no database; the deploy is static files and the drawings travel
phone → mqtt broker → projection browser, at qos 0 with no retention. That is
deliberate — nothing leaves the room — and it means the only copies that exist
are the projection's log and the handsets' own records. Both are now kept
rather than deleted, which was not true before 2026-08-21.
