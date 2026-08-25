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

## one creature per person

Two halves, and neither is identity:

- **the handset** remembers its own submission in `localStorage`, which is
  what makes the pad refuse to open a second time;
- **the server** claims a marker per device id on write, atomically, so two
  taps racing from one phone cannot both win it.

A person who clears their site data can draw again. That is a courtesy
rail, not an access control, and it should not be described as one. Making
it real would mean accounts, and accounts would cost more than the problem.

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

**The gate fails closed.** With no secret set, or one shorter than eight
characters, every moderation request 404s — not 403, because an endpoint
that confirms it exists to an unauthorised caller has told them something.
A moderation endpoint that opens itself when misconfigured is worse than
one that never works.

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
