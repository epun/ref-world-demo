# katamari props

82 object models from *Katamari Damacy*, curated for the `valiocon` world.

- `models/*.glb` — binary glTF, metres, y-up, one small baked texture per
  material, ps2 nearest-or-linear filtering and alpha modes preserved.
- `catalog.json` — what `src/world/katamari/models.ts` loads: one row per model
  with the world kind it stands in for, its tier, its height in world units and
  whether it belongs on the beach. Written by `scripts/katamari-curate.mjs`
  from the hand-written table in `src/world/katamari/catalog.ts`; it is a pure
  function of that table and carries no timestamp, so re-running the script
  changes nothing.

## provenance

These files are a **personal-use extraction** from a retail ntsc-u playstation 2
copy of *Katamari Damacy* (`SLUS-21008`). The assets remain the property of
their rights holders — Namco. Nothing here is original work of this repo, and
nothing here is licensed for redistribution.

`valiocon` is a **private demo world**. It is its own vercel deployment behind
its own hostname (`worlds.json`), the katamari game is gated per world
(`src/world/game.ts`), and these models are loaded only on a world whose entry
asks for that game. They do not reach the public deployment and must not be
added to it.

The curated subset is here rather than the whole library: 82 of 1,703 models,
~1.4 mb rather than ~35 mb. The full library is not in this repo and should not
be committed to it — `scripts/katamari-curate.mjs --source <dir>` re-derives
this folder from a local copy of it.

See `docs/katamari-props.md` for the look, the tiers and the wiring.
