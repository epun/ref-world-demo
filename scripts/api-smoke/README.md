# api smoke test

Drives the real handlers in `api/` against a real network round trip, using
a minimal Upstash-REST-compatible stand-in so nothing has to be provisioned
to run it.

```bash
node scripts/api-smoke/fake-redis.mjs &     # listens on 6390
npx tsx scripts/api-smoke/smoke.mjs
```

It covers the rules that only exist at this seam and cannot be unit-tested
out of it: one creature per device, worlds not leaking into each other, the
moderator gate being invisible without the secret, and a refused drawing
actually leaving the world the projection reads.

`test/api/store.test.ts` covers the pure parts (the gate failing closed,
world-id sanitising, the no-store fallback) and runs in the normal suite.
This one needs a listening socket, so it stays a script.


## is the LIVE world's store connected?

The test above proves the handlers are correct against a stand-in. This is a
different question — does the *deployment* have anywhere to write — and it
is the one that decides whether a drawing made on a phone still exists
tomorrow.

```bash
node scripts/api-smoke/live.mjs https://ref-world-demo.vercel.app
MODERATOR_SECRET=... node scripts/api-smoke/live.mjs https://ref-world-demo.vercel.app
```

It reads the world, writes one probe drawing, reads it back, checks a second
drawing from the same device is refused, and — given the secret — checks the
moderation gate and then refuses the probe so the world is left as it was
found. Without the secret it says plainly that the probe is still there
rather than pretending it cleaned up.

**Run it from a machine that can reach the deployment.** Anything that is
not json is reported as what it actually is; a proxy or a login wall
answering 200 with html is the usual cause and is not a fault in the api.

### the state it is checking for

`GET /api/drawings` reports `config.store` — `live` or `none`. Without a
store the api answers 200 with an empty list and refuses POSTs with 503, so
from the outside a world nobody has drawn in and a world that CANNOT be
drawn in look identical. That is the difference between a quiet night and
every drawing since Tuesday being dropped, and it should not take a POST to
tell them apart.
