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

This document is what landed, and the plan for hooking it up. **Nothing is
hooked up yet**: the modules below are new files with documented seams, and the
edits to `src/world/props.ts`, `scatter.ts`, `chunks.ts` and `sticky.ts` belong
to the delegates who own those files. §a–§e are that hand-off.

## what landed

| file | what it is |
| --- | --- |
| `src/world/katamari/catalog.ts` | the hand-written table: 82 models, each with the `PropKind` it stands in for (or a new katamari tier kind), its tier, its world height, whether it is rooted, whether it belongs on the beach |
| `scripts/katamari-curate.mjs` | node, no deps. reads the library's `manifest.json` + the table, copies the chosen glbs into `public/katamari/models/`, writes `public/katamari/catalog.json`, prints the table and the budgets |
| `src/world/katamari/models.ts` | `loadKatamariModels(baseUrl)` → a `KatamariLibrary`: per model, one normalised geometry, its radius, its texture, its alpha mode and a list of breakable `parts` |
| `src/world/katamari/material.ts` | `createKatamariMaterial` / `createKatamariMaterialSet` — the posterised cel look |
| `public/katamari/` | the curated glbs, the catalog, and the provenance note |
| `test/world/katamari/` | table integrity, normalisation, part splitting, the material's glsl, one real glb through `GLTFLoader`, and the script's idempotency |

**Curation:** 82 models, 11,074 triangles, 1.43 mb copied (budgets: 150k
triangles, 4 mb). Re-derive with

```
node scripts/katamari-curate.mjs --source <unpacked-library-dir>
node scripts/katamari-curate.mjs --verify      # no library needed; what the tests run
```

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

Replacement kinds and what now stands in for them: `tree` → the game's four
trees; `conifer` → the xmas tree and the two giant trees; `bush` → garden and
strawberry plants; `rock` → the four rocks; `stump` → tree stump; `cactus` →
giant daruma (the library has no cactus; same silhouette slot **[D]**);
`monolith` → the oni rock and a fish statue; `mountain` → coral island and top
shell island (the game's own island masses, which is what this kind is on a
tropical island); `building` → the harbour town's fish-named blocks plus car
wash, factory, bookstore, ryokan, boathouse; `palm` → palm tree;
`picnicTable` → street stall; `waterTower` → propane tank and weather station.

`beach: true` marks the sand set: parasols, boats, shells and fish, the
boathouse, the palm, the top shell island.

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

The library is ~1.4 mb of glb over the network, which is not something the first
frame waits for. The pattern already in the world is physics: it arrives late
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

## what is not done

- **no wiring.** §a–§e are a plan; `props.ts`, `scatter.ts`, `chunks.ts`,
  `sticky.ts`, `scene.ts` and `main.ts` are untouched.
- **no new tokens.** The warm shift and the sun dab use `GHIBLI.sun`, which
  already exists, so `src/taste/tokens.ts` needed no addition.
- **the beach admission** for `building` / `large` on `BEACH_SEED` is a
  decision for whoever owns the scatter (§b).
- **`heightUnits` is eyeballed [D]** against `PROP_VARIANT_DEFS`, one row at a
  time. The bands are pinned loosely by the catalog test; the numbers are a
  starting point to tune against a frame, exactly as TASTE §2.1 says of its own
  1823 ms.
