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
- `t` toggles the camera tour. `d` opens the local draw overlay.
- `shift+d` is the ghost panel. It has the moderation list, the session
  readout, and the recovery buttons.

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

1. **Press `r`.** It restores this machine's own autosaved log (instant,
   offline, needs nobody) and broadcasts a recall to every handset.
2. Still short? `shift+d` → `session` → **restore last session**. Same thing
   with a readout of how many came back.
3. Have people re-open the room link. A handset that reconnects heals itself.

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
