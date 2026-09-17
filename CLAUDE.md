# ref-world — agent notes

Shared isometric Three.js world. Phones draw characters; drawings become eggs; eggs hatch;
phones emote and track their character on a minimap.

## Before any visual or motion work

Read [`docs/TASTE.md`](docs/TASTE.md) — the arbitration between the briefs
([character](docs/taste/character.md), [world](docs/taste/world.md), and since 2026-09-15
[creature](docs/taste/creature.md), which supersedes the character brief for the creature —
TASTE §8) that conflict in seven places. **The arbitration wins over any brief.**

It tags every rule **[M]** measured (from a brief's tokens — not ours to negotiate) or
**[D]** derived (our decision, consistent with the briefs but not attributable to them).
Keep that discipline: the world brief explicitly says *"never invent a rule and attribute it
to this taste."* It also marks **`threeD` as not observed** — this is a 3D project whose
taste has no 3D evidence in it, so rendering choices follow the observed axes and are
otherwise ours to make and to label.

The traps, in order of how easily they get violated:

- **No overshoot, no bounce, no hard cuts, no abrupt stops** — all confidence 1.00. Every
  spring runs at damping ratio **ζ ≥ 1.0**; the solver clamps this at the API boundary so
  underdamped motion is unrepresentable. Entrances **slide**; never `scale: 0 → 1`, never a
  pop. Nothing fully arrests — an ambient drift floor runs under everything.
  ⚠️ This contradicts the vendored `apple-design` skill. The arbitration wins.
  ⚠️ But note **1823ms is confidence 0.06** — the constraints are certain, the number is a
  starting point to tune.
- **Near-black belongs to characters only.** Environment never goes below ~`#353534`. The
  measured palette has near-black at just 0.09 prevalence — it's rare by nature, and it's
  the character.
  ⚠️ **Standing user override (2026-09-15):** creatures are now COLOURED, per the creature
  brief ([docs/taste/creature.md](docs/taste/creature.md), TASTE §8) — one of six vivid hues
  read off the drawing (`src/character/palette.ts`), a stalk with the drawing as its topper,
  two eyes. The environment rule above is untouched: nothing environmental goes near-black
  or takes a hue. Don't "correct" the creatures back to `#080808`.
- **The ground is mid-toned grey (`groundLuma 0.74`), not cream or white.** There is **no
  pastel green or pink** in this taste; it is near-achromatic (`saturation 0.188`).
  ⚠️ **Standing user override:** the shipped `SURFACE.ground` is `#dfdfdf` (luma ~0.87) —
  lighter than the measured target — picked in the panel's color picker and exported as the
  default. `COLOR_METRICS.groundLuma` keeps the measured 0.74; the value-histogram gate
  measures against the configured paper and prints the drift. Don't "correct" it back.
- **The `valiocon` world renders in the ghibli cel style — a recorded user override, not a
  change to the taste.** Green meadow, warm sun, cool two-tone shadows, envpaint's ink on the
  contours; the achromatic palette and the six-luma quantize are the only two rules it
  relaxes, and the two palette gates report `n/a` there rather than a false failure. Every
  other world, the public one first, renders exactly as before. Documented in
  [`docs/TASTE.md`](docs/TASTE.md) §9; the code seams are `src/world/style.ts` and
  `src/world/toon.ts` (chain `onBeforeCompile`, never clobber it).
- **Grain is a full-frame post-process, never a material.** It must not vary across a
  character's fill or the silhouette stops reading as one solid shape.
- **UI is `icon` + `ruleLine` + `border` only.** No filled panels, no cards, no shadows under
  UI. That mark set is the world brief's #1 defining signal.
- **Shadows are hard-edged and flat-filled.** Single value, cut sharp, no penumbra, no PCF,
  no AO. Not Three.js default shadow mapping.
- **No rectilinear or engineered geometry.** The isometric grid governs *placement*, never
  *form*.
- **No uppercase type. Anywhere.** Room codes render `xkcd`, not `XKCD`.

## Architecture

[`docs/PLAN.md`](docs/PLAN.md) is the source of truth. Key invariants:

- **`src/shape/` and `src/inflate/` are pure and deterministic.** No Three.js, no DOM. Same
  strokes → identical mesh on every device. That determinism is load-bearing: it's why the
  phone can render the character locally instead of streaming video from the world. Don't
  introduce nondeterminism (unseeded random, time, float-order drift) into these.
- **The drawing is reproportioned, never replaced.** The `fidelity` dial controls how loosely
  the character interprets the drawing, but no code path generates a new shape.
- **No skeletal animation.** Characters are generated blobs deformed in a vertex shader from
  a few uniforms. No bones, no GLTF rigs.
- **Locomotion goes through the `Surface` interface**, never world-space Y. That seam is what
  lets the flat map become a sphere planet without a rewrite.
- **Durations come from motion tokens**, never literals.
- **Everything in `src/dev/` is gated on `isDev`** and must tree-shake out of the demo build.
- **Scene changes — landscape, terrain dials, paint — travel as session events** over the sync
  topic and into `refworld:<world>:scene`; apply through the replay driver, never a second path.
- **Physics runs only on the simulating page; every decision about what is stuck, loose or
  settled travels as a scene event.** `world.enablePhysics()` is called on host election and
  nowhere else — a viewer holds no rapier world and decides nothing (docs/PLAN.md §7.6).
  **And a HANDSET never loads rapier at all (2026-09-16)** — 760 kB compressed, paid by
  every phone testing alone in a room, because a phone alone on the link hosts. A phone host
  runs the game off the pure resolve and the scatter's own colliders instead and still
  decides everything; what it does not have is rolling stones and tumbling debris. So
  "does this page hold rigid bodies" and "is this page the authority" are now TWO questions
  (`rapierOwns` / `deciding` in `src/creatures/manager.ts`) — don't collapse them back into
  `bodies() !== null`. One flag reverses it: `PHONE_RUNS_RAPIER` in `src/world/device.ts`.
- **The katamari is a PER-WORLD GAME (user ruling, 2026-09-15). `worlds.json`
  `game: katamari` is the only switch; meridian and the public world are byte-identical and
  behaviourally unchanged by it.** The default branch builds every world's deployment at
  once, so nothing about the game may be unconditional. The seam copies `style`'s discipline
  — `src/world/game.ts`, `sanitizeGame` in `scripts/world-build.mjs`, a `<meta>` injected
  only when it is not `none`, read once in `src/main.ts`, default = the shipped behaviour.
  The flag gates: `WorldHandles.enablePhysics()` (rapier is never imported without it),
  `createLooseMeshes`/`createDebris` and the debris frame block, the replay driver's
  `stick`/`drop`/`loose`/`settle`/`crack`/`shatter` (not installed, so those scene events are
  ignored), the creature manager's `simulating()`, clumps, kinematic bodies, growth and all
  six `apply*`, the ball-diameter readout on the phone's world view (`src/ui/size.ts`,
  `CreatureManager.ballDiameter`), the handset's onboarding, loading and empty states
  (`src/ui/onboard.ts`, `loading.ts`, `empty.ts`), and **the island** — `setIslandMode` in
  `src/world/landscape.ts`, off by default, so the coast, the sea and the beach do not exist
  on any other world. Don't make any of it unconditional again. The creature LOOK is not
  part of this gate.
  **On a katamari world the props are the vendored object library** — the scatter's variants
  come from `src/world/katamari/` through a prop source, three junk kinds (`small`/`medium`/
  `large`) exist only there, and `public/katamari/` is personal-use material that ships to a
  katamari deployment and no other (docs/katamari-props.md). The catalog is **generated**:
  edit `katamari/rules.ts` and re-run `scripts/katamari-curate.mjs --all`, never
  `catalog.data.ts`. The game's characters are excluded there and stay excluded.
