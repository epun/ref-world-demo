# katamari props — the library, the look, and the wiring plan

User ask, 2026-09-15:

> For the buildings and the objects, I want to update them from the existing
> trees and buildings that we have in this old style and replace them with the
> objects from the Katamari library. Except I want them in a Ghibli-style toon
> shader that feels hand-painted but also very Japanese anime.

And the earlier brief: the world is a katamari — small props (cups, plants,
chairs, toys, lamps), medium (vending machines, benches, doors, signs, bikes),
large (cars, trees, kiosks, walls) and buildings that collapse in stages, on a
tropical island (ghibli meets scavengers reign).

This document is what landed. The library arrived first (2026-09-15) and was
**wired into the world on 2026-09-16**: on a katamari world the scatter draws
these models and nothing else, they break into their own parts, and the pickup
rules read them per model. §a–§e were the hand-off plan and are kept below as
the record of the shape; §f is what actually landed against each of them, with
the decisions that were open at the time now closed.

## what landed

| file | what it is |
| --- | --- |
| `src/world/katamari/rules.ts` | the CURATION RULES (2026-09-16): what is excluded, how a name picks a kind, how metres become units, the height bands, how many variants of each kind ship. Hand-written and documented — this is the file to review |
| `src/world/katamari/catalog.data.ts` | the ROWS, **generated** from the library's `manifest.json` and those rules by `--all`. 326 of them: the active set |
| `src/world/katamari/catalog.ts` | the seam that joins the two, plus the lookups (`katamariVariantsOf`, `katamariKinds`). Until 2026-09-16 this was 82 rows written out by hand |
| `scripts/katamari-curate.mjs` | node, plus `@gltf-transform` for the compression pass (lazily, so `--verify` needs nothing). reads the library's `manifest.json` + the table, copies the chosen glbs into `public/katamari/models/`, writes `public/katamari/catalog.json`, prints the table and the budgets |
| `src/world/katamari/models.ts` | `loadKatamariModels(baseUrl)` → a `KatamariLibrary`: per model, one normalised geometry, its radius, its texture, its alpha mode and a list of breakable `parts` |
| `src/world/katamari/material.ts` | `createKatamariMaterial` / `createKatamariMaterialSet` — the posterised cel look |
| `public/katamari/` | the curated glbs, the catalog, and the provenance note |
| `test/world/katamari/` | table integrity, normalisation, part splitting, the material's glsl, one real glb through `GLTFLoader`, and the script's idempotency |

**Curation (2026-09-16, auto):** 1,703 exported → **1,510 admitted** (208
excluded: 46 characters, 15 `no_model`, 91 map-sized pieces, 56 with no
measurable box) → **326 active variants**, 43,766 triangles, 6.13 mb copied
(budgets: 300k triangles, 7 mb). Re-derive with

```
node scripts/katamari-curate.mjs --all --source <unpacked-library-dir>   # measure, classify, compress, publish
node scripts/katamari-curate.mjs --catalog     # rewrite catalog.json from the table, no library
node scripts/katamari-curate.mjs --verify      # no library needed; what the tests run
```

**Compression (2026-09-16, the slow-network work — docs/PLAN.md §7.1 "slow network").**
`--all` now COMPRESSES every glb on the way into `public/katamari/models/`, because the
library was 4.06 mb over the wire and 25 s of a 1.5 Mbit link. Four passes, through
`@gltf-transform` (four dev dependencies, imported lazily so `--verify` and `--catalog`
still run with nothing installed) — and **all four are lossless**:

| | what it is for |
| --- | --- |
| `dedup` | the extraction writes a mesh's accessors per primitive, so a multipart prop repeats its material and sampler rows |
| `prune` | nodes, accessors and samplers nothing references — loudest for the TANGENT and second uv left on models whose material reads neither |
| `weld` | the geometry arrives as a flat triangle soup; welding merges BITWISE IDENTICAL vertices back under an index, and it is most of the saving before anything is compressed |
| `reorder` + `EXT_meshopt_compression` | meshopt's vertex-cache order (a shuffle, nothing else) and then an entropy coder over the buffer views, decoded at load by three's `MeshoptDecoder` (~30 kb, imported statically in `models.ts` and therefore only on a katamari world) |

