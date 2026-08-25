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