- **The geography is authored in `src/world/landscape.ts`** and is the single source every
  system samples — placement, colliders, water, minimap. Never re-derive a shoreline
  elsewhere, and the map does not ride the scatter seed. The ground has height: sample it
  through `src/world/surface.ts` only, never derive a height elsewhere. Locomotion never
  writes Y. **On the katamari world the map is an island; the sea is the complement of the
  authored coast** — everything outside `ISLAND_LOBES` is water, so nothing else needs to know
  where the edge of the world is (PLAN §7). It is behind `setIslandMode`, off by default: every
  other world's map is the one that shipped before the island landed.
  **The island is 1.1x the ORIGINAL diameter, and that is ONE number** — `MAP_SCALE` in
  `src/world/landscape.ts`, read through `mapScale()` and gated on `islandMode` like the
  coast itself. It has been 2 (2026-09-16, *"make the island twice as big"*), then 1.3 and
  then **1.1** on 2026-09-17 — two asks in one day, both *"too big"*, both read as linear
  (2 x 0.65, then x 0.85). The doubled map was too much ground for a room of 50-80 people.
  Every extent that has to cover the land rides it (the ground field and its three bakes, the
  base blade span, the scatter extent, the physics heightfield, the spawn disc, the minimap,
  the sea disc and the camera's depth range). A number scales when it says WHERE something is
  and not when it says HOW BIG a physical thing is: a beach, a pond, a shore ramp and the
  terrain noise are all unchanged.
  **It is NOT AN INTEGER, so every derived COUNT is rounded where it is derived** — the three
  outline vertex counts, `fieldSegments`, the three bake resolutions and the physics
  heightfield — and the thing held across the scale (a chord, a quad, a texel) is held to
  within half a count instead of exactly. The bakes round to a whole texel count rather than
  stepping to a power of two (141²/282²/563² over 440 u, every texel inside 0.1% of its
  authored size); NPOT is free on WebGL2 at CLAMP with no mipmaps. And 1.1 is not an exact
  binary float, so assert a scaled coordinate against `authored * MAP_SCALE`, never a
  spelled-out literal. **The riser run is a function of the scale** (`riserRun` in
  `src/world/field.ts`, `0.6 * terraceStep / steepestSlope`) off a table of MEASURED steepest
  slopes — 0.843 authored, 0.4570 at 1.1, 0.4814 at 2 — because verticals and noise
  wavelengths do not scale. Measure the slope and add the entry when the scale moves; the
  fallback `0.843/sqrt(scale)` only tightens the bound.
  **EXTENT is the same on every device; RESOLUTION is per tier.** The projection holds every
  texel and the 1.25 u ground quad it had. A HANDSET (`renderTier()` in
  `src/world/device.ts`, published once by `start`) trades four of them back, because four
  times the land at the same resolution is four times the CPU and it is a REBUILD cost every
  terrain dial and painted pond pays again — measured at `MAP_SCALE` 2: 906 ms → 3625 ms on
  one core, and 1944 ms with the trade: ground field 480 segments (1.67 u quad, still inside
  the 1.99 u riser run, height error 0.112 u), shore bake 512², region bake 128², physics
  heightfield 256. The HEIGHT bake is deliberately NOT traded — it is where every blade
  stands, so its error is geometry and not a soft edge. **The field's 480 is a CEILING and at
  1.1 it no longer binds**: the projection cuts 352, so `fieldSegments` takes the `min` — a
  phone never pays MORE than the projection for a map that got smaller. Don't delete it; it
  binds again above scale 1.5.
  **A body of water is what a change of scale breaks.** A pond's centre scales and the noise
  does not, so every body lands on different hummocks at every scale — at the 1.3 tried on
  the way to 1.1 one pond straddled a terrace riser and read as perched (0.517 against the
  0.6 basin-shoulder bound in `test/world/landscape.test.ts`). The fix is the pond's authored
  centre, never the bound. At 1.1 all four are healthy and nothing moved.
  Don't capture the exported layout (`ISLAND`, `ISLAND_LOBES`, `WATER_BODIES`, `FOREST_BLOBS`,
  `MOUNTAIN_BLOBS`) into a module-scope const — they are live bindings `setIslandMode`
  re-points, so read them after the flag is set. PLAN §7 has the full list.