Measured over the 182-model active set: **3.82 mb → 2.93 mb (−23.4%)**, and **10 of the 182
were published UNCOMPRESSED** because the meshopt per-view header costs more than it saves
on a 7 kb spatula — the script publishes whichever is fewer bytes and says how many went
each way, and the loader reads either (the decoder is set unconditionally and an
uncompressed glb never asks for it). Still deterministic and still idempotent: a second
`--all` copies nothing and `--verify` exits 0.

**Proved lossless, not asserted.** `scratch/props-compare.mjs` loads every model in the
active set twice through the real `GLTFLoader` and the app's own `buildKatamariModel` —
once from the library as extracted, once as published — and compares them by a one-sided
Hausdorff distance, so the reordering does not count as a difference:

```
npx tsx scratch/props-compare.mjs --source <library-dir> --geometry-only
  → 182 models compared
    worst position deviation  0 u = 0 screen px
    worst normal deviation    0.0000°
    worst uv deviation        0 = 0 texels of a 32-px map
    triangle-count mismatches 0
```

**Quantisation was measured and NOT taken** (user ruling, 2026-09-16: *"I don't want to
compromise on quality"*). `@gltf-transform`'s `meshopt()` wrapper quantises by default and
its own defaults are not good enough to promise anything (normals at 10 bits); at 16 bits
of position, 12 of normal and 16 of uv the library came to 2.35 mb — another 0.58 mb — at a
worst position deviation of 5.3e-4 u, which is 0.011 of a screen pixel at the camera's
scale. Nobody could see that. What decided against it was the rest of the measurement: the
quantised set showed normal and uv outliers on two models (a fish statue, a palm tree) that
the lossless set does not, and an unexplained outlier is not a thing to ship under that
ruling. The bits to use, if somebody wants that 0.58 mb and can account for those two, are
in the note above `compressGlb`.

⚠️ **The harness found a real bug, which is why it is committed.**
`conformKatamariGeometry` read attribute arrays directly (`Float32Array.from(attr.array)`),
which is wrong for any attribute that is not already float: a quantised model stores uv as
normalised unsigned shorts, so 1.0 arrives as 65535 and every one of those models would
have drawn the wrong texel. Position survived it by accident — the factor is uniform and
the prop is rescaled to its catalog height anyway. It de-normalises through the accessor
now (`floatsOf`), so the door is open either way.

**The textures are the bulk now and are left exactly as extracted** — not re-encoded, not
resized. 1.29 mb of the 2.93 — 44%. They are 32-px PS2 textures sampled at `NearestFilter`
and then posterised by the cel material (`material.ts`), so webp or basisu would move bytes
the shader quantises anyway, at the cost of a decoder the page does not otherwise carry.
The script reports the number every run; the decision is a person's.

**Every published row carries a content hash** (`KatamariEntry.hash`, eight hex of sha256
over the published bytes), which the loader appends as `?v=<hash>` (`modelUrl`). That is
what makes the one-year `immutable` cache in `vercel.json` safe: the filename stays the
library's own, because it is the provenance trail, and the CACHE KEY moves when the bytes
do. `--verify` checks the hash against the file on disk, so a table and a directory that
have drifted apart cannot be published. Consequence: **`--source` without `--all` is gone**
— it copied the files a hand-written table named and cannot write the hash back into
`catalog.data.ts`, so it could only ever publish a library `--verify` would reject.

**Nothing is loaded conditionally.** Every page loads every model (2026-09-16 user ruling:
*"load everything, just in the deferred order"*). The slow-link levers are WHEN — the
library starts after the first composed frame and after this page's own creature is
standing (`WorldOptions.libraryAfter`) — and caching. A per-connection content cut was
built and then reverted: a placement with no variant draws nothing AND carries no collider,
so a page that had skipped a tier would let a creature walk through a building another page
can see. See PLAN §7.1.

The first pass was 82 rows written out by hand with an eyeballed height on
each. `--all` measures instead: it reads every glb's own json chunk for the
POSITION accessors' min/max, composes the node transforms, and gets the real
box in metres — then one `WORLD_SCALE` (0.94, which puts a 1.7 m adult at the
1.6 units the hand-curated car already sat at) turns that into a height, the
tier bands turn it into `small`/`medium`/`large`/`building`, and the name
rules pull the tree family, the stones and the shops back into the kinds they
replace. Deterministic: same library + same rules → same bytes, and
`--verify` after a run exits 0.

**Provenance:** the library is a personal-use extraction from a retail ntsc-u
ps2 copy of *Katamari Damacy* (`SLUS-21008`); the assets remain Namco's.
`valiocon` is a private demo world, the katamari is gated per world
(`src/world/game.ts`), and these models are loaded on that world only. Also
stated in `public/katamari/README.md`.

## the look

`createKatamariMaterial(texture, opts)` is a `ShaderMaterial` assembled from
chunks that already exist:

- **albedo** is the model's baked texture at `NearestFilter`, as extracted,
  then **posterised** — each channel quantised to `uLevels` flat steps (5
  **[D]**) and nudged warm toward `GHIBLI.sun`. This is the whole point of the
  file. A 32-px ps2 texture sampled at nearest reads as *pixels*, and pixels
  are the one thing this taste has no room for; quantised, what survives is the
  texture's **shape** — the windows, the door, the fish painted on the gable —
  as a handful of flat poster colours, which is how a cel background paints a
  building. The quantise happens in the painted (srgb) space and the result is
  decoded by hand, because a raw `ShaderMaterial` gets no decode from three.
- **lighting** is `toonLight(albedo, n, 1.0, 3.0)` from `src/world/toon.ts` —
  the same call every module under `src/world/ghibli/` makes. Two flat tones, a
  cool hue-shifted shade, a painted terminator, a hard sun-coloured rim.
  `shadow` is a constant 1.0 (the flat stamps are the cast shadows, TASTE §2.4)
  and there is no grain (grain is a full-frame post-process, TASTE §2.7).
- **a hard warm dab** where a facet points straight at the sun —
  `step(0.82, dot(n, uSunDir))`, envpaint's tree-highlight rule, mirrored from
  `src/world/ghibli/trees.ts` and applied to built things too.
- **alpha**: `mask` → `alphaTest 0.5` and a `discard` in the shader, `blend` →
  transparent with `depthWrite` off, `opaque` → neither. Back-face culling
  follows the game's own flag.
- **instancing**: `aVariation` through `ggVariation` (imported from
  `src/world/ghibli/shared.ts`, not copied a third time) so a row of the same
  model is not a row of identical stamps, plus a drift floor so nothing fully
  arrests (TASTE §2.1). The drift reads its height fraction off the material's
  `uHeight` rather than the scatter's `aWindHeight` attribute, which rigid
  kinds deliberately never get — so the material drops onto ANY variant's
  `InstancedMesh` with no attribute baking.
- **outlines**: nothing to do. `src/world/ink.ts` draws the contour off the
  normal/depth targets.

`toonUniforms` are shared **by reference**, so the ghost panel's style select
and the per-frame sun write reach these materials with no recompile. The four
wind uniforms are the scatter's own names, so `setWindOnMaterial`
(`src/world/ghibli/shared.ts`) writes them unchanged.

## the tiers

`kind` in the table is either an existing `PropKind` the model **replaces** or
one of three **new** kinds:

| kind | tier | what is in it | rooted |
| --- | --- | --- | --- |
| `small` | `small` | mug, cassette tape, spatula, peeler, thumbtack, shortcake, hamburger, pizza, onigiri, cans, milk carton, persimmon, brick, ant, and on the sand: ammonite, striped fish, bonito | no |
| `medium` | `medium` | vending machine, bench, folding chair, mailbox, telephone, trash can, bicycle, delivery bike, lanterns, ramen sign, teahouse banner, shop curtain, matsuri tent, pedestrian signal, weathercock, compass, and on the sand: parasol, boat, lifeguard chair | mixed |
| `large` | `large` | japanese car, froggy car, steamroller, ox, park entrance, lamp post, telephone pole, wall, and on the sand: fishing boat, sailboat | mixed |

Replacement kinds and what now stands in for them (**eleven**, since
`mountain` left the set on 2026-09-16 — see §f): `tree` → the game's four
trees; `conifer` → the xmas tree and the two giant trees; `bush` → garden and
strawberry plants; `rock` → the four rocks; `stump` → tree stump; `cactus` →
giant daruma (the library has no cactus; same silhouette slot **[D]**);
`monolith` → the oni rock and a fish statue; `building` → the harbour town's fish-named blocks plus car
wash, factory, bookstore, ryokan, boathouse; `palm` → palm tree;
`picnicTable` → street stall; `waterTower` → propane tank and weather station.

`beach: true` marks the sand set: parasols, boats, shells and fish, the
boathouse, the palm, the two outcrops. A row that belongs in BOTH places
carries `inland: true` beside it (2026-09-16): the three smaller stones, the
brick and the shells — a beach wants shingle on it and the same stone belongs
in a field.

## a. `src/world/props.ts` — the extension seam

`buildPropGeometries(): Map<PropKind, PropVariant[]>` is the seam, and it wants
no new construction path. A `KatamariModel` already **is** a `PropVariant`
(`geometry`, `height`, `radius`, normalised by `variantTransform` — the same
rule `normalizeVariant` applies, imported rather than copied):

```ts
// katamari worlds only
const library = await loadKatamariModels();
const geometries = buildPropGeometries();          // the authored props, unchanged
for (const [kind, models] of library.byKind) {
  if (isKatamariNewKind(kind)) continue;           // handled below
  geometries.set(kind, models);                    // REPLACE the variants
}
```

Two consequences to keep straight:

1. **variant counts move.** `PROP_VARIANT_COUNTS` is what the scatter's pure
   placement math rolls against, and a kind with four authored variants may
   come back with two library ones. The katamari path has to publish its own
   counts (a `variantCountsFor(library)` beside `PROP_VARIANT_COUNTS`) rather
   than letting the two disagree — a roll of 3 against a two-entry array is the
   bug this note exists to prevent. `test/world/scatter-seed.test.ts` is the
   place to pin it.
2. **the new kinds are new `PropKind`s**, so `PROP_KINDS` grows on a katamari
   world. They are pure library kinds: no strokes, no arch builder, and
   `buildInflatedVariant` must never be asked for one. Adding them to
   `PROP_KINDS` means `STICKY` (§d) and the scatter's seed tables (§b) must
   grow with them, which typescript will insist on for the `Record<PropKind, …>`
   tables and will NOT insist on for the partial ones.

## b. `src/world/scatter.ts` — material and placement

- **`materialFor(kind)`** today returns one of a handful of shared
  `MeshStandardMaterial`s. A library-backed variant needs a material **per
  variant**, because each model has its own texture — which the scatter is
  already shaped for: it builds one `InstancedMesh` per variant
  (`new InstancedMesh(variants[v].geometry, material, …)`), so the change is to
  choose the material with the variant index in hand rather than the kind
  alone. `createKatamariMaterialSet(library).materialFor(model)` is that
  lookup, and it shares one material across models with the same texture, alpha
  mode and culling. `materialFor(kind)`'s other caller, `src/world/loose.ts`,
  draws a fallen prop non-instanced off the SAME material object — which works
  unchanged, since the vertex stage has a non-instanced branch.
- **placement.** The new kinds want their own seeds in the region tables:
  `SEED_PROB` for the plain, `FOREST_SEED` / `MOUNTAIN_SEED` where it makes
  sense, `ISLAND_SEED`, and `BEACH_SEED` for the rows marked `beach: true`.
  The junk tiers should be COMMON on the plain and near the town and sparse in
  the forest — a katamari town is dense with small things — and the sand set
  belongs in `BEACH_SEED` only. Note the existing comment on `BEACH_SEED`:
  nothing built and nothing forested reaches the beach, so `boathouse` and the
  boats need `building` / `large` to be admitted there deliberately, or their
  own kind. The cleanest version of that is to key the beach set off the
  catalog's `beach` flag and give the beach its own variant subset of the same
  kind, rather than a second kind.
- **wind.** The material takes the scatter's four uniform names; call
  `setWindOnMaterial(material, scatter.windField(), t)` over
  `materialSet.materials()` once a frame, the way the ghibli materials are
  already driven.

## c. `src/world/chunks.ts` — destruction

`KatamariPart` is `Chunk` by another name — `{ geometry, offset, radius, stage }`,
in the whole prop's object space at scale 1, re-centred on its own origin. So
the chunk map for a katamari world is

```ts
chunks.set(kind, library.byKind.get(kind)!.map((m) => m.parts));
```

Two routes produced those parts, matching two of that file's three:

- a **multipart** glb (a car's body/wheels/glass, a signal's three lamps) hands
  back one part per mesh, staged top-down — route 1, "the parts ARE the
  chunks";
- a **single-mesh** glb is cut by wobbled height planes — route 3. `building`
  and `mountain` get three bands (their `STICKY` rows carry `stages`),
  everything else two: crown then trunk. `cutByHeightPlane` is COPIED from
  `chunks.ts` (it is not exported) with `normal` and `uv` carried through,
  because a katamari chunk is textured and one that lost its uv would draw as a
  single flat texel. **If that function is ever exported, delete the copy and
  import it** — the copy says so in its own doc comment.

Seeds come from the model's game id through `hash`/`shash` in `props.ts`, the
world's one noise family. No `Math.random`, no clock: two handsets cut the same
building into the same chunks.

## d. `src/creatures/sticky.ts` — the rules

`STICKY` is a `Record<PropKind, StickyProps>`, so the three new kinds need rows.
The table already carries the numbers for each tier; the new kinds take their
tier's shape:

```ts
small:  { tier: 'small',  rooted: false, breakStrength: 0, attachmentStrength: 3,  stickiness: 1 },
medium: { tier: 'medium', rooted: true,  breakStrength: 4, attachmentStrength: 6,  stickiness: 1 },
large:  { tier: 'large',  rooted: true,  breakStrength: 8, shatterStrength: 11,
          attachmentStrength: 10, stickiness: 1 },
```

`rooted` is per-kind in `STICKY` and per-MODEL in the catalog (a bench is not
planted, a vending machine is), and the two must not quietly disagree. Either
`STICKY` keeps the kind's common case and the loose layer reads
`model.rooted` for the exception, or the unrooted members of a tier get their
own kind. The catalog test pins the invariant for the REPLACEMENT kinds today
(`entry.tier === STICKY[kind].tier` and the same for `rooted`); extend it to the
new kinds once the rows exist.

## e. loading order

The library is ~2.9 mb of glb over the network, which is not something the first
frame waits for — and since 2026-09-16 it does not even START until the first frame has
composed and this page's own creature is standing (`startLibrary` and
`WorldOptions.libraryAfter` in `src/world/scene.ts`): it never blocked the frame, but on a
1.5 Mbit link it competed for it. The pattern already in the world is physics: it arrives late
and the frame is correct before and after.

