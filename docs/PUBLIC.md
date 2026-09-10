# the public world

The installation world is ephemeral on purpose: drawings travel
phone → mqtt → projection and live in the browser showing them. That is
right for a room you can see and wrong for a link anyone can open — a
public world has to still be there when nobody is watching.

So a public world is the same world with one thing added: a server that
remembers. Nothing about generation moves there. `src/shape/` and
`src/inflate/` stay pure and stay on the client, so a creature is still
rebuilt from strokes on every device rather than served as geometry, and
the store holds strokes and nothing else.

## the two channels

| channel | carries | when |
|---|---|---|
| mqtt | the live drawing | instant, to whatever projection is open right now |
| the api | the durable drawing | forever, to whoever opens the link next |

**Both, not either.** mqtt is what makes an egg appear on the shared screen
within a second of the send. The api is what makes it still be there
tomorrow. A public draw page posts to both; the world reads the api on load
and then listens on mqtt, and re-asks the api every 20 seconds for anything
that arrived while it was closed or its socket was down.

That poll spawns **through the gate**, never through a restore. A restore
clears the world first, which would be a strange thing to do to a room
every twenty seconds.

## urls

```
https://<host>/?world=public              the projection
https://<host>/draw/?room=<code>&world=public   the phone
```

`world` is a name: lowercase letters, digits and hyphens, up to 24
characters. Anything else is stripped, and an empty one becomes `public`.
Two worlds never see each other's drawings, and a device that has drawn in
one may still draw in another.

Without `?world=` everything behaves exactly as the installation does —
ephemeral, no server, no persistence.

### a deployment of its own

A query string is a setting, not a place. A world you are handing to a
client is not `/?world=meridian` on the public site — it is **its own
deployment of this same repo**, at its own hostname:

```
https://ref-world-meridian.vercel.app/     a custom domain later
```

A world may also carry `"dev": true`. That deployment keeps the dev surface
(the ghost panel behind shift+d, and with it the painted terrain) that every
other build tree-shakes out — for a world that is its author's workbench as
well as a demo. Nothing about it is a runtime toggle: it is baked in with the
rest, so the public world and a client world without the flag are byte-for-byte
what they were. (A vercel *preview* — a branch alias, never a production url —
keeps the dev surface too, so a change can be looked at before it ships.)

The host in `worlds.json` has to be whatever the project's production url
actually is — the first domain on the project, which Vercel may set as a
team-suffixed hostname before the plain `ref-world-<name>.vercel.app` is
attached, and changes when it is. A host the map does not know resolves to
nothing and the build produces the public world instead, without a word; if
that happens, fix it with `node scripts/new-world.mjs <name> --clean --host
<that host>` (meridian did, 2026-09-09: the plain domain arrived and the
production build fell back to the public world until the map was updated).

One codebase, one store, many deployments. The client's link is an address,
the card it unfurls into carries their name rather than the public world's,
and the public site never lists them: two clients cannot find each other by
reading a url, and nothing about adding one changes what everyone else
sees.

**The map** is `worlds.json` at the repo root — one entry per deployment:

```json
{
  "worlds": {
    "meridian": {
      "host": "ref-world-meridian.vercel.app",
      "residents": "none",
      "hatch": "manual"
    }
  }
}
```

A deployment knows its own production hostname — Vercel sets
`VERCEL_PROJECT_PRODUCTION_URL` in every build, preview and production
alike — so the build looks itself up there and injects the world, its card
and how it starts into index.html. That has to happen at build time rather
than on load, because the card is read by crawlers that never run the app.

`residents` is the first setting:

| value | what it means |
|---|---|
| `shipped` (default) | the twenty-three recovered creatures are standing in the field on arrival |
| `none` | the world opens **empty** and fills only with what its own people draw |

The public world is `shipped` — those creatures are its exhibit, and an
empty field is a bad landing for a link anyone can open. A client's world is
`none`: somebody else's creatures there are not a welcome, they are clutter
with no story attached, and the client watching their own first drawing
arrive into an empty field is the whole proposition. Anything but the exact
word `none` means `shipped`, on both sides of the build, so a typo can never
empty a world.

`hatch` is the second — **who opens the eggs**:

| value | what it means |
|---|---|
| `timer` (default) | an egg opens by itself seven seconds in |
| `manual` | nothing hatches until somebody presses `h` on the projection |