## Running the room

[`docs/RUNBOOK.md`](docs/RUNBOOK.md) — one page, read before a demo. The part
worth knowing here: a refreshed projection **heals itself**. The world
announces its epoch retained, handsets re-publish their own drawing under the
same id, and the pure pipeline rebuilds the identical creatures. `shift+R` is
the manual path (local log first, then a recall) and it always reports on
screen what it did — shifted because the ghost panel owns plain `r`. Never reach for *replay* to
recover — that re-runs a session at its recorded pace; *restore* is the one
that applies the whole log at once (docs/SESSION.md §4a).

**Never delete a handset's stored drawing.** It is the only copy that survives
a projection restart, and two separate code paths used to destroy it on exactly
the event that made it precious. `test/session/recovery.test.ts` pins both gone.

## Taste gates

TASTE §7 defines eight verification gates (achromatic, value histogram, damping audit,
uppercase scan, stillness probe, density probe, mark-set lint, grain check). They ship as
Ghost Panel controls and build-time checks, not as review checklists — a constraint that
isn't a button doesn't survive a build. Keep them working.

## Skills

`.claude/skills/` is vendored — see its README for provenance. Two cautions:
`apple-design` recommends overshoot (forbidden here — see above), and
`threejs-aaa-graphics-builder` pushes photoreal art direction (use for render budgets and
LOD only).