1. the world builds its **authored** props as it does today and draws them;
2. on a katamari world only (`game() === 'katamari'`), `loadKatamariModels()`
   starts alongside;
3. when it resolves, the variants are swapped (§a), the material set is built
   (§b), the chunk map is rebuilt (§c), and the scatter **rebuilds** — the same
   `rebuild()` + `rebuildVersion()` bump that a density change already causes,
   so every consumer that keys off `rebuildVersion()` / `collidersVersion()`
   re-reads without knowing why;
4. a model that fails to load is skipped with a warning rather than taking the
   world down: a library short one building is a better frame than no frame,
   and the authored prop of that kind is still in the map until the swap.

Because the swap is a rebuild and not a second draw path, nothing needs a
transition: props slide into place on the existing rebuild, and no entrance
pops (TASTE §2.1).

## g. all of it, minus the characters — *(2026-09-16)*

> *"bring as many katamari objects in from the library as possible, minus the
> main characters. I do like the animals in there."*

| the ask | what landed |
| --- | --- |
| as many as possible | 1,510 of the 1,703 exported models are ADMITTED and classified. The catalog that ships is an ACTIVE SET of 326 (`ACTIVE_BUDGET`) because the scatter draws one `InstancedMesh` per (kind, variant) and 1,500 of those is 1,500 draw calls before the ink pass doubles them. The pick is a seeded shuffle per kind (`ACTIVE_SEED`), materialised into `catalog.data.ts` — a pure function of the manifest and the rules, so every device draws the identical world with no shuffle at runtime. |
| minus the main characters | every cousin is `OUJI<n>` internally (`OUJI02_D` is Lalala), so one internal-name prefix takes all 46 poses; the King and the Queen are not in the object archive at all and are listed anyway. A display-name net sits under it. The catalog test pins that nothing matching either got through. |
| the animals stay | they do — cows, bears, penguins, crabs, the ox. So do the people-objects, the food, the vehicles and the shops: a katamari is made of everything. |
| tier by size | the glb's own bounds, not a hand-written guess: `< 0.6 m` → `small`, `< 2.2` → `medium`, `< 6` → `large`, above that the `building` kind. Name rules overrule the size where the size cannot know (a Cherry Tree and a Traffic Light are both four metres and only one is a tree), and every height is clamped into its kind's band (`KIND_HEIGHT_BANDS`, read by the generator AND the test). |
| flags by name | `beach` for boats, shells, sea life, parasols; `inland: true` beside it for the handful that are honestly both (stones, a brick, a shell). `rooted` is the kind's, plus a name rule for the things that are planted although their kind is not — a lamp post, a vending machine — and never for a `small` thing, which is junk on the ground by definition. |
| budgets | 326 variants, 43.8k triangles (budget 300k), 6.13 mb (budget 7 mb), both enforced by the script. Measured on the frame: **472 draw calls, 2.9 M triangles per frame** at a wheel-out on the projection — up from 174 with the 82-model set, which is the cost of the variety and is the number to watch if the budgets grow again. |
| tier-ordered loading | `TIER_LOAD_ORDER` — small, medium, large, building. `loadKatamariModels` loads a tier, hands back everything so far (`onTier`) and goes on; each call is one `scatter.setPropSource` and one rebuild, so the field fills with cups and cans first and the skyline arrives last. A tier that has not landed draws NOTHING rather than the authored props (`katamariPropSource(library, { partial: true })`), for the reason §e gives: a world that shows one prop set and swaps it reads as changing its mind. |
| the islands | dropped, not re-tiered. Coral Island and Top Shell Island are 100 m and 157 m of level geometry; the size rules exclude everything over `MAX_SOURCE_HEIGHT_M` (30 m) because a country normalised into a prop's height is a flat slab twenty units wide. The hand rows that briefly made them `large` outcrops went with them. |