`timer` is right for a link anyone can open: nobody is standing in front of
it, there is no operator and nobody to wait for, and an egg that never
hatches is a person who drew something and got nothing back. `manual` is a
world with somebody in front of it — the demo (user ask, 2026-09-10: *"in
the demo let's pause the hatching until I press h on the keyboard"*). The
eggs stand, the room fills up, and the whole clutch opens on one press.

Because every phone's "view world" is **this same page**, that press has to
travel. It does: the hatch goes out on the world sync topic, from the page
that is simulating and from nowhere else, and every other screen plays the
same shell sequence (docs/SESSION.md §6). A screen that joined after a
hatch — or blinked while it went past — catches up from the roster, which
now carries the ids still standing as eggs. And a handset in a manual world
is told there is no clock, so its egg shows no countdown rather than one
that runs out with nothing at the end of it.

Anything but the exact word `manual` means `timer`, the opposite direction
from `residents` and for the same reason: the failure worth preventing is
the silent one, and a world stuck full of eggs with nobody in the room to
press anything looks broken and says nothing.

`hatch` can also be set on the address, for a preview or a rehearsal without
a deploy:

```
https://<host>/?hatch=manual     pause a timer world's hatching
https://<host>/?hatch=timer      hand a manual world's eggs back to the clock
```

It is read once, beside the world's name, and only these two words count —
so `?hatch=timer` really can undo the baked tag, which a one-word override
could not.

The public deployment is simply **absent from the map**. It resolves to
nothing, and its html comes out byte-identical to the file on disk; a test
pins exactly that.

Look at one locally before there is anything to deploy:

```bash
VITE_WORLD=meridian npm run dev
```

**Adding a client:**

```bash
node scripts/new-world.mjs meridian --clean    # writes the worlds.json entry
```

then the parts that are a dashboard rather than a file — the script prints
them too:

1. make a Vercel project named `ref-world-meridian`, linked to the same
   repo (`epun/ref-world-demo`) — the dashboard, or `vercel link`. Its
   production url has to be the hostname in the map.
2. connect the **same** KV store integration to it and set
   `MODERATOR_SECRET` in its environment. One store, many deployments;
   worlds partition it, so one client cannot see another's drawings.
3. deploy.
4. seed it (below) — unless it is `--clean`, which is the point of `--clean`.

`/?world=meridian` on the public site still reaches the identical world —
same derived room, same store partition, same drawings — if anyone types
it. It is not advertised anywhere and nothing links to it, but it was never
broken and breaking it would strand any link already sent. One difference,
and it is cosmetic: the public page carries no `residents` tag, so that
route lays the public exhibit on top of the client's world for that viewer
only. Nothing is written; the deployment's own link is still empty.

## one creature per person

Two halves, and neither is identity:

- **the handset** remembers its own submission in `localStorage`, which is
  what makes the pad refuse to open a second time;
- **the server** claims a marker per device id on write, atomically, so two
  taps racing from one phone cannot both win it.

A person who clears their site data can draw again. That is a courtesy
rail, not an access control, and it should not be described as one. Making
it real would mean accounts, and accounts would cost more than the problem.

### the handset heals the store

Those two halves can disagree, and in a named world nothing repairs it on
its own: the world's epoch is `w-<world>` forever, so a handset's record
never goes stale, so the pad refuses a second drawing and the companion
restores a creature the store has never had — *"it shows in the mobile view,
but it does not load in the map view"* (user report, 2026-09-09). A drawing
sent before the kv integration was connected (503), or whose durable POST
was cancelled by the hand-off navigation, is missing from the world forever
while the phone that made it still shows it.

So the handset offers it back. On the pad's already-drew path and again on
the companion, a named world is asked for its log; only if that log is
readable **and does not carry this handset's id** is the same drawing
posted again — same id, same wire strokes, the ordinary endpoint, the
ordinary screen, the ordinary device claim. The world's poll is additive, so
it arrives on the next tick.

Every other answer means leave everything alone: an unreachable or
unreadable store is **not** a store that lost the drawing, and `409` is the
store saying it already has this device under a record of its own —
including one a moderator has refused, which a re-post must never undo. The
local record is never deleted and the pad is never freed by a failure. It is
silent end to end; a database being tidied is not news for the person
holding the phone.

`src/phone/heal.ts` is the rule; `public/draw/index.html` carries the same
one written out again, because a page in `public/` imports nothing. Keep the
two in step — `test/phone/heal.test.ts` pins both.

## moderation

The automatic screen (`src/moderation/screen.ts`) runs **on the server as
well as the handset**. The draw page screens locally so a refusal is
instant and private; a public link cannot trust a client it does not
control, so the same pure function runs again where the submitter cannot
reach it. Same function, so the two never disagree about a drawing — only
about who is asking.

Three dispositions, exactly as in the room:

- `admitted` — in the world;
- `held` — stored, not shown, waiting on a person;
- `refused` — stored, never shown.

A held drawing is stored rather than dropped, and **the drawer is told
nothing**: TASTE's rule that the shared screen never rewards the attempt
applies to api responses too. Both `admitted` and `held` come back as
`accepted`.

### being the moderator

Set `MODERATOR_SECRET` in the Vercel project (32+ random characters), then:

```bash
# everything in the world, with the screen's reason and no stroke payloads
curl -H "x-moderator: $MODERATOR_SECRET" \
  'https://<host>/api/moderate?world=public'

# admit something that was held, or remove something that is standing
curl -X POST -H "x-moderator: $MODERATOR_SECRET" -H 'content-type: application/json' \
  -d '{"id":"<drawer-id>","disposition":"admitted"}' \
  'https://<host>/api/moderate?world=public'
```

`disposition` is `admitted`, `held` or `refused`, and a removal takes
effect on every projection within one poll.

### starting the world over

A rehearsal leaves trial creatures in the store, and **refusing them one by
one is not a reset**. A refusal releases the device slot, and every handset
that drew still holds its own drawing and heals it straight back in on its
next visit (§the handset heals the store) — by design, and the one copy of a
drawing that survives anything is never ours to delete.

So the world steps forward instead:

```bash
curl -X POST -H "x-moderator: $MOD" -H 'content-type: application/json' \
  "$BASE/api/moderate?world=meridian" -d '{"reset":true}'
```

It deletes the drawings, every device claim those drawings hold (found by
reading the drawings, never by scanning the keyspace), and the scene — a
reset world that opened onto last night's hills would be half a clean start —
and it counts `generation` up. The answer is `{"world","generation","cleared"}`.

**The generation is what the handsets read.** A public world's epoch is
`w-<world>-g<generation>`, announced retained to every phone in the room. A
handset compares the generation its drawing was admitted under against the
one the world is announcing now, and when the world's is newer it *steps
down*: it does not heal, it does not re-publish, it keeps the drawing bytes
(the keepsake still works from them), and it goes back to the pad with one
lowercase line — `the world started over — draw again`. An epoch with no
`-g` suffix, and a record with no epoch at all, are both generation 0, so
every drawing that exists today keeps working unchanged.

The projection reads its generation on the first pull of `/api/drawings` and
announces nothing until it has: an epoch announced before the number was
known would be an epoch the page then had to take back, which is every phone
in the room told the world changed, twice, at boot.

`shift+d` → `scene` → **`reset world`** is the same call from the panel. It
asks twice — one tap arms it and says `tap again to reset the world`, and the
arming lapses after one `MOTION.primaryMs` — then reloads, because the page
that asked is also a page full of creatures that no longer exist. **Any other
screen open on the world needs a reload too**; its readout says so when it
notices the generation move.

**The gate fails closed.** With no secret set, or one shorter than eight
characters, every moderation request 404s — not 403, because an endpoint
that confirms it exists to an unauthorised caller has told them something.
A moderation endpoint that opens itself when misconfigured is worse than
one that never works.

## the scene

The drawings survive a redeploy. Until 2026-09-09 the **world they stand in**
did not: the landscape switch, the three terrain dials and every dab of the
terrain brush lived in the page that made them, so a new build opened onto the
flat plain the world ships as, under a population that came back grown. And a
phone looking at the world — which is this same page, running its own copy of
it — saw that plain while the projection had hills.

So a world keeps its **scene** too: `refworld:<world>:scene`, a list of the
same session events the log already records, applied on every page through the
same replay driver (docs/SESSION.md §6).

```
GET  /api/scene?world=<name>
```

No auth, `cache-control: no-store`, and that is deliberate: the scene is what
everyone standing in the world is already looking at, and a phone has to be
able to read it before it can draw the ground under its creature. Refusing it
would only produce a room where the projection has hills and the handsets do
not.

```jsonc
{ "world": "meridian", "store": "live", "count": 412, "events": [ /* … */ ] }
```

`store` is `live` or `none`, the same honest signal `/api/drawings` gives: a
world with no database behind it reads empty either way, and the difference is
worth saying rather than looking like a quiet night.

```bash
# append changes
curl -X POST -H "x-moderator: $MODERATOR_SECRET" -H 'content-type: application/json' \
  -d '{"events":[{"k":"world","t":0,"field":"landscape","value":1}]}' \
  'https://<host>/api/scene?world=meridian'

# throw the whole scene away
curl -X POST -H "x-moderator: $MODERATOR_SECRET" -H 'content-type: application/json' \
  -d '{"reset":true}' 'https://<host>/api/scene?world=meridian'
```

Writing is the **moderator's**, gated on the same shared secret as
`/api/moderate` and **404 without it**, for the same reason: an endpoint that
confirms it exists to an unauthorised caller has told them something. Writing
here re-shapes the world for everybody, which is exactly the operator's job
and nobody else's. `503` with no store; `400` when nothing in the batch reads;
`413` past 500 events in one write.

Every event goes through `readSceneEvent` on the way in and on the way out
(`src/session/scene.ts`), which **clamps** — a stored scene cannot hand a
world a brush the size of the map, whatever wrote it.

### `?mod=` on the projection

The page that is doing the sculpting needs that secret. A projection has no
login and nowhere to type, so it arrives in the address:

```
https://<host>/?host=1&mod=<MODERATOR_SECRET>
```

…and leaves again immediately. It is stored under `refworld:moderator` on that
device, stripped out of the url with `history.replaceState`, and **never
printed** — not in a readout, not in an error, not in the panel's `scene`
line, which says only whether writing worked. The url on the projection is the
one people photograph off the wall and the one an operator copies to send
round; a share link carrying the secret would hand the room's whole world to
whoever read it over somebody's shoulder.

A page with no secret still sculpts, still broadcasts, and still reads the
stored scene. It simply does not keep what it makes, and the panel says so:
`scene · 412 events · not stored (no secret)`.

## the switches

Two things an operator changes without a deploy, both on `/api/moderate`:

| switch | default | what it does |
|---|---|---|
| `closed` | `false` | stops NEW drawings. The world stays viewable and nothing already standing disappears. This is both the panic button and the event switch — open for the room, closed when the event ends. |
| `ipPerHour` | `0` (off) | submissions per address per hour. |

**Rate limiting is off by default, on purpose** (user ruling, 2026-08-25:
*"i don't think we should limit the open one"*). An address is a bad proxy
for a person here: a conference is one NAT, so the limit that would protect
a public link is the same limit that would lock out the event this was
built for. The lever exists because the cost of being wrong is one bad
night — turn it on the moment one person is filling a world.

```bash
curl -X POST -H "x-moderator: $MODERATOR_SECRET" -H 'content-type: application/json' \
  -d '{"closed":true}' 'https://<host>/api/moderate?world=public'
```

Rate limiting fails OPEN — a store that cannot count must not become a
store that refuses everyone. Moderation fails closed. Those are opposite on
purpose.

## /moderate — the phone view

`https://<host>/moderate/` is the moderator's own screen: the held queue
with each drawing rendered **as it was drawn**, admit and refuse under each
one, the counts, and the open/close switch. Paste the secret once and it is
remembered on that device only.

It renders the ink rather than the creature deliberately. The pipeline
turns a drawing into a silhouette, and a silhouette hides exactly the
detail a moderator is being asked to judge.

## seeding a world

An empty field is a bad invitation — the first person to arrive has nothing
to join. `scripts/seed-world.mjs` puts an existing population in:

```bash
node scripts/seed-world.mjs https://<host> public
```

It posts through the ordinary submission endpoint: same screen, same
dispositions, same device claims. No privileged path, because a seed that
could bypass the gate would be a hole in the gate shaped like a script.
Idempotent — a second run reports every drawing as already there.

A world on a deployment of its own is seeded exactly the same way — the
deployment is an address, not a second store — but point it at that
deployment's host so the write and the read are the same place:

```bash
node scripts/seed-world.mjs https://ref-world-meridian.vercel.app meridian
```

`scripts/new-world.mjs` prints that line with the name already in it.

## setting it up

The code ships working; the store does not exist until you make it. Until
then `?world=` reads empty and posts 503, and everything without `?world=`
is untouched.

1. **Vercel dashboard → Storage → create a KV / Upstash Redis store**, and
   connect it to this project. The integration adds `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_*` pair) to the
   project's environment on its own — nothing to copy by hand. Both
   namings are read, so either integration works.
2. **Add `MODERATOR_SECRET`** to the same environment. 32+ random
   characters; it is the only thing standing between the public and the
   moderation endpoint.
3. Redeploy.

Check it: `GET /api/drawings?world=public` should return a
`refworld.session` log with an empty `events` array. If it returns one with
no store configured it returns empty too — the difference is that a POST
answers 503 rather than 201, which is the honest signal that nothing is
being kept.

## verifying

- `test/api/store.test.ts` — the pure parts, in the normal suite: the
  moderator gate failing closed, world-id sanitising, the no-store
  fallback.
- `scripts/api-smoke/` — the handlers against a real round trip, using a
  minimal Upstash-compatible stand-in so nothing needs provisioning. It
  covers what only exists at the seam: one creature per device, worlds not
  leaking, the gate invisible without the secret, and a refused drawing
  actually leaving the world the projection reads.