**Not done.** The brief asked for the PHONE tier to halve each budget; it does
not, and it should not as written — a phone that re-rolls a thinner active set
would place different variants at the same cells, and the placement key
(`kind:variant:x:z`) is what a host and a viewer agree a prop IS. A phone-side
cut has to be a DRAW-time cut of the same active set (skip the meshes above a
per-kind index, keep every key), which is a separate change.

## f. what landed, and the decisions that closed

| plan | landed as |
| --- | --- |
| §a the extension seam | a **prop source**. `src/world/props-source.ts` is the pure half — `PropVariantMeta` (the catalog row per variant: id, label, `beach`, `rooted`, `tier`), `PropPlacementSource` (counts + meta) and the one installed global; `PropSource` in `src/world/props.ts` adds the geometry and an optional `PropDraw`. `createScatter({ source })` takes `stockPropSource()` (every other world) or `katamariPropSource(library)`. `variantCount` reads `activePropCounts()`, so the "roll of 3 against a two-entry array" the plan warned about is unrepresentable. |
| §a.2 the new kinds | `small` / `medium` / `large` are `PropKind`s (`KATAMARI_TIER_KINDS`, re-exported from the catalog so the names have one home). Stock variant list **empty**, `PROP_VARIANT_COUNTS` 0, `DEFAULT_KIND_DENSITY` 0, `KIND_GROUP_LABELS` `small props` / `medium props` / `large props`. `STICKY` grew the three rows the plan drafted. Nothing else in the world can place one. |
| §b materials | `materialFor(kind, variant)`. A source that owns its look answers first (`PropDraw.materialFor`), and the library's answer depends on the STYLE: the cel material (`createKatamariMaterialSet`) on `ghibli`, a stock `MeshStandardMaterial` wearing the same texture on `ink` — the world is defined by `game`, its look by `style`, and a library model with its texture thrown away is a grey lump. The frame's wind write reaches the cel materials through `PropDraw.windMaterials()`. |
| §b placement | the junk tiers are in `SEED_PROB` (0.07 / 0.045 / 0.02 **[D]**), `FOREST_SEED` (sparse), `ISLAND_SEED` and `BEACH_SEED` (the sand set, 0.08 / 0.03 / 0.012 **[D]**), appended to `PROP_ROLL_ORDER` so every pre-existing kind keeps its salt. Per-kind density `KATAMARI_KIND_DENSITY` — small 1, medium 0.6, large 0.35 **[D]** — installed with the source. |
| §b the beach admission (open) | **closed: a per-VARIANT region filter, not a second kind.** The beach admits the catalog's `beach: true` rows and only those; everywhere else admits only the rest. The kind rolls first, exactly as it did, and then the SAME hash indexes the admitted list — so with no library installed the expression collapses to the one that shipped and the world is placement-identical. A kind with nothing admitted in a region places nothing there: the catalog has no beach rock, so a katamari beach has no rocks on it, which is honester than putting a vending machine on the sand. |
| §c destruction | `buildChunkGeometries(library)` — route 4. The library's `parts` ARE the chunk set, keyed by kind and ordered with the variants; the authored routes are not mixed in. `src/main.ts` re-memoises when the library arrives. |
| §d the rules | `stickyFor(kind, variant)` — `STICKY[kind]` with the variant's `rooted`/`tier` over the top, and every read that has a variant in hand (the manager's contact pass, `hitRooted`, `accumulate`, the pickup pass, the debris lifetime) goes through it. The kind's row is the common case; a MODEL overrules it. |
| §d rooted, twice (open) | **closed: `rooted` per model wins.** `src/world/rocks.ts` asks `stickyFor(kind, variant).rooted` instead of `kind === 'rock'`, so any unrooted library variant is a dynamic body from the start and any rooted one is a fixed cylinder — a bench behaves like a stone and the vending machine beside it like a trunk. |
| §e loading order | **changed on decision:** the scatter does NOT stand on the inflated props while the library loads. A katamari world starts on `katamariPendingSource()` — the catalog's placement rules with no geometry — so the first second is ground, water and marks, and the props slide in on one `setPropSource` → `rebuild()`. Drawing the authored props and then swapping them reads as the world changing its mind; an empty second does not. |
| the load gate | `startKatamariWorld(game)` — `./models` and `./attach` are both DYNAMIC imports behind the game, so no other world carries the loader, `GLTFLoader` or the cel shader in its first chunk, and `game: 'none'` never calls the loader at all (pinned in `test/world/katamari/wiring.test.ts`). `vite.config.ts` drops `public/katamari/` from a build whose world did not ask for the game, so the personal-use assets ship to the katamari deployment only. |
| `mountain` (2026-09-16, off a frame) | **out of the replacement set.** Coral Island and Top Shell Island are floating hexagonal slabs, and a range built of them read as stacked platforms hovering over the meadow. A mountain here is the authored inflated lump — which is also what `MOUNTAIN_FOOTPRINT` and the mountain pre-pass measure — so `katamariPropSource` MIXES: `buildStockVariants` fills any kind the catalog does not (`mountain`, and `cloud`, so a painted sky still draws), those variants carry no `meta`, and `stickyFor`/`materialFor` fall through to the kind's own row and the stock/ghibli albedo with no branch anywhere downstream. `buildChunkGeometries(library)` does the same per kind: a breakable kind the library does not cover keeps its authored route. The two islands moved to the `large` tier as beach-flagged outcrops at 3 / 2.8 units — 4.7 and 4.9 u across, inside the ~6 u a prop may be. |
| both-region rows (2026-09-16) | `inland?: boolean` on the catalog row, default `!beach`. The filter admits `beach === true` on the sand and `inland ?? !beach` elsewhere, so one flag still means one region and the handful that are honestly both — `Rock`, `Black Rock`, `Garden Rock`, `Brick`, the three shells — stand in either. `--catalog` is a new mode of `scripts/katamari-curate.mjs`: it rewrites `catalog.json` from the table with no library, which is what a table edit like this one needs. |
| the footprint cap | **new, read off the first render [D]:** scaling to a height alone is right for a tree and wrong for a pizza. `KATAMARI_ASPECT_CAP = 2.2` in `models.ts` — past 2.2 times its own height, a model's WIDTH sets the uniform scale, so `heightUnits` reads as "how big is this" for the flat rows (food, shells, the cassette tape) and as a height for everything else. Before it, a 0.3-unit pizza was six units across and taller than the tree beside it. |

## what is still open

- **`heightUnits` is measured now**, not eyeballed (§g) — but `WORLD_SCALE` and the tier
  bands are still **[D]**, and the footprint cap is what stops a flat thing from reading as a
  wide one. The numbers are a starting point to tune against a frame, exactly as TASTE §2.1
  says of its own 1823 ms.
- **472 draw calls per frame** with the active set, against 174 with the 82-model one. The
  ceiling is the number of (kind, variant) pairs with at least one placement, so it grows with
  the budgets and not with the world's density.
- **The junk tiers' densities are a first pass [D]** — a katamari town could be denser still
  near the buildings, which would want a `town` region rather than a number.
- **No cactus.** The library has none, so on a katamari world the `cactus` kind stands in as
  a daruma. (The beach DID lack shingle; `inland: true` on the stones fixed that.)
- **A cluster can spill one prop over the tideline.** The region is decided at the cluster's
  seat and its neighbours are thrown 0.6–1.6 steps around it, so a scree seeded a step inland
  may put one stone on the sand. That is the grove staying one species; what cannot happen is
  the sand seeding an inland set of its own.
- **The ink style shows the models' own textures**, which are coloured — deliberate (§b), and
  the reason the two palette gates already report `n/a` on this world (TASTE §9).
